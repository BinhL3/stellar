import { useEffect, useRef } from "react";

import limbArtUrl from "~/components/brand/stellar-limb.png";
import limbToneUrl from "~/components/brand/stellar-limb-tone.jpg";

import { cn } from "~/lib/utils";

import { startLimbRipples } from "./limbRipples";

// The art is 720x450 with its horizon 60% down. At 125% of the pane's height the horizon sits at
// about 75%, below the new-thread screen's centred heading and composer. In a thread it goes
// lower (90%) and dimmer, so messages read over space rather than the planet's surface.
const HERO_HEIGHT_RATIO = 1.25;
const AMBIENT_HEIGHT_RATIO = 1.5;
/**
 * The new-thread screen's backdrop: the seven Landsat scenes that spell STELLAR, wrapped onto a
 * planet's limb under an orange-blue atmosphere, ordered-dithered; the pointer stirs it like
 * water, re-dithering the dots as waves pass (see `limbRipples`).
 * It is dark art, so it shows only in the dark theme, where text over it stays readable.
 */
export function DraftHeroBackdrop(props: { readonly ambient?: boolean }) {
  const ambient = props.ambient === true;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Runs the canvas ripple animation and its pointer listener, outside React.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let stop: () => void = () => undefined;
    let cancelled = false;
    const load = (url: string) => {
      const image = new Image();
      image.src = url;
      return image.decode().then(() => image);
    };
    void load(limbArtUrl).then(
      (still) => {
        if (cancelled) return;
        canvas.getContext("2d")?.drawImage(still, 0, 0, canvas.width, canvas.height);
        // Ripples belong to the empty new-thread screen; behind a conversation they'd distract.
        if (ambient || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        // The smooth image is only needed once the water moves, so it loads second.
        void load(limbToneUrl).then(
          (tone) => {
            if (!cancelled) stop = startLimbRipples({ canvas, still, tone });
          },
          () => undefined,
        );
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      stop();
    };
  }, [ambient]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 hidden overflow-hidden bg-black dark:block"
    >
      <canvas
        ref={canvasRef}
        width={720}
        height={450}
        className={cn(
          "absolute inset-x-0 top-0 w-full object-cover object-top [image-rendering:pixelated]",
          ambient && "opacity-55",
        )}
        style={{ height: `${(ambient ? AMBIENT_HEIGHT_RATIO : HERO_HEIGHT_RATIO) * 100}%` }}
      />
      <div
        className={cn(
          "absolute inset-0 bg-linear-to-b",
          ambient
            ? "from-black/70 via-black/45 to-black/20"
            : "from-black/40 via-transparent to-black/50",
        )}
      />
      {ambient ? null : (
        <p className="absolute right-3 bottom-2 text-3xs text-white/50">
          Landsat imagery: NASA and USGS
        </p>
      )}
    </div>
  );
}
