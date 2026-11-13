import "dockview-react/dist/styles/dockview.css";

import {
  type DockviewApi,
  type DockviewReadyEvent,
  type DockviewTheme,
  DockviewReact,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelProps,
  type IWatermarkPanelProps,
} from "dockview-react";
import { Maximize2Icon, Minimize2Icon } from "lucide-react";
import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  savedTimelineLayout,
  TIMELINE_PANEL_IDS,
  TIMELINE_PANEL_TITLES,
  type TimelinePanelId,
  timelinePanelPlacement,
  useTimelineLayoutStore,
} from "./timelineLayoutStore";
import { TimelinePlayerContext, useTimelinePlayer } from "./timelinePlayer";

/** What each panel shows; the viewer above the dock owns their state. */
export interface TimelineWorkspacePanels {
  readonly monitor: ReactNode;
  readonly timeline: ReactNode;
  readonly script: ReactNode;
  readonly markers: ReactNode;
  readonly edits: ReactNode;
  readonly history: ReactNode;
}

const PanelsContext = createContext<TimelineWorkspacePanels | null>(null);

const usePanels = () => {
  const panels = use(PanelsContext);
  if (panels === null) throw new Error("Timeline panels render inside a TimelineWorkspace.");
  return panels;
};

// Styled from the app's tokens in index.css, under this class.
const THEME: DockviewTheme = {
  name: "stellar",
  className: "dockview-theme-stellar",
  gap: 0,
  dndOverlayMounting: "absolute",
  dndPanelOverlay: "group",
  dndTabIndicator: "line",
  dndOverlayBorder: "1px solid var(--primary)",
};

// Small enough that the three panels fit side by side in the right panel at its narrowest.
const CONSTRAINTS: Record<TimelinePanelId, { minimumWidth: number; minimumHeight: number }> = {
  monitor: { minimumWidth: 120, minimumHeight: 120 },
  timeline: { minimumWidth: 160, minimumHeight: 100 },
  script: { minimumWidth: 160, minimumHeight: 100 },
  markers: { minimumWidth: 160, minimumHeight: 100 },
  edits: { minimumWidth: 160, minimumHeight: 100 },
  history: { minimumWidth: 160, minimumHeight: 100 },
};

const SCRIPT_WIDTH_PX = 320;
// Below this window width the script starts closed, so the timeline keeps its room.
const SCRIPT_DEFAULT_OPEN_PX = 1280;
const SAVE_DELAY_MS = 400;

const openPanels = (api: DockviewApi) =>
  TIMELINE_PANEL_IDS.filter((id) => api.getPanel(id) !== undefined);

const addTimelinePanel = (api: DockviewApi, id: TimelinePanelId) => {
  const position = timelinePanelPlacement(id, openPanels(api));
  api.addPanel({
    id,
    component: id,
    title: TIMELINE_PANEL_TITLES[id],
    ...CONSTRAINTS[id],
    ...(id === "monitor" || id === "timeline" ? {} : { initialWidth: SCRIPT_WIDTH_PX }),
    ...(position === null ? {} : { position }),
  });
};

/** Monitor on top, the timeline under it, the script as a column on the right when there's room. */
const buildDefaultLayout = (api: DockviewApi) => {
  addTimelinePanel(api, "monitor");
  addTimelinePanel(api, "timeline");
  if (window.innerWidth >= SCRIPT_DEFAULT_OPEN_PX) addTimelinePanel(api, "script");
  api.getPanel("monitor")?.api.setActive();
};

const restoreLayout = (api: DockviewApi, projectKey: string) => {
  const saved = savedTimelineLayout(projectKey);
  if (saved !== null) {
    try {
      // Saved panels carry the minimum sizes they were made with; today's apply instead.
      api.fromJSON({
        ...saved,
        panels: Object.fromEntries(
          Object.entries(saved.panels).map(([id, panel]) => [
            id,
            { ...panel, ...CONSTRAINTS[id as TimelinePanelId] },
          ]),
        ),
      });
      if (api.panels.length > 0) return;
    } catch {
      // A layout this build can't read; the default replaces it below.
    }
    api.clear();
  }
  buildDefaultLayout(api);
};

const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((id, index) => id === b[index]);

/**
 * The dock for one project's timeline. It keeps the panel arrangement in the layout store and
 * publishes which panels are open, so the header, the Panels menu and the command palette can
 * show and hide them.
 */
export function TimelineWorkspace(props: {
  readonly projectKey: string;
  readonly panels: TimelineWorkspacePanels;
}) {
  const [api, setApi] = useState<DockviewApi | null>(null);
  const { projectKey } = props;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Follows dockview's layout events and saves the arrangement as the user changes it.
  useEffect(() => {
    if (api === null) return;
    const store = useTimelineLayoutStore.getState();
    const controls = {
      show: (id: TimelinePanelId) => {
        const panel = api.getPanel(id);
        if (panel) panel.api.setActive();
        else addTimelinePanel(api, id);
      },
      close: (id: TimelinePanelId) => api.getPanel(id)?.api.close(),
      reset: () => {
        if (api.hasMaximizedGroup()) api.exitMaximizedGroup();
        api.clear();
        buildDefaultLayout(api);
      },
    };
    let published: { open: ReadonlyArray<string>; visible: ReadonlyArray<string> } | null = null;
    const publish = () => {
      const open = openPanels(api);
      // A maximized group leaves the others in the grid at no size, still "visible" to dockview.
      const maximized = api.hasMaximizedGroup();
      const visible = open.filter((id) => {
        const panel = api.getPanel(id);
        return panel?.api.isVisible === true && (!maximized || panel.group.api.isMaximized());
      });
      if (published && sameIds(open, published.open) && sameIds(visible, published.visible)) return;
      published = { open, visible };
      store.setActive({ projectKey, open, visible, controls });
    };
    publish();

    let saveTimer: number | null = null;
    const save = () => {
      saveTimer = null;
      if (api.panels.length > 0)
        useTimelineLayoutStore.getState().saveLayout(projectKey, api.toJSON());
    };
    const disposables = [
      api.onDidLayoutChange(() => {
        publish();
        if (saveTimer !== null) window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(save, SAVE_DELAY_MS);
      }),
      api.onDidAddPanel(publish),
      api.onDidRemovePanel(publish),
      api.onDidActivePanelChange(publish),
      api.onDidMaximizedGroupChange(publish),
    ];
    return () => {
      for (const disposable of disposables) disposable.dispose();
      if (saveTimer !== null) {
        window.clearTimeout(saveTimer);
        save();
      }
      if (useTimelineLayoutStore.getState().active?.controls === controls) {
        useTimelineLayoutStore.getState().setActive(null);
      }
    };
  }, [api, projectKey]);

  const onReady = (event: DockviewReadyEvent) => {
    restoreLayout(event.api, projectKey);
    setApi(event.api);
  };

  return (
    <PanelsContext value={props.panels}>
      <div className="min-h-0 min-w-0 flex-1">
        <DockviewReact
          theme={THEME}
          components={PANEL_COMPONENTS}
          rightHeaderActionsComponent={MaximizeAction}
          watermarkComponent={NoPanels}
          onReady={onReady}
          disableFloatingGroups
          singleTabMode="default"
          getTabContextMenuItems={() => ["maximize", "separator", "close"]}
        />
      </div>
    </PanelsContext>
  );
}

function MonitorPanel() {
  return usePanels().monitor;
}

function TimelineTracksPanel() {
  return usePanels().timeline;
}

const subscribeVisibility = (api: IDockviewPanelProps["api"]) => (listener: () => void) => {
  const disposable = api.onDidVisibilityChange(listener);
  return () => disposable.dispose();
};

/** The script follows the playhead only while it is on screen. */
function ScriptDockPanel(props: IDockviewPanelProps) {
  const visible = useSyncExternalStore(subscribeVisibility(props.api), () => props.api.isVisible);
  const player = useTimelinePlayer();
  const script = usePanels().script;
  if (visible) return script;
  const frame = player.playhead.get();
  return (
    <TimelinePlayerContext
      value={{ ...player, playhead: { get: () => frame, subscribe: () => () => {} } }}
    >
      {script}
    </TimelinePlayerContext>
  );
}

function MarkersDockPanel() {
  return usePanels().markers;
}

function EditsDockPanel() {
  return usePanels().edits;
}

function HistoryDockPanel() {
  return usePanels().history;
}

const PANEL_COMPONENTS: Record<TimelinePanelId, React.FunctionComponent<IDockviewPanelProps>> = {
  monitor: MonitorPanel,
  timeline: TimelineTracksPanel,
  script: ScriptDockPanel,
  markers: MarkersDockPanel,
  edits: EditsDockPanel,
  history: HistoryDockPanel,
};

const subscribeMaximized = (api: DockviewApi) => (listener: () => void) => {
  const disposable = api.onDidMaximizedGroupChange(listener);
  return () => disposable.dispose();
};

function MaximizeAction(props: IDockviewHeaderActionsProps) {
  const maximized = useSyncExternalStore(subscribeMaximized(props.containerApi), () =>
    props.api.isMaximized(),
  );
  const title = props.activePanel?.title ?? "panel";
  const label = maximized ? `Restore ${title}` : `Maximize ${title}`;
  return (
    <div className="flex h-full items-center pr-1">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={label}
              onClick={() => (maximized ? props.api.exitMaximized() : props.api.maximize())}
            />
          }
        >
          {maximized ? <Minimize2Icon /> : <Maximize2Icon />}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{label}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function NoPanels(_props: IWatermarkPanelProps) {
  const controls = useTimelineLayoutStore((state) => state.active?.controls ?? null);
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Every panel is closed</EmptyTitle>
        <EmptyDescription>
          Open one from Panels, or put the workspace back as it was.
        </EmptyDescription>
      </EmptyHeader>
      {controls ? (
        <EmptyContent>
          <Button variant="outline" onClick={controls.reset}>
            Reset layout
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
