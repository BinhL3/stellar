import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ScopedThreadRef,
  VideoScriptBeat,
  VideoScriptView,
  VideoVoiceOverView,
} from "@t3tools/contracts";
import { FOOTAGE_TIMELINE_PATH } from "@t3tools/timeline/footage";
import {
  ClipboardPasteIcon,
  ExternalLinkIcon,
  RefreshCwIcon,
  ScrollTextIcon,
  XIcon,
} from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
} from "react";

import { canOpenLinksInApp, isWebUrl } from "~/browser/browserLinkTarget";
import { openUrlInPreview } from "~/browser/openFileInPreview";
import { recordVisitForThread } from "~/browserHistoryStore";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { previewEnvironment } from "~/state/preview";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useVoiceRecorder } from "../videoProject/useVoiceRecorder";
import { MAX_IMPORT_BYTES, ScriptLineVoiceOver } from "./ScriptLineVoiceOver";
import { beatAtFrame, beatTime, groupBeatsBySection } from "./scriptBeats";
import { useTimelinePlayer } from "./timelinePlayer";

const DOC_LINK_ID = "timeline-script-doc-link";

const failureMessage = (error: unknown) =>
  error instanceof Error && error.message.trim() !== "" ? error.message : "Try again in a moment.";

const savedLabel = (time: number) =>
  new Date(time).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/**
 * The script's lines in script order. Only this list follows the playhead, and its snapshot is
 * the current beat's id, so playback re-renders it when the beat changes, not on every frame.
 */
function BeatList(props: {
  readonly beats: ReadonlyArray<VideoScriptBeat>;
  /** What sits at the end of a line's row: its voice-over. */
  readonly trailing: (beat: VideoScriptBeat) => ReactNode;
}) {
  const { beats } = props;
  const player = useTimelinePlayer();
  const currentId = useSyncExternalStore(player.playhead.subscribe, () =>
    // A beat holds for up to a second of silence after its last word.
    beatAtFrame(beats, player.playhead.get(), player.rate),
  );
  return (
    <div className="flex flex-col pb-3">
      {groupBeatsBySection(beats).map((group, index) => (
        // Headings can repeat, so a section's place in the script is its identity.
        // oxlint-disable-next-line react/no-array-index-key
        <section key={index} className="flex flex-col">
          {group.section !== null ? (
            <h3 className="sticky top-0 z-10 border-b border-border/60 bg-card px-4 pt-3 pb-1.5 text-xs font-semibold text-foreground">
              {group.section}
            </h3>
          ) : null}
          <div className="flex flex-col gap-px px-2 pt-1.5">
            {group.beats.map((beat) => {
              const { startFrame } = beat;
              if (startFrame === null) {
                return (
                  <div key={beat.id} className="flex items-start gap-0.5">
                    <p className="flex min-w-0 flex-1 gap-2 rounded-md px-2 py-1.5 text-sm leading-5 text-muted-foreground">
                      <span
                        aria-hidden
                        className="w-9 shrink-0 font-mono text-2xs leading-5 text-muted-foreground/60"
                      >
                        –:––
                      </span>
                      <span className="min-w-0 wrap-anywhere">{beat.text}</span>
                      <span className="sr-only">Not on the timeline</span>
                    </p>
                    {props.trailing(beat)}
                  </div>
                );
              }
              const current = beat.id === currentId;
              return (
                <div key={beat.id} className="flex items-start gap-0.5">
                  <button
                    type="button"
                    aria-current={current ? "true" : undefined}
                    onClick={() => player.seek(startFrame)}
                    className={cn(
                      "relative flex min-w-0 flex-1 cursor-pointer gap-2 rounded-md px-2 py-1.5 text-left text-sm leading-5 text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                      "before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full",
                      current ? "bg-primary/10 before:bg-primary" : "hover:bg-accent",
                    )}
                  >
                    <span
                      className={cn(
                        "w-9 shrink-0 font-mono text-2xs leading-5 tabular-nums",
                        current ? "font-medium text-primary" : "text-muted-foreground",
                      )}
                    >
                      {beatTime(startFrame, player.rate)}
                    </span>
                    <span className="min-w-0 wrap-anywhere">{beat.text}</span>
                  </button>
                  {props.trailing(beat)}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

/** A read's answer, with what it was read for, so a newer request shows as still reading. */
interface Loaded {
  readonly revision: string;
  readonly transcribed: number;
  readonly reloads: number;
  readonly view: VideoScriptView | null;
  readonly error: string | null;
  /** Each line's takes; null when they couldn't be read, and the lines then show none. */
  readonly voice: VideoVoiceOverView | null;
}

/**
 * The script beside the timeline: each line sits where it is said, a click moves the playhead
 * there, and the line being said is marked. The script itself is written in a Google Doc; the
 * project keeps a snapshot, replaced by pasting here or by an agent.
 */
export function ScriptPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  /** The timeline the beats are placed on, as a path from `timelines`. */
  readonly timeline: string;
  /** Changes whenever the timeline's saved text does; the beats are placed again then. */
  readonly revision: string;
  /** How many media files have transcripts; new ones can place more beats. */
  readonly transcribed: number;
  /** Where the Google Doc opens: this thread's Browser tab, when the app has one. */
  readonly threadRef: ScopedThreadRef;
  readonly canWrite: boolean;
  /** The timeline has edits that aren't saved; placing a take would rewrite the file under them. */
  readonly pendingEdits: boolean;
  /** A take was placed, so the timeline's file changed on the server. */
  readonly onTimelineChanged: () => void;
  /** Told the beats each time they are read, so the ruler can mark where lines start. */
  readonly onBeats?: (beats: ReadonlyArray<VideoScriptBeat>) => void;
  readonly onClose: () => void;
}) {
  const readScript = useAtomCommand(projectEnvironment.readVideoScript, { reportFailure: false });
  const saveScript = useAtomCommand(projectEnvironment.saveVideoScript, { reportFailure: false });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reloads, setReloads] = useState(0);
  const [saving, setSaving] = useState(false);
  const [pasted, setPasted] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const readVoice = useAtomCommand(projectEnvironment.readVideoVoiceOver, { reportFailure: false });
  const saveTake = useAtomCommand(projectEnvironment.saveVideoTake, { reportFailure: false });
  const chooseTake = useAtomCommand(projectEnvironment.chooseVideoTake, { reportFailure: false });
  const deleteTake = useAtomCommand(projectEnvironment.deleteVideoTake, { reportFailure: false });
  const applyVoice = useAtomCommand(projectEnvironment.applyVideoVoiceOver, {
    reportFailure: false,
  });
  const recorder = useVoiceRecorder();
  // The one line being recorded or saved; the others wait.
  const [activeLine, setActiveLine] = useState<{
    readonly beatId: string;
    readonly state: "recording" | "busy";
  } | null>(null);

  const { revision, transcribed } = props;
  const read = useEffectEvent(() =>
    readScript({
      environmentId: props.environmentId,
      input: { workspaceRoot: props.workspaceRoot, timeline: props.timeline },
    }),
  );
  const publishBeats = useEffectEvent((beats: ReadonlyArray<VideoScriptBeat>) =>
    props.onBeats?.(beats),
  );
  const readTakes = useEffectEvent(() =>
    readVoice({
      environmentId: props.environmentId,
      input: { workspaceRoot: props.workspaceRoot, timeline: props.timeline },
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The script and where its lines fall are worked out on the server; they are read again when the timeline's text, the transcripts or the snapshot change.
  useEffect(() => {
    let current = true;
    void Promise.all([read(), readTakes()]).then(([result, takes]) => {
      if (!current) return;
      const request = {
        revision,
        transcribed,
        reloads,
        voice: takes._tag === "Success" ? takes.value : null,
      };
      if (result._tag === "Success") {
        setLoaded({ ...request, view: result.value, error: null });
        publishBeats(result.value.beats);
      } else {
        const error = isAtomCommandInterrupted(result)
          ? "Reading was interrupted."
          : failureMessage(squashAtomCommandFailure(result));
        setLoaded({ ...request, view: null, error });
      }
    });
    return () => {
      current = false;
    };
  }, [revision, transcribed, reloads]);
  const reading =
    loaded !== null &&
    (loaded.revision !== revision ||
      loaded.transcribed !== transcribed ||
      loaded.reloads !== reloads);

  const reload = () => setReloads((count) => count + 1);

  const save = async (input: { readonly text?: string; readonly docUrl?: string }) => {
    setSaving(true);
    const result = await saveScript({
      environmentId: props.environmentId,
      input: { workspaceRoot: props.workspaceRoot, ...input },
    });
    setSaving(false);
    if (result._tag === "Success") {
      // The save answers for the main timeline; read again for the one on screen.
      reload();
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not save the script",
        description: failureMessage(squashAtomCommandFailure(result)),
      });
    }
    return false;
  };

  const showVoice = (voice: VideoVoiceOverView) =>
    setLoaded((current) => (current === null ? current : { ...current, voice }));
  type VoiceResult = Awaited<ReturnType<typeof readVoice>>;
  const voiceFailed = (title: string, result: VoiceResult) => {
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    toastManager.add({
      type: "error",
      title,
      description: failureMessage(squashAtomCommandFailure(result)),
    });
  };
  const placeTake = async (beatId: string) => {
    const blocked =
      props.timeline === FOOTAGE_TIMELINE_PATH
        ? "Voice-over is placed on a cut, not on the footage timeline."
        : props.pendingEdits
          ? "Save or discard your timeline edits, then place it from this line's takes."
          : null;
    if (blocked !== null) {
      toastManager.add({
        type: "info",
        title: "The take is saved, not placed",
        description: blocked,
      });
      return;
    }
    const result = await applyVoice({
      environmentId: props.environmentId,
      input: { workspaceRoot: props.workspaceRoot, timeline: props.timeline, beatIds: [beatId] },
    });
    voiceFailed("Could not place the voice-over", result);
    if (result._tag !== "Success") return;
    showVoice(result.value);
    if (result.value.changes.length === 0) return;
    toastManager.add({
      type: "success",
      title: "Voice-over placed",
      description: result.value.changes.join(" "),
    });
    props.onTimelineChanged();
  };
  /** Runs one change to a line's takes, then puts the line's chosen take on the timeline. */
  const changeLine = async (
    beatId: string,
    title: string,
    run: () => Promise<VoiceResult>,
    place: boolean,
  ) => {
    setActiveLine({ beatId, state: "busy" });
    const result = await run();
    voiceFailed(title, result);
    if (result._tag === "Success") {
      showVoice(result.value);
      if (place) await placeTake(beatId);
    }
    setActiveLine(null);
  };
  const placeLine = async (beatId: string) => {
    setActiveLine({ beatId, state: "busy" });
    await placeTake(beatId);
    setActiveLine(null);
  };
  const lineInput = (beatId: string) => ({
    workspaceRoot: props.workspaceRoot,
    beatId,
    timeline: props.timeline,
  });
  const saveLine = (beatId: string, recording: Uint8Array, picked = false) =>
    changeLine(
      beatId,
      "Could not save the take",
      () =>
        saveTake({
          environmentId: props.environmentId,
          input: { ...lineInput(beatId), recording, ...(picked ? { picked } : {}) },
        }),
      true,
    );
  const recordLine = async (beatId: string) => {
    setActiveLine({ beatId, state: "recording" });
    const started = await recorder.start((recording) => void saveLine(beatId, recording));
    if (!started) setActiveLine(null);
  };
  const importLine = async (beatId: string, file: File) => {
    if (file.size > MAX_IMPORT_BYTES) {
      toastManager.add({
        type: "error",
        title: "That file is too large to import here",
        description:
          "Put it in the project's Audio folder and ask the agent to import it, or to split it if it reads several lines.",
      });
      return;
    }
    await saveLine(beatId, new Uint8Array(await file.arrayBuffer()), true);
  };
  const voiceLines = new Map((loaded?.voice?.beats ?? []).map((line) => [line.id, line]));
  const mediaRoot = loaded?.voice?.mediaRoot ?? null;
  const lineVoiceOver = (beat: VideoScriptBeat) => {
    const line = voiceLines.get(beat.id);
    if (line === undefined || mediaRoot === null) return null;
    return (
      <ScriptLineVoiceOver
        environmentId={props.environmentId}
        workspaceRoot={props.workspaceRoot}
        mediaRoot={mediaRoot}
        line={line}
        state={activeLine?.beatId === beat.id ? activeLine.state : "idle"}
        disabled={activeLine !== null}
        canWrite={props.canWrite}
        onRecord={() => void recordLine(beat.id)}
        onStop={recorder.stop}
        onChoose={(takeId) =>
          void changeLine(
            beat.id,
            "Could not choose the take",
            () =>
              chooseTake({
                environmentId: props.environmentId,
                input: { ...lineInput(beat.id), takeId },
              }),
            true,
          )
        }
        onDelete={(takeId) =>
          void changeLine(
            beat.id,
            "Could not delete the take",
            () =>
              deleteTake({
                environmentId: props.environmentId,
                input: { ...lineInput(beat.id), takeId },
              }),
            false,
          )
        }
        onImport={(file) => void importLine(beat.id, file)}
        onPlace={() => void placeLine(beat.id)}
      />
    );
  };

  const view = loaded?.view ?? null;
  const docUrl = view?.docUrl != null && isWebUrl(view.docUrl) ? view.docUrl : null;
  const openScript = async (event: MouseEvent, url: string) => {
    // Without an in-app browser the link opens as any other.
    if (!canOpenLinksInApp(props.threadRef)) return;
    event.preventDefault();
    const result = await openUrlInPreview({ threadRef: props.threadRef, url, openPreview });
    if (result._tag === "Success") recordVisitForThread(props.threadRef, url);
    else if (!isAtomCommandInterrupted(result)) void readLocalApi()?.shell.openExternal(url);
  };

  const placed = view?.beats.filter((beat) => beat.startFrame !== null).length ?? 0;
  const linkDraft = link ?? (view !== null && docUrl === null && props.canWrite ? "" : null);
  const linkReady = linkDraft !== null && isWebUrl(linkDraft.trim());

  const linkForm =
    linkDraft !== null && pasted === null ? (
      <form
        className="flex w-full flex-wrap items-center justify-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (!linkReady || saving) return;
          void save({ docUrl: linkDraft.trim() }).then((saved) => {
            if (saved) setLink(null);
          });
        }}
      >
        <label htmlFor={DOC_LINK_ID} className="sr-only">
          Google Doc link
        </label>
        <Input
          id={DOC_LINK_ID}
          className="min-w-0 flex-1 basis-36"
          size="compact"
          type="url"
          placeholder="Google Doc link"
          value={linkDraft}
          onChange={(event) => setLink(event.currentTarget.value)}
        />
        <Button type="submit" size="xs" variant="outline" disabled={!linkReady || saving}>
          Save link
        </Button>
        {link !== null && docUrl !== null ? (
          <Button size="xs" variant="ghost" onClick={() => setLink(null)}>
            Cancel
          </Button>
        ) : null}
      </form>
    ) : null;
  const empty = view !== null && view.beats.length === 0;

  return (
    <aside
      aria-label="Script"
      className="@container/script flex h-full min-h-0 min-w-0 flex-col bg-card text-xs"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 pr-1.5 pl-4">
        <h2 className="sr-only">Script</h2>
        {view !== null && view.beats.length > 0 ? (
          <span className="min-w-0 truncate text-2xs text-muted-foreground tabular-nums @max-[15rem]/script:hidden">
            {placed} of {view.beats.length} placed
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center">
          {docUrl !== null ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Open script"
                    render={<a href={docUrl} target="_blank" rel="noreferrer noopener" />}
                    onClick={(event) => void openScript(event, docUrl)}
                  />
                }
              >
                <ExternalLinkIcon />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Open the Google Doc</TooltipPopup>
            </Tooltip>
          ) : null}
          {props.canWrite && view !== null && !empty && pasted === null ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Paste script"
                    onClick={() => setPasted("")}
                  />
                }
              >
                <ClipboardPasteIcon />
              </TooltipTrigger>
              <TooltipPopup side="bottom">Paste script</TooltipPopup>
            </Tooltip>
          ) : null}
          {reading ? (
            <span className="flex size-6 items-center justify-center">
              <Spinner size="xs" />
            </span>
          ) : (
            <Button size="icon-xs" variant="ghost" aria-label="Reload script" onClick={reload}>
              <RefreshCwIcon />
            </Button>
          )}
          <Button size="icon-xs" variant="ghost" aria-label="Hide script" onClick={props.onClose}>
            <XIcon />
          </Button>
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {pasted !== null ? (
          <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
            <p className="text-muted-foreground">
              Paste the whole script. It replaces the snapshot kept in this project; the Google Doc
              is not changed.
            </p>
            <Textarea
              size="sm"
              rows={14}
              aria-label="Script text"
              placeholder="Paste the script here"
              value={pasted}
              onChange={(event) => setPasted(event.currentTarget.value)}
            />
            <div className="flex gap-1">
              <Button
                size="xs"
                disabled={pasted.trim() === "" || saving}
                onClick={() =>
                  void save({ text: pasted }).then((saved) => {
                    if (saved) setPasted(null);
                  })
                }
              >
                Save script
              </Button>
              <Button size="xs" variant="ghost" disabled={saving} onClick={() => setPasted(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : loaded === null ? (
          <div className="flex justify-center p-6 text-muted-foreground">
            <Spinner />
          </div>
        ) : view === null ? (
          <div role="alert" className="flex flex-col items-start gap-2 p-4">
            <p className="text-destructive">Could not read the script. {loaded.error}</p>
            <Button size="xs" variant="outline" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : empty ? (
          <Empty size="compact">
            <EmptyMedia variant="icon">
              <ScrollTextIcon />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No script yet</EmptyTitle>
              <EmptyDescription>
                {props.canWrite
                  ? "Paste the script and each line sits where it is said. An agent can also refresh it from the Google Doc."
                  : "An agent can refresh the script from the Google Doc."}
              </EmptyDescription>
            </EmptyHeader>
            {props.canWrite ? (
              <EmptyContent>
                <Button size="sm" onClick={() => setPasted("")}>
                  Paste script
                </Button>
                {linkForm ? (
                  <div className="flex w-full flex-col gap-1.5 border-t border-border/60 pt-4">
                    <p className="text-2xs text-muted-foreground">Or link its Google Doc</p>
                    {linkForm}
                  </div>
                ) : null}
              </EmptyContent>
            ) : null}
          </Empty>
        ) : (
          <BeatList beats={view.beats} trailing={lineVoiceOver} />
        )}
      </div>
      {view !== null && !empty && pasted === null ? (
        <div className="flex shrink-0 flex-col gap-2 border-t border-border/60 px-4 py-2.5">
          <div className="flex items-start gap-2">
            <p className="min-w-0 flex-1 text-2xs leading-4 text-muted-foreground">
              {view.savedAt !== null ? `Snapshot saved ${savedLabel(view.savedAt)}. ` : ""}
              {placed < view.beats.length ? "Faded lines aren't on this timeline." : ""}
            </p>
            {props.canWrite && docUrl !== null && link === null ? (
              <Button size="xs" variant="ghost" onClick={() => setLink(docUrl)}>
                Change link
              </Button>
            ) : null}
          </div>
          {linkForm}
        </div>
      ) : null}
    </aside>
  );
}
