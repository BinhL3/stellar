import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentIdentificationMode } from "@t3tools/contracts";

import { APP_STAGE_LABEL, SHOW_STAGE_ARTWORK } from "../branding";
import { Backdrop } from "./backdrop/Backdrop";
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

/** The dev and nightly channels show a strip of the theme's scene across the sidebar header. */
export function SidebarStageBackdrop({ variant }: { variant: SidebarStageBackdropVariant }) {
  return (
    <div
      aria-hidden
      data-stage-art={variant}
      className="sidebar-stage-backdrop pointer-events-none absolute inset-x-0 top-0 isolate z-0 h-20 select-none overflow-hidden"
    >
      <Backdrop variant="strip" className="bg-transparent" />
    </div>
  );
}

export function StageBackdropButtonArt({ variant }: { variant: SidebarStageBackdropVariant }) {
  return (
    <span data-stage-art={variant} className="absolute inset-0 isolate block">
      <Backdrop variant="strip" className="bg-transparent" />
    </span>
  );
}
