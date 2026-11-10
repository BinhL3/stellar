/**
 * Premiere keyboard layouts (`.kys`, XML) mapped onto the timeline's actions, so an editor keeps
 * their own keys. A binding is a combo string, modifiers in a fixed order: `Meta+Alt+Shift+Control+K`.
 */
import { XMLParser } from "fast-xml-parser";

export const TIMELINE_ACTIONS = {
  togglePlay: ["cmd.transport.toggleplay"],
  playAround: ["cmd.transport.play.fat"],
  playToOut: ["cmd.transport.play.ctitoout"],
  playInToOut: ["cmd.transport.playintoout"],
  shuttleLeft: ["cmd.transport.shuttle.left"],
  shuttleStop: ["cmd.transport.shuttle.stop"],
  shuttleRight: ["cmd.transport.shuttle.right"],
  shuttleSlowLeft: ["cmd.transport.shuttle.slow.left"],
  shuttleSlowRight: ["cmd.transport.shuttle.slow.right"],
  stepBack: ["cmd.transport.step.back"],
  stepForward: ["cmd.transport.step.forward"],
  stepBackFive: ["cmd.transport.step.back.five"],
  stepForwardFive: ["cmd.transport.step.forward.five"],
  goToStart: ["cmd.transport.sequence.start"],
  goToEnd: ["cmd.transport.sequence.end"],
  goToClipStart: ["cmd.transport.selectedclip.start"],
  goToClipEnd: ["cmd.transport.selectedclip.end"],
  previousEdit: ["cmd.tlnav.prev.edit", "cmd.tlnav.prev.edit.any.track"],
  nextEdit: ["cmd.tlnav.next.edit", "cmd.tlnav.next.edit.any.track"],
  markIn: ["cmd.common.setin"],
  markOut: ["cmd.common.setout"],
  goToIn: ["cmd.goto.in"],
  goToOut: ["cmd.goto.out"],
  clearIn: ["cmd.clear.in"],
  clearOut: ["cmd.clear.out"],
  clearInOut: ["cmd.clear.inandout"],
  zoomIn: ["cmd.zoom.in"],
  zoomOut: ["cmd.zoom.out"],
  zoomToSequence: ["cmd.tlnav.zoomto.sequence"],
  previousScreen: ["cmd.timeline.show.previous.screen"],
  nextScreen: ["cmd.timeline.show.next.screen"],
  addEdit: ["cmd.sequence.razorateditline", "cmd.sequence.razorateditline.all"],
  rippleDelete: ["cmd.edit.rippledelete", "cmd.timeline.ripple.delete"],
  clear: ["cmd.edit.clear"],
  lift: ["cmd.sequence.lift"],
  extract: ["cmd.sequence.extract"],
  rippleTrimPrevious: ["cmd.sequence.rippletrimpreviousedittoplayhead"],
  rippleTrimNext: ["cmd.sequence.rippletrimnextedittoplayhead"],
  trimInToPlayhead: ["cmd.tlnav.trim.in.to.cti"],
  trimOutToPlayhead: ["cmd.tlnav.trim.out.to.cti"],
  nudgeLeft: ["cmd.timeline.nudge.left.one"],
  nudgeRight: ["cmd.timeline.nudge.right.one"],
  nudgeLeftFive: ["cmd.timeline.nudge.left.several"],
  nudgeRightFive: ["cmd.timeline.nudge.right.several"],
  nudgeUp: ["cmd.timeline.nudge.up"],
  nudgeDown: ["cmd.timeline.nudge.down"],
  selectPreviousClip: ["cmd.tlnav.select.previous.clip"],
  selectNextClip: ["cmd.tlnav.select.next.clip"],
  deselectAll: ["cmd.edit.deselectall"],
  toggleClipEnabled: ["cmd.clip.enable"],
  undo: ["cmd.edit.undo"],
  redo: ["cmd.edit.redo"],
  maximize: ["cmd.toggle.maximize.focused.frame"],
} as const satisfies Record<string, ReadonlyArray<string>>;

export type TimelineAction = keyof typeof TIMELINE_ACTIONS;
/** Combo → action. */
export type Keymap = Readonly<Record<string, TimelineAction>>;

/** Premiere's default macOS keys for the actions above. */
export const PREMIERE_DEFAULT_KEYMAP: Keymap = {
  Space: "togglePlay",
  "Shift+Space": "playAround",
  "Control+Space": "playToOut",
  "Alt+K": "playInToOut",
  J: "shuttleLeft",
  K: "shuttleStop",
  L: "shuttleRight",
  "Shift+J": "shuttleSlowLeft",
  "Shift+L": "shuttleSlowRight",
  ArrowLeft: "stepBack",
  ArrowRight: "stepForward",
  "Shift+ArrowLeft": "stepBackFive",
  "Shift+ArrowRight": "stepForwardFive",
  Home: "goToStart",
  End: "goToEnd",
  "Shift+Home": "goToClipStart",
  "Shift+End": "goToClipEnd",
  ArrowUp: "previousEdit",
  ArrowDown: "nextEdit",
  I: "markIn",
  O: "markOut",
  "Shift+I": "goToIn",
  "Shift+O": "goToOut",
  "Alt+I": "clearIn",
  "Alt+O": "clearOut",
  "Alt+X": "clearInOut",
  "=": "zoomIn",
  "-": "zoomOut",
  "\\": "zoomToSequence",
  PageUp: "previousScreen",
  PageDown: "nextScreen",
  "Meta+K": "addEdit",
  "Meta+Shift+K": "addEdit",
  "Alt+Backspace": "rippleDelete",
  "Shift+Delete": "rippleDelete",
  Backspace: "clear",
  Delete: "clear",
  ";": "lift",
  "'": "extract",
  Q: "rippleTrimPrevious",
  W: "rippleTrimNext",
  "Alt+Q": "trimInToPlayhead",
  "Alt+W": "trimOutToPlayhead",
  "Meta+ArrowLeft": "nudgeLeft",
  "Meta+ArrowRight": "nudgeRight",
  "Meta+Shift+ArrowLeft": "nudgeLeftFive",
  "Meta+Shift+ArrowRight": "nudgeRightFive",
  "Alt+ArrowUp": "nudgeUp",
  "Alt+ArrowDown": "nudgeDown",
  "Meta+ArrowUp": "selectPreviousClip",
  "Meta+ArrowDown": "selectNextClip",
  "Meta+Shift+A": "deselectAll",
  "Meta+Shift+E": "toggleClipEnabled",
  "Meta+Z": "undo",
  "Meta+Shift+Z": "redo",
  "`": "maximize",
};

// Premiere's own codes for non-character keys; character keys carry the high bit (0x80000000).
const SPECIAL_KEYS: Readonly<Record<number, string>> = {
  1: "Space",
  2: "Backspace",
  3: "Tab",
  4: "Enter",
  7: "F1",
  35: "Delete",
  36: "Home",
  37: "End",
  38: "PageUp",
  39: "PageDown",
  42: "ArrowLeft",
  43: "ArrowRight",
  44: "ArrowUp",
  45: "ArrowDown",
};
const CHARACTER_FLAG = 0x80000000;
// Shortcuts that apply in the timeline: global ones, then the Timeline panel's, which win.
const CONTEXTS = ["context.global", "context.timeline"] as const;

export const comboOf = (input: {
  readonly key: string;
  readonly meta?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
  readonly control?: boolean;
}): string =>
  [
    input.meta ? "Meta" : null,
    input.alt ? "Alt" : null,
    input.shift ? "Shift" : null,
    input.control ? "Control" : null,
    input.key,
  ]
    .filter((part) => part !== null)
    .join("+");

const keyFromCode = (code: number): string | null => {
  if (code >= CHARACTER_FLAG) return String.fromCodePoint(code - CHARACTER_FLAG).toUpperCase();
  return SPECIAL_KEYS[code] ?? null;
};

const COMMAND_ACTIONS = new Map<string, TimelineAction>(
  Object.entries(TIMELINE_ACTIONS).flatMap(([action, commands]) =>
    commands.map((command) => [command, action as TimelineAction] as const),
  ),
);

/** The timeline keymap in a Premiere `.kys` layout. Unmapped commands and unknown keys are skipped. */
export const keymapFromKys = (xml: string): Keymap => {
  const parsed = new XMLParser({ parseTagValue: false }).parse(xml) as {
    PremiereData?: { shortcuts?: Record<string, unknown> };
  };
  const shortcuts = parsed.PremiereData?.shortcuts ?? {};
  const keymap: Record<string, TimelineAction> = {};
  for (const context of CONTEXTS) {
    const items = (shortcuts[context] ?? {}) as Record<string, Record<string, string> | string>;
    for (const [name, item] of Object.entries(items)) {
      if (!name.startsWith("item.") || typeof item !== "object") continue;
      const action = COMMAND_ACTIONS.get(item["commandname"] ?? "");
      const code = item["virtualkey"];
      const key = code === undefined ? null : keyFromCode(Number(code));
      if (action === undefined || key === null) continue;
      const combo = comboOf({
        key,
        meta: item["modifier.command"] === "true",
        alt: item["modifier.opt"] === "true",
        shift: item["modifier.shift"] === "true",
        control: item["modifier.ctrl"] === "true",
      });
      keymap[combo] = action;
    }
  }
  return keymap;
};
