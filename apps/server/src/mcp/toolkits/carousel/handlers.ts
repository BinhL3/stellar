import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { carouselText, MAX_SLIDES, slideGuides, slideSize } from "@t3tools/timeline/carousel";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as CarouselProjects from "../../../carousel/CarouselProjects.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readThread, unavailable } from "../../threadAccess.ts";
import { CarouselToolkit } from "./tools.ts";

const refused = (error: CarouselProjects.CarouselError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/** The folder of the project the calling thread belongs to. */
const callerWorkspaceRoot = Effect.gen(function* () {
  const {
    projection: { thread },
  } = yield* readThread();
  const projects = yield* Project.ProjectService;
  const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(unavailable));
  if (Option.isNone(project)) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The project was not found.",
    });
  }
  return project.value.workspaceRoot;
});

/**
 * How to work on a carousel, given with every read. It rides on the tool result so only
 * carousel threads pay for it; the standing instructions carry one line that points here.
 */
const carouselGuide = (ratio: Parameters<typeof slideSize>[0]) => {
  const { width, height } = slideSize(ratio);
  const { safe, grid } = slideGuides(ratio);
  return [
    `This project is an Instagram photo carousel, not a video: the video_* tools don't apply. Every slide is ${width}x${height} (ratio ${ratio}); Instagram gives one ratio to the whole post and takes up to ${MAX_SLIDES} slides.`,
    "Work in a loop: carousel_edit, then carousel_look, open the picture and check it yourself. Text you can't read at phone size, text over a busy part of a photo, or a cropped face is not done.",
    `Keep text inside x ${safe.x}-${safe.x + safe.width}, y ${safe.y}-${safe.y + safe.height}; the feed draws its slide counter over the top-right corner. The profile grid shows only the first slide, cropped to x ${Math.round(grid.x)}-${Math.round(grid.x + grid.width)}.`,
    "A photo must be in the project before a slide can use it: carousel_photos imports by path. The first slide is the hook; the last can ask for the save or follow.",
    "Write the caption with setCaption (2,200 characters and 30 hashtags at most) and alt text for every slide with setAltText, in the language the post is in.",
    "carousel_export writes the files; the user posts them from their phone, Stellar never does. Looking and exporting need this project's Carousel tab open in Stellar; reading and editing don't.",
  ].join("\n");
};

const handlers = {
  carousel_read: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const workspaceRoot = yield* callerWorkspaceRoot;
      const carousels = yield* CarouselProjects.CarouselProjects;
      const { document } = yield* carousels.read({ workspaceRoot }).pipe(Effect.mapError(refused));
      return { text: carouselText(document), guide: carouselGuide(document.ratio) };
    }),
  ),
  carousel_edit: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* callerWorkspaceRoot;
      const carousels = yield* CarouselProjects.CarouselProjects;
      const { document } = yield* carousels
        .edit({ workspaceRoot, edits: input.edits })
        .pipe(Effect.mapError(refused));
      return { text: carouselText(document) };
    }),
  ),
  carousel_look: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* callerWorkspaceRoot;
      const carousels = yield* CarouselProjects.CarouselProjects;
      return yield* carousels
        .preview({ workspaceRoot, ...(input.slides === undefined ? {} : { slides: input.slides }) })
        .pipe(Effect.mapError(refused));
    }),
  ),
  carousel_photos: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* callerWorkspaceRoot;
      const carousels = yield* CarouselProjects.CarouselProjects;
      const result = yield* carousels
        .importPhotos({ workspaceRoot, paths: input.paths }, { anyFolder: true })
        .pipe(Effect.mapError(refused));
      return {
        imported: result.imported,
        failed: result.failed,
        text: carouselText(result.view.document),
      };
    }),
  ),
  carousel_export: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* callerWorkspaceRoot;
      const carousels = yield* CarouselProjects.CarouselProjects;
      return yield* carousels
        .export({ workspaceRoot, ...(input.format === undefined ? {} : { format: input.format }) })
        .pipe(Effect.mapError(refused));
    }),
  ),
  carousel_start: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const carousels = yield* CarouselProjects.CarouselProjects;
      return yield* carousels.create(input).pipe(Effect.mapError(refused));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof CarouselToolkit.tools>;

export const layer = McpToolAccess.toLayer(CarouselToolkit, handlers);
