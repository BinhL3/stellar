import {
  flattenThemeColor,
  type MobileThemeAppearance,
  themeColorWithAlpha,
  type MobileThemeVariables,
} from "../lib/mobileTheme";

export interface WidgetPalette {
  background: string;
  foreground: string;
  secondary: string;
  accent: string;
  track: string;
  danger: string;
}

// The widget extension reads `mode`, `light` and `dark`. Both palettes are the active theme's,
// so a widget matches the app's theme instead of the home screen's scheme.
export interface WidgetTheme {
  mode: MobileThemeAppearance;
  light: WidgetPalette;
  dark: WidgetPalette;
}

export function createWidgetTheme(
  variables: MobileThemeVariables,
  mode: MobileThemeAppearance,
): WidgetTheme {
  const palette = {
    background: variables["--color-card"],
    foreground: variables["--color-foreground"],
    secondary: variables["--color-foreground-secondary"],
    accent: variables["--color-primary"],
    // Surface tokens can coincide; a foreground blend keeps the unfilled track visible.
    track: flattenThemeColor(
      themeColorWithAlpha(variables["--color-foreground"], 0.16),
      variables["--color-card"],
    ),
    danger: variables["--color-danger-foreground"],
  };
  return { mode, light: palette, dark: palette };
}
