import { HTML_RENDER_DEFAULT_FONTS, htmlRenderTheme } from "@t3tools/shared/htmlRender";
import { useSyncExternalStore } from "react";

import { appearanceFontStack } from "../appearanceFonts";
import {
  getActiveThemeDefinition,
  getDefaultThemeColors,
  subscribeToCustomThemes,
  themeColorToHex,
} from "../themePalette";
import { useClientSettings } from "./useSettings";
import { useRenderedAppearance, useTheme } from "./useTheme";

export function useHtmlRenderTheme() {
  const { activeTheme } = useTheme();
  // Custom and published palettes can be edited in place, under an unchanged preference.
  const colors = useSyncExternalStore(
    subscribeToCustomThemes,
    () => getActiveThemeDefinition(activeTheme).colors,
    getDefaultThemeColors,
  );
  const sans = useClientSettings((settings) => settings.fontFamilySans);
  const mono = useClientSettings((settings) => settings.fontFamilyCode);
  const appearance = useRenderedAppearance();
  return htmlRenderTheme(
    Object.fromEntries(
      Object.entries(colors).map(([role, color]) => [role, themeColorToHex(color) ?? color]),
    ) as typeof colors,
    {
      sans: appearanceFontStack(sans, HTML_RENDER_DEFAULT_FONTS.sans),
      mono: appearanceFontStack(mono, HTML_RENDER_DEFAULT_FONTS.mono),
    },
    appearance,
  );
}
