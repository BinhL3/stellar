import {
  CarouselDocument,
  type CarouselCreateInput,
  type CarouselCreateResult,
  type CarouselEditInput,
  type CarouselExportInput,
  type CarouselExportResult,
  type CarouselImageFormat,
  type CarouselImportPhotosInput,
  type CarouselImportResult,
  type CarouselPhoto,
  type CarouselPreviewInput,
  type CarouselPreviewResult,
  type CarouselReadInput,
  type CarouselRenderRequest,
  type CarouselSubmitRenderInput,
  type CarouselUploadPhotoInput,
  type CarouselView,
  type CarouselWatchState,
  CommandId,
  ProjectId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  applyCarouselEdits,
  captionFileText,
  CAROUSEL_CAPTION_FILE,
  CAROUSEL_EXPORT_DIRECTORY,
  CAROUSEL_FILE,
  CAROUSEL_PHOTO_DIRECTORY,
  emptyCarousel,
  exportFileNames,
  exportWarnings,
  imageSize,
  isExportFile,
  SLIDE_WIDTH,
  slideSize,
} from "@t3tools/timeline/carousel";
import { copyFootage } from "@t3tools/timeline/footage";
import { STILL_PATH } from "@t3tools/timeline/proxies";
import { preparePhoto } from "@t3tools/timeline/proxyBuilder";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ProjectService from "../project/ProjectService.ts";

export class CarouselError extends Schema.TaggedError<CarouselError>()("CarouselError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

const decodeDocument = Schema.decodeUnknownEffect(Schema.fromJsonString(CarouselDocument));

/** Stellar's own files sit in this folder; photos and exports are beside it. */
const STELLAR_FOLDER = "Stellar";
const PROJECT_FOLDERS = [CAROUSEL_PHOTO_DIRECTORY, "Exports", STELLAR_FOLDER];
/** Pictures drawn for an agent to look at, in the Stellar folder. */
const PREVIEW_FOLDER = "carousel-preview";
// Wide enough to read the text on, small enough to look at twenty of.
const PREVIEW_SLIDE_WIDTH = 720;
const PREVIEW_SHEET_CELL_WIDTH = 360;
const RENDER_TIMEOUT = "90 seconds";

const NO_CLIENT =
  "Slides are drawn by the Stellar app, so the export matches what the user sees, and no window has this carousel open. Ask the user to open this project's Carousel tab in Stellar (desktop or web), then call this again. Reading and editing work without it.";

interface PendingRender {
  readonly request: CarouselRenderRequest;
  readonly images: Array<Uint8Array | undefined>;
  readonly done: Deferred.Deferred<ReadonlyArray<Uint8Array>, CarouselError>;
}

interface OpenCarousel {
  readonly state: SubscriptionRef.SubscriptionRef<CarouselWatchState>;
  readonly editing: Semaphore.Semaphore;
  readonly pending: Map<string, PendingRender>;
  /** Clients following the carousel now; only they can draw it. */
  watchers: number;
  /** The file's text as last read or written, to notice a change made outside Stellar. */
  text: string;
}

export class CarouselProjects extends Context.Service<
  CarouselProjects,
  {
    /**
     * Starts a carousel project: makes its Photos, Exports and Stellar folders, writes an empty
     * `carousel.json`, and adds (or reuses) the project.
     */
    readonly create: (
      input: CarouselCreateInput,
    ) => Effect.Effect<CarouselCreateResult, CarouselError>;
    readonly read: (input: CarouselReadInput) => Effect.Effect<CarouselView, CarouselError>;
    /** Applies edits and writes the result. One bad edit refuses them all; nothing is written. */
    readonly edit: (input: CarouselEditInput) => Effect.Effect<CarouselView, CarouselError>;
    /**
     * Copies photos into the project's Photos folder, checking each copy, and makes a drawable
     * copy of the ones no browser decodes. The originals are left where they are. Unless
     * `anyFolder`, only files in the host's Downloads folder are taken.
     */
    readonly importPhotos: (
      input: CarouselImportPhotosInput,
      options?: { readonly anyFolder?: boolean },
    ) => Effect.Effect<CarouselImportResult, CarouselError>;
    /** Saves a photo a client sent from its own device into the Photos folder. */
    readonly uploadPhoto: (
      input: CarouselUploadPhotoInput,
    ) => Effect.Effect<CarouselImportResult, CarouselError>;
    /** The document and the pictures asked of clients, as they change. */
    readonly watch: (input: CarouselReadInput) => Stream.Stream<CarouselWatchState, CarouselError>;
    /** A client's answer to a render request: one picture, or why it could not draw. */
    readonly submitRender: (input: CarouselSubmitRenderInput) => Effect.Effect<void, CarouselError>;
    /**
     * Writes one image per slide, at the exact pixel size, into `Exports/Carousel`, replacing
     * the last export, with the caption beside them. A client draws the slides; with none
     * open this fails and says so.
     */
    readonly export: (
      input: CarouselExportInput,
    ) => Effect.Effect<CarouselExportResult, CarouselError>;
    /** Smaller pictures of some slides, or all of them on one sheet, for an agent to look at. */
    readonly preview: (
      input: CarouselPreviewInput,
    ) => Effect.Effect<CarouselPreviewResult, CarouselError>;
  }
>()("t3/carousel/CarouselProjects") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const downloads = path.join(yield* HostProcess.HomeDirectory, "Downloads");
  const open = new Map<string, OpenCarousel>();
  const opening = yield* Semaphore.make(1);

  const failed = (reason: string) => (cause: unknown) => new CarouselError({ reason, cause });
  const serialize = (document: CarouselDocument) => `${JSON.stringify(document, null, 2)}\n`;
  const documentPath = (workspaceRoot: string) => path.join(workspaceRoot, CAROUSEL_FILE);
  const mediaRootOf = (workspaceRoot: string) => path.dirname(workspaceRoot);

  const writeDocument = (workspaceRoot: string, text: string) =>
    // Written beside the file first, so a crash mid-write never leaves half a document.
    fileSystem
      .writeFileString(`${documentPath(workspaceRoot)}.part`, text)
      .pipe(
        Effect.andThen(
          fileSystem.rename(`${documentPath(workspaceRoot)}.part`, documentPath(workspaceRoot)),
        ),
        Effect.mapError(failed("Could not save the carousel.")),
      );

  const readDocument = Effect.fn("CarouselProjects.readDocument")(function* (
    workspaceRoot: string,
  ) {
    const text = yield* fileSystem
      .readFileString(documentPath(workspaceRoot))
      .pipe(
        Effect.mapError(
          failed(
            "This project has no carousel (no carousel.json in its folder). A carousel project is made with carousel_start, or New project > Carousel.",
          ),
        ),
      );
    const document = yield* decodeDocument(text).pipe(
      Effect.mapError(failed(`${CAROUSEL_FILE} isn't a carousel Stellar can read.`)),
    );
    return { text, document };
  });

  /** The project's carousel as held in memory, re-read when the file changed underneath. */
  const load = Effect.fn("CarouselProjects.load")(function* (workspaceRoot: string) {
    const known = yield* projects
      .getByWorkspaceRoot(workspaceRoot)
      .pipe(Effect.mapError(failed("Could not look up projects.")));
    if (Option.isNone(known)) {
      return yield* new CarouselError({ reason: "That folder isn't a project here." });
    }
    return yield* opening.withPermits(1)(
      Effect.gen(function* () {
        const { text, document } = yield* readDocument(workspaceRoot);
        const mediaRoot = mediaRootOf(workspaceRoot);
        const existing = open.get(workspaceRoot);
        if (existing === undefined) {
          // Revisions start from the clock so they keep rising across a server restart.
          const revision = yield* Clock.currentTimeMillis;
          const carousel: OpenCarousel = {
            state: yield* SubscriptionRef.make<CarouselWatchState>({
              view: { document, revision, mediaRoot },
              renders: [],
            }),
            editing: yield* Semaphore.make(1),
            pending: new Map(),
            watchers: 0,
            text,
          };
          open.set(workspaceRoot, carousel);
          return carousel;
        }
        if (existing.text !== text) {
          existing.text = text;
          yield* SubscriptionRef.update(existing.state, (state) => ({
            ...state,
            view: { document, revision: state.view.revision + 1, mediaRoot },
          }));
        }
        return existing;
      }),
    );
  });

  const viewOf = (carousel: OpenCarousel) =>
    SubscriptionRef.get(carousel.state).pipe(Effect.map((state) => state.view));

  /** Changes the document under the project's lock, writes it, and tells its watchers. */
  const change = Effect.fn("CarouselProjects.change")(function* (
    workspaceRoot: string,
    update: (document: CarouselDocument) => Effect.Effect<CarouselDocument, CarouselError>,
  ) {
    const carousel = yield* load(workspaceRoot);
    return yield* carousel.editing.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* viewOf(carousel);
        const document = yield* update(current.document);
        const text = serialize(document);
        if (text === carousel.text) return current;
        yield* writeDocument(workspaceRoot, text);
        carousel.text = text;
        const view = { ...current, document, revision: current.revision + 1 };
        yield* SubscriptionRef.update(carousel.state, (state) => ({ ...state, view }));
        return view;
      }),
    );
  });

  const create: CarouselProjects["Service"]["create"] = Effect.fn("CarouselProjects.create")(
    function* (input) {
      // The title names a folder, so anything a path would read as a separator comes out.
      const folderName = input.title
        .replace(/[/\\:]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (folderName === "" || folderName.startsWith(".")) {
        return yield* new CarouselError({ reason: "Give the project a name." });
      }
      const parent = yield* fileSystem.stat(input.parentFolder).pipe(Effect.option);
      if (
        !path.isAbsolute(input.parentFolder) ||
        Option.isNone(parent) ||
        parent.value.type !== "Directory"
      ) {
        return yield* new CarouselError({ reason: "Choose an existing folder to create it in." });
      }
      const root = path.join(input.parentFolder, folderName);
      for (const folder of PROJECT_FOLDERS) {
        yield* fileSystem
          .makeDirectory(path.join(root, folder), { recursive: true })
          .pipe(Effect.mapError(failed(`Could not create ${path.join(root, folder)}.`)));
      }
      const workspaceRoot = path.join(root, STELLAR_FOLDER);
      // A folder that already holds a carousel keeps it.
      if (
        !(yield* fileSystem
          .exists(documentPath(workspaceRoot))
          .pipe(Effect.orElseSucceed(() => false)))
      ) {
        yield* writeDocument(workspaceRoot, serialize(emptyCarousel()));
      }
      const existing = yield* projects
        .getByWorkspaceRoot(workspaceRoot)
        .pipe(Effect.mapError(failed("Could not look up projects.")));
      const project = Option.isSome(existing)
        ? existing.value
        : yield* random.uuidV4().pipe(
            Effect.flatMap((id) =>
              projects.create({
                commandId: CommandId.make(`carousel-project:${id}`),
                projectId: ProjectId.make(id),
                title: input.title,
                workspaceRoot,
                createWorkspaceRootIfMissing: true,
              }),
            ),
            Effect.mapError(failed("Could not add the project.")),
          );
      return { projectId: project.id, workspaceRoot, existed: Option.isSome(existing) };
    },
  );

  const read: CarouselProjects["Service"]["read"] = Effect.fn("CarouselProjects.read")(
    function* (input) {
      return yield* viewOf(yield* load(input.workspaceRoot));
    },
  );

  const edit: CarouselProjects["Service"]["edit"] = Effect.fn("CarouselProjects.edit")(
    function* (input) {
      return yield* change(input.workspaceRoot, (document) => {
        const result = applyCarouselEdits(document, input.edits);
        return result.ok
          ? Effect.succeed(result.document)
          : Effect.fail(new CarouselError({ reason: result.error }));
      });
    },
  );

  /** Adds files already in the Photos folder to the document, with their sizes and copies. */
  const register = Effect.fn("CarouselProjects.register")(function* (
    workspaceRoot: string,
    names: ReadonlyArray<string>,
  ) {
    const mediaRoot = mediaRootOf(workspaceRoot);
    const added: Array<CarouselPhoto> = [];
    const failures: Array<string> = [];
    for (const name of names) {
      const src = `${CAROUSEL_PHOTO_DIRECTORY}/${name}`;
      const prepared = yield* preparePhoto({
        source: path.join(mediaRoot, CAROUSEL_PHOTO_DIRECTORY, name),
        projectDir: workspaceRoot,
        identity: src,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.catch((error) => {
          failures.push(`${name}: ${error.message}`);
          return Effect.succeed(null);
        }),
      );
      if (prepared === null) continue;
      added.push({
        src,
        file:
          prepared.still === null
            ? src
            : path
                .relative(mediaRoot, path.join(workspaceRoot, prepared.still))
                .split(path.sep)
                .join("/"),
        width: prepared.width,
        height: prepared.height,
      });
    }
    const view = yield* change(workspaceRoot, (document) =>
      Effect.succeed({
        ...document,
        photos: [
          ...document.photos.filter((photo) => !added.some((other) => other.src === photo.src)),
          ...added,
        ],
      }),
    );
    return { view, imported: added.map((photo) => photo.src), failed: failures };
  });

  const importPhotos: CarouselProjects["Service"]["importPhotos"] = Effect.fn(
    "CarouselProjects.importPhotos",
  )(function* (input, options) {
    yield* load(input.workspaceRoot);
    const sources = input.paths.map((file) => path.resolve(file));
    const unreadable = sources.find((file) => !STILL_PATH.test(file));
    if (unreadable !== undefined) {
      return yield* new CarouselError({
        reason: `${path.basename(unreadable)} isn't a photo Stellar can use.`,
      });
    }
    if (options?.anyFolder !== true && sources.some((file) => path.dirname(file) !== downloads)) {
      return yield* new CarouselError({ reason: `Photos are imported from ${downloads}.` });
    }
    yield* copyFootage({
      sources,
      destination: path.join(mediaRootOf(input.workspaceRoot), CAROUSEL_PHOTO_DIRECTORY),
      onCopied: () => Effect.void,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) =>
        cause._tag === "FootageCopyError"
          ? new CarouselError({ reason: cause.message })
          : new CarouselError({ reason: "Could not copy the photos.", cause }),
      ),
    );
    return yield* register(
      input.workspaceRoot,
      sources.map((file) => path.basename(file)),
    );
  });

  const uploadPhoto: CarouselProjects["Service"]["uploadPhoto"] = Effect.fn(
    "CarouselProjects.uploadPhoto",
  )(function* (input) {
    yield* load(input.workspaceRoot);
    const name = path.basename(input.name.replaceAll("\\", "/"));
    if (name.startsWith(".") || !STILL_PATH.test(name)) {
      return yield* new CarouselError({ reason: `${input.name} isn't a photo Stellar can use.` });
    }
    const folder = path.join(mediaRootOf(input.workspaceRoot), CAROUSEL_PHOTO_DIRECTORY);
    const target = path.join(folder, name);
    yield* fileSystem
      .makeDirectory(folder, { recursive: true })
      .pipe(
        Effect.andThen(fileSystem.writeFile(`${target}.part`, input.data)),
        Effect.andThen(fileSystem.rename(`${target}.part`, target)),
        Effect.mapError(failed(`Could not save ${name}.`)),
      );
    return yield* register(input.workspaceRoot, [name]);
  });

  // One-slot sliding mailboxes bound a slow WebSocket to the newest state.
  const watch: CarouselProjects["Service"]["watch"] = (input) =>
    Stream.unwrap(
      load(input.workspaceRoot).pipe(
        Effect.map((carousel) =>
          Stream.callback<CarouselWatchState>(
            (mailbox) =>
              Effect.gen(function* () {
                carousel.watchers += 1;
                yield* Effect.addFinalizer(() =>
                  Effect.sync(() => {
                    carousel.watchers -= 1;
                  }),
                );
                yield* SubscriptionRef.changes(carousel.state).pipe(
                  Stream.runForEach((state) =>
                    Effect.sync(() => {
                      Queue.offerUnsafe(mailbox, state);
                    }),
                  ),
                  Effect.forkScoped,
                );
              }),
            { bufferSize: 1, strategy: "sliding" },
          ),
        ),
      ),
    );

  /** Asks the clients that have the carousel open to draw, and waits for the first to finish. */
  const render = Effect.fn("CarouselProjects.render")(function* (
    carousel: OpenCarousel,
    wanted: Pick<CarouselRenderRequest, "kind" | "format" | "slides" | "width">,
  ) {
    if (carousel.watchers === 0) return yield* new CarouselError({ reason: NO_CLIENT });
    const request: CarouselRenderRequest = {
      ...wanted,
      id: yield* random.uuidV4().pipe(Effect.mapError(failed("Could not start the render."))),
      revision: (yield* viewOf(carousel)).revision,
    };
    const pending: PendingRender = {
      request,
      images: Array.from({ length: wanted.kind === "sheet" ? 1 : wanted.slides.length }),
      done: yield* Deferred.make<ReadonlyArray<Uint8Array>, CarouselError>(),
    };
    carousel.pending.set(request.id, pending);
    yield* SubscriptionRef.update(carousel.state, (state) => ({
      ...state,
      renders: [...state.renders, request],
    }));
    const images = yield* Deferred.await(pending.done).pipe(
      Effect.timeoutOption(RENDER_TIMEOUT),
      Effect.ensuring(
        Effect.suspend(() => {
          carousel.pending.delete(request.id);
          return SubscriptionRef.update(carousel.state, (state) => ({
            ...state,
            renders: state.renders.filter((other) => other.id !== request.id),
          }));
        }),
      ),
    );
    if (Option.isNone(images)) {
      return yield* new CarouselError({
        reason:
          "The Stellar window with this carousel open did not draw the slides in time. Check that its Carousel tab is showing and its photos have loaded, then try again.",
      });
    }
    return images.value;
  });

  const submitRender: CarouselProjects["Service"]["submitRender"] = Effect.fn(
    "CarouselProjects.submitRender",
  )(function* (input) {
    const pending = open.get(input.workspaceRoot)?.pending.get(input.requestId);
    // Another client answered first, or the request ran out of time.
    if (pending === undefined) return;
    if (input.error !== undefined) {
      yield* Deferred.fail(pending.done, new CarouselError({ reason: input.error }));
      return;
    }
    if (!Number.isInteger(input.index) || input.index < 0 || input.index >= pending.images.length) {
      return yield* new CarouselError({ reason: "That picture isn't part of the request." });
    }
    pending.images[input.index] ??= input.data;
    const images = pending.images.filter((image) => image !== undefined);
    if (images.length === pending.images.length) yield* Deferred.succeed(pending.done, images);
  });

  const exportSlides: CarouselProjects["Service"]["export"] = Effect.fn("CarouselProjects.export")(
    function* (input) {
      const carousel = yield* load(input.workspaceRoot);
      const { document } = yield* viewOf(carousel);
      const format: CarouselImageFormat = input.format ?? "jpeg";
      const size = slideSize(document.ratio);
      const images = yield* render(carousel, {
        kind: "export",
        format,
        slides: document.slides.map((slide) => slide.id),
        width: SLIDE_WIDTH,
      });
      // What is posted must be the exact size, so a wrong picture is refused, not written.
      for (const [index, image] of images.entries()) {
        const drawn = imageSize(image);
        if (
          drawn?.format !== format ||
          drawn.width !== size.width ||
          drawn.height !== size.height
        ) {
          return yield* new CarouselError({
            reason: `Slide ${index + 1} came back ${drawn === null ? "unreadable" : `${drawn.width}x${drawn.height} ${drawn.format}`}, not ${size.width}x${size.height} ${format}. Nothing was exported.`,
          });
        }
      }
      const folder = path.join(mediaRootOf(input.workspaceRoot), CAROUSEL_EXPORT_DIRECTORY);
      const names = exportFileNames(images.length, format);
      const captionFile = path.join(folder, CAROUSEL_CAPTION_FILE);
      yield* Effect.gen(function* () {
        yield* fileSystem.makeDirectory(folder, { recursive: true });
        // The last export's slides go, so a shorter carousel never sits beside its old tail.
        for (const name of yield* fileSystem.readDirectory(folder)) {
          if (isExportFile(name)) yield* fileSystem.remove(path.join(folder, name));
        }
        for (const [index, image] of images.entries()) {
          yield* fileSystem.writeFile(path.join(folder, names[index] ?? ""), image);
        }
        yield* fileSystem.writeFileString(captionFile, captionFileText(document));
      }).pipe(Effect.mapError(failed(`Could not write the export to ${folder}.`)));
      return {
        folder,
        files: names,
        width: size.width,
        height: size.height,
        captionFile,
        warnings: exportWarnings(document),
      };
    },
  );

  const preview: CarouselProjects["Service"]["preview"] = Effect.fn("CarouselProjects.preview")(
    function* (input) {
      const carousel = yield* load(input.workspaceRoot);
      const { document } = yield* viewOf(carousel);
      const known = document.slides.map((slide) => slide.id);
      const unknown = input.slides?.find((id) => !known.includes(id));
      if (unknown !== undefined) {
        return yield* new CarouselError({ reason: `No slide ${unknown} in this carousel.` });
      }
      const slides = input.slides === undefined || input.slides.length === 0 ? known : input.slides;
      const sheet = input.slides === undefined || input.slides.length === 0;
      const images = yield* render(carousel, {
        kind: sheet ? "sheet" : "slides",
        format: "jpeg",
        slides,
        width: sheet ? PREVIEW_SHEET_CELL_WIDTH : PREVIEW_SLIDE_WIDTH,
      });
      const folder = path.join(input.workspaceRoot, PREVIEW_FOLDER);
      const names = sheet ? ["sheet.jpg"] : slides.map((id) => `${id}.jpg`);
      yield* Effect.gen(function* () {
        yield* fileSystem.makeDirectory(folder, { recursive: true });
        for (const [index, image] of images.entries()) {
          yield* fileSystem.writeFile(path.join(folder, names[index] ?? ""), image);
        }
      }).pipe(Effect.mapError(failed(`Could not write the pictures to ${folder}.`)));
      return { files: names.map((name) => path.join(folder, name)), sheet };
    },
  );

  return CarouselProjects.of({
    create,
    read,
    edit,
    importPhotos,
    uploadPhoto,
    watch,
    submitRender,
    export: exportSlides,
    preview,
  });
});

export const layer = Layer.effect(CarouselProjects, make);
