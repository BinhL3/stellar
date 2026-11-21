import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { checkMediaFile, mediaFileProblem, VIDEO_TYPES } from "./mediaFile.ts";

describe("mediaFileProblem", () => {
  it.each([
    ["IMG_8139.MOV", 10, null],
    ["Audio/VO/take.wav", 10, null],
    ["Graphics/logo.PNG", 10, null],
    ["Footage/._IMG_8139.MOV", 4096, "._IMG_8139.MOV is a macOS resource file, not media."],
    ["notes.txt", 10, "notes.txt is a .txt file, which isn't media Stellar reads."],
    ["README", 10, "README has no file extension to tell what it is."],
    ["IMG_8140.MOV", 0, "IMG_8140.MOV is empty (0 bytes); copy it again."],
    ["IMG_8141.MOV", null, "IMG_8141.MOV can't be read: it is missing, a folder, or not readable."],
  ] as const)("%s", (file, size, expected) => {
    expect(mediaFileProblem(file, size)).toBe(expected);
  });

  it("narrows to the types a caller takes", () => {
    expect(mediaFileProblem("take.wav", 10, [VIDEO_TYPES])).toBe(
      "take.wav is a .wav file, which isn't media Stellar reads.",
    );
  });
});

describe("checkMediaFile", () => {
  it.effect("reads the file's size and whether it opens", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-file-" });
      yield* fs.writeFileString(path.join(dir, "a.mov"), "media");
      yield* fs.writeFileString(path.join(dir, "empty.mov"), "");
      yield* fs.writeFileString(path.join(dir, "locked.mov"), "media");
      yield* fs.chmod(path.join(dir, "locked.mov"), 0o000);
      expect(yield* checkMediaFile(path.join(dir, "a.mov"))).toBeNull();
      expect(yield* checkMediaFile(path.join(dir, "empty.mov"))).toContain("empty");
      expect(yield* checkMediaFile(path.join(dir, "locked.mov"))).toContain("can't be read");
      expect(yield* checkMediaFile(path.join(dir, "gone.mov"))).toContain("can't be read");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
