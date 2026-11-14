import {
  comboOf,
  type Keymap,
  keymapFromKys,
  PREMIERE_DEFAULT_KEYMAP,
  type TimelineAction,
} from "@t3tools/timeline/premiere/shortcuts";
import { useState } from "react";

export const ACTION_LABELS: Record<TimelineAction, string> = {
  togglePlay: "Play or pause",
  playAround: "Play around the playhead",
  playToOut: "Play to the out point",
  playInToOut: "Play in to out",
  shuttleLeft: "Shuttle backward",
  shuttleStop: "Stop",
  shuttleRight: "Shuttle forward",
  shuttleSlowLeft: "Shuttle slowly backward",
  shuttleSlowRight: "Shuttle slowly forward",
  stepBack: "Back one frame",
  stepForward: "Forward one frame",
  stepBackFive: "Back five frames",
  stepForwardFive: "Forward five frames",
  goToStart: "Go to start",
  goToEnd: "Go to end",
  goToClipStart: "Go to the clip's start",
  goToClipEnd: "Go to the clip's end",
  previousEdit: "Previous cut",
  nextEdit: "Next cut",
  previousGap: "Previous gap",
  nextGap: "Next gap",
  markIn: "Mark in",
  markOut: "Mark out",
  markSelection: "Mark the selected clip or gap",
  goToIn: "Go to in",
  goToOut: "Go to out",
  clearIn: "Clear in",
  clearOut: "Clear out",
  clearInOut: "Clear in and out",
  zoomIn: "Zoom in",
  zoomOut: "Zoom out",
  zoomToSequence: "Fit the timeline",
  previousScreen: "Previous screen",
  nextScreen: "Next screen",
  addEdit: "Cut at the playhead",
  addEditAll: "Cut every track at the playhead",
  rippleDelete: "Ripple delete",
  clear: "Delete",
  lift: "Lift in to out",
  extract: "Extract in to out",
  rippleTrimPrevious: "Ripple trim previous cut to the playhead",
  rippleTrimNext: "Ripple trim next cut to the playhead",
  extendPreviousEdit: "Roll the previous cut to the playhead",
  extendNextEdit: "Roll the next cut to the playhead",
  trimInToPlayhead: "Trim the clip's start to the playhead",
  trimOutToPlayhead: "Trim the clip's end to the playhead",
  nudgeLeft: "Nudge left one frame",
  nudgeRight: "Nudge right one frame",
  nudgeLeftFive: "Nudge left five frames",
  nudgeRightFive: "Nudge right five frames",
  slipLeft: "Slip one frame left",
  slipRight: "Slip one frame right",
  slipLeftFive: "Slip five frames left",
  slipRightFive: "Slip five frames right",
  slideLeft: "Slide one frame left",
  slideRight: "Slide one frame right",
  slideLeftFive: "Slide five frames left",
  slideRightFive: "Slide five frames right",
  nudgeUp: "Move to the track above",
  nudgeDown: "Move to the track below",
  selectPreviousClip: "Select the previous clip",
  selectNextClip: "Select the next clip",
  deselectAll: "Deselect",
  toggleClipEnabled: "Enable or disable the clip",
  undo: "Undo",
  redo: "Redo",
  maximize: "Maximize the panel under the pointer",
  fullScreen: "Full screen",
  addMarker: "Add a marker",
  nextMarker: "Next marker",
  previousMarker: "Previous marker",
  listenToCut: "Hear the selected edit's cut, then the join",
  toolSelection: "Selection tool",
  toolRippleEdit: "Ripple edit tool",
  toolRollingEdit: "Rolling edit tool",
  toolRazor: "Razor tool",
  toolSlip: "Slip tool",
  toolSlide: "Slide tool",
  toolHand: "Hand tool",
  toolZoom: "Zoom tool",
};

/** What a press or drag on the tracks does, as Premiere's tools. */
export type TimelineTool =
  | "selection"
  | "rippleEdit"
  | "rollingEdit"
  | "razor"
  | "slip"
  | "slide"
  | "hand"
  | "zoom";

export const TOOL_ACTIONS = {
  selection: "toolSelection",
  rippleEdit: "toolRippleEdit",
  rollingEdit: "toolRollingEdit",
  razor: "toolRazor",
  slip: "toolSlip",
  slide: "toolSlide",
  hand: "toolHand",
  zoom: "toolZoom",
} as const satisfies Record<TimelineTool, TimelineAction>;

export const TOOL_HINTS: Record<TimelineTool, string> = {
  selection: "Drag clips to move them; drag their edges to trim",
  rippleEdit: "Drag an edge; everything after the clip follows",
  rollingEdit: "Drag a cut between two clips",
  razor: "Click a clip to cut it there; Shift-click cuts every track",
  slip: "Drag a clip to play another part of its media in the same place",
  slide: "Drag a clip along; its neighbours trim to keep the cuts closed",
  hand: "Drag to scroll the timeline",
  zoom: "Click to zoom in; Option-click to zoom out",
};

/**
 * Keys for actions Premiere has no command for. They are tried before the layout's, and an
 * action that doesn't apply lets the key fall through to the layout: backslash fits the timeline
 * unless an edit that removed footage is selected.
 */
const OWN_KEYMAP: Keymap = { "\\": "listenToCut" };

/** The actions a key runs, in the order to try them. */
export const actionsFor = (keymap: Keymap, combo: string): ReadonlyArray<TimelineAction> =>
  [OWN_KEYMAP[combo], keymap[combo]].filter((action) => action !== undefined);

// Physical keys, not characters: on a Mac, Option turns I into ˆ, and Shift turns ` into ~.
const KEY_BY_CODE: Readonly<Record<string, string>> = {
  Space: "Space",
  Backquote: "`",
  Quote: "'",
  Semicolon: ";",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Minus: "-",
  Equal: "=",
  NumpadAdd: "=",
  NumpadSubtract: "-",
};

type KeyPress = Pick<KeyboardEvent, "code" | "metaKey" | "altKey" | "shiftKey" | "ctrlKey">;

export const comboFromEvent = (event: KeyPress): string | null => {
  const { code } = event;
  const key = code.startsWith("Key")
    ? code.slice(3)
    : code.startsWith("Digit")
      ? code.slice(5)
      : (KEY_BY_CODE[code] ??
        (/^(Arrow\w+|Home|End|PageUp|PageDown|Backspace|Delete|Enter|Tab|F\d+)$/.test(code)
          ? code
          : null));
  if (key === null) return null;
  return comboOf({
    key,
    meta: event.metaKey,
    alt: event.altKey,
    shift: event.shiftKey,
    control: event.ctrlKey,
  });
};

const SYMBOLS: Readonly<Record<string, string>> = {
  Meta: "⌘",
  Alt: "⌥",
  Shift: "⇧",
  Control: "⌃",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Backspace: "⌫",
  Delete: "⌦",
  Space: "Space",
};

export const comboLabel = (combo: string) =>
  combo
    .split("+")
    .map((part) => SYMBOLS[part] ?? part)
    .join("");

const STORAGE_KEY = "stellar.timeline.shortcuts";

interface StoredLayout {
  readonly name: string;
  /** The `.kys` itself, so actions added since the import still pick up the layout's keys. */
  readonly kys?: string;
  readonly keymap: Keymap;
}

const readStored = (): StoredLayout | null => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw) as StoredLayout;
    if (typeof value.name !== "string") return null;
    if (typeof value.kys === "string") return { ...value, keymap: keymapFromKys(value.kys) };
    return typeof value.keymap === "object" ? value : null;
  } catch {
    return null;
  }
};

// Read once: the dock asks on every key press while a timeline is open.
let current: StoredLayout | null | undefined;
const stored = () => {
  if (current === undefined) current = readStored();
  return current;
};

/**
 * Whether a key press maximizes the panel under the pointer. The dock handles it for every
 * panel, but only for the keys the layout gives it: a layout may put Mark In on backquote.
 */
export const maximizesPanel = (event: KeyPress): boolean => {
  const combo = comboFromEvent(event);
  return combo !== null && (stored()?.keymap ?? PREMIERE_DEFAULT_KEYMAP)[combo] === "maximize";
};

/**
 * The viewer's shortcut layout: Premiere's defaults, or a layout imported from a Premiere `.kys`
 * file. The choice is a per-browser convenience, so it lives in local storage.
 */
export function useTimelineKeymap() {
  const [layout, setLayout] = useState<StoredLayout | null>(stored);
  const save = (next: StoredLayout | null) => {
    current = next;
    setLayout(next);
    try {
      if (next === null) window.localStorage.removeItem(STORAGE_KEY);
      else
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ name: next.name, kys: next.kys }),
        );
    } catch {
      // Storage can be unavailable (private windows); the layout still applies this session.
    }
  };
  return {
    name: layout?.name ?? "Premiere default",
    imported: layout !== null,
    keymap: layout?.keymap ?? PREMIERE_DEFAULT_KEYMAP,
    /** Reads a `.kys` file; returns how many actions it bound, 0 when it isn't a Premiere layout. */
    importKys: async (file: File) => {
      const kys = await file.text();
      const keymap = keymapFromKys(kys);
      const count = new Set(Object.values(keymap)).size;
      if (count > 0) save({ name: file.name.replace(/\.kys$/i, ""), kys, keymap });
      return count;
    },
    reset: () => save(null),
  };
}

/** The keys bound to an action, for hints. */
export const combosFor = (keymap: Keymap, action: TimelineAction) =>
  [...Object.entries(OWN_KEYMAP), ...Object.entries(keymap)]
    .filter(([, bound]) => bound === action)
    .map(([combo]) => combo);

/** The key that maximizes a panel under the current layout, for the dock's hint. */
export const maximizeKeyLabel = () =>
  comboLabel(combosFor(stored()?.keymap ?? PREMIERE_DEFAULT_KEYMAP, "maximize")[0] ?? "`");
