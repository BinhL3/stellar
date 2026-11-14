import type { CSSProperties } from "react";
import {
  BACKDROP_TREATMENTS,
  type BackdropTreatment,
  DEFAULT_UNIFIED_SETTINGS,
} from "@t3tools/contracts/settings";

import { Backdrop } from "../backdrop/Backdrop";
import {
  BACKDROP_TREATMENT_OPTIONS,
  BACKDROP_TREATMENT_SPECS,
  backdropParamKey,
  backdropSliderPercent,
  formatBackdropSliderValue,
} from "../backdrop/backdropTreatments";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function BackdropSlider(props: {
  readonly id: string;
  readonly label: string;
  readonly percent: number;
  readonly display: string;
  readonly onChange: (percent: number) => void;
}) {
  const sliderStyle = {
    "--settings-slider-progress": `${props.percent}%`,
    "--settings-slider-fill-offset": `${0.5 - props.percent / 100}rem`,
  } as CSSProperties;
  return (
    <div className="flex w-full items-center gap-3 sm:w-52">
      <output
        className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
        htmlFor={props.id}
      >
        {props.display}
      </output>
      <input
        aria-label={props.label}
        className="settings-slider min-w-0 flex-1"
        id={props.id}
        max={100}
        min={0}
        onChange={(event) => {
          const percent = Number(event.currentTarget.value);
          if (Number.isInteger(percent) && percent >= 0 && percent <= 100) props.onChange(percent);
        }}
        step={1}
        style={sliderStyle}
        type="range"
        value={props.percent}
      />
    </div>
  );
}

const isBackdropTreatment = (value: unknown): value is BackdropTreatment =>
  (BACKDROP_TREATMENTS as ReadonlyArray<unknown>).includes(value);

export function BackdropSettingsSection() {
  const treatment = useScopedSettings((settings) => settings.backdropTreatment);
  const strength = useScopedSettings((settings) => settings.backdropStrength);
  const params = useScopedSettings((settings) => settings.backdropParams);
  const updateSettings = useUpdateScopedSettings();
  const spec = BACKDROP_TREATMENT_SPECS[treatment];

  return (
    <SettingsSection id="appearance-backdrop" title="Backdrop">
      <div className="grid sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
        <div className="relative isolate min-h-36 overflow-hidden border-b border-border sm:border-e sm:border-b-0">
          <Backdrop variant="preview" />
        </div>
        <div>
          <SettingsRow
            {...searchableSetting("backdrop")}
            description="How the scene behind chats and empty screens is printed. Each theme brings its own scene and inks."
            resetAction={
              treatment !== DEFAULT_UNIFIED_SETTINGS.backdropTreatment ? (
                <SettingResetButton
                  label="backdrop treatment"
                  onClick={() =>
                    updateSettings({
                      backdropTreatment: DEFAULT_UNIFIED_SETTINGS.backdropTreatment,
                    })
                  }
                />
              ) : null
            }
            control={
              <div className="w-full sm:w-40">
                <Select
                  value={treatment}
                  onValueChange={(value) => {
                    if (isBackdropTreatment(value)) updateSettings({ backdropTreatment: value });
                  }}
                >
                  <SelectTrigger size="sm" className="w-full min-w-0" aria-label="Backdrop">
                    <SelectValue>{spec.label}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup align="end" alignItemWithTrigger={false}>
                    {BACKDROP_TREATMENT_OPTIONS.map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            }
          />
          {spec.sliders.map((slider) => {
            const key = backdropParamKey(treatment, slider.key);
            const percent = backdropSliderPercent(treatment, slider, params);
            return (
              <SettingsRow
                key={key}
                title={slider.label}
                resetAction={
                  key in params ? (
                    <SettingResetButton
                      label={slider.label.toLowerCase()}
                      onClick={() =>
                        updateSettings({
                          backdropParams: Object.fromEntries(
                            Object.entries(params).filter(([stored]) => stored !== key),
                          ),
                        })
                      }
                    />
                  ) : null
                }
                control={
                  <BackdropSlider
                    id={`backdrop-${key}`}
                    label={slider.label}
                    percent={percent}
                    display={formatBackdropSliderValue(slider, percent)}
                    onChange={(next) =>
                      updateSettings({ backdropParams: { ...params, [key]: next } })
                    }
                  />
                }
              />
            );
          })}
          {treatment === "none" ? null : (
            <SettingsRow
              title="Strength"
              description="Behind a conversation the scene always fades to about a fifth of this."
              resetAction={
                strength !== DEFAULT_UNIFIED_SETTINGS.backdropStrength ? (
                  <SettingResetButton
                    label="backdrop strength"
                    onClick={() =>
                      updateSettings({
                        backdropStrength: DEFAULT_UNIFIED_SETTINGS.backdropStrength,
                      })
                    }
                  />
                ) : null
              }
              control={
                <BackdropSlider
                  id="backdrop-strength"
                  label="Strength"
                  percent={strength}
                  display={`${strength}%`}
                  onChange={(next) => updateSettings({ backdropStrength: next })}
                />
              }
            />
          )}
        </div>
      </div>
    </SettingsSection>
  );
}
