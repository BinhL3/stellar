import { useEffect, useRef } from "react";

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
}) {
  const { variant } = props;
  const treatment = useClientSettings((settings) => settings.backdropTreatment);
  const strength = useClientSettings((settings) => settings.backdropStrength);
  const params = useClientSettings((settings) => settings.backdropParams);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawnRef = useRef(false);
  const visible = treatment !== "none" && strength > 0;

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
  }, [variant, treatment, params, visible]);

  return (
    <div
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
          style={{ opacity: (VARIANT_OPACITY[variant] * strength) / 100 }}
        />
      ) : null}
    </div>
  );
}
