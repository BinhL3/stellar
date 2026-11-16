/**
 * The footage log: a picture pass over each clip's proxy and a contact sheet, then a model's
 * description from the sheet, transcript, folder and the user's note. Kept in `footage-log/`,
 * keyed so only a changed proxy, note or model is done again.
 */
import {
  type ModelSelection,
  TextGenerationError,
  VideoTranscriptStatus,
  type VideoFootageClip,
  type VideoFootageLog,
  type VideoFootageLogInput,
  type VideoFootageNoteInput,
} from "@t3tools/contracts";
import { isImageFilesUnsupported } from "@t3tools/provider-core/server/textGenerationOperations";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { conformedPath } from "@t3tools/timeline/conform";
import { listFootage } from "@t3tools/timeline/footage";
import {
  type FootageLogClip,
  footageClipText,
  footageDescriptionPrompt,
  normalizeDescription,
} from "@t3tools/timeline/footageLog";
import {
  analysePicture,
  analysisSize,
  CAMERA_MOVES,
  PICTURE_ISSUES,
  contactSheetTimes,
  footageSheetFilter,
  makePictureMeter,
  PICTURE_SAMPLE_RATE,
  PICTURE_VERSION,
} from "@t3tools/timeline/picture";
import { PROXY_INDEX_PATH, type ProxyEntry, type ProxyIndex } from "@t3tools/timeline/proxies";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
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
import * as Stream from "effect/Stream";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { decodeTranscript, findTranscript } from "./Transcriber.ts";

export class FootageLogError extends Schema.TaggedError<FootageLogError>()("FootageLogError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

/** Inside the project folder; mirrors the Footage folder, one set of files per clip. */
export const FOOTAGE_LOG_FOLDER = "footage-log";
const NOTES_FILE = `${FOOTAGE_LOG_FOLDER}/notes.json`;
const TRANSCRIPT_STATUS_FILE = "transcripts.json";
const SHEET_FILE = "contact-sheet.jpg";
// A description that failed for a passing reason is tried this many times per clip, note and model.
const DESCRIBE_ATTEMPTS = 3;

const Cut = Schema.Struct({ at: Schema.Number, kind: Schema.Literals(["cut", "jump"]) });
const Segment = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
  camera: Schema.Literals(CAMERA_MOVES),
  issues: Schema.Array(Schema.Literals(PICTURE_ISSUES)),
});
const PictureFile = Schema.Struct({
  version: Schema.Number,
  /** The proxy it was read from, relative to the project folder, and that file's size and time. */
  proxy: Schema.String,
  size: Schema.Number,
  modifiedAt: Schema.Number,
  duration: Schema.Number,
  cuts: Schema.Array(Cut),
  segments: Schema.Array(Segment),
  /** The contact sheet beside it, relative to the project folder; null when none was drawn. */
  sheet: Schema.NullOr(Schema.String),
});
type PictureFile = typeof PictureFile.Type;
const PictureJson = Schema.fromJsonString(PictureFile);
const decodePicture = Schema.decodeUnknownEffect(PictureJson);
const encodePicture = Schema.encodeEffect(PictureJson);

const DescribedSegment = Schema.Struct({
  start: Schema.Number,
  end: Schema.Number,
  place: Schema.String,
  subject: Schema.String,
  action: Schema.String,
  usable: Schema.Boolean,
  why: Schema.String,
});
const DescriptionFile = Schema.Struct({
  /** What it was made from: the picture read, the note, and the model (see `describeKey`). */
  key: Schema.String,
  model: Schema.String,
  /** The note the model was given. */
  note: Schema.NullOr(Schema.String),
  describedAt: Schema.Number,
  result: Schema.NullOr(
    Schema.Struct({ summary: Schema.String, segments: Schema.Array(DescribedSegment) }),
  ),
  failed: Schema.NullOr(Schema.String),
  attempts: Schema.Number,
  /** False when no retry can help, such as a model that can't be shown images. */
  retry: Schema.Boolean,
});
type DescriptionFile = typeof DescriptionFile.Type;
const DescriptionJson = Schema.fromJsonString(DescriptionFile);
const decodeDescription = Schema.decodeUnknownEffect(DescriptionJson);
const encodeDescription = Schema.encodeEffect(DescriptionJson);

const NotesFile = Schema.Struct({
  notes: Schema.Record(
    Schema.String,
    Schema.Struct({ text: Schema.String, updatedAt: Schema.Number }),
  ),
});
type NotesFile = typeof NotesFile.Type;
const NotesJson = Schema.fromJsonString(NotesFile);
const decodeNotes = Schema.decodeUnknownEffect(NotesJson);
const encodeNotes = Schema.encodeEffect(NotesJson);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isTextGenerationError = Schema.is(TextGenerationError);
const decodeTranscriptStatus = Schema.decodeUnknownEffect(
  Schema.fromJsonString(VideoTranscriptStatus),
);

const modelLabel = (selection: ModelSelection) => `${selection.instanceId}/${selection.model}`;

/** A description stands while the picture it saw, the note and the model are the same. */
const describeKey = (
  picture: Pick<PictureFile, "proxy" | "size" | "modifiedAt">,
  note: string | null,
  model: string,
) => JSON.stringify([picture.proxy, picture.size, picture.modifiedAt, note ?? "", model]);

/** Whether a clip with this record still needs a call to the model. */
const needsDescription = (record: DescriptionFile | null, key: string) =>
  record === null ||
  record.key !== key ||
  (record.result === null && record.retry && record.attempts < DESCRIBE_ATTEMPTS);

/** Whether a kept picture reading still describes the proxy as it is now. */
const pictureCurrent = (
  cached: PictureFile | null,
  proxy: string,
  stat: { readonly size: number; readonly modifiedAt: number } | null,
) =>
  cached !== null &&
  cached.version === PICTURE_VERSION &&
  cached.proxy === proxy &&
  // A drive that is away can't be checked against; what was read still stands.
  (stat === null || (cached.size === stat.size && cached.modifiedAt === stat.modifiedAt));

/** The footage clips to log: a conformed copy stands in only when its original is gone. */
const loggedClips = (footage: ReadonlyArray<string>) => {
  const copies = new Set(footage.map(conformedPath));
  return footage.filter((target) => !copies.has(target));
};

export class FootageLog extends Context.Service<
  FootageLog,
  {
    /**
     * Reads the picture of every clip that needs it, then describes what isn't described, in
     * the background, one run per project. A request mid-run runs again when it ends.
     */
    readonly start: (projectFolder: string) => Effect.Effect<void>;
    /** One run itself, for a caller that waits on it. */
    readonly run: (projectFolder: string) => Effect.Effect<void>;
    /** The log, and starts a run when anything in it is missing. */
    readonly read: (input: VideoFootageLogInput) => Effect.Effect<VideoFootageLog, FootageLogError>;
    /**
     * Saves the user's note on a clip (empty removes it). Nothing else writes notes; the clip
     * is described again so the description fits the note.
     */
    readonly setNote: (
      input: VideoFootageNoteInput,
    ) => Effect.Effect<VideoFootageClip, FootageLogError>;
  }
>()("t3/videoProject/FootageLog") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const projects = yield* ProjectService.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const background = yield* FiberSet.make();
  // Clips are read and described one at a time across projects: decoding and model calls
  // are the expensive part, and the user's machine and subscription are shared.
  const reading = yield* Semaphore.make(1);
  const describing = yield* Semaphore.make(1);
  const savingNotes = yield* Semaphore.make(1);
  const running = new Set<string>();
  const queued = new Set<string>();

  const clipFiles = (projectFolder: string, clip: string) => {
    const base = path.join(
      projectFolder,
      FOOTAGE_LOG_FOLDER,
      ...clip.replace(/^Footage\//, "").split("/"),
    );
    return {
      picture: `${base}.picture.json`,
      sheet: `${base}.jpg`,
      description: `${base}.description.json`,
    };
  };

  const readIndex = (projectFolder: string) =>
    fileSystem.readFileString(path.join(projectFolder, PROXY_INDEX_PATH)).pipe(
      Effect.flatMap(decodeJson),
      Effect.map((value) => value as ProxyIndex),
      Effect.orElseSucceed(() => null),
    );

  const proxyOf = (index: ProxyIndex | null, clip: string): ProxyEntry | null =>
    index?.media[clip] ?? index?.media[conformedPath(clip)] ?? null;

  const readJson = <A>(file: string, decode: (text: string) => Effect.Effect<A, unknown>) =>
    fileSystem.readFileString(file).pipe(
      Effect.flatMap(decode),
      Effect.orElseSucceed(() => null),
    );

  const writeAtomic = (file: string, text: string) =>
    fileSystem
      .makeDirectory(path.dirname(file), { recursive: true })
      .pipe(
        Effect.andThen(fileSystem.writeFileString(`${file}.part`, text)),
        Effect.andThen(fileSystem.rename(`${file}.part`, file)),
      );

  const readNotes = (projectFolder: string) =>
    readJson(path.join(projectFolder, NOTES_FILE), decodeNotes).pipe(
      Effect.map((file): NotesFile => file ?? { notes: {} }),
    );

  const statFile = (file: string) =>
    fileSystem.stat(file).pipe(
      Effect.map((info) => ({
        size: Number(info.size),
        modifiedAt: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
      })),
      Effect.orElseSucceed(() => null),
    );

  /** The clip's proxy read at the sample rate as raw frames, measured as they stream past. */
  const measure = Effect.fn("FootageLog.measure")(function* (proxyFile: string, entry: ProxyEntry) {
    const size = analysisSize(entry.width, entry.height);
    const meter = makePictureMeter(size);
    const child = yield* spawner.spawn(
      ChildProcess.make("ffmpeg", [
        "-v",
        "error",
        "-nostdin",
        "-i",
        proxyFile,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        `fps=${PICTURE_SAMPLE_RATE},scale=${size.width}:${size.height}:flags=area,format=rgb24`,
        "-f",
        "rawvideo",
        "-",
      ]),
    );
    const [, errors, exitCode] = yield* Effect.all(
      [
        // Untraced work per chunk: a span per chunk would be thousands per clip.
        Stream.runForEach(child.stdout, (chunk) => Effect.sync(() => meter.push(chunk))),
        child.stderr.pipe(Stream.decodeText(), Stream.mkString),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (Number(exitCode) !== 0) {
      return yield* new FootageLogError({
        reason: `ffmpeg could not read the picture: ${errors.trim().split("\n").at(-1) ?? `exit ${exitCode}`}`,
      });
    }
    return analysePicture(meter.finish(), entry.duration);
  }, Effect.scoped);

  const drawSheet = Effect.fn("FootageLog.drawSheet")(function* (
    proxyFile: string,
    output: string,
    times: ReadonlyArray<number>,
    entry: ProxyEntry,
  ) {
    const part = `${output}.part.jpg`;
    const render = (labels: boolean) =>
      spawner.string(
        ChildProcess.make("ffmpeg", [
          "-v",
          "error",
          "-nostdin",
          "-y",
          "-i",
          proxyFile,
          "-map",
          "0:v:0",
          "-an",
          "-vf",
          footageSheetFilter(times, { width: entry.width, height: entry.height }, labels),
          "-frames:v",
          "1",
          "-update",
          "1",
          "-q:v",
          "4",
          part,
        ]),
      );
    yield* fileSystem.makeDirectory(path.dirname(output), { recursive: true });
    // An ffmpeg built without drawtext still draws the sheet, without times on it.
    yield* render(true).pipe(Effect.catch(() => render(false)));
    yield* fileSystem.rename(part, output);
  });

  /** The clip's picture reading, made now unless a current one is kept. */
  const ensurePicture = Effect.fn("FootageLog.ensurePicture")(function* (
    projectFolder: string,
    clip: string,
    entry: ProxyEntry,
  ) {
    if (entry.video === undefined) return null;
    const files = clipFiles(projectFolder, clip);
    const proxyFile = path.join(projectFolder, entry.video);
    const stat = yield* statFile(proxyFile);
    const cached = yield* readJson(files.picture, decodePicture);
    if (pictureCurrent(cached, entry.video, stat)) return cached;
    if (stat === null) return null;
    const analysis = yield* measure(proxyFile, entry);
    const times = contactSheetTimes(analysis);
    const drawn = yield* drawSheet(proxyFile, files.sheet, times, entry).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logWarning("Footage contact sheet failed", { clip, cause }).pipe(Effect.as(false)),
      ),
    );
    const picture: PictureFile = {
      version: PICTURE_VERSION,
      proxy: entry.video,
      size: stat.size,
      modifiedAt: stat.modifiedAt,
      duration: analysis.duration,
      cuts: analysis.cuts,
      segments: analysis.segments,
      sheet: drawn ? path.relative(projectFolder, files.sheet) : null,
    };
    yield* encodePicture(picture).pipe(Effect.flatMap((text) => writeAtomic(files.picture, text)));
    return picture;
  });

  const readWords = Effect.fn("FootageLog.readWords")(function* (mediaRoot: string, clip: string) {
    const file = yield* findTranscript(mediaRoot, clip).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    if (file === null) return null;
    return yield* fileSystem.readFileString(file).pipe(
      Effect.flatMap(decodeTranscript),
      Effect.orElseSucceed(() => null),
    );
  });

  const modelFor = Effect.fn("FootageLog.modelFor")(function* (projectFolder: string) {
    const current = yield* settings.getSettings;
    const project = yield* projects.getByWorkspaceRoot(projectFolder);
    return resolveProjectSettings(current, Option.isSome(project) ? project.value.id : null)
      .settings.textGenerationModelSelection;
  });

  const describeClip = Effect.fn("FootageLog.describeClip")(function* (input: {
    readonly projectFolder: string;
    readonly clip: string;
    readonly picture: PictureFile;
    readonly note: string | null;
    readonly selection: ModelSelection;
    readonly transcriptsPending: boolean;
  }) {
    const { projectFolder, clip, picture, note, selection } = input;
    const files = clipFiles(projectFolder, clip);
    const model = modelLabel(selection);
    const key = describeKey(picture, note, model);
    const record = yield* readJson(files.description, decodeDescription);
    if (!needsDescription(record, key)) return;
    const mediaRoot = path.dirname(projectFolder);
    const words = yield* readWords(mediaRoot, clip);
    // Its transcript is on its way; the run after transcription describes it with the words.
    if (words === null && input.transcriptsPending) return;
    const attempts = record?.key === key ? record.attempts + 1 : 1;
    const write = (fields: Pick<DescriptionFile, "result" | "failed" | "retry">) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((describedAt) =>
          encodeDescription({ key, model, note, describedAt, attempts, ...fields }),
        ),
        Effect.flatMap((text) => writeAtomic(files.description, text)),
      );
    const outcome = yield* Effect.gen(function* () {
      if (picture.sheet === null) {
        return yield* new TextGenerationError({
          operation: "generateFootageDescription",
          detail: "no contact sheet could be drawn",
        });
      }
      // The model's working directory holds the sheet and nothing else.
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "stellar-footage-" });
      const sheet = path.join(cwd, SHEET_FILE);
      yield* fileSystem.copyFile(path.join(projectFolder, picture.sheet), sheet);
      const segments = clip.split("/");
      const described = yield* textGeneration.generateFootageDescription({
        cwd,
        imageFiles: [sheet],
        modelSelection: selection,
        prompt: footageDescriptionPrompt({
          fileName: segments.at(-1) ?? clip,
          folder: segments.slice(1, -1).join("/"),
          duration: picture.duration,
          note,
          sheetFile: SHEET_FILE,
          picture,
          words,
        }),
      });
      return normalizeDescription(described, picture.duration);
    }).pipe(
      Effect.scoped,
      Effect.map((result) => ({ result, failed: null, retry: false })),
      Effect.catch((error) =>
        Effect.succeed(
          isTextGenerationError(error)
            ? { result: null, failed: error.detail, retry: !isImageFilesUnsupported(error) }
            : { result: null, failed: "the contact sheet could not be handed over", retry: true },
        ),
      ),
    );
    if (outcome.failed !== null) {
      yield* Effect.logWarning("Footage description failed", { clip, reason: outcome.failed });
    }
    yield* write(outcome);
  });

  const footageOf = (projectFolder: string) =>
    listFootage(path.dirname(projectFolder)).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.map(loggedClips),
    );

  const transcriptsPending = (projectFolder: string) =>
    readJson(path.join(projectFolder, TRANSCRIPT_STATUS_FILE), decodeTranscriptStatus).pipe(
      Effect.map((status) => status?.building != null),
    );

  const runPass = Effect.fn("FootageLog.runPass")(function* (projectFolder: string) {
    const index = yield* readIndex(projectFolder);
    const clips = yield* footageOf(projectFolder);
    const pictures = new Map<string, PictureFile>();
    for (const clip of clips) {
      const entry = proxyOf(index, clip);
      if (entry === null) continue;
      const picture = yield* reading
        .withPermits(1)(ensurePicture(projectFolder, clip, entry))
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Footage picture pass failed", { clip, cause }).pipe(Effect.as(null)),
          ),
        );
      if (picture !== null) pictures.set(clip, picture);
    }
    const selection = yield* modelFor(projectFolder);
    const notes = (yield* readNotes(projectFolder)).notes;
    const pending = yield* transcriptsPending(projectFolder);
    for (const [clip, picture] of pictures) {
      yield* describing
        .withPermits(1)(
          describeClip({
            projectFolder,
            clip,
            picture,
            note: notes[clip]?.text ?? null,
            selection,
            transcriptsPending: pending,
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Footage description could not be kept", { clip, cause }),
          ),
        );
    }
  });

  const run: FootageLog["Service"]["run"] = (projectFolder) =>
    runPass(projectFolder).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Footage log pass failed", { projectFolder, cause }),
      ),
    );

  const start: FootageLog["Service"]["start"] = (projectFolder) =>
    Effect.suspend(() => {
      if (running.has(projectFolder)) {
        queued.add(projectFolder);
        return Effect.void;
      }
      running.add(projectFolder);
      return FiberSet.run(
        background,
        run(projectFolder).pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              running.delete(projectFolder);
              return queued.delete(projectFolder) ? start(projectFolder) : Effect.void;
            }),
          ),
        ),
      ).pipe(Effect.asVoid);
    });

  const requireProject = Effect.fn("FootageLog.requireProject")(function* (workspaceRoot: string) {
    const known = yield* projects
      .getByWorkspaceRoot(workspaceRoot)
      .pipe(
        Effect.mapError(
          (cause) => new FootageLogError({ reason: "Could not look up projects.", cause }),
        ),
      );
    if (Option.isNone(known)) {
      return yield* new FootageLogError({ reason: "That folder isn't a project here." });
    }
  });

  /** One clip as it stands, with whether it still waits on the picture pass or the model. */
  const clipState = Effect.fn("FootageLog.clipState")(function* (input: {
    readonly projectFolder: string;
    readonly clip: string;
    readonly entry: ProxyEntry | null;
    readonly note: string | null;
    readonly model: string;
    readonly withWords: boolean;
  }) {
    const { projectFolder, clip, entry, note, model } = input;
    const files = clipFiles(projectFolder, clip);
    const stored = yield* readJson(files.picture, decodePicture);
    const picture =
      entry?.video !== undefined && pictureCurrent(stored, entry.video, null) ? stored : null;
    const record = yield* readJson(files.description, decodeDescription);
    const key = picture === null ? null : describeKey(picture, note, model);
    const words = input.withWords ? yield* readWords(path.dirname(projectFolder), clip) : null;
    const sheet = picture?.sheet == null ? null : path.join(projectFolder, picture.sheet);
    const logClip: FootageLogClip = {
      clip,
      folder: clip.split("/").slice(1, -1).join("/"),
      duration: picture?.duration ?? entry?.duration ?? 0,
      note,
      picture,
      contactSheet: sheet,
      description:
        record?.result == null ? null : { ...record.result, current: record.note === note },
      describeFailed: record?.result === null && record.key === key ? record.failed : null,
      words,
    };
    return {
      logClip,
      model: record?.model ?? model,
      waiting: {
        picture: entry?.video !== undefined && picture === null,
        description: key !== null && needsDescription(record, key),
      },
      unavailable:
        record !== null && record.key === key && record.result === null && !record.retry
          ? record.failed
          : null,
    };
  });

  const toContract = (clip: FootageLogClip, model: string): VideoFootageClip => ({
    clip: clip.clip,
    folder: clip.folder,
    duration: clip.duration,
    note: clip.note,
    picture:
      clip.picture === null
        ? null
        : {
            cuts: clip.picture.cuts,
            segments: clip.picture.segments,
            contactSheet: clip.contactSheet,
          },
    description:
      clip.description === null
        ? null
        : {
            summary: clip.description.summary,
            segments: clip.description.segments,
            model,
            current: clip.description.current,
          },
    describeFailed: clip.describeFailed,
  });

  /** A clip named by path, file name or folder; every clip when `names` is empty. */
  const matching = (clips: ReadonlyArray<string>, names: ReadonlyArray<string>) => {
    if (names.length === 0) return clips;
    const wanted = names.map((name) => name.toLowerCase().replace(/^\/+|\/+$/g, ""));
    return clips.filter((clip) => {
      const lower = clip.toLowerCase();
      return wanted.some(
        (name) =>
          lower === name ||
          lower.endsWith(`/${name}`) ||
          lower
            .split("/")
            .slice(0, -1)
            .some((folder) => folder === name),
      );
    });
  };

  const read: FootageLog["Service"]["read"] = Effect.fn("FootageLog.read")(function* (input) {
    yield* requireProject(input.workspaceRoot);
    const projectFolder = input.workspaceRoot;
    const index = yield* readIndex(projectFolder);
    const all = yield* footageOf(projectFolder);
    const named = input.clips ?? [];
    const shown = matching(all, named);
    const notes = (yield* readNotes(projectFolder)).notes;
    const model = modelLabel(
      yield* modelFor(projectFolder).pipe(
        Effect.mapError(
          (cause) => new FootageLogError({ reason: "Could not read the settings.", cause }),
        ),
      ),
    );
    const pending = { picture: 0, description: 0 };
    let unavailable: string | null = null;
    const clips: Array<VideoFootageClip> = [];
    const blocks: Array<string> = [];
    for (const clip of all) {
      const state = yield* clipState({
        projectFolder,
        clip,
        entry: proxyOf(index, clip),
        note: notes[clip]?.text ?? null,
        model,
        withWords: shown.includes(clip),
      });
      if (state.waiting.picture) pending.picture++;
      if (state.waiting.description) pending.description++;
      unavailable ??= state.unavailable;
      if (!shown.includes(clip)) continue;
      clips.push(toContract(state.logClip, state.model));
      blocks.push(footageClipText(state.logClip, named.length > 0));
    }
    if (pending.picture + pending.description > 0) yield* start(projectFolder);
    const building = index?.building !== undefined;
    const header = [
      `# Footage log · ${all.length} clips${named.length > 0 ? ` · showing ${shown.length}` : ""}`,
      ...(building ? ["Previews are still being built; clips without one aren't read yet."] : []),
      ...(pending.picture + pending.description > 0
        ? [
            `Working in the background: ${pending.picture} clips to read, ${pending.description} to describe. Read again later for the rest.`,
          ]
        : []),
      ...(unavailable === null ? [] : [`Clips can't be described: ${unavailable}`]),
    ];
    return {
      clips,
      pending,
      unavailable,
      text: [
        header.join("\n"),
        ...(named.length > 0 && shown.length === 0
          ? [`No clip matches ${named.join(", ")}.`]
          : blocks),
      ].join("\n\n"),
    };
  });

  const setNote: FootageLog["Service"]["setNote"] = Effect.fn("FootageLog.setNote")(
    function* (input) {
      yield* requireProject(input.workspaceRoot);
      const projectFolder = input.workspaceRoot;
      const all = yield* footageOf(projectFolder);
      const found = matching(all, [input.clip]).filter(
        (clip) => !all.includes(input.clip) || clip === input.clip,
      );
      if (found.length !== 1) {
        return yield* new FootageLogError({
          reason:
            found.length === 0
              ? `No footage clip is named ${input.clip}.`
              : `${input.clip} names ${found.length} clips; give its path: ${found.join(", ")}.`,
        });
      }
      const clip = found[0]!;
      const text = input.note.replace(/\s+/g, " ").trim();
      const now = yield* Clock.currentTimeMillis;
      yield* savingNotes
        .withPermits(1)(
          Effect.gen(function* () {
            const file = yield* readNotes(projectFolder);
            const { [clip]: _previous, ...others } = file.notes;
            const next: NotesFile = {
              notes: text === "" ? others : { ...others, [clip]: { text, updatedAt: now } },
            };
            yield* encodeNotes(next).pipe(
              Effect.flatMap((json) => writeAtomic(path.join(projectFolder, NOTES_FILE), json)),
            );
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) => new FootageLogError({ reason: "Could not save the note.", cause }),
          ),
        );
      yield* start(projectFolder);
      const index = yield* readIndex(projectFolder);
      const state = yield* clipState({
        projectFolder,
        clip,
        entry: proxyOf(index, clip),
        note: text === "" ? null : text,
        model: modelLabel(
          yield* modelFor(projectFolder).pipe(
            Effect.mapError(
              (cause) => new FootageLogError({ reason: "Could not read the settings.", cause }),
            ),
          ),
        ),
        withWords: false,
      });
      return toContract(state.logClip, state.model);
    },
  );

  return FootageLog.of({ start, run, read, setNote });
});

export const layer = Layer.effect(FootageLog, make);
