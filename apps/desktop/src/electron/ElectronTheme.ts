import type { DesktopWindowAppearance } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

/** Native menus, dialogs and web contents follow the active theme, never the OS scheme. */
export class ElectronTheme extends Context.Service<
  ElectronTheme,
  {
    readonly setSource: (appearance: DesktopWindowAppearance["appearance"]) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronTheme") {}

export const layer = Layer.effect(
  ElectronTheme,
  Effect.sync(() => {
    // Dark until the saved appearance loads with the desktop settings.
    Electron.nativeTheme.themeSource = "dark";
    return ElectronTheme.of({
      setSource: Effect.fn("ElectronTheme.setSource")(function* (appearance) {
        yield* Effect.sync(() => {
          Electron.nativeTheme.themeSource = appearance;
        });
      }),
    });
  }),
);
