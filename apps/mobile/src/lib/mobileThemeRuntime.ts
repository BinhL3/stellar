import { resolveTextScaleVariables } from "./appearancePreferences";
import { BUILT_IN_THEME_IDS, type BuiltInThemeId } from "@t3tools/shared/themePalettes";
import { DEFAULT_MOBILE_THEME_ID, type MobileThemeId } from "./mobileTheme";

// Uniwind always defines "light"; it carries the same dark variables as "dark".
export type MobileUniwindThemeName = "dark" | `${BuiltInThemeId}-dark`;

const UNIWIND_THEME_NAMES: ReadonlyArray<"light" | MobileUniwindThemeName> = [
  "light",
  "dark",
  ...BUILT_IN_THEME_IDS.map((themeId) => `${themeId}-dark` as const),
];

export function getMobileUniwindThemeName(themeId: MobileThemeId): MobileUniwindThemeName {
  return themeId === DEFAULT_MOBILE_THEME_ID || themeId === "material-you"
    ? "dark"
    : `${themeId}-dark`;
}

/** Text-scale variables live on every Uniwind theme, so a change is written to each. */
export function textScaleVariableUpdates(baseFontSize: number): ReadonlyArray<{
  readonly themeName: "light" | MobileUniwindThemeName;
  readonly variables: Readonly<Record<string, number>>;
}> {
  const variables = resolveTextScaleVariables(baseFontSize);
  return UNIWIND_THEME_NAMES.map((themeName) => ({ themeName, variables }));
}
