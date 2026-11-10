import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type AssetResource,
  AuthFilesystemWriteScope,
  type EnvironmentId,
} from "@t3tools/contracts";
import { PROXY_INDEX_PATH, type ProxyIndex } from "@t3tools/timeline/proxies";
import { lazy, Suspense, useState } from "react";

import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

import { useAssetUrls } from "~/assets/assetUrls";
import { useComposerHandleContext } from "~/composerHandleContext";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
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
        // Proxies decode through WebCodecs; originals fall back to a media element.
        ...(entry?.video !== undefined && plan.still < 0 ? { videoProxy: true } : {}),
        ...(entry ? { width: entry.width, height: entry.height } : {}),
        ...(entry?.peaks ? { peaks: at(plan.peaks) } : {}),
      });
    }
    return { sources, proxied: index !== null };
  };
  return { paths, build };
};

const timelineLabel = (path: string) =>
  path.slice(path.lastIndexOf("/") + 1).replace(/\.otio$/i, "");

export default function TimelinePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}) {
  const { timelinePaths } = useVideoProject(props.environmentId, props.workspaceRoot);
  const [chosenPath, setChosenPath] = useState<string | null>(null);
  const selectedPath =
    chosenPath !== null && timelinePaths.includes(chosenPath)
      ? chosenPath
      : (timelinePaths[0] ?? null);
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
  const plan = planMedia(
    mediaTargets(file.data?.contents),
    parseProxyIndex(proxyFile.data?.contents),
    props.workspaceRoot,
  );
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

  if (selectedPath === null) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No timeline yet</EmptyTitle>
          <EmptyDescription>
            Ask the agent to pull a sequence from your editing app. Timelines appear here from the
            project's timelines folder.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {timelinePaths.length > 1 ? (
        <div className="flex shrink-0 items-center gap-2 px-3 pt-2">
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
        </div>
      ) : null}
      {file.data ? (
        <Suspense fallback={null}>
          <TimelineViewer
            key={selectedPath}
            text={file.data.contents}
            media={media}
            onReference={reference}
            {...(canWriteFiles ? { onCommit: commit } : {})}
          />
        </Suspense>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
          <Spinner size="lg" />
        </div>
      )}
    </div>
  );
}
