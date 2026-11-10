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
  markIn: "Mark in",
  markOut: "Mark out",
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
  rippleDelete: "Ripple delete",
  clear: "Delete",
  lift: "Lift in to out",
  extract: "Extract in to out",
  rippleTrimPrevious: "Ripple trim previous cut to the playhead",
  rippleTrimNext: "Ripple trim next cut to the playhead",
  trimInToPlayhead: "Trim the clip's start to the playhead",
  trimOutToPlayhead: "Trim the clip's end to the playhead",
  nudgeLeft: "Nudge left one frame",
  nudgeRight: "Nudge right one frame",
  nudgeLeftFive: "Nudge left five frames",
  nudgeRightFive: "Nudge right five frames",
  nudgeUp: "Move to the track above",
  nudgeDown: "Move to the track below",
  selectPreviousClip: "Select the previous clip",
  selectNextClip: "Select the next clip",
  deselectAll: "Deselect",
  toggleClipEnabled: "Enable or disable the clip",
  undo: "Undo",
  redo: "Redo",
  maximize: "Full screen",
};

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

export const comboFromEvent = (event: React.KeyboardEvent): string | null => {
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
  readonly keymap: Keymap;
}

const readStored = (): StoredLayout | null => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw) as StoredLayout;
    return typeof value.name === "string" && typeof value.keymap === "object" ? value : null;
  } catch {
    return null;
  }
};

/**
 * The viewer's shortcut layout: Premiere's defaults, or a layout imported from a Premiere `.kys`
 * file. The choice is a per-browser convenience, so it lives in local storage.
 */
export function useTimelineKeymap() {
  const [stored, setStored] = useState<StoredLayout | null>(readStored);
  const save = (next: StoredLayout | null) => {
    setStored(next);
    try {
      if (next === null) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage can be unavailable (private windows); the layout still applies this session.
    }
  };
  return {
    name: stored?.name ?? "Premiere default",
    imported: stored !== null,
    keymap: stored?.keymap ?? PREMIERE_DEFAULT_KEYMAP,
    /** Reads a `.kys` file; returns how many actions it bound, 0 when it isn't a Premiere layout. */
    importKys: async (file: File) => {
      const keymap = keymapFromKys(await file.text());
      const count = new Set(Object.values(keymap)).size;
      if (count > 0) save({ name: file.name.replace(/\.kys$/i, ""), keymap });
      return count;
    },
    reset: () => save(null),
  };
}

/** The keys bound to an action, for hints. */
export const combosFor = (keymap: Keymap, action: TimelineAction) =>
  Object.entries(keymap)
    .filter(([, bound]) => bound === action)
    .map(([combo]) => combo);
