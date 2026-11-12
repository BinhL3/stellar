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
  type VideoProjectSaveVoiceOverInput,
  type VideoProjectSaveVoiceOverResult,
  type VideoProjectScanIntakeInput,
  type VideoProjectScanIntakeResult,
  type VideoProjectSyncInput,
  type VideoPremierePushPlan,
  type VideoProjectSyncResult,
  type VideoScriptReadInput,
  type VideoScriptSaveInput,
  type VideoScriptView,
  type VideoTimelineEdit,
  type VideoTimelineEditInput,
  type VideoTimelineExportResult,
  type VideoTimelineReadInput,
  type VideoTimelineView,
  type VideoTimelineWords,
  type VideoTranscribeInput,
  type VideoTranscriptStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import { editableView } from "@t3tools/timeline/compactView";
import { changeLine, diffSentences } from "@t3tools/timeline/diff";
import { applyEdits, type TimelineEdit } from "@t3tools/timeline/edits";
import {
  copyFootage,
  listFootage,
  FOOTAGE_DIRECTORY,
  FOOTAGE_TIMELINE_PATH,
  writeFootageStringout,
} from "@t3tools/timeline/footage";
import { layoutTimeline } from "@t3tools/timeline/layout";
import { serializeJson, serializeTimeline, type Timeline } from "@t3tools/timeline/otio";
import { toFcpXml } from "@t3tools/timeline/premiere/fcpxml";
import { parsePrproj } from "@t3tools/timeline/premiere/prproj";
import { pushPlan as planPush } from "@t3tools/timeline/premiere/pushPlan";
import {
  PREMIERE_LINK_PATH,
  type PremiereSyncResult,
  recordPull,
  type SequenceChange,
  syncFromPremiere,
  type TimelineChanges,
} from "@t3tools/timeline/premiereSync";
import { PROXY_INDEX_PATH, type ProxyIndex } from "@t3tools/timeline/proxies";
import { buildProjectProxies, markProxiesBuilding } from "@t3tools/timeline/proxyBuilder";
import { BASE_DIRECTORY, pullToProject } from "@t3tools/timeline/pullToProject";
import { alignBeats, assignBeatIds, parseScript } from "@t3tools/timeline/script";
import { timelineWords, type TranscriptWord, wordRange, wordsText } from "@t3tools/timeline/words";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
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
import * as ServerSettings from "../serverSettings.ts";
import {
  decodeTranscript,
  findTranscript,
  projectLanguage,
  runTranscription,
  transcriptCoverage,
  writeTranscriptStatus,
} from "./Transcriber.ts";

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
// What the host's transcriber is called when no command is set in settings.
const DEFAULT_TRANSCRIBE_COMMAND = "stt";

/** The script snapshot in the project folder: the text, and beside it the ids its beats were given. */
const SCRIPT_FILE = "script.md";
const SCRIPT_INDEX_FILE = "script.json";
const ScriptIndex = Schema.Struct({
  docUrl: Schema.NullOr(Schema.String),
  savedAt: Schema.NullOr(Schema.Number),
  beats: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
  nextId: Schema.Number,
});
const decodeScriptIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(ScriptIndex));
const NO_SCRIPT: typeof ScriptIndex.Type = { docUrl: null, savedAt: null, beats: [], nextId: 1 };

type FrameRange = { readonly start: number; readonly end: number };

// A split names its new pieces after the clip it cut ("id~frame"), so a later edit in the same
// call can name a piece that doesn't exist until the split has run.
const isSplitPiece = (clipId: string) => clipId.includes("~");

/** The typed edit a flat tool input describes, or what is missing from it. */
const toTimelineEdit = (
  edit: VideoTimelineEdit,
  framesOfWords: (fromWord: number, toWord: number, ripple: boolean) => FrameRange | string,
): TimelineEdit | string => {
  const missing = (...keys: ReadonlyArray<keyof VideoTimelineEdit>) =>
    `needs ${keys.filter((key) => edit[key] === undefined).join(", ")}`;
  switch (edit.kind) {
    case "move": {
      const { clipId, toTrack, startFrame } = edit;
      if (clipId === undefined || toTrack === undefined || startFrame === undefined) {
        return missing("clipId", "toTrack", "startFrame");
      }
      return {
        kind: "move",
        clipId,
        toTrack,
        startFrame,
        ...(edit.magnetic === undefined ? {} : { magnetic: edit.magnetic }),
      };
    }
    case "trim": {
      const { clipId, edge, frame } = edit;
      if (clipId === undefined || edge === undefined || frame === undefined) {
        return missing("clipId", "edge", "frame");
      }
      return { kind: "trim", clipId, edge, frame };
    }
    case "delete":
    case "rippleDelete":
      return edit.clipId === undefined
        ? missing("clipId")
        : { kind: edit.kind, clipId: edit.clipId };
    case "split":
      return edit.frame === undefined
        ? missing("frame")
        : {
            kind: "split",
            frame: edit.frame,
            ...(edit.tracks === undefined ? {} : { tracks: edit.tracks }),
          };
    case "removeRange": {
      const { start, end } = edit;
      if (start === undefined || end === undefined) return missing("start", "end");
      return { kind: "removeRange", start, end, ripple: edit.ripple ?? false };
    }
    case "removeWords": {
      const { fromWord, toWord } = edit;
      if (fromWord === undefined || toWord === undefined) return missing("fromWord", "toWord");
      const ripple = edit.ripple ?? false;
      const range = framesOfWords(fromWord, toWord, ripple);
      return typeof range === "string" ? range : { kind: "removeRange", ...range, ripple };
    }
    case "setEnabled": {
      const { clipId, enabled } = edit;
      if (clipId === undefined || enabled === undefined) return missing("clipId", "enabled");
      return { kind: "setEnabled", clipId, enabled };
    }
    case "setText": {
      const { clipId, text } = edit;
      if (clipId === undefined || text === undefined) return missing("clipId", "text");
      return { kind: "setText", clipId, text };
    }
  }
};

const sequenceSentence = (change: SequenceChange) =>
  change.kind === "added"
    ? `New sequence: ${change.name}${change.timelinePath === null ? " (not pulled: it can't be read, or a timeline already has its file name)" : ""}`
    : change.kind === "renamed"
      ? `Sequence renamed in Premiere: ${change.before} is now ${change.name}`
      : `Sequence ${change.name} was deleted in Premiere; ${change.timelinePath} is kept here`;

const timelineLabel = (timelinePath: string) => timelinePath.replace(/^timelines\/|\.otio$/g, "");

/** A sentence per change; each names its timeline when more than one timeline has any. */
const sentencesOf = <A extends { readonly timelinePath: string }>(
  entries: ReadonlyArray<A>,
  sentences: (entry: A) => ReadonlyArray<string>,
) =>
  entries.flatMap((entry) =>
    sentences(entry).map((sentence) =>
      entries.length > 1 ? `${timelineLabel(entry.timelinePath)}: ${sentence}` : sentence,
    ),
  );

const NO_BASE =
  "Stellar has no copy of what it last pulled from Premiere to tell the two sets of edits apart.";

// Tool output stays small: a long list is cut to this many lines and a count of the rest.
const CHANGE_LINES = 12;
const capped = (lines: ReadonlyArray<string>) =>
  lines.length <= CHANGE_LINES
    ? lines
    : [...lines.slice(0, CHANGE_LINES), `+${lines.length - CHANGE_LINES} more`];

/** What a sync found, as an agent reads it: lines in `editableView`'s vocabulary under headings. */
const changesText = (synced: PremiereSyncResult) => {
  const section = (heading: string, entries: ReadonlyArray<TimelineChanges>) =>
    entries.flatMap((entry) => [
      `${heading} (${entry.timelinePath}):`,
      ...capped(entry.diff.changes.map(changeLine)),
    ]);
  return [
    ...synced.sequences.map(sequenceSentence),
    ...section("Changed in Premiere since your last read", synced.changes),
    ...synced.conflicts.flatMap((entry) => [
      `Edits made here that were dropped, Premiere's version stands (${entry.timelinePath}):`,
      ...capped(entry.conflicts.map((conflict) => conflict.message)),
    ]),
    ...synced.unmerged.map(
      (timelinePath) =>
        `! ${timelinePath} was edited here and in Premiere and can't be merged: ${NO_BASE} The user chooses a version in Stellar.`,
    ),
    ...section(
      "Edited here, not in Premiere yet",
      synced.pending.filter((entry) => !synced.unmerged.includes(entry.timelinePath)),
    ),
  ].join("\n");
};

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
    /**
     * Saves a voice-over recorded in a client as a 48 kHz WAV under `Audio/VO`, the form
     * Premiere imports; browsers record WebM or MP4 audio, which it doesn't.
     */
    readonly saveVoiceOver: (
      input: VideoProjectSaveVoiceOverInput,
    ) => Effect.Effect<VideoProjectSaveVoiceOverResult, VideoProjectError>;
    /**
     * Writes a timeline as an XML file in the project's Premiere folder, which Premiere imports
     * as a new sequence. Only the cut travels; what can't is listed in `skipped`.
     */
    readonly exportForPremiere: (
      input: VideoTimelineReadInput,
    ) => Effect.Effect<VideoTimelineExportResult, VideoProjectError>;
    /**
     * The ordered steps that change the sequence open in Premiere into the timeline edited
     * here, touching only what differs from Premiere's last save. Nothing is changed: an agent
     * applies the steps with its Premiere tools. Refused while Premiere holds a newer save.
     */
    readonly pushPlan: (
      input: VideoTimelineReadInput,
    ) => Effect.Effect<VideoPremierePushPlan, VideoProjectError>;
    /** A timeline as an agent reads it, synced with Premiere first so it is never stale. */
    readonly readTimeline: (
      input: VideoTimelineReadInput,
    ) => Effect.Effect<VideoTimelineView, VideoProjectError>;
    /**
     * Applies edits to a timeline file and returns the result. Edits that name a missing clip
     * or leave out a field their kind needs are refused, and nothing is written.
     */
    readonly editTimeline: (
      input: VideoTimelineEditInput,
    ) => Effect.Effect<VideoTimelineView, VideoProjectError>;
    /**
     * The words spoken on a timeline, numbered and placed in frames, from the transcripts
     * `transcribe` or the user's own pipeline wrote under `Audio`.
     */
    readonly readWords: (
      input: VideoTimelineReadInput,
    ) => Effect.Effect<VideoTimelineWords, VideoProjectError>;
    /**
     * Starts the host's transcriber on the footage and voice-over takes that have no word-timed
     * transcript, in the background, and returns where that stands. A request made while a run
     * is going is taken up when it ends. With no transcriber, says so in `unavailable`.
     */
    readonly transcribe: (
      input: VideoTranscribeInput,
    ) => Effect.Effect<VideoTranscriptStatus, VideoProjectError>;
    /**
     * The project's snapshot of the script as beats, each placed on a timeline where its words
     * are said. A project with no snapshot has no beats.
     */
    readonly readScript: (
      input: VideoScriptReadInput,
    ) => Effect.Effect<VideoScriptView, VideoProjectError>;
    /**
     * Replaces the snapshot's text and/or records the Google Doc it came from. A beat whose
     * text is the same or lightly edited keeps its id.
     */
    readonly saveScript: (
      input: VideoScriptSaveInput,
    ) => Effect.Effect<VideoScriptView, VideoProjectError>;
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
  const savingScript = yield* Semaphore.make(1);
  // Premiere's process is named for its year ("Adobe Premiere Pro 2026"); `ps` lists it on macOS
  // and Linux. Where `ps` isn't there, the answer is unknown rather than "closed".
  const premiereRunning = spawner.string(ChildProcess.make("ps", ["-axo", "comm"])).pipe(
    Effect.map((processes) => /Adobe Premiere Pro/.test(processes)),
    Effect.orElseSucceed((): boolean | null => null),
  );
  const building = new Set<string>();
  const importing = new Set<string>();
  const downloads = path.join(yield* HostProcess.HomeDirectory, "Downloads");
  const queued = new Set<string>();
  const settings = yield* ServerSettings.ServerSettingsService;
  const onHost = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  /** The host's transcriber as a file to run, or the reason there is none. */
  const resolveTranscriber = Effect.gen(function* () {
    const configured = yield* settings.getSettings.pipe(
      Effect.map((current) => current.videoTranscribeCommand),
      Effect.orElseSucceed(() => ""),
    );
    const command = yield* onHost(resolveCommandPath(configured || DEFAULT_TRANSCRIBE_COMMAND));
    if (command !== null) return { command, unavailable: null };
    return {
      command: null,
      unavailable:
        configured === ""
          ? `No transcriber on this machine: put \`${DEFAULT_TRANSCRIBE_COMMAND}\` on the PATH, or set the transcribe command in Settings.`
          : `The transcribe command set in Settings (${configured}) isn't on this machine.`,
    };
  });

  interface TranscribeRequest {
    /** Every candidate without a transcript, besides the files named. */
    readonly everything: boolean;
    readonly files: ReadonlyArray<string>;
    readonly language: VideoTranscribeInput["language"];
  }
  // Projects with a transcription run going and where each stands, and what was asked of them
  // meanwhile. Starting is serialized so two requests can't both find no run and start one.
  const transcribing = new Map<string, VideoTranscriptStatus>();
  const transcribeQueued = new Map<string, TranscribeRequest>();
  const transcribeStarting = yield* Semaphore.make(1);

  /**
   * Transcribes a project's media in the background, one run per project at a time. A request
   * that arrives mid-run is merged with any other waiting and runs when this one ends.
   */
  const startTranscripts = (
    projectFolder: string,
    request: TranscribeRequest,
  ): Effect.Effect<VideoTranscriptStatus> =>
    transcribeStarting.withPermits(1)(
      Effect.gen(function* () {
        const running = transcribing.get(projectFolder);
        if (running !== undefined) {
          const waiting = transcribeQueued.get(projectFolder);
          transcribeQueued.set(
            projectFolder,
            waiting === undefined
              ? request
              : {
                  everything: waiting.everything || request.everything,
                  files: [...waiting.files, ...request.files],
                  language: request.language ?? waiting.language,
                },
          );
          return running;
        }
        const mediaRoot = path.dirname(projectFolder);
        const coverage = yield* onHost(transcriptCoverage(mediaRoot));
        const targets = new Set(request.everything ? coverage.missing : []);
        for (const file of request.files) {
          if ((yield* onHost(findTranscript(mediaRoot, file))) === null) targets.add(file);
        }
        const transcriber = yield* resolveTranscriber;
        const idle: VideoTranscriptStatus = {
          building: null,
          ready: coverage.total - coverage.missing.length,
          total: coverage.total,
          failed: [],
          unavailable: transcriber.unavailable,
        };
        if (transcriber.command === null || targets.size === 0) {
          yield* onHost(writeTranscriptStatus(projectFolder, idle));
          return idle;
        }
        const starting = { ...idle, building: { done: 0, total: targets.size } };
        transcribing.set(projectFolder, starting);
        // Clients poll this file, so it says "building" before the first clip is done.
        yield* onHost(writeTranscriptStatus(projectFolder, starting));
        yield* FiberSet.run(
          background,
          onHost(
            runTranscription({
              projectDir: projectFolder,
              command: transcriber.command,
              language: request.language ?? (yield* onHost(projectLanguage(projectFolder))),
              targets: [...targets],
              coverage,
              onStatus: (status) =>
                Effect.sync(() => {
                  if (status.building !== null) transcribing.set(projectFolder, status);
                }),
            }),
          ).pipe(
            Effect.tap((status) =>
              Effect.logInfo("Video project transcripts ready", {
                projectFolder,
                ready: status.ready,
                total: status.total,
                failed: status.failed.length,
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("Video project transcription failed", { projectFolder, cause }),
            ),
            Effect.ensuring(
              Effect.suspend(() => {
                transcribing.delete(projectFolder);
                const next = transcribeQueued.get(projectFolder);
                transcribeQueued.delete(projectFolder);
                return next === undefined ? Effect.void : startTranscripts(projectFolder, next);
              }),
            ),
          ),
        );
        return starting;
      }),
    );

  /** Transcribes whatever has no transcript yet; a no-op without a transcriber. */
  const transcribeMissing = (projectFolder: string) =>
    startTranscripts(projectFolder, { everything: true, files: [], language: undefined });

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
          Effect.tap(() => transcribeMissing(projectFolder)),
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

  const syncWithPremiere = Effect.fn("VideoProjects.syncWithPremiere")(function* (
    input: VideoProjectSyncInput,
  ) {
    yield* requireProject(input.workspaceRoot);
    // One at a time: two clients coming into focus together must not both rewrite a timeline.
    const result = yield* syncing.withPermits(1)(
      syncFromPremiere({
        projectDir: input.workspaceRoot,
        ...(input.usePremiere === undefined ? {} : { usePremiere: input.usePremiere }),
        ...(input.merge === undefined ? {} : { merge: input.merge }),
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
    const view: VideoProjectSyncResult = {
      state: result.state,
      premiereSavedAt: result.premiereSavedAt,
      updated: result.updated,
      kept: result.kept,
      premiereRunning: yield* premiereRunning,
      changes: [
        ...result.sequences.map(sequenceSentence),
        ...sentencesOf(result.changes, (entry) => diffSentences(entry.diff)),
      ],
      pending: sentencesOf(result.pending, (entry) => diffSentences(entry.diff)),
      conflicts: sentencesOf(result.conflicts, (entry) =>
        entry.conflicts.map((conflict) => conflict.message),
      ),
    };
    return { result, view };
  });

  const sync: VideoProjects["Service"]["sync"] = Effect.fn("VideoProjects.sync")(function* (input) {
    const { result, view } = yield* syncWithPremiere(input);
    const [unmerged] = result.unmerged;
    if (unmerged !== undefined) {
      return yield* new VideoProjectError({
        reason: `Can't merge ${unmerged}: ${NO_BASE} Take Premiere's version, or keep yours.`,
      });
    }
    return view;
  });

  /**
   * The sync agents read and edit behind: a timeline edited here and in Premiere is merged, so
   * an agent never works on a copy that lacks the user's hand edits.
   */
  const syncForAgent = (workspaceRoot: string) => syncWithPremiere({ workspaceRoot, merge: true });

  const loadScript = Effect.fn("VideoProjects.loadScript")(function* (workspaceRoot: string) {
    const text = yield* fileSystem
      .readFileString(path.join(workspaceRoot, SCRIPT_FILE))
      .pipe(Effect.orElseSucceed(() => ""));
    const index = yield* fileSystem
      .readFileString(path.join(workspaceRoot, SCRIPT_INDEX_FILE))
      .pipe(
        Effect.flatMap(decodeScriptIndex),
        Effect.orElseSucceed(() => NO_SCRIPT),
      );
    // script.md can be written without saveScript (by hand, by another tool); ids follow its lines.
    const assigned = assignBeatIds(index.beats, parseScript(text), index.nextId);
    return { docUrl: index.docUrl, savedAt: index.savedAt, ...assigned };
  });

  /**
   * The facts an agent would otherwise spend its first minute discovering, one per line.
   * Anything that blocks work (Premiere closed, no ffmpeg) is said plainly.
   */
  const describeProject = Effect.fn("VideoProjects.describeProject")(function* (
    workspaceRoot: string,
    synced: VideoProjectSyncResult,
  ) {
    const mediaRoot = path.dirname(workspaceRoot);
    const names = (folder: string) =>
      fileSystem
        .readDirectory(path.join(mediaRoot, folder))
        .pipe(Effect.orElseSucceed((): Array<string> => []));
    const footage = yield* listFootage(mediaRoot).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const index = yield* fileSystem.readFileString(path.join(workspaceRoot, PROXY_INDEX_PATH)).pipe(
      Effect.flatMap(decodeJson),
      Effect.map((value) => value as ProxyIndex),
      Effect.orElseSucceed(() => null),
    );
    const link = yield* fileSystem
      .readFileString(path.join(workspaceRoot, PREMIERE_LINK_PATH))
      .pipe(
        Effect.flatMap(decodeJson),
        Effect.map((value) => (value as { project?: string }).project ?? null),
        Effect.orElseSucceed(() => null),
      );
    const coverage = yield* onHost(transcriptCoverage(mediaRoot));
    const transcribed = transcribing.get(workspaceRoot)?.building;
    const transcripts = `${coverage.total - coverage.missing.length} of ${coverage.total} clips and takes word-timed${
      transcribed
        ? `, transcribing now (${transcribed.done} of ${transcribed.total} done)`
        : coverage.missing.length > 0
          ? ` (${(yield* resolveTranscriber).unavailable ?? "video_transcribe makes the rest"})`
          : ""
    }`;
    const takes = (yield* names(path.join("Audio", "VO"))).filter((name) => name.endsWith(".wav"));
    const script = yield* loadScript(workspaceRoot);
    const scriptLine =
      script.beats.length === 0 && script.docUrl === null
        ? "none (video_script saves one)"
        : `${script.beats.length} beats in Stellar/${SCRIPT_FILE}, Google Doc ${script.docUrl === null ? "not recorded" : "recorded"} (video_script)`;
    const hasFfmpeg = yield* spawner.string(ChildProcess.make("ffmpeg", ["-version"])).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    const running =
      synced.premiereRunning === null
        ? "may or may not be open (can't tell on this system)"
        : synced.premiereRunning
          ? "is open"
          : "is NOT open: Premiere tools will fail until the user opens it";
    const linked =
      link === null
        ? "no Premiere project is linked (save one into the Premiere folder, then video_premiere_pull)"
        : synced.state === "offline"
          ? `linked project ${link} can't be read (drive unplugged or file moved)`
          : `linked to ${link} (${synced.state})`;
    const previews =
      index === null
        ? "none built yet"
        : index.building !== undefined
          ? `building, ${index.building.done} of ${index.building.total}`
          : `ready for ${Object.keys(index.media).length} files${index.failed ? `, ${index.failed} failed` : ""}`;
    return [
      `Project folder: ${mediaRoot}`,
      `Premiere ${running}; ${linked}.`,
      `Footage: ${footage.length} videos in Footage/. Previews: ${previews}.`,
      `Transcripts: ${transcripts}. Script snapshot: ${scriptLine}. Voice-over takes: ${takes.length} in Audio/VO/.`,
      ...(hasFfmpeg
        ? []
        : ["ffmpeg is NOT installed: previews, imports and voice-over can't be made."]),
    ].join("\n");
  });

  const listTimelines = (workspaceRoot: string) =>
    fileSystem.readDirectory(path.join(workspaceRoot, "timelines")).pipe(
      Effect.orElseSucceed((): Array<string> => []),
      Effect.map((names) =>
        names
          .filter((name) => name.endsWith(".otio"))
          .map((name) => `timelines/${name}`)
          .toSorted(),
      ),
    );

  const loadTimeline = Effect.fn("VideoProjects.loadTimeline")(function* (
    workspaceRoot: string,
    timelinePath: string,
  ) {
    const timelines = yield* listTimelines(workspaceRoot);
    if (!timelines.includes(timelinePath)) {
      return yield* new VideoProjectError({
        reason: `No timeline ${timelinePath}. This project has: ${timelines.join(", ") || "none"}.`,
      });
    }
    return yield* fileSystem.readFileString(path.join(workspaceRoot, timelinePath)).pipe(
      Effect.flatMap(decodeJson),
      Effect.map((value) => value as Timeline),
      Effect.mapError(
        (cause) => new VideoProjectError({ reason: `Could not read ${timelinePath}.`, cause }),
      ),
    );
  });

  const loadWords = Effect.fn("VideoProjects.loadWords")(function* (
    workspaceRoot: string,
    timeline: Timeline,
  ) {
    const targets = new Set(
      layoutTimeline(timeline)
        .tracks.filter((track) => track.kind === "Audio")
        .flatMap((track) =>
          track.clips.map((item) => item.clip.media_references.DEFAULT_MEDIA.target_url),
        ),
    );
    const mediaRoot = path.dirname(workspaceRoot);
    const transcripts = new Map<string, ReadonlyArray<TranscriptWord>>();
    for (const target of targets) {
      if (target === "") continue;
      const file = yield* findTranscript(mediaRoot, target).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      if (file === null) continue;
      transcripts.set(
        target,
        yield* fileSystem.readFileString(file).pipe(
          Effect.flatMap(decodeTranscript),
          Effect.mapError(
            (cause) =>
              new VideoProjectError({
                reason: `Could not read the transcript ${file}.`,
                cause,
              }),
          ),
        ),
      );
    }
    return timelineWords(timeline, transcripts);
  });

  const readWords: VideoProjects["Service"]["readWords"] = Effect.fn("VideoProjects.readWords")(
    function* (input) {
      // Merged first, as editTimeline does, so the word numbers here are the ones it cuts by.
      yield* syncForAgent(input.workspaceRoot);
      const timelines = yield* listTimelines(input.workspaceRoot);
      const chosen =
        input.timeline ??
        timelines.find((candidate) => candidate !== FOOTAGE_TIMELINE_PATH) ??
        timelines[0];
      if (chosen === undefined) {
        return yield* new VideoProjectError({ reason: "This project has no timeline to read." });
      }
      const timeline = yield* loadTimeline(input.workspaceRoot, chosen);
      return { timeline: chosen, text: wordsText(yield* loadWords(input.workspaceRoot, timeline)) };
    },
  );

  const scriptView = Effect.fn("VideoProjects.scriptView")(function* (
    workspaceRoot: string,
    requested: string | undefined,
  ) {
    const script = yield* loadScript(workspaceRoot);
    const timelines = yield* listTimelines(workspaceRoot);
    const chosen =
      requested ??
      timelines.find((candidate) => candidate !== FOOTAGE_TIMELINE_PATH) ??
      timelines[0] ??
      null;
    const words =
      chosen === null
        ? { name: "", rate: 0, count: 0, clips: [] }
        : yield* loadWords(workspaceRoot, yield* loadTimeline(workspaceRoot, chosen));
    return {
      docUrl: script.docUrl,
      savedAt: script.savedAt,
      timeline: chosen,
      beats: alignBeats(script.beats, words),
    };
  });

  const readScript: VideoProjects["Service"]["readScript"] = Effect.fn("VideoProjects.readScript")(
    function* (input) {
      // Synced first, as readWords is, so the word numbers here are the ones it gives.
      yield* sync({ workspaceRoot: input.workspaceRoot });
      return yield* scriptView(input.workspaceRoot, input.timeline);
    },
  );

  const saveScript: VideoProjects["Service"]["saveScript"] = Effect.fn("VideoProjects.saveScript")(
    function* (input) {
      yield* requireProject(input.workspaceRoot);
      const { text, docUrl } = input;
      if (text === undefined && docUrl === undefined) {
        return yield* new VideoProjectError({ reason: "Saving the script needs text or docUrl." });
      }
      // One at a time, so two saves can't hand the same new id to different beats.
      yield* savingScript.withPermits(1)(
        Effect.gen(function* () {
          const previous = yield* loadScript(input.workspaceRoot);
          const { beats, nextId } =
            text === undefined
              ? previous
              : assignBeatIds(previous.beats, parseScript(text), previous.nextId);
          if (text !== undefined) {
            yield* fileSystem.writeFileString(path.join(input.workspaceRoot, SCRIPT_FILE), text);
          }
          yield* fileSystem.writeFileString(
            path.join(input.workspaceRoot, SCRIPT_INDEX_FILE),
            serializeJson({
              docUrl: docUrl ?? previous.docUrl,
              savedAt: yield* Clock.currentTimeMillis,
              beats: beats.map((beat) => ({ id: beat.id, text: beat.text })),
              nextId,
            } satisfies typeof ScriptIndex.Type),
          );
        }).pipe(
          Effect.mapError(
            (cause) => new VideoProjectError({ reason: "Could not save the script.", cause }),
          ),
        ),
      );
      return yield* readScript({ workspaceRoot: input.workspaceRoot });
    },
  );

  const transcribe: VideoProjects["Service"]["transcribe"] = Effect.fn("VideoProjects.transcribe")(
    function* (input) {
      yield* requireProject(input.workspaceRoot);
      const mediaRoot = path.dirname(input.workspaceRoot);
      const files = (input.files ?? []).map((file) =>
        path.relative(mediaRoot, path.resolve(mediaRoot, file)),
      );
      if (files.some((file) => file === "" || file.startsWith("..") || path.isAbsolute(file))) {
        return yield* new VideoProjectError({
          reason: `Files to transcribe are named relative to ${mediaRoot}.`,
        });
      }
      return yield* startTranscripts(input.workspaceRoot, {
        everything: input.files === undefined,
        files: files.map((file) => file.split(path.sep).join("/")),
        language: input.language,
      });
    },
  );

  const readTimeline: VideoProjects["Service"]["readTimeline"] = Effect.fn(
    "VideoProjects.readTimeline",
  )(function* (input) {
    const { result, view: synced } = yield* syncForAgent(input.workspaceRoot);
    const timelines = yield* listTimelines(input.workspaceRoot);
    const chosen =
      input.timeline ??
      timelines.find((candidate) => candidate !== FOOTAGE_TIMELINE_PATH) ??
      timelines[0] ??
      null;
    if (chosen === null) {
      return {
        timelines,
        timeline: null,
        premiere: synced.state,
        project: yield* describeProject(input.workspaceRoot, synced),
        changes: changesText(result),
        text: "",
      };
    }
    const timeline = yield* loadTimeline(input.workspaceRoot, chosen);
    // Clips whose frame rate changes partway can't be cut by time until they are conformed.
    const index = yield* fileSystem
      .readFileString(path.join(input.workspaceRoot, PROXY_INDEX_PATH))
      .pipe(
        Effect.flatMap(decodeJson),
        Effect.map((value) => value as ProxyIndex),
        Effect.orElseSucceed(() => null),
      );
    const warnings = Object.entries(index?.media ?? {}).flatMap(([target, entry]) =>
      entry.rateChanges === undefined
        ? []
        : [
            `! ${path.basename(target)} changes frame rate (${entry.rateChanges.map((change) => `${change.fps} fps from ${change.at}s`).join(", ")}). Conform it whole to one rate before cutting it by time.`,
          ],
    );
    return {
      timelines,
      timeline: chosen,
      premiere: synced.state,
      project: yield* describeProject(input.workspaceRoot, synced),
      changes: changesText(result),
      text: [editableView(timeline), ...warnings].join("\n"),
    };
  });

  const editTimeline: VideoProjects["Service"]["editTimeline"] = Effect.fn(
    "VideoProjects.editTimeline",
  )(function* (input) {
    const { result: before } = yield* syncForAgent(input.workspaceRoot);
    if (before.unmerged.includes(input.timeline)) {
      return yield* new VideoProjectError({
        reason: `${input.timeline} was edited here and in Premiere, and they can't be merged: ${NO_BASE} Nothing was changed. Ask the user to choose a version in Stellar.`,
      });
    }
    // The edits name clips and frames from the agent's last read, which this pull just outdated.
    if (before.updated.includes(input.timeline)) {
      return yield* new VideoProjectError({
        reason: `${input.timeline} just changed: the user saved in Premiere and it was pulled in. None of your edits were applied. Read the timeline again and redo them against what is there now.`,
      });
    }
    const timeline = yield* loadTimeline(input.workspaceRoot, input.timeline);
    const layout = layoutTimeline(timeline);
    const clipIds = new Set(layout.tracks.flatMap((track) => track.clips.map((clip) => clip.key)));
    const trackNames = new Set(layout.tracks.map((track) => track.name));
    const words = input.edits.some((edit) => edit.kind === "removeWords")
      ? yield* loadWords(input.workspaceRoot, timeline)
      : null;
    // Words are placed on the timeline as it was before the call, so a ripple word cut moves
    // the ones resolved after it by the frames it removed ahead of them.
    const rippled: Array<FrameRange> = [];
    const afterCuts = (frame: number) =>
      frame -
      rippled.reduce(
        (removed, cut) => removed + Math.max(0, Math.min(frame, cut.end) - cut.start),
        0,
      );
    const framesOfWords = (fromWord: number, toWord: number, ripple: boolean) => {
      const range = wordRange(
        words ?? { name: timeline.name, rate: layout.rate, count: 0, clips: [] },
        fromWord,
        toWord,
      );
      if (typeof range === "string") return range;
      const placed = { start: afterCuts(range.start), end: afterCuts(range.end) };
      if (ripple) rippled.push(range);
      return placed;
    };
    const edits: Array<TimelineEdit> = [];
    for (const [index, edit] of input.edits.entries()) {
      const parsed = toTimelineEdit(edit, framesOfWords);
      const problem =
        typeof parsed === "string"
          ? parsed
          : "clipId" in parsed && !clipIds.has(parsed.clipId) && !isSplitPiece(parsed.clipId)
            ? `no clip #${parsed.clipId}`
            : parsed.kind === "move" && !trackNames.has(parsed.toTrack)
              ? `no track ${parsed.toTrack}`
              : null;
      if (problem !== null || typeof parsed === "string") {
        return yield* new VideoProjectError({
          reason: `Edit ${index + 1} (${edit.kind}): ${problem}. Nothing was changed.`,
        });
      }
      edits.push(parsed);
    }
    const edited = applyEdits(timeline, edits);
    yield* syncing.withPermits(1)(
      fileSystem
        .writeFileString(path.join(input.workspaceRoot, input.timeline), serializeTimeline(edited))
        .pipe(
          Effect.mapError(
            (cause) =>
              new VideoProjectError({ reason: `Could not write ${input.timeline}.`, cause }),
          ),
        ),
    );
    const { result: after, view: synced } = yield* syncWithPremiere({
      workspaceRoot: input.workspaceRoot,
    });
    return {
      timelines: yield* listTimelines(input.workspaceRoot),
      timeline: input.timeline,
      premiere: synced.state,
      project: yield* describeProject(input.workspaceRoot, synced),
      // What the sync before the edit pulled or merged in, then what is pending with the edit.
      changes: changesText({ ...before, pending: after.pending }),
      text: editableView(edited),
    };
  });

  const saveVoiceOver: VideoProjects["Service"]["saveVoiceOver"] = Effect.fn(
    "VideoProjects.saveVoiceOver",
  )(function* (input) {
    yield* requireProject(input.workspaceRoot);
    if (input.recording.byteLength === 0) {
      return yield* new VideoProjectError({ reason: "The recording was empty." });
    }
    const mediaRoot = path.dirname(input.workspaceRoot);
    const folder = path.join("Audio", "VO");
    // Local time, so the name matches the clock the person recorded by.
    const stamp = yield* DateTime.nowAsDate;
    const two = (value: number) => String(value).padStart(2, "0");
    const name = `VO ${stamp.getFullYear()}-${two(stamp.getMonth() + 1)}-${two(stamp.getDate())} ${two(stamp.getHours())}.${two(stamp.getMinutes())}.${two(stamp.getSeconds())}`;
    const target = path.join(mediaRoot, folder, `${name}.wav`);
    const raw = path.join(mediaRoot, folder, `${name}.recording`);
    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(path.join(mediaRoot, folder), { recursive: true });
      yield* fileSystem.writeFile(raw, input.recording);
      yield* spawner.string(
        ChildProcess.make("ffmpeg", [
          "-v",
          "error",
          "-y",
          "-i",
          raw,
          "-vn",
          "-ar",
          "48000",
          "-c:a",
          "pcm_s24le",
          target,
        ]),
      );
    }).pipe(
      Effect.ensuring(fileSystem.remove(raw).pipe(Effect.ignore)),
      Effect.mapError(
        (cause) =>
          new VideoProjectError({
            reason: "Could not save the voice-over. Is ffmpeg installed on this machine?",
            cause,
          }),
      ),
    );
    yield* transcribeMissing(input.workspaceRoot);
    return { path: path.join(folder, `${name}.wav`), absolutePath: target };
  });

  const exportForPremiere: VideoProjects["Service"]["exportForPremiere"] = Effect.fn(
    "VideoProjects.exportForPremiere",
  )(function* (input) {
    yield* requireProject(input.workspaceRoot);
    const timelines = yield* listTimelines(input.workspaceRoot);
    const chosen =
      input.timeline ??
      timelines.find((candidate) => candidate !== FOOTAGE_TIMELINE_PATH) ??
      timelines[0];
    if (chosen === undefined) {
      return yield* new VideoProjectError({ reason: "This project has no timeline to export." });
    }
    const timeline = yield* loadTimeline(input.workspaceRoot, chosen);
    const index = yield* fileSystem
      .readFileString(path.join(input.workspaceRoot, PROXY_INDEX_PATH))
      .pipe(
        Effect.flatMap(decodeJson),
        Effect.map((value) => value as ProxyIndex),
        Effect.orElseSucceed(() => null),
      );
    // A new name each time, so an import never replaces a sequence the user has worked on.
    const stamp = yield* DateTime.nowAsDate;
    const two = (value: number) => String(value).padStart(2, "0");
    const sequenceName = `${timeline.name} (Stellar ${two(stamp.getHours())}.${two(stamp.getMinutes())})`;
    const exported = toFcpXml(timeline, {
      sequenceName,
      media: index?.media ?? {},
    });
    const folder = path.join(path.dirname(input.workspaceRoot), "Premiere");
    const file = path.join(folder, `${sequenceName.replace(/[/\\:]+/g, " ")}.xml`);
    yield* fileSystem.makeDirectory(folder, { recursive: true }).pipe(
      Effect.andThen(fileSystem.writeFileString(file, exported.xml)),
      Effect.mapError(
        (cause) => new VideoProjectError({ reason: `Could not write ${file}.`, cause }),
      ),
    );
    return {
      path: file,
      sequenceName,
      clips: exported.xml.split("<clipitem ").length - 1,
      // Speed changes travel as a plain cut, which the same list reports.
      skipped: [...exported.skipped, ...exported.approximated],
    };
  });

  const pushPlan: VideoProjects["Service"]["pushPlan"] = Effect.fn("VideoProjects.pushPlan")(
    function* (input) {
      // Not merged here: a merge rewrites the timeline, and the agent should read what it became.
      const { result, view: synced } = yield* syncWithPremiere({
        workspaceRoot: input.workspaceRoot,
      });
      const timelines = yield* listTimelines(input.workspaceRoot);
      const chosen =
        input.timeline ??
        timelines.find((candidate) => candidate !== FOOTAGE_TIMELINE_PATH) ??
        timelines[0];
      if (chosen === undefined) {
        return yield* new VideoProjectError({ reason: "This project has no timeline to push." });
      }
      const timeline = yield* loadTimeline(input.workspaceRoot, chosen);
      const state = {
        timeline: chosen,
        premiereRunning: synced.premiereRunning,
        linked: synced.state !== "unlinked",
        premiereIsNewer: synced.state === "conflict" && result.kept.includes(chosen),
      };
      const refuse = (refused: string): VideoPremierePushPlan => ({
        ...state,
        refused,
        steps: 0,
        manual: [],
        plan: "",
        instructions: refused,
      });
      if (synced.state === "unlinked") {
        return refuse(
          "No Premiere project is linked: save one into the project's Premiere folder and video_premiere_pull its sequence, or use video_premiere_export for a first cut.",
        );
      }
      if (synced.state === "offline") {
        return refuse("The linked Premiere project can't be read (drive unplugged or file moved).");
      }
      if (state.premiereIsNewer) {
        return refuse(
          "Pull first: Premiere saved a newer version of this sequence than the edits here started from. Call video_timeline_read, which merges it with the edits made here, then ask for the plan again.",
        );
      }
      const base = yield* fileSystem
        .readFileString(path.join(input.workspaceRoot, BASE_DIRECTORY, path.basename(chosen)))
        .pipe(
          Effect.flatMap(decodeJson),
          Effect.map((value) => value as Timeline),
          Effect.option,
        );
      if (Option.isNone(base)) {
        return refuse("No record of Premiere's version yet; sync once with Premiere open.");
      }
      const plan = yield* Effect.try({
        try: () => planPush(base.value, timeline),
        catch: (cause) =>
          new VideoProjectError({ reason: `Could not plan the push of ${chosen}.`, cause }),
      });
      const closed =
        synced.premiereRunning === false
          ? ["Premiere is NOT open: apply nothing. Tell the user to open the project in Premiere."]
          : [];
      const instructions =
        plan.steps.length === 0 && plan.manual.length === 0
          ? "Nothing to push: Premiere's last save already holds this timeline."
          : [
              ...closed,
              `Open the sequence "${timeline.name}" in Premiere and apply the steps in order with the Premiere tools, one clip per step (linked partners have steps of their own). Each step gives its position as it is when that step runs; clip ids change after every edit, so read the sequence again before each step and find the clip by track and start time. Tracks are numbered as Premiere shows them (V1 is video track 1; a tool that counts from 0 takes one less). Seconds are exact for the frames beside them.`,
              ...(Number.isInteger(plan.rate)
                ? []
                : [
                    `The sequence runs at ${plan.rate.toFixed(3)} fps: a tool that takes whole frame rates only will refuse a ripple-remove; razor both ends of the range and ripple-delete what is between them.`,
                  ]),
              ...(plan.manual.length === 0
                ? []
                : [
                    "The plan's by-hand list is not covered by the steps: do what a Premiere tool can do safely, and tell the user the rest.",
                  ]),
              "Then save the project in Premiere and call video_timeline_read: `premiere` is `current` once Premiere matches, and `changes` lists what still differs.",
            ].join("\n");
      return {
        ...state,
        refused: null,
        steps: plan.steps.length,
        manual: plan.manual,
        plan: plan.text,
        instructions,
      };
    },
  );

  return VideoProjects.of({
    exportForPremiere,
    pushPlan,
    saveVoiceOver,
    readTimeline,
    readWords,
    readScript,
    saveScript,
    transcribe,
    editTimeline,
    inspectPremiere,
    createFromPremiere,
    createFromIdea,
    scanIntake,
    importFootage,
    sync,
  });
});

export const layer = Layer.effect(VideoProjects, make);
