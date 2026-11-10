import type { EnvironmentId } from "@t3tools/contracts";

import { VIDEO_ONLY } from "~/branding";
import { useFilesystemReadAccess } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";

const TIMELINES_DIRECTORY = "timelines";

const EMPTY_TIMELINES: ReadonlyArray<string> = [];

/**
 * In Stellar every project is a video project (`VIDEO_ONLY`). Where that is off, a project is
 * one when it has a `timelines/` folder; one started from an idea has the folder and nothing in
 * it yet, until a Premiere sequence is pulled.
 */
export function useVideoProject(
  environmentId: EnvironmentId | null,
  workspaceRoot: string | null | undefined,
): {
  readonly isVideoProject: boolean;
  readonly timelinePaths: ReadonlyArray<string>;
  readonly refresh: () => void;
} {
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
  return {
    isVideoProject: VIDEO_ONLY ? workspaceRoot != null : result.data !== null,
    timelinePaths,
    refresh: result.refresh,
  };
}
