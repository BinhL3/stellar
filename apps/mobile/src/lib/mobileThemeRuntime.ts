import { resolveTextScaleVariables } from "./appearancePreferences";
import type { ThemeName } from "uniwind";
import {
  BUILT_IN_UNIWIND_THEME_NAMES,
  builtInThemeAppearance,
  DEFAULT_MOBILE_THEME_ID,
  type MobileThemeId,
} from "./mobileTheme";

// Uniwind always defines "light"; it carries the same dark variables as "dark".
// The generated theme list names each built-in theme by its own appearance.
export type MobileUniwindThemeName = Exclude<ThemeName, "light">;

const UNIWIND_THEME_NAMES: ReadonlyArray<"light" | MobileUniwindThemeName> = [
  "light",
  "dark",
  ...(BUILT_IN_UNIWIND_THEME_NAMES as ReadonlyArray<MobileUniwindThemeName>),
];

export function getMobileUniwindThemeName(themeId: MobileThemeId): MobileUniwindThemeName {
  return themeId === DEFAULT_MOBILE_THEME_ID || themeId === "material-you"
    ? "dark"
    : (`${themeId}-${builtInThemeAppearance(themeId)}` as MobileUniwindThemeName);
}

/** Text-scale variables live on every Uniwind theme, so a change is written to each. */
export function textScaleVariableUpdates(baseFontSize: number): ReadonlyArray<{
  readonly themeName: "light" | MobileUniwindThemeName;
  readonly variables: Readonly<Record<string, number>>;
}> {
  const variables = resolveTextScaleVariables(baseFontSize);
  return UNIWIND_THEME_NAMES.map((themeName) => ({ themeName, variables }));
}
