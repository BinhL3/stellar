import type { CarouselDocument, CarouselEdit, CarouselLayer } from "@t3tools/contracts";
import {
  applyCarouselEdits,
  type Box,
  boxContains,
  CAROUSEL_FONT_STACKS,
  scaleLayer,
  slideSize,
  toBoxSpace,
} from "@t3tools/timeline/carousel";
import { useEffect, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";

import { boxOf, drawOverlay, drawSlide, HANDLE, type PhotoLookup, ROTATE_REACH } from "./drawSlide";

/** What is selected on the slide: a layer by id, the background photo, or nothing. */
export type Selection = string | "background" | null;

interface Point {
  readonly x: number;
  readonly y: number;
}

interface Drag {
  readonly mode: "move" | "scale" | "rotate" | "background";
  readonly start: Point;
  readonly layer: CarouselLayer | null;
  readonly moved: boolean;
}

// Within this many slide pixels of the middle, a dragged layer snaps to it.
const SNAP = 12;
const ROTATION_SNAP = 4;

const snapTo = (value: number, target: number) =>
  Math.abs(value - target) < SNAP ? target : value;

/**
 * The selected slide at its true shape, drawn by the same routine as the export. Layers are
 * picked, dragged, scaled from a corner and turned from the handle above; a double click on
 * text types into it in place.
 */
export function SlideCanvas(props: {
  readonly document: CarouselDocument;
  readonly slideIndex: number;
  readonly photoOf: PhotoLookup;
  readonly selection: Selection;
  readonly onSelect: (selection: Selection) => void;
  readonly guides: boolean;
  readonly canEdit: boolean;
  readonly onEdit: (edits: ReadonlyArray<CarouselEdit>) => void;
}) {
  const well = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [draft, setDraft] = useState<CarouselEdit | null>(null);
  const [typing, setTyping] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The slide is sized to the panel, which only the DOM can measure.
  useEffect(() => {
    const element = well.current;
    if (element === null) return;
    return observeResize(element, (entries) => {
      const entry = entries.at(-1);
      if (entry === undefined) return;
      const { width, height } = entry.contentRect;
      setRoom((current) =>
        current.width === width && current.height === height ? current : { width, height },
      );
    });
  }, []);

  const size = slideSize(props.document.ratio);
  const scale = Math.max(
    0.05,
    Math.min((room.width - 24) / size.width, (room.height - 24) / size.height),
  );
  const drafted = draft === null ? null : applyCarouselEdits(props.document, [draft]);
  const shown = drafted?.ok ? drafted.document : props.document;
  const slide = shown.slides[props.slideIndex];
  const selectedLayer =
    slide?.layers.find((layer) => layer.id === props.selection && layer.id !== typing) ?? null;
  const selectedBox = selectedLayer === null ? null : boxOf(selectedLayer);
  const typed = slide?.layers.find((layer) => layer.id === typing && layer.kind === "text");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A canvas is drawn imperatively; every render may have changed what it shows.
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context || room.width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(size.width * scale * ratio);
    const height = Math.round(size.height * scale * ratio);
    if (element.width !== width || element.height !== height) {
      element.width = width;
      element.height = height;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width, height);
    drawSlide(context, shown, props.slideIndex, props.photoOf, scale * ratio, typing);
    context.scale(ratio, ratio);
    drawOverlay(context, shown, scale, {
      guides: props.guides,
      selected: selectedBox,
      accent: getComputedStyle(element).color,
    });
  });

  const pointOf = (event: React.PointerEvent | React.MouseEvent): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
  };

  const handleAt = (box: Box, point: Point): "scale" | "rotate" | null => {
    const local = toBoxSpace(box, point);
    const reach = HANDLE / scale;
    if (
      Math.abs(local.x) < reach &&
      Math.abs(local.y + box.height / 2 + ROTATE_REACH / scale) < reach
    ) {
      return "rotate";
    }
    return Math.abs(Math.abs(local.x) - box.width / 2) < reach &&
      Math.abs(Math.abs(local.y) - box.height / 2) < reach
      ? "scale"
      : null;
  };

  const layerAt = (point: Point) =>
    slide?.layers.toReversed().find((layer) => boxContains(boxOf(layer), point)) ?? null;

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (slide === undefined || event.button !== 0) return;
    const point = pointOf(event);
    const handle = selectedBox === null ? null : handleAt(selectedBox, point);
    const layer = handle === null ? layerAt(point) : selectedLayer;
    const mode =
      handle ?? (layer !== null ? "move" : slide.background.photo !== null ? "background" : null);
    props.onSelect(layer?.id ?? (mode === "background" ? "background" : null));
    if (mode === null || !props.canEdit) return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // The pointer is already gone (a cancelled touch); the drag ends on its own.
    }
    setDrag({ mode, start: point, layer, moved: false });
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (drag === null || slide === undefined) return;
    const point = pointOf(event);
    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    // A click that wobbles a pixel is still a click.
    if (!drag.moved && Math.hypot(dx, dy) * scale < 3) return;
    if (!drag.moved) setDrag({ ...drag, moved: true });
    const original = props.document.slides[props.slideIndex];
    if (original === undefined) return;
    if (drag.mode === "background") {
      const photo = original.background.photo;
      if (photo === null) return;
      setDraft({
        kind: "setBackground",
        slide: original.id,
        photo: {
          src: photo.src,
          offsetX: Math.round(snapTo(photo.offsetX + dx, 0)),
          offsetY: Math.round(snapTo(photo.offsetY + dy, 0)),
        },
      });
      return;
    }
    const { layer } = drag;
    if (layer === null) return;
    const centre = { x: layer.x, y: layer.y };
    const changes =
      drag.mode === "move"
        ? {
            x: Math.round(snapTo(layer.x + dx, size.width / 2)),
            y: Math.round(snapTo(layer.y + dy, size.height / 2)),
          }
        : drag.mode === "scale"
          ? scaleLayer(
              layer,
              Math.hypot(point.x - centre.x, point.y - centre.y) /
                Math.max(1, Math.hypot(drag.start.x - centre.x, drag.start.y - centre.y)),
            )
          : (() => {
              const turned =
                layer.rotation +
                ((Math.atan2(point.y - centre.y, point.x - centre.x) -
                  Math.atan2(drag.start.y - centre.y, drag.start.x - centre.x)) *
                  180) /
                  Math.PI;
              const wrapped = ((((turned + 180) % 360) + 360) % 360) - 180;
              const nearest = Math.round(wrapped / 45) * 45;
              return {
                rotation:
                  Math.abs(wrapped - nearest) < ROTATION_SNAP ? nearest : Math.round(wrapped),
              };
            })();
    setDraft({ kind: "updateLayer", slide: original.id, layerId: layer.id, layer: changes });
  };

  const onPointerUp = () => {
    if (draft !== null) props.onEdit([draft]);
    setDraft(null);
    setDrag(null);
  };

  const commitTyping = (text: string) => {
    if (
      slide !== undefined &&
      typed !== undefined &&
      typed.kind === "text" &&
      text !== typed.text
    ) {
      props.onEdit([{ kind: "updateLayer", slide: slide.id, layerId: typed.id, layer: { text } }]);
    }
    setTyping(null);
  };

  const typedBox = typed === undefined ? null : boxOf(typed);
  return (
    <div
      ref={well}
      className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center bg-viewer"
    >
      <div className="relative" style={{ width: size.width * scale, height: size.height * scale }}>
        <canvas
          ref={canvas}
          aria-label={`Slide ${props.slideIndex + 1}`}
          className="block size-full touch-none text-primary shadow-lg"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onDoubleClick={(event) => {
            const layer = layerAt(pointOf(event));
            if (props.canEdit && layer?.kind === "text") setTyping(layer.id);
          }}
        />
        {typed !== undefined && typed.kind === "text" && typedBox !== null ? (
          <textarea
            // Mounted fresh per layer, so the words it starts with are that layer's.
            key={typed.id}
            aria-label="Text"
            autoFocus
            defaultValue={typed.text}
            className="absolute resize-none overflow-hidden bg-transparent p-0 outline-1 outline-primary"
            style={{
              left: (typedBox.cx - typedBox.width / 2) * scale,
              top: (typedBox.cy - typedBox.height / 2) * scale,
              width: typedBox.width * scale,
              minHeight: typedBox.height * scale,
              transform: `rotate(${typed.rotation}deg)`,
              font: `${typed.weight} ${typed.size * scale}px ${CAROUSEL_FONT_STACKS[typed.font]}`,
              lineHeight: typed.lineHeight,
              color: typed.color,
              textAlign: typed.align,
            }}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={(event) => commitTyping(event.currentTarget.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") setTyping(null);
              else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                commitTyping(event.currentTarget.value);
              }
            }}
          />
        ) : null}
      </div>
    </div>
  );
}
