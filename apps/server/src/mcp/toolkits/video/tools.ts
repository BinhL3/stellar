import {
  OrchestratorMcpFailure,
  VideoProjectCreateFromIdeaResult,
  VideoPremiereOpenResult,
  VideoPremierePushPlan,
  VideoProjectScanIntakeResult,
  VideoScriptSaveInput,
  VideoTimelineEdit,
  VideoTimelineExportResult,
  VideoTimelineView,
  VideoTimelineWords,
  VideoTimelineWordsInput,
  VideoTranscribeInput,
  VideoTranscriptStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ProjectService from "../../../project/ProjectService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as CarouselProjects from "../../../carousel/CarouselProjects.ts";
import * as FootageLog from "../../../videoProject/FootageLog.ts";
import * as VideoProjects from "../../../videoProject/VideoProjects.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProjectService.ProjectService,
  VideoProjects.VideoProjects,
  FootageLog.FootageLog,
  CarouselProjects.CarouselProjects,
];

const TimelineReadTool = Tool.make("video_timeline_read", {
  description:
    "Read this thread's video timeline: one line per clip as `track start-end #clipId name`, in whole frames. Call it first in a video thread: `project` says what footage, previews, transcripts and takes exist and whether Premiere is open and linked. Pulls Premiere's latest save first, so read before every edit; `premiere` says whether the timeline holds edits Premiere doesn't. Omit `timeline` for the main one; `timelines` lists the others, such as the footage laid end to end. After the clips come markers, `M frame #markerId user|agent open|done name: note` (`on #clipId` when pinned to a clip): notes at a frame. An open marker from the user is a request: do what it asks, then resolve it with `video_timeline_edit`. Every change to a timeline is kept as a version: `version: \"list\"` lists them newest first, and a version id reads that version, with `changes` saying what differs from now. `version: \"edits\"` lists your edits as `E<n> version state: summary` with the user's decision on each (kept, undone): read it when the user names an edit such as E3 or a read ends with undone edits, and never redo an undone edit unasked.",
  parameters: Schema.Struct({
    timeline: Schema.optional(Schema.String),
    version: Schema.optional(Schema.String),
  }),
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
    "Edit a timeline in Stellar. `edits` run in order, in whole frames, naming clips by `#clipId` from `video_timeline_read`: move (clipId, toTrack, startFrame; `magnetic` closes the gap and pushes clips instead of overwriting), trim (clipId, edge, frame), rippleTrim (clipId, edge, frame: trims, then moves everything after the clip on every track by the change), roll (clipId, edge, frame: moves the cut at that edge; its neighbour trims the other way), slip (clipId, frames: plays media that many frames later, earlier when negative, in place), slide (clipId, frames: moves along its track; its neighbours trim to keep the cuts closed). These four take the linked sound or picture along and stop where the media runs out. insert and overwrite (media, toTrack, startFrame) put a clip of a project media file (footage, b-roll, a voice-over or a range of one) on a track: `media` is its path in the project folder or its file name, `sourceIn`/`sourceOut` the seconds of it to use (all of it when omitted), or `duration` in frames; a photo plays 5 s unless given a duration. insert moves everything from startFrame later by the clip's length on every track (only on toTrack and `tracks` when given), cutting what crosses it; overwrite covers what is there. A video's sound goes on `audioTrack`, linked (the first audio track when omitted, `none` for picture only); a track that doesn't exist yet, such as A2, is made. Media the project doesn't have is refused: import it first. delete, rippleDelete, split (frame, tracks), removeRange (start, end, ripple), removeWords (fromWord, toWord, ripple), trimPause (afterWord; `leave` seconds to keep, 0.25 when omitted; closes up unless `ripple` is false), setEnabled, setText, addMarker (frame, name, note; optional duration in frames, color, and clipId to pin it to that clip's picture), setMarker (markerId; any of frame, duration, name, note, color, resolved), removeMarker (markerId). Leave a marker to flag a frame for the user; when you have dealt with a user's marker, set `resolved` true and say what you did in `note` rather than removing it. restoreVersion (version, from `video_timeline_read` with `version: \"list\"`) brings a version back as a new version and must be the only edit in its call; what the user changed in Premiere since stays. A split's later piece is `<clipId>~<frame>`. Cut speech by word, not by frame: removeWords and trimPause take word numbers from `video_timeline_words` as they were before this call, so one call can hold several; put them before other edits. Stellar measures the audio and puts each of their edges on the quietest point between the words, and `cuts` reports every one: the frames removed, the level at each edge in dBFS, and how far it moved. An edit that would start or end a clip inside a word while it sounds is refused, naming the word and the nearest quiet point: redo it by word or at that point. One bad edit refuses the whole call. Edits change Stellar's timeline only; `video_premiere_push` plans how to make them in the Premiere sequence it came from, and `video_premiere_export` sends a first cut as a new sequence. `summary` says in one sentence what this call did and where: the user reviews each call as a numbered edit (E1, E2…) to keep, undo or send back, so make one call per change they would judge on its own. Set `check` only for a doubt the user must settle by watching or listening.",
  parameters: Schema.Struct({
    timeline: Schema.String,
    edits: Schema.Array(VideoTimelineEdit),
    summary: Schema.String,
    check: Schema.optional(Schema.String),
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
    "What is said on a timeline, read one of three ways. By default the words, to cut by: per audio clip, each transcribed word as `index:word@startFrame`. A gap of 0.4 s or more says what the audio holds: `(0.82s quiet)`, or `(1.70s, 0.60s sound @410-446)` for sound at speaking level that no word explains, at those frames, so it is not only a pause. Cut by these numbers with `video_timeline_edit` (removeWords, trimPause); they change after every edit, so read again before cutting more. Transcripts come from the project's `Audio/<clip>.words.json`; clips without one say so, and `video_transcribe` makes them. `action: \"joins\"` checks your cuts: every join as heard, with the level at each edge, flagging a word clipped while it sounds, words said twice across the join and its pause, then the pauses inside clips of `pauseOver` seconds or more (0.75 when omitted). Read it after cutting and fix what is flagged. `from` pages both: the first word, or the first joins line, to read. `picture`, in place of `action`, draws a passage, since you can't hear it: waveform over spectrogram, each word at its start. Give `fromWord`/`toWord` or `start`/`end` frames (15 seconds at most); `cutFromWord`/`cutToWord` or `cutStart`/`cutEnd` add a row with that range removed and closed up, a word cut where removeWords would land it, to check a cut doesn't clip a word or leave a breath before you make it. `text` is then a caption and `picture` the image's path: open it with your file or image tool.",
  parameters: Schema.Struct({
    timeline: Schema.optional(Schema.String),
    action: VideoTimelineWordsInput.fields.action,
    from: VideoTimelineWordsInput.fields.from,
    pauseOver: VideoTimelineWordsInput.fields.pauseOver,
    picture: Schema.optional(
      Schema.Struct({
        fromWord: Schema.optional(Schema.Number),
        toWord: Schema.optional(Schema.Number),
        start: Schema.optional(Schema.Number),
        end: Schema.optional(Schema.Number),
        cutFromWord: Schema.optional(Schema.Number),
        cutToWord: Schema.optional(Schema.Number),
        cutStart: Schema.optional(Schema.Number),
        cutEnd: Schema.optional(Schema.Number),
      }),
    ),
  }),
  success: Schema.Struct({
    ...VideoTimelineWords.fields,
    picture: Schema.optional(Schema.String),
  }),
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
    "Make word-timed transcripts for this thread's video project, so its clips can be cut by words. Call it when `video_timeline_words` shows clips with `(no transcript)`. Returns at once while the host's transcriber works through the files in the background, tens of seconds each: `building` counts the run, `ready` of `total` footage clips and voice-over takes have a transcript, `failed` lists files it couldn't do. Call again later to see progress, then read the words again. Omit `files` to do everything without a transcript, or name files relative to the project folder; `language` (en or vi) when the user says what is spoken; the project keeps it for later runs. When `unavailable` is set nothing was transcribed: tell the user what it says. If it is that the language isn't set, ask the user what is spoken unless they already said; never guess it.",
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
    "Read or refresh this project's script snapshot. The script lives in the user's own doc, such as a Google Doc; Stellar keeps only a snapshot split into beats (spoken lines; headings, metadata and [bracketed] visual notes are left out) and finds where each beat is said on a timeline. With no arguments it reads: `text` has one line per beat, `b4 words 120-141 frames 1830-2104: <line>` or `b5 not on the timeline: <line>`. The word numbers are `video_timeline_words` numbers, so they go straight into `video_timeline_edit` removeWords, and like them they change after every edit: read again before cutting more. To refresh the snapshot, read the doc with a Docs tool, else open it with `preview_open` and read it there, then pass its whole text (Markdown or plain) as `text` and its link as `docUrl`. `docUrl` in the result is the doc recorded so far; to show the user the script, open it with `preview_open` instead of pasting it. A pre-recorded short may have no script. Beats keep their ids when their wording is the same or lightly edited. When reading, `timeline` picks the timeline to place beats on; omit it for the main one, which a save always answers with.",
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

const VoiceOverTool = Tool.make("video_voice_over", {
  description:
    "Voice-over per script line. Each line (a beat; ids from `video_script`) has takes, recordings of that line, and uses one of them. With no `action` it reads: `text` has a line per beat, `b2 take t5 2.4s on A3 frames 90-162 (takes t2 t5): <line>`, `b3 take t6 3.0s chosen, not on the timeline (takes t6): <line>` or `b4 no voice-over: <line>`, then recordings in Audio/VO that belong to no line. `choose` (beatId, takeId) picks a line's take. `import` (beatId, path) copies an audio file on the host in as a new take and chooses it. `split` (path) cuts a transcribed recording of several lines into a take per line it says, each chosen. These three change no timeline. `apply` (timeline, and `beatIds` to do only some lines) puts each chosen take on the timeline and re-times only the lines whose take changed: cut points under the line scale to the new length and everything after it moves by the difference; other lines keep their content and length. Clips keep their in point and are never cut; one with no more source to stretch into leaves a gap. A line with no voice-over yet goes after the previous line's, moving nothing unless the next line's is in the way. `changes` says what moved and what was left short or refused: tell the user. You can't record: the user records with the timeline's Record voice-over button and gives you the file to `split` or `import`.",
  parameters: Schema.Struct({
    action: Schema.optional(Schema.Literals(["read", "choose", "import", "split", "apply"])),
    beatId: Schema.optional(Schema.String),
    takeId: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
    timeline: Schema.optional(Schema.String),
    beatIds: Schema.optional(Schema.Array(Schema.String)),
  }),
  success: Schema.Struct({
    timeline: Schema.NullOr(Schema.String),
    text: Schema.String,
    changes: Schema.Array(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read or place voice-over")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const PremiereExportTool = Tool.make("video_premiere_export", {
  description:
    "Send a first cut to Premiere as a new sequence; when the sequence already exists in Premiere, use `video_premiere_push`, which keeps its effects and polish. Writes the timeline as an XML file in the project's Premiere folder and returns the `path`. Import that file with a Premiere tool; it arrives as a new sequence named `sequenceName`, never replacing one. Only the cut travels (tracks, positions, source ranges, enabled state). Effects, text graphics and clips without a media file are left out and listed in `skipped`: tell the user what didn't come across.",
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

const PremierePushTool = Tool.make("video_premiere_push", {
  description:
    "Plan how to bring the sequence open in Premiere up to the timeline edited in Stellar, changing only what differs so effects, titles and hand polish stay. Use this, not `video_premiere_export`, whenever the sequence already exists in Premiere. Changes nothing itself: `plan` is numbered steps (add a track, ripple-remove a range, split, insert or overwrite a clip of a media file, remove, trim, move, enable or disable, then markers to add, change or remove) in seconds and frames, each at the position it has when that step runs. Apply them in order with the Premiere tools, importing a step's media into the Premiere project first when it isn't there, and reading clip ids from the sequence again after each step; then save the project in Premiere and call `video_timeline_read`, whose `premiere` is `current` once Premiere matches and whose `changes` say what still differs. `manual` lists what no step does (effects, text, the mix): do what your Premiere tools can, yourself. When `refused` is set there is no plan: it says why, such as Premiere holding a newer save to pull first. When `premiereRunning` is false, call `video_premiere_open` and continue once Premiere answers. `instructions` repeats what applies to this plan.",
  parameters: Schema.Struct({ timeline: Schema.optional(Schema.String) }),
  success: VideoPremierePushPlan,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Plan the push to Premiere")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PremiereOpenTool = Tool.make("video_premiere_open", {
  description:
    "Open this project's Premiere project in Premiere Pro on the machine running Stellar, or bring it to the front when it is open, then wait up to a minute for Premiere to start. Call it yourself whenever the work needs Premiere and it isn't open (`premiereRunning` false, or the read says Premiere is NOT open): never ask the user to open it. While Premiere runs and the user's Premiere tools are connected, their open_project does the same. `next` says what to check before going on: a project takes a while to load, so check with a Premiere tool that it answers with this project. Refused, saying why, when no Premiere project is linked or found, Premiere isn't installed, or the host can't run it.",
  parameters: Tool.EmptyParams,
  success: VideoPremiereOpenResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Open the project in Premiere")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ProjectStartTool = Tool.make("video_project_start", {
  description:
    "Start a video project from an idea, before footage or a Premiere project exists. Makes `<parentFolder>/<title>` with Footage, Audio, B-roll, Graphics, Premiere, Exports and Stellar folders and adds it as a project. Omit `parentFolder` unless the user names a folder: it defaults to the user's projects folder. Save the Premiere project into its Premiere folder later, then `video_premiere_pull`.",
  parameters: Schema.Struct({
    title: Schema.String,
    parentFolder: Schema.optionalKey(Schema.String),
  }),
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
    "Bring footage into this thread's video project. `scan` lists videos and photos that arrived in the host's Downloads in the last few days (AirDrop keeps camera dates, so this goes by date added). `import` copies the `paths` the user approved into `Footage/<folder>`, size-checked, in the background, then builds previews and a Footage timeline, then reads and describes each clip for `video_footage_log`; originals stay in Downloads. Show the scan and get the user's approval before importing. An import also makes a whole constant 59.94 copy (`<name>_5994.mov`, about 6 MB per second) of any clip that switches frame rate partway; `conform` does the same for footage that arrived another way, so ask first.",
  parameters: Schema.Struct({
    action: Schema.Literals(["scan", "import", "conform"]),
    paths: Schema.optional(Schema.Array(Schema.String)),
    folder: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    scan: Schema.NullOr(VideoProjectScanIntakeResult),
    importing: Schema.NullOr(Schema.Struct({ files: Schema.Number, folder: Schema.String })),
    conforming: Schema.optional(
      Schema.Struct({ files: Schema.Array(Schema.String), megabytes: Schema.Number }),
    ),
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

const FootageLogTool = Tool.make("video_footage_log", {
  description:
    "What each footage clip shows, to choose shots and b-roll by picture as well as by what is said. Read it before placing footage you haven't seen. One block per clip: `note`, the user's own words on the clip, which win over everything else; `seen`, what a model saw on the clip's contact sheet, then its stretches as `m:ss.s-m:ss.s place · subject · action`, marked UNUSABLE with why; `picture`, measured camera movement by stretch (static, handheld, on the move, pan, tilt, push in, pull out, fast motion; dark, covered, shaky) and cuts; `sheet`, the contact sheet image (open it with your image tool when you need to see the clip); `said`, the transcript. Times are seconds into the clip, for `sourceIn`/`sourceOut` of an insert with `video_timeline_edit`. Without `clips` every clip comes in brief; name clips by path, file name or folder for every stretch and the whole transcript. Stellar reads and describes footage in the background after import; the first line says what is still being done. When the user says what a clip is or where it was shot, save it with `action: \"note\"`, `clip` and `note`, in their words, not your guesses; an empty note removes it.",
  parameters: Schema.Struct({
    action: Schema.optional(Schema.Literals(["read", "note"])),
    clips: Schema.optional(Schema.Array(Schema.String)),
    clip: Schema.optional(Schema.String),
    note: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    text: Schema.String,
    pending: Schema.Struct({ picture: Schema.Number, description: Schema.Number }),
    unavailable: Schema.NullOr(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read the footage log")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RenderCheckTool = Tool.make("video_render_check", {
  description:
    "Check the video exported from Premiere against a timeline; a short is done when this passes, not when it looked right in playback. Stellar can't export: the user (or a Premiere tool) exports into the project's Exports folder first. Omit `exportPath` for the newest video there, or name a file (absolute, or relative to the project folder); omit `timeline` for the main one. `report` has one line per check as `pass|warn|fail Title: detail`, with places as `m:ss.ff (frame n)` of the export: resolution, frame rate and length against the sequence (one frame of slack), codecs, audio, black frames, frozen picture and silences the timeline doesn't explain, loudness against -14 LUFS and true peak against -1 dBTP, cuts between different clips that don't show within one frame, and flash frames. `level` is the worst of them. `contactSheet` is the path of an image of the whole export: frames spread evenly plus the frame after each timeline cut, each labelled with its frame number and time, cuts and flashes tagged. Open that image with your file or image tool and look at it before you call the export good. Fix what failed in the timeline or in Premiere, have it exported again, and check again.",
  parameters: Schema.Struct({
    timeline: Schema.optional(Schema.String),
    exportPath: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    level: Schema.Literals(["pass", "warn", "fail"]),
    timeline: Schema.String,
    exportPath: Schema.String,
    report: Schema.String,
    contactSheet: Schema.NullOr(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Check the export")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PreflightTool = Tool.make("video_preflight", {
  description:
    "Where this short's run stands, from footage to posted: one line per step as `done|working|todo|warn|fail Step: detail (tool that moves it on)`. Steps: footage imported, previews, transcripts, Premiere project linked, in sync with Premiere, render check (warns when the timeline or the export changed since the check), posted. Reads only what the project records; it pulls nothing from Premiere, so `video_timeline_read` is still the first call of a turn. `contactSheet` is the last render check's image, or null; `posted` is the posted record, or null.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    steps: Schema.String,
    contactSheet: Schema.NullOr(Schema.String),
    posted: Schema.NullOr(
      Schema.Struct({ on: Schema.NullOr(Schema.String), urls: Schema.Array(Schema.String) }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read the run's steps")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PostedTool = Tool.make("video_posted", {
  description:
    "Record that this short is posted, once the user says it is up: `posted` true with the post `urls` (one per platform, when you have them) and `postedOn` as YYYY-MM-DD when it wasn't today. `posted` false takes the record back. This writes Stellar's project only. Stellar never writes to Google: after recording, set this video's row in the user's video catalog (their Google Sheet) to Posted with the link through their Google connector, and read the row back to confirm; `next` repeats this.",
  parameters: Schema.Struct({
    posted: Schema.Boolean,
    urls: Schema.optional(Schema.Array(Schema.String)),
    postedOn: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    posted: Schema.NullOr(
      Schema.Struct({ on: Schema.NullOr(Schema.String), urls: Schema.Array(Schema.String) }),
    ),
    next: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Record the short as posted")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RecipeTool = Tool.make("video_recipe", {
  description:
    "Stellar's built-in edit recipes: how to do an edit style with these tools, its default numbers, and what to finish in Premiere. Without `name`, lists them as `name: when to use it`; with one, returns that recipe to follow.",
  parameters: Schema.Struct({ name: Schema.optional(Schema.String) }),
  success: Schema.Struct({ text: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read an edit recipe")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const VideoToolkit = Toolkit.make(
  TimelineReadTool,
  TimelineEditTool,
  TimelineWordsTool,
  TranscribeTool,
  ScriptTool,
  VoiceOverTool,
  PremiereExportTool,
  PremierePushTool,
  PremiereOpenTool,
  ProjectStartTool,
  PremierePullTool,
  FootageTool,
  FootageLogTool,
  RenderCheckTool,
  PreflightTool,
  PostedTool,
  RecipeTool,
);
