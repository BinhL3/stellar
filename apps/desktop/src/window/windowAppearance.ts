import type { DesktopWindowAppearance } from "@t3tools/contracts";
import type * as Electron from "electron";

export const DEFAULT_WINDOW_APPEARANCE: DesktopWindowAppearance = {
  appearance: "dark",
  background: "#000000",
};

export const titleBarSymbolColor = (appearance: DesktopWindowAppearance["appearance"]) =>
  appearance === "light" ? "#1f2937" : "#f8fafc";

/** Repaints a live main window for a theme change; macOS draws its own traffic lights. */
export function syncWindowAppearance(
  window: Electron.BrowserWindow,
  windowAppearance: DesktopWindowAppearance,
  platform: NodeJS.Platform,
): void {
  if (window.isDestroyed()) return;
  window.setBackgroundColor(windowAppearance.background);
  if (platform !== "darwin") {
    window.setTitleBarOverlay({ symbolColor: titleBarSymbolColor(windowAppearance.appearance) });
  }
}
