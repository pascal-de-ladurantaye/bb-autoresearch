// bb-autoresearch — server entry. Wiring only; behavior lives in src/.
//
// Order matters for reconciliation: register every handler (tools, CLI,
// events, rpc) first, then reconcile running studies from the background service
// once the load commits (host RPC and bb.sdk are available there).
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createBbPort } from "./src/bb-port.ts";
import { studyCli } from "./src/cli.ts";
import { DEFAULT_CONFIG, HostMutex, type Ctx, type EngineConfig } from "./src/context.ts";
import { MIGRATIONS } from "./src/db/schema.ts";
import { Store } from "./src/db/store.ts";
import { Engine } from "./src/engine.ts";
import { hostContract, hostSignals } from "./src/host/contract.ts";
import { ProgressBus } from "./src/host/runner.ts";
import { errText } from "./src/pipeline.ts";
import type { BbPort } from "./src/ports.ts";
import { seededRng } from "./src/stats.ts";
import { registerRpc } from "./src/rpc.ts";
import { registerTools } from "./src/tools.ts";

export interface PluginDeps {
  /** Override the BB adapter (tests). */
  port?: (bb: BbPluginApi) => BbPort;
  config?: Partial<EngineConfig>;
  seed?: number;
  now?: () => number;
  /** Tests: receive the engine (to seed or inspect state). */
  onEngine?: (engine: Engine) => void;
}

export function createAutoresearchPlugin(deps: PluginDeps = {}) {
  return async function plugin(bb: BbPluginApi): Promise<void> {
    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS);
    const now = deps.now ?? Date.now;
    const store = new Store(db, now);
    const client = bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
    // Host job progress streams back as signals; runners subscribe by job id.
    const progress = new ProgressBus();
    client.experimental_onSignal("progress", ({ payload }) => progress.emit(payload.key, payload.message));
    const port = deps.port ? deps.port(bb) : createBbPort(bb, client, progress);
    const ctx: Ctx = {
      store,
      bb: port,
      now,
      rng: seededRng(deps.seed ?? (now() & 0xffffffff)),
      benchLock: new HostMutex(),
      config: { ...DEFAULT_CONFIG, ...deps.config },
    };
    const engine = new Engine(ctx);
    deps.onEngine?.(engine);

    registerTools(bb, engine);
    registerRpc(bb, engine);
    bb.cli.register(studyCli(engine));

    const safe = (name: string, fn: () => void | Promise<void>) => {
      try {
        const r = fn();
        if (r instanceof Promise) r.catch((e) => bb.log.warn(`${name}: ${errText(e)}`));
      } catch (e) {
        bb.log.warn(`${name}: ${errText(e)}`);
      }
    };
    bb.events.on("thread.idle", ({ thread }) => safe("thread.idle", () => engine.onThreadIdle(thread.id)));
    bb.events.on("thread.active", ({ thread }) => safe("thread.active", () => engine.onThreadActive(thread.id)));
    bb.events.on("thread.failed", ({ thread }) => safe("thread.failed", () => engine.onThreadFailed(thread.id)));
    bb.events.on("thread.archived", ({ thread }) => safe("thread.archived", () => engine.onThreadGone(thread.id, "archived")));
    bb.events.on("thread.deleted", ({ thread }) => safe("thread.deleted", () => engine.onThreadGone(thread.id, "deleted")));
    bb.events.on("turn.failed", (event) => safe("turn.failed", () => engine.onTurnFailed(event)));
    client.experimental_onWorkerExit(({ hostId }) => {
      // In-flight host calls and jobs died with the worker: measurements on
      // that host restart from scratch (partial samples discarded).
      bb.log.warn(`host worker exited on ${hostId}`);
      engine.onHostWorkerExit(hostId);
    });

    bb.background.service("engine", {
      async start(signal) {
        try {
          const r = await engine.reconcile();
          bb.log.info(`reconciled: ${r.requeued} measurement(s) requeued, ${r.workers} worker(s) checked, ${r.calibrations} calibration(s) restarted`);
        } catch (e) {
          bb.log.error(`reconcile failed: ${errText(e)}`);
        }
        while (!signal.aborted) {
          await engine.tick().catch((e) => bb.log.warn(`tick: ${errText(e)}`));
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, ctx.config.tickMs);
            signal.addEventListener("abort", () => {
              clearTimeout(t);
              resolve();
            }, { once: true });
          });
        }
      },
    });
  };
}

export default createAutoresearchPlugin();
