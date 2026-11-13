import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type AssetResource,
  AuthFilesystemWriteScope,
  type EnvironmentId,
  type ScopedThreadRef,
  type VideoProjectIntakeStatus,
  type VideoProjectSyncResult,
  type VideoScriptBeat,
  type VideoTranscriptStatus,
} from "@t3tools/contracts";
import { FOOTAGE_TIMELINE_PATH } from "@t3tools/timeline/footage";
import { PROXY_INDEX_PATH, type ProxyIndex, STILL_PATH } from "@t3tools/timeline/proxies";
import { LayoutPanelTopIcon, ScrollTextIcon } from "lucide-react";
import { lazy, Suspense, useEffect, useEffectEvent, useState } from "react";

import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

import { useAssetUrls } from "~/assets/assetUrls";
import { useComposerHandleContext } from "~/composerHandleContext";
import { Button } from "~/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { Toggle } from "~/components/ui/toggle";
import { useVideoProject } from "~/hooks/useVideoProject";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useProjectFileQuery } from "../files/projectFilesQueryState";
import { ImportFootageButton } from "../videoProject/ImportFootageButton";
import { NewVideoProjectDialog } from "../videoProject/NewVideoProjectDialog";
import { RecordVoiceOverButton } from "../videoProject/RecordVoiceOverButton";
import { VideoStageSelect } from "../videoProject/VideoStageSelect";
import { EditsPanel } from "./EditsPanel";
import { HistoryPanel, type VersionPreview } from "./HistoryPanel";
import type { PremierePull } from "./premiereChanges";
import { PremierePullNotice } from "./PremierePullNotice";
import { PremiereSyncBadge } from "./PremiereSyncBadge";
import { PreflightStrip } from "./PreflightStrip";
import { scriptTicks } from "./scriptBeats";
import { ScriptPanel } from "./ScriptPanel";
import {
  TIMELINE_PANEL_IDS,
  TIMELINE_PANEL_TITLES,
  timelineProjectKey,
  useTimelineLayoutStore,
} from "./timelineLayoutStore";
import type { PreviewMedia, PreviewMediaSource } from "./TimelinePreview";

const TimelineViewer = lazy(() => import("../files/TimelineViewer"));

/** Each clip's `target_url` with its absolute path; relative ones sit under the media root. */
const mediaTargets = (text: string | undefined): ReadonlyArray<readonly [string, string]> => {
  if (text === undefined) return [];
  try {
    const timeline = JSON.parse(text) as {
      metadata?: { stellar?: { mediaRoot?: string } };
      tracks?: {
        children?: ReadonlyArray<{
          children?: ReadonlyArray<{
            media_references?: { DEFAULT_MEDIA?: { target_url?: string } };
          }>;
        }>;
      };
    };
    const root = timeline.metadata?.stellar?.mediaRoot;
    const targets = new Map<string, string>();
    for (const track of timeline.tracks?.children ?? []) {
      for (const child of track.children ?? []) {
        const target = child.media_references?.DEFAULT_MEDIA?.target_url;
        if (!target || targets.has(target)) continue;
        const absolute = target.startsWith("/")
          ? target
          : root === undefined
            ? null
            : `${root.replace(/\/$/, "")}/${target}`;
        if (absolute !== null) targets.set(target, absolute);
      }
    }
    return [...targets];
  } catch {
    return [];
  }
};

const parseProxyIndex = (text: string | undefined): ProxyIndex | null => {
  if (text === undefined) return null;
  try {
    const value = JSON.parse(text) as ProxyIndex;
    return value.version === 1 ? value : null;
  } catch {
    return null;
  }
};

/**
 * Plays proxies where the project has them and the original files otherwise. Every file becomes
 * a signed asset URL; the returned `build` maps the minted URLs back onto each media file.
 */
const planMedia = (
  targets: ReadonlyArray<readonly [string, string]>,
  index: ProxyIndex | null,
  workspaceRoot: string,
) => {
  const paths: Array<string> = [];
  const slot = (path: string | undefined) => {
    if (path === undefined) return -1;
    paths.push(path.startsWith("/") ? path : `${workspaceRoot.replace(/\/$/, "")}/${path}`);
    return paths.length - 1;
  };
  const plans = targets.map(([target, original]) => {
    const entry = index?.media[target];
    const still = STILL_PATH.test(target);
    return {
      target,
      entry,
      // A still no browser decodes is drawn from the rendition the proxy build made of it.
      still: still ? slot(entry?.still ?? original) : -1,
      video: still ? -1 : slot(entry?.video ?? original),
      audio: still ? -1 : slot(entry?.audio ?? original),
      peaks: slot(entry?.peaks),
    };
  });
  const build = (urls: ReadonlyArray<string | null>): PreviewMedia => {
    const at = (position: number) => (position < 0 ? null : (urls[position] ?? null));
    const sources = new Map<string, PreviewMediaSource>();
    for (const plan of plans) {
      const { entry } = plan;
      sources.set(plan.target, {
        video: at(plan.video),
        audio: at(plan.audio),
        still: at(plan.still),
        // Proxies decode through WebCodecs. Originals, and transparent proxies (VP9 with alpha,
        // which WebCodecs hands back opaque), play through a media element instead.
        ...(entry?.video !== undefined && entry.alpha !== true && plan.still < 0
          ? { videoProxy: true }
          : {}),
        ...(entry?.audio !== undefined && plan.still < 0 ? { audioProxy: true } : {}),
        ...(entry ? { width: entry.width, height: entry.height } : {}),
        ...(entry?.peaks ? { peaks: at(plan.peaks) } : {}),
      });
    }
    return { sources, proxied: index !== null };
  };
  return { paths, build };
};

// While footage copies or proxies build, their status files are re-read this often.
const PROXY_POLL_MS = 2500;
const INTAKE_STATUS_PATH = "intake.json";

const parseIntakeStatus = (text: string | undefined): VideoProjectIntakeStatus | null => {
  if (text === undefined) return null;
  try {
    const value = JSON.parse(text) as VideoProjectIntakeStatus;
    return typeof value.state === "string" ? value : null;
  } catch {
    return null;
  }
};

const TRANSCRIPT_STATUS_PATH = "transcripts.json";

const parseTranscriptStatus = (text: string | undefined): VideoTranscriptStatus | null => {
  if (text === undefined) return null;
  try {
    const value = JSON.parse(text) as VideoTranscriptStatus;
    return typeof value.ready === "number" && Array.isArray(value.failed) ? value : null;
  } catch {
    return null;
  }
};

const timelineLabel = (path: string) =>
  path.slice(path.lastIndexOf("/") + 1).replace(/\.otio$/i, "");

// Whether script lines show on the ruler is a per-browser habit, like the shortcut layout.
const SCRIPT_LINES_KEY = "stellar.timeline.scriptLines";
const readScriptLinesShown = () => {
  try {
    return window.localStorage.getItem(SCRIPT_LINES_KEY) !== "off";
  } catch {
    return true;
  }
};

const versionTime = (time: number) =>
  new Date(time).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

export default function TimelinePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  /** The thread whose Browser tab opens the script's Google Doc. */
  readonly threadRef: ScopedThreadRef;
}) {
  const { timelinePaths, refresh: refreshTimelines } = useVideoProject(
    props.environmentId,
    props.workspaceRoot,
  );
  const [pulling, setPulling] = useState(false);
  const [chosenPath, setChosenPath] = useState<string | null>(null);
  const [link, setLink] = useState<VideoProjectSyncResult | null>(null);
  const selectedPath =
    chosenPath !== null && timelinePaths.includes(chosenPath)
      ? chosenPath
      : // The cut Premiere follows comes first, then any cut, then the generated footage timeline.
        (link?.linked?.find((path) => timelinePaths.includes(path)) ??
        timelinePaths.find((path) => path !== FOOTAGE_TIMELINE_PATH) ??
        timelinePaths[0] ??
        null);
  const file = useProjectFileQuery(
    props.environmentId,
    props.workspaceRoot,
    selectedPath,
    selectedPath !== null,
  );

  const proxyFile = useProjectFileQuery(
    props.environmentId,
    props.workspaceRoot,
    PROXY_INDEX_PATH,
    selectedPath !== null,
  );
  const proxyIndex = parseProxyIndex(proxyFile.data?.contents);
  const plan = planMedia(mediaTargets(file.data?.contents), proxyIndex, props.workspaceRoot);
  const resources = plan.paths.map((path): AssetResource => ({
    _tag: "draft-workspace-file",
    cwd: props.workspaceRoot,
    path,
  }));
  const media = plan.build(useAssetUrls(props.environmentId, resources));
  const canWriteFiles = useEnvironmentScope(props.environmentId, AuthFilesystemWriteScope);
  const composerRef = useComposerHandleContext();
  // A reference: the timeline file as a chip, then a clip or moment in words, with stable clip
  // ids that the timeline's edits and an agent's tools both use.
  const reference = (description: string) => {
    const composer = composerRef?.current;
    if (!composer || selectedPath === null) {
      toastManager.add({
        type: "error",
        title: "Unable to add to chat",
        description: "Open a chat for this project and try again.",
      });
      return;
    }
    const inserted = composer.insertTextAtEnd(
      `${serializeComposerFileLink(selectedPath)} ${description} `,
      { ensureLeadingBoundary: true },
    );
    if (inserted) composer.focusAtEnd();
    else {
      toastManager.add({
        type: "error",
        title: "Unable to add to chat",
        description: "The chat isn't ready to accept input right now.",
      });
    }
  };
  const syncProject = useAtomCommand(projectEnvironment.syncVideoProject, { reportFailure: false });
  const [syncing, setSyncing] = useState(false);
  // Pending edits belong to the text they were made on, so a pull that lands under them would
  // drop them. Coming back into focus doesn't pull while there are any; "Sync now" still does.
  // They are remembered with that text: once the file's contents change, the viewer has let them go.
  const [editedContents, setEditedContents] = useState<string | null>(null);
  const hasPendingEdits = editedContents !== null && editedContents === file.data?.contents;
  const [pull, setPull] = useState<(PremierePull & { readonly dismissed: boolean }) | null>(null);
  const sync = async (options?: {
    readonly usePremiere?: boolean;
    readonly merge?: boolean;
    readonly quiet?: boolean;
  }) => {
    // Both replace the timeline file, which would drop edits the viewer hasn't saved.
    if ((options?.merge || options?.usePremiere) && hasPendingEdits) return;
    setSyncing(true);
    const result = await syncProject({
      environmentId: props.environmentId,
      input: {
        workspaceRoot: props.workspaceRoot,
        ...(options?.usePremiere ? { usePremiere: true } : {}),
        ...(options?.merge ? { merge: true } : {}),
      },
    });
    setSyncing(false);
    if (result._tag !== "Success") {
      if (options?.quiet !== true && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not sync with Premiere",
          description: error instanceof Error ? error.message : "Try again in a moment.",
        });
      }
      return;
    }
    setLink(result.value);
    // The sync may have started a proxy build; the index says so, and polling follows it.
    proxyFile.refresh();
    const { changes, conflicts, updated } = result.value;
    const replaced = options?.merge === true || options?.usePremiere === true;
    if (updated.length > 0 || replaced) file.refresh();
    // A pull can bring a sequence that had no timeline here.
    if (updated.length > 0 || changes.length > 0) refreshTimelines();
    if (changes.length > 0 || conflicts.length > 0) {
      setPull({ changes, conflicts, merged: options?.merge === true, dismissed: false });
    } else if (updated.length > 0) {
      toastManager.add({
        type: "success",
        title: "Pulled your Premiere save",
        description: updated.map(timelineLabel).join(", "),
      });
    }
  };
  const syncOnFocus = useEffectEvent(() => {
    if (canWriteFiles && !hasPendingEdits && !syncing) void sync({ quiet: true });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Premiere saves outside the app; coming back into focus is when a new save is most likely.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- The sync marks itself running before it awaits the server.
    syncOnFocus();
    window.addEventListener("focus", syncOnFocus);
    return () => window.removeEventListener("focus", syncOnFocus);
  }, []);

  const building = proxyIndex?.building ?? null;
  const intakeFile = useProjectFileQuery(
    props.environmentId,
    props.workspaceRoot,
    INTAKE_STATUS_PATH,
  );
  const intake = parseIntakeStatus(intakeFile.data?.contents);
  const isBuilding =
    building !== null || intake?.state === "copying" || intake?.state === "conforming";
  const transcriptFile = useProjectFileQuery(
    props.environmentId,
    props.workspaceRoot,
    TRANSCRIPT_STATUS_PATH,
  );
  const transcripts = parseTranscriptStatus(transcriptFile.data?.contents);
  const isPolling = isBuilding || (transcripts !== null && transcripts.building !== null);
  const refreshProxies = useEffectEvent(() => {
    proxyFile.refresh();
    intakeFile.refresh();
    transcriptFile.refresh();
  });
  // The footage timeline is written when a build ends, so the list is read again then.
  const refreshAfterBuild = useEffectEvent(() => refreshTimelines());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The server rewrites the proxy index and transcript status as its background work finishes each file; nothing pushes that to clients.
  useEffect(() => {
    if (!isPolling) return;
    const timer = window.setInterval(refreshProxies, PROXY_POLL_MS);
    return () => {
      window.clearInterval(timer);
      refreshAfterBuild();
    };
  }, [isPolling]);

  const transcribeMedia = useAtomCommand(projectEnvironment.transcribeVideoMedia, {
    reportFailure: false,
  });
  const transcribe = async () => {
    const result = await transcribeMedia({
      environmentId: props.environmentId,
      input: { workspaceRoot: props.workspaceRoot },
    });
    // The status file now says what is being transcribed, and polling follows it.
    transcriptFile.refresh();
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not start transcribing",
      description: error instanceof Error ? error.message : "Try again in a moment.",
    });
  };

  const projectKey = timelineProjectKey(props.environmentId, props.workspaceRoot);
  const workspace = useTimelineLayoutStore((state) =>
    state.active?.projectKey === projectKey ? state.active : null,
  );
  const scriptOpen = workspace?.open.includes("script") ?? false;

  const commitTimeline = useAtomCommand(projectEnvironment.commitVideoTimeline, {
    reportFailure: false,
  });
  // Committing writes the edited timeline over the .otio as a version of its history, then
  // reloads it, which clears the pending edits. Sending the change on to Premiere is the
  // adapter's push, not this.
  const commit = async (contents: string) => {
    if (selectedPath === null) return false;
    const result = await commitTimeline({
      environmentId: props.environmentId,
      input: { workspaceRoot: props.workspaceRoot, timeline: selectedPath, contents },
    });
    if (result._tag === "Success") {
      // The first save of the footage timeline is made on a cut of its own, which opens.
      const saved = result.value.timeline;
      if (saved !== selectedPath) {
        refreshTimelines();
        setChosenPath(saved);
      }
      file.refresh();
      // The timeline now differs from Premiere's save; the badge should say so.
      void sync({ quiet: true });
      toastManager.add({ type: "success", title: "Timeline saved", description: saved });
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not save the timeline",
        description: error instanceof Error ? error.message : "The edits are still pending.",
      });
    }
    return false;
  };

  // A version on show in the Monitor instead of the timeline; it belongs to the timeline it is of.
  const [previewing, setPreviewing] = useState<{
    readonly timeline: string;
    readonly view: VersionPreview;
  } | null>(null);
  const preview = previewing?.timeline === selectedPath ? previewing.view : null;
  const restoreVersion = useAtomCommand(projectEnvironment.restoreVideoTimelineVersion, {
    reportFailure: false,
  });
  /** Brings a version back, or steps one undo or redo through the versions. */
  const restore = async (
    target: { readonly version: string } | { readonly step: "undo" | "redo" },
  ) => {
    if (selectedPath === null) return;
    if (hasPendingEdits) {
      toastManager.add({
        type: "info",
        title: "Commit or discard your edits first",
        description: "Bringing a version back replaces the timeline they were made on.",
      });
      return;
    }
    const result = await restoreVersion({
      environmentId: props.environmentId,
      input: { workspaceRoot: props.workspaceRoot, timeline: selectedPath, ...target },
    });
    if (result._tag !== "Success") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      const message = error instanceof Error ? error.message : "Try again in a moment.";
      // Nothing left to step to is an answer, not a failure.
      const nothing = "step" in target && message.startsWith("Nothing to");
      toastManager.add({
        type: nothing ? "info" : "error",
        title: nothing ? message.split(":")[0] : "Could not bring that version back",
        ...(nothing ? {} : { description: message }),
      });
      return;
    }
    setPreviewing(null);
    file.refresh();
    void sync({ quiet: true });
    const { restored, keptFromPremiere, conflicts } = result.value;
    const kept =
      keptFromPremiere.length === 0
        ? ""
        : ` Kept ${keptFromPremiere.length === 1 ? "a change" : `${keptFromPremiere.length} changes`} made in Premiere since.`;
    toastManager.add({
      type: conflicts.length > 0 ? "warning" : "success",
      title:
        "step" in target
          ? `${target.step === "undo" ? "Stepped back" : "Stepped forward"} to ${versionTime(restored.at)}`
          : `Restored the version from ${versionTime(restored.at)}`,
      description:
        conflicts.length > 0
          ? `${conflicts.join(" ")}${kept}`
          : `${"step" in target ? `${restored.label}.` : "Undo steps back from it."}${kept}`,
    });
  };

  // Script lines on the ruler: read from the Script panel when it is open, else fetched here.
  const [scriptLinesShown, setScriptLinesShown] = useState(readScriptLinesShown);
  const [scriptBeats, setScriptBeats] = useState<{
    readonly key: string;
    readonly beats: ReadonlyArray<VideoScriptBeat>;
  } | null>(null);
  const readScript = useAtomCommand(projectEnvironment.readVideoScript, { reportFailure: false });
  const beatsKey = `${selectedPath ?? ""}\n${file.data?.contents.length ?? 0}:${transcripts?.ready ?? 0}`;
  const wantsBeats =
    scriptLinesShown && !scriptOpen && selectedPath !== null && file.data !== undefined;
  const loadBeats = useEffectEvent(async (key: string) => {
    if (selectedPath === null) return;
    const result = await readScript({
      environmentId: props.environmentId,
      input: { workspaceRoot: props.workspaceRoot, timeline: selectedPath },
    });
    if (result._tag === "Success") setScriptBeats({ key, beats: result.value.beats });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Where script lines fall is worked out on the server; with the Script panel closed nothing else reads it, so the ruler's ticks read it when the timeline's text changes.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- The beats are set when the server answers, not as the effect runs.
    if (wantsBeats) void loadBeats(beatsKey);
  }, [wantsBeats, beatsKey]);
  const ticks = scriptBeats !== null && selectedPath !== null ? scriptTicks(scriptBeats.beats) : [];

  const stageSelect = (variant?: "ghost") => (
    <VideoStageSelect
      environmentId={props.environmentId}
      workspaceRoot={props.workspaceRoot}
      hasTimeline={timelinePaths.length > 0}
      {...(variant ? { variant } : {})}
    />
  );

  const importFootage = (size?: "sm" | "micro") => (
    <ImportFootageButton
      environmentId={props.environmentId}
      workspaceRoot={props.workspaceRoot}
      onStarted={() => intakeFile.refresh()}
      {...(size ? { size } : {})}
    />
  );
  const intakeNote =
    intake?.state === "copying" ? (
      <span className="text-xs text-muted-foreground">
        Copying footage: {intake.done} of {intake.total}
      </span>
    ) : intake?.state === "conforming" && intake.conform !== undefined ? (
      <span className="text-xs text-muted-foreground">
        Conforming {intake.conform.file.slice(intake.conform.file.lastIndexOf("/") + 1)} to 59.94:{" "}
        {intake.conform.percent}% ({intake.conform.done + 1} of {intake.conform.total})
      </span>
    ) : intake?.state === "failed" ? (
      <span className="text-xs text-destructive">Import failed: {intake.error}</span>
    ) : null;

  const premiereDialog = (
    <NewVideoProjectDialog
      environmentId={props.environmentId}
      open={pulling}
      onOpenChange={setPulling}
      premiereFolder={`${props.workspaceRoot.replace(/\/+$/, "").replace(/\/[^/]+$/, "")}/Premiere/`}
      onPulled={refreshTimelines}
    />
  );
  // The run's steps, under the bar. It reads what this tab already loads and adds no timer.
  const preflightStrip = (
    <PreflightStrip
      environmentId={props.environmentId}
      workspaceRoot={props.workspaceRoot}
      watched={{
        sync: link,
        timeline: file.data?.contents,
        proxies: proxyFile.data?.contents,
        intake: intakeFile.data?.contents,
        transcripts: transcriptFile.data?.contents,
      }}
      canWrite={canWriteFiles}
      uncommittedEdits={hasPendingEdits}
      actions={{
        importFootage: importFootage("micro"),
        linkPremiere: () => setPulling(true),
        sync: () => void sync(),
        merge: () => void sync({ merge: true }),
        transcribe: () => void transcribe(),
        ...(workspace === null ? {} : { openScript: () => workspace.controls.show("script") }),
      }}
      onBeforeRenderCheck={() => sync({ quiet: true })}
    />
  );

  if (selectedPath === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {preflightStrip}
        <Empty>
          {stageSelect()}
          <EmptyHeader>
            <EmptyTitle>No timeline yet</EmptyTitle>
            <EmptyDescription>
              {isBuilding
                ? "Footage is on its way. It plays here as soon as its previews are made."
                : "Import the footage you shot and it plays here. Once a rough cut exists, save the Premiere project in this project's Premiere folder and pull a sequence."}
            </EmptyDescription>
          </EmptyHeader>
          {intakeNote}
          {canWriteFiles ? (
            <EmptyContent>
              {importFootage()}
              <Button variant="outline" onClick={() => setPulling(true)}>
                Pull from Premiere
              </Button>
            </EmptyContent>
          ) : null}
          {premiereDialog}
        </Empty>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="@container/bar flex h-11 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        {timelinePaths.length > 1 ? (
          <Select value={selectedPath} onValueChange={(value) => setChosenPath(value)}>
            <SelectTrigger size="sm" variant="ghost" aria-label="Timeline">
              <SelectValue>{(value: string) => timelineLabel(value)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {timelinePaths.map((path) => (
                <SelectItem key={path} value={path}>
                  {timelineLabel(path)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : (
          <h2 className="min-w-0 truncate px-1.5 text-sm font-semibold">
            {timelineLabel(selectedPath)}
          </h2>
        )}
        {stageSelect("ghost")}
        {intakeNote}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <Toggle
            size="sm"
            disabled={workspace === null}
            pressed={scriptOpen}
            onPressedChange={(open) =>
              open ? workspace?.controls.show("script") : workspace?.controls.close("script")
            }
          >
            <ScrollTextIcon />
            <span className="@max-[34rem]/bar:sr-only">Script</span>
          </Toggle>
          <Menu>
            <MenuTrigger
              disabled={workspace === null}
              render={<Button size="sm" variant="ghost" aria-label="Panels" />}
            >
              <LayoutPanelTopIcon />
              <span className="@max-[34rem]/bar:sr-only">Panels</span>
            </MenuTrigger>
            <MenuPopup align="end" side="bottom">
              {TIMELINE_PANEL_IDS.map((id) => (
                <MenuCheckboxItem
                  key={id}
                  checked={workspace?.open.includes(id) ?? false}
                  onCheckedChange={(open) =>
                    open ? workspace?.controls.show(id) : workspace?.controls.close(id)
                  }
                >
                  {TIMELINE_PANEL_TITLES[id]}
                </MenuCheckboxItem>
              ))}
              <MenuSeparator />
              <MenuItem onClick={() => workspace?.controls.reset()}>Reset layout</MenuItem>
            </MenuPopup>
          </Menu>
          {canWriteFiles ? importFootage("sm") : null}
        </span>
      </div>
      {preflightStrip}
      {premiereDialog}
      {pull !== null && !pull.dismissed ? (
        <PremierePullNotice pull={pull} onDismiss={() => setPull({ ...pull, dismissed: true })} />
      ) : null}
      {preview !== null ? (
        <div
          role="status"
          className="mx-3 mt-2 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-info/40 bg-info/8 py-1.5 pr-1.5 pl-3 text-xs"
        >
          <span className="min-w-0 flex-1">
            <span className="font-medium">
              Looking at the version from {versionTime(preview.version.at)}
            </span>
            <span className="text-muted-foreground">
              {" "}
              · {preview.version.label}. The timeline itself is unchanged.
            </span>
          </span>
          {canWriteFiles ? (
            <Button size="xs" onClick={() => void restore({ version: preview.version.id })}>
              Restore this version
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" onClick={() => setPreviewing(null)}>
            Back to now
          </Button>
        </div>
      ) : null}
      {file.data ? (
        <Suspense fallback={null}>
          <TimelineViewer
            key={selectedPath}
            text={preview?.contents ?? file.data.contents}
            media={media}
            scriptLines={{
              ticks: preview === null ? ticks : [],
              shown: scriptLinesShown,
              onShownChange: (shown) => {
                setScriptLinesShown(shown);
                try {
                  window.localStorage.setItem(SCRIPT_LINES_KEY, shown ? "on" : "off");
                } catch {
                  // Storage can be unavailable (private windows); the choice still holds this session.
                }
              },
              onPick: () => workspace?.controls.show("script"),
            }}
            onReference={reference}
            onPendingEdits={(pending) => {
              setEditedContents(pending ? (file.data?.contents ?? null) : null);
            }}
            premiere={
              <PremiereSyncBadge
                link={link}
                lastPull={pull}
                uncommittedEdits={hasPendingEdits}
                syncing={syncing}
                building={building}
                failedProxies={proxyIndex?.failed ?? 0}
                proxyProblems={{
                  error: proxyIndex?.error ?? null,
                  failures: Object.entries(proxyIndex?.failures ?? {}).map(([target, reason]) => [
                    target.slice(target.lastIndexOf("/") + 1),
                    reason,
                  ]),
                }}
                rateChanging={Object.entries(proxyIndex?.media ?? {}).flatMap(([target, entry]) =>
                  entry.rateChanges === undefined
                    ? []
                    : [target.slice(target.lastIndexOf("/") + 1)],
                )}
                proxied={media.proxied}
                transcripts={transcripts}
                {...(canWriteFiles
                  ? {
                      onSync: () => void sync(),
                      onUsePremiere: () => void sync({ usePremiere: true }),
                      onMerge: () => void sync({ merge: true }),
                      onTranscribe: () => void transcribe(),
                    }
                  : {})}
              />
            }
            workspace={{
              projectKey,
              script: (
                <ScriptPanel
                  environmentId={props.environmentId}
                  workspaceRoot={props.workspaceRoot}
                  timeline={selectedPath}
                  revision={file.data?.contents ?? ""}
                  transcribed={transcripts?.ready ?? 0}
                  threadRef={props.threadRef}
                  canWrite={canWriteFiles}
                  pendingEdits={hasPendingEdits}
                  onTimelineChanged={() => {
                    file.refresh();
                    // The timeline now differs from Premiere's save; the badge should say so.
                    void sync({ quiet: true });
                  }}
                  onBeats={(beats) => setScriptBeats({ key: beatsKey, beats })}
                  onClose={() => workspace?.controls.close("script")}
                />
              ),
              edits: (
                <EditsPanel
                  environmentId={props.environmentId}
                  workspaceRoot={props.workspaceRoot}
                  timeline={selectedPath}
                  revision={file.data?.contents ?? ""}
                  canWrite={canWriteFiles}
                  pendingEdits={hasPendingEdits}
                  preview={preview}
                  onPreview={(view) =>
                    setPreviewing(view === null ? null : { timeline: selectedPath, view })
                  }
                  onTimelineChanged={() => {
                    file.refresh();
                    // The timeline now differs from Premiere's save; the badge should say so.
                    void sync({ quiet: true });
                  }}
                  onRevise={reference}
                />
              ),
              history: (
                <HistoryPanel
                  environmentId={props.environmentId}
                  workspaceRoot={props.workspaceRoot}
                  timeline={selectedPath}
                  revision={file.data?.contents ?? ""}
                  canWrite={canWriteFiles}
                  preview={preview}
                  onPreview={(view) =>
                    setPreviewing(view === null ? null : { timeline: selectedPath, view })
                  }
                  onRestore={(version) => restore({ version })}
                />
              ),
            }}
            // A version on show is read-only: it can be looked at and played, not edited.
            {...(canWriteFiles && preview === null
              ? { onCommit: commit, onStepVersion: (step) => void restore({ step }) }
              : {})}
          />
        </Suspense>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
          <Spinner size="lg" />
        </div>
      )}
      {canWriteFiles ? (
        // The workspace's footer: recording runs against playback wherever the panels are.
        <div className="flex h-11 shrink-0 items-center gap-2.5 border-t border-border/60 bg-background px-3">
          <RecordVoiceOverButton
            environmentId={props.environmentId}
            workspaceRoot={props.workspaceRoot}
            onSaved={(path) => {
              // Hand the take to the chat, so asking the agent to place it is one sentence.
              composerRef?.current?.insertTextAtEnd(`Voice-over take: ${path} `, {
                ensureLeadingBoundary: true,
              });
            }}
          />
          <span className="min-w-0 truncate text-2xs text-muted-foreground">
            Press play, then record, to narrate to picture. Takes are saved in Audio/VO.
          </span>
        </div>
      ) : null}
    </div>
  );
}
