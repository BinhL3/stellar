import type { CSSProperties } from "react";
import { THEME_PREVIEW_RENDER_SPEC } from "@t3tools/shared/themePreview";
import { cn } from "../../lib/utils";
import type { ThemeDefinition } from "../../themePalette";

export type ThemeCardPreviewColors = Readonly<{
  canvas: string;
  accent: string;
  messageAction: string;
}>;
export type ThemeCardDefinition = {
  id: string;
  label: string;
  colors: ThemeCardPreviewColors;
};

export function getThemeCardDefinition(theme: ThemeDefinition): ThemeCardDefinition {
  return {
    id: theme.id,
    label: theme.label,
    colors: {
      canvas: theme.colors.canvas,
      accent: theme.colors.accent,
      messageAction: theme.colors.messageAction,
    },
  };
}

function getThemePreviewStyle(colors: ThemeCardPreviewColors): CSSProperties {
  const spec = THEME_PREVIEW_RENDER_SPEC;
  const base = `color-mix(in oklab, ${colors.canvas} ${spec.baseWeight * 100}%, ${spec.baseTarget})`;
  const accentPosition = `${spec.accent.center[0] * 100}% ${spec.accent.center[1] * 100}%`;
  const actionPosition = `${spec.action.center[0] * 100}% ${spec.action.center[1] * 100}%`;
  return {
    backgroundColor: base,
    backgroundImage: [
      `radial-gradient(circle at ${accentPosition} in oklab, ${colors.accent} 0%, color-mix(in oklab, ${colors.accent} ${spec.accent.middleOpacity * 100}%, transparent) ${spec.accent.middleOffset * 100}%, transparent ${spec.accent.endOffset * 100}%)`,
      `radial-gradient(circle at ${actionPosition} in oklab, color-mix(in oklab, ${colors.messageAction} ${spec.action.startOpacity * 100}%, transparent) 0%, transparent ${spec.action.endOffset * 100}%)`,
    ].join(", "),
    filter: `blur(${spec.blurAt56Px}px)`,
    transform: `scale(${spec.scale})`,
  };
}

export function ThemePreviewCircle({
  colors,
  className,
}: {
  colors: ThemeCardPreviewColors;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative block size-14 shrink-0 overflow-hidden rounded-full border-2 border-background",
        className,
      )}
      style={{
        boxShadow: "inset 0 0 0 1px rgb(255 255 255 / 0.14), 0 1px 2px rgb(0 0 0 / 0.18)",
      }}
    >
      <span className="absolute inset-0 rounded-full" style={getThemePreviewStyle(colors)} />
    </span>
  );
}
