// Routes inside the Studies panel that the Live view links to.

/** The subPath of a study's replay at a position (ms since its first event), or from the start. */
export function replayPath(slug: string, at: number | null = null): string {
  return `${slug}/live/replay${at !== null ? `/${Math.max(0, Math.round(at))}` : ""}`;
}
