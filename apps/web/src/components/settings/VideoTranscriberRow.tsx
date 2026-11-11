import { resolvePastedPath } from "@t3tools/shared/path";
import { useRef } from "react";

import { Input } from "../ui/input";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function VideoTranscriberRow() {
  const { targets } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["videoTranscribeCommand"]);
  const edited = useRef(false);
  const draft = useRef("");
  const scopeKey = targets.map((target) => target.environmentId).join(",");

  return (
    <SettingsRow
      {...searchableSetting("video-transcriber")}
      description="The program on this machine that makes word-timed transcripts, so agents can cut by what was said. It is run as: program words <file> -o <out.words.json>. Leave empty to use stt from the PATH."
      serverScoped
      settingKeys={["videoTranscribeCommand"]}
      resetAction={
        mixed || settings.videoTranscribeCommand !== "" ? (
          <SettingResetButton
            label="transcriber"
            onClick={() => updateSettings({ videoTranscribeCommand: "" })}
          />
        ) : null
      }
      control={
        <Input
          key={`${scopeKey}:${mixed}:${settings.videoTranscribeCommand}`}
          aria-label="Transcriber"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={mixed ? "Mixed" : "stt"}
          defaultValue={mixed ? "" : settings.videoTranscribeCommand}
          onFocus={(event) => {
            draft.current = event.target.value;
          }}
          onChange={(event) => {
            edited.current = true;
            draft.current = resolvePastedPath(draft.current, event.target.value);
            event.target.value = draft.current;
          }}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (edited.current && (mixed || value !== settings.videoTranscribeCommand))
              updateSettings({ videoTranscribeCommand: value });
            edited.current = false;
          }}
        />
      }
    />
  );
}
