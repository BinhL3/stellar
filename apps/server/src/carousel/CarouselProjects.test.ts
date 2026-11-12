import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ProjectService from "../project/ProjectService.ts";
import * as CarouselProjects from "./CarouselProjects.ts";

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

const provided = (created: Array<string>) =>
  Effect.provide(
    CarouselProjects.layer.pipe(
      Layer.provideMerge(withProjects(created)),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  );

/** As much of a PNG as says how big it is, which is all the server reads of a drawn slide. */
const png = (width: number, height: number) => {
  const bytes = new Uint8Array(24);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x89504e47);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};

const newCarousel = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const carousels = yield* CarouselProjects.CarouselProjects;
  const parentFolder = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-carousel-" });
  const { workspaceRoot } = yield* carousels.create({ title: "Phở: guide", parentFolder });
  return { fs, path, carousels, parentFolder, workspaceRoot };
});

/** Stands in for a client with the carousel open: answers each render with slides of one size. */
const openClient = Effect.fn("test.openClient")(function* (
  workspaceRoot: string,
  size: { width: number; height: number },
) {
  const carousels = yield* CarouselProjects.CarouselProjects;
  const watching = yield* Deferred.make<void>();
  yield* carousels.watch({ workspaceRoot }).pipe(
    Stream.runForEach((state) =>
      Deferred.succeed(watching, undefined).pipe(
        Effect.andThen(
          Effect.forEach(state.renders, (request) =>
            Effect.forEach(request.slides, (_, index) =>
              carousels.submitRender({
                workspaceRoot,
                requestId: request.id,
                index,
                data: png(size.width, size.height),
              }),
            ),
          ),
        ),
      ),
    ),
    Effect.forkScoped,
  );
  yield* Deferred.await(watching);
});

it.live("creates the project's folders and an empty carousel, and keeps one that is there", () => {
  const created: Array<string> = [];
  return Effect.gen(function* () {
    const { fs, path, carousels, parentFolder, workspaceRoot } = yield* newCarousel;
    // A colon can't be in a folder name on the drives footage lives on.
    const root = path.join(parentFolder, "Phở guide");
    assert.strictEqual(workspaceRoot, path.join(root, "Stellar"));
    assert.isTrue(yield* fs.exists(path.join(root, "Photos")));
    assert.isTrue(yield* fs.exists(path.join(root, "Exports")));

    yield* carousels.edit({ workspaceRoot, edits: [{ kind: "setCaption", text: "kept" }] });
    const again = yield* carousels.create({ title: "Phở: guide", parentFolder });
    assert.isTrue(again.existed);
    assert.strictEqual((yield* carousels.read({ workspaceRoot })).document.caption, "kept");
    assert.deepStrictEqual(created, [workspaceRoot]);

    // A video's folder is left a video: a carousel file there would hide its timeline.
    const video = path.join(parentFolder, "Short", "Stellar");
    yield* fs.makeDirectory(path.join(video, "timelines"), { recursive: true });
    const refused = yield* carousels.create({ title: "Short", parentFolder }).pipe(Effect.flip);
    assert.include(refused.message, "already holds a video project");
    assert.isFalse(yield* carousels.isCarousel(video));
    assert.isFalse(yield* fs.exists(path.join(parentFolder, "Short", "Photos")));
    assert.isTrue(yield* carousels.isCarousel(workspaceRoot));
  }).pipe(provided(created), Effect.scoped);
});

it.live("writes an edit to carousel.json, and nothing when one edit of a call is refused", () =>
  Effect.gen(function* () {
    const { fs, path, carousels, workspaceRoot } = yield* newCarousel;
    const file = path.join(workspaceRoot, "carousel.json");
    const before = yield* carousels.read({ workspaceRoot });
    const edited = yield* carousels.edit({
      workspaceRoot,
      edits: [{ kind: "addSlide", layout: "title", text: "Phở 101" }],
    });
    assert.strictEqual(edited.revision, before.revision + 1);
    const saved = yield* fs.readFileString(file);
    assert.include(saved, "Phở 101");

    const refused = yield* carousels
      .edit({
        workspaceRoot,
        edits: [
          { kind: "setCaption", text: "half of a bad call" },
          { kind: "removeSlide", slide: "s9" },
        ],
      })
      .pipe(Effect.flip);
    assert.strictEqual(refused.message, "Edit 2 (removeSlide): no slide s9 in this carousel.");
    assert.strictEqual(yield* fs.readFileString(file), saved);

    // A change made to the file outside Stellar is what the next read returns.
    yield* fs.writeFileString(file, saved.replace("Phở 101", "Bún chả 101"));
    const reread = yield* carousels.read({ workspaceRoot });
    assert.include(JSON.stringify(reread.document), "Bún chả 101");
    assert.strictEqual(reread.revision, edited.revision + 1);
  }).pipe(provided([]), Effect.scoped),
);

it.live("says that a window must be open when asked to export with no client watching", () =>
  Effect.gen(function* () {
    const { fs, path, carousels, workspaceRoot } = yield* newCarousel;
    const failure = yield* carousels.export({ workspaceRoot }).pipe(Effect.flip);
    assert.match(failure.message, /no window has this carousel open/);
    assert.match(failure.message, /Carousel tab/);
    const look = yield* carousels.preview({ workspaceRoot }).pipe(Effect.flip);
    assert.strictEqual(look.message, failure.message);
    assert.deepStrictEqual(
      yield* fs.readDirectory(path.join(path.dirname(workspaceRoot), "Exports")),
      [],
    );
  }).pipe(provided([]), Effect.scoped),
);

it.live("exports the slides a client drew, named in order, replacing the last export", () =>
  Effect.gen(function* () {
    const { fs, path, carousels, workspaceRoot } = yield* newCarousel;
    yield* carousels.edit({
      workspaceRoot,
      edits: [
        { kind: "addSlide" },
        { kind: "addSlide" },
        { kind: "setCaption", text: "Ba quán phở #pho" },
        { kind: "setAltText", slide: "s1", text: "Tô phở" },
      ],
    });
    yield* openClient(workspaceRoot, { width: 1080, height: 1350 });
    const folder = path.join(path.dirname(workspaceRoot), "Exports", "Carousel");
    const first = yield* carousels.export({ workspaceRoot, format: "png" });
    assert.deepStrictEqual(
      { ...first, warnings: [] },
      {
        folder,
        files: ["01.png", "02.png", "03.png"],
        width: 1080,
        height: 1350,
        captionFile: path.join(folder, "caption.txt"),
        warnings: [],
      },
    );
    assert.deepStrictEqual(first.warnings, ["2 of 3 slides have no alt text."]);
    assert.include(
      yield* fs.readFileString(first.captionFile),
      "Ba quán phở #pho\n\nAlt text\n1. Tô phở",
    );

    // A shorter carousel must not leave the old third slide beside its two.
    yield* carousels.edit({ workspaceRoot, edits: [{ kind: "removeSlide", slide: "s3" }] });
    yield* carousels.export({ workspaceRoot, format: "png" });
    assert.deepStrictEqual((yield* fs.readDirectory(folder)).toSorted(), [
      "01.png",
      "02.png",
      "caption.txt",
    ]);
  }).pipe(provided([]), Effect.scoped),
);

it.live("refuses slides that came back at the wrong size and writes nothing", () =>
  Effect.gen(function* () {
    const { fs, path, carousels, workspaceRoot } = yield* newCarousel;
    yield* openClient(workspaceRoot, { width: 540, height: 675 });
    const failure = yield* carousels.export({ workspaceRoot, format: "png" }).pipe(Effect.flip);
    assert.strictEqual(
      failure.message,
      "Slide 1 came back 540x675 png, not 1080x1350 png. Nothing was exported.",
    );
    assert.isFalse(yield* fs.exists(path.join(path.dirname(workspaceRoot), "Exports", "Carousel")));
  }).pipe(provided([]), Effect.scoped),
);
