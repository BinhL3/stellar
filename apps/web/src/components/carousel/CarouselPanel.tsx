import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthFilesystemWriteScope,
  type CarouselExportResult,
  type CarouselImageFormat,
  type CarouselRatio,
  type EnvironmentId,
} from "@t3tools/contracts";
import { slideSize } from "@t3tools/timeline/carousel";
import { DownloadIcon, FrameIcon, Redo2Icon, SmartphoneIcon, Undo2Icon, XIcon } from "lucide-react";
import { type KeyboardEvent, useState } from "react";

import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { Toggle } from "~/components/ui/toggle";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { AddPhotosButton } from "./AddPhotosButton";
import { CarouselInspector } from "./CarouselInspector";
import { PostPreview } from "./PostPreview";
import { type Selection, SlideCanvas } from "./SlideCanvas";
import { SlideStrip } from "./SlideStrip";
import { useCarousel, useCarouselRenders } from "./useCarousel";
import { useCarouselPhotos } from "./useCarouselPhotos";

const RATIOS: ReadonlyArray<readonly [CarouselRatio, string]> = [
  ["4:5", "4:5 portrait"],
  ["3:4", "3:4 tall"],
  ["1:1", "1:1 square"],
];

const isTyping = (target: EventTarget) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

/**
 * The carousel surface: the slide on a canvas, the strip of slides under it, and an inspector
 * for what is selected. Every change goes through `edit`, the same edits an agent's tool makes.
 */
export default function CarouselPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}) {
  const carousel = useCarousel(props.environmentId, props.workspaceRoot);
  const photos = useCarouselPhotos(props.environmentId, props.workspaceRoot, carousel.view);
  const canEdit = useEnvironmentScope(props.environmentId, AuthFilesystemWriteScope);
  const [slideId, setSlideId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);
  const [guides, setGuides] = useState(true);
  const [previewing, setPreviewing] = useState(false);
  const [pickedPhoto, setPickedPhoto] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState<CarouselExportResult | null>(null);
  const exportCarousel = useAtomCommand(projectEnvironment.exportCarousel, {
    reportFailure: false,
  });
  const { document } = carousel;
  useCarouselRenders({
    environmentId: props.environmentId,
    workspaceRoot: props.workspaceRoot,
    document,
    renders: carousel.renders,
    photoOf: photos.photoOf,
    photosReady: photos.ready,
  });

  if (document === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        {carousel.error === null ? (
          <Spinner size="lg" />
        ) : (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>Couldn't open the carousel</EmptyTitle>
              <EmptyDescription>{carousel.error}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    );
  }

  // The slide is remembered by id, so it stays selected when slides are added or reordered.
  const found = document.slides.findIndex((slide) => slide.id === slideId);
  const slideIndex = found < 0 ? 0 : found;
  const slide = document.slides[slideIndex];
  if (slide === undefined) return null;
  const size = slideSize(document.ratio);
  const picked =
    pickedPhoto !== null && document.photos.some((photo) => photo.src === pickedPhoto)
      ? pickedPhoto
      : null;
  const selected = slide.layers.find((layer) => layer.id === selection);

  const selectSlide = (id: string) => {
    setSlideId(id);
    setSelection(null);
  };

  const runExport = async (format: CarouselImageFormat) => {
    setExporting(true);
    const result = await exportCarousel({
      environmentId: props.environmentId,
      input: { workspaceRoot: props.workspaceRoot, format },
    });
    setExporting(false);
    if (result._tag === "Success") {
      setExported(result.value);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not export",
      description: error instanceof Error ? error.message : "Try again in a moment.",
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isTyping(event.target) || !canEdit) return;
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) carousel.redo();
      else carousel.undo();
      return;
    }
    if (command && event.key.toLowerCase() === "y") {
      event.preventDefault();
      carousel.redo();
      return;
    }
    if (event.key === "Escape") {
      setSelection(null);
      return;
    }
    if (selected === undefined) return;
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      carousel.edit([{ kind: "removeLayer", slide: slide.id, layerId: selected.id }]);
      setSelection(null);
      return;
    }
    const by = event.shiftKey ? 10 : 1;
    const nudge = (
      { ArrowLeft: [-by, 0], ArrowRight: [by, 0], ArrowUp: [0, -by], ArrowDown: [0, by] } as const
    )[event.key];
    if (nudge === undefined) return;
    event.preventDefault();
    carousel.edit([
      {
        kind: "updateLayer",
        slide: slide.id,
        layerId: selected.id,
        layer: { x: selected.x + nudge[0], y: selected.y + nudge[1] },
      },
    ]);
  };

  return (
    // The panel takes keys only while focus is inside it, so it never fights the composer.
    <div
      className="@container/carousel flex min-h-0 flex-1 flex-col outline-none"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="@container/bar flex h-11 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <Select
          value={document.ratio}
          disabled={!canEdit}
          onValueChange={(ratio) =>
            ratio === null ? undefined : carousel.edit([{ kind: "setRatio", ratio }])
          }
        >
          <SelectTrigger size="sm" variant="ghost" aria-label="Aspect ratio">
            <SelectValue>{(value: CarouselRatio) => value}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="start" alignItemWithTrigger={false}>
            {RATIOS.map(([ratio, label]) => (
              <SelectItem key={ratio} value={ratio}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <span className="text-2xs text-muted-foreground tabular-nums @max-[30rem]/bar:hidden">
          {size.width}×{size.height}
        </span>
        <Toggle size="sm" pressed={guides} onPressedChange={setGuides} aria-label="Safe margins">
          <FrameIcon />
          <span className="@max-[38rem]/bar:sr-only">Guides</span>
        </Toggle>
        {canEdit ? (
          <>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Undo"
              disabled={!carousel.canUndo}
              onClick={carousel.undo}
            >
              <Undo2Icon />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Redo"
              disabled={!carousel.canRedo}
              onClick={carousel.redo}
            >
              <Redo2Icon />
            </Button>
          </>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {canEdit ? (
            <AddPhotosButton
              environmentId={props.environmentId}
              workspaceRoot={props.workspaceRoot}
            />
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            aria-label="Preview as post"
            onClick={() => setPreviewing(true)}
          >
            <SmartphoneIcon />
            <span className="@max-[38rem]/bar:sr-only">Preview</span>
          </Button>
          {canEdit ? (
            <Menu>
              <MenuTrigger
                disabled={exporting || !photos.ready}
                render={<Button size="sm" aria-label="Export" />}
              >
                <DownloadIcon />
                <span className="@max-[30rem]/bar:sr-only">
                  {exporting ? "Exporting…" : "Export"}
                </span>
              </MenuTrigger>
              <MenuPopup align="end" side="bottom">
                <MenuItem onClick={() => void runExport("jpeg")}>
                  JPEG, for Instagram ({size.width}×{size.height})
                </MenuItem>
                <MenuItem onClick={() => void runExport("png")}>PNG, lossless</MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
        </span>
      </div>
      {exported === null ? null : (
        <div className="flex shrink-0 items-start gap-2 border-b border-border/60 bg-success/8 px-3 py-2 text-xs">
          <div className="min-w-0 flex-1">
            <p>
              Exported {exported.files.length} {exported.files.length === 1 ? "slide" : "slides"} at{" "}
              {exported.width}×{exported.height} ({exported.files[0]} to {exported.files.at(-1)})
              with the caption in caption.txt.
            </p>
            <p className="break-all text-muted-foreground select-text">{exported.folder}</p>
            {exported.warnings.map((warning) => (
              <p key={warning} className="text-warning-foreground">
                {warning}
              </p>
            ))}
          </div>
          <Button
            size="icon-micro"
            variant="ghost"
            aria-label="Dismiss"
            onClick={() => setExported(null)}
          >
            <XIcon />
          </Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col @[44rem]/carousel:flex-row">
        <div className="flex min-h-64 min-w-0 flex-1 flex-col">
          <SlideCanvas
            document={document}
            slideIndex={slideIndex}
            photoOf={photos.photoOf}
            selection={selection}
            onSelect={setSelection}
            guides={guides}
            canEdit={canEdit}
            onEdit={carousel.edit}
          />
          <SlideStrip
            document={document}
            slideIndex={slideIndex}
            onSelect={selectSlide}
            photoOf={photos.photoOf}
            canEdit={canEdit}
            onEdit={carousel.edit}
            photo={picked}
          />
        </div>
        <div className="flex max-h-[42%] min-h-0 shrink-0 flex-col border-t border-border/60 @[44rem]/carousel:max-h-none @[44rem]/carousel:w-72 @[44rem]/carousel:border-t-0 @[44rem]/carousel:border-l">
          <CarouselInspector
            document={document}
            slide={slide}
            selection={selection}
            onSelect={setSelection}
            canEdit={canEdit}
            onEdit={carousel.edit}
            photoOf={photos.photoOf}
            pickedPhoto={picked}
            onPickPhoto={setPickedPhoto}
          />
        </div>
      </div>
      <PostPreview
        open={previewing}
        onOpenChange={setPreviewing}
        document={document}
        photoOf={photos.photoOf}
        title={(carousel.view?.mediaRoot ?? "").replace(/\/+$/, "").split("/").at(-1) ?? "Post"}
      />
    </div>
  );
}
