import type { EnvironmentId } from "@t3tools/contracts";
import { CAROUSEL_FILE } from "@t3tools/timeline/carousel";

import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";

/**
 * What a project is follows from what its folder holds: one with `carousel.json` is a photo
 * carousel, and any other is a video. Null until the folder has been read.
 */
export function useIsCarouselProject(
  environmentId: EnvironmentId | null,
  workspaceRoot: string | null | undefined,
): boolean | null {
  const listing = useEnvironmentQuery(
    environmentId !== null && workspaceRoot
      ? projectEnvironment.listEntries({ environmentId, input: { cwd: workspaceRoot } })
      : null,
  );
  if (listing.data === null) return listing.isPending ? null : false;
  return listing.data.entries.some(
    (entry) => entry.kind === "file" && entry.path === CAROUSEL_FILE,
  );
}
