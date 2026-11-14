import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import { useProjectThemeClaim } from "../hooks/useTheme";
import { useProject, useQuietThreadShell } from "../state/entities";
import type { ThreadRouteTarget } from "../threadRoutes";

/** Shows the theme of the project the routed thread or draft belongs to. */
export function ProjectThemeClaim({ target }: { target: ThreadRouteTarget }) {
  const thread = useQuietThreadShell(target.kind === "server" ? target.threadRef : null);
  // Selects ids only, so composer edits to the draft do not re-render this.
  const draftEnvironmentId = useComposerDraftStore(
    (store) => draftOf(store, target)?.environmentId ?? null,
  );
  const draftProjectId = useComposerDraftStore(
    (store) => draftOf(store, target)?.projectId ?? null,
  );
  const environmentId: EnvironmentId | null = thread?.environmentId ?? draftEnvironmentId;
  const projectId: ProjectId | null = thread?.projectId ?? draftProjectId;
  const project = useProject(
    environmentId && projectId ? scopeProjectRef(environmentId, projectId) : null,
  );
  useProjectThemeClaim(project?.themeId ?? null);
  return null;
}

function draftOf(
  store: ReturnType<typeof useComposerDraftStore.getState>,
  target: ThreadRouteTarget,
) {
  return target.kind === "server"
    ? store.getDraftThread(target.threadRef)
    : store.getDraftSession(target.draftId);
}
