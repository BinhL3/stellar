import { compactLine } from "@t3tools/timeline/compactView";
import {
  applyEdits,
  editClipId,
  gapAt,
  linkedTracks,
  rippleDeleteBlocked,
  type TimelineEdit,
} from "@t3tools/timeline/edits";
import { type LaidOutClip, type LaidOutTrack, layoutTimeline } from "@t3tools/timeline/layout";
import { timelineMarkers } from "@t3tools/timeline/markers";
import {
  type EffectRef,
  serializeTimeline,
  type Timeline,
  TIMELINE_NAMESPACE,
} from "@t3tools/timeline/otio";
import type { TimelineAction } from "@t3tools/timeline/premiere/shortcuts";
import type { ProxyPeaks } from "@t3tools/timeline/proxies";
import {
  ArrowLeftRightIcon,
  AudioLinesIcon,
  BookmarkPlusIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftRightIcon,
  EllipsisIcon,
  FilmIcon,
  FoldHorizontalIcon,
  HandIcon,
  ImageIcon,
  MagnetIcon,
  MaximizeIcon,
  MessageSquarePlusIcon,
  MinusIcon,
  MousePointer2Icon,
  MoveHorizontalIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RepeatIcon,
  ScissorsIcon,
  SkipBackIcon,
  SkipForwardIcon,
  SparklesIcon,
  TypeIcon,
  Undo2Icon,
  XIcon,
  ZoomInIcon,
} from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";

import { graphicText } from "~/components/timeline/clipTransform";
import type { MarkerPatch } from "~/components/timeline/MarkerEditor";
import { MarkersPanel } from "~/components/timeline/MarkersPanel";
import { RulerMarkers, type ScriptTick } from "~/components/timeline/RulerMarkers";
import type { PreviewEngine } from "~/components/timeline/previewEngine";
import { useTimelineLayoutStore } from "~/components/timeline/timelineLayoutStore";
import { Backdrop, useBackdropHold } from "~/components/backdrop/Backdrop";
import { TimelinePlayerContext } from "~/components/timeline/timelinePlayer";
import { MonitorAudio } from "~/components/timeline/MonitorAudio";
import { type PreviewMedia, TimelinePreview } from "~/components/timeline/TimelinePreview";
import { listenToCut } from "~/components/timeline/timelineEditsStore";
import { PanelTools, TimelineWorkspace } from "~/components/timeline/TimelineWorkspace";
import { Bay } from "~/components/timeline/bay";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "~/components/ui/menu";
import { Kbd } from "~/components/ui/kbd";
import {
  ACTION_LABELS,
  actionsFor,
  comboFromEvent,
  comboLabel,
  combosFor,
  TOOL_ACTIONS,
  TOOL_HINTS,
  type TimelineTool,
  useTimelineKeymap,
} from "~/components/timeline/timelineKeymap";
import { ProvideTimelineCommand } from "~/components/timeline/timelineCommands";
import { toastManager } from "~/components/ui/toast";
import { Textarea } from "~/components/ui/textarea";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";

const ZOOM_STEP = 1.5;
// Zooming in stops when a frame is this wide, which is enough to trim frame by frame.
const MAX_PX_PER_FRAME = 24;
// Pinch arrives as a ctrl+wheel with small deltas; Option+wheel (Premiere's zoom) has larger ones.
const PINCH_ZOOM_RATE = 0.01;
const WHEEL_ZOOM_RATE = 0.002;
const TICK_SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900] as const;
// Show roughly this many seconds across the panel by default, then scroll.
const DEFAULT_VISIBLE_SECONDS = 20;
const LABEL_PX = 48;
// Clips this far outside the visible range still render, so scrolling doesn't pop.
const OVERSCAN_PX = 400;
const MAX_SHUTTLE = 8;
const SLOW_SHUTTLE = 0.5;
// Play around the playhead covers this much either side, as Premiere's preroll and postroll do.
const PLAY_AROUND_SECONDS = 2;
// A press that moves less than this is a click (select), not a drag.
const DRAG_THRESHOLD_PX = 3;
// Edges within this distance of a cut, the playhead or a mark snap to it.
const SNAP_PX = 8;
const TRIM_HANDLE_PX = 6;

type DragMode = "move" | "start" | "end";

interface Drag {
  readonly id: string;
  /** The tool that started the drag decides the edit; the mode, which part of the clip moves. */
  readonly tool: Exclude<TimelineTool, "razor" | "hand" | "zoom">;
  readonly mode: DragMode;
  readonly fromTrack: string;
  readonly kind: LaidOutTrack["kind"];
  readonly startFrame: number;
  readonly endFrame: number;
  readonly originX: number;
  readonly originY: number;
  readonly deltaFrames: number;
  readonly toTrack: string;
  readonly active: boolean;
}

const dragEdit = (drag: Drag, magnetic: boolean): TimelineEdit => {
  // Slipping drags the media under the clip, so it plays what was on the other side.
  if (drag.tool === "slip") return { kind: "slip", clipId: drag.id, frames: -drag.deltaFrames };
  if (drag.tool === "slide") return { kind: "slide", clipId: drag.id, frames: drag.deltaFrames };
  if (drag.mode !== "move" && drag.tool !== "selection") {
    return {
      kind: drag.tool === "rippleEdit" ? "rippleTrim" : "roll",
      clipId: drag.id,
      edge: drag.mode,
      frame: (drag.mode === "start" ? drag.startFrame : drag.endFrame) + drag.deltaFrames,
    };
  }
  if (drag.mode === "move") {
    return {
      kind: "move",
      clipId: drag.id,
      toTrack: drag.toTrack,
      startFrame: drag.startFrame + drag.deltaFrames,
      ...(magnetic ? { magnetic: true } : {}),
    };
  }
  return {
    kind: "trim",
    clipId: drag.id,
    edge: drag.mode,
    frame: (drag.mode === "start" ? drag.startFrame : drag.endFrame) + drag.deltaFrames,
  };
};

const EDIT_LABELS: Record<TimelineEdit["kind"], string> = {
  move: "move",
  trim: "trim",
  delete: "delete",
  rippleDelete: "ripple delete",
  rippleTrim: "ripple trim",
  roll: "roll",
  slip: "slip",
  slide: "slide",
  split: "cut",
  removeRange: "remove range",
  setEnabled: "enable",
  setText: "text",
  addMarker: "add marker",
  setMarker: "change marker",
  removeMarker: "remove marker",
  insert: "insert",
  overwrite: "overwrite",
};

const editLabel = (edit: TimelineEdit) =>
  edit.kind === "removeRange" ? (edit.ripple ? "extract" : "lift") : EDIT_LABELS[edit.kind];

const STILL_PATH = /\.(png|jpe?g|heic|tiff?|psd|gif|webp|bmp)$/i;
const EXTENSION = /\.[a-z0-9]{2,5}$/i;

type ClipKind = "video" | "still" | "text" | "audio" | "footageAudio";

// Each kind keeps one hue; a footage file's sound is coloured as audio, as it plays as audio.
const FILL_CLASS: Record<ClipKind, string> = {
  video: "bg-clip-video",
  still: "bg-clip-still",
  text: "bg-clip-graphic",
  audio: "bg-clip-audio",
  footageAudio: "bg-clip-audio",
};

// The tint draws a clip's top edge and its waveform.
const TINT_CLASS: Record<ClipKind, string> = {
  video: "text-clip-video-tint",
  still: "text-clip-still-tint",
  text: "text-clip-graphic-tint",
  audio: "text-clip-audio-tint",
  footageAudio: "text-clip-audio-tint",
};

const LEGEND: ReadonlyArray<readonly [ClipKind, string]> = [
  ["video", "Video"],
  ["audio", "Audio"],
  ["still", "Image"],
  ["text", "Text"],
];

// Minor ruler ticks between two labelled ones, by the labelled step in seconds.
const MINOR_TICKS: Record<number, number> = {
  1: 4,
  2: 4,
  5: 5,
  10: 5,
  15: 3,
  30: 6,
  60: 4,
  120: 4,
  300: 5,
  600: 5,
  900: 3,
};
const MIN_MINOR_TICK_PX = 6;

const VIDEO_FILE = /\.(mov|mp4|m4v|mxf|avi|mkv|webm|mts|m2ts)$/i;

const KIND_ICON: Record<ClipKind, typeof FilmIcon> = {
  video: FilmIcon,
  still: ImageIcon,
  text: TypeIcon,
  audio: AudioLinesIcon,
  footageAudio: AudioLinesIcon,
};

const TOOL_ICON: Record<TimelineTool, typeof FilmIcon> = {
  selection: MousePointer2Icon,
  rippleEdit: FoldHorizontalIcon,
  rollingEdit: ArrowLeftRightIcon,
  razor: ScissorsIcon,
  slip: ChevronsLeftRightIcon,
  slide: MoveHorizontalIcon,
  hand: HandIcon,
  zoom: ZoomInIcon,
};

const TOOLS = Object.keys(TOOL_ACTIONS) as Array<TimelineTool>;

// The pointer each tool shows over the tracks.
const TOOL_CURSOR: Record<TimelineTool, string> = {
  selection: "",
  rippleEdit: "cursor-ew-resize",
  rollingEdit: "cursor-col-resize",
  razor: "cursor-crosshair",
  slip: "cursor-ew-resize",
  slide: "cursor-ew-resize",
  hand: "cursor-grab active:cursor-grabbing",
  zoom: "cursor-zoom-in",
};

const TIER_HINT: Record<EffectRef["tier"], string> = {
  portable: "opens in any editor",
  mappable: "nearest match in other editors",
  native: "kept as-is from Premiere",
};

const parseTimeline = (text: string): Timeline | string => {
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value === "object" &&
      value !== null &&
      "OTIO_SCHEMA" in value &&
      value.OTIO_SCHEMA === "Timeline.1"
    ) {
      return value as Timeline;
    }
    return "This file is not an OpenTimelineIO timeline.";
  } catch {
    return "This timeline file is not valid JSON. Show the source to inspect it.";
  }
};

const frameOf = (timeline: Timeline) =>
  (
    timeline.metadata[TIMELINE_NAMESPACE] as
      | { frame?: { width: number; height: number } }
      | undefined
  )?.frame ?? null;

const effectsOf = (item: LaidOutClip): ReadonlyArray<EffectRef> =>
  (item.clip.metadata[TIMELINE_NAMESPACE] as { effects?: ReadonlyArray<EffectRef> } | undefined)
    ?.effects ?? [];

const targetOf = (item: LaidOutClip) => item.clip.media_references.DEFAULT_MEDIA.target_url;

const clipKind = (track: LaidOutTrack, item: LaidOutClip): ClipKind => {
  if (track.kind === "Audio") return VIDEO_FILE.test(targetOf(item)) ? "footageAudio" : "audio";
  const url = targetOf(item);
  if (url === "") return "text";
  return STILL_PATH.test(url) ? "still" : "video";
};

/** Text graphics show their words; files show their name without the extension. */
const clipTitle = (kind: ClipKind, item: LaidOutClip): string => {
  if (kind === "text") {
    const words = graphicText(item);
    return words === "" ? "Text" : `“${words.replace(/\s*[\r\n]+\s*/g, " ")}”`;
  }
  return item.clip.name.replace(EXTENSION, "");
};

/** Editor-style timecode, minutes:seconds:frames, with hours once a timeline passes one. */
const timecode = (frames: number, rate: number): string => {
  const whole = Math.floor(frames + 1e-6);
  const fps = Math.round(rate);
  const totalSeconds = Math.floor(whole / rate + 1e-6);
  const frame = Math.min(fps - 1, Math.max(0, Math.round(whole - totalSeconds * rate)));
  const minutes = Math.floor(totalSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const mm = String(minutes % 60).padStart(hours > 0 ? 2 : 1, "0");
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return `${hours > 0 ? `${hours}:` : ""}${mm}:${ss}:${String(frame).padStart(2, "0")}`;
};

const rulerLabel = (frames: number, rate: number): string => {
  const total = Math.round(frames / rate);
  const minutes = Math.floor(total / 60);
  const hours = Math.floor(minutes / 60);
  const ss = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes % 60).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
};

const seconds = (frames: number, rate: number): string =>
  `${Math.round((frames / rate) * 10) / 10} s`;

const isTyping = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * Playback values outside React state (the playing time changes every frame; the speed on every
 * play and pause). Only the small readouts subscribe, so playback never re-renders the timeline.
 */
function createValueStore() {
  let frame = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => frame,
    set: (next: number) => {
      if (next === frame) return;
      frame = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
type ValueStore = ReturnType<typeof createValueStore>;

/** The speed badge (2×, ◀ 4×) and the play/pause button, which follow the speed store. */
/** Keeps the backdrop still while the monitor plays, so the two never share the frame budget. */
function BackdropHoldWhilePlaying(props: { readonly store: ValueStore }) {
  useBackdropHold(useSyncExternalStore(props.store.subscribe, () => props.store.get() !== 0));
  return null;
}

function SpeedBadge(props: { readonly store: ValueStore }) {
  const speed = useSyncExternalStore(props.store.subscribe, props.store.get);
  if (speed === 0 || speed === 1) return null;
  return (
    <span className="rounded-xs border border-primary/50 px-1 font-mono text-2xs text-primary tabular-nums">
      {speed < 0 ? "◀ " : ""}
      {Math.abs(speed)}×
    </span>
  );
}

function PlayPauseButton(props: {
  readonly store: ValueStore;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}) {
  const playing = useSyncExternalStore(props.store.subscribe, props.store.get) !== 0;
  return (
    <Button
      size="icon-sm"
      aria-label={playing ? "Pause" : "Play"}
      disabled={props.disabled}
      onClick={props.onToggle}
    >
      {playing ? <PauseIcon /> : <PlayIcon />}
    </Button>
  );
}

function PlayheadTimecode(props: {
  readonly store: ValueStore;
  readonly rate: number;
  readonly duration: number;
}) {
  const frame = useSyncExternalStore(props.store.subscribe, props.store.get);
  return (
    <span className="font-mono text-xs tracking-wider whitespace-nowrap tabular-nums">
      <span className="text-sm font-medium text-foreground">{timecode(frame, props.rate)}</span>
      <span className="text-muted-foreground"> / {timecode(props.duration, props.rate)}</span>
    </span>
  );
}

/** The frame's shape as an editor names it (9:16, 4:5, 16:9), or a decimal ratio for odd sizes. */
function aspectLabel(frame: { readonly width: number; readonly height: number }): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const divisor = gcd(frame.width, frame.height);
  const across = frame.width / divisor;
  const down = frame.height / divisor;
  if (across <= 32 && down <= 32) return `${across}:${down}`;
  return frame.width >= frame.height
    ? `${(frame.width / frame.height).toFixed(2)}:1`
    : `1:${(frame.height / frame.width).toFixed(2)}`;
}

/**
 * Pass `media` to show the preview player and its transport above the tracks, and `onCommit` to
 * let people drag, trim and delete clips. Edits stay pending, drawn over the timeline and played
 * by the preview, until they are committed (written back as the `.otio`) or discarded.
 */
/**
 * Space plays from anywhere in the tab, as in an editor: from the page, or from an empty chat
 * box, where a leading space would type nothing useful. Text in the box keeps its spaces.
 */
function SpaceToPlay(props: { readonly onToggle: () => void }) {
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== " " || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.defaultPrevented) return;
    const target = event.target;
    const emptyComposer =
      target instanceof HTMLElement &&
      target.matches('[data-testid="composer-editor"]') &&
      (target.textContent ?? "").trim() === "" &&
      target.querySelector("[data-composer-mention],[data-composer-skill]") === null;
    if (!emptyComposer && target !== document.body) return;
    event.preventDefault();
    event.stopPropagation();
    props.onToggle();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Listens for Space on the window, outside React's tree.
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKey(event);
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, []);
  return null;
}

export default function TimelineViewer(props: {
  readonly text: string;
  readonly media?: PreviewMedia;
  readonly onCommit?: (contents: string) => Promise<boolean>;
  /** Present where a chat is open: right-click "Add to chat" hands it a clip's description. */
  readonly onReference?: (description: string) => void;
  /** Told whether uncommitted edits exist, each time that changes. */
  readonly onPendingEdits?: (pending: boolean) => void;
  /** The editing app's sync badge, shown in the transport row. */
  readonly premiere?: ReactNode;
  /** The monitor bar's actions, beside the frame's aspect, in the dock. */
  readonly monitorTools?: ReactNode;
  /** Beside play in the monitor's transport; in the tracks' tools when nothing can play. */
  readonly transportTools?: ReactNode;
  /** At the start of the tracks' tools. */
  readonly timelineTools?: ReactNode;
  /**
   * With a project, the monitor, tracks and side panels are panels in a dock that keeps the project's
   * layout; without one (a timeline file opened on its own) only the tracks show.
   */
  readonly workspace?: {
    readonly projectKey: string;
    /** The Edits panel's content; it can `useTimelinePlayer`. */
    readonly edits: ReactNode;
    readonly history: ReactNode;
  };
  /** Script lines shown as notches on the ruler; picking one seeks to it. */
  readonly scriptLines?: {
    readonly ticks: ReadonlyArray<ScriptTick>;
    readonly shown: boolean;
    readonly onShownChange: (shown: boolean) => void;
  };
  /** Undo and redo step through saved versions once no uncommitted edit is left to step over. */
  readonly onStepVersion?: (step: "undo" | "redo") => void;
}) {
  const [pending, setPendingState] = useState<{
    readonly base: string;
    readonly edits: ReadonlyArray<TimelineEdit>;
    readonly undone: ReadonlyArray<TimelineEdit>;
  }>({ base: props.text, edits: [], undone: [] });
  const [drag, setDrag] = useState<Drag | null>(null);
  // Magnetic drags close gaps and push clips along instead of overwriting, as in CapCut.
  const [magnetic, setMagnetic] = useState(true);
  const [tool, setTool] = useState<TimelineTool>("selection");
  // A click on a track's empty space picks the gap there, as in Premiere.
  const [gapPick, setGapPick] = useState<{ track: string; frame: number } | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [committing, setCommitting] = useState(false);
  const dragRef = useRef<Drag | null>(null);
  const suppressClickRef = useRef(false);
  const shortcuts = useTimelineKeymap();
  const editable = props.onCommit !== undefined;
  // Edits belong to the text they were made on; a new pull or a commit's reload clears them.
  // A timeline that is only being looked at (a past version) shows none.
  const holdsEdits = editable && pending.base === props.text;
  const edits = holdsEdits ? pending.edits : [];
  const undone = holdsEdits ? pending.undone : [];
  const pulled = parseTimeline(props.text);
  const liveEdits = drag?.active ? [...edits, dragEdit(drag, magnetic)] : edits;
  const timeline = typeof pulled === "string" ? pulled : applyEdits(pulled, liveEdits);
  const layout = typeof timeline === "string" ? null : layoutTimeline(timeline);
  const pulledLayout =
    typeof pulled === "string" || liveEdits.length === 0 ? null : layoutTimeline(pulled);
  const defaultZoom =
    layout === null
      ? 1
      : Math.max(1, layout.durationFrames / layout.rate / DEFAULT_VISIBLE_SECONDS);
  const [zoomLevel, setZoomLevel] = useState<number | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedMarker, setSelectedMarker] = useState<string | null>(null);
  // A marker picked on the ruler opens there; one picked in the Markers list opens in the list.
  const [markerOnRuler, setMarkerOnRuler] = useState(false);
  const [playheadStore] = useState(createValueStore);
  const lineRef = useRef<HTMLDivElement | null>(null);
  const headRef = useRef<HTMLSpanElement | null>(null);
  const scrubHeadRef = useRef<HTMLSpanElement | null>(null);
  const scrubRef = useRef<HTMLDivElement | null>(null);
  const rulerRef = useRef<HTMLDivElement | null>(null);
  // The scroller's scroll offset as of its last scroll event: reading it live forces a layout.
  const scrollOffsetRef = useRef(0);
  const [speedStore] = useState(createValueStore);
  // With the Timeline panel closed or behind another tab, the monitor shows its own scrub bar.
  const projectKey = props.workspace?.projectKey;
  const timelineVisible = useTimelineLayoutStore(
    (state) =>
      projectKey === undefined ||
      state.active?.projectKey !== projectKey ||
      state.active.visible.includes("timeline"),
  );
  const [marks, setMarks] = useState<{ in: number | null; out: number | null }>({
    in: null,
    out: null,
  });
  const [loop, setLoop] = useState(false);
  const [engine, setEngine] = useState<PreviewEngine | null>(null);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewWidth, setViewWidth] = useState(0);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // The exact playhead for handlers, without subscribing the view to it.
  const playheadRef = useRef(0);
  const pendingZoomRef = useRef<{ factor: number; frame: number; x: number } | null>(null);

  const durationFrames = Math.max(layout?.durationFrames ?? 1, 1);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Re-places the DOM-driven playhead when zoom or width rescales the track, or its scrub bar mounts.
  useLayoutEffect(() => {
    const maxZoom = Math.max(
      1,
      (MAX_PX_PER_FRAME * durationFrames + LABEL_PX) / Math.max(1, viewWidth),
    );
    const zoom = Math.min(Math.max(zoomLevel ?? defaultZoom, 1), maxZoom);
    const trackWidth = Math.max(1, viewWidth * zoom - LABEL_PX);
    const x = (playheadRef.current / durationFrames) * trackWidth;
    if (lineRef.current) lineRef.current.style.transform = `translateX(${LABEL_PX + x}px)`;
    if (headRef.current) headRef.current.style.transform = `translateX(${x}px)`;
    // The monitor's scrub bar mounts when the tracks leave the screen.
    if (!timelineVisible && scrubHeadRef.current) {
      scrubHeadRef.current.style.transform = `translateX(${(playheadRef.current / durationFrames) * 100}%)`;
    }
  }, [zoomLevel, viewWidth, durationFrames, defaultZoom, timelineVisible]);
  /** Zooms keeping `frame` under `x` (px from the scroller's left), rendering the wider track first. */
  const zoomAround = (next: number, frame: number, x: number) => {
    flushSync(() => setZoomLevel(Math.max(1, next)));
    const element = scrollerRef.current;
    if (element === null) return;
    const trackWidth = element.scrollWidth - LABEL_PX;
    element.scrollLeft = Math.max(0, LABEL_PX + (frame / durationFrames) * trackWidth - x);
  };

  // Trackpad pinch (ctrl+wheel) and Option+wheel zoom around the pointer, as in Premiere.
  const onWheel = (event: WheelEvent) => {
    const element = scrollerRef.current;
    if (element === null || !(event.ctrlKey || event.altKey)) return;
    event.preventDefault();
    const rate = event.ctrlKey ? PINCH_ZOOM_RATE : WHEEL_ZOOM_RATE;
    const delta = event.deltaY === 0 ? event.deltaX : event.deltaY;
    const x = event.clientX - element.getBoundingClientRect().left;
    const trackWidth = Math.max(1, element.scrollWidth - LABEL_PX);
    const frame = ((element.scrollLeft + x - LABEL_PX) / trackWidth) * durationFrames;
    // A trackpad sends many wheel events per frame; apply them as one zoom per frame.
    const pending = pendingZoomRef.current;
    if (pending !== null) {
      pending.factor *= Math.exp(-delta * rate);
      return;
    }
    pendingZoomRef.current = { factor: Math.exp(-delta * rate), frame: Math.max(0, frame), x };
    requestAnimationFrame(() => {
      const next = pendingZoomRef.current;
      pendingZoomRef.current = null;
      const target = scrollerRef.current;
      if (next === null || target === null) return;
      const current = target.scrollWidth / Math.max(1, target.clientWidth);
      zoomAround(current * next.factor, next.frame, next.x);
    });
  };
  /** The scroller reports its size, and its scroll offset, which a move between panels resets. */
  const onScrollerMeasure = (width: number, left: number) => {
    setViewWidth(width);
    scrollOffsetRef.current = left;
    setScrollLeft(Math.floor(left / (OVERSCAN_PX / 2)) * (OVERSCAN_PX / 2));
  };

  if (typeof timeline === "string" || layout === null) {
    return (
      <div role="alert" className="p-6 text-xs text-muted-foreground">
        {typeof timeline === "string" ? timeline : null}
      </div>
    );
  }

  const rate = layout.rate;
  const duration = durationFrames;
  const maxZoom = Math.max(1, (MAX_PX_PER_FRAME * duration + LABEL_PX) / Math.max(1, viewWidth));
  const zoom = Math.min(Math.max(zoomLevel ?? defaultZoom, 1), maxZoom);
  const percent = (frames: number) => `${(frames / duration) * 100}%`;
  const trackPx = Math.max(1, viewWidth * zoom - LABEL_PX);
  const pxPerFrame = trackPx / duration;
  const durationSeconds = duration / rate;
  const tickSeconds =
    TICK_SECONDS.find((step) => (step / durationSeconds) * trackPx >= 64) ??
    TICK_SECONDS.at(-1) ??
    60;
  const ticks = Array.from(
    { length: Math.floor(durationSeconds / tickSeconds) + 1 },
    (_, i) => i * tickSeconds * rate,
  );
  const minorTickPx = (tickSeconds * rate * pxPerFrame) / (MINOR_TICKS[tickSeconds] ?? 1);
  const visibleStart = (scrollLeft - OVERSCAN_PX) / pxPerFrame;
  const visibleEnd = (scrollLeft + viewWidth + OVERSCAN_PX) / pxPerFrame;
  const inView = (item: LaidOutClip) =>
    viewWidth === 0 || (item.endFrame >= visibleStart && item.startFrame <= visibleEnd);
  // Tracks with clips before or after the pending edits, so a moved-away clip's ghost has a row.
  const tracks = layout.tracks.filter(
    (track) =>
      track.clips.length > 0 ||
      (pulledLayout?.tracks.find((t) => t.name === track.name)?.clips.length ?? 0) > 0,
  );
  const touched = new Set(
    liveEdits.map(editClipId).filter((clipId): clipId is string => clipId !== null),
  );
  const frame = frameOf(timeline);
  const playable = props.media !== undefined && frame !== null && engine !== null;
  let selected: { track: LaidOutTrack; item: LaidOutClip } | null = null;
  for (const track of tracks) {
    const item = track.clips.find((c) => c.key === selectedKey);
    if (item) selected = { track, item };
  }
  const selectedGap =
    gapPick === null || selectedKey !== null
      ? null
      : (() => {
          const found = gapAt(timeline, gapPick.track, gapPick.frame);
          return found === null ? null : { ...found, track: gapPick.track };
        })();
  const cuts = [
    ...new Set(tracks.flatMap((t) => t.clips.flatMap((c) => [c.startFrame, c.endFrame]))),
  ].toSorted((a, b) => a - b);
  const markers = timelineMarkers(timeline);

  const currentFrame = () => engine?.currentFrame ?? playheadRef.current;
  const seek = (target: number) => {
    const clamped = Math.min(Math.max(0, Math.round(target)), layout.durationFrames);
    if (engine) {
      engine.setSpeed(0);
      engine.seek(clamped);
    } else {
      playheadRef.current = clamped;
      showPlayhead(clamped);
    }
    revealFrame(clamped);
  };
  const shuttle = (next: number) => engine?.setSpeed(next);

  const loopRange = (enabled: boolean, range: typeof marks) =>
    enabled
      ? {
          start: range.in ?? 0,
          end:
            range.out !== null && range.out > (range.in ?? 0) ? range.out : layout.durationFrames,
        }
      : null;
  const updateMarks = (next: typeof marks) => {
    setMarks(next);
    engine?.setLoop(loopRange(loop, next));
  };
  const toggleLoop = (enabled: boolean) => {
    setLoop(enabled);
    engine?.setLoop(loopRange(enabled, marks));
  };
  // A jump the user makes (start, end, a cut, a mark) scrolls the tracks so the playhead lands in
  // view, centred; playback instead pages along as the playhead reaches the edge.
  const revealFrame = (frameNumber: number) => {
    const element = scrollerRef.current;
    if (element === null || viewWidth === 0) return;
    const x = LABEL_PX + frameNumber * pxPerFrame;
    if (x > element.scrollLeft + element.clientWidth - 24 || x < element.scrollLeft + LABEL_PX) {
      element.scrollLeft = Math.max(0, x - (element.clientWidth + LABEL_PX) / 2);
    }
  };
  const followPlayhead = (frameNumber: number) => {
    const element = scrollerRef.current;
    if (element === null || viewWidth === 0) return;
    const x = LABEL_PX + frameNumber * pxPerFrame;
    const left = scrollOffsetRef.current;
    if (x > left + viewWidth - 24 || x < left + LABEL_PX) {
      element.scrollLeft = Math.max(0, x - LABEL_PX - 16);
    }
  };
  /** Moves the red line and its ruler head straight in the DOM: one element each, no restyle. */
  const showPlayhead = (frameNumber: number) => {
    playheadStore.set(frameNumber);
    const x = frameNumber * pxPerFrame;
    if (lineRef.current) lineRef.current.style.transform = `translateX(${LABEL_PX + x}px)`;
    if (headRef.current) headRef.current.style.transform = `translateX(${x}px)`;
    // The scrubber's head spans the bar, so a percentage of its own width tracks the playhead.
    if (scrubHeadRef.current) {
      scrubHeadRef.current.style.transform = `translateX(${(frameNumber / layout.durationFrames) * 100}%)`;
    }
    scrubRef.current?.setAttribute("aria-valuenow", String(Math.round(frameNumber)));
    rulerRef.current?.setAttribute("aria-valuenow", String(Math.round(frameNumber)));
  };

  const hasRange = marks.in !== null || marks.out !== null;
  /** A moment (the playhead) or the marked section, in words, with the clips it shows. */
  const referenceMoment = (section: boolean) => {
    const reference = props.onReference;
    if (!reference) return;
    const from = section ? (marks.in ?? 0) : Math.round(currentFrame());
    const to = section ? (marks.out ?? layout.durationFrames) : from + 1;
    const clips = layout.tracks.flatMap((track) =>
      track.clips
        .filter((item) => item.startFrame < to && from < item.endFrame && item.clip.enabled)
        .map(
          (item) => `${track.name} ${clipTitle(clipKind(track, item), item)} (clip ${item.key})`,
        ),
    );
    const where = section
      ? `from ${timecode(from, rate)} to ${timecode(to, rate)} (${seconds(from, rate)} to ${seconds(to, rate)}, ${seconds(to - from, rate)} long)`
      : `at ${timecode(from, rate)} (${seconds(from, rate)} in)`;
    const showing =
      clips.length === 0 ? "" : `, ${section ? "covering" : "showing"} ${clips.join(", ")}`;
    reference(`${where}${showing}`);
  };

  const showPreviewMenu = (event: React.MouseEvent) => {
    const api = readLocalApi();
    if (!api || (!props.onReference && !hasRange)) return;
    event.preventDefault();
    void api.contextMenu
      .show(
        [
          ...(props.onReference ? [{ id: "add-moment", label: "Add this moment to chat" }] : []),
          ...(props.onReference && hasRange
            ? [{ id: "add-section", label: "Add marked section to chat" }]
            : []),
          ...(hasRange ? [{ id: "clear", label: "Clear in and out" }] : []),
        ],
        { x: event.clientX, y: event.clientY },
      )
      .then((clicked) => {
        if (clicked === "add-moment") referenceMoment(false);
        if (clicked === "add-section") referenceMoment(true);
        if (clicked === "clear") updateMarks({ in: null, out: null });
      });
  };

  const setPending = (next: typeof pending) => {
    setPendingState(next);
    props.onPendingEdits?.(next.edits.length > 0);
  };
  const pushEdit = (edit: TimelineEdit) =>
    setPending({ base: props.text, edits: [...edits, edit], undone: [] });
  const undoEdit = () => {
    const last = edits.at(-1);
    if (last === undefined) return;
    setPending({ base: props.text, edits: edits.slice(0, -1), undone: [...undone, last] });
  };
  const redoEdit = () => {
    const next = undone.at(-1);
    if (next === undefined) return;
    setPending({ base: props.text, edits: [...edits, next], undone: undone.slice(0, -1) });
  };
  const discardEdits = () => setPending({ base: props.text, edits: [], undone: [] });
  const changeMarker = (patch: MarkerPatch) => pushEdit({ kind: "setMarker", ...patch });
  const removeMarker = (markerId: string) => {
    pushEdit({ kind: "removeMarker", markerId });
    setSelectedMarker(null);
  };
  /** A marker at `frame`, opened to be named; an existing one there is opened instead. */
  const addMarkerAt = (frame: number) => {
    const existing = markers.find((marker) => marker.frame === frame && marker.clipId === null);
    const edit: TimelineEdit = { kind: "addMarker", frame, author: "user" };
    // The edit names the marker from its place, so applying it here says what it will be called.
    const made =
      existing ??
      timelineMarkers(applyEdits(timeline, [edit])).find(
        (marker) => !markers.some((known) => known.id === marker.id),
      );
    if (existing === undefined) pushEdit(edit);
    setSelectedMarker(made?.id ?? null);
    setMarkerOnRuler(true);
  };
  const commitEdits = async () => {
    if (typeof pulled === "string" || !props.onCommit || edits.length === 0) return;
    setCommitting(true);
    const saved = await props.onCommit(serializeTimeline(applyEdits(pulled, edits)));
    // Dropped for good: stepping back to the text they were made on must not bring them back.
    if (saved) setPending({ base: props.text, edits: [], undone: [] });
    setCommitting(false);
  };

  /** Moves a dragged edge onto the nearest cut, playhead or mark within reach. */
  const snapDelta = (current: Drag, rawDelta: number) => {
    // A slip moves no edge, so there is nothing to snap.
    if (current.tool === "slip") return Math.round(rawDelta);
    const reach = SNAP_PX / pxPerFrame;
    const targets = [
      ...cuts.filter((frame) => frame !== current.startFrame && frame !== current.endFrame),
      Math.round(currentFrame()),
      ...(marks.in === null ? [] : [marks.in]),
      ...(marks.out === null ? [] : [marks.out]),
      ...markers.map((marker) => marker.frame),
    ];
    const edges =
      current.mode === "move"
        ? [current.startFrame, current.endFrame]
        : [current.mode === "start" ? current.startFrame : current.endFrame];
    let best = rawDelta;
    let bestDistance = reach;
    for (const edge of edges) {
      for (const target of targets) {
        const distance = Math.abs(edge + rawDelta - target);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = target - edge;
        }
      }
    }
    return Math.round(best);
  };

  const onClipPointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    track: LaidOutTrack,
    item: LaidOutClip,
  ) => {
    // The hand and zoom tools act on the track under the clip.
    if (!editable || event.button !== 0 || tool === "hand" || tool === "zoom") return;
    const rect = event.currentTarget.getBoundingClientRect();
    const offset = event.clientX - rect.left;
    if (tool === "razor") {
      // The razor snaps to the playhead, so a cut lands on the frame being watched.
      const raw = item.startFrame + offset / pxPerFrame;
      const playhead = currentFrame();
      const at = Math.round(Math.abs(raw - playhead) < SNAP_PX / pxPerFrame ? playhead : raw);
      if (at > item.startFrame && at < item.endFrame) {
        pushEdit({
          kind: "split",
          frame: at,
          ...(event.shiftKey ? {} : { tracks: linkedTracks(timeline, item.key) }),
        });
      }
      return;
    }
    const handles = rect.width > TRIM_HANDLE_PX * 3;
    const mode: DragMode =
      tool === "slip" || tool === "slide"
        ? "move"
        : tool === "rippleEdit" || tool === "rollingEdit"
          ? offset < rect.width / 2
            ? "start"
            : "end"
          : handles && offset < TRIM_HANDLE_PX
            ? "start"
            : handles && offset > rect.width - TRIM_HANDLE_PX
              ? "end"
              : "move";
    // Listen on the window: a clip dragged to another track re-renders in that row, and its old
    // element (and any pointer capture on it) goes away mid-drag.
    const onMove = (moveEvent: PointerEvent) => onClipPointerMove(moveEvent);
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      onClipPointerUp();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    dragRef.current = {
      id: item.key,
      tool,
      mode,
      fromTrack: track.name,
      kind: track.kind,
      startFrame: Math.round(item.startFrame),
      endFrame: Math.round(item.endFrame),
      originX: event.clientX,
      originY: event.clientY,
      deltaFrames: 0,
      toTrack: track.name,
      active: false,
    };
  };
  const onClipPointerMove = (event: PointerEvent) => {
    const current = dragRef.current;
    if (current === null) return;
    const dx = event.clientX - current.originX;
    const dy = event.clientY - current.originY;
    if (!current.active && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    let toTrack = current.toTrack;
    if (current.mode === "move" && current.tool === "selection") {
      const row = document
        .elementsFromPoint(event.clientX, event.clientY)
        .map((element) => element.closest<HTMLElement>("[data-track-name]"))
        .find((element) => element !== null);
      if (row?.dataset.trackKind === current.kind && row.dataset.trackName) {
        toTrack = row.dataset.trackName;
      }
    }
    const next = {
      ...current,
      active: true,
      toTrack,
      deltaFrames: snapDelta(current, dx / pxPerFrame),
    };
    dragRef.current = next;
    setDrag(next);
  };
  const onClipPointerUp = () => {
    const current = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (current?.active) {
      suppressClickRef.current = true;
      const moved = current.deltaFrames !== 0 || current.toTrack !== current.fromTrack;
      if (moved) pushEdit(dragEdit(current, magnetic));
    }
  };

  const notify = (title: string) => toastManager.add({ type: "info", title });
  const zoomBy = (factor: number) => {
    const element = scrollerRef.current;
    const frame = currentFrame();
    const playheadX = element ? LABEL_PX + frame * pxPerFrame - element.scrollLeft : 0;
    const x =
      element && playheadX >= LABEL_PX && playheadX <= element.clientWidth
        ? playheadX
        : (element?.clientWidth ?? 0) / 2;
    zoomAround(zoom * factor, frame, x);
  };
  const playFrom = (start: number | null, stopAt?: number) => {
    if (!engine) return;
    if (start !== null) seek(start);
    engine.setSpeed(1, stopAt === undefined ? undefined : { stopAt });
  };
  const sameKindTracks = (kind: LaidOutTrack["kind"]) =>
    layout.tracks.filter((track) => track.kind === kind);
  const allClips = tracks
    .flatMap((track) => track.clips)
    .toSorted((a, b) => a.startFrame - b.startFrame);

  /** Runs a shortcut's action; false when it doesn't apply, so the key falls through. */
  const runAction = (action: TimelineAction): boolean => {
    const here = Math.round(currentFrame());
    const item = selected?.item ?? null;
    const needsEdit = (): boolean => {
      if (!editable) notify("This timeline is read-only here.");
      return editable;
    };
    const needsClip = (): boolean => {
      if (item === null) notify("Select a clip first.");
      return item !== null && needsEdit();
    };
    switch (action) {
      case "togglePlay":
        shuttle(speedStore.get() === 0 ? 1 : 0);
        return true;
      case "playAround":
        playFrom(
          Math.max(0, here - PLAY_AROUND_SECONDS * rate),
          Math.min(layout.durationFrames, here + PLAY_AROUND_SECONDS * rate),
        );
        return true;
      case "playToOut":
        playFrom(null, marks.out ?? layout.durationFrames);
        return true;
      case "playInToOut":
        playFrom(marks.in ?? 0, marks.out ?? layout.durationFrames);
        return true;
      case "shuttleLeft":
        shuttle(speedStore.get() >= 0 ? -1 : Math.max(-MAX_SHUTTLE, speedStore.get() * 2));
        return true;
      case "shuttleStop":
        shuttle(0);
        return true;
      case "shuttleRight":
        shuttle(speedStore.get() <= 0 ? 1 : Math.min(MAX_SHUTTLE, speedStore.get() * 2));
        return true;
      case "shuttleSlowLeft":
        shuttle(-SLOW_SHUTTLE);
        return true;
      case "shuttleSlowRight":
        shuttle(SLOW_SHUTTLE);
        return true;
      case "stepBack":
        seek(here - 1);
        return true;
      case "stepForward":
        seek(here + 1);
        return true;
      case "stepBackFive":
        seek(here - 5);
        return true;
      case "stepForwardFive":
        seek(here + 5);
        return true;
      case "goToStart":
        seek(0);
        return true;
      case "goToEnd":
        seek(layout.durationFrames);
        return true;
      case "goToClipStart":
        if (item) seek(item.startFrame);
        return item !== null;
      case "goToClipEnd":
        if (item) seek(item.endFrame);
        return item !== null;
      case "previousEdit":
        seek(cuts.findLast((frame) => frame < here) ?? 0);
        return true;
      case "nextEdit":
        seek(cuts.find((frame) => frame > here) ?? layout.durationFrames);
        return true;
      case "previousGap":
      case "nextGap": {
        // Where no track plays anything, as Premiere's sequence gaps.
        const gaps: Array<number> = [];
        let cursor = 0;
        for (const clip of allClips) {
          if (clip.startFrame > cursor) gaps.push(cursor);
          cursor = Math.max(cursor, clip.endFrame);
        }
        const next =
          action === "nextGap"
            ? gaps.find((frame) => frame > here)
            : gaps.findLast((frame) => frame < here);
        if (next !== undefined) seek(next);
        return true;
      }
      case "markIn":
        updateMarks({ ...marks, in: here });
        return true;
      case "markOut":
        updateMarks({ ...marks, out: here });
        return true;
      case "markSelection": {
        const range =
          item ??
          (selectedGap ? { startFrame: selectedGap.start, endFrame: selectedGap.end } : null);
        if (range === null) {
          notify("Select a clip or a gap first.");
          return true;
        }
        updateMarks({ in: range.startFrame, out: range.endFrame });
        return true;
      }
      case "goToIn":
        if (marks.in !== null) seek(marks.in);
        return true;
      case "goToOut":
        if (marks.out !== null) seek(marks.out);
        return true;
      case "clearIn":
        updateMarks({ ...marks, in: null });
        return true;
      case "clearOut":
        updateMarks({ ...marks, out: null });
        return true;
      case "clearInOut":
        updateMarks({ in: null, out: null });
        return true;
      case "zoomIn":
        zoomBy(ZOOM_STEP);
        return true;
      case "zoomOut":
        zoomBy(1 / ZOOM_STEP);
        return true;
      case "zoomToSequence":
        zoomAround(1, 0, LABEL_PX);
        return true;
      case "previousScreen":
      case "nextScreen": {
        const element = scrollerRef.current;
        if (element) {
          const page = element.clientWidth - LABEL_PX;
          element.scrollLeft += action === "nextScreen" ? page : -page;
        }
        return true;
      }
      case "addEdit":
      case "addEditAll": {
        if (!needsEdit()) return true;
        // Premiere cuts the targeted tracks; here that's the selected clip's, with its linked sound.
        const crossing =
          action === "addEdit" && item !== null && item.startFrame < here && here < item.endFrame;
        pushEdit({
          kind: "split",
          frame: here,
          ...(crossing ? { tracks: linkedTracks(timeline, item.key) } : {}),
        });
        return true;
      }
      case "clear":
        if (item === null && selectedGap !== null) return rippleDeleteGap();
        if (item === null && selectedMarker !== null) {
          if (needsEdit()) removeMarker(selectedMarker);
          return true;
        }
        if (item === null) return false;
        if (needsEdit()) {
          pushEdit({ kind: "delete", clipId: item.key });
          setSelectedKey(null);
        }
        return true;
      case "rippleDelete":
        if (item === null && selectedGap !== null) return rippleDeleteGap();
        if (!needsClip() || item === null) return true;
        if (rippleDeleteBlocked(timeline, item.key)) {
          notify("Other tracks have clips beside this one, so a ripple delete would cut them.");
          return true;
        }
        pushEdit({ kind: "rippleDelete", clipId: item.key });
        setSelectedKey(null);
        return true;
      case "lift":
      case "extract":
        if (marks.in === null || marks.out === null || marks.out <= marks.in) {
          notify("Mark an in and an out first.");
          return true;
        }
        if (needsEdit()) {
          pushEdit({
            kind: "removeRange",
            start: marks.in,
            end: marks.out,
            ripple: action === "extract",
          });
          seek(marks.in);
          updateMarks({ in: null, out: null });
        }
        return true;
      case "rippleTrimPrevious": {
        const previous = cuts.findLast((frame) => frame < here);
        if (previous !== undefined && needsEdit()) {
          pushEdit({ kind: "removeRange", start: previous, end: here, ripple: true });
          seek(previous);
        }
        return true;
      }
      case "rippleTrimNext": {
        const next = cuts.find((frame) => frame > here);
        if (next !== undefined && needsEdit()) {
          pushEdit({ kind: "removeRange", start: here, end: next, ripple: true });
        }
        return true;
      }
      case "extendPreviousEdit":
      case "extendNextEdit": {
        if (!needsEdit()) return true;
        // The nearest cut on that side, on the selected clip's track when one is selected.
        const scope = selected === null ? tracks : [selected.track];
        const edges = scope.flatMap((track) =>
          track.clips.flatMap((clip) => [
            { clip, edge: "start" as const, frame: clip.startFrame },
            { clip, edge: "end" as const, frame: clip.endFrame },
          ]),
        );
        const side = edges.filter((edge) =>
          action === "extendPreviousEdit" ? edge.frame < here : edge.frame > here,
        );
        const nearest = side.toSorted((a, b) =>
          action === "extendPreviousEdit" ? b.frame - a.frame : a.frame - b.frame,
        )[0];
        if (nearest) {
          pushEdit({ kind: "roll", clipId: nearest.clip.key, edge: nearest.edge, frame: here });
        }
        return true;
      }
      case "slipLeft":
      case "slipRight":
      case "slipLeftFive":
      case "slipRightFive":
      case "slideLeft":
      case "slideRight":
      case "slideLeftFive":
      case "slideRightFive": {
        if (!needsClip() || item === null) return true;
        const step = action.endsWith("Five") ? 5 : 1;
        if (action.startsWith("slip")) {
          // Slipping left moves the media left under the clip, so it shows later frames.
          const frames = action.startsWith("slipLeft") ? step : -step;
          pushEdit({ kind: "slip", clipId: item.key, frames });
        } else {
          const frames = action.startsWith("slideLeft") ? -step : step;
          pushEdit({ kind: "slide", clipId: item.key, frames });
        }
        return true;
      }
      case "trimInToPlayhead":
      case "trimOutToPlayhead":
        if (needsClip() && item) {
          pushEdit({
            kind: "trim",
            clipId: item.key,
            edge: action === "trimInToPlayhead" ? "start" : "end",
            frame: here,
          });
        }
        return true;
      case "nudgeLeft":
      case "nudgeRight":
      case "nudgeLeftFive":
      case "nudgeRightFive": {
        if (!needsClip() || item === null || selected === null) return true;
        const step = action.endsWith("Five") ? 5 : 1;
        const direction = action.startsWith("nudgeLeft") ? -1 : 1;
        pushEdit({
          kind: "move",
          clipId: item.key,
          toTrack: selected.track.name,
          startFrame: Math.max(0, item.startFrame + direction * step),
        });
        return true;
      }
      case "nudgeUp":
      case "nudgeDown": {
        if (!needsClip() || item === null || selected === null) return true;
        const peers = sameKindTracks(selected.track.kind);
        const index = peers.findIndex((track) => track.name === selected?.track.name);
        const target = peers[index + (action === "nudgeUp" ? -1 : 1)];
        if (target) {
          pushEdit({
            kind: "move",
            clipId: item.key,
            toTrack: target.name,
            startFrame: item.startFrame,
          });
        }
        return true;
      }
      case "selectPreviousClip":
      case "selectNextClip": {
        const from = item?.startFrame ?? here;
        const next =
          action === "selectNextClip"
            ? allClips.find((clip) => clip.startFrame > from)
            : allClips.findLast((clip) => clip.startFrame < from);
        if (next) {
          setSelectedKey(next.key);
          seek(next.startFrame);
        }
        return true;
      }
      case "deselectAll":
        setSelectedKey(null);
        return true;
      case "toggleClipEnabled":
        if (needsClip() && item) {
          pushEdit({ kind: "setEnabled", clipId: item.key, enabled: !item.clip.enabled });
        }
        return true;
      case "undo":
        if (edits.length > 0) undoEdit();
        else if (editable && props.onStepVersion) props.onStepVersion("undo");
        else return false;
        return true;
      case "redo":
        if (undone.length > 0) redoEdit();
        else if (editable && edits.length === 0 && props.onStepVersion) props.onStepVersion("redo");
        else return false;
        return true;
      case "addMarker":
        if (needsEdit()) addMarkerAt(here);
        return true;
      case "nextMarker":
      case "previousMarker": {
        const next =
          action === "nextMarker"
            ? markers.find((marker) => marker.frame > here)
            : markers.findLast((marker) => marker.frame < here);
        if (next) seek(next.frame);
        return true;
      }
      case "maximize":
        return false;
      case "fullScreen":
        engine?.requestFullscreen();
        return true;
      case "listenToCut":
        return listenToCut();
      case "toolSelection":
      case "toolRippleEdit":
      case "toolRollingEdit":
      case "toolRazor":
      case "toolSlip":
      case "toolSlide":
      case "toolHand":
      case "toolZoom":
        setTool(TOOLS.find((candidate) => TOOL_ACTIONS[candidate] === action) ?? "selection");
        return true;
    }
  };
  /** Closes the selected gap, unless another track plays in it. */
  const rippleDeleteGap = (): boolean => {
    if (selectedGap === null || !editable) return selectedGap !== null;
    if (selectedGap.shared) {
      notify("Other tracks have clips in this gap, so closing it would cut them.");
      return true;
    }
    pushEdit({ kind: "removeRange", start: selectedGap.start, end: selectedGap.end, ripple: true });
    setGapPick(null);
    return true;
  };
  /** Zooms around the frame under the pointer, as Premiere's zoom tool. */
  const zoomAtPointer = (clientX: number, out: boolean) => {
    const element = scrollerRef.current;
    if (element === null) return;
    const x = clientX - element.getBoundingClientRect().left;
    const frameAt = (element.scrollLeft + x - LABEL_PX) / pxPerFrame;
    zoomAround(zoom * (out ? 1 / ZOOM_STEP : ZOOM_STEP), Math.max(0, frameAt), x);
  };
  /** The hand tool drags the tracks along. */
  const startHandDrag = (event: React.PointerEvent) => {
    const element = scrollerRef.current;
    if (element === null) return;
    const originX = event.clientX;
    const originLeft = element.scrollLeft;
    const onMove = (moveEvent: PointerEvent) => {
      element.scrollLeft = originLeft - (moveEvent.clientX - originX);
    };
    const onEnd = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (isTyping(event.target)) return;
    if (event.key === "Escape" && dragRef.current) {
      dragRef.current = null;
      setDrag(null);
      return;
    }
    if (event.key === "Escape" && selectedKey !== null) {
      event.preventDefault();
      setSelectedKey(null);
      return;
    }
    const combo = comboFromEvent(event);
    if (combo === null || !playable) return;
    if (actionsFor(shortcuts.keymap, combo).some(runAction)) event.preventDefault();
  };

  const previewOnly = !timelineVisible;
  const zoomLabel = `${zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}×`;
  // Each panel is a focus scope for the editor shortcuts, like an editor's monitor and timeline.
  const focusScope = (label: string, children: ReactNode) => (
    <div
      role="application"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={(event) => {
        if (!isTyping(event.target)) event.currentTarget.focus({ preventScroll: true });
      }}
      className="group/bay edit-bay @container/viewer flex h-full min-h-0 min-w-0 flex-1 flex-col outline-none"
    >
      {children}
    </div>
  );
  const pendingBar =
    edits.length > 0 ? (
      <div className="flex h-10 shrink-0 items-center gap-2 bg-warning/8 pr-2 pl-3 text-xs">
        <Bay.Hint
          side="top"
          className="min-w-0 truncate text-warning"
          hint={`${edits.map(editLabel).join(", ")}. Playing in the preview, not saved yet.`}
        >
          {edits.length} unsaved {edits.length === 1 ? "edit" : "edits"}
        </Bay.Hint>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Undo the last edit"
                  onClick={undoEdit}
                />
              }
            >
              <Undo2Icon />
            </TooltipTrigger>
            <TooltipPopup side="top">
              Undo the last edit <Kbd>⌘Z</Kbd>
            </TooltipPopup>
          </Tooltip>
          <Button size="xs" variant="ghost" onClick={discardEdits}>
            Discard
          </Button>
          <Button size="xs" disabled={committing} onClick={() => void commitEdits()}>
            {committing ? "Committing…" : "Commit"}
          </Button>
        </span>
      </div>
    ) : null;
  const monitor = focusScope(
    "Program monitor",
    props.media && frame ? (
      <>
        {props.workspace ? (
          <PanelTools panel="monitor">
            <div className="flex items-center gap-2">
              <Bay.Hint
                hint={`${frame.width} × ${frame.height}`}
                className="bay-label text-muted-foreground"
              >
                {aspectLabel(frame)}
              </Bay.Hint>
              {props.monitorTools}
            </div>
          </PanelTools>
        ) : null}
        {/* The tracks show pending edits; without them on screen, the monitor does. */}
        {previewOnly ? pendingBar : null}
        <div className="@container/monitor flex min-h-0 w-full flex-1 flex-col items-center">
          <div
            className="relative isolate flex min-h-0 w-full flex-1 items-center justify-center p-2 [container-type:size]"
            onContextMenu={showPreviewMenu}
          >
            <Backdrop variant="ambient" stage="continue" className="bg-transparent" />
            <TimelinePreview
              layout={layout}
              frame={frame}
              media={props.media}
              onEngine={setEngine}
              onTime={(frameNumber) => {
                playheadRef.current = frameNumber;
                showPlayhead(frameNumber);
                if (speedStore.get() !== 0) followPlayhead(frameNumber);
              }}
              onSpeed={speedStore.set}
            />
          </div>
          {previewOnly ? (
            <div className="w-full px-3 pt-1">
              <PreviewScrubber
                barRef={scrubRef}
                headRef={scrubHeadRef}
                duration={layout.durationFrames}
                marks={marks}
                disabled={!playable}
                playhead={currentFrame}
                onSeek={seek}
                onMarks={updateMarks}
                onContextMenu={showPreviewMenu}
              />
            </div>
          ) : null}
          <div className="grid w-full grid-cols-[1fr_auto_1fr] items-center gap-x-2 gap-y-1 px-3 py-2 text-xs [grid-template-areas:'time_transport_tools'] @max-[40rem]/monitor:grid-cols-[auto_1fr] @max-[40rem]/monitor:[grid-template-areas:'time_tools'_'transport_transport'] @max-[20rem]/monitor:grid-cols-1 @max-[20rem]/monitor:[grid-template-areas:'time'_'transport'_'tools']">
            <div className="flex min-w-0 items-center gap-1.5 [grid-area:time] @max-[20rem]/monitor:justify-center">
              <PlayheadTimecode store={playheadStore} rate={rate} duration={duration} />
              <SpeedBadge store={speedStore} />
              <BackdropHoldWhilePlaying store={speedStore} />
              {playable ? (
                <SpaceToPlay onToggle={() => shuttle(speedStore.get() === 0 ? 1 : 0)} />
              ) : null}
              {marks.in !== null || marks.out !== null ? (
                <InOutReadout
                  marks={marks}
                  rate={rate}
                  end={layout.durationFrames}
                  onClear={() => updateMarks({ in: null, out: null })}
                />
              ) : null}
            </div>
            <div className="flex items-center justify-center gap-0.5 [grid-area:transport]">
              <Bay.Reveal>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Go to start"
                  disabled={!playable}
                  onClick={() => seek(0)}
                >
                  <SkipBackIcon />
                </Button>
              </Bay.Reveal>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Previous frame"
                disabled={!playable}
                onClick={() => seek(Math.round(currentFrame()) - 1)}
              >
                <ChevronLeftIcon />
              </Button>
              <PlayPauseButton
                store={speedStore}
                disabled={!playable}
                onToggle={() => shuttle(speedStore.get() === 0 ? 1 : 0)}
              />
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Next frame"
                disabled={!playable}
                onClick={() => seek(Math.round(currentFrame()) + 1)}
              >
                <ChevronRightIcon />
              </Button>
              <Bay.Reveal>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Go to end"
                  disabled={!playable}
                  onClick={() => seek(layout.durationFrames)}
                >
                  <SkipForwardIcon />
                </Button>
              </Bay.Reveal>
              {props.transportTools ? (
                <span className="ml-2 flex">{props.transportTools}</span>
              ) : null}
            </div>
            <div className="flex min-w-0 items-center justify-end gap-1 [grid-area:tools] @max-[20rem]/monitor:justify-center">
              {props.onReference ? (
                <Bay.Reveal>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={
                            hasRange ? "Add marked section to chat" : "Add this moment to chat"
                          }
                          disabled={!playable}
                          onClick={() => referenceMoment(hasRange)}
                        />
                      }
                    >
                      <MessageSquarePlusIcon />
                    </TooltipTrigger>
                    <TooltipPopup side="top">
                      {hasRange ? "Add marked section to chat" : "Add this moment to chat"}
                    </TooltipPopup>
                  </Tooltip>
                </Bay.Reveal>
              ) : null}
              {props.premiere}
              <MonitorAudio engine={engine} />
              <Bay.Reveal>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Toggle
                        size="sm"
                        aria-label="Loop playback"
                        pressed={loop}
                        onPressedChange={toggleLoop}
                      />
                    }
                  >
                    <RepeatIcon />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Loop playback</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Full screen"
                        disabled={!playable}
                        onClick={() => engine?.requestFullscreen()}
                      />
                    }
                  >
                    <MaximizeIcon />
                  </TooltipTrigger>
                  <TooltipPopup side="top">Full screen</TooltipPopup>
                </Tooltip>
              </Bay.Reveal>
            </div>
          </div>
        </div>
      </>
    ) : (
      <p className="m-auto p-6 text-center text-xs text-muted-foreground">
        This timeline has no picture size, so it can't play here.
      </p>
    ),
  );
  const tracksPanel = focusScope(
    `${timeline.name} timeline`,
    <>
      <PanelTools panel="timeline">
        <div role="toolbar" aria-label="Timeline tools" className="flex items-center gap-0.5">
          {props.timelineTools}
          {props.media && frame ? null : props.transportTools}
          <ToolPicker tool={tool} editable={editable} keymap={shortcuts.keymap} onPick={setTool} />
          {editable ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    size="sm"
                    aria-label="Magnetic timeline"
                    pressed={magnetic}
                    onPressedChange={setMagnetic}
                  />
                }
              >
                <MagnetIcon />
              </TooltipTrigger>
              <TooltipPopup side="bottom">
                Magnetic: dragged clips close their gap and push others along
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Zoom out"
                  disabled={zoom <= 1}
                  onClick={() => zoomBy(1 / ZOOM_STEP)}
                />
              }
            >
              <MinusIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Zoom out · {zoomLabel}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Zoom in"
                  disabled={zoom >= maxZoom}
                  onClick={() => zoomBy(ZOOM_STEP)}
                />
              }
            >
              <PlusIcon />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Zoom in · {zoomLabel}</TooltipPopup>
          </Tooltip>
          {editable || playable || props.scriptLines ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button size="icon-sm" variant="ghost" aria-label="More timeline options" />
                }
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="end" side="bottom">
                {editable ? (
                  <MenuItem onClick={() => addMarkerAt(Math.round(currentFrame()))}>
                    <BookmarkPlusIcon />
                    Add marker at playhead
                    <MenuShortcut>M</MenuShortcut>
                  </MenuItem>
                ) : null}
                {props.scriptLines ? (
                  <MenuCheckboxItem
                    checked={props.scriptLines.shown}
                    onCheckedChange={props.scriptLines.onShownChange}
                  >
                    Script lines on the ruler
                  </MenuCheckboxItem>
                ) : null}
                {playable ? (
                  <>
                    <MenuSeparator />
                    <MenuItem onClick={() => setShortcutsOpen(true)}>Keyboard shortcuts…</MenuItem>
                  </>
                ) : null}
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      </PanelTools>
      {playable ? (
        <ShortcutsDialog
          open={shortcutsOpen}
          onOpenChange={setShortcutsOpen}
          keymap={shortcuts.keymap}
          layoutName={shortcuts.name}
          imported={shortcuts.imported}
          editable={editable}
          onImport={async (file) => {
            const count = await shortcuts.importKys(file);
            toastManager.add(
              count > 0
                ? {
                    type: "success",
                    title: `Imported “${file.name.replace(/\.kys$/i, "")}”`,
                    description: `${count} timeline shortcuts now follow your Premiere keys.`,
                  }
                : {
                    type: "error",
                    title: "That isn't a Premiere shortcut file",
                    description: "Choose a .kys file from Premiere's profile folder.",
                  },
            );
          }}
          onReset={shortcuts.reset}
        />
      ) : null}

      <TrackScroller
        scrollerRef={scrollerRef}
        onMeasure={onScrollerMeasure}
        onWheel={onWheel}
        // Clips are culled to the view plus an overscan, so the view only re-renders when the
        // scroll crosses half an overscan, not on every scroll event.
        onScroll={(left) => {
          scrollOffsetRef.current = left;
          setScrollLeft(Math.floor(left / (OVERSCAN_PX / 2)) * (OVERSCAN_PX / 2));
        }}
      >
        <div className="relative min-w-full" style={{ width: `${zoom * 100}%` }}>
          <div className="sticky top-0 z-50 flex h-8 border-b border-border/60 bg-background">
            <div
              className="sticky left-0 z-10 shrink-0 bg-background"
              style={{ width: LABEL_PX }}
            />
            <TimelineRuler
              rulerRef={rulerRef}
              duration={duration}
              marks={marks}
              disabled={!playable}
              playhead={currentFrame}
              onSeek={seek}
              onMarks={updateMarks}
              onContextMenu={showPreviewMenu}
            >
              {marks.in !== null || marks.out !== null ? (
                <span
                  aria-hidden
                  className="absolute inset-y-0 bg-primary/12"
                  style={{
                    left: percent(marks.in ?? 0),
                    width: percent((marks.out ?? duration) - (marks.in ?? 0)),
                  }}
                />
              ) : null}
              {marks.in !== null ? (
                <span
                  aria-hidden
                  className="absolute inset-y-0.5 w-1.5 rounded-l-xs border-y-2 border-l-2 border-primary"
                  style={{ left: percent(marks.in) }}
                />
              ) : null}
              {marks.out !== null ? (
                <span
                  aria-hidden
                  className="absolute inset-y-0.5 w-1.5 -translate-x-full rounded-r-xs border-y-2 border-r-2 border-primary"
                  style={{ left: percent(marks.out) }}
                />
              ) : null}
              {minorTickPx >= MIN_MINOR_TICK_PX ? (
                <span
                  aria-hidden
                  className="absolute inset-x-0 bottom-0 h-1.5 ruler-ticks"
                  style={{ backgroundSize: `${minorTickPx}px 100%` }}
                />
              ) : null}
              {ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute inset-y-0 border-l border-foreground/20 pt-1 pl-1 font-mono text-2xs leading-none tracking-wider text-muted-foreground tabular-nums"
                  style={{ left: percent(tick) }}
                >
                  {rulerLabel(tick, rate)}
                </span>
              ))}
              <RulerMarkers
                markers={markers}
                scriptTicks={props.scriptLines?.shown ? props.scriptLines.ticks : []}
                duration={duration}
                pxPerFrame={pxPerFrame}
                timecode={(frameNumber) => timecode(frameNumber, rate)}
                selectedId={selectedMarker}
                editing={markerOnRuler}
                onSelect={(id) => {
                  setSelectedMarker(id);
                  setMarkerOnRuler(id !== null);
                }}
                onSeek={seek}
                onScriptTick={(tick) => seek(tick.frame)}
                {...(editable ? { onChange: changeMarker, onRemove: removeMarker } : {})}
              />
              {/* The playhead's head, in the ruler that sits above the tracks' line. */}
              <span
                aria-hidden
                ref={headRef}
                className="pointer-events-none absolute inset-y-0 left-0 w-0"
              >
                <span className="absolute top-1 -left-[5px] h-3 w-[11px] bg-foreground [clip-path:polygon(0_0,100%_0,100%_60%,50%_100%,0_60%)]" />
                <span className="absolute top-3.5 bottom-0 left-0 w-px bg-foreground" />
              </span>
            </TimelineRuler>
          </div>
          {tracks.map((track, row) => (
            <div
              key={track.name}
              className={cn(
                // Picture lanes sit a step above the sound lanes; a heavier rule parts the two.
                "flex h-11 border-b border-border/40",
                track.kind === "Video" && "bg-foreground/3",
                track.kind === "Audio" &&
                  tracks[row - 1]?.kind === "Video" &&
                  "border-t-2 border-t-input",
              )}
            >
              <div
                className="sticky left-0 z-40 flex shrink-0 items-center bg-background pr-1.5 pl-2.75"
                style={{ width: LABEL_PX }}
              >
                <span className="truncate bay-label font-medium text-muted-foreground">
                  {track.name}
                </span>
              </div>
              <div
                className={cn("relative flex-1", TOOL_CURSOR[tool])}
                data-track-name={track.name}
                data-track-kind={track.kind}
                onPointerDown={(event) => {
                  if (tool === "hand" && event.button === 0) startHandDrag(event);
                }}
                onClick={(event) => {
                  if (tool === "zoom") {
                    zoomAtPointer(event.clientX, event.altKey);
                    return;
                  }
                  // A click on the track's empty space, not a clip, deselects and picks the gap.
                  if (event.target !== event.currentTarget) return;
                  setSelectedKey(null);
                  const left = event.currentTarget.getBoundingClientRect().left;
                  setGapPick(
                    tool === "selection" || tool === "rippleEdit"
                      ? {
                          track: track.name,
                          frame: Math.floor((event.clientX - left) / pxPerFrame),
                        }
                      : null,
                  );
                }}
              >
                {selectedGap?.track === track.name ? (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute inset-y-1 rounded-xs border border-primary/60 bg-primary/12"
                    style={{
                      left: percent(selectedGap.start),
                      width: percent(selectedGap.end - selectedGap.start),
                    }}
                  />
                ) : null}
                {pulledLayout?.tracks
                  .find((t) => t.name === track.name)
                  ?.clips.filter((item) => touched.has(item.key) && inView(item))
                  .map((item) => (
                    <span
                      key={`ghost:${item.key}`}
                      aria-hidden
                      className="pointer-events-none absolute inset-y-1 rounded-xs border border-dashed border-foreground/35 dither-field"
                      style={{
                        left: percent(item.startFrame),
                        width: percent(item.endFrame - item.startFrame),
                      }}
                    />
                  ))}
                {track.clips.filter(inView).map((item) => {
                  const kind = clipKind(track, item);
                  const animated = effectsOf(item).some((e) => e.animated);
                  const source = props.media?.sources.get(targetOf(item));
                  const widthPx = (item.endFrame - item.startFrame) * pxPerFrame;
                  const isSelected = item.key === selectedKey;
                  const isAudio = kind === "audio" || kind === "footageAudio";
                  return (
                    <button
                      key={item.key}
                      type="button"
                      aria-label={compactLine(track.name, item.clip)}
                      onPointerDown={(event) => onClipPointerDown(event, track, item)}
                      onContextMenu={(event) => {
                        const reference = props.onReference;
                        if (!reference) return;
                        event.preventDefault();
                        setSelectedKey(item.key);
                        const api = readLocalApi();
                        if (!api) return;
                        const description = `${track.name} ${clipTitle(kind, item)} ${timecode(item.startFrame, rate)}–${timecode(item.endFrame, rate)} (clip ${item.key})`;
                        void api.contextMenu
                          .show([{ id: "add-to-chat", label: "Add to chat" }], {
                            x: event.clientX,
                            y: event.clientY,
                          })
                          .then((clicked) => {
                            if (clicked === "add-to-chat") reference(description);
                          });
                      }}
                      onDoubleClick={() => {
                        if (kind !== "text" || !editable) return;
                        setSelectedKey(item.key);
                        // The field mounts with the selection; focus it on the next frame.
                        requestAnimationFrame(() =>
                          document.getElementById(TEXT_FIELD_ID)?.focus(),
                        );
                      }}
                      onClick={() => {
                        if (tool === "razor" || tool === "hand" || tool === "zoom") return;
                        setGapPick(null);
                        if (suppressClickRef.current) {
                          suppressClickRef.current = false;
                          return;
                        }
                        setSelectedKey(item.key === selectedKey ? null : item.key);
                        seek(item.startFrame);
                      }}
                      className={cn(
                        // The lane-coloured border keeps a gap at every cut; the tinted top edge
                        // names the kind even where a clip is too short for its name.
                        "group/clip absolute inset-y-1 flex flex-col overflow-hidden rounded-xs border border-lanes px-1.5 pt-1 text-left text-2xs leading-none whitespace-nowrap outline-none",
                        "before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-0.5 before:bg-current before:opacity-90",
                        "after:pointer-events-none after:absolute after:inset-0 after:bg-white/0 hover:after:bg-white/8 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                        FILL_CLASS[kind],
                        TINT_CLASS[kind],
                        isSelected &&
                          "z-10 ring-2 ring-primary ring-offset-1 ring-offset-lanes before:h-[3px] before:bg-primary before:opacity-100 after:bg-white/12",
                        editable && "touch-none",
                        tool === "selection"
                          ? editable && "cursor-grab active:cursor-grabbing"
                          : TOOL_CURSOR[tool],
                        touched.has(item.key) &&
                          "z-10 outline-2 -outline-offset-2 outline-warning outline-dashed",
                        drag?.active && drag.id === item.key && "opacity-90",
                        !item.clip.enabled && "opacity-40 saturate-0",
                      )}
                      style={{
                        left: percent(item.startFrame),
                        width: percent(item.endFrame - item.startFrame),
                      }}
                    >
                      {editable && tool === "selection" && widthPx > TRIM_HANDLE_PX * 3
                        ? (["left", "right"] as const).map((side) => (
                            <span
                              key={side}
                              aria-hidden
                              className={cn(
                                "absolute inset-y-0 z-10 flex w-1.5 cursor-ew-resize items-center justify-center bg-white/0 group-hover/clip:bg-white/25",
                                side === "left" ? "left-0" : "right-0",
                                isSelected && "bg-white/25",
                              )}
                            >
                              <span
                                className={cn(
                                  "h-3 w-px rounded-full bg-transparent group-hover/clip:bg-white",
                                  isSelected && "bg-white",
                                )}
                              />
                            </span>
                          ))
                        : null}
                      {isAudio ? (
                        source?.peaks ? (
                          <Waveform item={item} url={source.peaks} />
                        ) : (
                          <span
                            aria-hidden
                            className="absolute inset-x-1.5 top-[calc(50%+5px)] h-px bg-current opacity-50"
                          />
                        )
                      ) : null}
                      {widthPx > 28 ? (
                        <span className="relative flex min-w-0 items-center gap-1 text-white">
                          {animated ? <SparklesIcon className="size-3 shrink-0" /> : null}
                          <span className="truncate font-medium text-white/95">
                            {clipTitle(kind, item)}
                          </span>
                          {widthPx > 96 ? (
                            <span
                              className={cn(
                                "ml-auto shrink-0 pl-1 font-mono text-3xs text-white/70 tabular-nums",
                                !isSelected && "hidden group-hover/clip:inline",
                              )}
                            >
                              {seconds(item.endFrame - item.startFrame, rate)}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div
            aria-hidden
            ref={lineRef}
            className="pointer-events-none absolute top-0 bottom-0 left-0 z-30 w-px bg-foreground"
          />
        </div>
      </TrackScroller>
      {pendingBar}
      {selected ? (
        <div className="flex max-h-56 shrink-0 flex-col justify-center overflow-auto bg-background px-3 py-2.5 text-xs">
          <ClipDetails
            track={selected.track}
            item={selected.item}
            rate={rate}
            onClose={() => setSelectedKey(null)}
            {...(editable
              ? {
                  onSetText: (text: string) =>
                    pushEdit({ kind: "setText", clipId: selected.item.key, text }),
                }
              : {})}
          />
        </div>
      ) : null}
    </>,
  );
  const provideCommands = (
    <ProvideTimelineCommand command="runAction" handler={playable ? runAction : null} />
  );
  if (props.workspace === undefined) {
    return (
      <>
        {provideCommands}
        {tracksPanel}
      </>
    );
  }
  return (
    <TimelinePlayerContext
      value={{
        playhead: playheadStore,
        seek,
        rate,
        play: (from, to) => playFrom(Math.max(0, from), Math.min(layout.durationFrames, to)),
      }}
    >
      {provideCommands}
      <TimelineWorkspace
        projectKey={props.workspace.projectKey}
        portrait={frame !== null && frame.height > frame.width}
        panels={{
          monitor,
          timeline: tracksPanel,
          edits: props.workspace.edits,
          history: props.workspace.history,
          markers: (
            <MarkersPanel
              markers={markers}
              timecode={(frameNumber) => timecode(frameNumber, rate)}
              selectedId={selectedMarker}
              onSelect={(id) => {
                setSelectedMarker(id);
                setMarkerOnRuler(false);
              }}
              onSeek={seek}
              {...(editable
                ? {
                    onChange: changeMarker,
                    onRemove: removeMarker,
                    onAdd: () => addMarkerAt(Math.round(currentFrame())),
                  }
                : {})}
            />
          ),
        }}
      />
    </TimelinePlayerContext>
  );
}

/**
 * The current tool, quietly: one icon that opens the list of tools with their keys. A tool the
 * layout gives no key (the razor, in a layout that put C on zoom) is still a click away here.
 */
function ToolPicker(props: {
  readonly tool: TimelineTool;
  readonly editable: boolean;
  readonly keymap: Readonly<Record<string, TimelineAction>>;
  readonly onPick: (tool: TimelineTool) => void;
}) {
  const Icon = TOOL_ICON[props.tool];
  const label = ACTION_LABELS[TOOL_ACTIONS[props.tool]];
  // Without edits, only the tools that look around apply.
  const tools = props.editable
    ? TOOLS
    : TOOLS.filter((t) => ["selection", "hand", "zoom"].includes(t));
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={<Button size="icon-sm" variant="ghost" aria-label={`Tool: ${label}`} />}
            />
          }
        >
          <Icon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {label} · {TOOL_HINTS[props.tool]}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" side="bottom">
        <MenuRadioGroup
          value={props.tool}
          onValueChange={(value) => props.onPick(value as TimelineTool)}
        >
          {tools.map((tool) => {
            const ToolIcon = TOOL_ICON[tool];
            const [combo] = combosFor(props.keymap, TOOL_ACTIONS[tool]);
            return (
              <MenuRadioItem key={tool} value={tool}>
                <ToolIcon />
                {ACTION_LABELS[TOOL_ACTIONS[tool]]}
                {combo === undefined ? null : <MenuShortcut>{comboLabel(combo)}</MenuShortcut>}
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/**
 * The tracks' scroll area. It measures itself and takes the zoom wheel from inside the panel,
 * so both follow the element as the panel is moved, stacked behind a tab or closed and reopened.
 */
function TrackScroller(props: {
  readonly scrollerRef: React.RefObject<HTMLDivElement | null>;
  readonly onMeasure: (width: number, scrollLeft: number) => void;
  readonly onWheel: (event: WheelEvent) => void;
  readonly onScroll: (scrollLeft: number) => void;
  readonly children: ReactNode;
}) {
  const { scrollerRef } = props;
  const measure = useEffectEvent(props.onMeasure);
  const wheel = useEffectEvent(props.onWheel);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Measures the scroller, which only a resize observer reports, and attaches a non-passive wheel listener so pinch zooms the timeline instead of the page.
  useEffect(() => {
    const element = scrollerRef.current;
    if (element === null) return;
    // Hidden behind a tab the panel leaves the document and measures 0, which stops the
    // playhead following; shown again, its scroll offset may have reset.
    const stopObserving = observeResize(element, () =>
      measure(element.clientWidth, element.scrollLeft),
    );
    const listener = (event: WheelEvent) => wheel(event);
    element.addEventListener("wheel", listener, { passive: false });
    return () => {
      stopObserving();
      element.removeEventListener("wheel", listener);
      measure(0, 0);
    };
  }, [scrollerRef]);
  return (
    <div
      ref={scrollerRef}
      onScroll={(event) => props.onScroll(event.currentTarget.scrollLeft)}
      className="min-h-0 flex-1 overflow-auto bg-lanes"
    >
      {props.children}
    </div>
  );
}

/** Every timeline shortcut, what the clip colours mean, and importing a Premiere layout. */
function ShortcutsDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly keymap: Readonly<Record<string, TimelineAction>>;
  readonly layoutName: string;
  readonly imported: boolean;
  readonly editable: boolean;
  readonly onImport: (file: File) => void;
  readonly onReset: () => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Shortcuts{" "}
            <span className="font-normal text-muted-foreground">· {props.layoutName}</span>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3 text-xs">
            {props.editable ? (
              <p className="text-muted-foreground">
                Drag a clip to move it; drag its edges to trim.
              </p>
            ) : null}
            <dl className="grid max-h-80 grid-cols-[1fr_auto] gap-x-3 gap-y-1 overflow-auto">
              {(Object.keys(ACTION_LABELS) as Array<TimelineAction>).map((action) => (
                <div key={action} className="contents">
                  <dt className="text-muted-foreground">{ACTION_LABELS[action]}</dt>
                  <dd className="flex justify-end gap-1">
                    {combosFor(props.keymap, action).map((combo) => (
                      <Kbd key={combo}>{comboLabel(combo)}</Kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
            <ul aria-label="Clip colours" className="flex flex-wrap items-center gap-3">
              {LEGEND.map(([kind, label]) => (
                <li key={kind} className="flex items-center gap-1.5 text-muted-foreground">
                  <span
                    aria-hidden
                    className={cn(
                      "size-2.5 rounded-xs border-t-2 border-current",
                      FILL_CLASS[kind],
                      TINT_CLASS[kind],
                    )}
                  />
                  {label}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-1">
              <Button size="xs" variant="outline" onClick={() => fileRef.current?.click()}>
                Import Premiere layout
              </Button>
              {props.imported ? (
                <Button size="xs" variant="ghost" onClick={props.onReset}>
                  Use Premiere defaults
                </Button>
              ) : null}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".kys"
              className="hidden"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (file) props.onImport(file);
              }}
            />
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

// How close, in px, a press must land to grab the playhead or an in/out edge.
const GRAB_PX = 8;

type Marks = { readonly in: number | null; readonly out: number | null };

type RangeDrag =
  | { readonly mode: "scrub" }
  | { readonly mode: "edge"; readonly edge: "in" | "out" }
  | { readonly mode: "select"; readonly anchor: number; readonly x: number; moved: boolean };

/**
 * Pointer handling shared by the scrub bar and the timeline ruler: grabbing the playhead scrubs,
 * dragging across marks an in/out section, dragging a section's edge adjusts it, a click seeks
 * and a double-click on the section clears it.
 */
function useRangeDrag(options: {
  readonly duration: number;
  readonly marks: Marks;
  readonly disabled: boolean;
  readonly playhead: () => number;
  readonly onSeek: (frame: number) => void;
  readonly onMarks: (marks: { in: number | null; out: number | null }) => void;
}) {
  const { duration, marks, disabled, playhead, onSeek, onMarks } = options;
  const dragRef = useRef<RangeDrag | null>(null);
  const frameAt = (element: HTMLElement, clientX: number) => {
    const rect = element.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / Math.max(1, rect.width)));
    return Math.round(ratio * duration);
  };
  const hasRange = marks.in !== null || marks.out !== null;
  const start = marks.in ?? 0;
  const stop = marks.out ?? duration;
  return {
    onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
      if (disabled || event.button !== 0) return;
      const element = event.currentTarget;
      element.setPointerCapture(event.pointerId);
      const pxPerFrame = element.getBoundingClientRect().width / Math.max(1, duration);
      const frame = frameAt(element, event.clientX);
      const near = (target: number) => Math.abs(target - frame) * pxPerFrame <= GRAB_PX;
      if (near(playhead())) {
        dragRef.current = { mode: "scrub" };
        onSeek(frame);
      } else if (marks.out !== null && near(marks.out)) {
        dragRef.current = { mode: "edge", edge: "out" };
      } else if (marks.in !== null && near(marks.in)) {
        dragRef.current = { mode: "edge", edge: "in" };
      } else {
        dragRef.current = { mode: "select", anchor: frame, x: event.clientX, moved: false };
      }
    },
    onPointerMove: (event: React.PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (drag === null) return;
      const frame = frameAt(event.currentTarget, event.clientX);
      if (drag.mode === "scrub") {
        onSeek(frame);
      } else if (drag.mode === "edge") {
        onMarks(
          drag.edge === "in"
            ? { in: Math.min(frame, stop - 1), out: marks.out }
            : { in: marks.in, out: Math.max(frame, start + 1) },
        );
      } else {
        if (!drag.moved && Math.abs(event.clientX - drag.x) < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        if (frame === drag.anchor) return;
        onMarks({ in: Math.min(drag.anchor, frame), out: Math.max(drag.anchor, frame) });
      }
    },
    onPointerUp: (event: React.PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      if (drag?.mode === "select" && !drag.moved) {
        onSeek(frameAt(event.currentTarget, event.clientX));
      }
    },
    onPointerCancel: () => {
      dragRef.current = null;
    },
    onDoubleClick: (event: React.MouseEvent<HTMLElement>) => {
      const frame = frameAt(event.currentTarget, event.clientX);
      if (hasRange && start <= frame && frame <= stop) onMarks({ in: null, out: null });
    },
  };
}

/** The ruler above the tracks: the same drags as the scrub bar, around its tick labels. */
function TimelineRuler(props: {
  readonly rulerRef: React.Ref<HTMLDivElement>;
  readonly duration: number;
  readonly marks: Marks;
  readonly disabled: boolean;
  readonly playhead: () => number;
  readonly onSeek: (frame: number) => void;
  readonly onMarks: (marks: { in: number | null; out: number | null }) => void;
  readonly onContextMenu: (event: React.MouseEvent) => void;
  readonly children: React.ReactNode;
}) {
  const { rulerRef, duration, children } = props;
  const drag = useRangeDrag(props);
  return (
    <div
      ref={rulerRef}
      role="slider"
      tabIndex={-1}
      aria-label="Timeline ruler"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={0}
      className="relative flex-1 cursor-pointer touch-none select-none"
      {...drag}
      onContextMenu={props.onContextMenu}
    >
      {children}
    </div>
  );
}

function PreviewScrubber(props: {
  readonly barRef: React.Ref<HTMLDivElement>;
  readonly headRef: React.Ref<HTMLSpanElement>;
  readonly duration: number;
  readonly marks: Marks;
  readonly disabled: boolean;
  readonly playhead: () => number;
  readonly onSeek: (frame: number) => void;
  readonly onMarks: (marks: { in: number | null; out: number | null }) => void;
  readonly onContextMenu: (event: React.MouseEvent) => void;
}) {
  const { barRef, headRef, marks, duration, disabled } = props;
  const drag = useRangeDrag(props);
  const pct = (frames: number) => `${(frames / duration) * 100}%`;
  const hasRange = marks.in !== null || marks.out !== null;
  const start = marks.in ?? 0;
  const stop = marks.out ?? duration;
  return (
    <div
      ref={barRef}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label="Playhead"
      aria-valuemin={0}
      aria-valuemax={duration}
      aria-valuenow={0}
      aria-disabled={disabled}
      className="group/scrub relative h-6 w-full cursor-pointer touch-none outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      {...drag}
      onContextMenu={props.onContextMenu}
    >
      <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 bg-foreground/20 transition-[height] group-hover/scrub:h-1.5" />
      {hasRange ? (
        <>
          <span
            aria-hidden
            className="absolute top-1/2 h-1 -translate-y-1/2 bg-primary/70 transition-[height] group-hover/scrub:h-1.5"
            style={{ left: pct(start), width: pct(stop - start) }}
          />
          {/* Premiere's in and out brackets. */}
          <span
            aria-hidden
            className="absolute top-1/2 h-3.5 w-1.5 -translate-y-1/2 cursor-ew-resize rounded-l-xs border-y-2 border-l-2 border-primary"
            style={{ left: pct(start) }}
          />
          <span
            aria-hidden
            className="absolute top-1/2 h-3.5 w-1.5 -translate-x-full -translate-y-1/2 cursor-ew-resize rounded-r-xs border-y-2 border-r-2 border-primary"
            style={{ left: pct(stop) }}
          />
        </>
      ) : null}
      <span aria-hidden ref={headRef} className="pointer-events-none absolute inset-0">
        <span className="absolute top-1/2 -left-px h-4 w-0.5 -translate-y-1/2 bg-foreground transition-[height] group-hover/scrub:h-5" />
      </span>
    </div>
  );
}

/** The marked in/out section as a chip: its length, and a clear button. */
function InOutReadout(props: {
  readonly marks: { readonly in: number | null; readonly out: number | null };
  readonly rate: number;
  readonly end: number;
  readonly onClear: () => void;
}) {
  const start = props.marks.in ?? 0;
  const stop = props.marks.out ?? props.end;
  return (
    <span className="ml-1 flex items-center gap-1.5 rounded-xs border border-primary/50 pl-1.5 font-mono text-primary tabular-nums">
      <span aria-label="In to out duration">{timecode(Math.max(0, stop - start), props.rate)}</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Clear in and out"
              onClick={props.onClear}
            />
          }
        >
          <XIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">Clear in and out (⌥X, or double-click the section)</TooltipPopup>
      </Tooltip>
    </span>
  );
}

const peaksCache = new Map<string, Promise<ProxyPeaks | null>>();
const loadPeaks = (url: string) => {
  let pending = peaksCache.get(url);
  if (pending === undefined) {
    pending = fetch(url)
      .then((response) => (response.ok ? (response.json() as Promise<ProxyPeaks>) : null))
      .catch(() => null);
    peaksCache.set(url, pending);
  }
  return pending;
};
const MAX_WAVEFORM_POINTS = 240;

/** Peaks in the clip's tint, below its name. */
function Waveform(props: { readonly item: LaidOutClip; readonly url: string }) {
  const [peaks, setPeaks] = useState<ProxyPeaks | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Fetches the clip's waveform file from the server.
  useEffect(() => {
    let live = true;
    void loadPeaks(props.url).then((loaded) => {
      if (live) setPeaks(loaded);
    });
    return () => {
      live = false;
    };
  }, [props.url]);
  if (peaks === null) return null;
  const { start_time, duration } = props.item.clip.source_range;
  const first = Math.floor((start_time.value / start_time.rate) * peaks.perSecond);
  const last = Math.ceil(((start_time.value + duration.value) / start_time.rate) * peaks.perSecond);
  const slice = peaks.peaks.slice(first, Math.max(first + 1, last));
  const step = Math.max(1, Math.ceil(slice.length / MAX_WAVEFORM_POINTS));
  const points: Array<number> = [];
  for (let i = 0; i < slice.length; i += step) {
    points.push(Math.max(...slice.slice(i, i + step)));
  }
  const top = points.map((p, i) => `${i},${50 - p / 2}`).join(" L");
  const bottom = points
    .map((p, i) => `${i},${50 + p / 2}`)
    .toReversed()
    .join(" L");
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-4 h-[calc(100%-1.125rem)] w-full"
      viewBox={`0 0 ${Math.max(1, points.length - 1)} 100`}
      preserveAspectRatio="none"
    >
      <path d={`M${top} L${bottom} Z`} fill="currentColor" opacity={0.7} />
    </svg>
  );
}

const TEXT_FIELD_ID = "timeline-clip-text";

/** What an effect is called on a chip: its preset's name when it has one. */
const effectChipLabel = (effect: EffectRef) =>
  effect.label !== effect.kind && effect.kind !== "Text" ? effect.label : effect.kind;

/** A selected clip at a glance: name, place and length, its effects, and its words if it's text. */
function ClipDetails(props: {
  readonly track: LaidOutTrack;
  readonly item: LaidOutClip;
  readonly rate: number;
  readonly onClose: () => void;
  /** Present when the timeline is editable; called with a text graphic's new words. */
  readonly onSetText?: (text: string) => void;
}) {
  const { track, item, rate } = props;
  const kind = clipKind(track, item);
  const KindIcon = KIND_ICON[kind];
  const effects = effectsOf(item).filter((effect) => effect.kind !== "Text");
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className={cn(
            "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-xs border-t-2 border-current",
            FILL_CLASS[kind],
            TINT_CLASS[kind],
          )}
        >
          <KindIcon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{clipTitle(kind, item)}</p>
          <p className="bay-label text-muted-foreground">
            {track.name} · {timecode(item.startFrame, rate)} ·{" "}
            {seconds(item.endFrame - item.startFrame, rate)}
          </p>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Close clip details"
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </div>
      {kind === "text" && props.onSetText ? (
        <Textarea
          // Remount when the clip or its committed words change, so the field shows them.
          key={`${item.key}:${graphicText(item)}`}
          id={TEXT_FIELD_ID}
          size="sm"
          rows={2}
          defaultValue={graphicText(item)}
          aria-label="Text on screen"
          onBlur={(event) => {
            const next = event.currentTarget.value;
            if (next.trim() !== "" && next !== graphicText(item)) props.onSetText?.(next);
          }}
          onKeyDown={(event) => {
            // Enter keeps the edit; Shift+Enter adds a line, as captions can have two.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.blur();
            }
            if (event.key === "Escape") {
              event.currentTarget.value = graphicText(item);
              event.currentTarget.blur();
            }
          }}
        />
      ) : null}
      {effects.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {effects.map((effect, index, all) => (
            <Tooltip
              key={`${effect.ref}#${all.slice(0, index).filter((e) => e.ref === effect.ref).length}`}
            >
              <TooltipTrigger
                render={
                  <span className="flex items-center gap-1 rounded-xs border border-border px-1.5 py-0.5 font-mono text-2xs" />
                }
              >
                {effect.animated ? <SparklesIcon className="size-3" /> : null}
                {effectChipLabel(effect)}
              </TooltipTrigger>
              <TooltipPopup side="top">
                {effect.kind}
                {effect.animated ? ", animated" : ""}: {TIER_HINT[effect.tier]}
              </TooltipPopup>
            </Tooltip>
          ))}
        </div>
      ) : null}
    </div>
  );
}
