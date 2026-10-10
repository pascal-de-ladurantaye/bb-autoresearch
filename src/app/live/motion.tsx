// Motion for the Live view: FLIP moves between columns and into lanes, and
// a short entrance for new items, with the Web Animations API (no CSS
// keyframes needed). Everything is skipped under prefers-reduced-motion;
// the state is always in words and shapes, so nothing is lost without it.
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function usePrefersReducedMotion(): boolean {
  const query = "(prefers-reduced-motion: reduce)";
  const get = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;
  const [reduced, setReduced] = useState(get);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(query);
    const on = () => setReduced(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return reduced;
}

const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";

/**
 * Remembers where each keyed element was (relative to the provider's root,
 * so page scrolling doesn't count as motion). An element that mounts or
 * moves under a key seen before animates from the old place to the new one:
 * a card going from Tests to Queue, an idea going from Up next into a lane.
 */
class FlipRegistry {
  rects = new Map<string, { x: number; y: number }>();
  expiry = new Map<string, ReturnType<typeof setTimeout>>();
  mounted = new Map<string, number>();
  ready = false;
  constructor(
    public root: HTMLElement | null,
    public reduced: boolean,
  ) {}
  origin(): { x: number; y: number } {
    const r = this.root?.getBoundingClientRect();
    return { x: r?.left ?? 0, y: r?.top ?? 0 };
  }
}

const FlipContext = createContext<FlipRegistry | null>(null);

export function FlipRoot({ children, className }: { children: ReactNode; className?: string }) {
  const reduced = usePrefersReducedMotion();
  const ref = useRef<HTMLDivElement | null>(null);
  const registry = useRef<FlipRegistry | null>(null);
  if (!registry.current) registry.current = new FlipRegistry(null, reduced);
  registry.current.reduced = reduced;
  useLayoutEffect(() => {
    registry.current!.root = ref.current;
    // Items present at the first paint don't fly in.
    const t = setTimeout(() => (registry.current!.ready = true), 0);
    return () => clearTimeout(t);
  }, []);
  return (
    <FlipContext.Provider value={registry.current}>
      <div ref={ref} className={className} data-reduced-motion={reduced ? "true" : undefined}>
        {children}
      </div>
    </FlipContext.Provider>
  );
}

/** A ref for an element that should glide when it moves (FLIP) and fade in when new. */
export function useFlip<T extends HTMLElement>(key: string): (el: T | null) => void {
  const reg = useContext(FlipContext);
  const el = useRef<T | null>(null);
  const setRef = useCallback((node: T | null) => {
    el.current = node;
  }, []);
  // Runs after every render: compare with the last known place, then remember this one.
  useLayoutEffect(() => {
    const node = el.current;
    if (!reg || !node) return;
    const o = reg.origin();
    const r = node.getBoundingClientRect();
    const now = { x: r.left - o.x, y: r.top - o.y };
    const prev = reg.rects.get(key);
    reg.rects.set(key, now);
    if (reg.reduced || typeof node.animate !== "function") return;
    if (prev) {
      const dx = prev.x - now.x;
      const dy = prev.y - now.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }], { duration: 480, easing: EASE });
      }
    } else if (reg.ready) {
      node.animate([{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "scale(1)" }], { duration: 320, easing: EASE });
    }
  });
  // Forget the place a while after the last element with this key unmounts (a move remounts it elsewhere first).
  useEffect(() => {
    if (!reg) return;
    reg.mounted.set(key, (reg.mounted.get(key) ?? 0) + 1);
    return () => {
      reg.mounted.set(key, (reg.mounted.get(key) ?? 1) - 1);
      const t = setTimeout(() => {
        reg.expiry.delete(key);
        if ((reg.mounted.get(key) ?? 0) > 0) return;
        reg.rects.delete(key);
        reg.mounted.delete(key);
      }, 4000);
      reg.expiry.set(key, t);
    };
  }, [reg, key]);
  return setRef;
}

/** True for `ms` after `value` changes (not on mount): a short highlight when a verdict lands or best moves. */
export function useFlash(value: unknown, ms = 1800): boolean {
  const [on, setOn] = useState(false);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setOn(true);
    const t = setTimeout(() => setOn(false), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return on;
}
