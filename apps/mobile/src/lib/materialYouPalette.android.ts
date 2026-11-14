import { getMaterialColors, isDynamicColorAvailable } from "@expo/ui/jetpack-compose";

import type { MaterialYouPalette } from "./materialYouPalette";

export const isSystemColorsAvailable = isDynamicColorAvailable;

export function readSystemColorPalette(): MaterialYouPalette | null {
  return isDynamicColorAvailable ? getMaterialColors({ scheme: "dark" }) : null;
}
