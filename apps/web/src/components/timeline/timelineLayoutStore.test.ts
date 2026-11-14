import type { SerializedDockview } from "dockview-react";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  defaultTimelineLayout,
  migratePersistedTimelineLayout,
  NARROW_DOCK_PX,
  savedTimelineLayout,
  timelinePanelPlacement,
  useTimelineLayoutStore,
  validTimelineLayout,
} from "./timelineLayoutStore";

const leaf = (views: ReadonlyArray<string>, id: string) => ({
  type: "leaf",
  data: { views, activeView: views[0], id },
  size: 100,
});

const panel = (id: string) => ({ id, contentComponent: id, title: id });

/** Monitor over a Timeline and Markers stack: the shape dockview's toJSON writes. */
const layout = (
  views: { readonly top: ReadonlyArray<string>; readonly bottom: ReadonlyArray<string> } = {
    top: ["monitor"],
    bottom: ["timeline", "markers"],
  },
) =>
  ({
    grid: {
      root: { type: "branch", data: [leaf(views.top, "1"), leaf(views.bottom, "2")], size: 800 },
      width: 800,
      height: 600,
      orientation: "VERTICAL",
    },
    panels: Object.fromEntries([...views.top, ...views.bottom].map((id) => [id, panel(id)])),
    activeGroup: "1",
  }) as unknown as SerializedDockview;

async function reloadStore() {
  const { storage, name } = useTimelineLayoutStore.persist.getOptions();
  const persisted = await storage!.getItem(name!);
  useTimelineLayoutStore.setState(useTimelineLayoutStore.getInitialState());
  if (persisted !== null) await storage!.setItem(name!, persisted);
  await useTimelineLayoutStore.persist.rehydrate();
}

beforeEach(() => {
  useTimelineLayoutStore.setState({ layoutByProjectKey: {}, active: null });
});

describe("timelineLayoutStore", () => {
  it("restores each project's layout after a reload, and reset drops it for the default", async () => {
    const stacked = layout();
    const split = layout({ top: ["monitor", "timeline"], bottom: ["history"] });
    useTimelineLayoutStore.getState().saveLayout("env:/a", stacked);
    useTimelineLayoutStore.getState().saveLayout("env:/b", split);

    await reloadStore();
    expect(savedTimelineLayout("env:/a")).toEqual(stacked);
    expect(savedTimelineLayout("env:/b")).toEqual(split);

    useTimelineLayoutStore.getState().clearLayout("env:/a");
    await reloadStore();
    expect(savedTimelineLayout("env:/a")).toBeNull();
    expect(savedTimelineLayout("env:/b")).toEqual(split);
  });

  it("falls back to the default for a layout it can't use", () => {
    expect(validTimelineLayout(layout())).not.toBeNull();
    // Not dockview's shape.
    expect(validTimelineLayout({ panels: {} })).toBeNull();
    expect(validTimelineLayout("monitor")).toBeNull();
    // A panel this build no longer has.
    expect(validTimelineLayout(layout({ top: ["monitor"], bottom: ["bins"] }))).toBeNull();
    // The Script panel, saved by builds that had one.
    expect(
      validTimelineLayout(layout({ top: ["monitor"], bottom: ["timeline", "script"] })),
    ).toBeNull();
    // A grid that shows a panel the layout doesn't define.
    const missing = layout();
    const { markers: _markers, ...panels } = missing.panels;
    expect(validTimelineLayout({ ...missing, panels })).toBeNull();
    // Nothing to show.
    expect(validTimelineLayout({ ...layout(), panels: {} })).toBeNull();
    // A floating window, which the workspace doesn't have.
    expect(validTimelineLayout({ ...layout(), floatingGroups: [{}] })).toBeNull();
  });

  it("drops stored layouts from another storage version or with a broken entry", () => {
    expect(migratePersistedTimelineLayout({ layoutByProjectKey: { a: layout() } }, 0)).toEqual({
      layoutByProjectKey: {},
    });
    // Version 1 layouts predate the docked chat: they'd reopen without it, so the default wins.
    expect(migratePersistedTimelineLayout({ layoutByProjectKey: { a: layout() } }, 1)).toEqual({
      layoutByProjectKey: {},
    });
    expect(
      migratePersistedTimelineLayout({ layoutByProjectKey: { a: layout(), b: { grid: 1 } } }, 2),
    ).toEqual({ layoutByProjectKey: { a: layout() } });
    const withChat = layout({ top: ["chat", "monitor"], bottom: ["timeline"] });
    expect(validTimelineLayout(withChat)).not.toBeNull();
  });

  it("opens the chat beside the picture and the timeline under them", () => {
    const shape = (dock: Parameters<typeof defaultTimelineLayout>[0]) =>
      defaultTimelineLayout(dock).map(({ id, position }) => [id, position]);
    const wide = { chat: true, width: 1600, height: 900 };

    // 9:16: chat over the timeline on the left, the monitor a full-height column on the right.
    expect(shape({ ...wide, portrait: true })).toEqual([
      ["chat", null],
      ["monitor", { direction: "right" }],
      ["timeline", { referencePanel: "chat", direction: "below" }],
    ]);
    const portrait = defaultTimelineLayout({ ...wide, portrait: true });
    // The column fits a 9:16 picture at the dock's height, with a margin.
    expect(portrait[1]?.initialWidth).toBe(Math.round((900 * 9) / 16 + 48));
    expect(portrait[2]?.initialHeight).toBe(405);

    // 16:9: chat a left column beside the monitor, the timeline across the whole bottom.
    expect(shape({ ...wide, portrait: false })).toEqual([
      ["monitor", null],
      ["chat", { referencePanel: "monitor", direction: "left" }],
      ["timeline", { direction: "below" }],
    ]);
    const landscape = defaultTimelineLayout({ ...wide, portrait: false });
    expect(landscape[1]?.initialWidth).toBe(480);
    expect(landscape[2]?.initialHeight).toBe(324);
    expect(defaultTimelineLayout({ ...wide, width: 1000, portrait: false })[1]?.initialWidth).toBe(
      320,
    );

    // Narrow: everything stacked, the chat on top, in either shape.
    for (const portraitShape of [true, false]) {
      expect(
        shape({ chat: true, width: NARROW_DOCK_PX - 1, height: 900, portrait: portraitShape }),
      ).toEqual([
        ["chat", null],
        ["monitor", { direction: "below" }],
        ["timeline", { direction: "below" }],
      ]);
    }
  });

  it("keeps the monitor and timeline split where the chat can't dock", () => {
    const shape = (portrait: boolean) =>
      defaultTimelineLayout({ chat: false, width: 1600, height: 900, portrait }).map(
        ({ id }) => id,
      );
    expect(shape(true)).toEqual(["timeline", "monitor"]);
    expect(shape(false)).toEqual(["monitor", "timeline"]);
  });

  it("reopens a closed panel where it belongs among the open ones", () => {
    expect(timelinePanelPlacement("monitor", [])).toBeNull();
    expect(timelinePanelPlacement("monitor", ["timeline", "markers"])).toEqual({
      referencePanel: "timeline",
      direction: "above",
    });
    expect(timelinePanelPlacement("monitor", ["markers"])).toEqual({ direction: "left" });
    expect(timelinePanelPlacement("monitor", ["chat"])).toEqual({
      referencePanel: "chat",
      direction: "right",
    });
    expect(timelinePanelPlacement("timeline", ["chat"])).toEqual({ direction: "below" });
    // A closed chat comes back as the left column.
    expect(timelinePanelPlacement("chat", ["monitor", "timeline"])).toEqual({ direction: "left" });
    expect(timelinePanelPlacement("chat", [])).toBeNull();
    expect(timelinePanelPlacement("timeline", ["monitor"])).toEqual({
      referencePanel: "monitor",
      direction: "below",
    });
    expect(timelinePanelPlacement("timeline", ["markers"])).toEqual({ direction: "left" });
    // Markers and History share the side column, as tabs of whichever side panel is open.
    expect(timelinePanelPlacement("markers", ["monitor", "timeline"])).toEqual({
      direction: "right",
    });
    expect(timelinePanelPlacement("history", ["monitor", "timeline", "edits"])).toEqual({
      referencePanel: "edits",
      direction: "within",
    });
    expect(timelinePanelPlacement("markers", ["monitor", "history"])).toEqual({
      referencePanel: "history",
      direction: "within",
    });
  });
});
