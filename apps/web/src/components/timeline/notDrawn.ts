import type { LaidOutClip } from "@t3tools/timeline/layout";

import { graphicOf } from "./clipTransform";

/**
 * What the preview leaves out, so the Monitor can say so. The engine draws Motion, Opacity,
 * Crop and text; every other effect on a clip is listed by the name Premiere shows for it.
 */

// Effects the engine draws, plus the group a graphic's layers sit in, which has no look itself.
const DRAWN_EFFECTS = new Set([
  "AE.ADBE Motion",
  "AE.ADBE Opacity",
  "AE.ADBE AECrop",
  "AE.ADBE Text",
  "AE.ADBE Graphic Group",
]);

/** Blend modes a 2D canvas composites itself, by the name a pull stores. */
export const CANVAS_BLEND: Readonly<Record<string, GlobalCompositeOperation>> = {
  darken: "darken",
  multiply: "multiply",
  "color-burn": "color-burn",
  lighten: "lighten",
  screen: "screen",
  "color-dodge": "color-dodge",
  "linear-dodge": "lighter",
  overlay: "overlay",
  "soft-light": "soft-light",
  "hard-light": "hard-light",
  difference: "difference",
  exclusion: "exclusion",
  hue: "hue",
  saturation: "saturation",
  color: "color",
  luminosity: "luminosity",
};

/** What the preview does not draw of one video clip, in the user's words. Empty when it is whole. */
export const clipNotDrawn = (item: LaidOutClip): ReadonlyArray<string> => {
  const graphic = graphicOf(item);
  const missing: Array<string> = [];
  for (const effect of graphic.effects ?? []) {
    if (effect.matchName === undefined || DRAWN_EFFECTS.has(effect.matchName)) continue;
    const named = effect.label !== effect.kind && effect.label.length <= 40;
    missing.push(named ? `${effect.kind} (${effect.label})` : effect.kind);
  }
  const blend = graphic.blendMode;
  if (blend !== undefined && blend !== "normal" && CANVAS_BLEND[blend] === undefined) {
    missing.push(`${blend.replaceAll("-", " ")} blend`);
  }
  return [...new Set(missing)];
};
