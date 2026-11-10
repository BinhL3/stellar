import type { EnvironmentId } from "@t3tools/contracts";

import { useFilesystemReadAccess } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";

const TIMELINES_DIRECTORY = "timelines";

const EMPTY_TIMELINES: ReadonlyArray<string> = [];

/** A project is a video project when `timelines/` holds at least one `.otio` file. */
export function useVideoProject(
  environmentId: EnvironmentId | null,
  workspaceRoot: string | null | undefined,
): { readonly isVideoProject: boolean; readonly timelinePaths: ReadonlyArray<string> } {
  const { canReadFiles } = useFilesystemReadAccess(environmentId);
  const result = useEnvironmentQuery(
    environmentId !== null && workspaceRoot && canReadFiles
      ? projectEnvironment.listEntries({
          environmentId,
          input: { cwd: workspaceRoot, directoryPath: TIMELINES_DIRECTORY },
        })
      : null,
  );
  const timelinePaths =
    result.data?.entries
      .filter(
        (entry) =>
          entry.kind === "file" &&
          entry.path.startsWith(`${TIMELINES_DIRECTORY}/`) &&
          !entry.path.slice(TIMELINES_DIRECTORY.length + 1).includes("/") &&
          entry.path.toLowerCase().endsWith(".otio"),
      )
      .map((entry) => entry.path)
      .toSorted() ?? EMPTY_TIMELINES;
  return { isVideoProject: timelinePaths.length > 0, timelinePaths };
}
