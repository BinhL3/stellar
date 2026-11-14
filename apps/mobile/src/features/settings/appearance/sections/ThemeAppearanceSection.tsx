import { memo, useId } from "react";
import { Pressable, View } from "react-native";
import Svg, { Circle, Defs, RadialGradient, Stop } from "react-native-svg";

import { mixThemePreviewBase, THEME_PREVIEW_RENDER_SPEC } from "@t3tools/shared/themePreview";

import { AppText as Text } from "../../../../components/ui/AppText";
import {
  getMobileThemePreviewColors,
  MOBILE_THEME_OPTIONS,
  type MobileThemeId,
} from "../../../../lib/mobileTheme";
import { cn } from "../../../../lib/cn";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

const previewPercentage = (value: number) => `${value * 100}%`;

const PreviewOrb = memo(function PreviewOrb(props: { readonly themeId: MobileThemeId }) {
  const idPrefix = useId().replaceAll(":", "");
  const accentGradientId = `${idPrefix}-accent-glow`;
  const actionGradientId = `${idPrefix}-action-glow`;
  const { systemColorPalette: palette } = useAppearancePreferences();
  const colors =
    props.themeId === "material-you" && palette
      ? { canvas: palette.surface, accent: palette.primary, messageAction: palette.tertiary }
      : getMobileThemePreviewColors(props.themeId);
  const spec = THEME_PREVIEW_RENDER_SPEC;
  const accentRadius = Math.hypot(
    Math.max(spec.accent.center[0], 1 - spec.accent.center[0]),
    Math.max(spec.accent.center[1], 1 - spec.accent.center[1]),
  );
  const actionRadius = Math.hypot(
    Math.max(spec.action.center[0], 1 - spec.action.center[0]),
    Math.max(spec.action.center[1], 1 - spec.action.center[1]),
  );
  return (
    <View
      className="size-16 overflow-hidden rounded-full border"
      style={{ borderColor: "rgba(255, 255, 255, 0.14)" }}
    >
      <Svg accessibilityElementsHidden height="100%" viewBox="0 0 64 64" width="100%">
        <Defs>
          <RadialGradient
            cx={previewPercentage(spec.accent.center[0])}
            cy={previewPercentage(spec.accent.center[1])}
            fx={previewPercentage(spec.accent.center[0])}
            fy={previewPercentage(spec.accent.center[1])}
            id={accentGradientId}
            r={previewPercentage(accentRadius)}
          >
            <Stop offset="0%" stopColor={colors.accent} stopOpacity={1} />
            <Stop
              offset={previewPercentage(spec.accent.middleOffset)}
              stopColor={colors.accent}
              stopOpacity={spec.accent.middleOpacity}
            />
            <Stop
              offset={previewPercentage(spec.accent.endOffset)}
              stopColor={colors.accent}
              stopOpacity={0}
            />
            <Stop offset="100%" stopColor={colors.accent} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient
            cx={previewPercentage(spec.action.center[0])}
            cy={previewPercentage(spec.action.center[1])}
            fx={previewPercentage(spec.action.center[0])}
            fy={previewPercentage(spec.action.center[1])}
            id={actionGradientId}
            r={previewPercentage(actionRadius)}
          >
            <Stop
              offset="0%"
              stopColor={colors.messageAction}
              stopOpacity={spec.action.startOpacity}
            />
            <Stop
              offset={previewPercentage(spec.action.endOffset)}
              stopColor={colors.messageAction}
              stopOpacity={0}
            />
            <Stop offset="100%" stopColor={colors.messageAction} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx="32" cy="32" fill={mixThemePreviewBase(colors)} r="32" />
        <Circle cx="32" cy="32" fill={`url(#${actionGradientId})`} r="32" />
        <Circle cx="32" cy="32" fill={`url(#${accentGradientId})`} r="32" />
      </Svg>
    </View>
  );
});

function ThemeCard(props: {
  readonly disabled: boolean;
  readonly label: string;
  readonly onSelect: () => void;
  readonly selected: boolean;
  readonly themeId: MobileThemeId;
}) {
  return (
    <Pressable
      accessibilityLabel={`${props.label} theme`}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      className={cn(
        "min-w-36 flex-1 basis-[47%] items-center gap-3 rounded-[24px] px-2 py-4 active:scale-[0.97]",
        props.selected
          ? "border-2 border-primary bg-subtle"
          : "border border-border bg-grouped-card",
      )}
      disabled={props.disabled}
      onPress={props.onSelect}
    >
      <PreviewOrb themeId={props.themeId} />
      <Text className="min-w-0 px-1 text-lg font-t3-medium" numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  );
}

export function ThemeAppearanceSection() {
  const { isReady, setThemeId, themeId, systemColorsAvailable } = useAppearancePreferences();

  return (
    <View className="gap-3">
      <Text className="px-2 text-sm font-t3-medium text-foreground-muted">Themes</Text>
      <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-3">
        {MOBILE_THEME_OPTIONS.filter(
          (theme) => theme.id !== "material-you" || systemColorsAvailable,
        ).map((theme) => (
          <ThemeCard
            disabled={!isReady}
            key={theme.id}
            label={theme.label}
            onSelect={() => setThemeId(theme.id)}
            selected={theme.id === themeId}
            themeId={theme.id}
          />
        ))}
      </View>
    </View>
  );
}
