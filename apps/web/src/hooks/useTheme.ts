import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";
import {
  applyThemePalette,
  CUSTOM_THEMES_STORAGE_KEY,
  DEFAULT_THEME_ID,
  invalidateCustomThemes,
  canonicalThemePreference,
  isKnownThemePreference,
  LEGACY_THEME_HALVES_STORAGE_KEY,
  legacyDarkThemeHalf,
  THEME_PREVIEW_ID,
  ThemePreference,
} from "../themePalette";

type Theme = ThemePreference;
// `resolvedTheme` is always "dark". It stays for the components that still thread it to
// syntax highlighting and file icons.
type ThemeSnapshot = { theme: Theme; resolvedTheme: "dark" };

const STORAGE_KEY = "t3code:theme";
const DEFAULT_THEME_SNAPSHOT: ThemeSnapshot = { theme: DEFAULT_THEME_ID, resolvedTheme: "dark" };

const THEME_COLOR_META_NAME = "theme-color";
const DYNAMIC_THEME_COLOR_SELECTOR = `meta[name="${THEME_COLOR_META_NAME}"][data-dynamic-theme-color="true"]`;

export class ThemeStorageError extends Schema.TaggedError<ThemeStorageError>()(
  "ThemeStorageError",
  {
    operation: Schema.Literals(["read", "write"]),
    storageKey: Schema.String,
    theme: Schema.optional(ThemePreference),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} theme preference for ${this.storageKey}.`;
  }
}

const isThemeStorageError = Schema.is(ThemeStorageError);

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
let snapshotStale = true;
let lastAppliedTheme: Theme | null = null;
let themeStorageReadFailure: ThemeStorageError | null = null;

function emitChange() {
  snapshotStale = true;
  for (const listener of listeners) listener();
}

/**
 * Stored values outlive the choices that wrote them: "system", "light" and "dark" named an
 * appearance, and a pairing could give dark mode its own theme. The pairing's dark half wins,
 * since that is what a dark screen showed; anything unresolvable falls back to the default.
 */
export function readThemePreference(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME_SNAPSHOT.theme;
  let raw: string | null;
  let legacyHalves: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
    legacyHalves = window.localStorage.getItem(LEGACY_THEME_HALVES_STORAGE_KEY);
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "read",
      storageKey: STORAGE_KEY,
      cause,
    });
  }
  const darkHalf = legacyDarkThemeHalf(legacyHalves);
  if (darkHalf !== null) return darkHalf;
  if (raw !== null && isKnownThemePreference(raw)) {
    return canonicalThemePreference(raw);
  }
  return DEFAULT_THEME_SNAPSHOT.theme;
}

function writeThemePreference(theme: Theme): void {
  // A whole theme replaces the retired pairing; retain it to restore on a failed write.
  const previousHalves = window.localStorage.getItem(LEGACY_THEME_HALVES_STORAGE_KEY);
  window.localStorage.removeItem(LEGACY_THEME_HALVES_STORAGE_KEY);
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
    themeStorageReadFailure = null;
  } catch (cause) {
    if (previousHalves !== null) {
      try {
        window.localStorage.setItem(LEGACY_THEME_HALVES_STORAGE_KEY, previousHalves);
      } catch {}
    }
    throw cause;
  }
}

function getStored(): Theme {
  if (themeStorageReadFailure !== null) {
    return DEFAULT_THEME_SNAPSHOT.theme;
  }
  try {
    return readThemePreference();
  } catch (cause) {
    const error = isThemeStorageError(cause)
      ? cause
      : new ThemeStorageError({
          operation: "read",
          storageKey: STORAGE_KEY,
          cause,
        });
    themeStorageReadFailure = error;
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      ...safeErrorLogAttributes(error),
    });
    return DEFAULT_THEME_SNAPSHOT.theme;
  }
}

function ensureThemeColorMetaTag(): HTMLMetaElement {
  let element = document.querySelector<HTMLMetaElement>(DYNAMIC_THEME_COLOR_SELECTOR);
  if (element) {
    return element;
  }

  element = document.createElement("meta");
  element.name = THEME_COLOR_META_NAME;
  element.setAttribute("data-dynamic-theme-color", "true");
  document.head.append(element);
  return element;
}

function normalizeThemeColor(value: string | null | undefined): string | null {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return null;
  }

  return value?.trim() ?? null;
}

function resolveBrowserChromeSurface(): HTMLElement {
  return (
    document.querySelector<HTMLElement>("main[data-slot='sidebar-inset']") ??
    document.querySelector<HTMLElement>("[data-slot='sidebar-inner']") ??
    document.body
  );
}

export function syncBrowserChromeTheme() {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return;
  const rootStyles = getComputedStyle(document.documentElement);
  const themeChromeColor = document.documentElement.dataset.themeId
    ? normalizeThemeColor(rootStyles.getPropertyValue("--app-chrome-background"))
    : null;
  const surfaceColor = normalizeThemeColor(
    getComputedStyle(resolveBrowserChromeSurface()).backgroundColor,
  );
  const fallbackColor = normalizeThemeColor(getComputedStyle(document.body).backgroundColor);
  const backgroundColor = themeChromeColor ?? surfaceColor ?? fallbackColor;
  if (!backgroundColor) return;

  document.documentElement.style.backgroundColor = backgroundColor;
  document.body.style.backgroundColor = backgroundColor;
  const themeColorMetas = document.querySelectorAll<HTMLMetaElement>(
    `meta[name="${THEME_COLOR_META_NAME}"]`,
  );
  if (themeColorMetas.length === 0) {
    ensureThemeColorMetaTag().setAttribute("content", backgroundColor);
    return;
  }
  for (const element of themeColorMetas) {
    element.setAttribute("content", backgroundColor);
  }
}

function applyTheme(theme: Theme, { suppressTransitions = false, preservePreview = true } = {}) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  if (preservePreview && document.documentElement.dataset?.themeId === THEME_PREVIEW_ID) {
    return;
  }
  if (lastAppliedTheme === theme) return;

  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }
  applyThemePalette(theme);
  // Tailwind's `dark:` variant keys off this class, so it is always present.
  document.documentElement.classList.add("dark");
  lastAppliedTheme = theme;
  syncBrowserChromeTheme();
  if (suppressTransitions) {
    // Force a reflow so the no-transitions class takes effect before removal
    void document.documentElement.offsetHeight;
    requestAnimationFrame(() => {
      document.documentElement.classList.remove("no-transitions");
    });
  }
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  applyTheme(getStored());
}

function getSnapshot(): ThemeSnapshot {
  if (typeof window === "undefined") return DEFAULT_THEME_SNAPSHOT;
  // Cache localStorage reads until signalled; useTheme calls this every render.
  if (!snapshotStale && lastSnapshot) return lastSnapshot;
  snapshotStale = false;
  const theme = getStored();
  if (lastSnapshot?.theme === theme) return lastSnapshot;
  lastSnapshot = { theme, resolvedTheme: "dark" };
  return lastSnapshot;
}

function getServerSnapshot() {
  return DEFAULT_THEME_SNAPSHOT;
}

function handleStorageChange(e: StorageEvent) {
  if (e.key === STORAGE_KEY) {
    themeStorageReadFailure = null;
    applyTheme(getStored(), { suppressTransitions: true });
    emitChange();
  } else if (e.key === LEGACY_THEME_HALVES_STORAGE_KEY) {
    applyTheme(getStored(), { suppressTransitions: true });
    emitChange();
  } else if (e.key === CUSTOM_THEMES_STORAGE_KEY || e.key === null) {
    if (e.key === null) themeStorageReadFailure = null;
    invalidateCustomThemes();
    lastAppliedTheme = null;
    applyTheme(getStored(), { suppressTransitions: true });
    emitChange();
  }
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.push(listener);
  if (listeners.length === 1) window.addEventListener("storage", handleStorageChange);

  return () => {
    listeners = listeners.filter((l) => l !== listener);
    if (listeners.length === 0) window.removeEventListener("storage", handleStorageChange);
  };
}

/** For shortcuts and other handlers outside React that read the theme at event time. */
export function getThemeSnapshot(): ThemeSnapshot {
  return getSnapshot();
}

/** Always "dark"; see `ThemeSnapshot`. */
export const RENDERED_APPEARANCE = "dark" as const;

export function setTheme(next: Theme): boolean {
  if (typeof window === "undefined") return false;
  try {
    writeThemePreference(next);
  } catch (cause) {
    const error = new ThemeStorageError({
      operation: "write",
      storageKey: STORAGE_KEY,
      theme: next,
      cause,
    });
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      theme: next,
      ...safeErrorLogAttributes(error),
    });
    return false;
  }
  applyTheme(next, { suppressTransitions: true });
  emitChange();
  return true;
}

export function refreshTheme({ preservePreview = false } = {}): void {
  if (typeof window === "undefined") return;
  lastAppliedTheme = null;
  applyTheme(getStored(), { suppressTransitions: true, preservePreview });
  emitChange();
}

export function useTheme() {
  const { theme, resolvedTheme } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return { theme, setTheme, refreshTheme, resolvedTheme } as const;
}
