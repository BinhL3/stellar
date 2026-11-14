import {
  CarouselAgentEdit,
  CarouselCreateResult,
  CarouselExportResult,
  CarouselImageFormat,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as CarouselProjects from "../../../carousel/CarouselProjects.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProjectService.ProjectService,
  CarouselProjects.CarouselProjects,
];

const ReadTool = Tool.make("carousel_read", {
  description:
    "Read this thread's Instagram carousel: `text` has one line per slide (`1. s1 background …`) and per layer under it, bottom first (`l3 text \"…\" sans 64/700 #fff center at 540,300 maxWidth 900`), then the imported photos. Lengths are pixels of the exported slide; `at x,y` is a layer's centre from the slide's top-left. Call it first in a carousel project: `guide` says how to work.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({ text: Schema.String, guide: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read the carousel")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const EditTool = Tool.make("carousel_edit", {
  description:
    "Edit the carousel. `edits` run in order, naming slides and layers by id from `carousel_read`: addSlide (`layout` blank, photo with `src`, or title with `text`; `index` from 0), removeSlide, moveSlide (slide, index), duplicateSlide, setBackground (slide, `color` and/or `photo` {src, fit fill|fit, offsetX, offsetY, scale, rotation}; `photo: null` removes it), addLayer (slide, `layer` with kind photo + src, or kind text + text), updateLayer (slide, layerId, `layer` with only what changes), removeLayer, moveLayer (index 0 is the bottom), setCaption (text), setAltText (slide, text), setRatio (4:5, 1:1 or 3:4, for every slide). A photo layer is a frame (x, y, width, height, rotation, opacity, radius) its photo fills; `span: 3` runs one wide photo across three slides. A text layer has text, font (sans, serif, rounded, display, mono), size, weight, color (#rrggbb), align, maxWidth, lineHeight, and optional stroke {color, width}, shadow {color, blur, offsetX, offsetY} and box {color, padding, radius}. One bad edit refuses the whole call. Returns the new `text`.",
  parameters: Schema.Struct({ edits: Schema.Array(CarouselAgentEdit) }),
  success: Schema.Struct({ text: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Edit the carousel")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

// Marked read-only though it writes picture files: they are a cache in the Stellar folder.
const LookTool = Tool.make("carousel_look", {
  description:
    "See the carousel as it will be posted. Without `slides`, one contact sheet of every slide; with slide ids, one picture per slide, large enough to read. Returns image `files`: open them with your file or image tool and look before you call the work done. The Stellar app draws them, so it needs this project's Carousel tab open; the error says so when it isn't.",
  parameters: Schema.Struct({ slides: Schema.optional(Schema.Array(Schema.String)) }),
  success: Schema.Struct({ files: Schema.Array(Schema.String), sheet: Schema.Boolean }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Look at the slides")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PhotosTool = Tool.make("carousel_photos", {
  description:
    "Bring photos into the carousel project by absolute path on the host (JPEG, PNG, HEIC, WebP, TIFF, raw). Each is copied into the project's Photos folder and checked; the originals stay where they are. `imported` lists the `src` to use in `carousel_edit`; `failed` says which files could not be read.",
  parameters: Schema.Struct({ paths: Schema.Array(Schema.String) }),
  success: Schema.Struct({
    imported: Schema.Array(Schema.String),
    failed: Schema.Array(Schema.String),
    text: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Import photos")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ExportTool = Tool.make("carousel_export", {
  description:
    "Export the carousel: one image per slide at the exact pixel size (`01.jpg`, `02.jpg`…; `format` jpeg by default, or png) into the project's `Exports/Carousel` folder, replacing the last export, with `caption.txt` beside them. Stellar never posts: tell the user where the files are. `warnings` lists what Instagram would refuse or change. The Stellar app draws the slides, so the export is exactly the preview; it needs this project's Carousel tab open, and the error says so when it isn't.",
  parameters: Schema.Struct({ format: Schema.optional(CarouselImageFormat) }),
  success: CarouselExportResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Export the carousel")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const StartTool = Tool.make("carousel_start", {
  description:
    "Start an Instagram photo carousel project. Makes `<parentFolder>/<title>` with Photos, Exports and Stellar folders and adds it as a project; its carousel is edited from a thread in that project. Omit `parentFolder` unless the user names a folder: it defaults to the user's projects folder.",
  parameters: Schema.Struct({
    title: Schema.String,
    parentFolder: Schema.optionalKey(Schema.String),
  }),
  success: CarouselCreateResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Start a carousel project")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const CarouselToolkit = Toolkit.make(
  ReadTool,
  EditTool,
  LookTool,
  PhotosTool,
  ExportTool,
  StartTool,
);
