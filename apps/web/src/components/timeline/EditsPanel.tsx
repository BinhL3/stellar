import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  VideoTimelineEditRecord,
  VideoTimelineEdits,
  VideoTimelineReviewEditInput,
} from "@t3tools/contracts";
import {
  CheckIcon,
  CircleCheckIcon,
  HeadphonesIcon,
  MessageSquarePlusIcon,
  Redo2Icon,
  Undo2Icon,
} from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Kbd } from "~/components/ui/kbd";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";

import { Bay } from "./bay";
import type { VersionPreview } from "./HistoryPanel";
import { useTimelineEditsStore } from "./timelineEditsStore";
import {
  actionsFor,
  comboFromEvent,
  comboLabel,
  combosFor,
  useTimelineKeymap,
} from "./timelineKeymap";
import { useTimelinePlayer } from "./timelinePlayer";
import { PanelTools } from "./TimelineWorkspace";

const LISTEN_PAD_SECONDS = 2;

const clock = (frame: number, rate: number) => {
  const seconds = Math.floor(frame / rate);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const needsYou = (edit: VideoTimelineEditRecord) => edit.check !== null && edit.decision === null;

/** A range to play once the Monitor shows `version` (null for the timeline as it is now). */
interface Cue {
  readonly version: string | null;
  readonly from: number;
  readonly to: number;
}

/**
 * The agent's edits, newest first, each with what it says it did. Choosing one moves the
 * playhead to it; from there it is kept, taken out on its own, or handed back to the agent.
 */
export function EditsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly timeline: string;
  /** Changes whenever the timeline's saved text does; the list is read again then. */
  readonly revision: string;
  readonly canWrite: boolean;
  /** Uncommitted edits in the tab, which a change to the timeline's file would be made under. */
  readonly pendingEdits: boolean;
  readonly preview: VersionPreview | null;
  readonly onPreview: (preview: VersionPreview | null) => void;
  /** The timeline's file was rewritten. */
  readonly onTimelineChanged: () => void;
  /** Present where a chat is open: puts a reference to the edit in the composer. */
  readonly onRevise?: (description: string) => void;
}) {
  const listEdits = useAtomCommand(projectEnvironment.listVideoTimelineEdits, {
    reportFailure: false,
  });
  const reviewEdit = useAtomCommand(projectEnvironment.reviewVideoTimelineEdit, {
    reportFailure: false,
  });
  const readVersion = useAtomCommand(projectEnvironment.readVideoTimelineVersion, {
    reportFailure: false,
  });
  const player = useTimelinePlayer();
  const shortcuts = useTimelineKeymap();
  const [loaded, setLoaded] = useState<{
    /** The timeline text the list was read for. */
    readonly revision: string;
    readonly view: VideoTimelineEdits | null;
    readonly error: string | null;
  } | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState<{
    readonly edit: number;
    readonly message: string;
    readonly canRestore: boolean;
  } | null>(null);
  // The edit whose removed footage is on show; the next listen plays its join instead.
  const [heardRemoved, setHeardRemoved] = useState<number | null>(null);
  const [cue, setCue] = useState<Cue | null>(null);
  const { revision, preview } = props;
  const scope = { workspaceRoot: props.workspaceRoot, timeline: props.timeline };

  const list = useEffectEvent(() =>
    listEdits({ environmentId: props.environmentId, input: scope }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The edits are kept by the server; they are read again whenever the timeline's saved text changes.
  useEffect(() => {
    let current = true;
    void list().then((result) => {
      if (!current) return;
      if (result._tag === "Success") setLoaded({ revision, view: result.value, error: null });
      else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setLoaded({
          revision,
          view: null,
          error: error instanceof Error ? error.message : "Could not read the edits.",
        });
      }
    });
    return () => {
      current = false;
    };
  }, [revision]);

  const edits = loaded?.view?.edits ?? [];
  const selected = edits.find((edit) => edit.number === selectedNumber) ?? null;
  const shownVersion = preview?.version.id ?? null;

  const playCue = useEffectEvent((range: Cue) => player.play(range.from, range.to));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Starts the preview engine, which lives outside React, once the Monitor shows the version the cue is for.
  useEffect(() => {
    if (cue === null || cue.version !== shownVersion) return;
    let current = true;
    // After this commit's other effects, one of which hands the engine the version to play.
    queueMicrotask(() => {
      if (!current) return;
      playCue(cue);
      setCue(null);
    });
    return () => {
      current = false;
    };
  }, [cue, shownVersion]);

  const pad = Math.round(LISTEN_PAD_SECONDS * player.rate);
  const listen = async (edit: VideoTimelineEditRecord | null) => {
    const removed = edit?.removed ?? null;
    if (edit === null || removed === null) return;
    if (heardRemoved === edit.number && shownVersion !== null) {
      setHeardRemoved(null);
      props.onPreview(null);
      const join = edit.frame ?? removed.start;
      setCue({ version: null, from: join - pad, to: join + pad });
      return;
    }
    if (edit.before === null) {
      toastManager.add({
        type: "info",
        title: `What E${edit.number} removed is no longer in the history`,
      });
      return;
    }
    const result = await readVersion({
      environmentId: props.environmentId,
      input: { ...scope, version: edit.before },
    });
    if (result._tag !== "Success") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({ type: "error", title: "Could not read the version before that edit" });
      }
      return;
    }
    setHeardRemoved(edit.number);
    props.onPreview(result.value);
    setCue({ version: edit.before, from: removed.start - pad, to: removed.end + pad });
  };
  const listenNow = useEffectEvent(() => void listen(selected));
  const canListen = selected !== null && selected.removed !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publishes the listen action to the store the timeline's keys and the command palette read.
  useEffect(() => {
    if (!canListen) return;
    const run = () => listenNow();
    useTimelineEditsStore.getState().setListen(run);
    return () => {
      if (useTimelineEditsStore.getState().listen === run) {
        useTimelineEditsStore.getState().setListen(null);
      }
    };
  }, [canListen]);

  const select = (edit: VideoTimelineEditRecord) => {
    setSelectedNumber(edit.number === selectedNumber ? null : edit.number);
    setHeardRemoved(null);
    if (preview !== null) props.onPreview(null);
    if (edit.frame !== null) player.seek(edit.frame);
  };

  const review = async (
    edit: VideoTimelineEditRecord,
    action: VideoTimelineReviewEditInput["action"],
  ) => {
    const rewrites = action !== "keep" && action !== "reopen";
    if (rewrites && props.pendingEdits) {
      toastManager.add({
        type: "info",
        title: "Commit or discard your edits first",
        description: "This rewrites the timeline they were made on.",
      });
      return;
    }
    setBusy(true);
    const result = await reviewEdit({
      environmentId: props.environmentId,
      input: { ...scope, edit: edit.number, action },
    });
    setBusy(false);
    if (result._tag !== "Success") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: `Could not change E${edit.number}`,
        description: error instanceof Error ? error.message : "Try again in a moment.",
      });
      return;
    }
    const { blocked: reason, ...view } = result.value;
    setLoaded({ revision, view, error: null });
    setBlocked(
      reason === null
        ? null
        : {
            edit: edit.number,
            message: reason,
            canRestore: action === "undo" && edit.before !== null,
          },
    );
    if (reason === null && rewrites) {
      setHeardRemoved(null);
      props.onPreview(null);
      props.onTimelineChanged();
    }
  };

  if (loaded === null) {
    return (
      <div className="flex h-full items-center justify-center bg-card text-muted-foreground">
        <Spinner />
      </div>
    );
  }
  if (edits.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{loaded.error === null ? "No edits yet" : "No edits to show"}</EmptyTitle>
          {loaded.error === null ? null : <EmptyDescription>{loaded.error}</EmptyDescription>}
        </EmptyHeader>
      </Empty>
    );
  }
  const waiting = edits.filter(needsYou).length;
  const [listenKey] = combosFor(shortcuts.keymap, "listenToCut");
  return (
    <div
      className="flex h-full min-h-0 flex-col bg-card text-card-foreground"
      onKeyDown={(event) => {
        const combo = comboFromEvent(event);
        if (combo === null || !canListen) return;
        if (actionsFor(shortcuts.keymap, combo)[0] !== "listenToCut") return;
        event.preventDefault();
        void listen(selected);
      }}
    >
      {waiting > 0 ? (
        <PanelTools panel="edits">
          <span className="flex items-center gap-1.5 px-1.5 bay-label text-primary">
            <Bay.Mark />
            {waiting} to review
          </span>
        </PanelTools>
      ) : null}
      <ol className="flex min-h-0 flex-1 flex-col gap-px overflow-auto px-1.5 pb-1.5">
        {edits.map((edit) => {
          const isSelected = edit.number === selectedNumber;
          const undone = edit.decision === "undone";
          const kept = edit.decision === "kept";
          const waitingOnYou = needsYou(edit);
          const stuck = blocked?.edit === edit.number ? blocked : null;
          const hearingRemoved = heardRemoved === edit.number && shownVersion !== null;
          return (
            <Bay.Item
              key={edit.number}
              selected={isSelected}
              className={cn(!isSelected && "hover:bg-accent/70")}
            >
              <div className="flex items-start">
                <Bay.ItemButton
                  selected={isSelected}
                  aria-expanded={isSelected}
                  onClick={() => select(edit)}
                  className="min-w-0 flex-1 hover:bg-transparent"
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-4 w-7 shrink-0 items-center justify-center rounded-xs border font-mono text-2xs leading-none tabular-nums",
                      waitingOnYou
                        ? "border-primary/60 text-primary"
                        : "border-border text-muted-foreground",
                    )}
                  >
                    E{edit.number}
                    {waitingOnYou ? <span className="sr-only"> needs you</span> : null}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span
                      className={cn(
                        "leading-5 wrap-anywhere",
                        !isSelected && "line-clamp-2",
                        kept && "text-foreground/80",
                        undone && "text-muted-foreground line-through",
                      )}
                    >
                      {edit.summary}
                    </span>
                    {edit.check !== null && (isSelected || edit.decision === null) ? (
                      <span
                        className={cn(
                          "text-xs wrap-anywhere",
                          edit.decision === null ? "text-primary" : "text-muted-foreground",
                        )}
                      >
                        {edit.check}
                      </span>
                    ) : null}
                    {edit.frame === null ? null : (
                      <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                        {clock(edit.frame, player.rate)}
                      </span>
                    )}
                  </span>
                </Bay.ItemButton>
                <span className="flex shrink-0 items-center gap-0.5 py-1 pr-1">
                  {edit.removed !== null ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={
                              hearingRemoved
                                ? `Hear the join E${edit.number} left`
                                : `Hear what E${edit.number} removed`
                            }
                            onClick={() => {
                              if (!isSelected) setSelectedNumber(edit.number);
                              void listen(edit);
                            }}
                          />
                        }
                      >
                        <HeadphonesIcon />
                      </TooltipTrigger>
                      <TooltipPopup side="top">
                        {hearingRemoved ? "Hear the join as it is now" : "Hear what it removed"}
                        {listenKey === undefined ? null : (
                          <>
                            {" "}
                            <Kbd>{comboLabel(listenKey)}</Kbd>
                          </>
                        )}
                      </TooltipPopup>
                    </Tooltip>
                  ) : null}
                  {props.canWrite && !undone ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant={waitingOnYou ? "default" : "ghost"}
                            aria-label={kept ? `Reopen E${edit.number}` : `Keep E${edit.number}`}
                            aria-pressed={kept}
                            disabled={busy}
                            onClick={() => void review(edit, kept ? "reopen" : "keep")}
                          />
                        }
                      >
                        {kept ? <CircleCheckIcon className="text-success" /> : <CheckIcon />}
                      </TooltipTrigger>
                      <TooltipPopup side="top">{kept ? "Kept. Reopen" : "Keep"}</TooltipPopup>
                    </Tooltip>
                  ) : null}
                  {props.canWrite ? (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={
                              undone ? `Put E${edit.number} back` : `Undo E${edit.number}`
                            }
                            disabled={busy}
                            onClick={() => void review(edit, undone ? "redo" : "undo")}
                          />
                        }
                      >
                        {undone ? <Redo2Icon /> : <Undo2Icon />}
                      </TooltipTrigger>
                      <TooltipPopup side="top">
                        {undone ? "Undone. Put back" : "Undo this edit"}
                      </TooltipPopup>
                    </Tooltip>
                  ) : null}
                </span>
              </div>
              {isSelected && (stuck !== null || props.onRevise) ? (
                <div className="mr-2 mb-2 ml-11 flex flex-col items-start gap-2 text-xs">
                  {stuck !== null ? (
                    <div role="alert" className="flex flex-col items-start gap-1.5">
                      <p className="wrap-anywhere text-warning">{stuck.message}</p>
                      {stuck.canRestore && props.canWrite ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => void review(edit, "restoreBefore")}
                        >
                          Restore the version before E{edit.number}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {props.onRevise ? (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => props.onRevise?.(`edit E${edit.number} (“${edit.summary}”): `)}
                    >
                      <MessageSquarePlusIcon />
                      Revise
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </Bay.Item>
          );
        })}
      </ol>
    </div>
  );
}
