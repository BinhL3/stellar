import {
  flattenThemeColor,
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

// The widget extension reads `mode`, `light` and `dark`; all three now carry the one dark
// palette, so a widget on a light home screen matches the app instead of the system.
export interface WidgetTheme {
  mode: "dark";
  light: WidgetPalette;
  dark: WidgetPalette;
}

export function createWidgetTheme(variables: MobileThemeVariables): WidgetTheme {
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
  return { mode: "dark", light: palette, dark: palette };
}
