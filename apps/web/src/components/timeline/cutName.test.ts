import { expect, it } from "vite-plus/test";

import { cutName } from "./cutName";

it.each([
  // The sequence's own name wins, without the project it sits in.
  [
    "timelines/Jollibee_-_Rough_A_hook_8148_.otio",
    { title: "Jollibee - Rough A (hook 8148)", project: "Jollibee" },
    "Rough A (hook 8148)",
  ],
  // Unread timelines fall back to the file name, with its separators as spaces.
  ["timelines/Jollibee_-_Rough_A_hook_8148_.otio", { project: "jollibee" }, "Rough A hook 8148"],
  ["timelines/Jollibee_-_Rough_A.otio", { project: "Other" }, "Jollibee - Rough A"],
  ["footage.otio", { title: "  " }, "footage"],
  ["timelines/___.otio", undefined, "___"],
])("names %s", (path, options, expected) => {
  expect(cutName(path, options)).toBe(expected);
});
