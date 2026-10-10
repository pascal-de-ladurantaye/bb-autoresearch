// Live view data: one `study.live` fetch, then realtime deltas applied
// locally (stage moves, phases, pairs, verdicts), with refetches when a
// delta can't be applied, on "study-changed" (throttled), on reconnect, and
// every few seconds for consistency. Signals are ephemeral; RPC is the truth.
import { useRealtime, useRealtimeConnectionState } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useRef, useState } from "react";
import { applyDeltas, LIVE_CHANNEL, type LiveDeltaMessage, type LiveView } from "../../live-model.ts";
import { improvementText } from "../../present.ts";
import { useStudyRpc } from "../data.ts";

/** Refetches are at most this often (deltas carry the motion in between). */
const MIN_REFETCH_MS = 1000;
/** Full refetch for consistency (signals can be missed). */
const POLL_MS = 5000;

export interface LiveStudyState {
  view: LiveView | null;
  error: string | null;
  loading: boolean;
  /** Server clock minus client clock, so elapsed timers match the server. */
  offset: number;
  refetch: () => void;
}

export function useLiveStudy(slug: string | null): LiveStudyState {
  const rpc = useStudyRpc();
  const [view, setView] = useState<LiveView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [offset, setOffset] = useState(0);
  const viewRef = useRef<LiveView | null>(null);
  const seq = useRef(0);
  const lastFetch = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(() => {
    if (!slug) return;
    const mine = ++seq.current;
    lastFetch.current = Date.now();
    rpc.call("study.live", { slug }).then(
      (v) => {
        if (mine !== seq.current) return;
        viewRef.current = v;
        setView(v);
        setOffset(v.now - Date.now());
        setError(null);
        setLoading(false);
      },
      (e: unknown) => {
        if (mine !== seq.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
  }, [rpc, slug]);

  /** Refetch soon, at most once per MIN_REFETCH_MS. */
  const refetch = useCallback(() => {
    if (timer.current) return;
    const wait = Math.max(0, lastFetch.current + MIN_REFETCH_MS - Date.now());
    timer.current = setTimeout(() => {
      timer.current = null;
      load();
    }, wait);
  }, [load]);

  useEffect(() => {
    setLoading(true);
    setView(null);
    viewRef.current = null;
    load();
    const poll = setInterval(() => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") load();
    }, POLL_MS);
    return () => {
      clearInterval(poll);
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [load]);

  useRealtime(LIVE_CHANNEL, (payload: unknown) => {
    const msg = payload as LiveDeltaMessage;
    const v = viewRef.current;
    if (!v || !msg || typeof msg !== "object" || msg.s !== v.studyId || !Array.isArray(msg.d)) return;
    const r = applyDeltas(v, msg, (e) => (e === null ? null : improvementText(e, v.metric, { digits: 1, factor: false })));
    if (r.view !== v) {
      viewRef.current = r.view;
      setView(r.view);
    }
    if (r.refetch) refetch();
  });
  useRealtime("study-changed", (payload: unknown) => {
    const v = viewRef.current;
    const study = (payload as { study?: unknown } | null)?.study;
    if (!v || study === v.studyId) refetch();
  });
  const conn = useRealtimeConnectionState();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (conn === "connected") refetch();
  }, [conn, refetch]);

  return { view, error, loading, offset, refetch };
}

/** The server-aligned clock, ticking every second (elapsed timers). */
export function useNow(offset: number, everyMs = 1000): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return Date.now() + offset;
}

/** "0:42", "12:05", "1:02:10". */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** Spoken form for screen readers: "42 seconds", "12 minutes". */
export function spokenDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 6) / 10;
  return `${h} hours`;
}
