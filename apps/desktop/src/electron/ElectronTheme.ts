import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Electron from "electron";

/** Stellar is dark-only: native menus, dialogs and web contents never follow the OS scheme. */
export const layer = Layer.effectDiscard(
  Effect.sync(() => {
    Electron.nativeTheme.themeSource = "dark";
  }),
);
