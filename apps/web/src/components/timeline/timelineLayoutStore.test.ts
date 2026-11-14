import type { SerializedDockview } from "dockview-react";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  migratePersistedTimelineLayout,
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
    expect(
      migratePersistedTimelineLayout({ layoutByProjectKey: { a: layout(), b: { grid: 1 } } }, 1),
    ).toEqual({ layoutByProjectKey: { a: layout() } });
  });

  it("reopens a closed panel where it belongs among the open ones", () => {
    expect(timelinePanelPlacement("monitor", [])).toBeNull();
    expect(timelinePanelPlacement("monitor", ["timeline", "markers"])).toEqual({
      referencePanel: "timeline",
      direction: "above",
    });
    expect(timelinePanelPlacement("monitor", ["markers"])).toEqual({ direction: "left" });
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
