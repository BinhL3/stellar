import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type AssetResource,
  AuthFilesystemWriteScope,
  type EnvironmentId,
  type VideoProjectIntakeStatus,
  type VideoProjectSyncResult,
} from "@t3tools/contracts";
import { FOOTAGE_TIMELINE_PATH } from "@t3tools/timeline/footage";
import { PROXY_INDEX_PATH, type ProxyIndex } from "@t3tools/timeline/proxies";
import { lazy, Suspense, useEffect, useEffectEvent, useRef, useState } from "react";

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
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { useVideoProject } from "~/hooks/useVideoProject";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useProjectFileQuery } from "../files/projectFilesQueryState";
import { ImportFootageButton } from "../videoProject/ImportFootageButton";
import { NewVideoProjectDialog } from "../videoProject/NewVideoProjectDialog";
import { RecordVoiceOverButton } from "../videoProject/RecordVoiceOverButton";
import { VideoStageSelect } from "../videoProject/VideoStageSelect";
import { PremiereSyncBadge } from "./PremiereSyncBadge";
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

const STILL_PATH = /\.(png|jpe?g|heic|tiff?|psd|gif|webp|bmp)$/i;

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
      still: still ? slot(original) : -1,
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

const timelineLabel = (path: string) =>
  path.slice(path.lastIndexOf("/") + 1).replace(/\.otio$/i, "");

export default function TimelinePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}) {
  const { timelinePaths, refresh: refreshTimelines } = useVideoProject(
    props.environmentId,
    props.workspaceRoot,
  );
  const [pulling, setPulling] = useState(false);
  const [chosenPath, setChosenPath] = useState<string | null>(null);
  const selectedPath =
    chosenPath !== null && timelinePaths.includes(chosenPath)
      ? chosenPath
      : // A pulled sequence comes before the generated footage timeline.
        (timelinePaths.find((path) => path !== FOOTAGE_TIMELINE_PATH) ?? timelinePaths[0] ?? null);
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
  const [link, setLink] = useState<VideoProjectSyncResult | null>(null);
  const [syncing, setSyncing] = useState(false);
  // Pending edits belong to the text they were made on, so a pull that lands under them would
  // drop them. Coming back into focus doesn't pull while there are any; "Sync now" still does.
  const hasPendingEdits = useRef(false);
  const sync = async (options?: { readonly usePremiere?: boolean; readonly quiet?: boolean }) => {
    setSyncing(true);
    const result = await syncProject({
      environmentId: props.environmentId,
      input: {
        workspaceRoot: props.workspaceRoot,
        ...(options?.usePremiere ? { usePremiere: true } : {}),
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
    if (result.value.updated.length > 0) {
      file.refresh();
      toastManager.add({
        type: "success",
        title: "Pulled your Premiere save",
        description: result.value.updated.map(timelineLabel).join(", "),
      });
    }
  };
  const syncOnFocus = useEffectEvent(() => {
    if (canWriteFiles && !hasPendingEdits.current && !syncing) void sync({ quiet: true });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Premiere saves outside the app; coming back into focus is when a new save is most likely.
  useEffect(() => {
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
  const isBuilding = building !== null || intake?.state === "copying";
  const refreshProxies = useEffectEvent(() => {
    proxyFile.refresh();
    intakeFile.refresh();
  });
  // The footage timeline is written when a build ends, so the list is read again then.
  const refreshAfterBuild = useEffectEvent(() => refreshTimelines());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The server rewrites the proxy index as its background build finishes each file; nothing pushes that to clients.
  useEffect(() => {
    if (!isBuilding) return;
    const timer = window.setInterval(refreshProxies, PROXY_POLL_MS);
    return () => {
      window.clearInterval(timer);
      refreshAfterBuild();
    };
  }, [isBuilding]);

  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  // Committing writes the edited timeline over the .otio, then reloads it, which clears the
  // pending edits. Sending the change on to Premiere is the adapter's push, not this.
  const commit = async (contents: string) => {
    if (selectedPath === null) return false;
    const result = await writeFile({
      environmentId: props.environmentId,
      input: { cwd: props.workspaceRoot, relativePath: selectedPath, contents },
    });
    if (result._tag === "Success") {
      file.refresh();
      // The timeline now differs from Premiere's save; the badge should say so.
      void sync({ quiet: true });
      toastManager.add({ type: "success", title: "Timeline saved", description: selectedPath });
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

  const stageSelect = (
    <VideoStageSelect
      environmentId={props.environmentId}
      workspaceRoot={props.workspaceRoot}
      hasTimeline={timelinePaths.length > 0}
    />
  );

  const importFootage = (size?: "sm") => (
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
    ) : intake?.state === "failed" ? (
      <span className="text-xs text-destructive">Import failed: {intake.error}</span>
    ) : null;

  if (selectedPath === null) {
    return (
      <Empty>
        {stageSelect}
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
        <NewVideoProjectDialog
          environmentId={props.environmentId}
          open={pulling}
          onOpenChange={setPulling}
          premiereFolder={`${props.workspaceRoot.replace(/\/+$/, "").replace(/\/[^/]+$/, "")}/Premiere/`}
          onPulled={refreshTimelines}
        />
      </Empty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 pt-2">
        {stageSelect}
        {timelinePaths.length > 1 ? (
          <Select value={selectedPath} onValueChange={(value) => setChosenPath(value)}>
            <SelectTrigger size="sm" aria-label="Timeline">
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
        ) : null}
        {intakeNote}
        {canWriteFiles ? (
          <span className="ml-auto flex items-center gap-2">{importFootage("sm")}</span>
        ) : null}
      </div>
      {file.data ? (
        <Suspense fallback={null}>
          <TimelineViewer
            key={selectedPath}
            text={file.data.contents}
            media={media}
            onReference={reference}
            onPendingEdits={(pending) => {
              hasPendingEdits.current = pending;
            }}
            premiere={
              <PremiereSyncBadge
                link={link}
                syncing={syncing}
                building={building}
                failedProxies={proxyIndex?.failed ?? 0}
                rateChanging={Object.entries(proxyIndex?.media ?? {}).flatMap(([target, entry]) =>
                  entry.rateChanges === undefined
                    ? []
                    : [target.slice(target.lastIndexOf("/") + 1)],
                )}
                proxied={media.proxied}
                {...(canWriteFiles
                  ? {
                      onSync: () => void sync(),
                      onUsePremiere: () => void sync({ usePremiere: true }),
                    }
                  : {})}
              />
            }
            {...(canWriteFiles ? { onCommit: commit } : {})}
          />
        </Suspense>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
          <Spinner size="lg" />
        </div>
      )}
      {canWriteFiles ? (
        // Under the tracks, where narration is recorded against the picture.
        <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-3 py-2">
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
          <span className="text-xs text-muted-foreground">
            Press play, then record, to narrate to picture. Takes are saved in Audio/VO.
          </span>
        </div>
      ) : null}
    </div>
  );
}
