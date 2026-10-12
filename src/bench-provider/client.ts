// Calls to a bench provider plugin (see contract.ts), with the contract's
// output schemas, error codes parsed from messages, and bounded retries of the
// retryable ones ([capacity], [transient]).
import type { z } from "zod";
import { BenchProviderError, benchProviderContract, errorCode, type BenchProviderMethod, type MethodInput, type MethodOutput } from "./contract.ts";

/** How a call reaches the provider: bb.sdk.plugins.callRpc in the server, a function in tests. */
export type ProviderTransport = (method: string, input: unknown, outputSchema: z.ZodType) => Promise<unknown>;

export interface CallOptions {
  /** Retries of a retryable error (default 2). */
  retries?: number;
  signal?: AbortSignal;
}

export class BenchProviderClient {
  /** Calls per method (Bench tab, tests). */
  readonly calls = new Map<string, number>();
  constructor(
    readonly pluginId: string,
    private readonly transport: ProviderTransport,
    private readonly opts: { retryMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ) {}

  async call<M extends BenchProviderMethod>(method: M, input: MethodInput<M>, opts: CallOptions = {}): Promise<MethodOutput<M>> {
    const schema = benchProviderContract[method];
    const retries = opts.retries ?? 2;
    const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
      if (opts.signal?.aborted) throw new BenchProviderError(`${method}: cancelled`, null, method);
      this.calls.set(method, (this.calls.get(method) ?? 0) + 1);
      try {
        const out = await this.transport(method, input, schema.output as unknown as z.ZodType);
        return schema.output.parse(out) as MethodOutput<M>;
      } catch (e) {
        const err = toProviderError(e, method, this.pluginId);
        if (!err.retryable || attempt >= retries) throw err;
        await sleep((this.opts.retryMs ?? 1000) * (attempt + 1));
      }
    }
  }
}

/**
 * The call never reached a provider: its plugin isn't installed, enabled or
 * loaded (yet, during BB's startup). Code `not_found` like a machine the
 * provider doesn't know, so callers that don't care treat both alike.
 */
export class ProviderMissingError extends BenchProviderError {
  readonly providerMissing = true;
}

export function toProviderError(e: unknown, method: string, pluginId: string): BenchProviderError {
  if (e instanceof BenchProviderError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const code = errorCode(e);
  // A provider plugin that isn't installed, enabled or loaded: the call never reached a handler.
  const missing = code === null && /not (installed|enabled|loaded|found)|unknown plugin|no such plugin|plugin .* (is )?(disabled|unavailable)|\b404\b/iu.test(msg);
  // BB prefixes what a provider throws ("HTTP 500: [invalid] …"): the bracketed code is found anywhere. No code: internal.
  if (missing) return new ProviderMissingError(`${pluginId} ${method}: ${msg}`, "not_found", method);
  return new BenchProviderError(`${pluginId} ${method}: ${msg}`, code ?? "internal", method);
}
