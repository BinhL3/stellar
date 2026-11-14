import type { AssetResource, EnvironmentId, VideoVoiceOverBeat } from "@t3tools/contracts";
import {
  AudioLinesIcon,
  MicIcon,
  PlayIcon,
  SquareIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAssetUrls } from "~/assets/assetUrls";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

// A line of narration is a few megabytes; anything near this is a whole recording to split.
export const MAX_IMPORT_BYTES = 40 * 1024 * 1024;

export interface LineVoiceOverActions {
  readonly onRecord: () => void;
  readonly onStop: () => void;
  readonly onChoose: (takeId: string) => void;
  readonly onDelete: (takeId: string) => void;
  readonly onImport: (file: File) => void;
  readonly onPlace: () => void;
}

/** What a line's voice-over is doing, in one sentence. */
const voiceOverStatus = (line: VideoVoiceOverBeat): string => {
  const number = (takeId: string | null) => line.takes.findIndex((take) => take.id === takeId) + 1;
  if (line.takes.length === 0) return "No takes for this line yet.";
  const chosen = number(line.chosen);
  if (line.placed === null) return `Take ${chosen} is chosen but not on the timeline.`;
  if (line.placed.takeId === line.chosen) return `Take ${chosen} is on the timeline.`;
  const placed = number(line.placed.takeId);
  return `Take ${chosen} is chosen; ${placed > 0 ? `take ${placed}` : "another take"} is on the timeline.`;
};

/** The takes of one line: pick one, hear one, delete one, or bring one in. */
function Takes(
  props: LineVoiceOverActions & {
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
    readonly mediaRoot: string;
    readonly line: VideoVoiceOverBeat;
    readonly canWrite: boolean;
    readonly disabled: boolean;
  },
) {
  const { line } = props;
  const resources = line.takes.map((take): AssetResource => ({
    _tag: "draft-workspace-file",
    cwd: props.workspaceRoot,
    path: `${props.mediaRoot.replace(/\/$/, "")}/${take.path}`,
  }));
  const urls = useAssetUrls(props.environmentId, resources);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const silence = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(null);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A take playing when the popover closes must stop with it.
  useEffect(() => () => audioRef.current?.pause(), []);

  const audition = (takeId: string, url: string) => {
    silence();
    if (playing === takeId) return;
    const audio = new Audio(url);
    audio.addEventListener("ended", () => {
      if (audioRef.current === audio) silence();
    });
    audioRef.current = audio;
    setPlaying(takeId);
    void audio.play().catch(() => {
      if (audioRef.current === audio) silence();
    });
  };

  const unplaced = line.chosen !== null && line.placed?.takeId !== line.chosen;

  return (
    <div className="flex flex-col gap-2">
      <PopoverTitle>Voice-over</PopoverTitle>
      <p className="text-xs leading-4 text-muted-foreground">{voiceOverStatus(line)}</p>
      {line.takes.length > 0 ? (
        <ul role="radiogroup" aria-label="Takes" className="-mx-1.5 flex flex-col">
          {line.takes.map((take, index) => {
            const chosen = take.id === line.chosen;
            const placed = take.id === line.placed?.takeId;
            const url = urls[index] ?? null;
            const label = `Take ${index + 1}`;
            if (confirming === take.id) {
              return (
                <li key={take.id} className="flex items-center gap-1 px-1.5 py-0.5 text-xs">
                  <span className="min-w-0 flex-1 truncate">Delete {label.toLowerCase()}?</span>
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    onClick={() => {
                      setConfirming(null);
                      props.onDelete(take.id);
                    }}
                  >
                    Delete
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setConfirming(null)}>
                    Keep
                  </Button>
                </li>
              );
            }
            return (
              <li key={take.id} className="flex items-center gap-0.5">
                <button
                  type="button"
                  role="radio"
                  aria-checked={chosen}
                  disabled={!props.canWrite || props.disabled}
                  onClick={() => {
                    if (!chosen) props.onChoose(take.id);
                  }}
                  className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-left text-xs outline-none hover:bg-accent/70 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default disabled:hover:bg-transparent"
                >
                  <span
                    aria-hidden
                    className={cn(
                      "size-2.5 shrink-0 rounded-xs border",
                      chosen ? "border-primary dither-block text-primary" : "border-input",
                    )}
                  />
                  <span className="shrink-0">{label}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {take.seconds.toFixed(1)}s
                  </span>
                  <span className="min-w-0 truncate bay-label text-muted-foreground">
                    {placed ? "on timeline" : take.source === "recorded" ? "" : take.source}
                  </span>
                </button>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={playing === take.id ? `Stop ${label}` : `Play ${label}`}
                  disabled={url === null}
                  onClick={() => {
                    if (url !== null) audition(take.id, url);
                  }}
                >
                  {playing === take.id ? <SquareIcon /> : <PlayIcon />}
                </Button>
                {props.canWrite ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="icon-xs"
                          variant="ghost-destructive"
                          aria-label={`Delete ${label}`}
                          aria-disabled={placed || props.disabled}
                          onClick={() => {
                            if (!placed && !props.disabled) setConfirming(take.id);
                          }}
                        />
                      }
                    >
                      <Trash2Icon />
                    </TooltipTrigger>
                    <TooltipPopup side="left">
                      {placed
                        ? "On the timeline. Choose another take first."
                        : `Delete ${label.toLowerCase()}`}
                    </TooltipPopup>
                  </Tooltip>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {props.canWrite ? (
        <div className="flex flex-wrap gap-1">
          {unplaced ? (
            <Button size="xs" disabled={props.disabled} onClick={props.onPlace}>
              Place on timeline
            </Button>
          ) : null}
          <Button size="xs" variant="outline" disabled={props.disabled} onClick={props.onRecord}>
            <MicIcon />
            Record
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={props.disabled}
            onClick={() => fileRef.current?.click()}
          >
            <UploadIcon />
            Import
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="audio/*,video/mp4,video/quicktime"
            aria-label="Audio file to import as a take"
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file !== undefined) props.onImport(file);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * A script line's voice-over, at the end of its row: record it, and see and switch its takes.
 * The mark is green when the chosen take is on the timeline and amber when it isn't.
 */
export function ScriptLineVoiceOver(
  props: LineVoiceOverActions & {
    readonly environmentId: EnvironmentId;
    readonly workspaceRoot: string;
    readonly mediaRoot: string;
    readonly line: VideoVoiceOverBeat;
    readonly state: "idle" | "recording" | "busy";
    /** Another line is recording or being saved. */
    readonly disabled: boolean;
    readonly canWrite: boolean;
  },
) {
  const { line, state } = props;
  const [open, setOpen] = useState(false);
  if (!props.canWrite && line.takes.length === 0) return null;
  const count = line.takes.length;
  const placed = line.chosen !== null && line.placed?.takeId === line.chosen;
  return (
    <span className="flex shrink-0 items-start pt-0.5">
      {state === "recording" ? (
        <Button
          size="icon-xs"
          variant="destructive"
          aria-label="Stop recording this line"
          onClick={props.onStop}
        >
          <SquareIcon />
        </Button>
      ) : state === "busy" ? (
        <span className="flex size-7 items-center justify-center sm:size-6">
          <Spinner size="xs" />
        </span>
      ) : props.canWrite ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Record this line"
                disabled={props.disabled}
                onClick={props.onRecord}
              />
            }
          >
            <MicIcon />
          </TooltipTrigger>
          <TooltipPopup side="left">Record this line</TooltipPopup>
        </Tooltip>
      ) : null}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              aria-label={`Voice-over takes: ${voiceOverStatus(line)}`}
            />
          }
        >
          <AudioLinesIcon
            className={count === 0 ? undefined : placed ? "text-success" : "text-warning"}
          />
          {count > 0 ? <span className="tabular-nums">{count}</span> : null}
        </PopoverTrigger>
        <PopoverPopup align="end" width="sm" padding="compact">
          <Takes
            environmentId={props.environmentId}
            workspaceRoot={props.workspaceRoot}
            mediaRoot={props.mediaRoot}
            line={line}
            canWrite={props.canWrite}
            disabled={props.disabled || state !== "idle"}
            onRecord={() => {
              setOpen(false);
              props.onRecord();
            }}
            onStop={props.onStop}
            onChoose={props.onChoose}
            onDelete={props.onDelete}
            onImport={(file) => {
              setOpen(false);
              props.onImport(file);
            }}
            onPlace={props.onPlace}
          />
        </PopoverPopup>
      </Popover>
    </span>
  );
}
