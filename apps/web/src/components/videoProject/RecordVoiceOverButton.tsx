import { useProvideTimelineCommand } from "~/components/timeline/timelineCommands";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, VoiceOverChannels } from "@t3tools/contracts";
import { ChevronDownIcon, CircleIcon, MicIcon, SquareIcon } from "lucide-react";
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

export type VoiceOver = ReturnType<typeof useVoiceOver>;

/**
 * Records voice-over takes from this device's microphone and saves each into the project as a
 * WAV. Recording doesn't follow the playhead: press play to narrate to picture; the take is not
 * placed for you. Held by the Timeline tab rather than its button, so a take survives the button
 * moving between panels as the layout changes.
 */
export function useVoiceOver(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  /** Whether this client may write into the project; without it nothing is offered. */
  readonly enabled: boolean;
  /** Called with the saved file's path, relative to the project's media root. */
  readonly onSaved: (path: string) => void;
}) {
  const save = useAtomCommand(projectEnvironment.saveVideoVoiceOver, { reportFailure: false });
  const recorder = useVoiceRecorder();
  const [saving, setSaving] = useState(false);
  const [startedAt, setStartedAt] = useState(0);
  const savedDeviceId = useClientSettings((settings) => settings.voiceOverMicrophone);
  const channels = useClientSettings((settings) => settings.voiceOverChannels);
  const microphones = useMicrophones();

  const chosen = microphones.microphones.find((device) => device.deviceId === savedDeviceId);
  // Without access the list has no ids to match, so a saved device can't be called missing.
  const missing = savedDeviceId !== "" && microphones.named && chosen === undefined;
  const microphoneLabel =
    chosen?.label ?? (savedDeviceId === "" || missing ? "System default" : "Chosen microphone");

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

  const start = async () => {
    if (missing) toastManager.add({ type: "warning", title: MISSING_NOTE });
    const take = await recorder.start(
      { deviceId: missing ? "" : savedDeviceId, stereo: channels === "stereo" },
      (recording, recorded) => void finish(recording, recorded),
    );
    if (take === null) return;
    setStartedAt(Date.now());
    if (channels === "stereo" && take.channels === 1) {
      toastManager.add({ type: "info", title: "This microphone records in mono" });
    }
    // Granting access on this first take is what makes the device names readable.
    if (!microphones.named) void microphones.refresh();
  };

  useProvideTimelineCommand(
    "recordVoiceOver",
    !props.enabled || saving ? null : recorder.take !== null ? recorder.stop : () => void start(),
  );

  return {
    enabled: props.enabled,
    take: recorder.take,
    startedAt,
    saving,
    start,
    stop: recorder.stop,
    microphones,
    savedDeviceId,
    channels,
    missing,
    microphoneLabel,
  };
}

const MISSING_NOTE =
  "Your chosen microphone isn't connected, so this records from the system default.";

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** How long the take has run. Mounted only while recording, so it ticks only then. */
function RecordingTime(props: { readonly startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A clock: it reads the wall time each second while a take is recording.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="font-mono tabular-nums">{clock(now - props.startedAt)}</span>;
}

/**
 * The record control for the voice-over `useVoiceOver` holds: a record button and the menu that
 * picks the microphone and mono or stereo, which turn into Stop, the take's time and a level
 * meter while recording.
 */
export function RecordVoiceOverButton(props: {
  readonly voiceOver: VoiceOver;
  /**
   * Hides the words when the Monitor panel is narrow, leaving the record dot and its tooltip.
   * Elsewhere the words always show.
   */
  readonly collapse?: "monitor";
  readonly tooltipSide?: "top" | "bottom";
}) {
  const { voiceOver } = props;
  const { take, microphones, channels, savedDeviceId, missing } = voiceOver;
  const side = props.tooltipSide ?? "top";
  const label = props.collapse === "monitor" ? "@max-[24rem]/monitor:sr-only" : undefined;
  const systemDefault = microphones.microphones
    .find((device) => device.deviceId === "default")
    ?.label.replace(/^Default - /, "");
  const summary = `${voiceOver.microphoneLabel} · ${CHANNEL_LABELS[channels]}`;

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
    await microphones.refresh();
  };

  if (take !== null) {
    return (
      <Group aria-label="Voice-over">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant="destructive"
                aria-label="Stop recording"
                onClick={voiceOver.stop}
              />
            }
          >
            <SquareIcon className="fill-current" />
            <span className={label}>Stop</span>
            <RecordingTime startedAt={voiceOver.startedAt} />
          </TooltipTrigger>
          <TooltipPopup side={side}>
            Stop recording · {voiceOver.microphoneLabel} · {take.channels === 2 ? "Stereo" : "Mono"}
          </TooltipPopup>
        </Tooltip>
        <InputLevelMeter take={take} />
      </Group>
    );
  }

  return (
    <Group aria-label="Voice-over">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="xs"
              variant="outline"
              aria-label="Record voice-over"
              disabled={voiceOver.saving}
              onClick={() => void voiceOver.start()}
            />
          }
        >
          {voiceOver.saving ? (
            <Spinner size="xs" />
          ) : (
            <CircleIcon className="fill-destructive text-destructive" />
          )}
          <span className={label}>{voiceOver.saving ? "Saving…" : "Record VO"}</span>
        </TooltipTrigger>
        <TooltipPopup side={side}>
          Record a voice-over with {summary}. It doesn't follow the playhead: press play to narrate
          to picture. Takes are saved in Audio/VO and handed to the chat.
          {missing ? (
            <>
              <br />
              {MISSING_NOTE}
            </>
          ) : null}
        </TooltipPopup>
      </Tooltip>
      <Menu
        onOpenChange={(open) => {
          if (open) void microphones.refresh();
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                disabled={voiceOver.saving}
                render={
                  <Button size="icon-xs" variant="outline" aria-label="Voice-over microphone" />
                }
              />
            }
          >
            <ChevronDownIcon />
          </TooltipTrigger>
          <TooltipPopup side={side}>{summary}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" side={side}>
          <MenuGroup>
            <MenuGroupLabel>Microphone</MenuGroupLabel>
            {microphones.named ? null : (
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
              {microphones.microphones
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
              <p className="max-w-64 px-2 py-1 text-xs text-muted-foreground">{MISSING_NOTE}</p>
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
    </Group>
  );
}
