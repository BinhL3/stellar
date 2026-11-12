import type { CarouselDocument, CarouselEdit } from "@t3tools/contracts";
import { MAX_SLIDES, slideSize } from "@t3tools/timeline/carousel";
import { CopyIcon, ImageIcon, PlusIcon, SquareIcon, Trash2Icon, TypeIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { cn } from "~/lib/utils";

import { drawSlide, type PhotoLookup } from "./drawSlide";

/** A slide drawn small by the same routine as the canvas and the export. */
export function SlidePicture(props: {
  readonly document: CarouselDocument;
  readonly index: number;
  readonly photoOf: PhotoLookup;
  /** Width on screen, in CSS pixels. */
  readonly width: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const size = slideSize(props.document.ratio);
  const height = Math.round((props.width * size.height) / size.width);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A canvas is drawn imperatively; every render may have changed what it shows.
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = Math.round(props.width * ratio);
    element.height = Math.round(height * ratio);
    drawSlide(
      context,
      props.document,
      props.index,
      props.photoOf,
      (props.width * ratio) / size.width,
    );
  });
  return <canvas ref={canvas} className="block" style={{ width: props.width, height }} />;
}

const THUMB_WIDTH = 56;

/** The post's slides in order: pick one, drag to reorder, add, duplicate and delete. */
export function SlideStrip(props: {
  readonly document: CarouselDocument;
  readonly slideIndex: number;
  /** Slides are picked by id, which a reorder or an insert before them doesn't change. */
  readonly onSelect: (slideId: string) => void;
  readonly photoOf: PhotoLookup;
  readonly canEdit: boolean;
  readonly onEdit: (edits: ReadonlyArray<CarouselEdit>) => CarouselDocument | null;
  /** The photo a new photo slide starts with, when one is picked in the tray. */
  readonly photo: string | null;
}) {
  const [dragged, setDragged] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const { slides } = props.document;
  const current = slides[props.slideIndex];
  const full = slides.length >= MAX_SLIDES;
  const add = (edit: CarouselEdit) => {
    const next = props.onEdit([{ ...edit, index: props.slideIndex + 1 }]);
    const added = next?.slides[props.slideIndex + 1];
    if (added !== undefined) props.onSelect(added.id);
  };
  return (
    <div className="flex shrink-0 items-stretch gap-2 border-t border-border/60 bg-lanes px-2 py-2">
      <ol className="flex min-w-0 flex-1 items-end gap-2 overflow-x-auto pb-1" aria-label="Slides">
        {slides.map((slide, index) => (
          <li
            key={slide.id}
            draggable={props.canEdit}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              setDragged(index);
            }}
            onDragOver={(event) => {
              if (dragged === null) return;
              event.preventDefault();
              setOver(index);
            }}
            onDragEnd={() => {
              setDragged(null);
              setOver(null);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragged !== null && dragged !== index) {
                const moved = slides[dragged];
                if (moved !== undefined) {
                  props.onEdit([{ kind: "moveSlide", slide: moved.id, index }]);
                  props.onSelect(moved.id);
                }
              }
              setDragged(null);
              setOver(null);
            }}
            className={cn("shrink-0", dragged === index && "opacity-40")}
          >
            <button
              type="button"
              aria-label={`Slide ${index + 1}`}
              aria-current={index === props.slideIndex}
              onClick={() => props.onSelect(slide.id)}
              className={cn(
                "flex flex-col items-center gap-1 rounded-md p-1 text-2xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                index === props.slideIndex && "bg-primary/14 text-primary",
                over === index && dragged !== index && "ring-2 ring-primary",
              )}
            >
              <span className="overflow-hidden rounded-sm border border-border/60">
                <SlidePicture
                  document={props.document}
                  index={index}
                  photoOf={props.photoOf}
                  width={THUMB_WIDTH}
                />
              </span>
              <span className="tabular-nums">{index + 1}</span>
            </button>
          </li>
        ))}
      </ol>
      {props.canEdit ? (
        <div className="flex shrink-0 flex-col justify-center gap-1">
          <Menu>
            <MenuTrigger
              disabled={full}
              render={<Button size="icon-sm" variant="outline" aria-label="Add slide" />}
            >
              <PlusIcon />
            </MenuTrigger>
            <MenuPopup align="end" side="top">
              <MenuItem onClick={() => add({ kind: "addSlide", layout: "blank" })}>
                <SquareIcon />
                Blank slide
              </MenuItem>
              <MenuItem onClick={() => add({ kind: "addSlide", layout: "title", text: "Title" })}>
                <TypeIcon />
                Title slide
              </MenuItem>
              <MenuItem
                disabled={props.photo === null}
                onClick={() =>
                  props.photo === null
                    ? undefined
                    : add({ kind: "addSlide", layout: "photo", src: props.photo })
                }
              >
                <ImageIcon />
                {props.photo === null ? "Photo slide (pick a photo first)" : "Photo slide"}
              </MenuItem>
            </MenuPopup>
          </Menu>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Duplicate slide"
            disabled={full || current === undefined}
            onClick={() =>
              current === undefined ? undefined : add({ kind: "duplicateSlide", slide: current.id })
            }
          >
            <CopyIcon />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost-destructive"
            aria-label="Delete slide"
            disabled={slides.length <= 1 || current === undefined}
            onClick={() => {
              if (current === undefined) return;
              const neighbour = slides[props.slideIndex + 1] ?? slides[props.slideIndex - 1];
              props.onEdit([{ kind: "removeSlide", slide: current.id }]);
              if (neighbour !== undefined) props.onSelect(neighbour.id);
            }}
          >
            <Trash2Icon />
          </Button>
        </div>
      ) : null}
    </div>
  );
}
