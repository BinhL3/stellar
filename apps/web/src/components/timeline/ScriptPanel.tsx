import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ScopedThreadRef,
  VideoScriptBeat,
  VideoScriptView,
} from "@t3tools/contracts";
import { RefreshCwIcon, XIcon } from "lucide-react";
import { type MouseEvent, useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";

import { canOpenLinksInApp, isWebUrl } from "~/browser/browserLinkTarget";
import { openUrlInPreview } from "~/browser/openFileInPreview";
import { recordVisitForThread } from "~/browserHistoryStore";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Spinner } from "~/components/ui/spinner";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { previewEnvironment } from "~/state/preview";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
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
function BeatList(props: { readonly beats: ReadonlyArray<VideoScriptBeat> }) {
  const { beats } = props;
  const player = useTimelinePlayer();
  const currentId = useSyncExternalStore(player.playhead.subscribe, () =>
    // A beat holds for up to a second of silence after its last word.
    beatAtFrame(beats, player.playhead.get(), player.rate),
  );
  return (
    <div className="flex flex-col gap-2 px-1 pb-2">
      {groupBeatsBySection(beats).map((group, index) => (
        // Headings can repeat, so a section's place in the script is its identity.
        // oxlint-disable-next-line react/no-array-index-key
        <section key={index} className="flex flex-col">
          {group.section !== null ? (
            <h3 className="px-2 pt-1 pb-0.5 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
              {group.section}
            </h3>
          ) : null}
          {group.beats.map((beat) => {
            const { startFrame } = beat;
            if (startFrame === null) {
              return (
                <p key={beat.id} className="flex gap-2 px-2 py-1 text-xs text-muted-foreground/70">
                  <span aria-hidden className="w-9 shrink-0" />
                  <span className="min-w-0 wrap-anywhere">{beat.text}</span>
                  <span className="sr-only">Not on the timeline</span>
                </p>
              );
            }
            const current = beat.id === currentId;
            return (
              <button
                key={beat.id}
                type="button"
                aria-current={current ? "true" : undefined}
                onClick={() => player.seek(startFrame)}
                className={cn(
                  "flex w-full cursor-pointer gap-2 rounded-sm px-2 py-1 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  // The audio clip colour: these are the words on the audio track.
                  current ? "bg-clip-audio text-white" : "hover:bg-accent",
                )}
              >
                <span
                  className={cn(
                    "w-9 shrink-0 font-mono text-2xs leading-4 tabular-nums",
                    current ? "text-clip-audio-accent" : "text-muted-foreground",
                  )}
                >
                  {beatTime(startFrame, player.rate)}
                </span>
                <span className="min-w-0 wrap-anywhere">{beat.text}</span>
              </button>
            );
          })}
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

  const { revision, transcribed } = props;
  const read = useEffectEvent(() =>
    readScript({
      environmentId: props.environmentId,
      input: { workspaceRoot: props.workspaceRoot, timeline: props.timeline },
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The script and where its lines fall are worked out on the server; they are read again when the timeline's text, the transcripts or the snapshot change.
  useEffect(() => {
    let current = true;
    void read().then((result) => {
      if (!current) return;
      const request = { revision, transcribed, reloads };
      if (result._tag === "Success") setLoaded({ ...request, view: result.value, error: null });
      else {
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

  return (
    <aside
      aria-label="Script"
      className="flex w-72 max-w-[45%] shrink-0 flex-col border-l border-border/60 text-xs"
    >
      <div className="flex shrink-0 flex-col gap-1.5 px-3 pt-2 pb-2">
        <div className="flex items-center gap-1">
          <h2 className="text-xs font-medium">Script</h2>
          {view !== null && view.beats.length > 0 ? (
            <span className="min-w-0 truncate text-muted-foreground">
              {placed} of {view.beats.length} on the timeline
            </span>
          ) : null}
          <span className="ml-auto flex items-center">
            {reading ? (
              <Spinner size="xs" />
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
        {view !== null && pasted === null ? (
          <div className="flex flex-wrap items-center gap-1">
            {docUrl !== null ? (
              <Button
                size="xs"
                variant="outline"
                render={<a href={docUrl} target="_blank" rel="noreferrer noopener" />}
                onClick={(event) => void openScript(event, docUrl)}
              >
                Open script
              </Button>
            ) : null}
            {props.canWrite ? (
              <Button size="xs" variant="outline" onClick={() => setPasted("")}>
                Paste script
              </Button>
            ) : null}
            {props.canWrite && docUrl !== null && link === null ? (
              <Button size="xs" variant="ghost" onClick={() => setLink(docUrl)}>
                Change link
              </Button>
            ) : null}
          </div>
        ) : null}
        {linkDraft !== null && pasted === null ? (
          <form
            className="flex items-center gap-1"
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
              size="compact"
              type="url"
              placeholder="Paste the Google Doc link"
              value={linkDraft}
              onChange={(event) => setLink(event.currentTarget.value)}
            />
            <Button type="submit" size="xs" variant="outline" disabled={!linkReady || saving}>
              Save
            </Button>
            {link !== null && docUrl !== null ? (
              <Button size="xs" variant="ghost" onClick={() => setLink(null)}>
                Cancel
              </Button>
            ) : null}
          </form>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {pasted !== null ? (
          <div className="flex flex-col gap-2 px-3 pb-3">
            <p className="text-muted-foreground">
              Paste the whole script. It replaces the snapshot kept in this project; the Google Doc
              is not changed.
            </p>
            <Textarea
              size="sm"
              rows={10}
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
          <div role="alert" className="flex flex-col items-start gap-2 px-3 pb-3">
            <p className="text-destructive">Could not read the script. {loaded.error}</p>
            <Button size="xs" variant="outline" onClick={reload}>
              Try again
            </Button>
          </div>
        ) : view.beats.length === 0 ? (
          <p className="px-3 pb-3 text-muted-foreground">
            {props.canWrite
              ? "No script in this project yet. Paste it here, or ask an agent to refresh it from the Google Doc."
              : "No script in this project yet. An agent can refresh it from the Google Doc."}
          </p>
        ) : (
          <>
            <BeatList beats={view.beats} />
            <p className="px-3 pb-3 text-2xs text-muted-foreground">
              {view.savedAt !== null ? `Snapshot saved ${savedLabel(view.savedAt)}. ` : ""}
              {placed < view.beats.length ? "Muted lines aren't on this timeline. " : ""}
              An agent can refresh it from the Google Doc.
            </p>
          </>
        )}
      </div>
    </aside>
  );
}
