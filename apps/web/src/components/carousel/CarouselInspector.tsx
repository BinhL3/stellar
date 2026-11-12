import type {
  CarouselDocument,
  CarouselEdit,
  CarouselFont,
  CarouselLayer,
  CarouselSlide,
} from "@t3tools/contracts";
import { coverCrop, MAX_ALT_TEXT, MAX_CAPTION } from "@t3tools/timeline/carousel";
import {
  AlignCenterIcon,
  AlignLeftIcon,
  AlignRightIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  ImageIcon,
  Trash2Icon,
  TypeIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

import { Button } from "~/components/ui/button";
import { DraftInput } from "~/components/ui/draft-input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { cn } from "~/lib/utils";

import type { PhotoLookup } from "./drawSlide";
import type { Selection } from "./SlideCanvas";

type LayerChanges = NonNullable<CarouselEdit["layer"]>;

const FONTS: ReadonlyArray<readonly [CarouselFont, string]> = [
  ["sans", "Sans"],
  ["serif", "Serif"],
  ["rounded", "Rounded"],
  ["display", "Display"],
  ["mono", "Mono"],
];

const NO_PHOTO = "none";
const fileName = (src: string) => src.slice(src.lastIndexOf("/") + 1);

/** A colour new text can be read in: white with a shadow over a photo or a dark colour. */
const readableText = (slide: CarouselSlide): LayerChanges => {
  if (slide.background.photo !== null) {
    return { color: "#ffffff", shadow: { color: "#00000099", blur: 18, offsetX: 0, offsetY: 6 } };
  }
  const value = Number.parseInt(slide.background.color.slice(1, 7), 16);
  const luminance =
    0.2126 * ((value >> 16) & 255) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255);
  return { color: luminance < 140 ? "#ffffff" : "#111111" };
};

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-b border-border/60 p-3">
      <h3 className="text-2xs font-semibold tracking-wide text-muted-foreground uppercase">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

function Row(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-2 text-xs">
      <span className="shrink-0 text-muted-foreground">{props.label}</span>
      {props.children}
    </div>
  );
}

function NumberBox(props: {
  readonly label: string;
  readonly value: number;
  readonly disabled: boolean;
  readonly onCommit: (value: number) => void;
}) {
  return (
    <div className="w-20">
      <DraftInput
        size="compact"
        aria-label={props.label}
        inputMode="decimal"
        disabled={props.disabled}
        value={String(Math.round(props.value * 100) / 100)}
        onCommit={(next) => {
          const value = Number(next);
          if (next.trim() !== "" && Number.isFinite(value)) props.onCommit(value);
        }}
      />
    </div>
  );
}

function ColorBox(props: {
  readonly label: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly onCommit: (value: string) => void;
}) {
  const swatch = useRef<HTMLInputElement>(null);
  const { onCommit } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- React's onChange fires on every move in the colour picker; the native change event fires once, when a colour is chosen.
  useEffect(() => {
    const element = swatch.current;
    if (element === null) return;
    const chosen = () => onCommit(element.value);
    element.addEventListener("change", chosen);
    return () => element.removeEventListener("change", chosen);
  });
  return (
    <span className="flex items-center gap-1.5">
      <input
        ref={swatch}
        // The picker is uncontrolled so it can be dragged freely; a new value remounts it.
        key={props.value}
        type="color"
        aria-label={props.label}
        disabled={props.disabled}
        defaultValue={props.value.slice(0, 7)}
        className="size-6 cursor-pointer rounded border border-border bg-transparent p-0"
      />
      <span className="w-20">
        <DraftInput
          size="compact"
          aria-label={`${props.label} hex`}
          disabled={props.disabled}
          value={props.value}
          onCommit={(next) => {
            const value = next.trim().startsWith("#") ? next.trim() : `#${next.trim()}`;
            if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value)) props.onCommit(value);
          }}
        />
      </span>
    </span>
  );
}

function PhotoSelect(props: {
  readonly label: string;
  readonly document: CarouselDocument;
  readonly value: string | null;
  readonly allowNone: boolean;
  readonly disabled: boolean;
  readonly onChange: (src: string | null) => void;
}) {
  return (
    <Select
      value={props.value ?? NO_PHOTO}
      disabled={props.disabled}
      onValueChange={(value) => props.onChange(value === NO_PHOTO || value === null ? null : value)}
    >
      <SelectTrigger size="sm" aria-label={props.label}>
        <SelectValue>
          {(value: string) => (value === NO_PHOTO ? "None" : fileName(value))}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {props.allowNone ? <SelectItem value={NO_PHOTO}>None</SelectItem> : null}
        {props.document.photos.map((photo) => (
          <SelectItem key={photo.src} value={photo.src}>
            {fileName(photo.src)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** Words typed here are committed when the field is left, so each edit is one undo step. */
function TextBox(props: {
  readonly label: string;
  readonly value: string;
  readonly rows: number;
  readonly disabled: boolean;
  readonly placeholder?: string;
  readonly onCommit: (value: string) => void;
}) {
  return (
    <Textarea
      // Uncontrolled while typing; a value changed elsewhere remounts it.
      key={props.value}
      size="sm"
      rows={props.rows}
      aria-label={props.label}
      disabled={props.disabled}
      defaultValue={props.value}
      placeholder={props.placeholder}
      onBlur={(event) => {
        if (event.currentTarget.value !== props.value) props.onCommit(event.currentTarget.value);
      }}
    />
  );
}

function PhotoThumb(props: { readonly bitmap: ImageBitmap | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const { bitmap } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- A canvas is drawn imperatively, from a bitmap decoded outside React.
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context || bitmap === null) return;
    const crop = coverCrop(element, bitmap);
    context.drawImage(
      bitmap,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      element.width,
      element.height,
    );
  }, [bitmap]);
  return <canvas ref={canvas} width={112} height={112} className="block size-14 bg-muted" />;
}

function LayerFields(props: {
  readonly document: CarouselDocument;
  readonly layer: CarouselLayer;
  readonly disabled: boolean;
  readonly change: (changes: LayerChanges) => void;
}) {
  const { layer, change, disabled } = props;
  const placed = (
    <>
      <Row label="Position">
        <span className="flex gap-1">
          <NumberBox
            label="X"
            value={layer.x}
            disabled={disabled}
            onCommit={(x) => change({ x })}
          />
          <NumberBox
            label="Y"
            value={layer.y}
            disabled={disabled}
            onCommit={(y) => change({ y })}
          />
        </span>
      </Row>
      <Row label="Rotation">
        <NumberBox
          label="Rotation"
          value={layer.rotation}
          disabled={disabled}
          onCommit={(rotation) => change({ rotation })}
        />
      </Row>
    </>
  );
  if (layer.kind === "photo") {
    return (
      <>
        <Row label="Photo">
          <PhotoSelect
            label="Photo"
            document={props.document}
            value={layer.src}
            allowNone={false}
            disabled={disabled}
            onChange={(src) => (src === null ? undefined : change({ src }))}
          />
        </Row>
        {placed}
        <Row label="Size">
          <span className="flex gap-1">
            <NumberBox
              label="Width"
              value={layer.width}
              disabled={disabled}
              onCommit={(width) => change({ width })}
            />
            <NumberBox
              label="Height"
              value={layer.height}
              disabled={disabled}
              onCommit={(height) => change({ height })}
            />
          </span>
        </Row>
        <Row label="Corner radius">
          <NumberBox
            label="Corner radius"
            value={layer.radius}
            disabled={disabled}
            onCommit={(radius) => change({ radius })}
          />
        </Row>
        <Row label="Opacity %">
          <NumberBox
            label="Opacity"
            value={layer.opacity * 100}
            disabled={disabled}
            onCommit={(percent) => change({ opacity: percent / 100 })}
          />
        </Row>
        <Row label="Runs across slides">
          <NumberBox
            label="Slides spanned"
            value={layer.span}
            disabled={disabled}
            onCommit={(span) => change({ span: Math.round(span) })}
          />
        </Row>
      </>
    );
  }
  return (
    <>
      <TextBox
        label="Text"
        value={layer.text}
        rows={3}
        disabled={disabled}
        onCommit={(text) => change({ text })}
      />
      <Row label="Font">
        <Select
          value={layer.font}
          disabled={disabled}
          onValueChange={(font) => (font === null ? undefined : change({ font }))}
        >
          <SelectTrigger size="sm" aria-label="Font">
            <SelectValue>
              {(value: CarouselFont) => FONTS.find(([font]) => font === value)?.[1]}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {FONTS.map(([font, label]) => (
              <SelectItem key={font} value={font}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </Row>
      <Row label="Size">
        <NumberBox
          label="Font size"
          value={layer.size}
          disabled={disabled}
          onCommit={(size) => change({ size })}
        />
      </Row>
      <Row label="Bold">
        <Switch
          size="sm"
          aria-label="Bold"
          disabled={disabled}
          checked={layer.weight >= 600}
          onCheckedChange={(bold) => change({ weight: bold ? 700 : 400 })}
        />
      </Row>
      <Row label="Colour">
        <ColorBox
          label="Text colour"
          value={layer.color}
          disabled={disabled}
          onCommit={(color) => change({ color })}
        />
      </Row>
      <Row label="Align">
        <ToggleGroup
          aria-label="Align"
          disabled={disabled}
          value={[layer.align]}
          onValueChange={([align]) =>
            align === "left" || align === "center" || align === "right"
              ? change({ align })
              : undefined
          }
        >
          <Toggle value="left" aria-label="Left">
            <AlignLeftIcon />
          </Toggle>
          <Toggle value="center" aria-label="Centre">
            <AlignCenterIcon />
          </Toggle>
          <Toggle value="right" aria-label="Right">
            <AlignRightIcon />
          </Toggle>
        </ToggleGroup>
      </Row>
      <Row label="Wrap width">
        <NumberBox
          label="Wrap width"
          value={layer.maxWidth}
          disabled={disabled}
          onCommit={(maxWidth) => change({ maxWidth })}
        />
      </Row>
      <Row label="Line height">
        <NumberBox
          label="Line height"
          value={layer.lineHeight}
          disabled={disabled}
          onCommit={(lineHeight) => change({ lineHeight })}
        />
      </Row>
      {placed}
      <Row label="Outline">
        <span className="flex items-center gap-1.5">
          {layer.stroke === null ? null : (
            <>
              <ColorBox
                label="Outline colour"
                value={layer.stroke.color}
                disabled={disabled}
                onCommit={(color) => change({ stroke: { color, width: layer.stroke?.width ?? 6 } })}
              />
              <NumberBox
                label="Outline width"
                value={layer.stroke.width}
                disabled={disabled}
                onCommit={(width) =>
                  change({ stroke: { color: layer.stroke?.color ?? "#000000", width } })
                }
              />
            </>
          )}
          <Switch
            size="sm"
            aria-label="Outline"
            disabled={disabled}
            checked={layer.stroke !== null}
            onCheckedChange={(on) => change({ stroke: on ? { color: "#000000", width: 6 } : null })}
          />
        </span>
      </Row>
      <Row label="Shadow">
        <Switch
          size="sm"
          aria-label="Shadow"
          disabled={disabled}
          checked={layer.shadow !== null}
          onCheckedChange={(on) =>
            change({ shadow: on ? { color: "#00000099", blur: 18, offsetX: 0, offsetY: 6 } : null })
          }
        />
      </Row>
      <Row label="Box">
        <span className="flex items-center gap-1.5">
          {layer.box === null ? null : (
            <ColorBox
              label="Box colour"
              value={layer.box.color}
              disabled={disabled}
              onCommit={(color) =>
                change({
                  box: {
                    color,
                    padding: layer.box?.padding ?? 24,
                    radius: layer.box?.radius ?? 16,
                  },
                })
              }
            />
          )}
          <Switch
            size="sm"
            aria-label="Box"
            disabled={disabled}
            checked={layer.box !== null}
            onCheckedChange={(on) =>
              change({ box: on ? { color: "#000000", padding: 24, radius: 16 } : null })
            }
          />
        </span>
      </Row>
    </>
  );
}

/** Everything about the selection that isn't a drag: the layer, the slide and the post. */
export function CarouselInspector(props: {
  readonly document: CarouselDocument;
  readonly slide: CarouselSlide;
  readonly selection: Selection;
  readonly onSelect: (selection: Selection) => void;
  readonly canEdit: boolean;
  readonly onEdit: (edits: ReadonlyArray<CarouselEdit>) => CarouselDocument | null;
  readonly photoOf: PhotoLookup;
  readonly pickedPhoto: string | null;
  readonly onPickPhoto: (src: string | null) => void;
}) {
  const { document, slide, onEdit } = props;
  const disabled = !props.canEdit;
  const layerIndex = slide.layers.findIndex((other) => other.id === props.selection);
  const layer = slide.layers[layerIndex];
  const background = slide.background;
  const addLayer = (input: LayerChanges) => {
    const next = onEdit([{ kind: "addLayer", slide: slide.id, layer: input }]);
    const added = next?.slides.find((other) => other.id === slide.id)?.layers.at(-1);
    if (added !== undefined) props.onSelect(added.id);
  };
  const used = new Set(
    document.slides.flatMap((other) => [
      ...(other.background.photo === null ? [] : [other.background.photo.src]),
      ...other.layers.flatMap((each) => (each.kind === "photo" ? [each.src] : [])),
    ]),
  );
  const unused = document.photos.filter((photo) => !used.has(photo.src));
  return (
    <div className="flex min-h-0 flex-col overflow-y-auto">
      <Section title="Add">
        <div className="flex flex-wrap gap-1.5">
          <Button
            size="compact"
            variant="outline"
            disabled={disabled}
            onClick={() => addLayer({ kind: "text", text: "Your text", ...readableText(slide) })}
          >
            <TypeIcon />
            Text
          </Button>
          <Button
            size="compact"
            variant="outline"
            disabled={disabled || props.pickedPhoto === null}
            onClick={() =>
              props.pickedPhoto === null
                ? undefined
                : addLayer({ kind: "photo", src: props.pickedPhoto })
            }
          >
            <ImageIcon />
            Photo layer
          </Button>
          <Button
            size="compact"
            variant="outline"
            disabled={disabled || props.pickedPhoto === null}
            onClick={() =>
              props.pickedPhoto === null
                ? undefined
                : onEdit([
                    { kind: "setBackground", slide: slide.id, photo: { src: props.pickedPhoto } },
                  ])
            }
          >
            Set as background
          </Button>
        </div>
        {document.photos.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Add photos to start. Pick one here, then make it a slide, a background or a layer.
          </p>
        ) : (
          <ul className="flex flex-wrap gap-1.5" aria-label="Photos">
            {document.photos.map((photo) => (
              <li key={photo.src}>
                <button
                  type="button"
                  aria-label={fileName(photo.src)}
                  aria-pressed={props.pickedPhoto === photo.src}
                  onClick={() =>
                    props.onPickPhoto(props.pickedPhoto === photo.src ? null : photo.src)
                  }
                  className={cn(
                    "block overflow-hidden rounded-md border border-border/60 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    props.pickedPhoto === photo.src && "ring-2 ring-primary",
                  )}
                >
                  <PhotoThumb bitmap={props.photoOf(photo.src)} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {unused.length > 1 && props.canEdit ? (
          <div>
            <Button
              size="compact"
              variant="ghost"
              onClick={() =>
                onEdit(
                  unused.map((photo) => ({ kind: "addSlide", layout: "photo", src: photo.src })),
                )
              }
            >
              Make a slide from each of the {unused.length} unused photos
            </Button>
          </div>
        ) : null}
      </Section>
      {layer === undefined ? (
        <Section title="Background">
          <Row label="Colour">
            <ColorBox
              label="Background colour"
              value={background.color}
              disabled={disabled}
              onCommit={(color) => onEdit([{ kind: "setBackground", slide: slide.id, color }])}
            />
          </Row>
          <Row label="Photo">
            <PhotoSelect
              label="Background photo"
              document={document}
              value={background.photo?.src ?? null}
              allowNone
              disabled={disabled}
              onChange={(src) =>
                onEdit([
                  { kind: "setBackground", slide: slide.id, photo: src === null ? null : { src } },
                ])
              }
            />
          </Row>
          {background.photo === null ? null : (
            <>
              <Row label="Fit">
                <ToggleGroup
                  aria-label="Fit"
                  disabled={disabled}
                  value={[background.photo.fit]}
                  onValueChange={([fit]) =>
                    background.photo !== null && (fit === "fill" || fit === "fit")
                      ? onEdit([
                          {
                            kind: "setBackground",
                            slide: slide.id,
                            photo: { src: background.photo.src, fit, offsetX: 0, offsetY: 0 },
                          },
                        ])
                      : undefined
                  }
                >
                  <Toggle value="fill">Fill</Toggle>
                  <Toggle value="fit">Fit</Toggle>
                </ToggleGroup>
              </Row>
              <Row label="Zoom %">
                <NumberBox
                  label="Zoom"
                  value={background.photo.scale * 100}
                  disabled={disabled}
                  onCommit={(percent) =>
                    background.photo === null
                      ? undefined
                      : onEdit([
                          {
                            kind: "setBackground",
                            slide: slide.id,
                            photo: { src: background.photo.src, scale: percent / 100 },
                          },
                        ])
                  }
                />
              </Row>
              <Row label="Rotation">
                <NumberBox
                  label="Background rotation"
                  value={background.photo.rotation}
                  disabled={disabled}
                  onCommit={(rotation) =>
                    background.photo === null
                      ? undefined
                      : onEdit([
                          {
                            kind: "setBackground",
                            slide: slide.id,
                            photo: { src: background.photo.src, rotation },
                          },
                        ])
                  }
                />
              </Row>
              <p className="text-2xs text-muted-foreground">
                Drag the photo on the slide to move it.
              </p>
            </>
          )}
        </Section>
      ) : (
        <Section title={layer.kind === "text" ? "Text" : "Photo"}>
          <LayerFields
            document={document}
            layer={layer}
            disabled={disabled}
            change={(changes) =>
              onEdit([{ kind: "updateLayer", slide: slide.id, layerId: layer.id, layer: changes }])
            }
          />
          <div className="flex items-center gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Bring forward"
              disabled={disabled || layerIndex === slide.layers.length - 1}
              onClick={() =>
                onEdit([
                  { kind: "moveLayer", slide: slide.id, layerId: layer.id, index: layerIndex + 1 },
                ])
              }
            >
              <ArrowUpIcon />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Send backward"
              disabled={disabled || layerIndex === 0}
              onClick={() =>
                onEdit([
                  { kind: "moveLayer", slide: slide.id, layerId: layer.id, index: layerIndex - 1 },
                ])
              }
            >
              <ArrowDownIcon />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost-destructive"
              aria-label="Delete layer"
              disabled={disabled}
              onClick={() => {
                onEdit([{ kind: "removeLayer", slide: slide.id, layerId: layer.id }]);
                props.onSelect(null);
              }}
            >
              <Trash2Icon />
            </Button>
          </div>
        </Section>
      )}
      <Section title="Alt text for this slide">
        <TextBox
          label="Alt text"
          value={slide.altText}
          rows={2}
          disabled={disabled}
          placeholder="What the slide shows, for people who can't see it"
          onCommit={(text) => onEdit([{ kind: "setAltText", slide: slide.id, text }])}
        />
        <p className="text-2xs text-muted-foreground tabular-nums">
          {slide.altText.length} / {MAX_ALT_TEXT}
        </p>
      </Section>
      <Section title="Caption">
        <TextBox
          label="Caption"
          value={document.caption}
          rows={5}
          disabled={disabled}
          placeholder="The post's caption"
          onCommit={(text) => onEdit([{ kind: "setCaption", text }])}
        />
        <p
          className={cn(
            "text-2xs tabular-nums",
            document.caption.length > MAX_CAPTION ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {document.caption.length} / {MAX_CAPTION}
        </p>
      </Section>
    </div>
  );
}
