import {
  BACKDROP_TREATMENTS,
  type BackdropParams,
  type BackdropTreatment,
} from "@t3tools/contracts/settings";

export interface BackdropSlider {
  readonly key: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly initial: number;
  readonly unit: "px" | "°" | "%";
}

const slider = (
  key: string,
  label: string,
  min: number,
  max: number,
  initial: number,
  unit: BackdropSlider["unit"] = "%",
): BackdropSlider => ({ key, label, min, max, initial, unit });

const contrast = slider("contrast", "Contrast", 0.5, 2, 1);

export const BACKDROP_TREATMENT_SPECS: Readonly<
  Record<
    BackdropTreatment,
    { readonly label: string; readonly sliders: ReadonlyArray<BackdropSlider> }
  >
> = {
  dither: {
    label: "Dithered dots",
    sliders: [slider("dotSize", "Dot size", 2, 8, 3, "px"), contrast],
  },
  halftone: {
    label: "Halftone dots",
    sliders: [
      slider("dotSize", "Dot size", 4, 18, 8, "px"),
      contrast,
      slider("angle", "Screen angle", 0, 90, 30, "°"),
    ],
  },
  cmyk: {
    label: "Halftone CMYK",
    sliders: [
      slider("dotSize", "Dot size", 4, 18, 7, "px"),
      contrast,
      slider("offset", "Misregistration", 0, 8, 2, "px"),
    ],
  },
  fluted: {
    label: "Fluted glass",
    sliders: [
      slider("ribSize", "Rib size", 9, 96, 36, "px"),
      slider("distortion", "Distortion", 0, 1, 0.5),
      slider("dotSize", "Dot size", 2, 8, 3, "px"),
    ],
  },
  paper: {
    label: "Paper texture",
    sliders: [slider("grain", "Grain", 0, 1, 0.5), slider("fibre", "Fibre", 0, 1, 0.4), contrast],
  },
  none: { label: "None", sliders: [] },
};

export const BACKDROP_TREATMENT_OPTIONS = BACKDROP_TREATMENTS.map(
  (treatment) => [treatment, BACKDROP_TREATMENT_SPECS[treatment].label] as const,
);

/**
 * Prints cheap enough to redraw while the scene moves: one ink per dot. The others work out a
 * screen per output pixel, so they keep a still picture and skip pointer parallax.
 */
export const backdropTreatmentMoves = (treatment: BackdropTreatment) =>
  treatment === "dither" || treatment === "fluted";

export const backdropParamKey = (treatment: BackdropTreatment, sliderKey: string) =>
  `${treatment}.${sliderKey}`;

/** Where a slider sits, 0 to 100, from the stored settings or its default. */
export function backdropSliderPercent(
  treatment: BackdropTreatment,
  spec: BackdropSlider,
  stored: BackdropParams,
): number {
  return (
    stored[backdropParamKey(treatment, spec.key)] ??
    Math.round(((spec.initial - spec.min) / (spec.max - spec.min)) * 100)
  );
}

const backdropSliderValue = (spec: BackdropSlider, percent: number) =>
  spec.min + (percent / 100) * (spec.max - spec.min);

export function formatBackdropSliderValue(spec: BackdropSlider, percent: number): string {
  const value = backdropSliderValue(spec, percent);
  if (spec.unit === "%") return `${Math.round(value * 100)}%`;
  return `${Math.round(value)}${spec.unit === "px" ? " px" : "°"}`;
}

/** The treatment's slider values in their own units, keyed by slider. */
export function resolveBackdropValues(
  treatment: BackdropTreatment,
  stored: BackdropParams,
): Readonly<Record<string, number>> {
  return Object.fromEntries(
    BACKDROP_TREATMENT_SPECS[treatment].sliders.map((spec) => [
      spec.key,
      backdropSliderValue(spec, backdropSliderPercent(treatment, spec, stored)),
    ]),
  );
}
