import { useEffect, useRef, useSyncExternalStore } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";

import type { BackdropVariant } from "./backdropEngine";
import { resolveBackdropValues } from "./backdropTreatments";

// Full strength where there is nothing to read. Behind text a solid patch of the brightest
// accent must still leave muted text at 4.5:1, which a fifth does in every built-in palette.
const VARIANT_OPACITY: Readonly<Record<BackdropVariant, number>> = {
  hero: 1,
  preview: 1,
  strip: 0.85,
  ambient: 0.2,
};

const SETTING_SETTLE_MS = 160;

interface Stage {
  readonly element: HTMLElement;
  readonly variant: BackdropVariant;
}

// The pane-filling backdrops, latest last. The sidebar continues the latest one's picture.
let stages: ReadonlyArray<Stage> = [];
const stageListeners = new Set<() => void>();
const subscribeStage = (listener: () => void) => {
  stageListeners.add(listener);
  return () => void stageListeners.delete(listener);
};
const currentStage = () => stages.at(-1) ?? null;
function registerStage(stage: Stage): () => void {
  stages = [...stages, stage];
  for (const notify of stageListeners) notify();
  return () => {
    stages = stages.filter((entry) => entry !== stage);
    for (const notify of stageListeners) notify();
  };
}

// The scenes and printing code stay out of the first-paint bundle.
const loadEngine = () => import("./backdropEngine");

/**
 * The decorative surface behind the app: the active theme's scene, printed in that theme's inks
 * with the treatment chosen in Settings → Appearance. Every decorative surface renders this, so
 * the theme and the one setting decide how all of them look. It fills its nearest positioned
 * ancestor, behind that ancestor's content.
 */
export function Backdrop(props: {
  readonly variant: BackdropVariant;
  readonly className?: string;
  /**
   * `fill`: this backdrop fills the main pane, and the sidebar continues its picture.
   * `continue`: this surface shows the part of that picture that falls on it, faded for text,
   * or a slice of a window-wide `variant` picture when no pane is filled.
   */
  readonly stage?: "fill" | "continue";
}) {
  const filled = useSyncExternalStore(subscribeStage, currentStage);
  const continues = props.stage === "continue";
  const variant = continues ? (filled?.variant ?? props.variant) : props.variant;
  const stageElement = continues ? (filled?.element ?? document.documentElement) : undefined;
  const opacity = VARIANT_OPACITY[continues ? "ambient" : variant];
  const fills = props.stage === "fill";
  const boxRef = useRef<HTMLDivElement | null>(null);
  const treatment = useClientSettings((settings) => settings.backdropTreatment);
  const strength = useClientSettings((settings) => settings.backdropStrength);
  const params = useClientSettings((settings) => settings.backdropParams);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawnRef = useRef(false);
  const visible = treatment !== "none" && strength > 0;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Publishes this pane to the module-level stage registry the sidebar reads.
  useEffect(() => {
    const element = boxRef.current;
    if (!fills || element === null) return;
    return registerStage({ element, variant });
  }, [fills, variant]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Draws on a canvas and listens for resize, theme and pointer changes, outside React.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || !visible) return;
    let stop: () => void = () => undefined;
    let cancelled = false;
    // Until the engine has loaded, the plain palette shows.
    const mount = () =>
      void loadEngine().then(
        ({ mountBackdrop }) => {
          if (cancelled) return;
          stop = mountBackdrop(canvas, {
            variant,
            treatment,
            values: resolveBackdropValues(treatment, params),
            ...(stageElement ? { stage: stageElement } : {}),
          });
        },
        () => undefined,
      );
    // A slider drag in Settings redraws its preview at once; full-size surfaces behind the
    // dialog wait for the drag to rest and keep their last picture meanwhile.
    const wait = drawnRef.current && variant !== "preview" ? SETTING_SETTLE_MS : 0;
    drawnRef.current = true;
    const timer = window.setTimeout(mount, wait);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      stop();
    };
  }, [variant, treatment, params, visible, stageElement]);

  return (
    <div
      ref={boxRef}
      aria-hidden="true"
      data-backdrop={variant}
      className={cn(
        "pointer-events-none absolute inset-0 -z-10 overflow-hidden bg-background",
        props.className,
      )}
    >
      {visible ? (
        <canvas
          ref={canvasRef}
          className="absolute inset-0 size-full"
          style={{ opacity: (opacity * strength) / 100 }}
        />
      ) : null}
    </div>
  );
}
