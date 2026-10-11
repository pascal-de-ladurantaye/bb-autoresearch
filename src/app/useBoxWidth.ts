import { useCallback, useRef, useState } from "react";

/** The pixel width of a box (charts draw in pixels, so their text stays crisp); `fallback` until measured. */
export function useBoxWidth(fallback: number): [(el: HTMLDivElement | null) => void, number] {
  const [w, setW] = useState(fallback);
  const obs = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    obs.current?.disconnect();
    obs.current = null;
    if (!el) return;
    const width = el.getBoundingClientRect().width;
    if (width > 0) setW(Math.round(width));
    if (typeof ResizeObserver === "function") {
      obs.current = new ResizeObserver((entries) => {
        const x = entries[0]?.contentRect.width;
        if (x && x > 0) setW(Math.round(x));
      });
      obs.current.observe(el);
    }
  }, []);
  return [ref, w];
}
