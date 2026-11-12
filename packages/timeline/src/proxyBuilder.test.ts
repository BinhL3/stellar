// @effect-diagnostics nodeBuiltinImport:off -- Recomputes the key an older build gave a file.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { describe, expect, it } from "@effect/vitest";

import { serializeJson, timeRange, TIMELINE_NAMESPACE } from "./otio.ts";
import { PROXY_INDEX_PATH, type ProxyIndex } from "./proxies.ts";
import { buildProjectProxies } from "./proxyBuilder.ts";

const handle = (output: string, exitCode = 0, errors = "") =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(new TextEncoder().encode(output)),
    stderr: Stream.make(new TextEncoder().encode(errors)),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const PROBE = JSON.stringify({
  streams: [
    {
      codec_type: "video",
      width: 1920,
      height: 1080,
      pix_fmt: "yuv420p",
      r_frame_rate: "30/1",
      avg_frame_rate: "30/1",
    },
  ],
  format: { duration: "4.000000" },
});

/**
 * Stands in for ffmpeg and ffprobe: every clip probes as four seconds of 1080p, and an encode
 * writes each output it was asked for. `installed` empties to act as a machine without them.
 */
const fakeTools = (ran: Array<string>, installed: ReadonlyArray<string> = ["ffmpeg", "ffprobe"]) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) return handle("");
          const { command: tool, args } = command;
          if (!installed.includes(tool)) {
            return yield* PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
            });
          }
          if (tool === "ffmpeg" && args.some((arg) => arg === "-encoders"))
            return handle(" V libwebp");
          if (tool === "ffprobe")
            return handle(args.some((arg) => arg === "-version") ? "ffprobe" : PROBE);
          ran.push(tool);
          for (const word of args) {
            const arg = String(word);
            if (/\/proxies\/[0-9a-f]{16}\./.test(arg))
              yield* Effect.orDie(fs.writeFileString(arg, "x"));
          }
          return handle("");
        }),
      );
    }),
  );

const clip = (target: string) => ({
  OTIO_SCHEMA: "Clip.2",
  name: target,
  source_range: timeRange(0, 30, 30),
  media_references: {
    DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", target_url: target, metadata: {} },
  },
  active_media_reference_key: "DEFAULT_MEDIA",
  enabled: true,
  metadata: {},
});

/** A media root with one project whose timeline uses `targets`, each a small file on disk. */
const makeProject = Effect.fn(function* (root: string, targets: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectDir = path.join(root, "Stellar");
  yield* fs.makeDirectory(path.join(projectDir, "timelines"), { recursive: true });
  for (const target of targets) {
    yield* fs.makeDirectory(path.dirname(path.join(root, target)), { recursive: true });
    yield* fs.writeFileString(path.join(root, target), `media ${target}`);
  }
  yield* fs.writeFileString(
    path.join(projectDir, "timelines", "cut.otio"),
    serializeJson({
      OTIO_SCHEMA: "Timeline.1",
      name: "Cut",
      tracks: {
        OTIO_SCHEMA: "Stack.1",
        children: [{ OTIO_SCHEMA: "Track.1", kind: "Video", children: targets.map(clip) }],
      },
      metadata: { [TIMELINE_NAMESPACE]: { mediaRoot: root } },
    }),
  );
  return projectDir;
});

const readIndex = Effect.fn(function* (projectDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return JSON.parse(
    yield* fs.readFileString(path.join(projectDir, PROXY_INDEX_PATH)),
  ) as ProxyIndex;
});

const layer = (ran: Array<string>, installed?: ReadonlyArray<string>) =>
  fakeTools(ran, installed).pipe(Layer.provideMerge(NodeServices.layer));

describe("buildProjectProxies", () => {
  it.effect(
    "keeps proxies when the media root moves, adopts ones keyed by absolute path, and clears orphans",
    () => {
      const ran: Array<string> = [];
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3-proxies-" });
        const root = path.join(base, "Drive");
        const projectDir = yield* makeProject(root, ["Footage/a.mp4", "Footage/b.mp4"]);
        yield* buildProjectProxies({ projectDir, concurrency: 1 });
        const built = yield* readIndex(projectDir);
        expect(ran).toEqual(["ffmpeg", "ffmpeg"]);
        expect(built.keys).toBe(2);

        // Rewrite the index as an older build left it: no marker, a.mp4 keyed by its absolute
        // path (checkable while the drive stays put), b.mp4 by a path that no longer exists.
        const legacy = (source: string) =>
          Effect.map(fs.stat(source), (stat) =>
            NodeCrypto.createHash("sha256")
              .update(`${source}|${stat.size}|${Option.getOrThrow(stat.mtime).getTime()}`)
              .digest("hex")
              .slice(0, 16),
          );
        const { keys: _keys, ...old } = built;
        const a = built.media["Footage/a.mp4"]!;
        const b = built.media["Footage/b.mp4"]!;
        yield* fs.writeFileString(
          path.join(projectDir, PROXY_INDEX_PATH),
          serializeJson({
            ...old,
            media: {
              "Footage/a.mp4": { ...a, key: yield* legacy(path.join(root, "Footage/a.mp4")) },
              "Footage/b.mp4": { ...b, key: "0000000000000000" },
            },
          }),
        );
        yield* fs.writeFileString(path.join(projectDir, "proxies", "ffffffffffffffff.mp4"), "x");
        yield* fs.writeFileString(path.join(projectDir, "proxies", "notes.txt"), "mine");
        const adopted = yield* buildProjectProxies({ projectDir, concurrency: 1 });
        // Nothing was encoded again, and both entries carry the new keys and the same files.
        expect(ran).toEqual(["ffmpeg", "ffmpeg"]);
        expect((yield* readIndex(projectDir)).media).toEqual(built.media);
        expect(adopted.removed).toBe(1);
        expect(yield* fs.exists(path.join(projectDir, "proxies", "notes.txt"))).toBe(true);
        expect(yield* fs.exists(path.join(projectDir, a.video!))).toBe(true);

        // The drive is mounted somewhere else: same keys, nothing rebuilt.
        const moved = path.join(base, "Elsewhere");
        yield* fs.rename(root, moved);
        const movedProject = path.join(moved, "Stellar");
        const timeline = path.join(movedProject, "timelines", "cut.otio");
        yield* fs.writeFileString(
          timeline,
          (yield* fs.readFileString(timeline)).replaceAll(root, moved),
        );
        yield* buildProjectProxies({ projectDir: movedProject, concurrency: 1 });
        expect(ran).toEqual(["ffmpeg", "ffmpeg"]);
        expect((yield* readIndex(movedProject)).media).toEqual(built.media);

        // The originals go offline: the previews stay. A changed file is made again.
        yield* fs.remove(path.join(moved, "Footage/a.mp4"));
        yield* fs.writeFileString(path.join(moved, "Footage/b.mp4"), "a longer, different take");
        const after = yield* buildProjectProxies({ projectDir: movedProject, concurrency: 1 });
        const index = yield* readIndex(movedProject);
        expect(ran).toEqual(["ffmpeg", "ffmpeg", "ffmpeg"]);
        expect(index.media["Footage/a.mp4"]).toEqual(a);
        expect(index.media["Footage/b.mp4"]?.key).not.toBe(b.key);
        expect(after).toMatchObject({ failed: 0, removed: 2 });
        expect(yield* fs.exists(path.join(movedProject, b.video!))).toBe(false);
      }).pipe(Effect.provide(layer(ran)));
    },
  );

  it.effect(
    "says which tools are missing instead of failing every file, and keeps what was built",
    () => {
      const ran: Array<string> = [];
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-proxies-" });
        const projectDir = yield* makeProject(root, ["Footage/a.mp4", "Graphics/raw.dng"]);
        const result = yield* buildProjectProxies({ projectDir, concurrency: 1 }).pipe(
          Effect.provide(fakeTools(ran, ["ffmpeg"])),
        );
        expect(result).toMatchObject({
          failed: 0,
          error: expect.stringContaining("ffprobe is not"),
        });
        const index = yield* readIndex(projectDir);
        expect(index.error).toContain("Install ffmpeg");
        expect(index.failed).toBeUndefined();

        // With the tools back, the video builds; the raw still names what it would take.
        yield* buildProjectProxies({ projectDir, concurrency: 1 });
        const built = yield* readIndex(projectDir);
        expect(built.error).toBeUndefined();
        expect(Object.keys(built.media)).toEqual(["Footage/a.mp4"]);
        expect(built.failures).toEqual({
          "Graphics/raw.dng": "Camera raw stills are only converted on macOS, with sips.",
        });
      }).pipe(Effect.provide(layer(ran)));
    },
  );
});
