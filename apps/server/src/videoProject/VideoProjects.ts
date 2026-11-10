import {
  CommandId,
  ProjectId,
  type VideoProjectCreateInput,
  type VideoProjectCreateResult,
  type VideoProjectInspectPremiereInput,
  type VideoProjectInspectPremiereResult,
} from "@t3tools/contracts";
import { parsePrproj } from "@t3tools/timeline/premiere/prproj";
import { buildProjectProxies } from "@t3tools/timeline/proxyBuilder";
import { pullToProject } from "@t3tools/timeline/pullToProject";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

import * as ProjectService from "../project/ProjectService.ts";

export class VideoProjectError extends Schema.TaggedError<VideoProjectError>()(
  "VideoProjectError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

/** Stellar's own files for a video project sit in this folder beside the Premiere project. */
const STELLAR_FOLDER = "Stellar";
// Proxies are encoded a few files at a time so a big import doesn't starve the machine.
const PROXY_CONCURRENCY = 3;

export class VideoProjects extends Context.Service<
  VideoProjects,
  {
    readonly inspectPremiere: (
      input: VideoProjectInspectPremiereInput,
    ) => Effect.Effect<VideoProjectInspectPremiereResult, VideoProjectError>;
    /**
     * Pulls a sequence into the project folder beside the Premiere project, adds (or reuses) the
     * project, and starts building proxies in the background; the player falls back to the
     * original files until they are ready.
     */
    readonly createFromPremiere: (
      input: VideoProjectCreateInput,
    ) => Effect.Effect<VideoProjectCreateResult, VideoProjectError>;
  }
>()("t3/videoProject/VideoProjects") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const background = yield* FiberSet.make();

  /**
   * The folder that holds a Premiere project's footage: the `.prproj`'s own folder, or its parent
   * when that folder is a "Premiere" subfolder (SFUniqlo/Premiere/SFUniqlo.prproj -> SFUniqlo).
   */
  const mediaRootFor = (premiereProjectPath: string) => {
    const folder = path.dirname(premiereProjectPath);
    return /premiere/i.test(path.basename(folder)) ? path.dirname(folder) : folder;
  };

  const readPremiere = Effect.fn("VideoProjects.readPremiere")(function* (
    premiereProjectPath: string,
  ) {
    if (path.extname(premiereProjectPath).toLowerCase() !== ".prproj") {
      return yield* new VideoProjectError({ reason: "Choose a Premiere project (.prproj) file." });
    }
    const bytes = yield* fileSystem
      .readFile(premiereProjectPath)
      .pipe(
        Effect.mapError(
          (cause) =>
            new VideoProjectError({ reason: `Could not read ${premiereProjectPath}.`, cause }),
        ),
      );
    const project = yield* Effect.try({
      try: () => parsePrproj(bytes),
      catch: (cause) =>
        new VideoProjectError({
          reason: "This file isn't a Premiere project Stellar can read.",
          cause,
        }),
    });
    return { bytes, project };
  });

  const inspectPremiere: VideoProjects["Service"]["inspectPremiere"] = Effect.fn(
    "VideoProjects.inspectPremiere",
  )(function* (input) {
    const { project } = yield* readPremiere(input.premiereProjectPath);
    const title = path.basename(input.premiereProjectPath, path.extname(input.premiereProjectPath));
    return {
      title: title.trim() === "" ? "Video project" : title,
      sequences: project.sequences.map((sequence) => ({ id: sequence.id, name: sequence.name })),
      projectFolder: path.join(mediaRootFor(input.premiereProjectPath), STELLAR_FOLDER),
    };
  });

  const createFromPremiere: VideoProjects["Service"]["createFromPremiere"] = Effect.fn(
    "VideoProjects.createFromPremiere",
  )(function* (input) {
    const { bytes } = yield* readPremiere(input.premiereProjectPath);
    const mediaRoot = mediaRootFor(input.premiereProjectPath);
    const projectFolder = path.join(mediaRoot, STELLAR_FOLDER);
    const pulled = yield* pullToProject({
      prproj: bytes,
      sequence: input.sequenceId,
      projectDir: projectFolder,
      mediaRoot,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) => new VideoProjectError({ reason: "Could not pull the sequence.", cause }),
      ),
      Effect.catchDefect(
        (cause) => new VideoProjectError({ reason: "Could not read that sequence.", cause }),
      ),
    );

    const existing = yield* projects
      .getByWorkspaceRoot(projectFolder)
      .pipe(
        Effect.mapError(
          (cause) => new VideoProjectError({ reason: "Could not look up projects.", cause }),
        ),
      );
    const project = Option.isSome(existing)
      ? existing.value
      : yield* random.uuidV4().pipe(
          Effect.flatMap((id) =>
            projects.create({
              commandId: CommandId.make(`video-project:${id}`),
              projectId: ProjectId.make(id),
              title: path.basename(
                input.premiereProjectPath,
                path.extname(input.premiereProjectPath),
              ),
              workspaceRoot: projectFolder,
              createWorkspaceRootIfMissing: true,
            }),
          ),
          Effect.mapError(
            (cause) => new VideoProjectError({ reason: "Could not add the project.", cause }),
          ),
        );

    yield* FiberSet.run(
      background,
      buildProjectProxies({ projectDir: projectFolder, concurrency: PROXY_CONCURRENCY }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.tap((result) =>
          Effect.logInfo("Video project proxies ready", { projectFolder, files: result.count }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Video project proxies failed", { projectFolder, cause }),
        ),
      ),
    );

    return {
      projectId: project.id,
      workspaceRoot: projectFolder,
      timelinePath: path.relative(projectFolder, pulled.timelinePath),
      existed: Option.isSome(existing),
    };
  });

  return VideoProjects.of({ inspectPremiere, createFromPremiere });
});

export const layer = Layer.effect(VideoProjects, make);
