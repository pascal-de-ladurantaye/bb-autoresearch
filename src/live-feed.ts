// The Live view's feed: one plain sentence per event the human cares
// about, grouped by candidate on the page. Pure and frontend-safe, so the
// live view (server) and replay (app) tell the same story.
import type { EventLike, FeedTone, LiveFeedItem } from "./live-model.ts";
import { improvementText, verdictCause, type MetricInfo, type NoiseClass } from "./present.ts";

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function seconds(ms: number): string {
  const s = ms / 1000;
  if (s < 90) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  return `${(s / 60).toFixed(1)} min`;
}

/**
 * The event feed: one plain sentence per event the human cares about,
 * tagged with its candidate so the page can group them ("c/14 tests passed
 * in 41 s", "c/13 lost: 0.4% more ops").
 */
export function feedItems(
  events: readonly EventLike[],
  ctx: { metric: MetricInfo; ideas: Map<number, { title: string }>; hostName: (id: string) => string; candidateN: Map<number, number>; noise?: NoiseClass; gatesOnBench?: boolean },
): LiveFeedItem[] {
  const out: LiveFeedItem[] = [];
  const gatingAt = new Map<number, number>();
  const nOf = (d: Record<string, unknown>): number | null => (typeof d.n === "number" ? d.n : typeof d.candidate === "number" ? (ctx.candidateN.get(d.candidate) ?? null) : null);
  const idea = (id: unknown): string => (typeof id === "number" ? `idea #${id}${ctx.ideas.get(id) ? ` (${clip(ctx.ideas.get(id)!.title, 60)})` : ""}` : "an idea");
  let pendingBest: LiveFeedItem | null = null;
  const flushBest = () => {
    if (pendingBest) out.push(pendingBest);
    pendingBest = null;
  };
  for (const e of events) {
    const d = e.data;
    const n = nOf(d);
    if (pendingBest && !(e.kind === "candidate.verdict" && n === pendingBest.candidate) && e.kind !== "candidate.stage" && e.kind !== "bench.cache_invalidated") flushBest();
    const push = (text: string, tone: FeedTone = "info", candidate: number | null = n) => {
      out.push({ id: e.id, at: e.at, candidate, text, tone });
      if (e.kind === "candidate.verdict") flushBest();
    };
    switch (e.kind) {
      case "candidate.submitted":
        push(`c/${n} submitted${typeof d.files === "number" ? ` (${plural(d.files, "file")})` : ""}`);
        break;
      case "candidate.stage":
        if (d.to === "gating" && typeof d.candidate === "number") {
          gatingAt.set(d.candidate, e.at);
          if (d.from === "queued" || d.from === "measuring" || d.from === "confirming") break; // rebased: the requeue line says why
          // Single-machine mode: tests wait for the bench lock (gate.started says when they run).
          push(ctx.gatesOnBench ? `c/${n} waits to run its tests on the bench` : `c/${n} tests started`);
        } else if (d.to === "confirming") push(`c/${n} looks like a win: confirming with fresh pairs`);
        break;
      case "candidate.queued": {
        const started = typeof d.candidate === "number" ? gatingAt.get(d.candidate) : undefined;
        push(`c/${n} tests passed${started !== undefined ? ` in ${seconds(e.at - started)}` : ""}, queued for the bench`);
        break;
      }
      case "gate.started":
        if (typeof d.candidate === "number") gatingAt.set(d.candidate, e.at);
        push(
          typeof d.host === "string" && d.host.startsWith("remote-")
            ? `c/${n} tests started on ${ctx.hostName(d.host)} (gates on the remote machines)`
            : `c/${n} tests started on ${typeof d.host === "string" ? ctx.hostName(d.host) : "the bench"}, holding the bench (single-machine mode)`,
        );
        break;
      case "gate.flaky":
        push(`c/${n} a test was flaky (passed on the retry)`, "warn");
        break;
      case "candidate.rebased":
        push(`c/${n} rebased onto the new best`);
        break;
      case "candidate.requeued":
        push(`c/${n} sent back: ${clip(String(d.reason ?? "best moved"), 80)}`, "warn");
        break;
      case "measure.started":
        push(`c/${n} on the bench${typeof d.host === "string" ? ` (${ctx.hostName(d.host)})` : ""}`);
        break;
      case "measure.restarted":
        push(`c/${n} measurement restarted: ${clip(String(d.reason ?? ""), 80)}`, "warn");
        break;
      case "measure.deferred":
        push(`c/${n} waits: the bench host failed its health check`, "warn");
        break;
      case "measure.finished": {
        const m = typeof d.measure_pairs === "number" ? d.measure_pairs : typeof d.pairs === "number" ? d.pairs : null;
        const c = typeof d.confirm_pairs === "number" && d.confirm_pairs > 0 ? d.confirm_pairs : 0;
        // Deterministic measurements are one run each side; expensive ones count candidate runs; noisy ones pairs.
        const what = ctx.noise === "deterministic" ? "one run each" : m === null ? null : ctx.noise === "expensive" ? plural(m, "run") : `${plural(m, "pair")}${c ? `, then ${plural(c, "confirmation pair")}` : ""}`;
        // Why the sequential test stopped when it wasn't the plain rule, and a skipped confirmation.
        const why = d.confirm_skipped === true ? " (confirmation skipped: far beyond the win threshold)" : d.stop === "futility" ? " (stopped early: CI upper bound below the win threshold)" : d.stop === "early" ? " (stopped early: clearly worse)" : "";
        push(`c/${n} measured${what ? `: ${what}` : ""}${typeof d.seconds === "number" ? ` in ${seconds(d.seconds * 1000)}` : ""}${why}`);
        break;
      }
      case "candidate.verdict": {
        const eff = typeof d.effect === "number" ? improvementText(d.effect, ctx.metric, { digits: 1, factor: false }) : null;
        const reason = Array.isArray(d.reasons) && typeof d.reasons[0] === "string" ? clip(d.reasons[0], 90) : "";
        // Why it isn't the primary metric's verdict (replay bundles carry it precomputed, their reasons are trimmed).
        const cause = typeof d.cause === "string" ? d.cause : verdictCause(typeof d.verdict === "string" ? d.verdict : null, d.reasons);
        switch (d.verdict) {
          case "win":
            push(`c/${n} won${eff ? `: ${eff}` : ""}`, "win");
            break;
          case "lose":
            // A primary-metric win that broke a guardrail says so first: "c/3 lost on guardrail mem_kb (27.6% worse), despite 43.3% fewer ops".
            push(cause ? `c/${n} ${cause}${eff && typeof d.effect === "number" && d.effect > 0 ? `, despite ${eff}` : ""}` : `c/${n} lost${eff ? `: ${eff}` : reason ? `: ${reason}` : ""}`, "lose");
            break;
          case "inconclusive":
            push(`c/${n} inconclusive: not promoted${eff ? `. Estimate: ${eff} vs previous best` : ""}`, "info");
            break;
          case "gate_failed":
            push(`c/${n} failed the tests`, "lose");
            break;
          case "conflict":
            push(`c/${n} conflicts with the new best`, "warn");
            break;
          case "rejected":
            push(`c/${n} rejected${reason ? `: ${reason}` : ""}`, "lose");
            break;
          default:
            push(`c/${n}: ${String(d.verdict)}`);
        }
        break;
      }
      case "best.promoted":
        // Promotion is recorded just before the verdict; tell it after the "won" line.
        pendingBest = { id: e.id, at: e.at, candidate: n, text: `Best moved: c/${n} promoted, workers notified`, tone: "best" };
        break;
      case "worker.spawned":
        push(`A worker picked ${idea(d.idea)}`, "info", null);
        break;
      case "worker.finished":
        push(`The worker on ${idea(d.idea)} finished`, "info", null);
        break;
      case "worker.abandoned":
        push(`The worker on ${idea(d.idea)} stopped${d.reason ? `: ${clip(String(d.reason), 60)}` : ""}`, "warn", null);
        break;
      case "remote.requested":
        push(`A remote machine (${String(d.provider ?? "provider")}, ${String(d.cores ?? "?")} cores) is joining${typeof d.replaces === "number" ? ` to replace #${d.replaces}` : ""}`, "info", null);
        break;
      case "remote.ready":
        push(`${typeof d.host === "string" ? ctx.hostName(d.host) : "A remote machine"} ${d.recalibrated ? "recalibrated" : "joined"}: noise ${typeof d.noise_floor === "number" ? `${(d.noise_floor * 100).toFixed(2)}%` : "?"} per pair, measuring from now on`, "info", null);
        break;
      case "remote.retiring":
        push(`${typeof d.host === "string" ? ctx.hostName(d.host) : "A remote machine"} retires (${clip(String(d.reason ?? ""), 60)}): it takes no new work`, "info", null);
        break;
      case "remote.left":
        push(`${typeof d.host === "string" ? ctx.hostName(d.host) : "A remote machine"} left: ${clip(String(d.reason ?? ""), 80)}`, d.expected ? "info" : "warn", null);
        break;
      case "bench.noisy_host": {
        const h = typeof d.host === "string" ? ctx.hostName(d.host) : "A bench host";
        const ratio = typeof d.ratio === "number" ? `${d.ratio.toFixed(1)}× the other hosts' noise` : "much noisier than the other hosts";
        push(d.action === "kept" ? `${h} is ${ratio}, kept after replacements that were too: quieter hosts go first` : d.action === "replaced" ? `${h} is ${ratio}: replaced` : `${h} is ${ratio}: it measures nothing until the next calibration`, "warn", null);
        break;
      }
      case "recalibration.deferred":
        push(`Recalibration waits for a healthy bench (retry ${String(d.tries ?? "?")} of ${String(d.max ?? "?")} in ${String(d.retry_seconds ?? "?")} s)`, "warn", null);
        break;
      case "drift.checked":
        push(`Drift check on ${typeof d.host === "string" ? ctx.hostName(d.host) : "the bench"}: ${d.ok ? "noise as calibrated" : "noise drifted"}`, d.ok ? "info" : "warn", null);
        break;
      case "study.state":
        push(`Study ${String(d.to)}${d.reason ? `: ${clip(String(d.reason), 80)}` : ""}`, d.to === "paused" ? "warn" : "info", null);
        break;
    }
  }
  flushBest();
  return out;
}

