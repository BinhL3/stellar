import type { VideoProjectSyncResult } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";

export interface PremiereSyncStatus {
  readonly link: Pick<
    VideoProjectSyncResult,
    "state" | "premiereSavedAt" | "premiereRunning"
  > | null;
  readonly syncing: boolean;
  /** Proxies still being made, or null when none are. */
  readonly building: { readonly done: number; readonly total: number } | null;
  /** Media files the last proxy build couldn't read. */
  readonly failedProxies: number;
  /** Names of clips whose frame rate changes partway. */
  readonly rateChanging: ReadonlyArray<string>;
  readonly proxied: boolean;
  /** Absent when this connection can't write to the project. */
  readonly onSync?: () => void;
  readonly onUsePremiere?: () => void;
}

type State = VideoProjectSyncResult["state"];

const SHORT: Record<State, string | null> = {
  current: null,
  updated: null,
  edited: "Edited here",
  conflict: "Conflict",
  offline: "Offline",
  unlinked: "Not linked",
};

const DOT: Record<State, string> = {
  current: "bg-success",
  updated: "bg-success",
  edited: "bg-warning",
  conflict: "bg-destructive",
  offline: "bg-muted-foreground",
  unlinked: "bg-muted-foreground",
};

const savedAt = (time: number | null) =>
  time === null
    ? ""
    : ` (${new Date(time).toLocaleString([], {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })})`;

const explain = (state: State, time: number | null): string => {
  switch (state) {
    case "current":
    case "updated":
      return `This timeline matches Premiere's last save${savedAt(time)}. Save in Premiere and come back here to pull your changes.`;
    case "edited":
      return "This timeline has edits made here that aren't in Premiere yet. Premiere hasn't changed since the last pull.";
    case "conflict":
      return `This timeline was edited here, and Premiere saved a different version${savedAt(time)}. Nothing was overwritten.`;
    case "offline":
      return "The Premiere project can't be read. Its drive may be unplugged, or the file was moved.";
    case "unlinked":
      return "This project isn't linked to a Premiere project. Start a new video project from its .prproj to link it.";
  }
};

/** The Premiere pill in the preview's transport row: sync state at a glance, details on click. */
export function PremiereSyncBadge(props: PremiereSyncStatus) {
  const state = props.link?.state ?? null;
  const short = props.syncing ? "Syncing" : state === null ? null : SHORT[state];
  const { building } = props;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Premiere sync"
            className="flex h-5 shrink-0 items-center gap-1 rounded-sm bg-premiere-bg px-1 text-2xs font-bold text-premiere outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          />
        }
      >
        Pr
        {short !== null ? <span className="font-medium">{short}</span> : null}
        {props.syncing ? (
          <Spinner size="xs" />
        ) : (
          <span
            aria-hidden
            className={cn("size-1.5 rounded-full", state === null ? "bg-warning" : DOT[state])}
          />
        )}
      </PopoverTrigger>
      <PopoverPopup side="top" align="end" className="w-72">
        <div className="flex flex-col gap-2 text-xs">
          <p>
            {state === null
              ? "Checking Premiere for a newer save."
              : explain(state, props.link?.premiereSavedAt ?? null)}
          </p>
          {props.link?.premiereRunning === false ? (
            <p className="text-warning">
              Premiere isn't open on this machine. An agent can read and edit this timeline, but
              can't change the Premiere sequence until you open it.
            </p>
          ) : null}
          {state === "edited" || state === "conflict" ? (
            <p className="text-muted-foreground">
              Sending edits to Premiere isn't built yet. Taking Premiere's version keeps yours in
              timelines/replaced.
            </p>
          ) : null}
          <p className="text-muted-foreground">
            {building !== null
              ? `Making previews${building.total > 0 ? `: ${building.done} of ${building.total}` : ""}. Clips without one play from the original file until then.`
              : props.proxied
                ? "Draft preview from proxies."
                : "Draft preview from the original files."}{" "}
            {props.failedProxies > 0
              ? `${props.failedProxies} ${props.failedProxies === 1 ? "file has" : "files have"} no preview; check that the media is online and ffmpeg is installed. `
              : ""}
            Presets and plugin effects render in Premiere.
          </p>
          {props.rateChanging.length > 0 ? (
            <p className="text-warning">
              {props.rateChanging.join(", ")}{" "}
              {props.rateChanging.length === 1 ? "changes" : "change"} frame rate partway. Conform{" "}
              {props.rateChanging.length === 1 ? "it" : "them"} to one rate before cutting by
              transcript, or cuts land on the wrong frame.
            </p>
          ) : null}
          {props.onSync ? (
            <div className="flex flex-wrap gap-1">
              <Button
                size="xs"
                variant="outline"
                disabled={props.syncing || state === "unlinked"}
                onClick={props.onSync}
              >
                Sync now
              </Button>
              {(state === "edited" || state === "conflict") && props.onUsePremiere ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={props.syncing}
                  onClick={props.onUsePremiere}
                >
                  Use Premiere's version
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
