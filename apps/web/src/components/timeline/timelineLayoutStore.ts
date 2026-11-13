import type { EnvironmentId } from "@t3tools/contracts";
import type { SerializedDockview } from "dockview-react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";

export const TIMELINE_PANEL_IDS = [
  "monitor",
  "timeline",
  "script",
  "markers",
  "edits",
  "history",
] as const;
export type TimelinePanelId = (typeof TIMELINE_PANEL_IDS)[number];

export const TIMELINE_PANEL_TITLES: Record<TimelinePanelId, string> = {
  monitor: "Monitor",
  timeline: "Timeline",
  script: "Script",
  markers: "Markers",
  edits: "Edits",
  history: "History",
};

const isPanelId = (value: unknown): value is TimelinePanelId =>
  typeof value === "string" && (TIMELINE_PANEL_IDS as ReadonlyArray<string>).includes(value);

/** Every thread of a project shows the same workspace, so layouts are keyed by project. */
export const timelineProjectKey = (environmentId: EnvironmentId, workspaceRoot: string) =>
  `${environmentId}:${workspaceRoot.replace(/\/+$/, "")}`;

/** Where a panel goes when it is opened again, given the panels already open. */
export type TimelinePanelPlacement =
  | { readonly direction: "left" | "right" }
  | { readonly referencePanel: TimelinePanelId; readonly direction: "above" | "below" | "within" }
  | null;

export const timelinePanelPlacement = (
  id: TimelinePanelId,
  open: ReadonlyArray<TimelinePanelId>,
): TimelinePanelPlacement => {
  if (open.length === 0) return null;
  switch (id) {
    case "monitor":
      return open.includes("timeline")
        ? { referencePanel: "timeline", direction: "above" }
        : { direction: "left" };
    case "timeline":
      return open.includes("monitor")
        ? { referencePanel: "monitor", direction: "below" }
        : { direction: "left" };
    case "script":
      return { direction: "right" };
    // Lists to scan now and then: a tab beside the other side panels, so opening one never
    // takes room from the monitor or the tracks.
    case "markers":
    case "edits":
    case "history": {
      const beside = (["script", "markers", "edits", "history"] as const).find(
        (other) => other !== id && open.includes(other),
      );
      return beside === undefined
        ? { direction: "right" }
        : { referencePanel: beside, direction: "within" };
    }
  }
};

interface SerializedNode {
  readonly type?: unknown;
  readonly data?: unknown;
}

/** The panel ids a serialized grid shows, or null when the grid isn't one dockview wrote. */
const gridViews = (node: SerializedNode, into: Array<unknown>): boolean => {
  if (node.type === "branch") {
    return (
      Array.isArray(node.data) &&
      node.data.every(
        (child) => typeof child === "object" && child !== null && gridViews(child, into),
      )
    );
  }
  if (node.type !== "leaf" || typeof node.data !== "object" || node.data === null) return false;
  const views = (node.data as { views?: unknown }).views;
  if (!Array.isArray(views)) return false;
  into.push(...views);
  return true;
};

/**
 * A saved layout when it still describes this workspace: dockview's shape, only the panels that
 * exist today, every panel the grid shows defined, and at least one panel. Anything else is
 * dropped so the workspace falls back to its default rather than opening broken or empty.
 */
export const validTimelineLayout = (value: unknown): SerializedDockview | null => {
  if (typeof value !== "object" || value === null) return null;
  const { grid, panels, floatingGroups, popoutGroups } = value as Partial<
    Record<keyof SerializedDockview, unknown>
  >;
  if (typeof grid !== "object" || grid === null || typeof panels !== "object" || panels === null) {
    return null;
  }
  // The workspace has no floating or popped-out windows.
  if (Array.isArray(floatingGroups) && floatingGroups.length > 0) return null;
  if (Array.isArray(popoutGroups) && popoutGroups.length > 0) return null;
  const ids = Object.keys(panels);
  if (ids.length === 0 || !ids.every(isPanelId)) return null;
  const root = (grid as { root?: unknown }).root;
  if (typeof root !== "object" || root === null) return null;
  const views: Array<unknown> = [];
  if (!gridViews(root, views) || views.length === 0) return null;
  if (!views.every((view) => isPanelId(view) && ids.includes(view))) return null;
  return value as SerializedDockview;
};

/** What the mounted workspace lets the header, the Panels menu and the command palette do. */
export interface TimelineWorkspaceControls {
  readonly show: (id: TimelinePanelId) => void;
  readonly close: (id: TimelinePanelId) => void;
  readonly reset: () => void;
}

interface ActiveTimelineWorkspace {
  readonly projectKey: string;
  readonly open: ReadonlyArray<TimelinePanelId>;
  /** Open panels that are on screen: not stacked behind another tab or a maximized group. */
  readonly visible: ReadonlyArray<TimelinePanelId>;
  readonly controls: TimelineWorkspaceControls;
}

interface TimelineLayoutState {
  readonly layoutByProjectKey: Readonly<Record<string, SerializedDockview>>;
  /** The workspace on screen, if any; not persisted. */
  readonly active: ActiveTimelineWorkspace | null;
  readonly saveLayout: (projectKey: string, layout: SerializedDockview) => void;
  readonly clearLayout: (projectKey: string) => void;
  readonly setActive: (active: ActiveTimelineWorkspace | null) => void;
}

const TIMELINE_LAYOUT_STORAGE_KEY = "stellar:timeline-layout";
const TIMELINE_LAYOUT_STORAGE_VERSION = 1;

export const migratePersistedTimelineLayout = (
  persisted: unknown,
  version: number,
): Pick<TimelineLayoutState, "layoutByProjectKey"> => {
  if (version !== TIMELINE_LAYOUT_STORAGE_VERSION) return { layoutByProjectKey: {} };
  const stored =
    typeof persisted === "object" && persisted !== null && "layoutByProjectKey" in persisted
      ? persisted.layoutByProjectKey
      : null;
  if (typeof stored !== "object" || stored === null) return { layoutByProjectKey: {} };
  return {
    layoutByProjectKey: Object.fromEntries(
      Object.entries(stored).flatMap(([key, layout]) => {
        const valid = validTimelineLayout(layout);
        return valid === null ? [] : [[key, valid]];
      }),
    ),
  };
};

export const useTimelineLayoutStore = create<TimelineLayoutState>()(
  persist(
    (set) => ({
      layoutByProjectKey: {},
      active: null,
      saveLayout: (projectKey, layout) =>
        set((state) => ({
          layoutByProjectKey: { ...state.layoutByProjectKey, [projectKey]: layout },
        })),
      clearLayout: (projectKey) =>
        set((state) => {
          const { [projectKey]: _cleared, ...layoutByProjectKey } = state.layoutByProjectKey;
          return { layoutByProjectKey };
        }),
      setActive: (active) => set({ active }),
    }),
    {
      name: TIMELINE_LAYOUT_STORAGE_KEY,
      version: TIMELINE_LAYOUT_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ layoutByProjectKey: state.layoutByProjectKey }),
      migrate: migratePersistedTimelineLayout,
      // A layout edited by hand, or written by an older build, is checked as it loads.
      merge: (persisted, current) => ({
        ...current,
        ...migratePersistedTimelineLayout(persisted, TIMELINE_LAYOUT_STORAGE_VERSION),
      }),
    },
  ),
);

/** The saved layout for a project, or null to build the default. */
export const savedTimelineLayout = (projectKey: string): SerializedDockview | null =>
  validTimelineLayout(useTimelineLayoutStore.getState().layoutByProjectKey[projectKey]);
