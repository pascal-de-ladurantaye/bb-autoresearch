// Data hooks: every read goes through bb.rpc; the "study-changed" realtime
// signal (and reconnects) trigger a debounced refetch. Signals are
// ephemeral, so a slow poll covers anything missed while the page is open.
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RpcContract } from "../rpc.ts";

export type Rpc = ReturnType<typeof useRpc<RpcContract>>;

export function useStudyRpc(): Rpc {
  return useRpc<RpcContract>();
}

export interface Loaded<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
}

/** Call `load` now, on every study-changed signal (debounced), on reconnect, and every `pollMs`. */
export function useLive<T>(load: (rpc: Rpc) => Promise<T>, deps: readonly unknown[], pollMs = 5000): Loaded<T> {
  const rpc = useStudyRpc();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(() => {
    const mine = ++seq.current;
    load(rpc).then(
      (d) => {
        if (mine !== seq.current) return;
        setData(d);
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (mine !== seq.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
  }, [rpc, ...deps]);
  const refetch = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(run, 250);
  }, [run]);
  useEffect(() => {
    setLoading(true);
    run();
    const poll = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") run();
    }, pollMs);
    return () => {
      clearInterval(poll);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [run, pollMs]);
  useRealtime("study-changed", refetch);
  const conn = useRealtimeConnectionState();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (conn === "connected") refetch();
  }, [conn, refetch]);
  return { data, error, loading, refetch };
}
