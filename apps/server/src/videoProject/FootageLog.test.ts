import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, TextGenerationError } from "@t3tools/contracts";
import type {
  FootageDescriptionInput,
  FootageDescriptionResult,
} from "@t3tools/provider-core/server/textGeneration";
import { imageFilesUnsupported } from "@t3tools/provider-core/server/textGenerationOperations";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as FootageLog from "./FootageLog.ts";

const handle = (stdout: Uint8Array) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(stdout),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

// Stands in for ffmpeg, which CI doesn't have: a "proxy" is JSON of its shots, each a number of
// seconds of one flat grey. Reading one streams those frames at the size asked for; drawing a
// contact sheet writes a placeholder. `reads` collects each proxy read.
const fakeFfmpeg = (reads: Array<string>) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command) || command.command !== "ffmpeg") {
            return yield* real.spawn(command);
          }
          const args = command.args.map(String);
          const input = args[args.indexOf("-i") + 1] ?? "";
          if (args.includes("-frames:v")) {
            yield* fs.writeFileString(args.at(-1) ?? "", "jpg").pipe(Effect.orDie);
            return handle(new Uint8Array());
          }
          reads.push(input);
          const shots = JSON.parse(yield* fs.readFileString(input).pipe(Effect.orDie)) as Array<
            readonly [seconds: number, grey: number]
          >;
          const [width = 0, height = 0] = (/scale=(\d+):(\d+)/.exec(args.join(" ")) ?? [])
            .slice(1)
            .map(Number);
          const frames = shots.flatMap(([seconds, grey]) =>
            Array.from({ length: seconds * 10 }, () =>
              new Uint8Array(width * height * 3).fill(grey),
            ),
          );
          const bytes = new Uint8Array(frames.length * width * height * 3);
          frames.forEach((frame, index) => bytes.set(frame, index * frame.length));
          return handle(bytes);
        }),
      );
    }),
  ).pipe(Layer.provide(NodeServices.layer));

type Describe = (
  input: FootageDescriptionInput,
) => Effect.Effect<FootageDescriptionResult, TextGenerationError>;

/** The model, as the test says it answers; `asked` collects each request with its folder's files. */
const fakeModel = (
  asked: Array<{ input: FootageDescriptionInput; files: Array<string> }>,
  answer: { current: Describe },
) =>
  Layer.effect(
    TextGeneration.TextGeneration,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return TextGeneration.TextGeneration.of({
        generateFootageDescription: (input) =>
          fs.readDirectory(input.cwd).pipe(
            Effect.orDie,
            Effect.tap((files) => Effect.sync(() => asked.push({ input, files }))),
            Effect.andThen(answer.current(input)),
          ),
      } as TextGeneration.TextGeneration["Service"]);
    }),
  ).pipe(Layer.provide(NodeServices.layer));

const described: Describe = () =>
  Effect.succeed({
    summary: "A train pulls into a station",
    segments: [
      {
        start: 0,
        end: 3,
        place: "station platform",
        subject: "train",
        action: "arrives",
        usable: true,
        why: "",
      },
    ],
  });

const testLayer = (
  reads: Array<string>,
  asked: Parameters<typeof fakeModel>[0],
  answer: { current: Describe },
) =>
  FootageLog.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        fakeFfmpeg(reads),
        fakeModel(asked, answer),
        Layer.mock(ProjectService.ProjectService)({
          getByWorkspaceRoot: () => Effect.succeedSome({ id: ProjectId.make("acme") } as never),
        }),
        ServerSettings.ServerSettingsService.layerTest(),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

/** A project with two clips in one folder, each with a proxy, and a transcript for the first. */
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-footage-log-" });
  const projectFolder = path.join(root, "Stellar");
  const folder = path.join(root, "Footage", "00 Raw iPhone (Oct 10)");
  yield* fs.makeDirectory(path.join(projectFolder, "proxies"), { recursive: true });
  yield* fs.makeDirectory(folder, { recursive: true });
  yield* fs.makeDirectory(path.join(root, "Audio"), { recursive: true });
  const media: Record<string, unknown> = {};
  for (const [name, shots] of [
    ["IMG_0001.MOV", [[3, 120]]],
    ["._IMG_0001.MOV", [[3, 0]]],
    [
      "IMG_0002.MOV",
      [
        [2, 40],
        [2, 200],
      ],
    ],
  ] as const) {
    yield* fs.writeFileString(path.join(folder, name), "");
    if (name.startsWith(".")) continue;
    const proxy = `proxies/${name}.mp4`;
    yield* fs.writeFileString(path.join(projectFolder, proxy), JSON.stringify(shots));
    media[`Footage/00 Raw iPhone (Oct 10)/${name}`] = {
      key: name,
      width: 1080,
      height: 1920,
      duration: shots.reduce((sum, [seconds]) => sum + seconds, 0),
      video: proxy,
    };
  }
  yield* fs.writeFileString(
    path.join(projectFolder, "proxies", "index.json"),
    JSON.stringify({ version: 1, media }),
  );
  yield* fs.writeFileString(
    path.join(root, "Audio", "IMG_0001.words.json"),
    JSON.stringify([
      { w: "next", start: 0.5, end: 0.8 },
      { w: "stop", start: 0.8, end: 1.1 },
    ]),
  );
  return { fs, path, projectFolder };
});

it.live("reads and describes each clip once, and again only when its preview changes", () => {
  const reads: Array<string> = [];
  const asked: Parameters<typeof fakeModel>[0] = [];
  return Effect.gen(function* () {
    const { fs, path, projectFolder } = yield* setup;
    const footageLog = yield* FootageLog.FootageLog;
    yield* footageLog.run(projectFolder);
    assert.deepStrictEqual(
      reads.map((file) => path.basename(file)),
      ["IMG_0001.MOV.mp4", "IMG_0002.MOV.mp4"],
    );
    assert.strictEqual(asked.length, 2);
    // The model's folder holds the contact sheet and nothing else.
    assert.deepStrictEqual(asked[0]?.files, ["contact-sheet.jpg"]);
    assert.deepStrictEqual(asked[0]?.input.imageFiles, [
      path.join(asked[0]!.input.cwd, "contact-sheet.jpg"),
    ]);
    assert.include(asked[0]?.input.prompt, `folder "00 Raw iPhone (Oct 10)"`);
    assert.include(asked[0]?.input.prompt, "0:00.5 next stop");
    assert.include(asked[1]?.input.prompt, "cuts at 0:02.0");

    yield* footageLog.run(projectFolder);
    assert.strictEqual(reads.length, 2);
    assert.strictEqual(asked.length, 2);

    yield* fs.writeFileString(
      path.join(projectFolder, "proxies", "IMG_0002.MOV.mp4"),
      JSON.stringify([[4, 90]]),
    );
    yield* footageLog.run(projectFolder);
    assert.deepStrictEqual(
      reads.slice(2).map((file) => path.basename(file)),
      ["IMG_0002.MOV.mp4"],
    );
    assert.strictEqual(asked.length, 3);

    const log = yield* footageLog.read({ workspaceRoot: projectFolder, clips: ["IMG_0001.MOV"] });
    assert.deepStrictEqual(log.pending, { picture: 0, description: 0 });
    assert.deepStrictEqual(
      log.clips.map((clip) => [clip.clip, clip.description?.summary]),
      [["Footage/00 Raw iPhone (Oct 10)/IMG_0001.MOV", "A train pulls into a station"]],
    );
  }).pipe(Effect.provide(testLayer(reads, asked, { current: described })), Effect.scoped);
});

it.live(
  "keeps the user's note, gives it to the model as true, and describes the clip again",
  () => {
    const reads: Array<string> = [];
    const asked: Parameters<typeof fakeModel>[0] = [];
    return Effect.gen(function* () {
      const { fs, path, projectFolder } = yield* setup;
      const footageLog = yield* FootageLog.FootageLog;
      yield* footageLog.run(projectFolder);
      const saved = yield* footageLog.setNote({
        workspaceRoot: projectFolder,
        clip: "img_0001.mov",
        note: " Philadelphia   station, b-roll ",
      });
      assert.strictEqual(saved.note, "Philadelphia station, b-roll");
      assert.isFalse(saved.description?.current);
      const notes = path.join(projectFolder, FootageLog.FOOTAGE_LOG_FOLDER, "notes.json");
      const before = yield* fs.readFileString(notes);

      yield* footageLog.run(projectFolder);
      assert.strictEqual(asked.length, 3);
      assert.include(
        asked[2]?.input.prompt,
        `"Philadelphia station, b-roll". Use it, never contradict it`,
      );
      assert.strictEqual(yield* fs.readFileString(notes), before);
      const log = yield* footageLog.read({ workspaceRoot: projectFolder, clips: ["IMG_0001.MOV"] });
      assert.include(
        log.text,
        "note (user's, wins): Philadelphia station, b-roll\nseen: A train pulls into a station",
      );

      const cleared = yield* footageLog.setNote({
        workspaceRoot: projectFolder,
        clip: "IMG_0001.MOV",
        note: "",
      });
      assert.isNull(cleared.note);
      const missing = yield* footageLog
        .setNote({ workspaceRoot: projectFolder, clip: "IMG_9999.MOV", note: "x" })
        .pipe(Effect.flip);
      assert.strictEqual(missing.reason, "No footage clip is named IMG_9999.MOV.");
    }).pipe(Effect.provide(testLayer(reads, asked, { current: described })), Effect.scoped);
  },
);

it.live(
  "waits for transcripts, retries a passing failure, and never re-asks a model that can't see",
  () => {
    const reads: Array<string> = [];
    const asked: Parameters<typeof fakeModel>[0] = [];
    const answer = { current: described };
    return Effect.gen(function* () {
      const { fs, path, projectFolder } = yield* setup;
      const footageLog = yield* FootageLog.FootageLog;
      const status = (building: boolean) =>
        fs.writeFileString(
          path.join(projectFolder, "transcripts.json"),
          JSON.stringify({
            building: building ? { done: 0, total: 1 } : null,
            ready: 1,
            total: 2,
            failed: [],
            unavailable: null,
          }),
        );
      yield* status(true);
      yield* footageLog.run(projectFolder);
      // Only the clip that already has its words is described while the rest are transcribed.
      assert.deepStrictEqual(
        asked.map(({ input }) => input.prompt.includes("IMG_0001.MOV")),
        [true],
      );

      yield* status(false);
      answer.current = () =>
        Effect.fail(
          new TextGenerationError({
            operation: "generateFootageDescription",
            detail: "Claude CLI request timed out.",
          }),
        );
      for (let run = 0; run < 4; run++) yield* footageLog.run(projectFolder);
      assert.strictEqual(asked.length, 1 + 3);
      const waiting = yield* footageLog.read({
        workspaceRoot: projectFolder,
        clips: ["IMG_0002.MOV"],
      });
      assert.strictEqual(waiting.clips[0]?.describeFailed, "Claude CLI request timed out.");
      assert.isNull(waiting.unavailable);

      yield* footageLog.setNote({
        workspaceRoot: projectFolder,
        clip: "IMG_0002.MOV",
        note: "Lobby",
      });
      answer.current = () =>
        Effect.fail(imageFilesUnsupported("generateFootageDescription", "CursorTextGeneration"));
      yield* footageLog.run(projectFolder);
      yield* footageLog.run(projectFolder);
      assert.strictEqual(asked.length, 5);
      const log = yield* footageLog.read({ workspaceRoot: projectFolder });
      assert.include(log.unavailable, "can't be handed images");
      assert.deepStrictEqual(log.pending, { picture: 0, description: 0 });
    }).pipe(Effect.provide(testLayer(reads, asked, answer)), Effect.scoped);
  },
);
