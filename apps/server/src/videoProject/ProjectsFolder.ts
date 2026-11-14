import { DEFAULT_PROJECTS_FOLDER, type VideoProjectsFolderResult } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class ProjectsFolderError extends Schema.TaggedError<ProjectsFolderError>()(
  "ProjectsFolderError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

/** The mount point a removable drive's folder hangs off, which is missing while it is unplugged. */
const driveRootOf = (folder: string, platform: NodeJS.Platform, path: Path.Path) => {
  if (platform === "win32") return path.parse(folder).root || null;
  const parts = folder.split("/").filter((part) => part !== "");
  const depth =
    parts[0] === "Volumes" || parts[0] === "mnt"
      ? 2
      : parts[0] === "media"
        ? 3
        : parts[0] === "run" && parts[1] === "media"
          ? 4
          : 0;
  return depth > 0 && parts.length >= depth ? `/${parts.slice(0, depth).join("/")}` : null;
};

/** Where a folder is, and why a project can't be made in it, without creating anything. */
const inspectFolder = Effect.fn("ProjectsFolder.inspect")(function* (folder: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const expanded = expandHomePath(folder, yield* HostProcess.HomeDirectory);
  if (!path.isAbsolute(expanded)) {
    return {
      path: expanded,
      exists: false,
      disconnected: false,
      unavailable: `${folder} isn't a full path. Use one that starts with / or ~.`,
    };
  }
  const resolved = path.resolve(expanded);
  const stat = yield* fileSystem.stat(resolved).pipe(Effect.option);
  if (Option.isSome(stat)) {
    return stat.value.type === "Directory"
      ? { path: resolved, exists: true, disconnected: false, unavailable: null }
      : {
          path: resolved,
          exists: false,
          disconnected: false,
          unavailable: `${resolved} is a file, not a folder.`,
        };
  }
  const drive = driveRootOf(resolved, yield* HostProcess.Platform, path);
  if (
    drive !== null &&
    !(yield* fileSystem.exists(drive).pipe(Effect.orElseSucceed(() => false)))
  ) {
    return {
      path: resolved,
      exists: false,
      disconnected: true,
      unavailable: `${resolved} is on ${path.basename(drive) || drive}, which isn't connected. Connect the drive or choose another folder.`,
    };
  }
  return { path: resolved, exists: false, disconnected: false, unavailable: null };
});

/** The projects folder a setting names; empty means the default. */
export const resolveProjectsFolder = (
  setting: string,
): Effect.Effect<VideoProjectsFolderResult, never, FileSystem.FileSystem | Path.Path> =>
  inspectFolder(setting.trim() || DEFAULT_PROJECTS_FOLDER).pipe(
    Effect.map(({ disconnected: _, ...folder }) => folder),
  );

/**
 * The folder a new project is made in: the one asked for, which must exist, or else the projects
 * folder, created on first use.
 */
export const parentFolderFor = Effect.fn("ProjectsFolder.parentFolderFor")(function* (
  parentFolder: string | undefined,
  projectsFolderSetting: string,
) {
  if (parentFolder !== undefined && parentFolder.trim() !== "") {
    const chosen = yield* inspectFolder(parentFolder);
    if (chosen.exists) return chosen.path;
    return yield* new ProjectsFolderError({
      reason:
        chosen.disconnected && chosen.unavailable !== null
          ? chosen.unavailable
          : "Choose an existing folder to create it in.",
    });
  }
  const folder = yield* resolveProjectsFolder(projectsFolderSetting);
  if (folder.unavailable !== null) {
    return yield* new ProjectsFolderError({
      reason: `Can't use the projects folder: ${folder.unavailable}`,
    });
  }
  if (!folder.exists) {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(folder.path, { recursive: true }).pipe(
      Effect.mapError(
        () =>
          new ProjectsFolderError({
            reason: `Could not create the projects folder ${folder.path}.`,
          }),
      ),
    );
  }
  return folder.path;
});
