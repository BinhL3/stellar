import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A carousel is an Instagram post of several slides. Its document is `carousel.json` in the
 * project's Stellar folder. Every length is in pixels of the exported slide, which is always
 * 1080 wide; a layer's `x` and `y` are its centre, from the slide's top-left corner.
 */
export const CarouselRatio = Schema.Literals(["4:5", "1:1", "3:4"]);
export type CarouselRatio = typeof CarouselRatio.Type;

export const CarouselFont = Schema.Literals(["sans", "serif", "rounded", "display", "mono"]);
export type CarouselFont = typeof CarouselFont.Type;

/** `#rrggbb`, or `#rrggbbaa` for a see-through colour. */
const Color = Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/));
const Finite = Schema.Number.check(Schema.isFinite());
const PhotoPath = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));

/** A photo in the project, by its path under the media root, such as `Photos/IMG_0042.heic`. */
export const CarouselPhoto = Schema.Struct({
  src: PhotoPath,
  /** The file a browser draws: the original, or the copy made of a HEIC, TIFF, PSD or raw. */
  file: PhotoPath,
  /** The upright size. Zero when it could not be read; drawing measures the picture itself. */
  width: Finite,
  height: Finite,
});
export type CarouselPhoto = typeof CarouselPhoto.Type;

export const CarouselPhotoPlacement = Schema.Struct({
  src: PhotoPath,
  /** `fill` covers the slide and crops the overflow; `fit` shows the whole photo. */
  fit: Schema.Literals(["fill", "fit"]),
  /** How far the photo's centre sits from the slide's centre. */
  offsetX: Finite,
  offsetY: Finite,
  /** 1 is the fitted size. */
  scale: Finite,
  /** Degrees clockwise. */
  rotation: Finite,
});
export type CarouselPhotoPlacement = typeof CarouselPhotoPlacement.Type;

export const CarouselBackground = Schema.Struct({
  color: Color,
  photo: Schema.NullOr(CarouselPhotoPlacement),
});
export type CarouselBackground = typeof CarouselBackground.Type;

export const CarouselPhotoLayer = Schema.Struct({
  kind: Schema.Literal("photo"),
  id: TrimmedNonEmptyString,
  src: PhotoPath,
  x: Finite,
  y: Finite,
  /** The frame the photo fills, cropped from its centre. */
  width: Finite,
  height: Finite,
  rotation: Finite,
  opacity: Finite,
  radius: Finite,
  /**
   * How many slides the layer runs across, starting at its own. A panorama is one photo
   * `span` slides wide: each later slide draws it shifted left by a slide width.
   */
  span: Finite,
});
export type CarouselPhotoLayer = typeof CarouselPhotoLayer.Type;

export const CarouselTextLayer = Schema.Struct({
  kind: Schema.Literal("text"),
  id: TrimmedNonEmptyString,
  text: Schema.String.check(Schema.isMaxLength(2000)),
  font: CarouselFont,
  size: Finite,
  weight: Finite,
  color: Color,
  align: Schema.Literals(["left", "center", "right"]),
  x: Finite,
  y: Finite,
  /** Lines wrap at this width; the text aligns inside it. */
  maxWidth: Finite,
  rotation: Finite,
  /** A multiple of the font size. */
  lineHeight: Finite,
  stroke: Schema.NullOr(Schema.Struct({ color: Color, width: Finite })),
  shadow: Schema.NullOr(
    Schema.Struct({ color: Color, blur: Finite, offsetX: Finite, offsetY: Finite }),
  ),
  /** A filled box behind the words. */
  box: Schema.NullOr(Schema.Struct({ color: Color, padding: Finite, radius: Finite })),
});
export type CarouselTextLayer = typeof CarouselTextLayer.Type;

export const CarouselLayer = Schema.Union([CarouselPhotoLayer, CarouselTextLayer]);
export type CarouselLayer = typeof CarouselLayer.Type;

export const CarouselSlide = Schema.Struct({
  id: TrimmedNonEmptyString,
  altText: Schema.String,
  background: CarouselBackground,
  /** Bottom first. */
  layers: Schema.Array(CarouselLayer),
});
export type CarouselSlide = typeof CarouselSlide.Type;

export const CarouselDocument = Schema.Struct({
  version: Schema.Literal(1),
  ratio: CarouselRatio,
  caption: Schema.String,
  slides: Schema.Array(CarouselSlide),
  photos: Schema.Array(CarouselPhoto),
  /** The number the next slide or layer id takes. */
  nextId: Finite,
});
export type CarouselDocument = typeof CarouselDocument.Type;

/**
 * One edit to a carousel. Flat on purpose: which fields apply depends on `kind`, and tool
 * schemas with unions are harder for models to fill in.
 */
export const CarouselEdit = Schema.Struct({
  kind: Schema.Literals([
    "addSlide",
    "removeSlide",
    "moveSlide",
    "duplicateSlide",
    "setBackground",
    "addLayer",
    "updateLayer",
    "removeLayer",
    "moveLayer",
    "setCaption",
    "setAltText",
    "setRatio",
    "restore",
  ]),
  /** A slide id such as `s2`. */
  slide: Schema.optional(Schema.String),
  /** Where a new or moved slide or layer lands, counted from 0. */
  index: Schema.optional(Finite),
  /** addSlide: `blank`, `photo` (a full-bleed `src`) or `title` (`text` as a headline). */
  layout: Schema.optional(Schema.Literals(["blank", "photo", "title"])),
  layerId: Schema.optional(Schema.String),
  /** addLayer needs `kind` (and `src` or `text`); updateLayer takes only what changes. */
  layer: Schema.optional(
    Schema.Struct({
      kind: Schema.optional(Schema.Literals(["photo", "text"])),
      src: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
      x: Schema.optional(Finite),
      y: Schema.optional(Finite),
      width: Schema.optional(Finite),
      height: Schema.optional(Finite),
      rotation: Schema.optional(Finite),
      opacity: Schema.optional(Finite),
      radius: Schema.optional(Finite),
      span: Schema.optional(Finite),
      font: Schema.optional(CarouselFont),
      size: Schema.optional(Finite),
      weight: Schema.optional(Finite),
      color: Schema.optional(Schema.String),
      align: Schema.optional(Schema.Literals(["left", "center", "right"])),
      maxWidth: Schema.optional(Finite),
      lineHeight: Schema.optional(Finite),
      stroke: Schema.optional(CarouselTextLayer.fields.stroke),
      shadow: Schema.optional(CarouselTextLayer.fields.shadow),
      box: Schema.optional(CarouselTextLayer.fields.box),
    }),
  ),
  /** setBackground: a colour and/or a photo; `photo: null` takes the photo away. */
  color: Schema.optional(Schema.String),
  photo: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        src: Schema.String,
        fit: Schema.optional(Schema.Literals(["fill", "fit"])),
        offsetX: Schema.optional(Finite),
        offsetY: Schema.optional(Finite),
        scale: Schema.optional(Finite),
        rotation: Schema.optional(Finite),
      }),
    ),
  ),
  /** The photo of an addSlide `photo` layout. */
  src: Schema.optional(Schema.String),
  /** The caption, the alt text, or a `title` layout's headline. */
  text: Schema.optional(Schema.String),
  ratio: Schema.optional(CarouselRatio),
  /** restore: the slides, caption and ratio to go back to (undo). */
  document: Schema.optional(CarouselDocument),
});
export type CarouselEdit = typeof CarouselEdit.Type;

const { document: _restored, kind: _kind, ...agentEditFields } = CarouselEdit.fields;

/** The edits an agent's tool takes: all but `restore`, whose whole document would bloat the schema. */
export const CarouselAgentEdit = Schema.Struct({
  kind: Schema.Literals(CarouselEdit.fields.kind.literals.filter((kind) => kind !== "restore")),
  ...agentEditFields,
});

const WorkspaceRoot = TrimmedNonEmptyString.check(Schema.isMaxLength(4096));

export const CarouselCreateInput = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  /** An existing folder on the host; the project's folder is created inside it. */
  parentFolder: WorkspaceRoot,
});
export type CarouselCreateInput = typeof CarouselCreateInput.Type;

export const CarouselCreateResult = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
  existed: Schema.Boolean,
});
export type CarouselCreateResult = typeof CarouselCreateResult.Type;

export const CarouselReadInput = Schema.Struct({ workspaceRoot: WorkspaceRoot });
export type CarouselReadInput = typeof CarouselReadInput.Type;

export const CarouselEditInput = Schema.Struct({
  workspaceRoot: WorkspaceRoot,
  edits: Schema.Array(CarouselEdit).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export type CarouselEditInput = typeof CarouselEditInput.Type;

export const CarouselImportPhotosInput = Schema.Struct({
  workspaceRoot: WorkspaceRoot,
  /** Files on the host. Over the WebSocket only the host's Downloads folder is accepted. */
  paths: Schema.Array(WorkspaceRoot).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
});
export type CarouselImportPhotosInput = typeof CarouselImportPhotosInput.Type;

export const CarouselUploadPhotoInput = Schema.Struct({
  workspaceRoot: WorkspaceRoot,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  data: Schema.Uint8ArrayFromBase64,
});
export type CarouselUploadPhotoInput = typeof CarouselUploadPhotoInput.Type;

export const CarouselImageFormat = Schema.Literals(["jpeg", "png"]);
export type CarouselImageFormat = typeof CarouselImageFormat.Type;

/**
 * Slides are drawn by a client, so that an export is the picture the user approved. The server
 * asks whichever clients have the carousel open; `export` wants every slide at full size,
 * `slides` a smaller picture of some, `sheet` all of them on one contact sheet.
 */
export const CarouselRenderRequest = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["export", "slides", "sheet"]),
  format: CarouselImageFormat,
  /** Slide ids to draw, in order; a sheet draws them all into one image. */
  slides: Schema.Array(Schema.String),
  /** The width of each picture: 1080 for an export. */
  width: Finite,
  /** The document revision the request was made against. */
  revision: Finite,
});
export type CarouselRenderRequest = typeof CarouselRenderRequest.Type;

/** A carousel as clients and agents read it. */
export const CarouselView = Schema.Struct({
  document: CarouselDocument,
  /** Goes up by one with every change, so a client can tell a newer document from its own. */
  revision: Finite,
  /** The absolute folder photo paths are relative to. */
  mediaRoot: Schema.String,
});
export type CarouselView = typeof CarouselView.Type;

/** What a client with the carousel open follows: the document and the pictures asked of it. */
export const CarouselWatchState = Schema.Struct({
  view: CarouselView,
  renders: Schema.Array(CarouselRenderRequest),
});
export type CarouselWatchState = typeof CarouselWatchState.Type;

export const CarouselSubmitRenderInput = Schema.Struct({
  workspaceRoot: WorkspaceRoot,
  requestId: TrimmedNonEmptyString,
  /** The picture's place in the request's `slides`; a sheet is index 0. */
  index: Finite,
  data: Schema.Uint8ArrayFromBase64,
  /** Why the client could not draw, in place of a picture; the request then fails with it. */
  error: Schema.optional(Schema.String),
});
export type CarouselSubmitRenderInput = typeof CarouselSubmitRenderInput.Type;

export const CarouselExportInput = Schema.Struct({
  workspaceRoot: WorkspaceRoot,
  format: Schema.optional(CarouselImageFormat),
});
export type CarouselExportInput = typeof CarouselExportInput.Type;

export const CarouselExportResult = Schema.Struct({
  /** The folder the slides were written to. */
  folder: Schema.String,
  files: Schema.Array(Schema.String),
  width: Finite,
  height: Finite,
  /** The caption and alt texts as a text file beside the slides, ready to paste. */
  captionFile: Schema.String,
  warnings: Schema.Array(Schema.String),
});
export type CarouselExportResult = typeof CarouselExportResult.Type;

export const CarouselImportResult = Schema.Struct({
  view: CarouselView,
  /** The photos now in the project, by the path edits name them with. */
  imported: Schema.Array(Schema.String),
  /** Files that were copied but could not be read as a photo, each with why. */
  failed: Schema.Array(Schema.String),
});
export type CarouselImportResult = typeof CarouselImportResult.Type;

export const CarouselPreviewInput = Schema.Struct({
  workspaceRoot: WorkspaceRoot,
  /** Slide ids to draw one picture each of; omit for one contact sheet of every slide. */
  slides: Schema.optional(Schema.Array(Schema.String)),
});
export type CarouselPreviewInput = typeof CarouselPreviewInput.Type;

export const CarouselPreviewResult = Schema.Struct({
  /** Absolute paths of the pictures, in the order asked. */
  files: Schema.Array(Schema.String),
  sheet: Schema.Boolean,
});
export type CarouselPreviewResult = typeof CarouselPreviewResult.Type;
