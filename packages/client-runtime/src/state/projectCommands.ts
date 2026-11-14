import {
  type EnvironmentId,
  ProjectId,
  type ProjectReadFileResult,
  type ScopedProjectRef,
  WS_METHODS,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/reactivity";

import {
  type EnvironmentRpcInput,
  type EnvironmentRpcSuccess,
  request,
  requestGuarded,
} from "../rpc/client.ts";
import type { EnvironmentProject } from "./models.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import { createProject, deleteProject, updateProject } from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createFileMetadataAtoms } from "./fileMetadata.ts";
import { resolveWorkspaceFilePath } from "@t3tools/shared/path";

export type {
  CreateProjectInput,
  DeleteProjectInput,
  UpdateProjectInput,
} from "../operations/commands.ts";

export interface OptimisticProjectFile {
  readonly data: ProjectReadFileResult;
  readonly confirmedAgainst: object | null | undefined;
}

export interface OptimisticProjectFileTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

function optimisticProjectFileKey(target: OptimisticProjectFileTarget): string {
  return JSON.stringify([target.environmentId, target.cwd, target.relativePath]);
}

function writtenFilePaths(
  input: EnvironmentRpcInput<typeof WS_METHODS.projectsWriteFile>,
  result: EnvironmentRpcSuccess<typeof WS_METHODS.projectsWriteFile>,
) {
  return new Set(
    [result.relativePath, input.relativePath].map((path) =>
      resolveWorkspaceFilePath(path, input.cwd),
    ),
  );
}

export class ScratchProjectNotLoadedError extends Schema.TaggedError<ScratchProjectNotLoadedError>()(
  "ScratchProjectNotLoadedError",
  { projectId: ProjectId },
) {
  override get message(): string {
    return "The folder for threads without a project has not reached this device yet. Try again.";
  }
}

export function createProjectEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | SecureRandom.SecureRandom | R, E>,
  options: {
    readonly projectAtom: (ref: ScopedProjectRef) => Atom.Atom<EnvironmentProject | null>;
  },
) {
  const fileMetadata = createFileMetadataAtoms(runtime);
  const projectScheduler = createAtomCommandScheduler();
  const fileScheduler = createAtomCommandScheduler();
  const optimisticFileFamily = Atom.family((key: string) =>
    Atom.make<OptimisticProjectFile | null>(null).pipe(
      Atom.withLabel(`environment-data:projects:optimistic-file:${key}`),
    ),
  );
  const projectConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { projectId: string } }) =>
      JSON.stringify([environmentId, input.projectId]),
  };
  return {
    fileMetadata: fileMetadata.metadata,
    fileMetadataThread: fileMetadata.retainThread,
    invalidateFileMetadata: createEnvironmentCommand(runtime, {
      label: "environment-data:filesystem:invalidate-metadata",
      execute: (input: { paths: ReadonlyArray<string> }, registry, environmentId) =>
        Effect.forEach([...new Set(input.paths)], (path) =>
          fileMetadata
            .invalidate(path)
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => fileMetadata.refreshPath(environmentId, path, registry)),
              ),
            ),
        ),
    }),
    searchEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:search-entries",
      tag: WS_METHODS.projectsSearchEntries,
      staleTimeMs: 15_000,
      execute: (input) =>
        fileMetadata.seedAfterRead(
          request(WS_METHODS.projectsSearchEntries, input),
          (result, isCurrent) => fileMetadata.rememberEntries(input.cwd, result.entries, isCurrent),
        ),
    }),
    listEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:list-entries",
      tag: WS_METHODS.projectsListEntries,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
      execute: (input) =>
        fileMetadata.seedAfterRead(
          request(WS_METHODS.projectsListEntries, input),
          (result, isCurrent) => fileMetadata.rememberEntries(input.cwd, result.entries, isCurrent),
        ),
    }),
    listIgnoredFiles: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:list-ignored-files",
      tag: WS_METHODS.projectsListIgnoredFiles,
      staleTimeMs: 15_000,
    }),
    readFile: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:read-file",
      tag: WS_METHODS.projectsReadFile,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
      execute: (input) =>
        fileMetadata.seedAfterRead(
          request(WS_METHODS.projectsReadFile, input),
          (result, isCurrent) =>
            result.exists === false
              ? Effect.void
              : fileMetadata.rememberFile(input.cwd, result, isCurrent),
        ),
    }),
    optimisticFile: (target: OptimisticProjectFileTarget) =>
      optimisticFileFamily(optimisticProjectFileKey(target)),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:create",
      execute: createProject,
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:update",
      execute: updateProject,
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:delete",
      execute: deleteProject,
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    // Finds or creates the environment's Scratch project and resolves once the
    // project is in the client store, since drafts key off its stored path.
    openScratch: createEnvironmentCommand(runtime, {
      label: "environment-data:projects:open-scratch",
      execute: (
        input: EnvironmentRpcInput<typeof WS_METHODS.projectsEnsureScratch>,
        registry,
        environmentId,
      ) =>
        request(WS_METHODS.projectsEnsureScratch, input).pipe(
          Effect.flatMap(({ projectId }) =>
            AtomRegistry.toStream(registry, options.projectAtom({ environmentId, projectId })).pipe(
              Stream.filter(Predicate.isNotNull),
              Stream.runHead,
              Effect.timeoutOption("10 seconds"),
              Effect.map(Option.flatten),
              Effect.flatMap(
                Option.match({
                  onSome: Effect.succeed,
                  onNone: () => Effect.fail(new ScratchProjectNotLoadedError({ projectId })),
                }),
              ),
            ),
          ),
        ),
      scheduler: projectScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    createNew: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:create-new",
      tag: WS_METHODS.projectsCreateNew,
      scheduler: projectScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    createCarousel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:carousel:create",
      tag: WS_METHODS.carouselCreate,
      scheduler: projectScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    editCarousel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:carousel:edit",
      tag: WS_METHODS.carouselEdit,
      scheduler: projectScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.workspaceRoot]),
      },
    }),
    importCarouselPhotos: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:carousel:import-photos",
      tag: WS_METHODS.carouselImportPhotos,
      scheduler: projectScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.workspaceRoot]),
      },
    }),
    uploadCarouselPhoto: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:carousel:upload-photo",
      tag: WS_METHODS.carouselUploadPhoto,
      scheduler: projectScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.workspaceRoot]),
      },
    }),
    submitCarouselRender: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:carousel:submit-render",
      tag: WS_METHODS.carouselSubmitRender,
      scheduler: projectScheduler,
      concurrency: { mode: "parallel" },
    }),
    exportCarousel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:carousel:export",
      tag: WS_METHODS.carouselExport,
      scheduler: projectScheduler,
      concurrency: { mode: "parallel" },
    }),
    watchCarousel: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:carousel:watch",
      tag: WS_METHODS.carouselWatch,
      // The server counts a subscriber as a client that can draw, so let go soon after the panel closes.
      idleTtlMs: 1_000,
    }),
    watchLearnings: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:learnings:watch",
      tag: WS_METHODS.learningsWatch,
    }),
    approveLearning: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:learnings:approve",
      tag: WS_METHODS.learningsApprove,
      scheduler: projectScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    dismissLearning: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:learnings:dismiss",
      tag: WS_METHODS.learningsDismiss,
      scheduler: projectScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    removeHouseRule: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:learnings:remove-rule",
      tag: WS_METHODS.learningsRemoveRule,
      scheduler: projectScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    inspectPremiere: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:video-projects:inspect-premiere",
      tag: WS_METHODS.videoProjectsInspectPremiere,
      scheduler: projectScheduler,
      concurrency: { mode: "parallel" },
    }),
    createVideoProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:video-projects:create",
      tag: WS_METHODS.videoProjectsCreate,
      scheduler: projectScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    createVideoProjectFromIdea: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:video-projects:create-from-idea",
      tag: WS_METHODS.videoProjectsCreateFromIdea,
      scheduler: projectScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    scanVideoIntake: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:video-projects:scan-intake",
      tag: WS_METHODS.videoProjectsScanIntake,
      scheduler: projectScheduler,
      concurrency: { mode: "parallel" },
    }),
    importVideoFootage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:video-projects:import-footage",
      tag: WS_METHODS.videoProjectsImportFootage,
      scheduler: projectScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.workspaceRoot]),
      },
    }),
    saveVideoVoiceOver: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:video-projects:save-voice-over",
      tag: WS_METHODS.videoProjectsSaveVoiceOver,
      scheduler: projectScheduler,
      concurrency: { mode: "parallel" },
    }),
    syncVideoProject: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:video-projects:sync",
      tag: WS_METHODS.videoProjectsSync,
      scheduler: projectScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.workspaceRoot]),
      },
    }),
    transcribeVideoMedia: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:video-projects:transcribe",
      tag: WS_METHODS.videoProjectsTranscribe,
      scheduler: projectScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.workspaceRoot]),
      },
    }),
    readVideoScript: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:video-projects:read-script",
      tag: WS_METHODS.videoProjectsReadScript,
      scheduler: projectScheduler,
      concurrency: { mode: "parallel" },
    }),
    checkVideoRender: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:video-projects:check-render",
      tag: WS_METHODS.videoProjectsCheckRender,
      scheduler: projectScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.workspaceRoot]),
      },
    }),
    readVideoPreflight: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:video-projects:preflight",
      tag: WS_METHODS.videoProjectsPreflight,
      scheduler: projectScheduler,
      concurrency: { mode: "parallel" },
    }),
    setVideoPosted: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:video-projects:set-posted",
      tag: WS_METHODS.videoProjectsSetPosted,
      scheduler: projectScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.workspaceRoot]),
      },
    }),
    commitVideoTimeline: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:video-projects:commit-timeline",
      tag: WS_METHODS.videoProjectsCommitTimeline,
      scheduler: projectScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.workspaceRoot]),
      },
    }),
    listVideoTimelineVersions: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:video-projects:list-versions",
      tag: WS_METHODS.videoProjectsListVersions,
      scheduler: projectScheduler,
      concurrency: { mode: "parallel" },
    }),
    readVideoTimelineVersion: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:video-projects:read-version",
      tag: WS_METHODS.videoProjectsReadVersion,
      scheduler: projectScheduler,
      concurrency: { mode: "parallel" },
    }),
    restoreVideoTimelineVersion: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:video-projects:restore-version",
      tag: WS_METHODS.videoProjectsRestoreVersion,
      scheduler: projectScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.workspaceRoot]),
      },
    }),
    listVideoTimelineEdits: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:video-projects:list-edits",
      tag: WS_METHODS.videoProjectsListEdits,
      scheduler: projectScheduler,
      concurrency: { mode: "parallel" },
    }),
    reviewVideoTimelineEdit: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:video-projects:review-edit",
      tag: WS_METHODS.videoProjectsReviewEdit,
      scheduler: projectScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.workspaceRoot]),
      },
    }),
    createFromThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:create-from-thread",
      tag: WS_METHODS.projectsCreateFromThread,
      scheduler: projectScheduler,
      concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
    }),
    writeFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:write-file",
      tag: WS_METHODS.projectsWriteFile,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
      execute: (input) =>
        requestGuarded(WS_METHODS.projectsWriteFile, input).pipe(
          Effect.tap((result) =>
            Effect.forEach(writtenFilePaths(input, result), fileMetadata.invalidate),
          ),
        ),
      onSuccess: ({ environmentId, input }, registry, result) =>
        Effect.sync(() => {
          for (const path of writtenFilePaths(input, result))
            fileMetadata.refreshPath(environmentId, path, registry);
        }),
    }),
  };
}
