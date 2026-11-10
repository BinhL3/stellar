import {
  CommandId,
  ProjectId,
  type VideoProjectCreateFromIdeaInput,
  type VideoProjectCreateFromIdeaResult,
  type VideoProjectCreateInput,
  type VideoProjectCreateResult,
  type VideoProjectImportFootageInput,
  type VideoProjectInspectPremiereInput,
  type VideoProjectInspectPremiereResult,
  type VideoProjectIntakeStatus,
  type VideoProjectScanIntakeInput,
  type VideoProjectScanIntakeResult,
  type VideoProjectSyncInput,
  type VideoProjectSyncResult,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { copyFootage, FOOTAGE_DIRECTORY, writeFootageStringout } from "@t3tools/timeline/footage";
import { serializeJson } from "@t3tools/timeline/otio";
import { parsePrproj } from "@t3tools/timeline/premiere/prproj";
import { recordPull, syncFromPremiere } from "@t3tools/timeline/premiereSync";
import { PROXY_INDEX_PATH, type ProxyIndex } from "@t3tools/timeline/proxies";
import { buildProjectProxies, markProxiesBuilding } from "@t3tools/timeline/proxyBuilder";
import { pullToProject } from "@t3tools/timeline/pullToProject";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

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

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** Stellar's own files for a video project sit in this folder beside the Premiere project. */
const STELLAR_FOLDER = "Stellar";
/**
 * What a project folder starts with. A Premiere project saved into `Premiere` is then found
 * from the Stellar folder beside it, the same layout `mediaRootFor` reads.
 */
const PROJECT_FOLDERS = [
  "Footage",
  "Audio",
  "B-roll",
  "Graphics",
  "Premiere",
  "Exports",
  `${STELLAR_FOLDER}/timelines`,
];
// Proxies are encoded a few files at a time so a big import doesn't starve the machine.
const PROXY_CONCURRENCY = 3;
/** Progress of a footage import, in the project folder; clients re-read it while it copies. */
const INTAKE_STATUS_FILE = "intake.json";
// How far back a scan looks for files that arrived in Downloads.
const INTAKE_DAYS = 3;
const INTAKE_FILE = /\.(mov|mp4|m4v|heic|jpe?g|png)$/i;

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
    /**
     * Starts a video project from an idea, before any footage or Premiere project exists:
     * makes the project's folders and adds the project, so the script and intake have a home.
     */
    readonly createFromIdea: (
      input: VideoProjectCreateFromIdeaInput,
    ) => Effect.Effect<VideoProjectCreateFromIdeaResult, VideoProjectError>;
    /** Lists the videos and photos that recently arrived in the host's Downloads folder. */
    readonly scanIntake: (
      input: VideoProjectScanIntakeInput,
    ) => Effect.Effect<VideoProjectScanIntakeResult, VideoProjectError>;
    /**
     * Copies scanned files into the project's Footage folder in the background, checking each
     * copy's size, then builds proxies. The originals are left where they are. Progress is
     * written to `intake.json` in the project folder.
     */
    readonly importFootage: (
      input: VideoProjectImportFootageInput,
    ) => Effect.Effect<void, VideoProjectError>;
    /**
     * Pulls Premiere's latest save into the project's timelines when the `.prproj` changed, and
     * (re)starts the proxy build when new media arrived or an earlier build never finished.
     * Cheap enough to call whenever a client comes back into focus.
     */
    readonly sync: (
      input: VideoProjectSyncInput,
    ) => Effect.Effect<VideoProjectSyncResult, VideoProjectError>;
  }
>()("t3/videoProject/VideoProjects") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const background = yield* FiberSet.make();
  const syncing = yield* Semaphore.make(1);
  const building = new Set<string>();
  const importing = new Set<string>();
  const downloads = path.join(yield* HostProcess.HomeDirectory, "Downloads");
  const queued = new Set<string>();

  /**
   * Builds a project's proxies in the background, one build per project at a time. A request
   * that arrives mid-build (a pull brought new media) runs another build when this one ends.
   */
  const startProxies = (projectFolder: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (building.has(projectFolder)) {
        queued.add(projectFolder);
        return Effect.void;
      }
      building.add(projectFolder);
      const build = FiberSet.run(
        background,
        buildProjectProxies({ projectDir: projectFolder, concurrency: PROXY_CONCURRENCY }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          // The footage timeline needs each clip's length, which the proxy index now has.
          Effect.tap(() =>
            writeFootageStringout(projectFolder).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.ignore,
            ),
          ),
          Effect.tap((result) =>
            Effect.logInfo("Video project proxies ready", {
              projectFolder,
              files: result.count,
              failed: result.failed,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Video project proxies failed", { projectFolder, cause }),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              building.delete(projectFolder);
              return queued.delete(projectFolder) ? startProxies(projectFolder) : Effect.void;
            }),
          ),
        ),
      );
      return markProxiesBuilding(projectFolder).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.ignore,
        Effect.andThen(build),
        Effect.asVoid,
      );
    });

  /** True when no build is running and the index is missing or was left mid-build. */
  const proxiesUnfinished = (projectFolder: string) =>
    fileSystem.readFileString(path.join(projectFolder, PROXY_INDEX_PATH)).pipe(
      Effect.flatMap(decodeJson),
      Effect.map((index) => (index as ProxyIndex).building !== undefined),
      Effect.orElseSucceed(() => true),
      Effect.map((unfinished) => unfinished && !building.has(projectFolder)),
    );

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

    const timelinePath = path.relative(projectFolder, pulled.timelinePath);
    yield* recordPull({
      projectDir: projectFolder,
      premiereProject: input.premiereProjectPath,
      timelinePath,
      sequenceId: input.sequenceId,
      text: pulled.text,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) => new VideoProjectError({ reason: "Could not link the Premiere project.", cause }),
      ),
    );
    yield* startProxies(projectFolder);

    return {
      projectId: project.id,
      workspaceRoot: projectFolder,
      timelinePath,
      existed: Option.isSome(existing),
    };
  });

  const createFromIdea: VideoProjects["Service"]["createFromIdea"] = Effect.fn(
    "VideoProjects.createFromIdea",
  )(function* (input) {
    // The title names a folder, so anything a path would read as a separator comes out.
    const folderName = input.title
      .replace(/[/\\:]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (folderName === "" || folderName.startsWith(".")) {
      return yield* new VideoProjectError({ reason: "Give the project a name." });
    }
    const parent = yield* fileSystem.stat(input.parentFolder).pipe(Effect.option);
    if (
      !path.isAbsolute(input.parentFolder) ||
      Option.isNone(parent) ||
      parent.value.type !== "Directory"
    ) {
      return yield* new VideoProjectError({ reason: "Choose an existing folder to create it in." });
    }
    const root = path.join(input.parentFolder, folderName);
    for (const folder of PROJECT_FOLDERS) {
      yield* fileSystem.makeDirectory(path.join(root, folder), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new VideoProjectError({
              reason: `Could not create ${path.join(root, folder)}.`,
              cause,
            }),
        ),
      );
    }
    const projectFolder = path.join(root, STELLAR_FOLDER);
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
              title: input.title,
              workspaceRoot: projectFolder,
              createWorkspaceRootIfMissing: true,
            }),
          ),
          Effect.mapError(
            (cause) => new VideoProjectError({ reason: "Could not add the project.", cause }),
          ),
        );
    return {
      projectId: project.id,
      workspaceRoot: projectFolder,
      existed: Option.isSome(existing),
    };
  });

  /** Clients name a project by its folder; only folders that are projects here are acted on. */
  const requireProject = Effect.fn("VideoProjects.requireProject")(function* (
    workspaceRoot: string,
  ) {
    const known = yield* projects
      .getByWorkspaceRoot(workspaceRoot)
      .pipe(
        Effect.mapError(
          (cause) => new VideoProjectError({ reason: "Could not look up projects.", cause }),
        ),
      );
    if (Option.isNone(known)) {
      return yield* new VideoProjectError({ reason: "That folder isn't a project here." });
    }
  });

  const scanIntake: VideoProjects["Service"]["scanIntake"] = Effect.fn("VideoProjects.scanIntake")(
    function* (input) {
      yield* requireProject(input.workspaceRoot);
      const since = (yield* Clock.currentTimeMillis) - INTAKE_DAYS * 24 * 60 * 60 * 1000;
      // AirDrop keeps a file's original dates, so only Spotlight knows when it arrived. Without
      // Spotlight (other systems), fall back to files modified recently.
      const arrived = yield* spawner
        .string(
          ChildProcess.make("mdfind", [
            "-onlyin",
            downloads,
            `kMDItemDateAdded >= $time.today(-${INTAKE_DAYS})`,
          ]),
        )
        .pipe(
          Effect.map((output) => new Set(output.split("\n").filter((line) => line !== ""))),
          // No answer also covers Spotlight being off for the folder.
          Effect.map((found) => (found.size === 0 ? null : found)),
          Effect.orElseSucceed(() => null),
        );
      const names = yield* fileSystem
        .readDirectory(downloads)
        .pipe(Effect.orElseSucceed((): Array<string> => []));
      const files: Array<VideoProjectScanIntakeResult["files"][number]> = [];
      for (const name of names) {
        if (!INTAKE_FILE.test(name) || name.startsWith(".")) continue;
        const file = path.join(downloads, name);
        if (arrived !== null && !arrived.has(file)) continue;
        const stat = yield* fileSystem.stat(file).pipe(Effect.option);
        if (Option.isNone(stat) || stat.value.type !== "File") continue;
        const capturedAt = Option.match(stat.value.mtime, {
          onNone: () => 0,
          onSome: (date) => date.getTime(),
        });
        if (arrived === null && capturedAt < since) continue;
        files.push({ path: file, name, size: Number(stat.value.size), capturedAt });
      }
      return {
        source: downloads,
        files: files.toSorted(
          (a, b) => a.capturedAt - b.capturedAt || a.name.localeCompare(b.name),
        ),
      };
    },
  );

  const importFootage: VideoProjects["Service"]["importFootage"] = Effect.fn(
    "VideoProjects.importFootage",
  )(function* (input) {
    yield* requireProject(input.workspaceRoot);
    const folder = input.folder.replace(/[/\\:]+/g, " ").trim();
    if (folder === "" || folder.startsWith(".")) {
      return yield* new VideoProjectError({ reason: "Name the folder the footage goes in." });
    }
    if (input.paths.some((file) => path.dirname(path.resolve(file)) !== downloads)) {
      return yield* new VideoProjectError({ reason: `Footage is imported from ${downloads}.` });
    }
    if (importing.has(input.workspaceRoot)) {
      return yield* new VideoProjectError({ reason: "An import is already running." });
    }
    const destination = path.join(path.dirname(input.workspaceRoot), FOOTAGE_DIRECTORY, folder);
    const total = input.paths.length;
    const report = (status: Omit<VideoProjectIntakeStatus, "folder" | "total">) =>
      fileSystem
        .writeFileString(
          path.join(input.workspaceRoot, INTAKE_STATUS_FILE),
          serializeJson({ ...status, folder: destination, total }),
        )
        .pipe(Effect.ignore);
    const copy = copyFootage({
      sources: input.paths,
      destination,
      onCopied: (done) => report({ state: "copying", done }),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.tap((done) => report({ state: "done", done })),
      Effect.andThen(startProxies(input.workspaceRoot)),
      Effect.catch((error) =>
        report({ state: "failed", done: 0, error: error.message }).pipe(
          Effect.andThen(Effect.logWarning("Footage import failed", { destination, error })),
        ),
      ),
      Effect.ensuring(Effect.sync(() => importing.delete(input.workspaceRoot))),
    );
    importing.add(input.workspaceRoot);
    yield* report({ state: "copying", done: 0 });
    yield* FiberSet.run(background, copy);
  });

  const sync: VideoProjects["Service"]["sync"] = Effect.fn("VideoProjects.sync")(function* (input) {
    yield* requireProject(input.workspaceRoot);
    // One at a time: two clients coming into focus together must not both rewrite a timeline.
    const result = yield* syncing.withPermits(1)(
      syncFromPremiere({
        projectDir: input.workspaceRoot,
        ...(input.usePremiere === undefined ? {} : { usePremiere: input.usePremiere }),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) => new VideoProjectError({ reason: "Could not sync with Premiere.", cause }),
        ),
      ),
    );
    if (result.updated.length > 0 || (yield* proxiesUnfinished(input.workspaceRoot))) {
      yield* startProxies(input.workspaceRoot);
    }
    return result;
  });

  return VideoProjects.of({
    inspectPremiere,
    createFromPremiere,
    createFromIdea,
    scanIntake,
    importFootage,
    sync,
  });
});

export const layer = Layer.effect(VideoProjects, make);
