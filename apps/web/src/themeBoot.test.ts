import { describe, expect, it, vi } from "vite-plus/test";

import indexHtml from "../index.html?raw";
import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";

import { readThemePreference } from "./hooks/useTheme";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  DEFAULT_THEME_ID,
  getActiveThemeDefinition,
  invalidateCustomThemes,
  LEGACY_THEME_HALVES_STORAGE_KEY,
  NIGHT_EDIT_THEME,
  STELLAR_THEME,
  toCanonicalThemeColor,
} from "./themePalette";

const THEME_STORAGE_KEY = "t3code:theme";

const bootScript = (() => {
  const match = indexHtml.match(/<script>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("Could not find the inline boot script in index.html");
  return match[1];
})();

type BootResult = {
  themeId: string | undefined;
  backgroundColor: string;
  bootVariables: Record<string, string>;
  metaContent: string | null;
};

function runBootScript(options: {
  storage?: Record<string, string>;
  storageThrows?: boolean;
}): BootResult {
  const bootVariables: Record<string, string> = {};
  const meta = {
    content: null as string | null,
    setAttribute(_name: string, value: string) {
      this.content = value;
    },
  };
  const documentElement = {
    dataset: {} as Record<string, string | undefined>,
    style: {
      backgroundColor: "",
      setProperty: (name: string, value: string) => {
        bootVariables[name] = value;
      },
    },
  };
  const fakeDocument = {
    documentElement,
    querySelectorAll: (selector: string) => (selector === 'meta[name="theme-color"]' ? [meta] : []),
  };
  const fakeWindow = {
    localStorage: {
      getItem: (key: string): string | null => {
        if (options.storageThrows) throw new Error("storage blocked");
        return options.storage?.[key] ?? null;
      },
    },
    // A light OS: the boot script must not ask, and must not follow it if it does.
    matchMedia: () => ({ matches: false }),
  };

  const fakeCss = {
    supports: (property: string, value: string) =>
      property === "color" && toCanonicalThemeColor(value) !== null,
  };

  new Function("window", "document", "CSS", bootScript)(fakeWindow, fakeDocument, fakeCss);

  return {
    themeId: documentElement.dataset.themeId,
    backgroundColor: documentElement.style.backgroundColor,
    bootVariables,
    metaContent: meta.content,
  };
}

function runtimeThemeId(storage: Record<string, string>): string {
  vi.stubGlobal("window", {
    localStorage: { getItem: (key: string) => storage[key] ?? null },
  });
  invalidateCustomThemes();
  try {
    return getActiveThemeDefinition(readThemePreference()).id;
  } finally {
    vi.unstubAllGlobals();
    invalidateCustomThemes();
  }
}

const AURORA_LIGHT_WITH_DARK_VARIANT = {
  id: "aurora",
  label: "Aurora",
  appearance: "light",
  colors: { canvas: "#f8fbff", text: "#10243d", accent: "#5b6cff" },
  variants: { dark: { canvas: "#101827", text: "#eef5ff", accent: "#7c93ff" } },
};
const PAPER_LIGHT_ONLY = {
  id: "paper",
  label: "Paper",
  appearance: "light",
  colors: { canvas: "#f8fbff", text: "#10243d", accent: "#5b6cff" },
};
const CHARCOAL = {
  id: "charcoal",
  label: "Charcoal",
  appearance: "dark",
  colors: { canvas: "#1c1210", text: "#ffe8d9", accent: "#ff7a45" },
};
const CUSTOM_THEMES = JSON.stringify([AURORA_LIGHT_WITH_DARK_VARIANT, PAPER_LIGHT_ONLY, CHARCOAL]);

describe("index.html boot script", () => {
  const parityCases: ReadonlyArray<{
    name: string;
    storage: Record<string, string>;
    themeId: string;
  }> = [
    { name: "no stored preference", storage: {}, themeId: DEFAULT_THEME_ID },
    ...["system", "light", "dark"].map((retired) => ({
      name: `the retired "${retired}" preference`,
      storage: {
        [THEME_STORAGE_KEY]: retired,
        "t3code:theme-appearance-mode": "light",
        "t3code:theme-follow-system": "true",
      },
      themeId: DEFAULT_THEME_ID,
    })),
    {
      name: "a built-in stays selected under a stored light mode",
      storage: { [THEME_STORAGE_KEY]: "studio", "t3code:theme-appearance-mode": "light" },
      themeId: "studio",
    },
    {
      name: "a legacy theme id resolves through its alias",
      storage: { [THEME_STORAGE_KEY]: "t3-chat-dark" },
      themeId: "stellar",
    },
    {
      name: "a renamed built-in resolves to its new id",
      storage: { [THEME_STORAGE_KEY]: "borealis" },
      themeId: "drive-in",
    },
    {
      name: "a light custom theme with a dark variant",
      storage: { [THEME_STORAGE_KEY]: "aurora", [CUSTOM_THEMES_STORAGE_KEY]: CUSTOM_THEMES },
      themeId: "aurora",
    },
    {
      name: "a light-only custom theme",
      storage: { [THEME_STORAGE_KEY]: "paper", [CUSTOM_THEMES_STORAGE_KEY]: CUSTOM_THEMES },
      themeId: DEFAULT_THEME_ID,
    },
    {
      name: "a dark custom theme",
      storage: { [THEME_STORAGE_KEY]: "charcoal", [CUSTOM_THEMES_STORAGE_KEY]: CUSTOM_THEMES },
      themeId: "charcoal",
    },
    {
      name: "a removed custom theme",
      storage: { [THEME_STORAGE_KEY]: "gone-theme" },
      themeId: DEFAULT_THEME_ID,
    },
    {
      name: "the dark half of a retired pairing",
      storage: {
        [THEME_STORAGE_KEY]: "studio",
        [LEGACY_THEME_HALVES_STORAGE_KEY]: JSON.stringify({
          light: "darkroom",
          dark: "night-edit",
        }),
      },
      themeId: NIGHT_EDIT_THEME.id,
    },
    {
      name: "a retired pairing with only a light half",
      storage: {
        [THEME_STORAGE_KEY]: "studio",
        [LEGACY_THEME_HALVES_STORAGE_KEY]: JSON.stringify({ light: "darkroom" }),
      },
      themeId: "studio",
    },
  ];

  it.each(parityCases)("resolves like the runtime: $name", ({ storage, themeId }) => {
    expect(runBootScript({ storage }).themeId).toBe(themeId);
    expect(runtimeThemeId(storage)).toBe(themeId);
  });

  it("paints the dark variant of a stored light theme", () => {
    const boot = runBootScript({
      storage: { [THEME_STORAGE_KEY]: "aurora", [CUSTOM_THEMES_STORAGE_KEY]: CUSTOM_THEMES },
    });
    expect(boot.bootVariables["--boot-background"]).toBe(
      AURORA_LIGHT_WITH_DARK_VARIANT.variants.dark.canvas,
    );
  });

  it("accepts exponent-form OKLCH before the runtime mounts", () => {
    const colors = {
      canvas: "oklch(1.5e-1 1e-2 2.8e2)",
      chrome: "oklch(1.4e-1 1e-2 2.8e2)",
      text: "oklch(9e-1 0 0 / 9e-1)",
      accent: "oklch(6.2e-1 0.2 2.8e2)",
    };
    const boot = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "scientific",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([
          { id: "scientific", label: "Scientific", colors },
        ]),
      },
    });

    expect(boot.bootVariables["--boot-background"]).toBe(colors.canvas);
    expect(boot.bootVariables["--boot-foreground"]).toBe(colors.text);
    expect(boot.bootVariables["--boot-accent"]).toBe(colors.accent);
    expect(boot.backgroundColor).toBe(colors.chrome);
    expect(boot.metaContent).toBe(colors.chrome);
  });

  it("keeps every built-in boot splash in sync with the real palettes", () => {
    for (const theme of BUILT_IN_THEMES) {
      const boot = runBootScript({ storage: { [THEME_STORAGE_KEY]: theme.id } });
      expect(boot.themeId).toBe(theme.id);
      expect(boot.bootVariables["--boot-background"]).toBe(theme.colors.canvas);
      expect(boot.bootVariables["--boot-foreground"]).toBe(theme.colors.text);
      expect(boot.bootVariables["--boot-accent"]).toBe(theme.colors.accent);
      expect(boot.backgroundColor).toBe(theme.colors.chrome);
      expect(boot.metaContent).toBe(theme.colors.chrome);
    }
  });

  it("uses runtime defaults for malformed custom roles", () => {
    const boot = runBootScript({
      storage: {
        [THEME_STORAGE_KEY]: "partial",
        [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([
          {
            id: "partial",
            label: "Partial",
            appearance: "dark",
            colors: { canvas: "not-a-color", text: "#fffaff", accent: "nope" },
          },
        ]),
      },
    });

    expect(boot.themeId).toBe("partial");
    expect(boot.bootVariables["--boot-background"]).toBe(STELLAR_THEME.colors.canvas);
    expect(boot.bootVariables["--boot-foreground"]).toBe("#fffaff");
    expect(boot.bootVariables["--boot-accent"]).toBe(STELLAR_THEME.colors.accent);
    expect(boot.backgroundColor).toBe(STELLAR_THEME.colors.chrome);
    expect(boot.metaContent).toBe(STELLAR_THEME.colors.chrome);
  });

  it("paints the default theme when storage is unavailable", () => {
    const boot = runBootScript({ storageThrows: true });
    expect(boot.themeId).toBe(DEFAULT_THEME_ID);
    expect(boot.bootVariables["--boot-background"]).toBe(BUILT_IN_THEMES[0]!.colors.canvas);
  });

  it("ships the dark class in the markup instead of resolving an appearance", () => {
    expect(indexHtml).toMatch(/<html lang="en" class="dark">/);
    expect(bootScript).not.toContain("prefers-color-scheme");
  });
});
