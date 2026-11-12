import type { CarouselDocument } from "@t3tools/contracts";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useRef, useState } from "react";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { cn } from "~/lib/utils";

import type { PhotoLookup } from "./drawSlide";
import { SlidePicture } from "./SlideStrip";

// A phone's feed column, near enough to judge text size by.
const WIDTH = 340;

/** The post as the feed shows it: swipe through the slides, with the counter, dots and caption. */
export function PostPreview(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly document: CarouselDocument;
  readonly photoOf: PhotoLookup;
  readonly title: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const count = props.document.slides.length;
  const shown = Math.min(index, count - 1);
  const go = (to: number) =>
    track.current?.scrollTo({ left: Math.max(0, Math.min(count - 1, to)) * WIDTH });
  const arrow =
    "absolute top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:hidden";
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Preview as post</DialogTitle>
          <DialogDescription>
            Swipe or use the arrows, as in the feed. These are the pictures that are exported.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div
            className="mx-auto overflow-hidden rounded-xl border border-border/60 bg-background"
            style={{ width: WIDTH }}
          >
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="size-7 rounded-full bg-muted" />
              <span className="min-w-0 truncate text-sm font-semibold">{props.title}</span>
            </div>
            <div className="relative">
              <div
                ref={track}
                className="flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none]"
                onScroll={(event) => setIndex(Math.round(event.currentTarget.scrollLeft / WIDTH))}
              >
                {props.document.slides.map((slide, slideIndex) => (
                  <div key={slide.id} className="shrink-0 snap-center">
                    <SlidePicture
                      document={props.document}
                      index={slideIndex}
                      photoOf={props.photoOf}
                      width={WIDTH}
                    />
                  </div>
                ))}
              </div>
              <span className="absolute top-2.5 right-2.5 rounded-full bg-black/60 px-2 py-0.5 text-2xs text-white tabular-nums">
                {shown + 1}/{count}
              </span>
              <button
                type="button"
                aria-label="Previous slide"
                disabled={shown === 0}
                className={cn(arrow, "left-2")}
                onClick={() => go(shown - 1)}
              >
                <ChevronLeftIcon className="size-4" />
              </button>
              <button
                type="button"
                aria-label="Next slide"
                disabled={shown >= count - 1}
                className={cn(arrow, "right-2")}
                onClick={() => go(shown + 1)}
              >
                <ChevronRightIcon className="size-4" />
              </button>
            </div>
            <div className="flex justify-center gap-1 py-2" aria-hidden>
              {props.document.slides.map((slide, slideIndex) => (
                <span
                  key={slide.id}
                  className={cn(
                    "size-1.5 rounded-full",
                    slideIndex === shown ? "bg-primary" : "bg-muted-foreground/40",
                  )}
                />
              ))}
            </div>
            <p className="max-h-32 overflow-y-auto px-3 pb-3 text-sm whitespace-pre-wrap">
              {props.document.caption === "" ? (
                <span className="text-muted-foreground">No caption yet.</span>
              ) : (
                props.document.caption
              )}
            </p>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
