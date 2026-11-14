import type { VideoProjectSyncResult, VideoTranscriptStatus } from "@t3tools/contracts";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import type { PremierePull } from "./premiereChanges";
import { DROPPED_EDITS_TITLE, PremiereChangeList, pullTitle } from "./PremierePullNotice";

export interface PremiereSyncStatus {
  readonly link: Pick<
    VideoProjectSyncResult,
    "state" | "premiereSavedAt" | "premiereRunning" | "pending"
  > | null;
  /** The last sync that changed anything, still listed here after its notice is dismissed. */
  readonly lastPull: PremierePull | null;
  /** Edits in the viewer that aren't saved to the timeline file; replacing the file drops them. */
  readonly uncommittedEdits: boolean;
  readonly syncing: boolean;
  /** Proxies still being made, or null when none are. */
  readonly building: { readonly done: number; readonly total: number } | null;
  /** Media files the last proxy build couldn't read. */
  readonly failedProxies: number;
  /** Why previews are missing: the build's own error, and each failed file with its reason. */
  readonly proxyProblems?: {
    readonly error: string | null;
    readonly failures: ReadonlyArray<readonly [name: string, reason: string]>;
  };
  /** Names of clips whose frame rate changes partway. */
  readonly rateChanging: ReadonlyArray<string>;
  readonly proxied: boolean;
  /** Absent when this connection can't write to the project. */
  readonly onSync?: () => void;
  readonly onUsePremiere?: () => void;
  readonly onMerge?: () => void;
  /** Null until the project's transcript status has been written. */
  readonly transcripts: VideoTranscriptStatus | null;
  /** Absent when this connection can't write to the project. */
  readonly onTranscribe?: () => void;
}

type State = VideoProjectSyncResult["state"];

const FAILURES_SHOWN = 4;

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
      return `This timeline matches Premiere's last save${savedAt(time)}.`;
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

const transcriptLine = (status: VideoTranscriptStatus | null): string => {
  if (status === null) return "Transcripts: none yet.";
  if (status.building !== null) {
    return `Transcribing${status.building.total > 0 ? ` ${status.building.done} of ${status.building.total}` : ""}.`;
  }
  if (status.unavailable !== null) return status.unavailable;
  return `Transcripts: ${status.ready} of ${status.total}.`;
};

/** The Premiere pill in the preview's transport row: sync state at a glance, details on click. */
export function PremiereSyncBadge(props: PremiereSyncStatus) {
  const state = props.link?.state ?? null;
  const inSync = state === "current" || state === "updated";
  const diverged = state === "edited" || state === "conflict";
  const pending = props.link?.pending ?? [];
  const { lastPull } = props;
  const short = props.syncing ? "Syncing" : state === null ? null : SHORT[state];
  const { building, transcripts } = props;
  const failedTranscripts = transcripts?.failed.length ?? 0;
  const canTranscribe =
    props.onTranscribe !== undefined &&
    (transcripts === null ||
      (transcripts.building === null &&
        transcripts.unavailable === null &&
        transcripts.ready < transcripts.total));
  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={`Premiere sync${short === null ? "" : `: ${short}`}`}
            aria-busy={props.syncing}
            className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm px-1.5 text-2xs text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-popup-open:bg-accent"
          />
        }
      >
        <span className="flex h-4 items-center rounded-xs bg-premiere-bg px-1 font-bold text-premiere">
          Pr
        </span>
        {short !== null && !props.syncing ? <span className="bay-label">{short}</span> : null}
        {props.syncing ? (
          <Spinner size="xs" />
        ) : (
          <span
            aria-hidden
            className={cn("size-1.5", state === null ? "bg-warning" : DOT[state])}
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
          {inSync ? (
            <p className="text-muted-foreground">
              {props.link?.premiereRunning === true
                ? "Premiere is open. Saves there are pulled in when you come back here."
                : "Save in Premiere and come back here to pull your changes."}
            </p>
          ) : null}
          {props.link?.premiereRunning === false ? (
            <p className="text-warning">
              Premiere isn't open on this machine. An agent can read and edit this timeline, but
              can't change the Premiere sequence until you open it.
            </p>
          ) : null}
          {diverged && pending.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="font-medium">Not in Premiere yet</span>
              <PremiereChangeList items={pending} limit={4} />
            </div>
          ) : null}
          {state === "edited" ? (
            <p className="text-muted-foreground">
              An agent can apply these to the open Premiere sequence. Ask it to push the timeline to
              Premiere. Taking Premiere's version keeps yours as a version in History.
            </p>
          ) : null}
          {state === "conflict" ? (
            <p className="text-muted-foreground">
              Merge takes Premiere's save and puts your edits back on top. The timeline from before
              the merge stays in History, as it does when you take Premiere's version.
            </p>
          ) : null}
          {diverged && props.uncommittedEdits && props.onUsePremiere ? (
            <p className="text-warning">
              Save or discard your pending edits first. Replacing the timeline would drop them.
            </p>
          ) : null}
          {lastPull !== null ? (
            <div className="flex flex-col gap-1">
              <span className="font-medium">{pullTitle(lastPull)}</span>
              {lastPull.changes.length > 0 ? (
                <PremiereChangeList items={lastPull.changes} limit={3} />
              ) : null}
              {lastPull.conflicts.length > 0 ? (
                <>
                  <span className="text-warning">{DROPPED_EDITS_TITLE}</span>
                  <PremiereChangeList items={lastPull.conflicts} limit={3} />
                </>
              ) : null}
            </div>
          ) : null}
          <p className="text-muted-foreground">
            {building !== null
              ? `Making previews${building.total > 0 ? `: ${building.done} of ${building.total}` : ""}. Clips without one play from the original file until then.`
              : props.proxied
                ? "Draft preview from proxies."
                : "Draft preview from the original files."}{" "}
            {props.failedProxies > 0
              ? `${props.failedProxies} ${props.failedProxies === 1 ? "file has" : "files have"} no preview. `
              : ""}
            Presets and plugin effects render in Premiere.
          </p>
          {props.proxyProblems?.error ? (
            <p className="text-warning">{props.proxyProblems.error}</p>
          ) : null}
          {props.proxyProblems !== undefined && props.proxyProblems.failures.length > 0 ? (
            <ul className="flex flex-col gap-0.5 text-warning">
              {props.proxyProblems.failures.slice(0, FAILURES_SHOWN).map(([name, reason]) => (
                <li key={name} className="break-words">
                  {name}: {reason}
                </li>
              ))}
              {props.proxyProblems.failures.length > FAILURES_SHOWN ? (
                <li>and {props.proxyProblems.failures.length - FAILURES_SHOWN} more</li>
              ) : null}
            </ul>
          ) : null}
          {props.rateChanging.length > 0 ? (
            <p className="text-warning">
              {props.rateChanging.join(", ")}{" "}
              {props.rateChanging.length === 1 ? "changes" : "change"} frame rate partway. Conform{" "}
              {props.rateChanging.length === 1 ? "it" : "them"} to one rate before cutting by
              transcript, or cuts land on the wrong frame.
            </p>
          ) : null}
          <p className="text-muted-foreground">
            {transcriptLine(transcripts)}
            {failedTranscripts > 0
              ? ` ${failedTranscripts} ${failedTranscripts === 1 ? "file" : "files"} could not be transcribed.`
              : ""}
          </p>
          {props.onSync || canTranscribe ? (
            <div className="flex flex-wrap gap-1">
              {state === "conflict" && props.onMerge ? (
                <Button
                  size="xs"
                  disabled={props.syncing || props.uncommittedEdits}
                  onClick={props.onMerge}
                >
                  Merge
                </Button>
              ) : null}
              {props.onSync ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={props.syncing || state === "unlinked"}
                  onClick={props.onSync}
                >
                  Sync now
                </Button>
              ) : null}
              {diverged && props.onUsePremiere ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={props.syncing || props.uncommittedEdits}
                  onClick={props.onUsePremiere}
                >
                  Use Premiere's version
                </Button>
              ) : null}
              {canTranscribe ? (
                <Button size="xs" variant="outline" onClick={props.onTranscribe}>
                  Transcribe
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
