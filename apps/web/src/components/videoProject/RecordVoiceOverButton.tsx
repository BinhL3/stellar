import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, VoiceOverChannels } from "@t3tools/contracts";
import { ChevronDownIcon, MicIcon, SquareIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { updateClientSettings, useClientSettings } from "~/hooks/useSettings";
import { Button } from "~/components/ui/button";
import { Group } from "~/components/ui/group";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemDetail,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  type BrowserMicrophone,
  listBrowserMicrophonesWithAccess,
} from "~/speech/browserMicrophones";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { InputLevelMeter } from "./InputLevelMeter";
import { useVoiceRecorder } from "./useVoiceRecorder";

// Chrome lists the OS default and Windows' communications device as aliases of real devices.
const ALIAS_DEVICE_IDS = new Set(["default", "communications"]);
const CHANNEL_LABELS: Record<VoiceOverChannels, string> = { mono: "Mono", stereo: "Stereo" };

/** The input devices, kept current as they're plugged in or out. */
function useMicrophones() {
  const [state, setState] = useState<{
    readonly microphones: ReadonlyArray<BrowserMicrophone>;
    readonly named: boolean;
  }>({ microphones: [], named: false });
  const refresh = useStableCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      setState(await listBrowserMicrophonesWithAccess());
    } catch {
      // Listing failed; the system default still records.
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the browser's microphone list, which changes as devices are plugged in or out
  useEffect(() => {
    queueMicrotask(() => void refresh());
    const mediaDevices = navigator.mediaDevices;
    mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, [refresh]);
  return { ...state, refresh };
}

/**
 * Records a voice-over take from this device's microphone and saves it into the project as a
 * WAV. Play the timeline while recording to narrate to picture; the take is not placed for you.
 * The attached menu picks the microphone and mono or stereo.
 */
export function RecordVoiceOverButton(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  /** Called with the saved file's path, relative to the project's media root. */
  readonly onSaved: (path: string) => void;
  /** A toolbar's icon, with how to use it in its tooltip, instead of the worded button. */
  readonly iconOnly?: boolean;
}) {
  const save = useAtomCommand(projectEnvironment.saveVideoVoiceOver, { reportFailure: false });
  const recorder = useVoiceRecorder();
  const [saving, setSaving] = useState(false);
  const savedDeviceId = useClientSettings((settings) => settings.voiceOverMicrophone);
  const channels = useClientSettings((settings) => settings.voiceOverChannels);
  const { microphones, named, refresh } = useMicrophones();

  const chosen = microphones.find((device) => device.deviceId === savedDeviceId);
  // Without access the list has no ids to match, so a saved device can't be called missing.
  const missing = savedDeviceId !== "" && named && chosen === undefined;
  const systemDefault = microphones
    .find((device) => device.deviceId === "default")
    ?.label.replace(/^Default - /, "");
  const microphoneLabel =
    chosen?.label ?? (savedDeviceId === "" || missing ? "System default" : "Chosen microphone");
  const summary = `${microphoneLabel} · ${CHANNEL_LABELS[channels]}`;
  const missingNote =
    "Your chosen microphone isn't connected, so this records from the system default.";

  const finish = async (recording: Uint8Array, recorded: 1 | 2) => {
    setSaving(true);
    const result = await save({
      environmentId: props.environmentId,
      input: { workspaceRoot: props.workspaceRoot, recording, channels: recorded },
    });
    setSaving(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Voice-over saved",
        description: result.value.path,
      });
      props.onSaved(result.value.path);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not save the voice-over",
        description:
          error instanceof Error && error.message.trim() !== ""
            ? error.message
            : "Try again in a moment.",
      });
    }
  };

  const startRecording = async () => {
    if (missing) toastManager.add({ type: "warning", title: missingNote });
    const take = await recorder.start(
      { deviceId: missing ? "" : savedDeviceId, stereo: channels === "stereo" },
      (recording, recorded) => void finish(recording, recorded),
    );
    if (take === null) return;
    if (channels === "stereo" && take.channels === 1) {
      toastManager.add({ type: "info", title: "This microphone records in mono" });
    }
    // Granting access on this first take is what makes the device names readable.
    if (!named) void refresh();
  };

  const allowAccess = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Microphone access was not granted",
        description:
          error instanceof Error && error.message.trim() !== ""
            ? error.message
            : "Allow it in the browser's or system's privacy settings.",
      });
    }
    await refresh();
  };

  const settingsMenu = (
    <Menu
      onOpenChange={(open) => {
        if (open) void refresh();
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              disabled={recorder.take !== null || saving}
              render={
                <Button
                  size={props.iconOnly ? "icon-xs" : "sm"}
                  variant={props.iconOnly ? "ghost" : "outline"}
                  aria-label="Voice-over microphone"
                />
              }
            />
          }
        >
          <ChevronDownIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{summary}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom">
        <MenuGroup>
          <MenuGroupLabel>Microphone</MenuGroupLabel>
          {named ? null : (
            <MenuItem onClick={() => void allowAccess()}>
              <MicIcon />
              Allow microphone access
            </MenuItem>
          )}
          <MenuRadioGroup
            value={
              missing ? "missing" : savedDeviceId === "" ? "default" : `device:${savedDeviceId}`
            }
            onValueChange={(value) => {
              if (typeof value !== "string" || value === "missing") return;
              void updateClientSettings({
                voiceOverMicrophone: value === "default" ? "" : value.slice("device:".length),
              });
            }}
          >
            <MenuRadioItem value="default" closeOnClick>
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">System default</span>
                {systemDefault ? <MenuItemDetail>{systemDefault}</MenuItemDetail> : null}
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
            {missing ? (
              <MenuRadioItem value="missing" disabled>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate">Chosen microphone</span>
                  <MenuItemDetail>Not connected</MenuItemDetail>
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ) : null}
            {microphones
              .filter((device) => !ALIAS_DEVICE_IDS.has(device.deviceId))
              .map((device) => (
                <MenuRadioItem
                  key={device.deviceId}
                  value={`device:${device.deviceId}`}
                  closeOnClick
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate">{device.label}</span>
                    <MenuRadioItemIndicator />
                  </span>
                </MenuRadioItem>
              ))}
          </MenuRadioGroup>
          {missing ? (
            <p className="max-w-64 px-2 py-1 text-xs text-muted-foreground">{missingNote}</p>
          ) : null}
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Channels</MenuGroupLabel>
          <MenuRadioGroup
            value={channels}
            onValueChange={(value) => {
              if (value === "mono" || value === "stereo") {
                void updateClientSettings({ voiceOverChannels: value });
              }
            }}
          >
            <MenuRadioItem value="mono" closeOnClick>
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">Mono</span>
                <MenuItemDetail>One voice</MenuItemDetail>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
            <MenuRadioItem value="stereo" closeOnClick>
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">Stereo</span>
                <MenuItemDetail>If the mic has two channels</MenuItemDetail>
                <MenuRadioItemIndicator />
              </span>
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );

  const recordingNote =
    recorder.take === null
      ? null
      : `Stop recording · ${microphoneLabel} · ${recorder.take.channels === 2 ? "Stereo" : "Mono"}`;

  if (props.iconOnly) {
    return (
      <Group aria-label="Voice-over">
        <Tooltip>
          <TooltipTrigger
            render={
              recorder.take !== null ? (
                <Button
                  size="icon-sm"
                  variant="destructive"
                  aria-label="Stop recording"
                  onClick={recorder.stop}
                />
              ) : (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Record voice-over"
                  disabled={saving}
                  onClick={() => void startRecording()}
                />
              )
            }
          >
            {recorder.take !== null ? <SquareIcon /> : saving ? <Spinner size="xs" /> : <MicIcon />}
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {recordingNote ?? (
              <>
                Record voice-over with {summary}. Press play first to narrate to picture; takes are
                saved in Audio/VO.
                {missing ? (
                  <>
                    <br />
                    {missingNote}
                  </>
                ) : null}
              </>
            )}
          </TooltipPopup>
        </Tooltip>
        {recorder.take !== null ? <InputLevelMeter take={recorder.take} /> : settingsMenu}
      </Group>
    );
  }
  return (
    <Group aria-label="Voice-over">
      {recorder.take !== null ? (
        <Button size="sm" variant="destructive" onClick={recorder.stop}>
          <SquareIcon />
          Stop recording
        </Button>
      ) : (
        <Button size="sm" variant="outline" disabled={saving} onClick={() => void startRecording()}>
          <MicIcon />
          {saving ? "Saving…" : "Record voice-over"}
        </Button>
      )}
      {recorder.take !== null ? <InputLevelMeter take={recorder.take} /> : settingsMenu}
    </Group>
  );
}
