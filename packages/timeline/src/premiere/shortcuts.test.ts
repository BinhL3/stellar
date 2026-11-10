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
});
