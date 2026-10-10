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
 * Make sure an animation ends in its final state even if the page stops
 * drawing frames mid-flight (an occluded window, a background tab): a timer
 * finishes it shortly after it should have ended, so nothing stays frozen at
 * its first keyframe (invisible, or displaced).
 */
function settle(anim: Animation | undefined, ms: number): void {
  if (!anim || typeof anim.finish !== "function") return;
  setTimeout(() => {
    try {
      if (anim.playState === "running") anim.finish();
    } catch {
      // A cancelled or detached animation needs nothing.
    }
  }, ms + 300);
}

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
  /** Jumps, not motion (a replay being scrubbed). */
  still = false;
  /** Last time an animation frame ran (a hidden or occluded page renders none: animating there would freeze items mid-flight). */
  lastFrame = Number.NEGATIVE_INFINITY;
  rendering(): boolean {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
    return typeof performance === "undefined" || performance.now() - this.lastFrame < 2500;
  }
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

export function FlipRoot({ children, className, still = false }: { children: ReactNode; className?: string; still?: boolean }) {
  const reduced = usePrefersReducedMotion();
  const ref = useRef<HTMLDivElement | null>(null);
  const registry = useRef<FlipRegistry | null>(null);
  if (!registry.current) registry.current = new FlipRegistry(null, reduced);
  registry.current.reduced = reduced;
  // A replay that is scrubbed or paused jumps: nothing glides (positions are still remembered).
  registry.current.still = still;
  useLayoutEffect(() => {
    registry.current!.root = ref.current;
    // Items present when the view first fills in don't fly in.
    const t = setTimeout(() => (registry.current!.ready = true), 1500);
    // A cheap heartbeat, once a second: two animation frames in a row tell whether the page is really
    // drawing. A page that is not composited (an occluded or hidden window) may still run a frame now and
    // then, but not two within 100 ms; animating there would leave items frozen at their first keyframe.
    const probe = () => {
      if (typeof requestAnimationFrame !== "function") return;
      requestAnimationFrame((t1) =>
        requestAnimationFrame((t2) => {
          if (t2 - t1 < 100) registry.current!.lastFrame = performance.now();
        }),
      );
    };
    probe();
    const beat = setInterval(probe, 1000);
    return () => {
      clearTimeout(t);
      clearInterval(beat);
    };
  }, []);
  return (
    <FlipContext.Provider value={registry.current}>
      <div ref={ref} className={className} data-reduced-motion={reduced ? "true" : undefined}>
        {children}
      </div>
    </FlipContext.Provider>
  );
}

/** The translation an element's transform applies now (a glide in flight), in px. */
function translationOf(node: HTMLElement): { x: number; y: number } {
  if (!node.getAnimations?.().length) return { x: 0, y: 0 };
  const m = /matrix(3d)?\(([^)]+)\)/u.exec(getComputedStyle(node).transform || "");
  if (!m) return { x: 0, y: 0 };
  const v = m[2]!.split(",").map((x) => Number(x.trim()));
  const [x, y] = m[1] ? [v[12], v[13]] : [v[4], v[5]];
  return { x: Number.isFinite(x) ? x! : 0, y: Number.isFinite(y) ? y! : 0 };
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
    // The layout position, without the translation of a glide in flight (measuring through it would
    // feed each glide's offset into the next one).
    const t = translationOf(node);
    const now = { x: r.left - o.x - t.x, y: r.top - o.y - t.y };
    const prev = reg.rects.get(key);
    reg.rects.set(key, now);
    if (reg.reduced || reg.still || typeof node.animate !== "function" || !reg.rendering()) {
      for (const a of node.getAnimations?.() ?? []) a.cancel();
      return;
    }
    if (prev) {
      const dx = prev.x - now.x;
      const dy = prev.y - now.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        // Continue from where the element is seen now (its old place plus any glide in flight).
        for (const a of node.getAnimations?.() ?? []) a.cancel();
        settle(node.animate([{ transform: `translate(${dx + t.x}px, ${dy + t.y}px)` }, { transform: "translate(0, 0)" }], { duration: 480, easing: EASE }), 480);
      }
    } else if (reg.ready) {
      settle(node.animate([{ opacity: 0, transform: "scale(0.96)" }, { opacity: 1, transform: "scale(1)" }], { duration: 320, easing: EASE }), 320);
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

/**
 * Whether motion may run right now: not under prefers-reduced-motion, and
 * the page is drawing frames (inside a FlipRoot, its heartbeat decides).
 */
export function useMotionGate(): () => boolean {
  const reg = useContext(FlipContext);
  const reduced = usePrefersReducedMotion();
  return useCallback(() => !reduced && !(reg?.reduced ?? false) && !(reg?.still ?? false) && (reg ? reg.rendering() : true), [reg, reduced]);
}

/** Run a Web Animation on `el` when motion is allowed (no-op otherwise). */
export function animateIf(ok: boolean, el: Element | null | undefined, keyframes: Keyframe[], options: KeyframeAnimationOptions): void {
  if (!ok || !el || typeof (el as HTMLElement).animate !== "function") return;
  const ms = typeof options.duration === "number" ? options.duration : 400;
  settle((el as HTMLElement).animate(keyframes, { easing: EASE, ...options }), ms);
}

/**
 * A number that counts up (or down) to `value` over `ms` when `animate` is
 * true at the moment it changes, and jumps otherwise (first render, reduced
 * motion, a page that draws no frames, a replay scrubbed backwards).
 */
export function useCountUp(value: number | null, animate: boolean, ms = 900): number | null {
  const [shown, setShown] = useState(value);
  const prev = useRef(value);
  useEffect(() => {
    const from = prev.current;
    prev.current = value;
    if (value === null || from === null || from === value || !animate || typeof requestAnimationFrame !== "function") {
      setShown(value);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const step = () => {
      const k = Math.min(1, (performance.now() - start) / ms);
      const e = 1 - (1 - k) ** 3;
      setShown(from + (value - from) * e);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    // If frames stop (hidden page), land on the value anyway.
    const done = setTimeout(() => setShown(value), ms + 200);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(done);
    };
  }, [value, animate, ms]);
  return shown;
}
