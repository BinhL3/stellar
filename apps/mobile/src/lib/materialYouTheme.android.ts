import { Hct, argbFromHex, hexFromArgb } from "@material/material-color-utilities";

import type { MobileThemeVariables } from "./mobileTheme";
import type { MaterialYouPalette } from "./materialYouPalette";

function withAlpha(color: string, alpha: number): string {
  const match = /^#([\da-f]{6})(?:[\da-f]{2})?$/iu.exec(color);
  if (!match?.[1]) return color;
  const alphaByte = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
  return `#${match[1]}${alphaByte}`;
}

function materialTone(color: string, tone: number): string {
  const match = /^#([\da-f]{6})(?:[\da-f]{2})?$/iu.exec(color);
  if (!match?.[1]) return color;

  const source = Hct.fromInt(argbFromHex(match[1]));
  return `${hexFromArgb(Hct.from(source.hue, source.chroma, tone).toInt()).toUpperCase()}FF`;
}

export function materialYouPaletteToMobileThemeVariables(
  palette: MaterialYouPalette,
  base: MobileThemeVariables,
): MobileThemeVariables {
  const userBubble = materialTone(palette.inversePrimary, 30);
  const userBubbleForeground = materialTone(palette.inversePrimary, 90);

  return {
    ...base,
    "--color-screen": palette.surface,
    "--color-sheet": withAlpha(palette.surfaceContainerLow, 0.98),
    "--color-sheet-solid": palette.surfaceContainerLow,
    "--color-card": palette.surfaceContainer,
    "--color-grouped-card": palette.surfaceContainer,
    "--color-card-alt": palette.surfaceContainerHigh,
    "--color-card-translucent": withAlpha(palette.surfaceContainer, 0.8),
    "--color-thread-canvas": palette.surfaceContainerLow,
    "--color-thread-selected": palette.surfaceContainer,
    "--color-thread-selected-foreground": palette.onSurface,
    "--color-thread-selected-foreground-muted": palette.onSurfaceVariant,
    "--color-thread-hover": palette.surfaceContainerHigh,
    "--color-row-hover": palette.surfaceContainerHigh,
    "--color-composer-panel": withAlpha(palette.surfaceContainerLow, 0.92),
    "--color-composer-surface": withAlpha(palette.surfaceContainerHigh, 0.9),
    "--color-composer-border": withAlpha(palette.outlineVariant, 0.34),
    "--color-foreground": palette.onSurface,
    "--color-foreground-secondary": palette.onSurfaceVariant,
    "--color-foreground-muted": palette.onSurfaceVariant,
    "--color-foreground-tertiary": withAlpha(palette.onSurfaceVariant, 0.58),
    "--color-border": withAlpha(palette.outlineVariant, 0.5),
    "--color-focus": palette.primary,
    "--color-border-subtle": withAlpha(palette.outlineVariant, 0.34),
    "--color-separator": withAlpha(palette.outlineVariant, 0.24),
    "--color-subtle": withAlpha(palette.onSurface, 0.05),
    "--color-subtle-strong": withAlpha(palette.onSurface, 0.1),
    "--color-inline-skill-background": withAlpha(palette.tertiaryContainer, 0.52),
    "--color-inline-skill-border": withAlpha(palette.tertiary, 0.38),
    "--color-inline-skill-foreground": palette.onTertiaryContainer,
    "--color-primary": palette.primary,
    "--color-primary-foreground": palette.onPrimary,
    "--color-primary-text": palette.primary,
    "--color-primary-shadow": withAlpha(palette.scrim, 0.22),
    "--color-secondary": palette.secondaryContainer,
    "--color-secondary-foreground": palette.onSecondaryContainer,
    "--color-secondary-border": withAlpha(palette.outlineVariant, 0.42),
    "--color-switch-active-track": palette.primary,
    "--color-switch-active-thumb": palette.onPrimary,
    "--color-switch-inactive-track": palette.surfaceContainerHighest,
    "--color-switch-inactive-thumb": palette.outline,
    "--color-danger": palette.errorContainer,
    "--color-danger-border": withAlpha(palette.onErrorContainer, 0.42),
    "--color-danger-foreground": palette.onErrorContainer,
    "--color-update": palette.primaryContainer,
    "--color-update-foreground": palette.onPrimaryContainer,
    "--color-input": palette.surfaceContainerLowest,
    "--color-input-border": withAlpha(palette.outline, 0.42),
    "--color-sidebar-search": palette.surfaceContainerLowest,
    "--color-placeholder": withAlpha(palette.onSurface, 0.62),
    "--color-icon": palette.onSurface,
    "--color-icon-muted": palette.onSurfaceVariant,
    "--color-icon-subtle": withAlpha(palette.onSurfaceVariant, 0.68),
    "--color-header": palette.surfaceContainerHigh,
    "--color-header-foreground": palette.onSurface,
    "--color-header-border": withAlpha(palette.outlineVariant, 0.36),
    "--color-glass-surface": withAlpha(palette.surfaceContainerHigh, 0.78),
    "--color-glass-fallback": withAlpha(palette.surfaceContainerHigh, 0.9),
    "--color-glass-tint": withAlpha(palette.primaryContainer, 0.24),
    "--color-status-bar": palette.surfaceContainerLow,
    "--color-md-body": materialTone(palette.onSurfaceVariant, 90),
    "--color-md-strong": materialTone(palette.onSurfaceVariant, 90),
    "--color-md-link": palette.primary,
    "--color-md-blockquote-border": withAlpha(palette.primary, 0.34),
    "--color-md-blockquote-bg": withAlpha(palette.primaryContainer, 0.14),
    "--color-md-code-bg": withAlpha(palette.onSurface, 0.08),
    "--color-md-code-text": palette.onSurface,
    "--color-md-user-code-bg": withAlpha(userBubbleForeground, 0.18),
    "--color-md-user-code-text": userBubbleForeground,
    "--color-md-user-fence-bg": withAlpha(userBubbleForeground, 0.14),
    "--color-md-user-fence-text": userBubbleForeground,
    "--color-md-hr": withAlpha(palette.outlineVariant, 0.48),
    "--color-user-bubble": userBubble,
    "--color-user-bubble-foreground": userBubbleForeground,
    "--color-user-bubble-foreground-muted": withAlpha(userBubbleForeground, 0.78),
    "--color-user-bubble-skill-foreground": userBubbleForeground,
    "--color-backdrop": withAlpha(palette.scrim, 0.48),
    "--color-drawer": palette.surface,
    "--color-drawer-foreground": palette.onSurface,
    "--color-drawer-foreground-muted": palette.onSurfaceVariant,
    "--color-drawer-border": withAlpha(palette.outlineVariant, 0.36),
    "--color-drawer-shadow": withAlpha(palette.scrim, 0.32),
    "--color-dot-separator": withAlpha(palette.onSurface, 0.2),
    "--color-wordmark": palette.onSurface,
    "--color-chevron": withAlpha(palette.onSurface, 0.2),
  };
}
