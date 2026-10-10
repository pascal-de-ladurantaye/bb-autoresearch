// Autoresearch frontend: the Studies nav panel (study list and study page),
// the thread-header badge for study and worker threads, and the Live panel
// in a thread's right split pane.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never
// bundled). components/ui/ is vendored shadcn source from the BB registry.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { StudiesAccessory, StudiesPanel } from "./src/app/StudiesPage.tsx";
import { ThreadBadge } from "./src/app/ThreadBadge.tsx";
import { LivePanel } from "./src/app/live/LivePanel.tsx";
import { LIVE_PANEL_ACTION } from "./src/app/live/openBeside.ts";

/** The plugin's flask glyph (same shape as assets/flask.svg). */
function FlaskIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M9 3h6" />
      <path d="M10 3v6.2L4.6 18.4A1.7 1.7 0 0 0 6.1 21h11.8a1.7 1.7 0 0 0 1.5-2.6L14 9.2V3" />
      <path d="M7.5 15h9" />
    </svg>
  );
}

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: "autoresearch-flask", component: FlaskIcon });
  app.slots.navPanel({
    id: "studies",
    title: "Studies",
    icon: "autoresearch-flask",
    path: "studies",
    component: StudiesPanel,
    // How many approvals, system pauses, failed calibrations and ready harvests wait for the human.
    experimental_sidebarAccessory: StudiesAccessory,
  });
  app.slots.experimental_threadHeaderAction({
    id: "study-badge",
    title: "Autoresearch study",
    component: ThreadBadge,
  });
  // The Live view beside a study thread (or a worker thread): the panel resolves its study from the thread.
  app.slots.threadPanelAction({
    id: LIVE_PANEL_ACTION,
    title: "Study live view",
    icon: "autoresearch-flask",
    layout: "flush",
    component: LivePanel,
  });
});
