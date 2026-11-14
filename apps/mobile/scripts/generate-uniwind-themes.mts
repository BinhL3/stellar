#!/usr/bin/env node

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import tailwindColors from "tailwindcss/colors";
import { BUILT_IN_THEME_IDS, type BuiltInThemeId } from "@t3tools/shared/themePalettes";

import {
  createMobileThemeVariables,
  getMobileThemeColors,
  getMobileThemeVariables,
  DEFAULT_MOBILE_THEME_ID,
} from "../src/lib/mobileTheme.ts";

const GENERATED_CSS_PATH = NodePath.resolve(import.meta.dirname, "../generated-uniwind-themes.css");
const GENERATED_NAMES_PATH = NodePath.resolve(
  import.meta.dirname,
  "../generated-uniwind-theme-names.json",
);
const GENERATED_DEFAULT_VARIABLES_PATH = NodePath.resolve(
  import.meta.dirname,
  "../generated-uniwind-default-theme-variables.json",
);
const GENERATED_CLERK_THEME_PATH = NodePath.resolve(import.meta.dirname, "../clerk-theme.json");

type TailwindColorFamily = keyof typeof tailwindColors;
type TailwindColorShade = 50 | 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950;

const color = (family: TailwindColorFamily, shade?: TailwindColorShade, opacity = 1): string => {
  const familyColors = tailwindColors[family];
  const value =
    typeof familyColors === "string"
      ? shade === undefined
        ? familyColors
        : undefined
      : shade === undefined
        ? undefined
        : familyColors[String(shade) as keyof typeof familyColors];
  if (value === undefined) {
    throw new Error(`Unknown Tailwind color ${family}${shade === undefined ? "" : `-${shade}`}.`);
  }
  if (opacity === 1) return value;

  const percentage = Number((opacity * 100).toFixed(4));
  const oklch = /^oklch\((.*)\)$/.exec(value);
  if (oklch) return `oklch(${oklch[1]} / ${percentage}%)`;
  if (value === "#fff") return `rgb(255 255 255 / ${percentage}%)`;
  if (value === "#000") return `rgb(0 0 0 / ${percentage}%)`;
  return `color-mix(in srgb, ${value} ${percentage}%, transparent)`;
};

// Named for the light and dark values they once switched between; only the dark one is left.
const ADAPTIVE_COLORS: Readonly<Record<string, string>> = {
  "--color-adaptive-amber-50-950-a40": color("amber", 950, 0.4),
  "--color-adaptive-amber-200-900-a60": color("amber", 900, 0.6),
  "--color-adaptive-amber-500-a12-a16": color("amber", 500, 0.16),
  "--color-adaptive-amber-500-a10-400-a10": color("amber", 400, 0.1),
  "--color-adaptive-amber-500-a25-400-a25": color("amber", 400, 0.25),
  "--color-adaptive-amber-700-300": color("amber", 300),
  "--color-adaptive-amber-700-400": color("amber", 400),
  "--color-adaptive-amber-800-200": color("amber", 200),
  "--color-adaptive-blue-50-blue-400-a14": color("blue", 400, 0.14),
  "--color-adaptive-blue-300-a50-blue-400-a28": color("blue", 400, 0.28),
  "--color-adaptive-blue-500-a20-blue-400-a15": color("blue", 400, 0.15),
  "--color-adaptive-blue-500-400": color("blue", 400),
  "--color-adaptive-blue-600-400": color("blue", 400),
  "--color-adaptive-black-a10-a25": color("black", undefined, 0.25),
  "--color-adaptive-black-a15-a35": color("black", undefined, 0.35),
  "--color-adaptive-black-a2p5-white-a2p5": color("white", undefined, 0.025),
  "--color-adaptive-emerald-500-a12-a16": color("emerald", 500, 0.16),
  "--color-adaptive-emerald-600-400": color("emerald", 400),
  "--color-adaptive-emerald-700-300": color("emerald", 300),
  "--color-adaptive-fuchsia-500-a50-300-a40": color("fuchsia", 300, 0.4),
  "--color-adaptive-fuchsia-600-300": color("fuchsia", 300),
  "--color-adaptive-indigo-500-a12-a16": color("indigo", 500, 0.16),
  "--color-adaptive-indigo-600-300": color("indigo", 300),
  "--color-adaptive-indigo-700-300": color("indigo", 300),
  "--color-adaptive-neutral-100-900": color("neutral", 900),
  "--color-adaptive-neutral-200-700-a60": color("neutral", 700, 0.6),
  "--color-adaptive-neutral-200-800": color("neutral", 800),
  "--color-adaptive-neutral-200-a70-white-a8": color("white", undefined, 0.08),
  "--color-adaptive-neutral-200-white-a6": color("white", undefined, 0.06),
  "--color-adaptive-neutral-200-white-a8": color("white", undefined, 0.08),
  "--color-adaptive-neutral-200-a80-white-a8": color("white", undefined, 0.08),
  "--color-adaptive-neutral-300-a60-white-a12": color("white", undefined, 0.12),
  "--color-adaptive-neutral-400-500": color("neutral", 500),
  "--color-adaptive-neutral-400-a60-500-a60": color("neutral", 500, 0.6),
  "--color-adaptive-neutral-400-a80-500-a80": color("neutral", 500, 0.8),
  "--color-adaptive-neutral-500-a10-a16": color("neutral", 500, 0.16),
  "--color-adaptive-neutral-500-400": color("neutral", 400),
  "--color-adaptive-neutral-500-500": color("neutral", 500),
  "--color-adaptive-neutral-600-300": color("neutral", 300),
  "--color-adaptive-neutral-600-400": color("neutral", 400),
  "--color-adaptive-neutral-950-50": color("neutral", 50),
  "--color-adaptive-neutral-950-a5-white-a5": color("white", undefined, 0.05),
  "--color-adaptive-neutral-950-a10-white-a10": color("white", undefined, 0.1),
  "--color-adaptive-red-50-950-a80": color("red", 950, 0.8),
  "--color-adaptive-red-200-800": color("red", 800),
  "--color-adaptive-red-600-a80-400-a80": color("red", 400, 0.8),
  "--color-adaptive-red-700-300": color("red", 300),
  "--color-adaptive-rose-100-500-a18": color("rose", 500, 0.18),
  "--color-adaptive-rose-100-a80-500-a12": color("rose", 500, 0.12),
  "--color-adaptive-rose-300-a70-400-a28": color("rose", 400, 0.28),
  "--color-adaptive-rose-500-a12-a16": color("rose", 500, 0.16),
  "--color-adaptive-rose-500-400": color("rose", 400),
  "--color-adaptive-rose-600-400": color("rose", 400),
  "--color-adaptive-rose-700-300": color("rose", 300),
  "--color-adaptive-sky-500-a12-a16": color("sky", 500, 0.16),
  "--color-adaptive-sky-500-a10-400-a10": color("sky", 400, 0.1),
  "--color-adaptive-sky-500-a25-400-a25": color("sky", 400, 0.25),
  "--color-adaptive-sky-600-400": color("sky", 400),
  "--color-adaptive-sky-700-300": color("sky", 300),
  "--color-adaptive-violet-500-a12-a16": color("violet", 500, 0.16),
  "--color-adaptive-violet-600-400": color("violet", 400),
  "--color-adaptive-violet-700-300": color("violet", 300),
  "--color-adaptive-white-neutral-950-a70": color("neutral", 950, 0.7),
  "--color-adaptive-zinc-500-a12-a16": color("zinc", 500, 0.16),
  "--color-adaptive-zinc-500-400": color("zinc", 400),
  "--color-adaptive-zinc-600-300": color("zinc", 300),
};

export const customThemeNames = BUILT_IN_THEME_IDS.map((themeId) => `${themeId}-dark`);

// Profile pages must match Clerk's build-time palette even with a named app theme.
const clerkColors = (() => {
  const variables = createMobileThemeVariables(getMobileThemeColors(DEFAULT_MOBILE_THEME_ID));
  return {
    primary: variables["--color-primary"],
    background: variables["--color-sheet-solid"],
    input: variables["--color-input"],
    danger: variables["--color-danger-foreground"],
    success: "#34d399",
    warning: variables["--color-warning-foreground"],
    foreground: variables["--color-foreground"],
    mutedForeground: variables["--color-foreground-muted"],
    primaryForeground: variables["--color-primary-foreground"],
    inputForeground: variables["--color-foreground"],
    neutral: variables["--color-secondary"],
    border: variables["--color-border"],
    ring: variables["--color-focus"],
    muted: variables["--color-subtle"],
    shadow: variables["--color-primary-shadow"],
  };
})();

const clerkVariables = {
  "--color-clerk-page": clerkColors.background.toLowerCase(),
  "--color-clerk-foreground": clerkColors.foreground.toLowerCase(),
  "--color-clerk-foreground-muted": clerkColors.mutedForeground.toLowerCase(),
  "--color-clerk-border": clerkColors.border,
  "--color-clerk-danger": clerkColors.danger.toLowerCase(),
};

const variablesFor = (themeId: BuiltInThemeId | typeof DEFAULT_MOBILE_THEME_ID) => ({
  ...getMobileThemeVariables(themeId),
  ...ADAPTIVE_COLORS,
  ...clerkVariables,
});

const renderVariant = (name: string, variables: Readonly<Record<string, string>>) => {
  const declarations = Object.entries(variables)
    .map(([variable, value]) => `      ${variable}: ${value};`)
    .join("\n");
  return `    @variant ${name} {\n${declarations}\n    }`;
};

export const renderUniwindThemesCSS = () => {
  const defaults = variablesFor(DEFAULT_MOBILE_THEME_ID);
  const variants = [
    // Uniwind requires a "light" theme. It carries the dark values, so nothing can paint light.
    renderVariant("light", defaults),
    renderVariant("dark", defaults),
    ...BUILT_IN_THEME_IDS.map((themeId) => renderVariant(`${themeId}-dark`, variablesFor(themeId))),
  ];
  return [
    "/* Generated by scripts/generate-uniwind-themes.mts. Do not edit manually. */",
    "@layer theme {",
    "  :root {",
    variants.join("\n\n"),
    "  }",
    "}",
    "",
  ].join("\n");
};

export const renderDefaultThemeVariablesJSON = () =>
  `${JSON.stringify(getMobileThemeVariables(DEFAULT_MOBILE_THEME_ID), null, 2)}\n`;

export const getGeneratedUniwindThemeOutputs = (): ReadonlyArray<
  readonly [filename: string, contents: string]
> => [
  [GENERATED_CSS_PATH, renderUniwindThemesCSS()],
  [GENERATED_NAMES_PATH, `${JSON.stringify(customThemeNames, null, 2)}\n`],
  [GENERATED_DEFAULT_VARIABLES_PATH, renderDefaultThemeVariablesJSON()],
  [
    GENERATED_CLERK_THEME_PATH,
    // Clerk picks `colors` or `darkColors` by the system scheme; both are the dark palette.
    `${JSON.stringify({ colors: clerkColors, darkColors: clerkColors, design: { borderRadius: 18 } }, null, 2)}\n`,
  ],
];

const writeFileAtomically = (filename: string, contents: string) => {
  const current = NodeFS.existsSync(filename) ? NodeFS.readFileSync(filename, "utf8") : null;
  if (current === contents) return;

  const temporaryFilename = `${filename}.${process.pid}.tmp`;
  try {
    NodeFS.writeFileSync(temporaryFilename, contents);
    NodeFS.renameSync(temporaryFilename, filename);
  } finally {
    if (NodeFS.existsSync(temporaryFilename)) NodeFS.unlinkSync(temporaryFilename);
  }
};

if (import.meta.main) {
  const checkOnly = process.argv.includes("--check");
  for (const [filename, contents] of getGeneratedUniwindThemeOutputs()) {
    if (checkOnly) {
      const current = NodeFS.existsSync(filename) ? NodeFS.readFileSync(filename, "utf8") : null;
      if (current !== contents) {
        console.error(
          `${NodePath.relative(process.cwd(), filename)} is stale. Run vp run --filter @t3tools/mobile generate.`,
        );
        process.exitCode = 1;
      }
      continue;
    }
    // Atomic replacement prevents Metro from compiling partial CSS.
    writeFileAtomically(filename, contents);
  }
}
