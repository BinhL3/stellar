import type { EnvironmentId } from "@t3tools/contracts";
import type { SerializedDockview } from "dockview-react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "~/lib/storage";

export const TIMELINE_PANEL_IDS = [
  "chat",
  "monitor",
  "timeline",
  "markers",
  "edits",
  "history",
] as const;
export type TimelinePanelId = (typeof TIMELINE_PANEL_IDS)[number];

export const TIMELINE_PANEL_TITLES: Record<TimelinePanelId, string> = {
  chat: "Chat",
  monitor: "Monitor",
  timeline: "Timeline",
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
  | { readonly direction: "above" | "below" }
  | {
      readonly referencePanel: TimelinePanelId;
      readonly direction: "above" | "below" | "left" | "right" | "within";
    }
  | null;

export const timelinePanelPlacement = (
  id: TimelinePanelId,
  open: ReadonlyArray<TimelinePanelId>,
): TimelinePanelPlacement => {
  if (open.length === 0) return null;
  switch (id) {
    // The conversation goes back to the left edge, beside everything, as in the defaults.
    case "chat":
      return { direction: "left" };
    case "monitor":
      if (open.includes("timeline")) return { referencePanel: "timeline", direction: "above" };
      return open.includes("chat")
        ? { referencePanel: "chat", direction: "right" }
        : { direction: "left" };
    case "timeline":
      if (open.includes("monitor")) return { referencePanel: "monitor", direction: "below" };
      return open.includes("chat") ? { direction: "below" } : { direction: "left" };
    // Lists to scan now and then: a tab beside the other side panels, so opening one never
    // takes room from the monitor or the tracks.
    case "markers":
    case "edits":
    case "history": {
      const beside = (["markers", "edits", "history"] as const).find(
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
// 2: the chat became a dock panel; earlier layouts have no place for it and fall back to the default.
const TIMELINE_LAYOUT_STORAGE_VERSION = 2;

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

/** Below this width the dock stacks its panels instead of setting them side by side. */
export const NARROW_DOCK_PX = 760;
const PORTRAIT_MONITOR_MIN_PX = 240;
// The most of the dock a tall monitor takes, so the tracks keep a workable width.
const PORTRAIT_MONITOR_SHARE = 0.55;
// Room around a tall picture so the column doesn't hug it.
const PORTRAIT_MONITOR_MARGIN_PX = 48;
const CHAT_COLUMN_SHARE = 0.3;
const CHAT_COLUMN_MIN_PX = 320;
const CHAT_COLUMN_MAX_PX = 480;

export interface PlannedTimelinePanel {
  readonly id: TimelinePanelId;
  readonly position: TimelinePanelPlacement;
  readonly initialWidth?: number;
  readonly initialHeight?: number;
}

const clamp = (value: number, min: number, max: number) =>
  Math.round(Math.max(min, Math.min(max, value)));

/**
 * A fresh dock's panels, in the order they are added. A tall picture gets a full-height column
 * beside chat-over-timeline; a wide one sits beside a chat column above a full-width timeline;
 * a narrow dock stacks chat, monitor and timeline.
 */
export const defaultTimelineLayout = (dock: {
  readonly portrait: boolean;
  readonly chat: boolean;
  readonly width: number;
  readonly height: number;
}): ReadonlyArray<PlannedTimelinePanel> => {
  const { width, height } = dock;
  const portraitMonitorWidth = clamp(
    (height * 9) / 16 + PORTRAIT_MONITOR_MARGIN_PX,
    PORTRAIT_MONITOR_MIN_PX,
    Math.max(PORTRAIT_MONITOR_MIN_PX, width * PORTRAIT_MONITOR_SHARE),
  );
  if (!dock.chat) {
    return dock.portrait
      ? [
          { id: "timeline", position: null },
          { id: "monitor", position: { direction: "right" }, initialWidth: portraitMonitorWidth },
        ]
      : [
          { id: "monitor", position: null },
          { id: "timeline", position: { referencePanel: "monitor", direction: "below" } },
        ];
  }
  if (width < NARROW_DOCK_PX) {
    return [
      { id: "chat", position: null },
      {
        id: "monitor",
        position: { direction: "below" },
        initialHeight: Math.round(height * (dock.portrait ? 0.35 : 0.3)),
      },
      {
        id: "timeline",
        position: { direction: "below" },
        initialHeight: Math.round(height * 0.25),
      },
    ];
  }
  if (dock.portrait) {
    return [
      { id: "chat", position: null },
      { id: "monitor", position: { direction: "right" }, initialWidth: portraitMonitorWidth },
      {
        id: "timeline",
        position: { referencePanel: "chat", direction: "below" },
        initialHeight: Math.round(height * 0.45),
      },
    ];
  }
  return [
    { id: "monitor", position: null },
    {
      id: "chat",
      position: { referencePanel: "monitor", direction: "left" },
      initialWidth: clamp(width * CHAT_COLUMN_SHARE, CHAT_COLUMN_MIN_PX, CHAT_COLUMN_MAX_PX),
    },
    { id: "timeline", position: { direction: "below" }, initialHeight: Math.round(height * 0.36) },
  ];
};
