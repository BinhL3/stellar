import { describe, expect, it } from "vite-plus/test";

import { keymapFromKys } from "./shortcuts.ts";

const item = (index: number, command: string, code: number, mods: Record<string, boolean> = {}) =>
  `<item.${index} Version="1"><virtualkey>${code}</virtualkey>${["command", "opt", "shift", "ctrl"]
    .map((m) => `<modifier.${m}>${mods[m] === true}</modifier.${m}>`)
    .join("")}<commandname>${command}</commandname></item.${index}>`;
const char = (c: string) => 0x80000000 + c.codePointAt(0)!;

const kys = `<?xml version="1.0" encoding="UTF-8"?>
<PremiereData Version="3"><shortcuts Version="5"><platform>macintosh</platform>
<context.global Version="1"><itemcount>5</itemcount>
${item(0, "cmd.transport.toggleplay", 1)}
${item(1, "cmd.transport.shuttle.left", char("1"))}
${item(2, "cmd.common.setin", char("`"))}
${item(3, "cmd.sequence.razorateditline", char("E"))}
${item(4, "cmd.workspace.reset", char("R"), { command: true })}
<item.5 Version="1"><commandname>cmd.edit.clear</commandname></item.5>
</context.global>
<context.timeline Version="1"><itemcount>2</itemcount>
${item(0, "cmd.timeline.ripple.delete", 2, { opt: true })}
${item(1, "cmd.timeline.nudge.right.several", 43, { command: true, shift: true })}
</context.timeline>
<context.project Version="1"><itemcount>1</itemcount>${item(0, "cmd.edit.clear", 2)}</context.project>
</shortcuts></PremiereData>`;

describe("keymapFromKys", () => {
  it("maps the timeline's commands from global and timeline contexts, decoding Premiere's keys", () => {
    expect(keymapFromKys(kys)).toEqual({
      Space: "togglePlay",
      "1": "shuttleLeft",
      "`": "markIn",
      E: "addEdit",
      "Alt+Backspace": "rippleDelete",
      "Meta+Shift+ArrowRight": "nudgeRightFive",
    });
  });

  it("reads an editor's own layout exactly: its keys win and unsupported commands are left out", () => {
    // Bound timeline-context entries of a real layout ("editor 100x"), commands we support
    // plus a few we don't (insert, overwrite, match frame, rate stretch, clip volume, render).
    const MODS = { "⌘": "command", "⌥": "opt", "⇧": "shift", "⌃": "ctrl" } as const;
    const entries: ReadonlyArray<readonly [string, string | number, string, string]> = [
      ["global", "I", "⌥", "cmd.clear.in"],
      ["global", "X", "⌥", "cmd.clear.inandout"],
      ["global", "O", "⌥", "cmd.clear.out"],
      ["global", "E", "⌘⇧", "cmd.clip.enable"],
      ["global", ",", "", "cmd.clip.insert"],
      ["global", ".", "", "cmd.clip.overlay"],
      ["global", "`", "", "cmd.common.setin"],
      ["global", "4", "", "cmd.common.setout"],
      ["global", 35, "", "cmd.edit.clear"],
      ["global", "A", "⌘⇧", "cmd.edit.deselectall"],
      ["global", "Z", "⌘⇧", "cmd.edit.redo"],
      ["global", "X", "", "cmd.edit.rippledelete"],
      ["global", "Z", "⌘", "cmd.edit.undo"],
      ["global", "I", "⇧", "cmd.goto.in"],
      ["global", "O", "⇧", "cmd.goto.out"],
      ["global", "M", "⇧", "cmd.marker.gotomarker.next"],
      ["global", "M", "⌘⇧", "cmd.marker.gotomarker.previous"],
      ["global", "/", "", "cmd.marker.setsequenceinoutmarkeraroundselection.out"],
      ["global", "W", "⇧", "cmd.sequence.extendnextedittoplayhead"],
      ["global", "Q", "⇧", "cmd.sequence.extendpreviousedittoplayhead"],
      ["global", "'", "", "cmd.sequence.extract"],
      ["global", ";", "⇧", "cmd.sequence.findnextsequencegap"],
      ["global", ";", "⌥", "cmd.sequence.findprevioussequencegap"],
      ["global", "]", "", "cmd.sequence.increaseclipvolume"],
      ["global", ";", "", "cmd.sequence.lift"],
      ["global", "F", "", "cmd.sequence.matchframe"],
      ["global", 4, "", "cmd.sequence.preview"],
      ["global", "E", "", "cmd.sequence.razorateditline"],
      ["global", "K", "⌘⇧", "cmd.sequence.razorateditline.all"],
      ["global", "D", "", "cmd.sequence.rippletrimnextedittoplayhead"],
      ["global", "S", "", "cmd.sequence.rippletrimpreviousedittoplayhead"],
      ["global", "M", "", "cmd.set.marker"],
      ["global", 45, "", "cmd.tlnav.next.edit"],
      ["global", 45, "⇧", "cmd.tlnav.next.edit.any.track"],
      ["global", 44, "", "cmd.tlnav.prev.edit"],
      ["global", 44, "⇧", "cmd.tlnav.prev.edit.any.track"],
      ["global", 45, "⌘", "cmd.tlnav.select.next.clip"],
      ["global", 44, "⌘", "cmd.tlnav.select.previous.clip"],
      ["global", "Q", "⌥", "cmd.tlnav.trim.in.to.cti"],
      ["global", "W", "⌥", "cmd.tlnav.trim.out.to.cti"],
      ["global", "\\", "", "cmd.tlnav.zoomto.sequence"],
      ["global", "`", "⌃", "cmd.toggle.fullscreen.monitor"],
      ["global", "`", "⇧", "cmd.toggle.maximize.focused.frame"],
      ["global", "A", "", "cmd.tools.01pointer"],
      ["global", "B", "", "cmd.tools.03ripple"],
      ["global", "N", "", "cmd.tools.04roll"],
      ["global", "R", "", "cmd.tools.05ratestretch"],
      ["global", "Y", "", "cmd.tools.07slip"],
      ["global", "U", "", "cmd.tools.08slide"],
      ["global", "H", "", "cmd.tools.10hand"],
      ["global", "Z", "", "cmd.tools.11zoom"],
      ["global", "T", "", "cmd.tools.12text"],
      ["global", 1, "⌃", "cmd.transport.play.ctitoout"],
      ["global", 1, "⇧", "cmd.transport.play.fat"],
      ["global", "K", "⌥", "cmd.transport.playintoout"],
      ["global", 37, "⇧", "cmd.transport.selectedclip.end"],
      ["global", 36, "⇧", "cmd.transport.selectedclip.start"],
      ["global", 37, "", "cmd.transport.sequence.end"],
      ["global", 36, "", "cmd.transport.sequence.start"],
      ["global", "1", "", "cmd.transport.shuttle.left"],
      ["global", "3", "", "cmd.transport.shuttle.right"],
      ["global", "J", "⇧", "cmd.transport.shuttle.slow.left"],
      ["global", "L", "⇧", "cmd.transport.shuttle.slow.right"],
      ["global", "2", "", "cmd.transport.shuttle.stop"],
      ["global", "Q", "", "cmd.transport.step.back"],
      ["global", 42, "⇧", "cmd.transport.step.back.five"],
      ["global", "W", "", "cmd.transport.step.forward"],
      ["global", 43, "⇧", "cmd.transport.step.forward.five"],
      ["global", 1, "", "cmd.transport.toggleplay"],
      ["global", "V", "", "cmd.zoom.in"],
      ["global", "C", "", "cmd.zoom.out"],
      ["timeline", 2, "", "cmd.edit.clear"],
      ["timeline", 45, "⌥", "cmd.timeline.nudge.down"],
      ["timeline", 42, "⌘", "cmd.timeline.nudge.left.one"],
      ["timeline", 42, "⌘⇧", "cmd.timeline.nudge.left.several"],
      ["timeline", 43, "⌘", "cmd.timeline.nudge.right.one"],
      ["timeline", 43, "⌘⇧", "cmd.timeline.nudge.right.several"],
      ["timeline", 44, "⌥", "cmd.timeline.nudge.up"],
      ["timeline", 2, "⌥", "cmd.timeline.ripple.delete"],
      ["timeline", 39, "", "cmd.timeline.show.next.screen"],
      ["timeline", 38, "", "cmd.timeline.show.previous.screen"],
      ["timeline", ",", "⌥", "cmd.timeline.slide.left.one"],
      ["timeline", ",", "⌥⇧", "cmd.timeline.slide.left.several"],
      ["timeline", ".", "⌥", "cmd.timeline.slide.right.one"],
      ["timeline", ".", "⌥⇧", "cmd.timeline.slide.right.several"],
      ["timeline", 42, "⌘⌥", "cmd.timeline.slip.left.one"],
      ["timeline", 42, "⌘⌥⇧", "cmd.timeline.slip.left.several"],
      ["timeline", 43, "⌘⌥", "cmd.timeline.slip.right.one"],
      ["timeline", 43, "⌘⌥⇧", "cmd.timeline.slip.right.several"],
    ];
    const context = (name: string) =>
      `<context.${name} Version="1">${entries
        .filter(([where]) => where === name)
        .map(([, key, mods, command], index) =>
          item(
            index,
            command,
            typeof key === "number" ? key : char(key),
            Object.fromEntries([...mods].map((mod) => [MODS[mod as keyof typeof MODS], true])),
          ),
        )
        .join("")}</context.${name}>`;
    const layout = `<?xml version="1.0" encoding="UTF-8"?><PremiereData Version="3"><shortcuts Version="5">${context("global")}${context("timeline")}</shortcuts></PremiereData>`;
    expect(keymapFromKys(layout)).toEqual({
      "`": "markIn",
      "4": "markOut",
      "1": "shuttleLeft",
      "2": "shuttleStop",
      "3": "shuttleRight",
      Q: "stepBack",
      W: "stepForward",
      E: "addEdit",
      "Meta+Shift+K": "addEditAll",
      Y: "toolSlip",
      U: "toolSlide",
      "\\": "zoomToSequence",
      A: "toolSelection",
      S: "rippleTrimPrevious",
      D: "rippleTrimNext",
      H: "toolHand",
      ";": "lift",
      "'": "extract",
      Z: "toolZoom",
      X: "rippleDelete",
      C: "zoomOut",
      V: "zoomIn",
      B: "toolRippleEdit",
      N: "toolRollingEdit",
      M: "addMarker",
      "/": "markSelection",
      Space: "togglePlay",
      "Shift+Space": "playAround",
      "Control+Space": "playToOut",
      "Alt+K": "playInToOut",
      "Shift+J": "shuttleSlowLeft",
      "Shift+L": "shuttleSlowRight",
      "Shift+ArrowLeft": "stepBackFive",
      "Shift+ArrowRight": "stepForwardFive",
      Home: "goToStart",
      End: "goToEnd",
      "Shift+Home": "goToClipStart",
      "Shift+End": "goToClipEnd",
      ArrowUp: "previousEdit",
      ArrowDown: "nextEdit",
      "Shift+ArrowUp": "previousEdit",
      "Shift+ArrowDown": "nextEdit",
      "Alt+;": "previousGap",
      "Shift+;": "nextGap",
      "Shift+I": "goToIn",
      "Shift+O": "goToOut",
      "Alt+I": "clearIn",
      "Alt+O": "clearOut",
      "Alt+X": "clearInOut",
      PageUp: "previousScreen",
      PageDown: "nextScreen",
      Delete: "clear",
      Backspace: "clear",
      "Alt+Backspace": "rippleDelete",
      "Shift+Q": "extendPreviousEdit",
      "Shift+W": "extendNextEdit",
      "Alt+Q": "trimInToPlayhead",
      "Alt+W": "trimOutToPlayhead",
      "Meta+ArrowLeft": "nudgeLeft",
      "Meta+ArrowRight": "nudgeRight",
      "Meta+Shift+ArrowLeft": "nudgeLeftFive",
      "Meta+Shift+ArrowRight": "nudgeRightFive",
      "Alt+ArrowUp": "nudgeUp",
      "Alt+ArrowDown": "nudgeDown",
      "Meta+Alt+ArrowLeft": "slipLeft",
      "Meta+Alt+ArrowRight": "slipRight",
      "Meta+Alt+Shift+ArrowLeft": "slipLeftFive",
      "Meta+Alt+Shift+ArrowRight": "slipRightFive",
      "Alt+,": "slideLeft",
      "Alt+.": "slideRight",
      "Alt+Shift+,": "slideLeftFive",
      "Alt+Shift+.": "slideRightFive",
      "Meta+ArrowUp": "selectPreviousClip",
      "Meta+ArrowDown": "selectNextClip",
      "Meta+Shift+A": "deselectAll",
      "Meta+Shift+E": "toggleClipEnabled",
      "Meta+Z": "undo",
      "Meta+Shift+Z": "redo",
      "Shift+`": "maximize",
      "Control+`": "fullScreen",
      "Shift+M": "nextMarker",
      "Meta+Shift+M": "previousMarker",
    });
  });
});
