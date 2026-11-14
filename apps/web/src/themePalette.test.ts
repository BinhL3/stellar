import { describe, expect, it, vi } from "vite-plus/test";
import { converter } from "culori/fn";
import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";

import { CONTEXT_CHIP_ACCENTS, contextChipColorVariable } from "./lib/contextChipAccents";

import {
  contextChipVariables,
  getActiveThemeDefinition,
  getThemeDefinition,
  isReservedThemeId,
  legacyDarkThemeHalf,
  getCustomThemes,
  getStoredCustomThemeCollection,
  invalidateCustomThemes,
  installCustomTheme,
  parseThemeFile,
  removeCustomTheme,
  replaceCustomThemeCollection,
  serializeThemeFile,
  updateCustomTheme,
  updateThemeColorFamily,
  CUSTOM_THEMES_STORAGE_KEY,
  createVividThemeColors,
  getDefaultThemeColors,
  themeColorToHex,
  toCanonicalThemeColor,
  THEME_FILE_VERSION,
} from "./themePalette";

function asHex(value: string): string {
  const hex = themeColorToHex(value);
  if (!hex) throw new Error(`Expected a theme color, received ${value}`);
  return hex.slice(0, 7);
}

function canonical(value: string): string {
  const color = toCanonicalThemeColor(value);
  if (!color) throw new Error(`Expected a theme color, received ${value}`);
  return color;
}

function contrastRatio(first: string, second: string): number {
  const toRgb = (value: string) => {
    const hex = asHex(value).slice(1);
    return [0, 1, 2].map(
      (channel) => Number.parseInt(hex.slice(channel * 2, channel * 2 + 2), 16) / 255,
    );
  };
  const luminance = (value: string) =>
    toRgb(value)
      .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4))
      .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
  const lighter = Math.max(luminance(first), luminance(second));
  const darker = Math.min(luminance(first), luminance(second));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("theme files", () => {
  it("migrates removed presets and retired pairings without capturing custom themes", () => {
    for (const id of [
      "t3-code",
      "t3-chat",
      "t3-chat-dark",
      "grove",
      "ocean",
      "ember",
      "iris",
      "t3-grove",
      "t3-ocean",
      "t3-ember",
      "t3-iris",
    ]) {
      expect(getThemeDefinition(id)?.id).toBe("stellar");
      expect(legacyDarkThemeHalf(JSON.stringify({ light: "studio", dark: id }))).toBe("stellar");
    }
    expect(legacyDarkThemeHalf(JSON.stringify({ light: "studio" }))).toBeNull();
    expect(legacyDarkThemeHalf(JSON.stringify({ dark: "my-custom-theme" }))).toBeNull();
    expect(legacyDarkThemeHalf("{ not json")).toBeNull();
    expect(getThemeDefinition("my-custom-theme")).toBeNull();
    for (const retired of ["system", "light", "dark", "my-custom-theme"]) {
      expect(getActiveThemeDefinition(retired).id).toBe("drive-in");
    }
    for (const id of ["borealis", "drive-in"]) {
      expect(getThemeDefinition(id)?.id).toBe("drive-in");
      expect(isReservedThemeId(id)).toBe(true);
    }
  });

  it("keeps small text readable in every Stellar palette", () => {
    for (const theme of BUILT_IN_THEMES) {
      expect(theme.sidebarArtwork).not.toBe(true);
      const colors = theme.colors;
      for (const surface of [colors.canvas, colors.surface, colors.surfaceRaised]) {
        expect(contrastRatio(colors.text, surface)).toBeGreaterThanOrEqual(7);
        expect(contrastRatio(colors.textMuted, surface)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(colors.accent, colors.accentForeground)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("gives non-Latin theme names distinct stable ids", () => {
    const file = {
      version: THEME_FILE_VERSION,
      appearance: "dark",
      colors: { canvas: "#101820" },
    };
    const night = parseThemeFile({ ...file, name: "夜" });
    expect(parseThemeFile({ ...file, name: "朝" }).id).not.toBe(night.id);
    expect(parseThemeFile({ ...file, name: " 夜 " }).id).toBe(night.id);
  });

  it("keeps built-in and standard search pairs readable and distinct from inline code", () => {
    const toOklab = converter("oklab");
    const distance = (first: string, second: string) => {
      const a = toOklab(first)!;
      const b = toOklab(second)!;
      return Math.hypot(a.l - b.l, a.a - b.a, a.b - b.b);
    };
    const palettes = [getDefaultThemeColors(), ...BUILT_IN_THEMES.map((theme) => theme.colors)];
    for (const colors of palettes) {
      expect(
        contrastRatio(colors.searchMatchForeground, colors.searchMatchBackground),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(colors.searchMatchActiveForeground, colors.searchMatchActiveBackground),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        distance(colors.searchMatchBackground, colors.searchMatchActiveBackground),
      ).toBeGreaterThan(0.14);
      for (const background of [colors.muted, colors.messageSurface, colors.codeBackground]) {
        expect(distance(colors.searchMatchBackground, background)).toBeGreaterThan(0.08);
        expect(distance(colors.searchMatchActiveBackground, background)).toBeGreaterThan(0.08);
      }
    }
  });

  it("round-trips custom search colours and fills them in for older theme files", () => {
    const legacy = parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Legacy",
      appearance: "dark",
      colors: { canvas: "#101010" },
    });
    expect(legacy.colors.searchMatchBackground).toBe(getDefaultThemeColors().searchMatchBackground);
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Search",
      appearance: "dark",
      colors: {
        searchMatchBackground: "#224466",
        searchMatchForeground: "#ffffff",
        searchMatchActiveBackground: "#aaddff",
        searchMatchActiveForeground: "#112233",
      },
    });
    const restored = parseThemeFile(JSON.parse(serializeThemeFile(theme)));
    expect(restored.colors).toEqual(theme.colors);
  });

  it.each(["searchMatchBackground", "searchMatchActiveBackground"] as const)(
    "editing %s derives readable text without changing the other match or warning colours",
    (role) => {
      const original = getDefaultThemeColors();
      const foreground =
        role === "searchMatchBackground" ? "searchMatchForeground" : "searchMatchActiveForeground";
      for (const value of ["#ffffff", "#000000", "#33669980"]) {
        const updated = updateThemeColorFamily(original, role, value);
        expect(contrastRatio(updated[foreground], updated[role])).toBeGreaterThanOrEqual(4.5);
        for (const key of Object.keys(original) as Array<keyof typeof original>) {
          if (key !== role && key !== foreground) expect(updated[key]).toBe(original[key]);
        }
      }
    },
  );

  it("derives readable, distinctive vivid palettes from exact seeds", () => {
    // The editor does not hold a canvas to a dark value, so bright seeds must stay readable too.
    const seeds: ReadonlyArray<[string, string]> = [
      ["#f4f9f2", "#1d8a4e"],
      ["#101a2c", "#4f8fe8"],
      ["#211a23", "#df5398"],
      ["#fdf6ec", "#c2571b"],
      ["#111827", "#8ab4f8"],
      ["#f5ecf5", "#a84370"],
    ];
    const channels = (value: string) =>
      [1, 3, 5].map((index) => Number.parseInt(asHex(value).slice(index, index + 2), 16)) as [
        number,
        number,
        number,
      ];
    for (const [canvas, accent] of seeds) {
      const colors = createVividThemeColors(canvas, accent);
      expect(colors.canvas).toMatch(/^oklch\(/);
      expect(colors.accent).toMatch(/^oklch\(/);
      expect(asHex(colors.canvas)).toBe(canvas);
      expect(asHex(colors.accent)).toBe(accent);
      expect(contrastRatio(colors.text, colors.canvas)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(colors.textMuted, colors.canvas)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.textMuted, colors.canvas)).toBeLessThan(5.5);
      expect(contrastRatio(colors.mutedForeground, colors.muted)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.mutedForeground, colors.muted)).toBeLessThan(
        contrastRatio(colors.text, colors.muted),
      );
      expect(contrastRatio(colors.placeholder, colors.surfaceRaised)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.placeholder, colors.surfaceRaised)).toBeLessThan(
        contrastRatio(colors.text, colors.surfaceRaised),
      );
      expect(colors.secondaryLabel).toBe(colors.textMuted);
      expect(contrastRatio(colors.accentForeground, colors.accent)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(colors.searchMatchForeground, colors.searchMatchBackground),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(colors.searchMatchActiveForeground, colors.searchMatchActiveBackground),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(colors.messageActionForeground, colors.messageAction),
      ).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.messageForeground, colors.messageSurface)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(colors.secondaryForeground, colors.secondary)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(colors.sidebarForeground, colors.sidebar)).toBeGreaterThanOrEqual(4.5);
      expect(colors.messageAction).not.toBe(colors.accent);
      expect(asHex(colors.update)).toBe(accent);
      const [errorRed, errorGreen, errorBlue] = channels(colors.error);
      expect(errorRed).toBeGreaterThan(errorGreen * 2);
      expect(errorRed).toBeGreaterThan(errorBlue * 2);
      expect(contrastRatio(colors.error, "#ffffff")).toBeGreaterThanOrEqual(2.5);
      expect(contrastRatio(colors.errorForeground, colors.errorSurface)).toBeGreaterThanOrEqual(
        4.5,
      );
      const [warnRed, warnGreen, warnBlue] = channels(colors.warning);
      expect(warnRed).toBeGreaterThan(warnBlue);
      expect(warnGreen).toBeGreaterThan(warnBlue);
    }
  });

  it("decodes literal CSS color formats into OKLCH without dropping alpha", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Translucent",
      colors: {
        canvas: "oklch(62% 0.2 280deg / 50%)",
        accent: "#abcd",
        focus: "rgb(10 20 30 / 50%)",
        error: "hsl(350 80% 50%)",
        warning: "hwb(45 10% 20%)",
        update: "lab(60% 40 30)",
        messageAction: "lch(60% 50 120)",
        sidebar: "oklab(0.6 0.1 -0.1)",
        terminalCursor: "color(display-p3 0.8 0.2 0.3)",
        terminalSelection: "rebeccapurple",
        terminalScrollbar: "transparent",
        terminalScrollbarHover: "rgb(10 20 30 / none)",
      },
    });

    expect(theme.colors.canvas).toBe("oklch(0.62 0.2 280 / 0.5)");
    expect(theme.colors.accent).toBe(canonical("#abcd"));
    expect(themeColorToHex(theme.colors.accent)).toBe("#aabbccdd");
    expect(themeColorToHex(theme.colors.focus)).toBe("#0a141e80");
    expect(themeColorToHex(theme.colors.terminalSelection)).toBe("#663399");
    expect(theme.colors.terminalScrollbar).toBe("oklch(0 0 0 / 0)");
    expect(themeColorToHex(theme.colors.terminalScrollbarHover)).toBe("#0a141e00");
    for (const role of [
      "error",
      "warning",
      "update",
      "messageAction",
      "sidebar",
      "terminalCursor",
    ] as const) {
      expect(theme.colors[role]).toMatch(/^oklch\(/);
    }
  });

  it("gamut maps extreme finite OKLCH chroma from theme files", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Extreme chroma",
      colors: { accent: "oklch(0.5 1e303 0)" },
    });

    expect(theme.colors.accent).toBe("oklch(0.5 1e+303 0)");
    expect(themeColorToHex(theme.colors.accent)).toBe("#b5005e");
  });

  it("reads the dark palette of a file with both, and a light-only file as a light theme", () => {
    const file = {
      version: THEME_FILE_VERSION,
      id: "aurora",
      name: "Aurora",
      appearance: "light",
      colors: { canvas: "#f8fbff", text: "#10243d" },
    };
    const theme = parseThemeFile({
      ...file,
      variants: { dark: { canvas: "#101827", text: "#eef5ff" } },
    });

    expect(theme.colors).toMatchObject({
      canvas: canonical("#101827"),
      text: canonical("#eef5ff"),
    });
    expect(theme).not.toHaveProperty("variants");
    const serialized = JSON.parse(serializeThemeFile(theme));
    expect(serialized.appearance).toBe("dark");
    expect(serialized).not.toHaveProperty("variants");
    expect(parseThemeFile(serialized).colors).toEqual(theme.colors);

    const light = parseThemeFile(file);
    expect(light).toMatchObject({ appearance: "light", colors: { canvas: canonical("#f8fbff") } });
    expect(JSON.parse(serializeThemeFile(light)).appearance).toBe("light");
    expect(
      parseThemeFile({
        ...file,
        appearance: "dark",
        variants: { light: { canvas: "#ffffff" } },
      }).colors.canvas,
    ).toBe(canonical("#f8fbff"));
  });

  it("preserves valid imported-theme collections and drops malformed metadata", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) =>
          key === CUSTOM_THEMES_STORAGE_KEY
            ? JSON.stringify([
                {
                  id: "github-dark",
                  label: "GitHub Dark",
                  appearance: "dark",
                  colors: { canvas: "#0d1117" },
                  collection: { id: "open-vsx:github.github-vscode-theme", label: "GitHub Theme" },
                },
                {
                  id: "github-light",
                  label: "GitHub Light",
                  appearance: "dark",
                  colors: { canvas: "#ffffff" },
                  collection: { id: "bad collection id", label: "GitHub Theme" },
                },
              ])
            : null,
      },
    });

    invalidateCustomThemes();
    expect(getCustomThemes()).toMatchObject([
      { collection: { id: "open-vsx:github.github-vscode-theme", label: "GitHub Theme" } },
      { id: "github-light" },
    ]);
    expect(getCustomThemes()[1]).not.toHaveProperty("collection");

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });

  it("atomically replaces an imported collection and removes stale variants", () => {
    const collection = { id: "open-vsx:demo.theme", label: "Demo Theme" };
    const personalTheme = {
      id: "personal",
      label: "Personal",
      appearance: "dark",
      colors: { canvas: "#111111", futureRole: "hsl(10 20% 30%)" },
      futureMetadata: { version: 2 },
    };
    const stored = new Map<string, string>([
      [
        CUSTOM_THEMES_STORAGE_KEY,
        JSON.stringify([
          personalTheme,
          {
            id: "old-light",
            label: "Old Light",
            appearance: "dark",
            colors: { canvas: "#ffffff" },
            collection,
          },
          {
            id: "removed-dark",
            label: "Removed Dark",
            appearance: "dark",
            colors: { canvas: "#000000" },
            collection,
          },
        ]),
      ],
    ]);
    const setItem = vi.fn((key: string, value: string) => stored.set(key, value));
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem,
      },
    });

    invalidateCustomThemes();
    const expectedCollection = getStoredCustomThemeCollection(collection.id);
    getCustomThemes();
    const concurrentlyAddedTheme = {
      id: "other-tab",
      label: "Other Tab",
      appearance: "dark",
      colors: { canvas: "#222222" },
    };
    stored.set(
      CUSTOM_THEMES_STORAGE_KEY,
      JSON.stringify([
        ...JSON.parse(stored.get(CUSTOM_THEMES_STORAGE_KEY) ?? "[]"),
        concurrentlyAddedTheme,
      ]),
    );
    const replacement = [
      {
        ...parseThemeFile({
          version: THEME_FILE_VERSION,
          id: "old-light",
          name: "New Light",
          appearance: "dark",
          colors: { canvas: "#fafafa" },
        }),
        collection,
      },
      {
        ...parseThemeFile({
          version: THEME_FILE_VERSION,
          id: "new-dark",
          name: "New Dark",
          appearance: "dark",
          colors: { canvas: "#101010" },
        }),
        collection,
      },
    ];

    expect(
      replaceCustomThemeCollection(collection.id, replacement, { expectedCollection }),
    ).toEqual(replacement);
    expect(getCustomThemes().map((theme) => theme.id)).toEqual([
      "personal",
      "old-light",
      "new-dark",
      "other-tab",
    ]);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(stored.get(CUSTOM_THEMES_STORAGE_KEY) ?? "[]")[0]).toEqual(personalTheme);

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });

  it("canonicalizes explicit writes without migrating untouched themes", () => {
    const stored = new Map<string, string>();
    const untouchedTheme = {
      id: "legacy",
      label: "Legacy",
      appearance: "dark",
      colors: { accent: "#5b6cff", futureRole: "hsl(10 20% 30%)" },
      futureMetadata: { version: 2 },
    };
    stored.set(CUSTOM_THEMES_STORAGE_KEY, JSON.stringify([untouchedTheme]));
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });

    invalidateCustomThemes();
    const createdTheme = installCustomTheme(
      parseThemeFile({
        version: THEME_FILE_VERSION,
        id: "aurora",
        name: "Aurora",
        appearance: "dark",
        colors: { canvas: "#f8fbff", accent: "#5b6cff" },
        sidebarArtwork: true,
      }),
    );
    const updatedTheme = updateCustomTheme({
      ...createdTheme,
      label: "Aurora Night",
      colors: { ...createdTheme.colors, accent: "hsl(263 70% 58%)" },
    });

    expect(updatedTheme).toMatchObject({
      id: "aurora",
      label: "Aurora Night",
      colors: { accent: canonical("hsl(263 70% 58%)") },
    });
    expect(updatedTheme).not.toHaveProperty("sidebarArtwork");
    const storedThemes = JSON.parse(stored.get(CUSTOM_THEMES_STORAGE_KEY) ?? "[]");
    expect(storedThemes[0]).toEqual(untouchedTheme);
    expect(storedThemes[1]).toMatchObject({
      id: "aurora",
      label: "Aurora Night",
      colors: { accent: canonical("hsl(263 70% 58%)") },
    });
    expect(storedThemes[1]).not.toHaveProperty("sidebarArtwork");
    invalidateCustomThemes();
    expect(getCustomThemes().find((theme) => theme.id === "aurora")).toMatchObject({
      id: "aurora",
      colors: { accent: canonical("hsl(263 70% 58%)") },
    });
    removeCustomTheme("aurora");
    expect(JSON.parse(stored.get(CUSTOM_THEMES_STORAGE_KEY) ?? "[]")).toEqual([untouchedTheme]);

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });

  it("writes from the cached raw snapshot without risking a destructive reread", () => {
    const legacyTheme = {
      id: "legacy",
      label: "Legacy",
      appearance: "dark",
      colors: { accent: "#5b6cff" },
      futureMetadata: true,
    };
    let storedThemes = JSON.stringify([legacyTheme]);
    let readCount = 0;
    const setItem = vi.fn((_key: string, value: string) => {
      storedThemes = value;
    });
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          readCount += 1;
          if (readCount > 1) throw new Error("transient read failure");
          return storedThemes;
        },
        setItem,
      },
    });

    invalidateCustomThemes();
    expect(getCustomThemes()).toHaveLength(1);
    installCustomTheme(
      parseThemeFile({
        version: THEME_FILE_VERSION,
        id: "aurora",
        name: "Aurora",
        appearance: "dark",
        colors: { accent: "hsl(263 70% 58%)" },
      }),
    );

    expect(readCount).toBe(1);
    expect(setItem).toHaveBeenCalledOnce();
    expect(JSON.parse(storedThemes)[0]).toEqual(legacyTheme);

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });

  it("refuses to overwrite a theme library that could not be read", () => {
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () => {
          throw new Error("storage unavailable");
        },
        setItem,
      },
    });

    invalidateCustomThemes();
    expect(getCustomThemes()).toEqual([]);
    expect(() =>
      installCustomTheme(
        parseThemeFile({
          version: THEME_FILE_VERSION,
          id: "aurora",
          name: "Aurora",
          appearance: "dark",
          colors: { accent: "#5b6cff" },
        }),
      ),
    ).toThrow(`Failed to read the theme library from ${CUSTOM_THEMES_STORAGE_KEY}.`);
    expect(setItem).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    invalidateCustomThemes();
  });
});

describe("context chip colors", () => {
  it.each([
    ["#ffffff", 5],
    ["#777777", 4.5],
  ] as const)(
    "chooses readable chip lightness on %s when the text is medium gray",
    (surface, minimum) => {
      const colors = {
        ...getDefaultThemeColors(),
        canvas: surface,
        surface,
        surfaceRaised: surface,
        messageSurface: surface,
        text: "#767676",
        messageForeground: "#767676",
      };
      for (const color of Object.values(contextChipVariables(colors))) {
        expect(contrastRatio(color, surface)).toBeGreaterThanOrEqual(minimum);
      }
    },
  );

  const toOklch = converter("oklch");
  const toRgb = converter("rgb");
  // Surfaces stay unrounded, as CSS paints them; the chip is the 8-bit hex the solver returns.
  const paintedContrastRatio = (chip: string, surface: string, canvas: string) => {
    const channels = (value: string) => {
      const rgb = toRgb(value)!;
      return [rgb.r, rgb.g, rgb.b].map((channel) => Math.min(1, Math.max(0, channel)));
    };
    const back = channels(canvas);
    const alpha = toRgb(surface)!.alpha ?? 1;
    const painted = channels(surface).map(
      (channel, index) => back[index]! * (1 - alpha) + channel * alpha,
    );
    const luminance = (rgb: number[]) =>
      rgb
        .map((channel) =>
          channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
        )
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
    const first = luminance(channels(asHex(chip)));
    const second = luminance(painted);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  };
  const palettes = [getDefaultThemeColors(), ...BUILT_IN_THEMES.map((theme) => theme.colors)];

  it("reads at 5:1 on every chip surface of every built-in theme and keeps each hue", () => {
    for (const colors of palettes) {
      const variables = contextChipVariables(colors);
      expect(variables["--context-chip-message"]).toBeUndefined();
      for (const [kind, accent] of Object.entries(CONTEXT_CHIP_ACCENTS)) {
        const chip =
          variables[contextChipColorVariable(kind as keyof typeof CONTEXT_CHIP_ACCENTS)]!;
        for (const surface of [
          colors.canvas,
          colors.surface,
          colors.surfaceRaised,
          colors.messageSurface,
        ]) {
          expect(paintedContrastRatio(chip, surface, colors.canvas)).toBeGreaterThanOrEqual(5);
        }
        const solved = toOklch(chip)!;
        if ((solved.c ?? 0) > 0.04) {
          const drift = Math.abs((((solved.h ?? 0) - toOklch(accent)!.h! + 540) % 360) - 180);
          expect(drift).toBeLessThan(4);
        }
      }
    }
  });

  it("solves the invalid state's error color to 5:1 on every chip surface", () => {
    for (const colors of palettes) {
      const invalid = contextChipVariables(colors)["--context-chip-invalid"];
      expect(invalid).toBeDefined();
      for (const surface of [
        colors.canvas,
        colors.surface,
        colors.surfaceRaised,
        colors.messageSurface,
      ]) {
        expect(paintedContrastRatio(invalid!, surface, colors.canvas)).toBeGreaterThanOrEqual(5);
      }
    }
  });

  it("leaves a bubble with opposite-shade text out of the shared solve", () => {
    const colors = {
      ...getDefaultThemeColors(),
      messageSurface: "#dbe4ff",
      messageForeground: "#101010",
    };
    const variables = contextChipVariables(colors);
    expect(variables["--context-chip-message"]).toBe("#101010");
    for (const kind of Object.keys(CONTEXT_CHIP_ACCENTS) as Array<
      keyof typeof CONTEXT_CHIP_ACCENTS
    >) {
      expect(
        contrastRatio(variables[contextChipColorVariable(kind)]!, colors.canvas),
      ).toBeGreaterThanOrEqual(5);
    }
    expect(toOklch(variables[contextChipColorVariable("file")])!.c).toBeGreaterThan(0.08);
  });
});

describe("stored theme preferences", () => {
  it("reads the dark palette of stored themes, keeps light-only ones light, and never writes on read", () => {
    const storedThemes = JSON.stringify([
      {
        id: "aurora",
        label: "Aurora",
        appearance: "light",
        colors: { canvas: "#f8fbff" },
        variants: {
          dark: { canvas: "rgb(16 24 39)", futureRole: "#123456", accent: "not-a-color" },
        },
      },
      { id: "paper", label: "Paper", appearance: "light", colors: { canvas: "#f8fbff" } },
      { id: "charcoal", label: "Charcoal", colors: { canvas: "#1c1210" } },
      { id: "light", label: "Reserved", appearance: "dark", colors: {} },
      { id: "aurora", label: "Duplicate", appearance: "dark", colors: {} },
    ]);
    const stored = new Map([[CUSTOM_THEMES_STORAGE_KEY, storedThemes]]);
    const setItem = vi.fn((key: string, value: string) => stored.set(key, value));
    vi.stubGlobal("window", {
      localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem },
    });
    invalidateCustomThemes();
    try {
      const themes = getCustomThemes();
      expect(themes.map((theme) => theme.id)).toEqual(["aurora", "paper", "charcoal"]);
      expect(themes.map((theme) => theme.appearance)).toEqual([undefined, "light", undefined]);
      expect(themes[0]!.colors).toMatchObject({
        canvas: canonical("rgb(16 24 39)"),
        accent: getDefaultThemeColors().accent,
      });
      expect(themes[0]).not.toHaveProperty("variants");
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      invalidateCustomThemes();
    }
  });
});
