import {
  OrchestratorMcpFailure,
  VideoProjectCreateFromIdeaResult,
  VideoProjectScanIntakeResult,
  VideoScriptSaveInput,
  VideoTimelineEdit,
  VideoTimelineExportResult,
  VideoTimelineView,
  VideoTimelineWords,
  VideoTranscribeInput,
  VideoTranscriptStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as VideoProjects from "../../../videoProject/VideoProjects.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProjectService.ProjectService,
  VideoProjects.VideoProjects,
];

const TimelineReadTool = Tool.make("video_timeline_read", {
  description:
    "Read this thread's video timeline: one line per clip as `track start-end #clipId name`, in whole frames. Call it first in a video thread: `project` says what footage, previews, transcripts and takes exist and whether Premiere is open and linked. Pulls Premiere's latest save first, so read before every edit; `premiere` says whether the timeline holds edits Premiere doesn't. Omit `timeline` for the main one; `timelines` lists the others, such as the footage laid end to end.",
  parameters: Schema.Struct({ timeline: Schema.optional(Schema.String) }),
  success: VideoTimelineView,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read the video timeline")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const TimelineEditTool = Tool.make("video_timeline_edit", {
  description:
    "Edit a timeline in Stellar. `edits` run in order, in whole frames, naming clips by `#clipId` from `video_timeline_read`: move (clipId, toTrack, startFrame; `magnetic` closes the gap and pushes clips instead of overwriting), trim (clipId, edge, frame), delete, rippleDelete, split (frame, tracks), removeRange (start, end, ripple), removeWords (fromWord, toWord, ripple), setEnabled, setText. A split's later piece is `<clipId>~<frame>`. removeWords takes word numbers from `video_timeline_words` as they were before this call, so one call can hold several word cuts; put them before other edits. One bad edit refuses the whole call. Edits change Stellar's timeline only; `video_premiere_export` sends the result to Premiere.",
  parameters: Schema.Struct({
    timeline: Schema.String,
    edits: Schema.Array(VideoTimelineEdit),
  }),
  success: VideoTimelineView,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Edit the video timeline")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const TimelineWordsTool = Tool.make("video_timeline_words", {
  description:
    "Read what is said on a timeline, to cut by words: per audio clip, each transcribed word as `index:word@startFrame`. Cut with `video_timeline_edit` removeWords, which removes from a word's start to the next word's start. Numbers change after every edit, so read again before cutting more. Transcripts come from the project's `Audio/<clip>.words.json`; clips without one say so, and `video_transcribe` makes them.",
  parameters: Schema.Struct({ timeline: Schema.optional(Schema.String) }),
  success: VideoTimelineWords,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read the timeline's words")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const TranscribeTool = Tool.make("video_transcribe", {
  description:
    "Make word-timed transcripts for this thread's video project, so its clips can be cut by words. Call it when `video_timeline_words` shows clips with `(no transcript)`. Returns at once while the host's transcriber works through the files in the background, tens of seconds each: `building` counts the run, `ready` of `total` footage clips and voice-over takes have a transcript, `failed` lists files it couldn't do. Call again later to see progress, then read the words again. Omit `files` to do everything without a transcript, or name files relative to the project folder; `language` (en or vi) only when the user says what is spoken. When `unavailable` is set the host has no transcriber: tell the user what it says.",
  parameters: Schema.Struct({
    files: VideoTranscribeInput.fields.files,
    language: VideoTranscribeInput.fields.language,
  }),
  success: VideoTranscriptStatus,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Transcribe the project's media")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ScriptTool = Tool.make("video_script", {
  description:
    "Read or refresh this project's script. The script's source of truth is the user's Google Doc; Stellar keeps a snapshot split into beats (spoken lines; headings, metadata and [bracketed] visual notes are left out) and finds where each beat is said on a timeline. With no arguments it reads: `text` has one line per beat, `b4 words 120-141 frames 1830-2104: <line>` or `b5 not on the timeline: <line>`. The word numbers are `video_timeline_words` numbers, so they go straight into `video_timeline_edit` removeWords, and like them they change after every edit: read again before cutting more. To refresh the snapshot, read the Google Doc with a Docs tool and pass its whole text (Markdown or plain) as `text`, and its link as `docUrl` when you have it; `docUrl` in the result is the doc recorded so far. Beats keep their ids when their wording is the same or lightly edited. When reading, `timeline` picks the timeline to place beats on; omit it for the main one, which a save always answers with.",
  parameters: Schema.Struct({
    text: VideoScriptSaveInput.fields.text,
    docUrl: VideoScriptSaveInput.fields.docUrl,
    timeline: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    docUrl: Schema.NullOr(Schema.String),
    timeline: Schema.NullOr(Schema.String),
    beats: Schema.Number,
    text: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read or save the script")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PremiereExportTool = Tool.make("video_premiere_export", {
  description:
    "Send a Stellar timeline to Premiere: writes it as an XML file in the project's Premiere folder and returns the `path`. Import that file with a Premiere tool; it arrives as a new sequence named `sequenceName`, never replacing one. Only the cut travels (tracks, positions, source ranges, enabled state). Effects, text graphics and clips without a media file are left out and listed in `skipped`: tell the user what didn't come across.",
  parameters: Schema.Struct({ timeline: Schema.optional(Schema.String) }),
  success: VideoTimelineExportResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Export the timeline for Premiere")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ProjectStartTool = Tool.make("video_project_start", {
  description:
    "Start a video project from an idea, before footage or a Premiere project exists. Makes `<parentFolder>/<title>` with Footage, Audio, B-roll, Graphics, Premiere, Exports and Stellar folders and adds it as a project. Save the Premiere project into its Premiere folder later, then `video_premiere_pull`.",
  parameters: Schema.Struct({ title: Schema.String, parentFolder: Schema.String }),
  success: VideoProjectCreateFromIdeaResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Start a video project")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PremierePullTool = Tool.make("video_premiere_pull", {
  description:
    "Pull a Premiere sequence into Stellar as a timeline that then follows Premiere's saves. Save the project in Premiere first: only saved state is read. Without `sequence`, lists the project's sequences. The timeline goes in the Stellar folder beside the .prproj, joining the project already there.",
  parameters: Schema.Struct({
    premiereProjectPath: Schema.String,
    sequence: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    sequences: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
    pulled: Schema.NullOr(Schema.Struct({ workspaceRoot: Schema.String, timeline: Schema.String })),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Pull a Premiere sequence")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const FootageTool = Tool.make("video_footage", {
  description:
    "Bring footage into this thread's video project. `scan` lists videos and photos that arrived in the host's Downloads in the last few days (AirDrop keeps camera dates, so this goes by date added). `import` copies the `paths` the user approved into `Footage/<folder>`, size-checked, in the background, then builds previews and a Footage timeline; originals stay in Downloads. Show the scan and get the user's approval before importing.",
  parameters: Schema.Struct({
    action: Schema.Literals(["scan", "import"]),
    paths: Schema.optional(Schema.Array(Schema.String)),
    folder: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    scan: Schema.NullOr(VideoProjectScanIntakeResult),
    importing: Schema.NullOr(Schema.Struct({ files: Schema.Number, folder: Schema.String })),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Scan or import footage")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const VideoToolkit = Toolkit.make(
  TimelineReadTool,
  TimelineEditTool,
  TimelineWordsTool,
  TranscribeTool,
  ScriptTool,
  PremiereExportTool,
  ProjectStartTool,
  PremierePullTool,
  FootageTool,
);
