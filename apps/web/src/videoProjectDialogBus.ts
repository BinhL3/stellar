import type { EnvironmentId } from "@t3tools/contracts";
import { create } from "zustand";

import { openCommandPalette } from "./commandPaletteBus";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { readPrimaryEnvironmentId } from "./state/environments";
import { environmentSummaries } from "./state/presentation";

export const useNewVideoProjectRequest = create<{
  readonly environmentId: EnvironmentId | null;
  readonly open: boolean;
  readonly session: number;
}>(() => ({ environmentId: null, open: false, session: 0 }));

/** Opens the new project dialog on this environment, else the primary or first connected one. */
export function openNewVideoProject(environmentId?: EnvironmentId | null): void {
  const target =
    environmentId ??
    readPrimaryEnvironmentId() ??
    appAtomRegistry.get(environmentSummaries.connectedEnvironmentIdsAtom)[0] ??
    null;
  // With nothing connected, the palette's add-project flow points at connection settings.
  if (target === null) {
    openCommandPalette({ open: "add-project" });
    return;
  }
  useNewVideoProjectRequest.setState((state) => ({
    environmentId: target,
    open: true,
    session: state.session + 1,
  }));
}

export function closeNewVideoProject(): void {
  useNewVideoProjectRequest.setState({ open: false });
}
