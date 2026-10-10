// Opening the Live panel beside the study thread.
//
// `useBbNavigate().openThreadPanel` only works on a thread surface (it
// returns false on a plugin page, even right after `toThread`). So the Live
// tab records a request and navigates to the study thread; the study
// thread's header badge (mounted there, on the thread surface) takes the
// request and opens the panel.
import type { useBbNavigate } from "@get-bb/plugin-sdk/app";

/** The threadPanelAction id of the Live panel. */
export const LIVE_PANEL_ACTION = "study-live";

type Nav = ReturnType<typeof useBbNavigate>;

let pending: { threadId: string; slug: string; at: number } | null = null;

/** Ask the next header badge mounted on `threadId` to open the Live panel for `slug`. */
export function requestOpenBeside(threadId: string, slug: string): void {
  pending = { threadId, slug, at: Date.now() };
}

/** Take a pending request for `threadId` (valid for 15 s), if any. */
export function takeOpenBeside(threadId: string): string | null {
  if (!pending || pending.threadId !== threadId || Date.now() - pending.at > 15_000) return null;
  const slug = pending.slug;
  pending = null;
  return slug;
}

/** Open (or focus) the Live panel tab for a study in the current thread's side panel. */
export function openLivePanel(nav: Nav, slug: string): boolean {
  return nav.openThreadPanel({ actionId: LIVE_PANEL_ACTION, title: `Live · ${slug}`, params: { slug } });
}

/** Open the panel, retrying briefly while the thread surface settles after navigation. */
export function openLivePanelSoon(nav: Nav, slug: string, tries = 20, everyMs = 100): () => void {
  let left = tries;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const attempt = () => {
    timer = null;
    if (openLivePanel(nav, slug) || --left <= 0) return;
    timer = setTimeout(attempt, everyMs);
  };
  attempt();
  return () => {
    if (timer) clearTimeout(timer);
  };
}
