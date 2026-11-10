import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentIdentificationMode } from "@t3tools/contracts";

import { APP_STAGE_LABEL, SHOW_STAGE_ARTWORK } from "../branding";
import skyArtUrl from "./brand/stellar-sky.png";
import { resolveServerBackedAppStageLabel } from "../branding.logic";
import { primaryServerConfigAtom } from "../state/server";

export type SidebarStageBackdropVariant = "nightly" | "dev";
export type EnvironmentIdentificationPillLabel = "Dev" | "Nightly";

export function resolveSidebarStageBackdropVariant(
  stageLabel: string,
  mode: EnvironmentIdentificationMode = "artwork",
): SidebarStageBackdropVariant | null {
  if (!SHOW_STAGE_ARTWORK) return null;
  if (mode === "nightly-artwork") return "nightly";
  if (mode === "dev-artwork") return "dev";
  if (mode !== "artwork") return null;
  const normalized = stageLabel.trim().toLowerCase();
  if (normalized === "nightly") return "nightly";
  if (normalized === "dev") return "dev";
  return null;
}

export function resolveEnvironmentIdentificationPillLabel(
  stageLabel: string,
): EnvironmentIdentificationPillLabel | null {
  const normalized = stageLabel.trim().toLowerCase();
  if (normalized === "dev") return "Dev";
  if (normalized === "nightly") return "Nightly";
  return null;
}

export function useEnvironmentStageLabel(): string {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;

  return resolveServerBackedAppStageLabel({
    primaryServerVersion,
    fallbackStageLabel: APP_STAGE_LABEL,
  });
}

export function useSidebarStageBackdropVariant(
  mode: EnvironmentIdentificationMode,
): SidebarStageBackdropVariant | null {
  return resolveSidebarStageBackdropVariant(useEnvironmentStageLabel(), mode);
}

export function SidebarStageBackdrop({ variant }: { variant: SidebarStageBackdropVariant }) {
  return (
    <div
      aria-hidden
      className="sidebar-stage-backdrop pointer-events-none absolute inset-x-0 top-0 z-0 h-20 select-none overflow-hidden"
    >
      <StageBackdropArt variant={variant} />
    </div>
  );
}

// A dithered moon in blue and red space, drawn at one dot per CSS pixel; `pixelated` keeps the
// dots crisp. The moon sits about 260px in, inside the sidebar's usual width.
function StageBackdropArt({ variant }: { variant: SidebarStageBackdropVariant }) {
  return (
    <img
      data-stage-art={variant}
      alt=""
      src={skyArtUrl}
      draggable={false}
      className="h-full w-auto max-w-none object-cover object-left [image-rendering:pixelated]"
    />
  );
}

export function StageBackdropButtonArt({ variant }: { variant: SidebarStageBackdropVariant }) {
  return (
    <img
      data-stage-art={variant}
      alt=""
      src={skyArtUrl}
      draggable={false}
      className="size-full object-cover object-[54%_50%] [image-rendering:pixelated]"
    />
  );
}
