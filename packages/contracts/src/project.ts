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
  /** An existing folder on the host; the project's folder is created inside it. */
  parentFolder: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type VideoProjectCreateFromIdeaInput = typeof VideoProjectCreateFromIdeaInput.Type;

export const VideoProjectCreateFromIdeaResult = Schema.Struct({
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
  /** True when the folder already belonged to a project, which was reused. */
  existed: Schema.Boolean,
});
export type VideoProjectCreateFromIdeaResult = typeof VideoProjectCreateFromIdeaResult.Type;

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
  state: Schema.Literals(["copying", "done", "failed"]),
  folder: Schema.String,
  done: Schema.Number,
  total: Schema.Number,
  error: Schema.optional(Schema.String),
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
    "setEnabled",
    "setText",
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
  enabled: Schema.optional(Schema.Boolean),
  text: Schema.optional(Schema.String),
});
export type VideoTimelineEdit = typeof VideoTimelineEdit.Type;

export const VideoTimelineReadInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  /** A path from `timelines`; omitted, the project's main timeline. */
  timeline: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
});
export type VideoTimelineReadInput = typeof VideoTimelineReadInput.Type;

export const VideoTimelineExportResult = Schema.Struct({
  /** The XML file Premiere imports as a new sequence. */
  path: TrimmedNonEmptyString,
  sequenceName: TrimmedNonEmptyString,
  clips: Schema.Number,
  /** Clips the XML can't carry (text graphics, anything without a media file). */
  skipped: Schema.Array(Schema.String),
});
export type VideoTimelineExportResult = typeof VideoTimelineExportResult.Type;

export const VideoTimelineEditInput = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  timeline: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  edits: Schema.Array(VideoTimelineEdit).check(Schema.isMinLength(1), Schema.isMaxLength(500)),
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
  /** One line per clip: track, start-end in frames, #clipId, name. */
  text: Schema.String,
});
export type VideoTimelineView = typeof VideoTimelineView.Type;

export const VideoTimelineWords = Schema.Struct({
  timeline: Schema.String,
  /** A line per audio clip, then its numbered words as `index:word@startFrame`. */
  text: Schema.String,
});
export type VideoTimelineWords = typeof VideoTimelineWords.Type;

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
