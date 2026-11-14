import { useFocusEffect } from "@react-navigation/native";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { Atom } from "effect/reactivity";
import { useCallback } from "react";

import { projectMobileThemeId, type MobileThemeId } from "../../../lib/mobileTheme";
import { appAtomRegistry } from "../../../state/atom-registry";

/** The focused project's theme, shown in place of the user's own; never saved. */
export const projectThemeIdAtom = Atom.make<MobileThemeId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:project-theme-id"),
);

const claims: Array<{ readonly themeId: MobileThemeId | null }> = [];
let syncScheduled = false;

// Coalesced so moving between two screens' claims applies once.
function scheduleSync(): void {
  if (syncScheduled) return;
  syncScheduled = true;
  queueMicrotask(() => {
    syncScheduled = false;
    const next = claims.at(-1)?.themeId ?? null;
    if (appAtomRegistry.get(projectThemeIdAtom) !== next) {
      appAtomRegistry.set(projectThemeIdAtom, next);
    }
  });
}

/** While the calling screen is focused, the app shows its project's theme. */
export function useProjectThemeClaim(project: EnvironmentProject | null): void {
  const themeId = projectMobileThemeId(project?.themeId);
  useFocusEffect(
    useCallback(() => {
      const claim = { themeId };
      claims.push(claim);
      scheduleSync();
      return () => {
        claims.splice(claims.indexOf(claim), 1);
        scheduleSync();
      };
    }, [themeId]),
  );
}
