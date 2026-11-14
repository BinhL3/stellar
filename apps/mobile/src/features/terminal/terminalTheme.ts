import {
  getMobileThemeColors,
  getMobileThemeVariables,
  themeColorToNativeColor,
  type MobileThemeId,
} from "../../lib/mobileTheme";

/** Always "dark"; callers still pass the appearance they render in. */
export type TerminalAppearanceScheme = "dark";

export interface TerminalTheme {
  readonly background: string;
  readonly foreground: string;
  readonly mutedForeground: string;
  readonly border: string;
  readonly cursorForeground: string;
  readonly cursorBackground: string;
  readonly palette: TerminalPalette;
}

type TerminalPalette = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

const PIERRE_DARK_THEME: TerminalTheme = {
  background: "#0a0a0a",
  foreground: "#adadb1",
  mutedForeground: "#8E8E95",
  border: "#2e2e30",
  cursorForeground: "#009fff",
  cursorBackground: "#0a0a0a",
  palette: [
    "#141415",
    "#ff2e3f",
    "#0dbe4e",
    "#ffca00",
    "#009fff",
    "#c635e4",
    "#08c0ef",
    "#c6c6c8",
    "#141415",
    "#ff2e3f",
    "#0dbe4e",
    "#ffca00",
    "#009fff",
    "#c635e4",
    "#08c0ef",
    "#c6c6c8",
  ],
};

export function getMobileTerminalTheme(
  themeId: MobileThemeId,
  _scheme?: TerminalAppearanceScheme,
): TerminalTheme {
  const base = PIERRE_DARK_THEME;
  const paletteId = themeId === "material-you" ? "t3-code" : themeId;
  const palette = getMobileThemeColors(paletteId);
  const colors = getMobileThemeVariables(paletteId);
  const background = themeColorToNativeColor(palette.terminalBackground);
  return {
    ...base,
    background,
    foreground: themeColorToNativeColor(palette.terminalForeground),
    mutedForeground: colors["--color-foreground-muted"],
    border: colors["--color-border"],
    cursorForeground: themeColorToNativeColor(palette.terminalCursor),
    cursorBackground: background,
  };
}

export function buildGhosttyThemeConfig(theme: TerminalTheme): string {
  const lines = [
    `background = ${theme.background}`,
    `foreground = ${theme.foreground}`,
    `cursor-color = ${theme.cursorForeground}`,
    `cursor-text = ${theme.cursorBackground}`,
  ];

  for (const [index, color] of theme.palette.entries()) {
    lines.push(`palette = ${index}=${color}`);
  }

  return `${lines.join("\n")}\n`;
}
