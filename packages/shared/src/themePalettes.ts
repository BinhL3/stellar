export const BUILT_IN_THEME_IDS = [
  "stellar",
  "night-edit",
  "darkroom",
  "studio",
  "drive-in",
  "long-bien",
  "sakura",
  "shore",
  "train-street",
  "nebula",
] as const;

export const DEFAULT_THEME_ID = "drive-in" satisfies (typeof BUILT_IN_THEME_IDS)[number];

export const MOBILE_DEFAULT_THEME_ID = "t3-code";

export const MOBILE_THEME_IDS = [MOBILE_DEFAULT_THEME_ID, ...BUILT_IN_THEME_IDS] as const;

/** Built-in ids that were renamed; stored preferences and `t3 theme set` still name the old one. */
export const RENAMED_THEME_IDS: Readonly<Record<string, BuiltInThemeId>> = {
  borealis: "drive-in",
};

/** Reserve the retired appearance keywords, built-ins, and legacy aliases so custom themes cannot capture stored preferences. */
export const RESERVED_THEME_IDS: ReadonlySet<string> = new Set([
  "system",
  "light",
  "dark",
  ...BUILT_IN_THEME_IDS,
  ...Object.keys(RENAMED_THEME_IDS),
  "t3-code",
  "t3-chat",
  "grove",
  "ocean",
  "ember",
  "iris",
  "t3-chat-dark",
  "t3-grove",
  "t3-ocean",
  "t3-ember",
  "t3-iris",
]);

/** The mobile default id is valid in saved themes but cannot be published because web/desktop cannot resolve it. */
export const UNPUBLISHABLE_THEME_IDS: ReadonlySet<string> = new Set([
  ...RESERVED_THEME_IDS,
  MOBILE_DEFAULT_THEME_ID,
]);

export type BuiltInThemeId = (typeof BUILT_IN_THEME_IDS)[number];
export type MobileThemeId = (typeof MOBILE_THEME_IDS)[number];
export type ThemeAppearance = "light" | "dark";

export const THEME_COLOR_ROLES = [
  "canvas",
  "chrome",
  "toolbar",
  "toolbarForeground",
  "toolbarBorder",
  "toolbarControl",
  "toolbarControlForeground",
  "toolbarControlHover",
  "surface",
  "surfaceRaised",
  "surfaceOverlay",
  "text",
  "textMuted",
  "border",
  "input",
  "focus",
  "accent",
  "accentForeground",
  "secondary",
  "secondaryForeground",
  "muted",
  "mutedForeground",
  "placeholder",
  "secondaryLabel",
  "iconMuted",
  "error",
  "errorForeground",
  "errorSurface",
  "warning",
  "warningForeground",
  "warningSurface",
  "update",
  "updateForeground",
  "updateSurface",
  "accentSurface",
  "accentSurfaceForeground",
  "messageSurface",
  "messageForeground",
  "messageAction",
  "messageActionForeground",
  "messageActionHover",
  "codeBackground",
  "codeForeground",
  "searchMatchBackground",
  "searchMatchForeground",
  "searchMatchActiveBackground",
  "searchMatchActiveForeground",
  "sidebar",
  "sidebarForeground",
  "sidebarMutedForeground",
  "sidebarControlSurface",
  "sidebarRowHover",
  "sidebarRowActive",
  "sidebarRowSelected",
  "sidebarBorder",
  "terminalBackground",
  "terminalForeground",
  "terminalCursor",
  "terminalSelection",
  "terminalScrollbar",
  "terminalScrollbarHover",
] as const;

export type ThemeColorRole = (typeof THEME_COLOR_ROLES)[number];
export type ThemeColors = Readonly<Record<ThemeColorRole, string>>;
export type ThemeDefinition = Readonly<{
  id: string;
  label: string;
  /** Light themes draw dark ink on light paper; absent means dark. */
  appearance?: ThemeAppearance;
  colors: ThemeColors;
  collection?: Readonly<{ id: string; label: string }>;
  sidebarArtwork?: boolean;
  managed?: boolean;
}>;

export const themeAppearance = (theme: Pick<ThemeDefinition, "appearance">): ThemeAppearance =>
  theme.appearance ?? "dark";

export const T3_CODE_LIGHT_THEME_COLORS: ThemeColors = {
  searchMatchBackground: "#ffde8b",
  searchMatchForeground: "#21180a",
  searchMatchActiveBackground: "#eea52b",
  searchMatchActiveForeground: "#21180a",
  canvas: "#fcfcfc",
  chrome: "#fcfcfc",
  toolbar: "#fcfcfc",
  toolbarForeground: "#27272a",
  toolbarBorder: "#e4e4e7",
  toolbarControl: "#ffffff",
  toolbarControlForeground: "#27272a",
  toolbarControlHover: "#f4f4f5",
  surface: "#ffffff",
  surfaceRaised: "#fcfcfc",
  surfaceOverlay: "#ffffff",
  text: "#27272a",
  textMuted: "#71717b",
  border: "#e4e4e7",
  input: "#d4d4d8",
  focus: "#1b4ed8",
  accent: "#1b4ed8",
  accentForeground: "#ffffff",
  secondary: "#fafafa",
  secondaryForeground: "#27272a",
  muted: "#fafafa",
  mutedForeground: "#71717b",
  placeholder: "#71717b",
  secondaryLabel: "#71717b",
  iconMuted: "#71717b",
  error: "#fb2c36",
  errorForeground: "#c10007",
  errorSurface: "#fcebec",
  warning: "#fe9a00",
  warningForeground: "#a84400",
  warningSurface: "#fcf4e8",
  update: "#1b4ed8",
  updateForeground: "#1b4ed8",
  updateSurface: "#e0e6f7",
  accentSurface: "#f4f4f5",
  accentSurfaceForeground: "#18181b",
  messageSurface: "#f4f4f5",
  messageForeground: "#27272a",
  messageAction: "#1b4ed8",
  messageActionForeground: "#ffffff",
  messageActionHover: "#3160db",
  codeBackground: "#ffffff",
  codeForeground: "#27272a",
  sidebar: "#fafafa",
  sidebarForeground: "#27272a",
  sidebarMutedForeground: "#71717b",
  sidebarControlSurface: "#f4f4f5",
  sidebarRowHover: "#fcfcfc",
  sidebarRowActive: "#ffffff",
  sidebarRowSelected: "#ffffff",
  sidebarBorder: "#e4e4e7",
  terminalBackground: "#fcfcfc",
  terminalForeground: "#27272a",
  terminalCursor: "#26384e",
  terminalSelection: "#d0d6dd",
  terminalScrollbar: "#d6d6d6",
  terminalScrollbarHover: "#bdbdbd",
};

export const T3_CODE_DARK_THEME_COLORS: ThemeColors = {
  searchMatchBackground: "#8c6c1f",
  searchMatchForeground: "#f5f5f5",
  searchMatchActiveBackground: "#eea52b",
  searchMatchActiveForeground: "#21180a",
  canvas: "#0a0a0a",
  chrome: "#0a0a0a",
  toolbar: "#0a0a0a",
  toolbarForeground: "#f5f5f5",
  toolbarBorder: "#191919",
  toolbarControl: "#111111",
  toolbarControlForeground: "#f5f5f5",
  toolbarControlHover: "#141414",
  surface: "#111111",
  surfaceRaised: "#111111",
  surfaceOverlay: "#111111",
  text: "#f5f5f5",
  textMuted: "#818181",
  border: "#191919",
  input: "#1e1e1e",
  focus: "#346bf1",
  accent: "#346bf1",
  accentForeground: "#ffffff",
  secondary: "#111111",
  secondaryForeground: "#f5f5f5",
  muted: "#111111",
  mutedForeground: "#818181",
  placeholder: "#818181",
  secondaryLabel: "#818181",
  iconMuted: "#818181",
  error: "#fb414a",
  errorForeground: "#ff6467",
  errorSurface: "#301214",
  warning: "#fe9a00",
  warningForeground: "#ffb900",
  warningSurface: "#312108",
  update: "#346bf1",
  updateForeground: "#51a2ff",
  updateSurface: "#121b34",
  accentSurface: "#141414",
  accentSurfaceForeground: "#f5f5f5",
  messageSurface: "#141414",
  messageForeground: "#f5f5f5",
  messageAction: "#346bf1",
  messageActionForeground: "#ffffff",
  messageActionHover: "#3061d9",
  codeBackground: "#111111",
  codeForeground: "#f5f5f5",
  sidebar: "#000000",
  sidebarForeground: "#f1f3f7",
  sidebarMutedForeground: "#a3a3a3",
  sidebarControlSurface: "#0a0a0a",
  sidebarRowHover: "#131313",
  sidebarRowActive: "#1a1b1b",
  sidebarRowSelected: "#111111",
  sidebarBorder: "#141414",
  terminalBackground: "#0a0a0a",
  terminalForeground: "#f5f5f5",
  terminalCursor: "#b4cbff",
  terminalSelection: "#343a47",
  terminalScrollbar: "#222222",
  terminalScrollbarHover: "#363636",
};

function editorPalette(
  canvas: string,
  surface: string,
  raised: string,
  border: string,
  accent: string,
): ThemeColors {
  const text = "#eeeeee";
  const muted = "#aaaaaa";
  const accentForeground = "#101010";
  return {
    ...T3_CODE_DARK_THEME_COLORS,
    canvas,
    chrome: canvas,
    toolbar: canvas,
    toolbarForeground: text,
    toolbarBorder: border,
    toolbarControl: surface,
    toolbarControlForeground: text,
    toolbarControlHover: raised,
    surface,
    surfaceRaised: raised,
    surfaceOverlay: raised,
    text,
    textMuted: muted,
    border,
    input: border,
    focus: accent,
    accent,
    accentForeground,
    secondary: surface,
    secondaryForeground: text,
    muted: surface,
    mutedForeground: muted,
    placeholder: muted,
    secondaryLabel: muted,
    iconMuted: muted,
    update: accent,
    updateForeground: accent,
    updateSurface: raised,
    accentSurface: raised,
    accentSurfaceForeground: text,
    messageSurface: raised,
    messageForeground: text,
    messageAction: accent,
    messageActionForeground: accentForeground,
    messageActionHover: accent,
    codeBackground: surface,
    codeForeground: text,
    sidebar: canvas,
    sidebarForeground: text,
    sidebarMutedForeground: muted,
    sidebarControlSurface: surface,
    sidebarRowHover: surface,
    sidebarRowActive: raised,
    sidebarRowSelected: raised,
    sidebarBorder: border,
    terminalBackground: canvas,
    terminalForeground: text,
    terminalCursor: accent,
    terminalSelection: raised,
    terminalScrollbar: border,
    terminalScrollbarHover: muted,
  };
}

/**
 * Near-neutral graphite, so the surround doesn't tint how footage reads, with one blue-violet
 * accent for actions, focus and selection. Chrome (sidebar, panel edges) sits a step below the
 * canvas; hover, overlays and a user turn each get their own step above it.
 */
function stellarPalette(): ThemeColors {
  const tone = {
    chrome: "#0f1012",
    canvas: "#141517",
    surface: "#1b1c1f",
    hover: "#212226",
    raised: "#26272b",
    overlay: "#1f2023",
    border: "#2a2c31",
    input: "#3a3d44",
    text: "#ececee",
    muted: "#a0a3aa",
    accent: "#9ba3ff",
    accentForeground: "#0f1012",
    actionHover: "#aeb4ff",
  };
  return {
    ...editorPalette(tone.canvas, tone.surface, tone.raised, tone.border, tone.accent),
    toolbarForeground: tone.text,
    toolbarControlHover: tone.hover,
    surfaceOverlay: tone.overlay,
    text: tone.text,
    textMuted: tone.muted,
    input: tone.input,
    accentForeground: tone.accentForeground,
    secondaryForeground: tone.text,
    mutedForeground: tone.muted,
    placeholder: tone.muted,
    secondaryLabel: tone.muted,
    iconMuted: tone.muted,
    updateSurface: "#25284a",
    accentSurface: tone.hover,
    accentSurfaceForeground: tone.text,
    messageForeground: tone.text,
    messageActionForeground: tone.accentForeground,
    messageActionHover: tone.actionHover,
    codeForeground: tone.text,
    sidebar: tone.chrome,
    sidebarForeground: tone.text,
    sidebarMutedForeground: tone.muted,
    sidebarControlSurface: tone.surface,
    sidebarRowHover: tone.surface,
    sidebarRowActive: tone.raised,
    sidebarRowSelected: tone.hover,
    terminalForeground: tone.text,
    terminalSelection: "#2f3350",
    terminalScrollbarHover: tone.muted,
  };
}

export const STELLAR_THEME: ThemeDefinition = {
  id: "stellar",
  label: "Stellar",
  colors: stellarPalette(),
};

export const NIGHT_EDIT_THEME: ThemeDefinition = {
  id: "night-edit",
  label: "Night Edit",
  colors: editorPalette("#0d1219", "#171d25", "#252e39", "#3c4755", "#a2bfdc"),
};

export const DARKROOM_THEME: ThemeDefinition = {
  id: "darkroom",
  label: "Darkroom",
  colors: editorPalette("#151310", "#201d18", "#302b23", "#4b4337", "#d8b575"),
};

export const STUDIO_THEME: ThemeDefinition = {
  id: "studio",
  label: "Studio",
  colors: editorPalette("#252525", "#303030", "#3b3b3b", "#555555", "#dedede"),
};

// A field after dark, lit by the screen: blue-black with one lime ink.
export const DRIVE_IN_THEME: ThemeDefinition = {
  id: DEFAULT_THEME_ID,
  label: "Drive-In",
  colors: editorPalette("#070a0e", "#0f131a", "#161b24", "#232a36", "#d0f26a"),
};

/**
 * Light paper with darker inks. Text and muted text are tinted towards the paper's hue so they
 * sit in the picture, and both clear 7:1 and 4.5:1 on every surface; the accent clears 4.5:1 on
 * the canvas and carries white text.
 */
function paperPalette(tone: {
  readonly chrome: string;
  readonly canvas: string;
  readonly surface: string;
  readonly hover: string;
  readonly raised: string;
  readonly border: string;
  readonly input: string;
  readonly text: string;
  readonly muted: string;
  readonly accent: string;
  readonly accentHover: string;
  readonly accentSurface: string;
  readonly selection: string;
}): ThemeColors {
  return {
    ...T3_CODE_LIGHT_THEME_COLORS,
    canvas: tone.canvas,
    chrome: tone.canvas,
    toolbar: tone.canvas,
    toolbarForeground: tone.text,
    toolbarBorder: tone.border,
    toolbarControl: tone.surface,
    toolbarControlForeground: tone.text,
    toolbarControlHover: tone.hover,
    surface: tone.surface,
    surfaceRaised: tone.raised,
    surfaceOverlay: tone.surface,
    text: tone.text,
    textMuted: tone.muted,
    border: tone.border,
    input: tone.input,
    focus: tone.accent,
    accent: tone.accent,
    accentForeground: "#ffffff",
    secondary: tone.surface,
    secondaryForeground: tone.text,
    muted: tone.surface,
    mutedForeground: tone.muted,
    placeholder: tone.muted,
    secondaryLabel: tone.muted,
    iconMuted: tone.muted,
    update: tone.accent,
    updateForeground: tone.accent,
    updateSurface: tone.accentSurface,
    accentSurface: tone.hover,
    accentSurfaceForeground: tone.text,
    messageSurface: tone.raised,
    messageForeground: tone.text,
    messageAction: tone.accent,
    messageActionForeground: "#ffffff",
    messageActionHover: tone.accentHover,
    codeBackground: tone.surface,
    codeForeground: tone.text,
    sidebar: tone.chrome,
    sidebarForeground: tone.text,
    sidebarMutedForeground: tone.muted,
    sidebarControlSurface: tone.surface,
    sidebarRowHover: tone.hover,
    sidebarRowActive: tone.surface,
    sidebarRowSelected: tone.surface,
    sidebarBorder: tone.border,
    terminalBackground: tone.canvas,
    terminalForeground: tone.text,
    terminalCursor: tone.accent,
    terminalSelection: tone.selection,
    terminalScrollbar: tone.border,
    terminalScrollbarHover: tone.muted,
  };
}

// Hanoi at dawn: the rust truss of Long Biên over a pale, misty river.
const LONG_BIEN_THEME: ThemeDefinition = {
  id: "long-bien",
  label: "Long Biên",
  appearance: "light",
  colors: paperPalette({
    chrome: "#efe9df",
    canvas: "#f6f2eb",
    surface: "#fcfaf6",
    hover: "#ece5da",
    raised: "#efe8dd",
    border: "#ddd3c5",
    input: "#c9bcaa",
    text: "#2a211b",
    muted: "#615549",
    accent: "#a3461f",
    accentHover: "#8f3c1a",
    accentSurface: "#f3e1d6",
    selection: "#ecd3c3",
  }),
};

// Cherry branches against a blush sky.
const SAKURA_THEME: ThemeDefinition = {
  id: "sakura",
  label: "Sakura",
  appearance: "light",
  colors: paperPalette({
    chrome: "#f6ecec",
    canvas: "#fcf6f5",
    surface: "#fffcfb",
    hover: "#f3e5e5",
    raised: "#f5e9e8",
    border: "#e8d6d7",
    input: "#d5bcbf",
    text: "#2c1f23",
    muted: "#6b5459",
    accent: "#ad4466",
    accentHover: "#983a59",
    accentSurface: "#f6dfe6",
    selection: "#f0d0db",
  }),
};

// Morning surf on a pale beach.
const SHORE_THEME: ThemeDefinition = {
  id: "shore",
  label: "Shore",
  appearance: "light",
  colors: paperPalette({
    chrome: "#eaf0ef",
    canvas: "#f3f6f5",
    surface: "#fbfcfc",
    hover: "#e3eae9",
    raised: "#e7eeed",
    border: "#d2dddc",
    input: "#b9c9c8",
    text: "#1b2628",
    muted: "#4d5c59",
    accent: "#2d6a80",
    accentHover: "#255a6d",
    accentSurface: "#dbe9ee",
    selection: "#cfe1e7",
  }),
};

// A Hanoi street the railway runs through: ochre walls, green shutters, noon light.
const TRAIN_STREET_THEME: ThemeDefinition = {
  id: "train-street",
  label: "Train Street",
  appearance: "light",
  colors: paperPalette({
    chrome: "#f1eadb",
    canvas: "#f8f3e8",
    surface: "#fdfbf5",
    hover: "#eee6d5",
    raised: "#f0e9da",
    border: "#e0d5bf",
    input: "#cbbd9f",
    text: "#26231a",
    muted: "#625b48",
    accent: "#2e6a4c",
    accentHover: "#265a40",
    accentSurface: "#dceadf",
    selection: "#d2e3d6",
  }),
};

// A clear night far from town: deep indigo, with the galaxy's violet as the one bright ink.
const NEBULA_THEME: ThemeDefinition = {
  id: "nebula",
  label: "Nebula",
  colors: editorPalette("#07061a", "#100e28", "#1a1838", "#2a2850", "#b4a6ff"),
};

export const BUILT_IN_THEMES: ReadonlyArray<ThemeDefinition> = [
  DRIVE_IN_THEME,
  STELLAR_THEME,
  NIGHT_EDIT_THEME,
  DARKROOM_THEME,
  STUDIO_THEME,
  LONG_BIEN_THEME,
  SAKURA_THEME,
  SHORE_THEME,
  TRAIN_STREET_THEME,
  NEBULA_THEME,
];
