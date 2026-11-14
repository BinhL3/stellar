import { createContext, startTransition, use, useMemo, type ReactNode } from "react";
import { AppState, Appearance, Platform } from "react-native";

import { manufacturer } from "expo-device";
import {
  resolveAndroidNavigationStyle,
  type AndroidNavigationStyle,
} from "../../../lib/androidNavigationStyle";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Atom, AsyncResult } from "effect/reactivity";

import { ScopedTheme, ScopedVariables, Uniwind } from "uniwind";

import {
  resolveAppearance,
  resolveAppearancePreferences,
  type ResolvedAppearance,
} from "../../../lib/appearancePreferences";
import { appAtomRegistry } from "../../../state/atom-registry";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import type { Preferences } from "../../../persistence/mobile-preferences";
import {
  isSystemColorsAvailable,
  readSystemColorPalette,
  type MaterialYouPalette,
} from "../../../lib/materialYouPalette";
import { materialYouPaletteToMobileThemeVariables } from "../../../lib/materialYouTheme";
import { getMobileThemeRuntimeVariables } from "../../../lib/mobileThemeVariables";
import type { MobileThemeVariables } from "../../../lib/mobileTheme";
import {
  createMobileThemePatch,
  getMobileThemeAppearance,
  resolveMobileThemeId,
  type MobileThemeAppearance,
  type MobileThemeId,
} from "../../../lib/mobileTheme";
import {
  getMobileUniwindThemeName,
  textScaleVariableUpdates,
} from "../../../lib/mobileThemeRuntime";

interface AppearancePreferencesContextValue {
  readonly appearance: ResolvedAppearance;
  readonly themeId: MobileThemeId;
  readonly androidNavigationStyle: AndroidNavigationStyle;
  readonly setAndroidNavigationStyle: (value: AndroidNavigationStyle) => void;
  /** The active theme's appearance; native views that take one read it from here. */
  readonly themeAppearance: MobileThemeAppearance;
  readonly systemColorsAvailable: boolean;
  readonly systemColorsActive: boolean;
  readonly themeVariables: MobileThemeVariables;
  readonly systemColorPalette: MaterialYouPalette | null;
  readonly isReady: boolean;
  readonly setThemeId: (value: MobileThemeId) => void;
  readonly setBaseFontSize: (value: number) => void;
  readonly setTerminalFontSize: (value: number | null) => void;
  readonly setCodeFontSize: (value: number | null) => void;
  readonly setCodeWordBreak: (value: boolean) => void;
  readonly mathRenderingEnabled: boolean;
  readonly setMathRenderingEnabled: (value: boolean) => void;
}

const AppearancePreferencesContext = createContext<AppearancePreferencesContextValue | null>(null);

function storedPreferencesOf<E>(result: AsyncResult.AsyncResult<Preferences, E>) {
  return AsyncResult.isSuccess(result) ? result.value : null;
}

/**
 * Material You palettes follow the system wallpaper, which can change while the
 * app is in the background.
 */
const systemColorPaletteAtom = Atom.make((get): MaterialYouPalette | null => {
  const initial = readSystemColorPalette();
  if (!isSystemColorsAvailable) return initial;
  let current = initial;
  const refresh = () => {
    const next = readSystemColorPalette();
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    current = next;
    get.setSelf(next);
  };
  const subscription = AppState.addEventListener("change", (state) => {
    if (state === "active") refresh();
  });
  const focusSubscription = AppState.addEventListener("focus", refresh);
  get.addFinalizer(() => {
    subscription.remove();
    focusSubscription.remove();
  });
  return initial;
}).pipe(Atom.withLabel("mobile:system-color-palette"));

function resolveThemeVariables(
  themeId: MobileThemeId,
  palette: MaterialYouPalette | null,
): MobileThemeVariables {
  const base = getMobileThemeRuntimeVariables(themeId, Platform.OS);
  return themeId === "material-you" && palette
    ? materialYouPaletteToMobileThemeVariables(palette, base)
    : base;
}

const themeAppearanceAtom = Atom.make((get) =>
  getMobileThemeAppearance(
    resolveMobileThemeId(storedPreferencesOf(get(mobilePreferencesAtom)) ?? {}),
  ),
);

const baseFontSizeAtom = Atom.make(
  (get) =>
    resolveAppearancePreferences(storedPreferencesOf(get(mobilePreferencesAtom))).baseFontSize,
);

// Uniwind text variables are process-global, so the last applied size is too. The setter
// applies ahead of the preference write so the first frame after a change already uses it;
// the atom subscription then sees no difference.
let appliedBaseFontSize: number | null = null;

function applyBaseFontSize(baseFontSize: number) {
  if (appliedBaseFontSize === baseFontSize) return;
  for (const { themeName, variables } of textScaleVariableUpdates(baseFontSize)) {
    Uniwind.updateCSSVariables(themeName, variables);
  }
  appliedBaseFontSize = baseFontSize;
}

/**
 * App-lifetime: applies theme preferences to the native runtime and holds the
 * system palette listeners. Holding them here instead of `keepAlive` lets the
 * fast-refresh disposer release the replaced module's AppState listeners.
 */
export function installAppearanceRuntime(): () => void {
  // Native controls, sheets and the keyboard follow the theme, never the system.
  const unsubscribeAppearance = appAtomRegistry.subscribe(
    themeAppearanceAtom,
    (appearance) => Appearance.setColorScheme(appearance),
    { immediate: true },
  );
  const unsubscribeRuntime = appAtomRegistry.subscribe(baseFontSizeAtom, applyBaseFontSize, {
    immediate: true,
  });
  const releasePalette = appAtomRegistry.mount(systemColorPaletteAtom);
  return () => {
    unsubscribeAppearance();
    unsubscribeRuntime();
    releasePalette();
  };
}

export function AppearancePreferencesProvider(props: { readonly children: ReactNode }) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const storedPreferences = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value
    : null;
  const preferences = useMemo(
    () => resolveAppearancePreferences(storedPreferences),
    [storedPreferences],
  );
  const androidNavigationStyle = resolveAndroidNavigationStyle(
    storedPreferences?.androidNavigationStyle,
    manufacturer,
    process.env.EXPO_PUBLIC_T3_FLOATING_TABS === "1",
  );
  const themeId = resolveMobileThemeId(storedPreferences ?? {});
  const systemColorsActive = themeId === "material-you" && isSystemColorsAvailable;
  const systemColorPalette = useAtomValue(systemColorPaletteAtom);
  const themeVariables = resolveThemeVariables(themeId, systemColorPalette);
  const activeThemeName = getMobileUniwindThemeName(themeId);
  const themeAppearance = getMobileThemeAppearance(themeId);
  const { baseFontSize, codeFontSize, codeWordBreak, terminalFontSize } = preferences;
  const appearance = useMemo(
    () => resolveAppearance({ baseFontSize, codeFontSize, codeWordBreak, terminalFontSize }),
    [baseFontSize, codeFontSize, codeWordBreak, terminalFontSize],
  );
  const isReady = AsyncResult.isSuccess(preferencesResult);
  const updatePreferences = (patch: Partial<Preferences>) => {
    startTransition(() => savePreferences(patch));
  };

  // Not a transition: the picked theme should paint on the next frame.
  const setThemeId = (value: MobileThemeId) => savePreferences(createMobileThemePatch(value));

  const setAndroidNavigationStyle = (value: AndroidNavigationStyle) =>
    updatePreferences({ androidNavigationStyle: value });

  const setBaseFontSize = (value: number) => {
    applyBaseFontSize(value);
    updatePreferences({ baseFontSize: value });
  };

  const setTerminalFontSize = (value: number | null) => {
    updatePreferences({ terminalFontSize: value });
  };

  const setCodeFontSize = (value: number | null) => {
    updatePreferences({ codeFontSize: value });
  };

  const setCodeWordBreak = (value: boolean) => {
    updatePreferences({ codeWordBreak: value });
  };

  const mathRenderingEnabled = storedPreferences?.mathRenderingEnabled === true;
  const setMathRenderingEnabled = (value: boolean) =>
    updatePreferences({ mathRenderingEnabled: value });

  const value = useMemo(
    (): AppearancePreferencesContextValue => ({
      appearance,
      themeId,
      androidNavigationStyle,
      setAndroidNavigationStyle,
      themeAppearance,
      systemColorsAvailable: isSystemColorsAvailable,
      systemColorsActive,
      themeVariables,
      systemColorPalette,
      isReady,
      setThemeId,
      setBaseFontSize,
      setTerminalFontSize,
      setCodeFontSize,
      setCodeWordBreak,
      mathRenderingEnabled,
      setMathRenderingEnabled,
    }),
    [
      appearance,
      themeId,
      androidNavigationStyle,
      setAndroidNavigationStyle,
      themeAppearance,
      systemColorsActive,
      themeVariables,
      systemColorPalette,
      isReady,
      setThemeId,
      setBaseFontSize,
      setTerminalFontSize,
      setCodeFontSize,
      setCodeWordBreak,
      mathRenderingEnabled,
      setMathRenderingEnabled,
    ],
  );

  return (
    <AppearancePreferencesContext.Provider value={value}>
      <ScopedTheme theme={activeThemeName}>
        <ScopedVariables variables={themeVariables}>{props.children}</ScopedVariables>
      </ScopedTheme>
    </AppearancePreferencesContext.Provider>
  );
}

export function useAppearancePreferences(): AppearancePreferencesContextValue {
  const context = use(AppearancePreferencesContext);
  if (!context) {
    throw new Error("useAppearancePreferences must be used within AppearancePreferencesProvider");
  }
  return context;
}

export function useAndroidFloatingTabs() {
  const { androidNavigationStyle } = useAppearancePreferences();
  return Platform.OS === "android" && androidNavigationStyle === "one-ui";
}
