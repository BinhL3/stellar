import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { RepositoryIdentity, ThreadEnvMode } from "./environment.ts";
import { ModelSelection } from "./modelSelection.ts";
import {
  CommandId,
  ForwardCompatibleUnion,
  isUnknownUnionMember,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
  type UnknownUnionMember,
} from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_SEARCH_CONTENTS_MAX_LIMIT = 500;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_READ_FILE_PATH_MAX_LENGTH = 512;

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
  runOnSettle: Schema.optional(Schema.Boolean),
  stopOnSettle: Schema.optional(Schema.Boolean),
  async: Schema.optional(Schema.Boolean),
  previewUrl: Schema.optional(TrimmedNonEmptyString),
  autoOpenPreview: Schema.optional(Schema.Boolean),
});
export type ProjectScript = typeof ProjectScript.Type;

export const ProjectIconColor = Schema.Literals([
  "gray",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
]);
export type ProjectIconColor = typeof ProjectIconColor.Type;

const ProjectLucideIconName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
);

const ProjectEmoji = TrimmedNonEmptyString.check(Schema.isMaxLength(32));

// Grapheme-count validation belongs to the server command boundary, not snapshot decoding.
export const ProjectMonogramText = TrimmedNonEmptyString.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^[\p{L}\p{N}][\p{L}\p{N}\p{M}\u200c\u200d]*$/u),
);

const ProjectLucideIcon = Schema.Struct({
  kind: Schema.Literal("lucide"),
  name: ProjectLucideIconName,
  color: ProjectIconColor,
});
const ProjectEmojiIcon = Schema.Struct({
  kind: Schema.Literal("emoji"),
  emoji: ProjectEmoji,
});
const ProjectMonogramIcon = Schema.Struct({
  kind: Schema.Literal("monogram"),
  text: ProjectMonogramText,
  color: ProjectIconColor,
});
export const ProjectFaviconPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(/\.(?:avif|gif|icns|ico|jpe?g|png|svg|webp)$/i),
);
export type ProjectFaviconPath = typeof ProjectFaviconPath.Type;

export const ProjectIconOverride = Schema.Union([
  ProjectLucideIcon,
  ProjectEmojiIcon,
  ProjectMonogramIcon,
]);
export type ProjectIconOverride = typeof ProjectIconOverride.Type;

const ProjectLucideIconWithLegacyMonogram = Schema.Struct({
  ...ProjectLucideIcon.fields,
  monogramText: Schema.optional(ProjectMonogramText),
  monogram: Schema.optional(ProjectMonogramText),
});
const projectIconMembers = [
  ProjectLucideIconWithLegacyMonogram,
  ProjectEmojiIcon,
  ProjectMonogramIcon,
] as const;
type ProjectIconMember = (typeof projectIconMembers)[number]["Type"];

const fromLegacyMonogram = (icon: ProjectIconMember): ProjectIconOverride => {
  if (icon.kind !== "lucide") return icon;
  const text = icon.monogramText ?? icon.monogram;
  return text === undefined
    ? { kind: "lucide", name: icon.name, color: icon.color }
    : { kind: "monogram", text, color: icon.color };
};

export const StoredProjectIcon = Schema.Union(projectIconMembers).pipe(
  Schema.decodeTo(
    Schema.toType(ProjectIconOverride),
    SchemaTransformation.transform<ProjectIconOverride, ProjectIconMember>({
      decode: fromLegacyMonogram,
      encode: (icon) => icon,
    }),
  ),
);

export const ReceivedProjectIcon = ForwardCompatibleUnion(projectIconMembers, "kind").pipe(
  Schema.decodeTo(
    Schema.NullOr(Schema.toType(ProjectIconOverride)),
    SchemaTransformation.transform<
      ProjectIconOverride | null,
      ProjectIconMember | UnknownUnionMember<"kind">
    >({
      decode: (icon) => (isUnknownUnionMember(icon) ? null : fromLegacyMonogram(icon)),
      encode: (icon) => icon as ProjectIconMember,
    }),
  ),
);

/** A built-in, custom or published theme id; clients fall back to the user's theme when it does not resolve. */
export const ProjectThemeId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
);
export type ProjectThemeId = typeof ProjectThemeId.Type;

export const Project = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  faviconPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  projectIcon: Schema.optional(Schema.NullOr(ReceivedProjectIcon)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  // Opt-in because background sync performs network I/O and may move the checkout.
  autoPull: Schema.optional(Schema.Boolean),
  themeId: Schema.optional(Schema.NullOr(ProjectThemeId)),
  scripts: Schema.Array(ProjectScript),
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type Project = typeof Project.Type;

export const ProjectSnapshot = Schema.Struct({
  projects: Schema.Array(Project),
  updatedAt: IsoDateTime,
});
export type ProjectSnapshot = typeof ProjectSnapshot.Type;

export const ProjectCreatePayload = Schema.Struct({
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});
export type ProjectCreatePayload = typeof ProjectCreatePayload.Type;

export const ProjectUpdatePayload = Schema.Struct({
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  autoPull: Schema.optional(Schema.Boolean),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  faviconPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  themeId: Schema.optional(
    Schema.NullOr(ProjectThemeId).annotate({
      description: "Theme id shown in this project, e.g. `long-bien`. Null: viewer's own.",
    }),
  ),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  pinned: Schema.optional(Schema.Boolean),
  archived: Schema.optional(
    Schema.Boolean.annotate({
      description: "Threads and files are kept.",
    }),
  ),
});
export type ProjectUpdatePayload = typeof ProjectUpdatePayload.Type;

export const ProjectMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("project.create"),
    commandId: CommandId,
    projectId: ProjectId,
    ...ProjectCreatePayload.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("project.update"),
    commandId: CommandId,
    projectId: ProjectId,
    ...ProjectUpdatePayload.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("project.delete"),
    commandId: CommandId,
    projectId: ProjectId,
    force: Schema.optional(Schema.Boolean),
  }),
]);
export type ProjectMutation = typeof ProjectMutation.Type;

export class ProjectMutationError extends Schema.TaggedError<ProjectMutationError>()(
  "ProjectMutationError",
  {
    commandId: CommandId,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ProjectEntryKind = Schema.Literals(["file", "directory"]);
export type ProjectEntryKind = typeof ProjectEntryKind.Type;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
  kind: Schema.optional(ProjectEntryKind),
  imageOnly: Schema.optional(Schema.Boolean),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  ignored: Schema.optional(Schema.Boolean),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export const ProjectSearchContentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  // Preserve whitespace because it is significant in content queries.
  query: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_CONTENTS_MAX_LIMIT)),
  caseSensitive: Schema.Boolean,
  wholeWord: Schema.Boolean,
  useRegex: Schema.Boolean,
});
export type ProjectSearchContentsInput = typeof ProjectSearchContentsInput.Type;

export const ProjectContentMatchRange = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
});
export type ProjectContentMatchRange = typeof ProjectContentMatchRange.Type;

export const ProjectContentMatch = Schema.Struct({
  path: TrimmedNonEmptyString,
  lineNumber: PositiveInt,
  lineContent: Schema.String,
  matchRanges: Schema.Array(ProjectContentMatchRange),
});
export type ProjectContentMatch = typeof ProjectContentMatch.Type;

export const ProjectSearchContentsResult = Schema.Struct({
  matches: Schema.Array(ProjectContentMatch),
  truncated: Schema.Boolean,
  regexFallbackError: Schema.optional(Schema.String),
});
export type ProjectSearchContentsResult = typeof ProjectSearchContentsResult.Type;

export const ProjectListEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  directoryPath: Schema.optional(TrimmedString),
});
export type ProjectListEntriesInput = typeof ProjectListEntriesInput.Type;

export const ProjectListEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectListEntriesResult = typeof ProjectListEntriesResult.Type;

// Untracked files git ignores. Wholly ignored folders such as `node_modules`
// are left out, so the list stays small enough to pick from.
export const ProjectListIgnoredFilesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ProjectListIgnoredFilesInput = typeof ProjectListIgnoredFilesInput.Type;

export const ProjectIgnoredFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  byteLength: NonNegativeInt,
});
export type ProjectIgnoredFile = typeof ProjectIgnoredFile.Type;

export const ProjectListIgnoredFilesResult = Schema.Struct({
  files: Schema.Array(ProjectIgnoredFile),
  truncated: Schema.Boolean,
});
export type ProjectListIgnoredFilesResult = typeof ProjectListIgnoredFilesResult.Type;

export const ProjectEntriesFailure = Schema.Literals([
  "workspace_root_not_found",
  "workspace_root_create_failed",
  "workspace_root_stat_failed",
  "workspace_root_not_directory",
  "search_index_create_failed",
  "search_index_scan_timed_out",
  "search_index_search_failed",
  "directory_list_failed",
]);
export type ProjectEntriesFailure = typeof ProjectEntriesFailure.Type;

type ProjectEntriesFailureContext = {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
  readonly cause?: unknown;
};

function decodedProjectErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class ProjectSearchEntriesError extends Schema.TaggedError<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    queryLength: Schema.optional(NonNegativeInt),
    limit: Schema.optional(PositiveInt),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectEntriesFailureContext & {
      readonly cwd: string;
      readonly queryLength: number;
      readonly limit: number;
    },
  ) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to search workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export class ProjectSearchContentsError extends Schema.TaggedError<ProjectSearchContentsError>()(
  "ProjectSearchContentsError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    queryLength: Schema.optional(NonNegativeInt),
    limit: Schema.optional(PositiveInt),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectEntriesFailureContext & {
      readonly cwd: string;
      readonly queryLength: number;
      readonly limit: number;
    },
  ) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to search workspace contents in '${props.cwd}'.`,
    } as any);
  }
}

export class ProjectListEntriesError extends Schema.TaggedError<ProjectListEntriesError>()(
  "ProjectListEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectEntriesFailureContext & { readonly cwd: string }) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ?? `Failed to list workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  // Workspace-relative or absolute host path; only workspace-relative paths are writable.
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
  // Optional files can be absent without failing the read.
  allowMissing: Schema.optional(Schema.Boolean),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  contents: Schema.String,
  byteLength: NonNegativeInt,
  truncated: Schema.Boolean,
  // Omitted by older servers; false only for an absent optional file.
  exists: Schema.optional(Schema.Boolean),
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export const ProjectFileFailure = Schema.Literals([
  "workspace_path_outside_root",
  "resolved_path_outside_root",
  "path_not_file",
  "binary_file",
  "operation_failed",
]);
export type ProjectFileFailure = typeof ProjectFileFailure.Type;

export const ProjectFileOperation = Schema.Literals([
  "realpath-workspace-root",
  "realpath-target",
  "open",
  "stat",
  "read",
  "close",
  "make-directory",
  "write-file",
]);
export type ProjectFileOperation = typeof ProjectFileOperation.Type;

type ProjectFileFailureContext = {
  readonly cwd: string;
  readonly relativePath: string;
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
  readonly cause?: unknown;
};

export class ProjectReadFileError extends Schema.TaggedError<ProjectReadFileError>()(
  "ProjectReadFileError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to read workspace file '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export const ProjectEnsureScratchResult = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectEnsureScratchResult = typeof ProjectEnsureScratchResult.Type;

export const ProjectCreateNewInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type ProjectCreateNewInput = typeof ProjectCreateNewInput.Type;

export const ProjectCreateNewResult = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
  /** The project and its files exist either way. */
  commitError: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProjectCreateNewResult = typeof ProjectCreateNewResult.Type;

export const VideoProjectInspectPremiereInput = Schema.Struct({
  premiereProjectPath: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type VideoProjectInspectPremiereInput = typeof VideoProjectInspectPremiereInput.Type;

export const VideoProjectInspectPremiereResult = Schema.Struct({
  title: TrimmedNonEmptyString,
  sequences: Schema.Array(Schema.Struct({ id: TrimmedNonEmptyString, name: Schema.String })),
  /** The Stellar project folder, beside the Premiere project; it may already exist. */
  projectFolder: TrimmedNonEmptyString,
});
export type VideoProjectInspectPremiereResult = typeof VideoProjectInspectPremiereResult.Type;

export const VideoProjectCreateInput = Schema.Struct({
  premiereProjectPath: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  sequenceId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type VideoProjectCreateInput = typeof VideoProjectCreateInput.Type;

export const VideoProjectCreateResult = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
  timelinePath: TrimmedNonEmptyString,
  /** True when the folder already belonged to a project, which was reused. */
  existed: Schema.Boolean,
});
export type VideoProjectCreateResult = typeof VideoProjectCreateResult.Type;

export const VideoProjectCreateFromIdeaInput = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  /** An existing folder on the host to create the project's folder in; omitted, the projects folder. */
  parentFolder: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
});
export type VideoProjectCreateFromIdeaInput = typeof VideoProjectCreateFromIdeaInput.Type;

export const VideoProjectCreateFromIdeaResult = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
  /** True when the folder already belonged to a project, which was reused. */
  existed: Schema.Boolean,
});
export type VideoProjectCreateFromIdeaResult = typeof VideoProjectCreateFromIdeaResult.Type;

/** Where new projects go by default, as the host resolved it. */
export const VideoProjectsFolderResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  /** False until the first project is made there; it is created then. */
  exists: Schema.Boolean,
  /** Why no project can be made there now, such as its drive being disconnected. */
  unavailable: Schema.NullOr(Schema.String),
});
export type VideoProjectsFolderResult = typeof VideoProjectsFolderResult.Type;

export const VideoProjectScanIntakeInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type VideoProjectScanIntakeInput = typeof VideoProjectScanIntakeInput.Type;

export const VideoProjectIntakeFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  size: Schema.Number,
  /** When the file was shot, in epoch milliseconds: AirDrop keeps the camera's dates. */
  capturedAt: Schema.Number,
});
export type VideoProjectIntakeFile = typeof VideoProjectIntakeFile.Type;

export const VideoProjectScanIntakeResult = Schema.Struct({
  /** The folder that was scanned (the host's Downloads). */
  source: TrimmedNonEmptyString,
  /** Videos and photos that arrived there in the last few days, oldest shot first. */
  files: Schema.Array(VideoProjectIntakeFile),
});
export type VideoProjectScanIntakeResult = typeof VideoProjectScanIntakeResult.Type;

export const VideoProjectImportFootageInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  /** Paths from a scan; anything outside the scanned folder is refused. */
  paths: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2000),
  ),
  /** The folder inside Footage to copy into, such as "00 Raw iPhone (Oct 10)". */
  folder: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type VideoProjectImportFootageInput = typeof VideoProjectImportFootageInput.Type;

/**
 * Progress of the last footage import, written to `intake.json` in the project folder as the
 * copy runs so every client can follow it.
 */
export const VideoProjectIntakeStatus = Schema.Struct({
  state: Schema.Literals(["copying", "conforming", "done", "failed"]),
  folder: Schema.String,
  done: Schema.Number,
  total: Schema.Number,
  error: Schema.optional(Schema.String),
  /**
   * While `conforming`: the clip being copied to a constant frame rate, how many of the clips
   * that need it are finished, and how far this one has got (0 to 100).
   */
  conform: Schema.optional(
    Schema.Struct({
      file: Schema.String,
      done: Schema.Number,
      total: Schema.Number,
      percent: Schema.Number,
    }),
  ),
});
export type VideoProjectIntakeStatus = typeof VideoProjectIntakeStatus.Type;

/**
 * One edit to a timeline, in whole timeline frames. Flat on purpose: which fields apply
 * depends on `kind`, and tool schemas with unions are harder for models to fill in.
 */
export const VideoTimelineEdit = Schema.Struct({
  kind: Schema.Literals([
    "move",
    "trim",
    "delete",
    "rippleDelete",
    "split",
    "removeRange",
    "removeWords",
    "trimPause",
    "setEnabled",
    "setText",
    "addMarker",
    "setMarker",
    "removeMarker",
    "restoreVersion",
  ]),
  clipId: Schema.optional(Schema.String),
  toTrack: Schema.optional(Schema.String),
  startFrame: Schema.optional(Schema.Number),
  magnetic: Schema.optional(Schema.Boolean),
  edge: Schema.optional(Schema.Literals(["start", "end"])),
  frame: Schema.optional(Schema.Number),
  tracks: Schema.optional(Schema.Array(Schema.String)),
  start: Schema.optional(Schema.Number),
  end: Schema.optional(Schema.Number),
  ripple: Schema.optional(Schema.Boolean),
  /** Word numbers from the timeline's words view, inclusive. */
  fromWord: Schema.optional(Schema.Number),
  toWord: Schema.optional(Schema.Number),
  /** `trimPause`: the word the pause follows, and the seconds of it to keep. */
  afterWord: Schema.optional(Schema.Number),
  leave: Schema.optional(Schema.Number),
  enabled: Schema.optional(Schema.Boolean),
  text: Schema.optional(Schema.String),
  /** Markers: `markerId` from the timeline's marker lines; `duration` in frames. */
  markerId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  color: Schema.optional(
    Schema.Literals(["GREEN", "RED", "PURPLE", "ORANGE", "YELLOW", "WHITE", "BLUE", "CYAN"]),
  ),
  duration: Schema.optional(Schema.Number),
  resolved: Schema.optional(Schema.Boolean),
  /** A version id from the timeline's history, such as `v12`. */
  version: Schema.optional(Schema.String),
});
export type VideoTimelineEdit = typeof VideoTimelineEdit.Type;

export const VideoTimelineReadInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  /** A path from `timelines`; omitted, the project's main timeline. */
  timeline: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  /** `list` for the timeline's versions, or a version id to read that version instead. */
  version: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(32))),
});
export type VideoTimelineReadInput = typeof VideoTimelineReadInput.Type;

/** One recorded state of a timeline's file. */
export const VideoTimelineVersion = Schema.Struct({
  /** `v<n>`, counted up per timeline. */
  id: TrimmedNonEmptyString,
  /** Epoch milliseconds. */
  at: Schema.Number,
  /** `outside` is a change no Stellar tool made, such as the file edited by hand. */
  by: Schema.Literals(["user", "agent", "premiere", "outside"]),
  label: Schema.String,
  /** What changed from the version before, one plain sentence per change. */
  changes: Schema.Array(Schema.String),
});
export type VideoTimelineVersion = typeof VideoTimelineVersion.Type;

export const VideoTimelineVersionsInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  timeline: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
export type VideoTimelineVersionsInput = typeof VideoTimelineVersionsInput.Type;

export const VideoTimelineVersions = Schema.Struct({
  timeline: Schema.String,
  /** Newest first; the first is what the file holds now. */
  versions: Schema.Array(VideoTimelineVersion),
  /** The versions undo and redo would go to from here; null when there is none. */
  undo: Schema.NullOr(Schema.String),
  redo: Schema.NullOr(Schema.String),
});
export type VideoTimelineVersions = typeof VideoTimelineVersions.Type;

export const VideoTimelineVersionReadInput = Schema.Struct({
  ...VideoTimelineVersionsInput.fields,
  version: TrimmedNonEmptyString.check(Schema.isMaxLength(32)),
});
export type VideoTimelineVersionReadInput = typeof VideoTimelineVersionReadInput.Type;

export const VideoTimelineVersionView = Schema.Struct({
  version: VideoTimelineVersion,
  /** The timeline's text as that version held it. */
  contents: Schema.String,
  /** What changed from that version to the timeline now, one plain sentence per change. */
  changesSince: Schema.Array(Schema.String),
});
export type VideoTimelineVersionView = typeof VideoTimelineVersionView.Type;

export const VideoTimelineCommitInput = Schema.Struct({
  ...VideoTimelineVersionsInput.fields,
  /** The whole timeline as OTIO JSON. */
  contents: Schema.String.check(Schema.isMaxLength(64_000_000)),
});
export type VideoTimelineCommitInput = typeof VideoTimelineCommitInput.Type;

export const VideoTimelineRestoreInput = Schema.Struct({
  ...VideoTimelineVersionsInput.fields,
  /** The version to bring back; or `step` to go one undo or redo from the newest. */
  version: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(32))),
  step: Schema.optional(Schema.Literals(["undo", "redo"])),
});
export type VideoTimelineRestoreInput = typeof VideoTimelineRestoreInput.Type;

export const VideoTimelineRestoreResult = Schema.Struct({
  ...VideoTimelineVersions.fields,
  /** The version that was brought back. */
  restored: VideoTimelineVersion,
  /**
   * Changes made in Premiere since that version, which the restore kept: it brings back the
   * edits made here, on top of Premiere's latest save.
   */
  keptFromPremiere: Schema.Array(Schema.String),
  /** Parts of the version that could not be brought back because Premiere changed the same thing. */
  conflicts: Schema.Array(Schema.String),
});
export type VideoTimelineRestoreResult = typeof VideoTimelineRestoreResult.Type;

/** One agent edit as the user reviews it. */
export const VideoTimelineEditRecord = Schema.Struct({
  /** Counted up per timeline and never reused; shown and said as `E<n>`. */
  number: Schema.Number,
  /** The version the edit wrote, and the one before it; `before` is null once it is no longer kept. */
  version: TrimmedNonEmptyString,
  before: Schema.NullOr(Schema.String),
  /** Epoch milliseconds. */
  at: Schema.Number,
  /** What the agent says it did, in a sentence. */
  summary: Schema.String,
  /** A doubt the agent left that only watching or listening settles; null when it left none. */
  check: Schema.NullOr(Schema.String),
  decision: Schema.NullOr(Schema.Literals(["kept", "undone"])),
  /** Where the edit is in the timeline now, in frames; null when it has no place. */
  frame: Schema.NullOr(Schema.Number),
  /** The first stretch it took out, in the frames of the version before it. */
  removed: Schema.NullOr(Schema.Struct({ start: Schema.Number, end: Schema.Number })),
});
export type VideoTimelineEditRecord = typeof VideoTimelineEditRecord.Type;

export const VideoTimelineEdits = Schema.Struct({
  timeline: Schema.String,
  /** Newest first. */
  edits: Schema.Array(VideoTimelineEditRecord),
});
export type VideoTimelineEdits = typeof VideoTimelineEdits.Type;

export const VideoTimelineReviewEditInput = Schema.Struct({
  ...VideoTimelineVersionsInput.fields,
  edit: Schema.Number,
  /**
   * `keep` settles an edit and `reopen` unsettles it. `undo` takes just that edit out and
   * `redo` puts it back, each only when the edits made since leave room. `restoreBefore`
   * brings back the version before the edit, taking every later edit with it.
   */
  action: Schema.Literals(["keep", "reopen", "undo", "redo", "restoreBefore"]),
});
export type VideoTimelineReviewEditInput = typeof VideoTimelineReviewEditInput.Type;

export const VideoTimelineReviewEditResult = Schema.Struct({
  ...VideoTimelineEdits.fields,
  /** Why an undo or redo changed nothing, in plain words; null when the action was done. */
  blocked: Schema.NullOr(Schema.String),
});
export type VideoTimelineReviewEditResult = typeof VideoTimelineReviewEditResult.Type;

export const VideoTimelineExportResult = Schema.Struct({
  /** The XML file Premiere imports as a new sequence. */
  path: TrimmedNonEmptyString,
  sequenceName: TrimmedNonEmptyString,
  clips: Schema.Number,
  /** Clips the XML can't carry (text graphics, anything without a media file). */
  skipped: Schema.Array(Schema.String),
});
export type VideoTimelineExportResult = typeof VideoTimelineExportResult.Type;

/** The steps that bring a sequence open in Premiere up to the timeline edited here. */
export const VideoPremierePushPlan = Schema.Struct({
  timeline: Schema.String,
  /** Whether Premiere is open on the host; null where that can't be told. */
  premiereRunning: Schema.NullOr(Schema.Boolean),
  /** Whether the project follows a Premiere project. */
  linked: Schema.Boolean,
  /** Premiere saved a version the timeline here doesn't hold yet, so nothing may be pushed. */
  premiereIsNewer: Schema.Boolean,
  /** Why there is no plan; null when there is one, or nothing to push. */
  refused: Schema.NullOr(Schema.String),
  steps: Schema.Number,
  /** What differs that no step does safely, in plain words. */
  manual: Schema.Array(Schema.String),
  /** One numbered line per step, in the order to run them, then the manual list. */
  plan: Schema.String,
  /** What to do with the plan, or instead of it. */
  instructions: Schema.String,
});
export type VideoPremierePushPlan = typeof VideoPremierePushPlan.Type;

export const VideoTimelineEditInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  timeline: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  edits: Schema.Array(VideoTimelineEdit).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
  /** What the edits did, in a sentence. With it the call is an edit the user reviews. */
  summary: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  /** A doubt left that the user must settle by watching or listening. */
  check: Schema.optional(Schema.String.check(Schema.isMaxLength(300))),
});
export type VideoTimelineEditInput = typeof VideoTimelineEditInput.Type;

export const VideoProjectSaveVoiceOverInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  /** The recording as the browser made it (WebM or MP4 audio). */
  recording: Schema.Uint8ArrayFromBase64,
});
export type VideoProjectSaveVoiceOverInput = typeof VideoProjectSaveVoiceOverInput.Type;

export const VideoProjectSaveVoiceOverResult = Schema.Struct({
  /** The saved WAV, relative to the project's media root, such as "Audio/VO/VO 2026-11-09 21.04.33.wav". */
  path: TrimmedNonEmptyString,
  absolutePath: TrimmedNonEmptyString,
});
export type VideoProjectSaveVoiceOverResult = typeof VideoProjectSaveVoiceOverResult.Type;

export const VideoProjectSyncInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  /** Replace timelines edited here with Premiere's version; the replaced files are kept. */
  usePremiere: Schema.optional(Schema.Boolean),
  /** Take Premiere's save and re-apply the edits made here on top of it. */
  merge: Schema.optional(Schema.Boolean),
});
export type VideoProjectSyncInput = typeof VideoProjectSyncInput.Type;

export const VideoProjectSyncResult = Schema.Struct({
  state: Schema.Literals(["current", "updated", "edited", "conflict", "offline", "unlinked"]),
  /** When Premiere last saved the project, in epoch milliseconds. */
  premiereSavedAt: Schema.NullOr(Schema.Number),
  /** Timeline paths this sync rewrote from Premiere. */
  updated: Schema.Array(Schema.String),
  /** Timeline paths that differ from Premiere's save and were left alone. */
  kept: Schema.Array(Schema.String),
  /** Whether Premiere is open on the host; null where that can't be told. */
  premiereRunning: Schema.NullOr(Schema.Boolean),
  /** What this sync brought in from Premiere, one plain sentence per change. */
  changes: Schema.Array(Schema.String),
  /** Edits made here that aren't in Premiere yet, one plain sentence per change. */
  pending: Schema.Array(Schema.String),
  /** Edits made here that a merge had to drop because Premiere changed the same thing. */
  conflicts: Schema.Array(Schema.String),
  /** The timeline paths that follow a Premiere sequence, which a push reaches. */
  linked: Schema.optional(Schema.Array(Schema.String)),
});
export type VideoProjectSyncResult = typeof VideoProjectSyncResult.Type;

export const VideoTimelineView = Schema.Struct({
  timelines: Schema.Array(Schema.String),
  timeline: Schema.NullOr(Schema.String),
  /** How the project stands against Premiere's last save, checked just before reading. */
  premiere: VideoProjectSyncResult.fields.state,
  /**
   * What exists and what is ready, one fact per line: the project folder, whether Premiere is
   * open and linked, footage, previews, transcripts, voice-over takes, and missing tools.
   */
  project: Schema.String,
  /**
   * What this call found, a line each and empty when nothing: what the user changed in Premiere
   * since the last read, edits made here that a merge dropped, and edits not in Premiere yet.
   */
  changes: Schema.String,
  /** One line per clip: track, start-end in frames, #clipId, name. */
  text: Schema.String,
  /**
   * After an edit that cut by words: a line per cut saying the frames removed, the level
   * measured at each edge in dBFS, and how far an edge was moved onto quiet, in seconds.
   */
  cuts: Schema.optional(Schema.String),
});
export type VideoTimelineView = typeof VideoTimelineView.Type;

export const VideoTimelineWordsInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  /** A path from `timelines`; omitted, the project's main timeline. */
  timeline: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  /** `joins` reads every join and long pause as heard instead of the words. */
  action: Schema.optional(Schema.Literals(["words", "joins"])),
  /** The first word, or the first audit line, of the page to read. */
  from: Schema.optional(Schema.Number),
  /** `joins`: pauses of this many seconds or more are listed. */
  pauseOver: Schema.optional(Schema.Number),
});
export type VideoTimelineWordsInput = typeof VideoTimelineWordsInput.Type;

export const VideoTimelineWords = Schema.Struct({
  timeline: Schema.String,
  /**
   * `words`: a line per audio clip, then its numbered words as `index:word@startFrame`.
   * `joins`: a line per join or long pause, with levels in dBFS and lengths in seconds.
   */
  text: Schema.String,
});
export type VideoTimelineWords = typeof VideoTimelineWords.Type;

/** One line of the script, and where it was said on a timeline. */
export const VideoScriptBeat = Schema.Struct({
  /** Kept across snapshots while the beat's text stays recognisably the same. */
  id: TrimmedNonEmptyString,
  text: Schema.String,
  /** The heading the beat sits under, or null. */
  section: Schema.NullOr(Schema.String),
  /** Timeline frames of the beat's words, or null when the timeline doesn't say them. */
  startFrame: Schema.NullOr(Schema.Number),
  endFrame: Schema.NullOr(Schema.Number),
  /** First and last word numbers, as `video_timeline_words` counts them. */
  firstWord: Schema.NullOr(Schema.Number),
  lastWord: Schema.NullOr(Schema.Number),
});
export type VideoScriptBeat = typeof VideoScriptBeat.Type;

export const VideoScriptReadInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  /** The timeline to place beats on; omitted, the project's main timeline. */
  timeline: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
});
export type VideoScriptReadInput = typeof VideoScriptReadInput.Type;

export const VideoScriptView = Schema.Struct({
  /** The Google Doc the script is written in, or null when none is recorded. */
  docUrl: Schema.NullOr(Schema.String),
  /** When the snapshot in the project was last saved, in epoch milliseconds; null with no snapshot. */
  savedAt: Schema.NullOr(Schema.Number),
  timeline: Schema.NullOr(Schema.String),
  beats: Schema.Array(VideoScriptBeat),
});
export type VideoScriptView = typeof VideoScriptView.Type;

export const VideoScriptSaveInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  /** The script as Markdown or plain text, replacing the project's snapshot. */
  text: Schema.optional(Schema.String.check(Schema.isMaxLength(400_000))),
  docUrl: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))),
});
export type VideoScriptSaveInput = typeof VideoScriptSaveInput.Type;

/** Word-timed transcripts for a project's footage and voice-over, written by the host's transcriber. */
export const VideoTranscriptStatus = Schema.Struct({
  /** Files being transcribed now, or null when none are. */
  building: Schema.NullOr(Schema.Struct({ done: Schema.Number, total: Schema.Number })),
  /** Media files with a word-timed transcript. */
  ready: Schema.Number,
  /** Media files with speech to transcribe: footage and voice-over takes. */
  total: Schema.Number,
  /** Media-root-relative paths the last run couldn't transcribe. */
  failed: Schema.Array(Schema.String),
  /** Why nothing can be transcribed (no transcriber on the host), or null. */
  unavailable: Schema.NullOr(Schema.String),
});
export type VideoTranscriptStatus = typeof VideoTranscriptStatus.Type;

export const VideoTranscribeInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  /** Media-root-relative files to transcribe; omitted, every file without a transcript. */
  files: Schema.optional(Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(500))),
  language: Schema.optional(Schema.Literals(["en", "vi"])),
});
export type VideoTranscribeInput = typeof VideoTranscribeInput.Type;

/** One recording of a script line. */
export const VideoVoiceOverTake = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** The WAV, relative to the project's media root, such as "Audio/VO/VO b3 t7.wav". */
  path: TrimmedNonEmptyString,
  seconds: Schema.Number,
  source: Schema.Literals(["recorded", "imported", "split"]),
  /** Epoch milliseconds. */
  createdAt: Schema.Number,
});
export type VideoVoiceOverTake = typeof VideoVoiceOverTake.Type;

/** A script line with its voice-over takes. */
export const VideoVoiceOverBeat = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: Schema.String,
  section: Schema.NullOr(Schema.String),
  takes: Schema.Array(VideoVoiceOverTake),
  /** The take the line uses; null only when it has none. */
  chosen: Schema.NullOr(Schema.String),
  /** The take on the timeline for this line, with its frames; null when none is. */
  placed: Schema.NullOr(
    Schema.Struct({
      takeId: Schema.String,
      track: Schema.String,
      startFrame: Schema.Number,
      endFrame: Schema.Number,
    }),
  ),
});
export type VideoVoiceOverBeat = typeof VideoVoiceOverBeat.Type;

export const VideoVoiceOverView = Schema.Struct({
  /** The timeline `placed` was read from; null when the project has none. */
  timeline: Schema.NullOr(Schema.String),
  /** The folder take paths are relative to. */
  mediaRoot: Schema.String,
  /** Script lines in script order. */
  beats: Schema.Array(VideoVoiceOverBeat),
  /** Recordings under Audio/VO that belong to no line, such as a read of the whole script. */
  loose: Schema.Array(Schema.String),
  /** Takes whose line the script no longer has, by the old beat id. */
  orphaned: Schema.Array(Schema.Struct({ beatId: Schema.String, takes: Schema.Number })),
  /** What this call did to the timeline, a sentence each; empty for a read. */
  changes: Schema.Array(Schema.String),
});
export type VideoVoiceOverView = typeof VideoVoiceOverView.Type;

export const VideoVoiceOverReadInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  /** The timeline to look for placed takes on; omitted, the project's main timeline. */
  timeline: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
});
export type VideoVoiceOverReadInput = typeof VideoVoiceOverReadInput.Type;

export const VideoVoiceOverSaveTakeInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  beatId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** An audio file on the host to copy in, in any format ffmpeg reads, absolute or relative to the media root. */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  timeline: VideoVoiceOverReadInput.fields.timeline,
});
export type VideoVoiceOverSaveTakeInput = typeof VideoVoiceOverSaveTakeInput.Type;

export const VideoVoiceOverTakeInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  beatId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  takeId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  timeline: VideoVoiceOverReadInput.fields.timeline,
});
export type VideoVoiceOverTakeInput = typeof VideoVoiceOverTakeInput.Type;

export const VideoVoiceOverApplyInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  timeline: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  /** The lines to place; omitted, every line whose chosen take isn't the one on the timeline. */
  beatIds: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(64))).check(
      Schema.isMaxLength(500),
    ),
  ),
});
export type VideoVoiceOverApplyInput = typeof VideoVoiceOverApplyInput.Type;

export const VideoVoiceOverSplitInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  /** A transcribed recording of several lines, relative to the media root. */
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  timeline: VideoVoiceOverReadInput.fields.timeline,
});
export type VideoVoiceOverSplitInput = typeof VideoVoiceOverSplitInput.Type;
/** One check of an exported file against the timeline it was cut from. */
export const VideoRenderCheckItem = Schema.Struct({
  /** Which check, such as `duration`, `black`, `cuts` or `loudness`. */
  id: Schema.String,
  level: Schema.Literals(["pass", "warn", "fail"]),
  title: Schema.String,
  /** What was found, with times as `m:ss.ff (frame n)` of the export. */
  detail: Schema.String,
});
export type VideoRenderCheckItem = typeof VideoRenderCheckItem.Type;

/**
 * The last render check, kept as `render/report.json` in the project folder: an export from
 * Premiere compared with a timeline. Stellar has no renderer, so this is what "done" rests on.
 */
export const VideoRenderReport = Schema.Struct({
  /** The timeline path it was checked against, and a hash of that file's text at the time. */
  timeline: Schema.String,
  timelineHash: Schema.String,
  /** The exported file, with the size and modified time it had when checked. */
  exportPath: Schema.String,
  exportSize: Schema.Number,
  exportModifiedAt: Schema.Number,
  /** Epoch milliseconds. */
  checkedAt: Schema.Number,
  /** The worst level among the items. */
  level: VideoRenderCheckItem.fields.level,
  items: Schema.Array(VideoRenderCheckItem),
  /**
   * An image of the export's frames, spread evenly plus the frame after each timeline cut, as an
   * absolute path; null when it couldn't be made. `contactSheetLabelled` is false when the
   * host's ffmpeg can't draw the frame number and time on each tile.
   */
  contactSheet: Schema.NullOr(Schema.String),
  contactSheetLabelled: Schema.Boolean,
  /** The sheet's tiles in reading order: the export frame each shows, and why it is there. */
  contactSheetTiles: Schema.Array(
    Schema.Struct({
      frame: Schema.Number,
      seconds: Schema.Number,
      kind: Schema.Literals(["even", "cut", "flash"]),
    }),
  ),
});
export type VideoRenderReport = typeof VideoRenderReport.Type;

export const VideoRenderCheckInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  /** A path from `timelines`; omitted, the project's main timeline. */
  timeline: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  /**
   * The exported video, absolute or relative to the project's media root; omitted, the newest
   * video in its Exports folder.
   */
  exportPath: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(4096))),
});
export type VideoRenderCheckInput = typeof VideoRenderCheckInput.Type;

/** One step of a short's run, from footage to posted. */
export const VideoPreflightStep = Schema.Struct({
  id: Schema.Literals([
    "footage",
    "proxies",
    "transcripts",
    "premiereLink",
    "premiereSync",
    "render",
    "posted",
  ]),
  label: Schema.String,
  /** `todo` is a step not reached yet; `warn` and `fail` need the person. */
  state: Schema.Literals(["done", "working", "todo", "warn", "fail"]),
  /** What is there or what is missing, in a few words. */
  detail: Schema.String,
  /** What moves the step on, where something does. */
  action: Schema.NullOr(
    Schema.Literals([
      "importFootage",
      "sync",
      "merge",
      "transcribe",
      "linkPremiere",
      "checkRender",
      "markPosted",
      "unmarkPosted",
    ]),
  ),
});
export type VideoPreflightStep = typeof VideoPreflightStep.Type;

/** That a short is posted, kept as `posted` in the project folder's `project.json`. */
export const VideoPosted = Schema.Struct({
  /** Epoch milliseconds. */
  at: Schema.Number,
  /** Links to the posts, one per platform. */
  urls: Schema.Array(Schema.String),
});
export type VideoPosted = typeof VideoPosted.Type;

export const VideoPreflightInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type VideoPreflightInput = typeof VideoPreflightInput.Type;

/** Where a short's run stands, derived from what the project folder records. */
export const VideoPreflight = Schema.Struct({
  /** The steps in the order a short goes through them. */
  steps: Schema.Array(VideoPreflightStep),
  /** The last render check, whether or not it still holds; the `render` step says if it does. */
  render: Schema.NullOr(VideoRenderReport),
  posted: Schema.NullOr(VideoPosted),
});
export type VideoPreflight = typeof VideoPreflight.Type;

export const VideoSetPostedInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  /** False takes the record back. */
  posted: Schema.Boolean,
  urls: Schema.optional(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))).check(
      Schema.isMaxLength(20),
    ),
  ),
  /** When it went up, in epoch milliseconds; omitted, now. */
  at: Schema.optional(Schema.Number),
});
export type VideoSetPostedInput = typeof VideoSetPostedInput.Type;

export const ProjectCreateFromThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProjectCreateFromThreadInput = typeof ProjectCreateFromThreadInput.Type;

export const ProjectCreateFromThreadResult = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectCreateFromThreadResult = typeof ProjectCreateFromThreadResult.Type;

export class ProjectWriteFileError extends Schema.TaggedError<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to write workspace file '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}
