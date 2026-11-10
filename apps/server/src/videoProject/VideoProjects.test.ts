import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";
import * as NodeZlib from "node:zlib";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { copyFootage, footageStringout, listFootage } from "@t3tools/timeline/footage";
import { serializeTimeline } from "@t3tools/timeline/otio";

import * as ProjectService from "../project/ProjectService.ts";
import * as VideoProjects from "./VideoProjects.ts";

// Tests close their scope after the service's layer, so background proxy builds have stopped
// before the temporary folder they write into is removed.

// The smallest project Premiere's reader accepts: one sequence with an empty video track group.
const prprojWithFrame = (frame: string) =>
  NodeZlib.gzipSync(`<?xml version="1.0" encoding="UTF-8" ?>
<PremiereData Version="3">
<VideoTrackGroup ObjectID="1"><TrackGroup><FrameRate>4237833600</FrameRate></TrackGroup><FrameRect>0,0,${frame}</FrameRect></VideoTrackGroup>
<Sequence ObjectUID="seq-1"><TrackGroups><TrackGroup Index="0"><First>v</First><Second ObjectRef="1"/></TrackGroup></TrackGroups><Name>Polish v1</Name></Sequence>
</PremiereData>`);
const prproj = prprojWithFrame("1080,1920");

const withProjects = (created: Array<string>) =>
  Layer.mock(ProjectService.ProjectService)({
    getByWorkspaceRoot: (root) =>
      Effect.succeed(
        created.includes(root)
          ? Option.some({ id: ProjectId.make("existing") } as never)
          : Option.none(),
      ),
    create: (input) => {
      created.push(input.workspaceRoot);
      return Effect.succeed({ id: input.projectId } as never);
    },
  });

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-video-project-" });
  const premiereFolder = path.join(root, "SFUniqlo", "Premiere");
  yield* fs.makeDirectory(premiereFolder, { recursive: true });
  const premiereProjectPath = path.join(premiereFolder, "SFUniqlo.prproj");
  yield* fs.writeFile(premiereProjectPath, prproj);
  return { fs, path, root, premiereProjectPath };
});

it.live("lists sequences and places the project beside the Premiere folder's parent", () =>
  Effect.gen(function* () {
    const { path, root, premiereProjectPath } = yield* setup;
    const videoProjects = yield* VideoProjects.VideoProjects;
    const inspected = yield* videoProjects.inspectPremiere({ premiereProjectPath });
    assert.deepStrictEqual(inspected, {
      title: "SFUniqlo",
      sequences: [{ id: "seq-1", name: "Polish v1" }],
      projectFolder: path.join(root, "SFUniqlo", "Stellar"),
    });
  }).pipe(
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provideMerge(withProjects([])),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    Effect.scoped,
  ),
);

it.live("pulls the sequence into the project folder and reuses the project next time", () => {
  const created: Array<string> = [];
  return Effect.gen(function* () {
    const { fs, path, root, premiereProjectPath } = yield* setup;
    const videoProjects = yield* VideoProjects.VideoProjects;
    const first = yield* videoProjects.createFromPremiere({
      premiereProjectPath,
      sequenceId: "seq-1",
    });
    const folder = path.join(root, "SFUniqlo", "Stellar");
    assert.strictEqual(first.workspaceRoot, folder);
    assert.strictEqual(first.timelinePath, path.join("timelines", "Polish_v1.otio"));
    assert.isFalse(first.existed);
    assert.isTrue(yield* fs.exists(path.join(folder, first.timelinePath)));

    const again = yield* videoProjects.createFromPremiere({
      premiereProjectPath,
      sequenceId: "seq-1",
    });
    assert.isTrue(again.existed);
    assert.deepStrictEqual(created, [folder]);
  }).pipe(
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provideMerge(withProjects(created)),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    Effect.scoped,
  );
});

it.live("syncs Premiere's saves without overwriting edits made here", () => {
  const created: Array<string> = [];
  return Effect.gen(function* () {
    const { fs, path, root, premiereProjectPath } = yield* setup;
    const videoProjects = yield* VideoProjects.VideoProjects;
    const { workspaceRoot, timelinePath } = yield* videoProjects.createFromPremiere({
      premiereProjectPath,
      sequenceId: "seq-1",
    });
    const timelineFile = path.join(workspaceRoot, timelinePath);
    const frameWidth = Effect.map(
      fs.readFileString(timelineFile),
      (text) => JSON.parse(text).metadata.stellar.frame.width as number,
    );
    const sync = (usePremiere?: boolean) =>
      Effect.map(
        videoProjects.sync({ workspaceRoot, ...(usePremiere ? { usePremiere } : {}) }),
        ({ state, updated, kept }) => ({ state, updated, kept }),
      );

    assert.deepStrictEqual(yield* sync(), { state: "current", updated: [], kept: [] });

    // Each save has a different byte length, so the change shows even within one clock tick.
    yield* fs.writeFile(premiereProjectPath, prprojWithFrame("540,960"));
    assert.deepStrictEqual(yield* sync(), { state: "updated", updated: [timelinePath], kept: [] });
    assert.strictEqual(yield* frameWidth, 540);
    assert.deepStrictEqual(yield* sync(), { state: "current", updated: [], kept: [] });

    const edited = `${yield* fs.readFileString(timelineFile)}\n`;
    yield* fs.writeFileString(timelineFile, edited);
    assert.deepStrictEqual(yield* sync(), { state: "edited", updated: [], kept: [timelinePath] });

    yield* fs.writeFile(premiereProjectPath, prprojWithFrame("3840,2160,0"));
    assert.deepStrictEqual(yield* sync(), { state: "conflict", updated: [], kept: [timelinePath] });
    assert.strictEqual(yield* fs.readFileString(timelineFile), edited);
    // The conflict is remembered, so an unchanged save still reports it.
    assert.deepStrictEqual(yield* sync(), { state: "conflict", updated: [], kept: [timelinePath] });

    assert.deepStrictEqual(yield* sync(true), {
      state: "updated",
      updated: [timelinePath],
      kept: [],
    });
    assert.strictEqual(yield* frameWidth, 3840);
    assert.strictEqual(
      yield* fs.readFileString(
        path.join(workspaceRoot, "timelines", "replaced", path.basename(timelinePath)),
      ),
      edited,
    );

    yield* fs.remove(premiereProjectPath);
    assert.strictEqual((yield* sync()).state, "offline");

    const elsewhere = yield* videoProjects.sync({ workspaceRoot: root }).pipe(Effect.flip);
    assert.strictEqual(elsewhere.message, "That folder isn't a project here.");
  }).pipe(
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provideMerge(withProjects(created)),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    Effect.scoped,
  );
});

it.live(
  "starts a project from an idea, and a Premiere project saved into it joins the same one",
  () => {
    const created: Array<string> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-video-idea-" });
      const videoProjects = yield* VideoProjects.VideoProjects;
      const project = yield* videoProjects.createFromIdea({
        title: "Jollibee: lần đầu",
        parentFolder: root,
      });
      const folder = path.join(root, "Jollibee lần đầu");
      assert.strictEqual(project.workspaceRoot, path.join(folder, "Stellar"));
      assert.isFalse(project.existed);
      for (const name of ["Footage", "Audio", "B-roll", "Graphics", "Premiere", "Exports"]) {
        assert.isTrue(yield* fs.exists(path.join(folder, name)));
      }
      assert.isTrue(yield* fs.exists(path.join(folder, "Stellar", "timelines")));
      assert.strictEqual(
        (yield* videoProjects.sync({ workspaceRoot: project.workspaceRoot })).state,
        "unlinked",
      );

      const premiereProjectPath = path.join(folder, "Premiere", "Jollibee.prproj");
      yield* fs.writeFile(premiereProjectPath, prproj);
      const pulled = yield* videoProjects.createFromPremiere({
        premiereProjectPath,
        sequenceId: "seq-1",
      });
      assert.strictEqual(pulled.workspaceRoot, project.workspaceRoot);
      assert.isTrue(pulled.existed);
      assert.deepStrictEqual(created, [project.workspaceRoot]);

      const missing = yield* videoProjects
        .createFromIdea({ title: "Nowhere", parentFolder: path.join(root, "missing") })
        .pipe(Effect.flip);
      assert.strictEqual(missing.message, "Choose an existing folder to create it in.");
    }).pipe(
      Effect.provide(
        VideoProjects.layer.pipe(
          Layer.provideMerge(withProjects(created)),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
      Effect.scoped,
    );
  },
);

it.live("copies footage in, replacing a cut-short copy and leaving the originals", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-footage-" });
    const downloads = path.join(root, "Downloads");
    yield* fs.makeDirectory(downloads);
    const sources = ["IMG_2.MOV", "IMG_1.MOV", "IMG_3.HEIC"].map((name) =>
      path.join(downloads, name),
    );
    for (const source of sources) yield* fs.writeFileString(source, `clip ${source}`);
    const destination = path.join(root, "Jollibee", "Footage", "00 Raw");
    yield* fs.makeDirectory(destination, { recursive: true });
    yield* fs.writeFileString(path.join(destination, "IMG_1.MOV"), "cl");

    const progress: Array<number> = [];
    const copy = copyFootage({
      sources,
      destination,
      onCopied: (done) => Effect.sync(() => void progress.push(done)),
    });
    assert.strictEqual(yield* copy, 3);
    assert.deepStrictEqual(progress, [1, 2, 3]);
    assert.strictEqual(
      yield* fs.readFileString(path.join(destination, "IMG_1.MOV")),
      `clip ${sources[1]}`,
    );
    assert.deepStrictEqual((yield* fs.readDirectory(destination)).toSorted(), [
      "IMG_1.MOV",
      "IMG_2.MOV",
      "IMG_3.HEIC",
    ]);
    assert.isTrue(yield* fs.exists(sources[0]!));
    assert.deepStrictEqual(yield* listFootage(path.join(root, "Jollibee")), [
      "Footage/00 Raw/IMG_1.MOV",
      "Footage/00 Raw/IMG_2.MOV",
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("reads a timeline for an agent and applies its edits, refusing a bad one whole", () => {
  const created: Array<string> = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-video-edit-" });
    const videoProjects = yield* VideoProjects.VideoProjects;
    const { workspaceRoot } = yield* videoProjects.createFromIdea({
      title: "Jollibee",
      parentFolder: root,
    });
    const timeline = "timelines/Footage.otio";
    const file = path.join(workspaceRoot, timeline);
    yield* fs.writeFileString(
      file,
      serializeTimeline(
        footageStringout(
          [
            { target: "Footage/a.MOV", duration: 2, width: 1080, height: 1920 },
            { target: "Footage/b.MOV", duration: 1, width: 1080, height: 1920 },
          ],
          path.dirname(workspaceRoot),
        ),
      ),
    );

    const read = yield* videoProjects.readTimeline({ workspaceRoot });
    assert.deepStrictEqual(read.timelines, [timeline]);
    assert.strictEqual(read.premiere, "unlinked");
    const facts = read.project.split("\n");
    assert.strictEqual(facts[0], `Project folder: ${path.dirname(workspaceRoot)}`);
    assert.include(facts[1], "no Premiere project is linked");
    assert.include(facts[2], "Footage: 0 videos in Footage/.");
    assert.deepStrictEqual(read.text.split("\n").slice(1), [
      "V1 0-120 #0:0 a.MOV",
      "V1 120-180 #0:1 b.MOV",
      "A1 0-120 #1:0 a.MOV",
      "A1 120-180 #1:1 b.MOV",
    ]);

    const before = yield* fs.readFileString(file);
    const refused = yield* videoProjects
      .editTimeline({
        workspaceRoot,
        timeline,
        edits: [
          { kind: "split", frame: 60 },
          { kind: "trim", clipId: "0:9", edge: "end", frame: 30 },
        ],
      })
      .pipe(Effect.flip);
    assert.strictEqual(refused.message, "Edit 2 (trim): no clip #0:9. Nothing was changed.");
    assert.strictEqual(yield* fs.readFileString(file), before);

    const edited = yield* videoProjects.editTimeline({
      workspaceRoot,
      timeline,
      edits: [{ kind: "removeRange", start: 0, end: 120, ripple: true }],
    });
    assert.deepStrictEqual(
      edited.text
        .split("\n")
        .slice(1)
        .map((line) => line.replace(/#\S+/, "#id")),
      ["V1 0-60 #id b.MOV", "A1 0-60 #id b.MOV"],
    );
  }).pipe(
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provideMerge(withProjects(created)),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    Effect.scoped,
  );
});

// The service reads the home folder when it is built, so the test's home has a fixed path.
const intakeHome = `${NodeOS.tmpdir()}/stellar-intake-home-${process.pid}`;

it.live("scans Downloads for new footage and only imports from there", () => {
  const created: Array<string> = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const downloads = path.join(intakeHome, "Downloads");
    yield* fs.makeDirectory(downloads, { recursive: true });
    yield* Effect.addFinalizer(() =>
      fs.remove(intakeHome, { recursive: true }).pipe(Effect.ignore),
    );
    yield* fs.writeFileString(path.join(downloads, "IMG_8139.MOV"), "clip");
    yield* fs.writeFileString(path.join(downloads, "notes.txt"), "not footage");
    const videoProjects = yield* VideoProjects.VideoProjects;
    const { workspaceRoot } = yield* videoProjects.createFromIdea({
      title: "Jollibee",
      parentFolder: intakeHome,
    });

    const scan = yield* videoProjects.scanIntake({ workspaceRoot });
    assert.strictEqual(scan.source, downloads);
    assert.deepStrictEqual(
      scan.files.map((file) => [file.path, file.size]),
      [[path.join(downloads, "IMG_8139.MOV"), 4]],
    );

    const outside = yield* videoProjects
      .importFootage({
        workspaceRoot,
        paths: [path.join(intakeHome, "secret.mov")],
        folder: "00 Raw",
      })
      .pipe(Effect.flip);
    assert.strictEqual(outside.message, `Footage is imported from ${downloads}.`);
    const unnamed = yield* videoProjects
      .importFootage({ workspaceRoot, paths: [scan.files[0]!.path], folder: ".." })
      .pipe(Effect.flip);
    assert.strictEqual(unnamed.message, "Name the folder the footage goes in.");
  }).pipe(
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provideMerge(withProjects(created)),
        Layer.provideMerge(Layer.succeed(HostProcess.HomeDirectory, intakeHome)),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
    Effect.scoped,
  );
});

it.live("rejects files that aren't Premiere projects", () =>
  Effect.gen(function* () {
    const videoProjects = yield* VideoProjects.VideoProjects;
    const error = yield* videoProjects
      .inspectPremiere({ premiereProjectPath: "/tmp/not-a-project.mov" })
      .pipe(Effect.flip);
    assert.strictEqual(error.message, "Choose a Premiere project (.prproj) file.");
  }).pipe(
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provideMerge(withProjects([])),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);
