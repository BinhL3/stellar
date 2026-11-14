import { describe, expect, it } from "vite-plus/test";
import {
  BUILT_IN_THEME_IDS,
  BUILT_IN_THEMES,
  STELLAR_THEME,
  T3_CODE_DARK_THEME_COLORS,
  MOBILE_THEME_IDS,
} from "@t3tools/shared/themePalettes";
import {
  readDefaultMobileThemeVariables,
  readGeneratedMobileThemeVariables,
} from "./mobileTheme.test-support";
import { getMobileThemeRuntimeVariables } from "./mobileThemeVariables";
import { getMobileUniwindThemeName } from "./mobileThemeRuntime";

import {
  createMobileThemePatch,
  createMobileThemeVariables,
  DEFAULT_MOBILE_THEME_ID,
  flattenThemeColor,
  getMobileThemeAppearance,
  getMobileThemeVariables,
  resolveMobileThemeId,
  themeColorWithAlpha,
  themeColorToNativeColor,
} from "./mobileTheme";

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

function compositeOver(overlay: string, background: string): string {
  const overlayMatch = /^rgba\((\d+), (\d+), (\d+), ([\d.]+)\)$/.exec(overlay)!;
  const backgroundChannels = background
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16));
  const alpha = Number(overlayMatch[4]);
  const channels = [1, 2, 3].map((index) =>
    Math.round(Number(overlayMatch[index]) * alpha + backgroundChannels[index - 1]! * (1 - alpha)),
  );
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

describe("mobile themes", () => {
  it("declares every runtime theme variable in the static stylesheet", () => {
    const generatedVariables = createMobileThemeVariables(STELLAR_THEME.colors);
    // Uniwind's required "light" theme must carry the dark values, never a light palette.
    expect(readGeneratedMobileThemeVariables("light")).toEqual(readDefaultMobileThemeVariables());
    expect(Object.keys(readDefaultMobileThemeVariables()).sort()).toEqual(
      Object.keys(generatedVariables).sort(),
    );
  });

  it.each(MOBILE_THEME_IDS)("uses the web color roles for %s", (themeId) => {
    const theme = BUILT_IN_THEMES.find((candidate) => candidate.id === themeId);
    const colors = theme?.colors ?? T3_CODE_DARK_THEME_COLORS;
    const variables =
      themeId === DEFAULT_MOBILE_THEME_ID
        ? readDefaultMobileThemeVariables()
        : getMobileThemeVariables(themeId);
    expect(variables["--color-screen"]).toBe(themeColorToNativeColor(colors.canvas));
    expect(variables["--color-thread-canvas"]).toBe(variables["--color-screen"]);
    expect(variables["--color-drawer"]).toBe(themeColorToNativeColor(colors.sidebar));
    expect(variables["--color-thread-hover"]).toBe(themeColorToNativeColor(colors.sidebarRowHover));
    expect(variables["--color-card"]).toBe(themeColorToNativeColor(colors.surface));
    expect(variables["--color-composer-surface"]).toBe(
      themeColorWithAlpha(
        variables["--color-grouped-card"],
        getMobileThemeAppearance(themeId) === "dark" ? 0.9 : 0.94,
      ),
    );
    expect(variables["--color-thread-selected"]).toBe(
      themeColorToNativeColor(colors.sidebarRowActive),
    );
    expect(variables["--color-thread-selected-foreground"]).toBe(
      themeColorToNativeColor(colors.sidebarForeground),
    );
    expect(variables["--color-primary"]).toBe(themeColorToNativeColor(colors.messageAction));
    if (themeId !== DEFAULT_MOBILE_THEME_ID) {
      expect(variables["--color-user-bubble"]).toBe(themeColorToNativeColor(colors.messageSurface));
    }
    expect(
      contrastRatio(variables["--color-foreground"], variables["--color-screen"]),
    ).toBeGreaterThanOrEqual(4.5);
    for (const [foreground, surface] of [
      ["--color-drawer-foreground", "--color-drawer"],
      ["--color-drawer-foreground-muted", "--color-drawer"],
      ["--color-drawer-foreground", "--color-thread-hover"],
      ["--color-drawer-foreground-muted", "--color-thread-hover"],
      ["--color-thread-selected-foreground-muted", "--color-thread-selected"],
      ["--color-primary-foreground", "--color-primary"],
      ["--color-primary-text", "--color-screen"],
      ["--color-primary-text", "--color-card"],
      ["--color-primary-text", "--color-card-alt"],
      ["--color-primary-text", "--color-sheet-solid"],
      ["--color-foreground", "--color-sheet-solid"],
      ["--color-foreground-muted", "--color-sheet-solid"],
      ["--color-primary-text", "--color-grouped-card"],
      ["--color-foreground", "--color-grouped-card"],
      ["--color-foreground-muted", "--color-grouped-card"],
      ["--color-placeholder", "--color-grouped-card"],
      ["--color-secondary-foreground", "--color-secondary"],
      ["--color-user-bubble-foreground", "--color-user-bubble"],
      ["--color-warning-foreground", "--color-warning"],
      ["--color-danger-foreground", "--color-danger"],
      ["--color-md-body", "--color-screen"],
      ["--color-md-strong", "--color-screen"],
      ["--color-md-link", "--color-screen"],
      ["--color-md-code-text", "--color-md-code-bg"],
    ] as const) {
      expect(
        contrastRatio(variables[foreground], variables[surface]),
        `${foreground} on ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    expect(
      contrastRatio(
        variables["--color-thread-selected-foreground"],
        variables["--color-thread-selected"],
      ),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it.each(MOBILE_THEME_IDS)("keeps %s sidebar text readable on Android", (themeId) => {
    const variables = getMobileThemeRuntimeVariables(themeId, "android");
    for (const foreground of [
      "--color-drawer-foreground",
      "--color-drawer-foreground-muted",
    ] as const) {
      expect(
        contrastRatio(variables[foreground], variables["--color-drawer"]),
        `${foreground}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(MOBILE_THEME_IDS)("separates %s filled groups from their sheets", (themeId) => {
    const generated = readGeneratedMobileThemeVariables(getMobileUniwindThemeName(themeId));
    expect(generated).toEqual(getMobileThemeVariables(themeId));
    for (const platform of ["ios", "android"]) {
      const variables = getMobileThemeRuntimeVariables(themeId, platform);
      const sheet = variables["--color-sheet-solid"];
      const group = variables["--color-grouped-card"];
      expect(
        contrastRatio(group, sheet),
        `${platform}: grouped surface on sheet`,
      ).toBeGreaterThanOrEqual(1.025);
      for (const role of [
        "--color-foreground",
        "--color-foreground-secondary",
        "--color-foreground-muted",
        "--color-placeholder",
        "--color-primary-text",
      ] as const) {
        expect(
          contrastRatio(variables[role], group),
          `${platform}: ${role} on grouped surface`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      if (platform === "android") {
        const header = flattenThemeColor(variables["--color-header"], sheet);
        for (const role of ["--color-header-foreground", "--color-foreground-muted"] as const) {
          expect(
            contrastRatio(variables[role], header),
            `${role} on Android header`,
          ).toBeGreaterThanOrEqual(4.5);
        }
        // Only a dark page swallows the card's shadow, so only there must the fill lift it.
        const lifted = getMobileThemeAppearance(themeId) === "dark";
        for (const surface of lifted ? [variables["--color-screen"], header] : []) {
          expect(
            contrastRatio(group, surface),
            `dark grouped surface on Android ${surface}`,
          ).toBeGreaterThanOrEqual(1.2);
        }
      }
      const selected = variables["--color-thread-selected"];
      expect(
        contrastRatio(selected, flattenThemeColor(variables["--color-drawer"], sheet)),
        `${platform}: selected row on drawer`,
      ).toBeGreaterThanOrEqual(1.2);
      for (const role of [
        "--color-thread-selected-foreground",
        "--color-thread-selected-foreground-muted",
      ] as const) {
        expect(
          contrastRatio(variables[role], selected),
          `${platform}: ${role} on selected row`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(
        contrastRatio(variables["--color-foreground-muted"], variables["--color-secondary"]),
        `${platform}: muted label on secondary surface`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the dark theme of preferences saved with a theme per appearance", () => {
    expect(resolveMobileThemeId({})).toBe("drive-in");
    expect(resolveMobileThemeId({ themeId: "borealis" })).toBe("drive-in");
    expect(resolveMobileThemeId({ themeId: "grove" })).toBe("stellar");
    expect(resolveMobileThemeId({ themeId: DEFAULT_MOBILE_THEME_ID })).toBe(
      DEFAULT_MOBILE_THEME_ID,
    );
    const pairedPreferences = {
      themeId: "night-edit",
      lightThemeId: "darkroom",
      darkThemeId: "studio",
    };
    expect(resolveMobileThemeId(pairedPreferences)).toBe("studio");
    expect(resolveMobileThemeId({ themeId: "night-edit", darkThemeId: "missing" })).toBe(
      "drive-in",
    );
    // A new pick must outrank the stored dark theme, which is read first.
    expect(
      resolveMobileThemeId({ ...pairedPreferences, ...createMobileThemePatch("darkroom") }),
    ).toBe("darkroom");
  });

  it("converts OKLCH colors to React Native sRGB ColorValues", () => {
    expect(themeColorToNativeColor("oklch(1 0 0)")).toBe("#ffffff");
    expect(themeColorToNativeColor("oklch(0 0 0)")).toBe("#000000");
    expect(themeColorToNativeColor("#123456")).toBe("#123456");
  });

  it("keeps placeholders and selected-row labels readable on their mobile surfaces", () => {
    for (const themeId of BUILT_IN_THEME_IDS) {
      const variables = getMobileThemeVariables(themeId);
      expect(
        contrastRatio(variables["--color-placeholder"], variables["--color-input"]),
      ).toBeGreaterThanOrEqual(4.5);
    }

    for (const themeId of BUILT_IN_THEME_IDS) {
      const variables = getMobileThemeVariables(themeId);
      expect(
        contrastRatio(
          variables["--color-user-bubble-foreground"],
          variables["--color-user-bubble"],
        ),
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(
          variables["--color-user-bubble-skill-foreground"],
          variables["--color-user-bubble"],
        ),
      ).toBeGreaterThanOrEqual(4.5);
      const fenceSurface = compositeOver(
        variables["--color-md-user-fence-bg"],
        variables["--color-user-bubble"],
      );
      expect(fenceSurface).not.toBe(variables["--color-user-bubble"]);
      expect(
        contrastRatio(variables["--color-md-user-fence-text"], fenceSurface),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the default user bubble readable", () => {
    const variables = readDefaultMobileThemeVariables();
    const bubble = variables["--color-user-bubble"];
    expect(
      contrastRatio(variables["--color-user-bubble-foreground"], bubble),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(variables["--color-user-bubble-skill-foreground"], bubble),
    ).toBeGreaterThanOrEqual(4.5);
    expect(variables["--color-user-bubble-skill-foreground"]).not.toBe(
      variables["--color-user-bubble-foreground"],
    );
    const fenceSurface = compositeOver(variables["--color-md-user-fence-bg"], bubble);
    expect(fenceSurface).not.toBe(bubble);
    expect(
      contrastRatio(variables["--color-md-user-fence-text"], fenceSurface),
    ).toBeGreaterThanOrEqual(4.5);
    const codeSurface = compositeOver(variables["--color-md-user-code-bg"], bubble);
    expect(
      contrastRatio(variables["--color-md-user-code-text"], codeSurface),
    ).toBeGreaterThanOrEqual(4.5);
  });
});
