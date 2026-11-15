import {
  CommandId,
  ProjectId,
  type VideoProjectCreateFromIdeaInput,
  type VideoProjectCreateFromIdeaResult,
  type VideoProjectsFolderResult,
  type VideoProjectCreateInput,
  type VideoProjectCreateResult,
  type VideoProjectImportFootageInput,
  type VideoProjectInspectPremiereInput,
  type VideoProjectInspectPremiereResult,
  type VideoProjectIntakeStatus,
  type VideoProjectSaveVoiceOverInput,
  type VideoProjectSaveVoiceOverResult,
  type VideoProjectScanIntakeInput,
  type VideoProjectScanIntakeResult,
  type VideoProjectSyncInput,
  type VideoPremiereOpenInput,
  type VideoPremiereOpenResult,
  type VideoPremierePushPlan,
  type VideoProjectSyncResult,
  type VideoScriptReadInput,
  type VideoScriptSaveInput,
  type VideoScriptView,
  type VideoTimelineEdit,
  type VideoTimelineEditInput,
  type VideoTimelineExportResult,
  type VideoTimelineReadInput,
  type VideoTimelineRestoreInput,
  type VideoTimelineEdits,
  type VideoTimelineRestoreResult,
  type VideoTimelineReviewEditInput,
  type VideoTimelineReviewEditResult,
  type VideoTimelineCommitInput,
  type VideoTimelineVersionReadInput,
  type VideoTimelineVersions,
  type VideoTimelineVersionsInput,
  type VideoTimelineVersionView,
  type VideoTimelineView,
  type VideoTimelineWords,
  type VideoTimelineWordsInput,
  type VideoTranscribeInput,
  type VideoTranscriptStatus,
  type VideoVoiceOverApplyInput,
  type VideoVoiceOverReadInput,
  type VideoVoiceOverSaveTakeInput,
  type VideoVoiceOverSplitInput,
  type VideoVoiceOverTakeInput,
  type VideoVoiceOverView,
} from "@t3tools/contracts";
import {
  VideoProjectIntakeStatus as IntakeStatusSchema,
  type VideoPreflight,
  type VideoPreflightInput,
  type VideoRenderCheckInput,
  type VideoRenderReport,
  type VideoSetPostedInput,
} from "@t3tools/contracts";
import { derivePreflight, preflightHeadline, preflightLine } from "@t3tools/timeline/preflight";
import { premiereLinkStatus } from "@t3tools/timeline/premiereSync";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveCommandPath } from "@t3tools/shared/shell";
import { editableView } from "@t3tools/timeline/compactView";
import {
  conformedMegabytes,
  conformSummary,
  mediaKey,
  type MediaIndex,
} from "@t3tools/timeline/conform";
import {
  loadFrameTimes,
  prepareFootage,
  readConformState,
  readMediaIndex,
} from "@t3tools/timeline/conformBuilder";
import { changeLine, diffSentences, diffTimelines } from "@t3tools/timeline/diff";
import {
  applyEdits,
  editClipId,
  type MediaFacts,
  type Placement,
  placementProblem,
  STILL_PATH,
  type TimelineEdit,
} from "@t3tools/timeline/edits";
import {
  auditJoins,
  clippedEdgeReason,
  clippedEdges,
  joinAuditText,
  placePauseCut,
  placeWordCut,
  type SourceEdge,
} from "@t3tools/timeline/joins";
import type { AudioLevels } from "@t3tools/timeline/levels";
import { timelineMarkers } from "@t3tools/timeline/markers";
import {
  copyFootage,
  listFootage,
  FOOTAGE_DIRECTORY,
  cutFromFootage,
  FOOTAGE_TIMELINE_PATH,
  ROUGH_CUT_TIMELINE_PATH,
  writeFootageStringout,
} from "@t3tools/timeline/footage";
import { layoutTimeline } from "@t3tools/timeline/layout";
import {
  serializeJson,
  serializeTimeline,
  type Timeline,
  TIMELINE_NAMESPACE,
} from "@t3tools/timeline/otio";
import { toFcpXml } from "@t3tools/timeline/premiere/fcpxml";
import { parsePrproj } from "@t3tools/timeline/premiere/prproj";
import { pushPlan as planPush } from "@t3tools/timeline/premiere/pushPlan";
import {
  PREMIERE_LINK_PATH,
  type PremiereSyncResult,
  pulledHash,
  readBase,
  recordPull,
  type SequenceChange,
  syncFromPremiere,
  type TimelineChanges,
} from "@t3tools/timeline/premiereSync";
import { PROXY_INDEX_PATH, type ProxyIndex } from "@t3tools/timeline/proxies";
import { buildProjectProxies, markProxiesBuilding } from "@t3tools/timeline/proxyBuilder";
import { pullToProject } from "@t3tools/timeline/pullToProject";
import { alignBeats, assignBeatIds, parseScript } from "@t3tools/timeline/script";
import {
  addTake,
  chooseTake as chooseIndexedTake,
  nextTakeId,
  placedVoiceOver,
  placeTake,
  sliceByBeats,
} from "@t3tools/timeline/voiceOver";
import type { SoundPictureRequest } from "@t3tools/timeline/soundPicture";
import { timelineWords, type TranscriptWord, wordsText } from "@t3tools/timeline/words";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { findPremiereApp } from "./PremiereApp.ts";
import { parentFolderFor, resolveProjectsFolder } from "./ProjectsFolder.ts";
import {
  newestExport,
  readPosted,
  readRenderReport,
  renderStaleness,
  runRenderCheck,
  writePosted,
} from "./RenderCheck.ts";
import { ensureLevels, NO_FFMPEG } from "./AudioLevels.ts";
import { drawSoundPicture } from "./SoundPicture.ts";
import {
  decodeTranscript,
  findTranscript,
  projectLanguage,
  runTranscription,
  TRANSCRIPT_FOLDER,
  transcriptCoverage,
  writeTranscriptStatus,
} from "./Transcriber.ts";
import { encodeTake, readTakeIndex, TAKE_FOLDER, writeTakeIndex } from "./VoiceOverTakes.ts";
import {
  commitFromClient,
  commitTimelineText,
  editsLine,
  editsText,
  listTimelineEdits,
  listTimelineVersions,
  readTimelineVersion,
  restoreTimelineVersion,
  reviewTimelineEdit,
  versionsText,
} from "./TimelineHistory.ts";

export class VideoProjectError extends Schema.TaggedError<VideoProjectError>()(
  "VideoProjectError",
  {
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeIntakeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(IntakeStatusSchema));
// What the host's transcriber is called when no command is set in settings.
const DEFAULT_TRANSCRIBE_COMMAND = "stt";

/** The script snapshot in the project folder: the text, and beside it the ids its beats were given. */
const SCRIPT_FILE = "script.md";
const SCRIPT_INDEX_FILE = "script.json";
const ScriptIndex = Schema.Struct({
  docUrl: Schema.NullOr(Schema.String),
  savedAt: Schema.NullOr(Schema.Number),
  beats: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
  nextId: Schema.Number,
});
const decodeScriptIndex = Schema.decodeUnknownEffect(Schema.fromJsonString(ScriptIndex));
const NO_SCRIPT: typeof ScriptIndex.Type = { docUrl: null, savedAt: null, beats: [], nextId: 1 };

type FrameRange = { readonly start: number; readonly end: number };

/** The edits that can leave a clip starting or ending somewhere new. */
const EDGE_MAKING_EDITS: ReadonlySet<VideoTimelineEdit["kind"]> = new Set([
  "move",
  "trim",
  "delete",
  "rippleDelete",
  "rippleTrim",
  "roll",
  "slip",
  "slide",
  "removeRange",
  "setEnabled",
  "insert",
  "overwrite",
]);

const HANDLE_EDITS: ReadonlySet<TimelineEdit["kind"]> = new Set([
  "rippleTrim",
  "roll",
  "slip",
  "slide",
]);

// A split names its new pieces after the clip it cut ("id~frame"), so a later edit in the same
// call can name a piece that doesn't exist until the split has run.
const isSplitPiece = (clipId: string) => clipId.includes("~");

/** The typed edit a flat tool input describes, or what is missing from it. */
const toTimelineEdit = (
  edit: VideoTimelineEdit,
  /** The frames a cut named by words removes; null when it has nothing to remove. */
  framesOfWords: (
    cut:
      | { readonly fromWord: number; readonly toWord: number }
      | { readonly afterWord: number; readonly leave: number | undefined },
    ripple: boolean,
  ) => FrameRange | string | null,
  /** Who a marker made by this edit is from. */
  author: "user" | "agent",
  /** The media file an insert or overwrite names, found in the project, or why it isn't. */
  mediaOf: (name: string) => PlacedMedia | string,
  /** The timeline's tracks, for where a placement's picture and sound go. */
  tracks: ReadonlyArray<{ readonly name: string; readonly kind: "Video" | "Audio" }>,
): TimelineEdit | string | null => {
  const missing = (...keys: ReadonlyArray<keyof VideoTimelineEdit>) =>
    `needs ${keys.filter((key) => edit[key] === undefined).join(", ")}`;
  switch (edit.kind) {
    case "move": {
      const { clipId, toTrack, startFrame } = edit;
      if (clipId === undefined || toTrack === undefined || startFrame === undefined) {
        return missing("clipId", "toTrack", "startFrame");
      }
      return {
        kind: "move",
        clipId,
        toTrack,
        startFrame,
        ...(edit.magnetic === undefined ? {} : { magnetic: edit.magnetic }),
      };
    }
    case "trim":
    case "rippleTrim":
    case "roll": {
      const { clipId, edge, frame } = edit;
      if (clipId === undefined || edge === undefined || frame === undefined) {
        return missing("clipId", "edge", "frame");
      }
      return { kind: edit.kind, clipId, edge, frame };
    }
    case "slip":
    case "slide": {
      const { clipId, frames } = edit;
      if (clipId === undefined || frames === undefined) return missing("clipId", "frames");
      return { kind: edit.kind, clipId, frames };
    }
    case "delete":
    case "rippleDelete":
      return edit.clipId === undefined
        ? missing("clipId")
        : { kind: edit.kind, clipId: edit.clipId };
    case "split":
      return edit.frame === undefined
        ? missing("frame")
        : {
            kind: "split",
            frame: edit.frame,
            ...(edit.tracks === undefined ? {} : { tracks: edit.tracks }),
          };
    case "removeRange": {
      const { start, end } = edit;
      if (start === undefined || end === undefined) return missing("start", "end");
      return { kind: "removeRange", start, end, ripple: edit.ripple ?? false };
    }
    case "removeWords": {
      const { fromWord, toWord } = edit;
      if (fromWord === undefined || toWord === undefined) return missing("fromWord", "toWord");
      const ripple = edit.ripple ?? false;
      const range = framesOfWords({ fromWord, toWord }, ripple);
      return typeof range === "string" || range === null
        ? range
        : { kind: "removeRange", ...range, ripple };
    }
    case "trimPause": {
      if (edit.afterWord === undefined) return missing("afterWord");
      // A pause trimmed and left open would only be a hole, so this closes up unless told not to.
      const ripple = edit.ripple ?? true;
      const range = framesOfWords({ afterWord: edit.afterWord, leave: edit.leave }, ripple);
      return typeof range === "string" || range === null
        ? range
        : { kind: "removeRange", ...range, ripple };
    }
    case "setEnabled": {
      const { clipId, enabled } = edit;
      if (clipId === undefined || enabled === undefined) return missing("clipId", "enabled");
      return { kind: "setEnabled", clipId, enabled };
    }
    case "setText": {
      const { clipId, text } = edit;
      if (clipId === undefined || text === undefined) return missing("clipId", "text");
      return { kind: "setText", clipId, text };
    }
    case "addMarker": {
      if (edit.frame === undefined) return missing("frame");
      if ((edit.name ?? "") === "" && (edit.note ?? "") === "") return "needs a name or a note";
      return {
        kind: "addMarker",
        frame: edit.frame,
        author,
        ...(edit.duration === undefined ? {} : { duration: edit.duration }),
        ...(edit.name === undefined ? {} : { name: edit.name }),
        ...(edit.note === undefined ? {} : { note: edit.note }),
        ...(edit.color === undefined ? {} : { color: edit.color }),
        ...(edit.clipId === undefined ? {} : { clipId: edit.clipId }),
      };
    }
    case "setMarker": {
      if (edit.markerId === undefined) return missing("markerId");
      return {
        kind: "setMarker",
        markerId: edit.markerId.replace(/^#/, ""),
        ...(edit.frame === undefined ? {} : { frame: edit.frame }),
        ...(edit.duration === undefined ? {} : { duration: edit.duration }),
        ...(edit.name === undefined ? {} : { name: edit.name }),
        ...(edit.note === undefined ? {} : { note: edit.note }),
        ...(edit.color === undefined ? {} : { color: edit.color }),
        ...(edit.resolved === undefined ? {} : { resolved: edit.resolved }),
      };
    }
    case "removeMarker":
      return edit.markerId === undefined
        ? missing("markerId")
        : { kind: "removeMarker", markerId: edit.markerId.replace(/^#/, "") };
    case "restoreVersion":
      return "a restore is the only edit in its call";
    case "insert":
    case "overwrite": {
      const { media, toTrack, startFrame } = edit;
      if (media === undefined || toTrack === undefined || startFrame === undefined) {
        return missing("media", "toTrack", "startFrame");
      }
      const found = mediaOf(media);
      if (typeof found === "string") return found;
      const kindOf = (name: string) => tracks.find((track) => track.name === name)?.kind;
      // A file with picture puts its picture on toTrack, unless toTrack is for sound.
      const soundOnly =
        !found.facts.picture ||
        (kindOf(toTrack) ?? (/^A\d+$/i.test(toTrack) ? "Audio" : "Video")) === "Audio";
      const firstAudio = tracks.find((track) => track.kind === "Audio")?.name ?? "A1";
      const audioTrack = soundOnly
        ? toTrack
        : !found.facts.sound || edit.audioTrack === "none"
          ? undefined
          : (edit.audioTrack ?? firstAudio);
      const placement: Placement = {
        kind: edit.kind,
        media: found.target,
        startFrame,
        ...(soundOnly ? {} : { videoTrack: toTrack }),
        ...(audioTrack === undefined ? {} : { audioTrack }),
        ...(edit.sourceIn === undefined ? {} : { sourceIn: edit.sourceIn }),
        ...(edit.sourceOut === undefined ? {} : { sourceOut: edit.sourceOut }),
        ...(edit.duration === undefined ? {} : { frames: edit.duration }),
        ...(edit.tracks === undefined ? {} : { rippleTracks: edit.tracks }),
        ...(edit.name === undefined ? {} : { name: edit.name }),
      };
      return placement;
    }
  }
};

interface PlacedMedia {
  /** As timelines name it: relative to the media root. */
  readonly target: string;
  readonly facts: MediaFacts;
}

const PLACING_EDITS: ReadonlySet<VideoTimelineEdit["kind"]> = new Set(["insert", "overwrite"]);

const sequenceSentence = (change: SequenceChange) =>
  change.kind === "added"
    ? `New sequence: ${change.name}${change.timelinePath === null ? " (not pulled: it can't be read, or a timeline already has its file name)" : ""}`
    : change.kind === "renamed"
      ? `Sequence renamed in Premiere: ${change.before} is now ${change.name}`
      : `Sequence ${change.name} was deleted in Premiere; ${change.timelinePath} is kept here`;

const timelineLabel = (timelinePath: string) => timelinePath.replace(/^timelines\/|\.otio$/g, "");

/** A sentence per change; each names its timeline when more than one timeline has any. */
const sentencesOf = <A extends { readonly timelinePath: string }>(
  entries: ReadonlyArray<A>,
  sentences: (entry: A) => ReadonlyArray<string>,
) =>
  entries.flatMap((entry) =>
    sentences(entry).map((sentence) =>
      entries.length > 1 ? `${timelineLabel(entry.timelinePath)}: ${sentence}` : sentence,
    ),
  );

const NO_BASE =
  "Stellar has no copy of what it last pulled from Premiere to tell the two sets of edits apart.";

// Tool output stays small: a long list is cut to this many lines and a count of the rest.
const CHANGE_LINES = 12;
const capped = (lines: ReadonlyArray<string>) =>
  lines.length <= CHANGE_LINES
    ? lines
    : [...lines.slice(0, CHANGE_LINES), `+${lines.length - CHANGE_LINES} more`];

/** What a sync found, as an agent reads it: lines in `editableView`'s vocabulary under headings. */
const changesText = (synced: PremiereSyncResult) => {
  const section = (heading: string, entries: ReadonlyArray<TimelineChanges>) =>
    entries.flatMap((entry) => [
      `${heading} (${entry.timelinePath}):`,
      ...capped(entry.diff.changes.map(changeLine)),
    ]);
  return [
    ...synced.sequences.map(sequenceSentence),
    ...section("Changed in Premiere since your last read", synced.changes),
    ...synced.conflicts.flatMap((entry) => [
      `Edits made here that were dropped, Premiere's version stands (${entry.timelinePath}):`,
      ...capped(entry.conflicts.map((conflict) => conflict.message)),
    ]),
    ...synced.unmerged.map(
      (timelinePath) =>
        `! ${timelinePath} was edited here and in Premiere and can't be merged: ${NO_BASE} The user chooses a version in Stellar.`,
    ),
    ...section(
      "Edited here, not in Premiere yet",
      synced.pending.filter((entry) => !synced.unmerged.includes(entry.timelinePath)),
    ),
  ].join("\n");
};

/** Stellar's own files for a video project sit in this folder beside the Premiere project. */
const STELLAR_FOLDER = "Stellar";
/**
 * What a project folder starts with. A Premiere project saved into `Premiere` is then found
 * from the Stellar folder beside it, the same layout `mediaRootFor` reads.
 */
const PROJECT_FOLDERS = [
  "Footage",
  "Audio",
  "B-roll",
  "Graphics",
  "Premiere",
  "Exports",
  `${STELLAR_FOLDER}/timelines`,
];
// Proxies are encoded a few files at a time so a big import doesn't starve the machine.
const PROXY_CONCURRENCY = 3;
/** Progress of a footage import, in the project folder; clients re-read it while it copies. */
const INTAKE_STATUS_FILE = "intake.json";
// How far back a scan looks for files that arrived in Downloads.
const INTAKE_DAYS = 3;
const INTAKE_FILE = /\.(mov|mp4|m4v|heic|jpe?g|png)$/i;

export class VideoProjects extends Context.Service<
  VideoProjects,
  {
    readonly inspectPremiere: (
      input: VideoProjectInspectPremiereInput,
    ) => Effect.Effect<VideoProjectInspectPremiereResult, VideoProjectError>;
    /**
     * Pulls a sequence into the project folder beside the Premiere project, adds (or reuses) the
     * project, and starts building proxies in the background; the player falls back to the
     * original files until they are ready.
     */
    readonly createFromPremiere: (
      input: VideoProjectCreateInput,
    ) => Effect.Effect<VideoProjectCreateResult, VideoProjectError>;
    /**
     * Starts a video project from an idea, before any footage or Premiere project exists:
     * makes the project's folders and adds the project, so the script and intake have a home.
     */
    readonly createFromIdea: (
      input: VideoProjectCreateFromIdeaInput,
    ) => Effect.Effect<VideoProjectCreateFromIdeaResult, VideoProjectError>;
    /** Where new projects go when no folder is chosen, and whether one can be made there now. */
    readonly projectsFolder: Effect.Effect<VideoProjectsFolderResult>;
    /** Lists the videos and photos that recently arrived in the host's Downloads folder. */
    readonly scanIntake: (
      input: VideoProjectScanIntakeInput,
    ) => Effect.Effect<VideoProjectScanIntakeResult, VideoProjectError>;
    /**
     * Copies scanned files into the project's Footage folder in the background, checking each
     * copy's size, then builds proxies. The originals are left where they are. Progress is
     * written to `intake.json` in the project folder.
     */
    readonly importFootage: (
      input: VideoProjectImportFootageInput,
    ) => Effect.Effect<void, VideoProjectError>;
    /**
     * Makes whole constant-rate copies of the footage that switches frame rate partway, in the
     * background, reporting to `intake.json`. An import does this by itself; this is for
     * footage that reached the project another way. Returns what it will conform.
     */
    readonly conformFootage: (input: {
      readonly workspaceRoot: string;
    }) => Effect.Effect<
      { readonly files: ReadonlyArray<string>; readonly megabytes: number },
      VideoProjectError
    >;
    /**
     * Pulls Premiere's latest save into the project's timelines when the `.prproj` changed, and
     * (re)starts the proxy build when new media arrived or an earlier build never finished.
     * Cheap enough to call whenever a client comes back into focus.
     */
    readonly sync: (
      input: VideoProjectSyncInput,
    ) => Effect.Effect<VideoProjectSyncResult, VideoProjectError>;
    /**
     * Saves a voice-over recorded in a client as a 48 kHz WAV under `Audio/VO`, the form
     * Premiere imports; browsers record WebM or MP4 audio, which it doesn't.
     */
    readonly saveVoiceOver: (
      input: VideoProjectSaveVoiceOverInput,
    ) => Effect.Effect<VideoProjectSaveVoiceOverResult, VideoProjectError>;
    /**
     * Writes a timeline as an XML file in the project's Premiere folder, which Premiere imports
     * as a new sequence. Only the cut travels; what can't is listed in `skipped`.
     */
    readonly exportForPremiere: (
      input: VideoTimelineReadInput,
    ) => Effect.Effect<VideoTimelineExportResult, VideoProjectError>;
    /**
     * The ordered steps that change the sequence open in Premiere into the timeline edited
     * here, touching only what differs from Premiere's last save. Nothing is changed: an agent
     * applies the steps with its Premiere tools. Refused while Premiere holds a newer save.
     */
    readonly pushPlan: (
      input: VideoTimelineReadInput,
    ) => Effect.Effect<VideoPremierePushPlan, VideoProjectError>;
    /**
     * Opens the project's `.prproj` in Premiere Pro on the host, or brings it forward when it is
     * open, then waits a while for Premiere to be running. Refused where Premiere doesn't run.
     */
    readonly openInPremiere: (
      input: VideoPremiereOpenInput,
    ) => Effect.Effect<VideoPremiereOpenResult, VideoProjectError>;
    /** A timeline as an agent reads it, synced with Premiere first so it is never stale. */
    readonly readTimeline: (
      input: VideoTimelineReadInput,
    ) => Effect.Effect<VideoTimelineView, VideoProjectError>;
    /**
     * Applies edits to a timeline file and returns the result. Edits that name a missing clip
     * or leave out a field their kind needs are refused, and nothing is written.
     */
    readonly editTimeline: (
      input: VideoTimelineEditInput & { readonly by?: "user" | "agent" },
    ) => Effect.Effect<VideoTimelineView, VideoProjectError>;
    /**
     * Writes a timeline edited in a client and records it as the user's version. Every write of
     * a timeline (a commit, an agent's edit, a pull or merge, a voice-over placement, a restore)
     * is a version, so any of them can be stepped back from.
     */
    readonly commitTimeline: (
      input: VideoTimelineCommitInput,
    ) => Effect.Effect<VideoTimelineVersions, VideoProjectError>;
    readonly listVersions: (
      input: VideoTimelineVersionsInput,
    ) => Effect.Effect<VideoTimelineVersions, VideoProjectError>;
    /** One version's text and what changed since. Changes nothing. */
    readonly readVersion: (
      input: VideoTimelineVersionReadInput,
    ) => Effect.Effect<VideoTimelineVersionView, VideoProjectError>;
    /**
     * Brings a version back, or steps one undo or redo, as a new version. Premiere's latest
     * save is merged first, and a version made on an earlier save has its own edits re-applied
     * on the latest, so what the user did in Premiere since is never discarded.
     */
    readonly restoreVersion: (
      input: VideoTimelineRestoreInput & {
        readonly by?: "user" | "agent";
        readonly review?: { readonly summary: string; readonly check?: string };
      },
    ) => Effect.Effect<VideoTimelineRestoreResult, VideoProjectError>;
    /** The agent edits that carry a summary, newest first, with what the user decided on each. */
    readonly listEdits: (
      input: VideoTimelineVersionsInput,
    ) => Effect.Effect<VideoTimelineEdits, VideoProjectError>;
    /**
     * The user's decision on one edit: keep it, take just it out or put it back, or go back to
     * the version before it. Taking one edit out never disturbs a later one: when they touch
     * the same thing nothing changes and `blocked` says why. Premiere's latest save is merged first.
     */
    readonly reviewEdit: (
      input: VideoTimelineReviewEditInput,
    ) => Effect.Effect<VideoTimelineReviewEditResult, VideoProjectError>;
    /**
     * The words spoken on a timeline, numbered and placed in frames, from the transcripts
     * `transcribe` or the user's own pipeline wrote under `Audio`.
     */
    readonly readWords: (
      input: VideoTimelineWordsInput,
    ) => Effect.Effect<VideoTimelineWords, VideoProjectError>;
    /**
     * Draws a passage's sound for an agent that can't hear it: waveform over spectrogram with
     * the words at their frames, and with a cut, the passage again as the cut would leave it.
     * Returns the image's path in the project folder's `render/sound/` and a caption.
     */
    readonly soundPicture: (input: {
      readonly workspaceRoot: string;
      readonly timeline?: string | undefined;
      readonly request: SoundPictureRequest;
    }) => Effect.Effect<
      { readonly timeline: string; readonly picture: string; readonly caption: string },
      VideoProjectError
    >;
    /**
     * Starts the host's transcriber on the footage and voice-over takes that have no word-timed
     * transcript, in the background, and returns where that stands. A request made while a run
     * is going is taken up when it ends. With no transcriber, says so in `unavailable`.
     */
    readonly transcribe: (
      input: VideoTranscribeInput,
    ) => Effect.Effect<VideoTranscriptStatus, VideoProjectError>;
    /**
     * The project's snapshot of the script as beats, each placed on a timeline where its words
     * are said. A project with no snapshot has no beats.
     */
    readonly readScript: (
      input: VideoScriptReadInput,
    ) => Effect.Effect<VideoScriptView, VideoProjectError>;
    /**
     * Replaces the snapshot's text and/or records the Google Doc it came from. A beat whose
     * text is the same or lightly edited keeps its id.
     */
    readonly saveScript: (
      input: VideoScriptSaveInput,
    ) => Effect.Effect<VideoScriptView, VideoProjectError>;
    /**
     * Each script line with its voice-over takes, the one it uses, and the one on a timeline.
     * Takes are WAVs under `Audio/VO`, indexed by `voiceover.json` in the project folder.
     */
    readonly readVoiceOver: (
      input: VideoVoiceOverReadInput,
    ) => Effect.Effect<VideoVoiceOverView, VideoProjectError>;
    /**
     * Copies an audio file on the host in as a take of one script line and makes it the line's
     * chosen take. Nothing on a timeline changes until it is applied.
     */
    readonly saveTake: (
      input: VideoVoiceOverSaveTakeInput,
    ) => Effect.Effect<VideoVoiceOverView, VideoProjectError>;
    readonly chooseTake: (
      input: VideoVoiceOverTakeInput,
    ) => Effect.Effect<VideoVoiceOverView, VideoProjectError>;
    /**
     * Puts each line's chosen take on a timeline and re-times only the lines that changed
     * (`placeTake`), after merging Premiere's latest save as `editTimeline` does.
     */
    readonly applyVoiceOver: (
      input: VideoVoiceOverApplyInput & { readonly by?: "user" | "agent" },
    ) => Effect.Effect<VideoVoiceOverView, VideoProjectError>;
    /**
     * Cuts a transcribed recording of several lines into one take per line it says, each
     * chosen for its line. The recording itself is kept.
     */
    readonly splitTake: (
      input: VideoVoiceOverSplitInput,
    ) => Effect.Effect<VideoVoiceOverView, VideoProjectError>;
    /**
     * Compares an export from Premiere with a timeline (container facts, black, frozen and
     * silent stretches, loudness, cut points), makes a contact sheet of it, and keeps both in
     * the project folder's `render/`. Without `exportPath`, the newest video in Exports.
     */
    readonly checkRender: (
      input: VideoRenderCheckInput,
    ) => Effect.Effect<VideoRenderReport, VideoProjectError>;
    /**
     * Where the short's run stands, step by step from footage to posted, read from what the
     * project folder records. Pulls nothing and writes nothing.
     */
    readonly preflight: (
      input: VideoPreflightInput,
    ) => Effect.Effect<VideoPreflight, VideoProjectError>;
    /** Records that the short is posted, with its links, or takes that back. */
    readonly setPosted: (
      input: VideoSetPostedInput,
    ) => Effect.Effect<VideoPreflight, VideoProjectError>;
  }
>()("t3/videoProject/VideoProjects") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projects = yield* ProjectService.ProjectService;
  const random = yield* SecureRandom.SecureRandom;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const background = yield* FiberSet.make();
  const syncing = yield* Semaphore.make(1);
  // One source is measured at a time, so two reads never write the same levels file at once.
  const measuring = yield* Semaphore.make(1);
  const MEASURE_WAIT_MILLIS = 20_000;
  const savingScript = yield* Semaphore.make(1);
  // Premiere's process is named for its year ("Adobe Premiere Pro 2026"); `ps` lists it on macOS
  // and Linux, `tasklist` on Windows. Where neither runs, the answer is unknown, not "closed".
  const premiereRunning = Effect.gen(function* () {
    const listing =
      (yield* HostProcess.Platform) === "win32"
        ? ChildProcess.make("tasklist", ["/FO", "CSV", "/NH"])
        : ChildProcess.make("ps", ["-axo", "comm"]);
    return /Adobe Premiere Pro/.test(yield* spawner.string(listing));
  }).pipe(Effect.orElseSucceed((): boolean | null => null));
  const building = new Set<string>();
  const importing = new Set<string>();
  const downloads = path.join(yield* HostProcess.HomeDirectory, "Downloads");
  const queued = new Set<string>();
  const settings = yield* ServerSettings.ServerSettingsService;
  const onHost = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  const readProjectsFolderSetting = settings.getSettings.pipe(
    Effect.map((current) => current.projectsFolder),
    Effect.orElseSucceed(() => ""),
  );
  const projectsFolder = readProjectsFolderSetting.pipe(
    Effect.flatMap((setting) => onHost(resolveProjectsFolder(setting))),
    Effect.withSpan("VideoProjects.projectsFolder"),
  );

  /** The host's transcriber as a file to run, or the reason there is none. */
  const resolveTranscriber = Effect.gen(function* () {
    const configured = yield* settings.getSettings.pipe(
      Effect.map((current) => current.videoTranscribeCommand),
      Effect.orElseSucceed(() => ""),
    );
    const command = yield* onHost(resolveCommandPath(configured || DEFAULT_TRANSCRIBE_COMMAND));
    if (command !== null) return { command, unavailable: null };
    return {
      command: null,
      unavailable:
        configured === ""
          ? `No transcriber on this machine: put \`${DEFAULT_TRANSCRIBE_COMMAND}\` on the PATH, or set the transcribe command in Settings.`
          : `The transcribe command set in Settings (${configured}) isn't on this machine.`,
    };
  });

  interface TranscribeRequest {
    /** Every candidate without a transcript, besides the files named. */
    readonly everything: boolean;
    readonly files: ReadonlyArray<string>;
    readonly language: VideoTranscribeInput["language"];
  }
  // Projects with a transcription run going and where each stands, and what was asked of them
  // meanwhile. Starting is serialized so two requests can't both find no run and start one.
  const transcribing = new Map<string, VideoTranscriptStatus>();
  const transcribeQueued = new Map<string, TranscribeRequest>();
  const transcribeStarting = yield* Semaphore.make(1);

  /**
   * Transcribes a project's media in the background, one run per project at a time. A request
   * that arrives mid-run is merged with any other waiting and runs when this one ends.
   */
  const startTranscripts = (
    projectFolder: string,
    request: TranscribeRequest,
  ): Effect.Effect<VideoTranscriptStatus> =>
    transcribeStarting.withPermits(1)(
      Effect.gen(function* () {
        const running = transcribing.get(projectFolder);
        if (running !== undefined) {
          const waiting = transcribeQueued.get(projectFolder);
          transcribeQueued.set(
            projectFolder,
            waiting === undefined
              ? request
              : {
                  everything: waiting.everything || request.everything,
                  files: [...waiting.files, ...request.files],
                  language: request.language ?? waiting.language,
                },
          );
          return running;
        }
        const mediaRoot = path.dirname(projectFolder);
        const coverage = yield* onHost(transcriptCoverage(mediaRoot));
        const targets = new Set(request.everything ? coverage.missing : []);
        for (const file of request.files) {
          if ((yield* onHost(findTranscript(mediaRoot, file))) === null) targets.add(file);
        }
        const transcriber = yield* resolveTranscriber;
        const idle: VideoTranscriptStatus = {
          building: null,
          ready: coverage.total - coverage.missing.length,
          total: coverage.total,
          failed: [],
          unavailable: transcriber.unavailable,
        };
        if (transcriber.command === null || targets.size === 0) {
          yield* onHost(writeTranscriptStatus(projectFolder, idle));
          return idle;
        }
        const starting = { ...idle, building: { done: 0, total: targets.size } };
        transcribing.set(projectFolder, starting);
        // Clients poll this file, so it says "building" before the first clip is done.
        yield* onHost(writeTranscriptStatus(projectFolder, starting));
        yield* FiberSet.run(
          background,
          onHost(
            runTranscription({
              projectDir: projectFolder,
              command: transcriber.command,
              language: request.language ?? (yield* onHost(projectLanguage(projectFolder))),
              targets: [...targets],
              coverage,
              onStatus: (status) =>
                Effect.sync(() => {
                  if (status.building !== null) transcribing.set(projectFolder, status);
                }),
            }),
          ).pipe(
            Effect.tap((status) =>
              Effect.logInfo("Video project transcripts ready", {
                projectFolder,
                ready: status.ready,
                total: status.total,
                failed: status.failed.length,
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("Video project transcription failed", { projectFolder, cause }),
            ),
            Effect.ensuring(
              Effect.suspend(() => {
                transcribing.delete(projectFolder);
                const next = transcribeQueued.get(projectFolder);
                transcribeQueued.delete(projectFolder);
                return next === undefined ? Effect.void : startTranscripts(projectFolder, next);
              }),
            ),
          ),
        );
        return starting;
      }),
    );

  /** Transcribes whatever has no transcript yet; a no-op without a transcriber. */
  const transcribeMissing = (projectFolder: string) =>
    startTranscripts(projectFolder, { everything: true, files: [], language: undefined });

  // Projects whose rate-switching footage the next build may conform: an import the user
  // approved, or an agent's ask. Other builds only read frame rates and write nothing to Footage.
  const conformWanted = new Set<string>();
  /**
   * Reads the footage's frame rates and frame tables ahead of a proxy build, and conforms what
   * needs it when that was asked for. Runs first so proxies are made from the conformed copies.
   */
  const prepareProjectFootage = Effect.fn("VideoProjects.prepareProjectFootage")(function* (
    projectFolder: string,
  ) {
    const statusPath = path.join(projectFolder, INTAKE_STATUS_FILE);
    const last = yield* fileSystem.readFileString(statusPath).pipe(
      Effect.flatMap(decodeJson),
      Effect.map((value) => value as VideoProjectIntakeStatus),
      Effect.orElseSucceed(() => null),
    );
    // A status left at "conforming" is a run the server stopped in the middle of.
    const conform = conformWanted.delete(projectFolder) || last?.state === "conforming";
    const report = (status: Pick<VideoProjectIntakeStatus, "state" | "error" | "conform">) =>
      fileSystem
        .writeFileString(
          statusPath,
          serializeJson({
            folder: last?.folder ?? path.join(path.dirname(projectFolder), FOOTAGE_DIRECTORY),
            done: last?.done ?? 0,
            total: last?.total ?? 0,
            ...status,
          }),
        )
        .pipe(Effect.ignore);
    let conformed = false;
    yield* onHost(
      prepareFootage({
        projectDir: projectFolder,
        conform,
        onProgress: (progress) => {
          if (progress.kind !== "conforming") return Effect.void;
          conformed = true;
          const { file, done, total, percent } = progress;
          return report({ state: "conforming", conform: { file, done, total, percent } });
        },
      }),
    ).pipe(
      Effect.tap(({ index, state }) => {
        const failures = state.pending.flatMap((file) =>
          index.failed?.[file] === undefined ? [] : [index.failed[file]],
        );
        if (!conformed && last?.state !== "conforming") return Effect.void;
        return failures.length > 0
          ? report({ state: "failed", error: `Could not conform ${failures.join("; ")}` })
          : report({ state: "done" });
      }),
      Effect.catch((cause) =>
        Effect.logWarning("Video project footage check failed", { projectFolder, cause }).pipe(
          Effect.andThen(
            conform
              ? report({ state: "failed", error: "Could not conform the footage." })
              : Effect.void,
          ),
        ),
      ),
    );
  });

  /**
   * Builds a project's proxies in the background, one build per project at a time. A request
   * that arrives mid-build (a pull brought new media) runs another build when this one ends.
   */
  const startProxies = (projectFolder: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (building.has(projectFolder)) {
        queued.add(projectFolder);
        return Effect.void;
      }
      building.add(projectFolder);
      const build = FiberSet.run(
        background,
        Effect.andThen(
          prepareProjectFootage(projectFolder),
          buildProjectProxies({ projectDir: projectFolder, concurrency: PROXY_CONCURRENCY }),
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          // The footage timeline needs each clip's length, which the proxy index now has.
          Effect.tap(() =>
            writeFootageStringout(projectFolder).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.ignore,
            ),
          ),
          Effect.tap(() => transcribeMissing(projectFolder)),
          Effect.tap((result) =>
            Effect.logInfo("Video project proxies ready", {
              projectFolder,
              files: result.count,
              failed: result.failed,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Video project proxies failed", { projectFolder, cause }),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              building.delete(projectFolder);
              return queued.delete(projectFolder) ? startProxies(projectFolder) : Effect.void;
            }),
          ),
        ),
      );
      return markProxiesBuilding(projectFolder).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.ignore,
        Effect.andThen(build),
        Effect.asVoid,
      );
    });

  /** True when no build is running and the index is missing or was left mid-build. */
  const proxiesUnfinished = (projectFolder: string) =>
    fileSystem.readFileString(path.join(projectFolder, PROXY_INDEX_PATH)).pipe(
      Effect.flatMap(decodeJson),
      Effect.map((index) => (index as ProxyIndex).building !== undefined),
      Effect.orElseSucceed(() => true),
      Effect.map((unfinished) => unfinished && !building.has(projectFolder)),
    );

  /**
   * The folder that holds a Premiere project's footage: the `.prproj`'s own folder, or its parent
   * when that folder is a "Premiere" subfolder (SFUniqlo/Premiere/SFUniqlo.prproj -> SFUniqlo).
   */
  const mediaRootFor = (premiereProjectPath: string) => {
    const folder = path.dirname(premiereProjectPath);
    return /premiere/i.test(path.basename(folder)) ? path.dirname(folder) : folder;
  };

  const readPremiere = Effect.fn("VideoProjects.readPremiere")(function* (
    premiereProjectPath: string,
  ) {
    if (path.extname(premiereProjectPath).toLowerCase() !== ".prproj") {
      return yield* new VideoProjectError({ reason: "Choose a Premiere project (.prproj) file." });
    }
    const bytes = yield* fileSystem
      .readFile(premiereProjectPath)
      .pipe(
        Effect.mapError(
          (cause) =>
            new VideoProjectError({ reason: `Could not read ${premiereProjectPath}.`, cause }),
        ),
      );
    const project = yield* Effect.try({
      try: () => parsePrproj(bytes),
      catch: (cause) =>
        new VideoProjectError({
          reason: "This file isn't a Premiere project Stellar can read.",
          cause,
        }),
    });
    return { bytes, project };
  });

  const inspectPremiere: VideoProjects["Service"]["inspectPremiere"] = Effect.fn(
    "VideoProjects.inspectPremiere",
  )(function* (input) {
    const { project } = yield* readPremiere(input.premiereProjectPath);
    const title = path.basename(input.premiereProjectPath, path.extname(input.premiereProjectPath));
    return {
      title: title.trim() === "" ? "Video project" : title,
      sequences: project.sequences.map((sequence) => ({ id: sequence.id, name: sequence.name })),
      projectFolder: path.join(mediaRootFor(input.premiereProjectPath), STELLAR_FOLDER),
    };
  });

  const createFromPremiere: VideoProjects["Service"]["createFromPremiere"] = Effect.fn(
    "VideoProjects.createFromPremiere",
  )(function* (input) {
    const { bytes } = yield* readPremiere(input.premiereProjectPath);
    const mediaRoot = mediaRootFor(input.premiereProjectPath);
    const projectFolder = path.join(mediaRoot, STELLAR_FOLDER);
    const pulled = yield* pullToProject({
      prproj: bytes,
      sequence: input.sequenceId,
      projectDir: projectFolder,
      mediaRoot,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) => new VideoProjectError({ reason: "Could not pull the sequence.", cause }),
      ),
      Effect.catchDefect(
        (cause) => new VideoProjectError({ reason: "Could not read that sequence.", cause }),
      ),
    );

    const existing = yield* projects
      .getByWorkspaceRoot(projectFolder)
      .pipe(
        Effect.mapError(
          (cause) => new VideoProjectError({ reason: "Could not look up projects.", cause }),
        ),
      );
    const project = Option.isSome(existing)
      ? existing.value
      : yield* random.uuidV4().pipe(
          Effect.flatMap((id) =>
            projects.create({
              commandId: CommandId.make(`video-project:${id}`),
              projectId: ProjectId.make(id),
              title: path.basename(
                input.premiereProjectPath,
                path.extname(input.premiereProjectPath),
              ),
              workspaceRoot: projectFolder,
              createWorkspaceRootIfMissing: true,
            }),
          ),
          Effect.mapError(
            (cause) => new VideoProjectError({ reason: "Could not add the project.", cause }),
          ),
        );

    const timelinePath = path.relative(projectFolder, pulled.timelinePath);
    yield* recordPull({
      projectDir: projectFolder,
      premiereProject: input.premiereProjectPath,
      timelinePath,
      sequenceId: input.sequenceId,
      text: pulled.text,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) => new VideoProjectError({ reason: "Could not link the Premiere project.", cause }),
      ),
    );
    yield* startProxies(projectFolder);

    return {
      projectId: project.id,
      workspaceRoot: projectFolder,
      timelinePath,
      existed: Option.isSome(existing),
    };
  });

  const createFromIdea: VideoProjects["Service"]["createFromIdea"] = Effect.fn(
    "VideoProjects.createFromIdea",
  )(function* (input) {
    // The title names a folder, so anything a path would read as a separator comes out.
    const folderName = input.title
      .replace(/[/\\:]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (folderName === "" || folderName.startsWith(".")) {
      return yield* new VideoProjectError({ reason: "Give the project a name." });
    }
    const parentFolder = yield* onHost(
      parentFolderFor(input.parentFolder, yield* readProjectsFolderSetting),
    ).pipe(Effect.mapError((error) => new VideoProjectError({ reason: error.reason })));
    const root = path.join(parentFolder, folderName);
    for (const folder of PROJECT_FOLDERS) {
      yield* fileSystem.makeDirectory(path.join(root, folder), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new VideoProjectError({
              reason: `Could not create ${path.join(root, folder)}.`,
              cause,
            }),
        ),
      );
    }
    const projectFolder = path.join(root, STELLAR_FOLDER);
    const existing = yield* projects
      .getByWorkspaceRoot(projectFolder)
      .pipe(
        Effect.mapError(
          (cause) => new VideoProjectError({ reason: "Could not look up projects.", cause }),
        ),
      );
    const project = Option.isSome(existing)
      ? existing.value
      : yield* random.uuidV4().pipe(
          Effect.flatMap((id) =>
            projects.create({
              commandId: CommandId.make(`video-project:${id}`),
              projectId: ProjectId.make(id),
              title: input.title,
              workspaceRoot: projectFolder,
              createWorkspaceRootIfMissing: true,
            }),
          ),
          Effect.mapError(
            (cause) => new VideoProjectError({ reason: "Could not add the project.", cause }),
          ),
        );
    return {
      projectId: project.id,
      workspaceRoot: projectFolder,
      existed: Option.isSome(existing),
    };
  });

  /** Clients name a project by its folder; only folders that are projects here are acted on. */
  const requireProject = Effect.fn("VideoProjects.requireProject")(function* (
    workspaceRoot: string,
  ) {
    const known = yield* projects
      .getByWorkspaceRoot(workspaceRoot)
      .pipe(
        Effect.mapError(
          (cause) => new VideoProjectError({ reason: "Could not look up projects.", cause }),
        ),
      );
    if (Option.isNone(known)) {
      return yield* new VideoProjectError({ reason: "That folder isn't a project here." });
    }
  });

  const scanIntake: VideoProjects["Service"]["scanIntake"] = Effect.fn("VideoProjects.scanIntake")(
    function* (input) {
      yield* requireProject(input.workspaceRoot);
      const since = (yield* Clock.currentTimeMillis) - INTAKE_DAYS * 24 * 60 * 60 * 1000;
      // AirDrop keeps a file's original dates, so only Spotlight knows when it arrived. Without
      // Spotlight (other systems), fall back to files modified recently.
      const arrived = yield* spawner
        .string(
          ChildProcess.make("mdfind", [
            "-onlyin",
            downloads,
            `kMDItemDateAdded >= $time.today(-${INTAKE_DAYS})`,
          ]),
        )
        .pipe(
          Effect.map((output) => new Set(output.split("\n").filter((line) => line !== ""))),
          // No answer also covers Spotlight being off for the folder.
          Effect.map((found) => (found.size === 0 ? null : found)),
          Effect.orElseSucceed(() => null),
        );
      const names = yield* fileSystem
        .readDirectory(downloads)
        .pipe(Effect.orElseSucceed((): Array<string> => []));
      const files: Array<VideoProjectScanIntakeResult["files"][number]> = [];
      for (const name of names) {
        if (!INTAKE_FILE.test(name) || name.startsWith(".")) continue;
        const file = path.join(downloads, name);
        if (arrived !== null && !arrived.has(file)) continue;
        const stat = yield* fileSystem.stat(file).pipe(Effect.option);
        if (Option.isNone(stat) || stat.value.type !== "File") continue;
        const capturedAt = Option.match(stat.value.mtime, {
          onNone: () => 0,
          onSome: (date) => date.getTime(),
        });
        if (arrived === null && capturedAt < since) continue;
        files.push({ path: file, name, size: Number(stat.value.size), capturedAt });
      }
      return {
        source: downloads,
        files: files.toSorted(
          (a, b) => a.capturedAt - b.capturedAt || a.name.localeCompare(b.name),
        ),
      };
    },
  );

  const importFootage: VideoProjects["Service"]["importFootage"] = Effect.fn(
    "VideoProjects.importFootage",
  )(function* (input) {
    yield* requireProject(input.workspaceRoot);
    const folder = input.folder.replace(/[/\\:]+/g, " ").trim();
    if (folder === "" || folder.startsWith(".")) {
      return yield* new VideoProjectError({ reason: "Name the folder the footage goes in." });
    }
    if (input.paths.some((file) => path.dirname(path.resolve(file)) !== downloads)) {
      return yield* new VideoProjectError({ reason: `Footage is imported from ${downloads}.` });
    }
    if (importing.has(input.workspaceRoot)) {
      return yield* new VideoProjectError({ reason: "An import is already running." });
    }
    const destination = path.join(path.dirname(input.workspaceRoot), FOOTAGE_DIRECTORY, folder);
    const total = input.paths.length;
    const report = (status: Omit<VideoProjectIntakeStatus, "folder" | "total">) =>
      fileSystem
        .writeFileString(
          path.join(input.workspaceRoot, INTAKE_STATUS_FILE),
          serializeJson({ ...status, folder: destination, total }),
        )
        .pipe(Effect.ignore);
    const copy = copyFootage({
      sources: input.paths,
      destination,
      onCopied: (done) => report({ state: "copying", done }),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.tap((done) => report({ state: "done", done })),
      // Approving the import approves conforming what it brought in.
      Effect.tap(() => Effect.sync(() => conformWanted.add(input.workspaceRoot))),
      Effect.andThen(startProxies(input.workspaceRoot)),
      Effect.catch((error) =>
        report({ state: "failed", done: 0, error: error.message }).pipe(
          Effect.andThen(Effect.logWarning("Footage import failed", { destination, error })),
        ),
      ),
      Effect.ensuring(Effect.sync(() => importing.delete(input.workspaceRoot))),
    );
    importing.add(input.workspaceRoot);
    yield* report({ state: "copying", done: 0 });
    yield* FiberSet.run(background, copy);
  });

  const conformFootage: VideoProjects["Service"]["conformFootage"] = Effect.fn(
    "VideoProjects.conformFootage",
  )(function* (input) {
    yield* requireProject(input.workspaceRoot);
    // What the last build measured; the build started here also covers footage added since.
    const { index, state } = yield* onHost(readConformState(input.workspaceRoot));
    conformWanted.add(input.workspaceRoot);
    yield* startProxies(input.workspaceRoot);
    return {
      files: state.pending,
      megabytes: state.pending.reduce(
        (sum, file) => sum + conformedMegabytes(index.media[file]?.duration ?? 0),
        0,
      ),
    };
  });

  /** The timeline paths the project's Premiere link follows; none when nothing is linked. */
  const linkedTimelines = (workspaceRoot: string) =>
    fileSystem.readFileString(path.join(workspaceRoot, PREMIERE_LINK_PATH)).pipe(
      Effect.flatMap(decodeJson),
      Effect.map((value) => Object.keys((value as { timelines?: object }).timelines ?? {})),
      Effect.orElseSucceed((): Array<string> => []),
    );

  const syncWithPremiere = Effect.fn("VideoProjects.syncWithPremiere")(function* (
    input: VideoProjectSyncInput,
  ) {
    yield* requireProject(input.workspaceRoot);
    // One at a time: two clients coming into focus together must not both rewrite a timeline.
    const result = yield* syncing.withPermits(1)(
      syncFromPremiere({
        projectDir: input.workspaceRoot,
        ...(input.usePremiere === undefined ? {} : { usePremiere: input.usePremiere }),
        ...(input.merge === undefined ? {} : { merge: input.merge }),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) => new VideoProjectError({ reason: "Could not sync with Premiere.", cause }),
        ),
      ),
    );
    if (result.updated.length > 0 || (yield* proxiesUnfinished(input.workspaceRoot))) {
      yield* startProxies(input.workspaceRoot);
    }
    const view: VideoProjectSyncResult = {
      state: result.state,
      premiereSavedAt: result.premiereSavedAt,
      updated: result.updated,
      kept: result.kept,
      premiereRunning: yield* premiereRunning,
      linked: yield* linkedTimelines(input.workspaceRoot),
      changes: [
        ...result.sequences.map(sequenceSentence),
        ...sentencesOf(result.changes, (entry) => diffSentences(entry.diff)),
      ],
      pending: sentencesOf(result.pending, (entry) => diffSentences(entry.diff)),
      conflicts: sentencesOf(result.conflicts, (entry) =>
        entry.conflicts.map((conflict) => conflict.message),
      ),
    };
    return { result, view };
  });

  const sync: VideoProjects["Service"]["sync"] = Effect.fn("VideoProjects.sync")(function* (input) {
    const { result, view } = yield* syncWithPremiere(input);
    const [unmerged] = result.unmerged;
    if (unmerged !== undefined) {
      return yield* new VideoProjectError({
        reason: `Can't merge ${unmerged}: ${NO_BASE} Take Premiere's version, or keep yours.`,
      });
    }
    return view;
  });

  /**
   * The sync agents read and edit behind: a timeline edited here and in Premiere is merged, so
   * an agent never works on a copy that lacks the user's hand edits.
   */
  const syncForAgent = (workspaceRoot: string) => syncWithPremiere({ workspaceRoot, merge: true });

  const loadScript = Effect.fn("VideoProjects.loadScript")(function* (workspaceRoot: string) {
    const text = yield* fileSystem
      .readFileString(path.join(workspaceRoot, SCRIPT_FILE))
      .pipe(Effect.orElseSucceed(() => ""));
    const index = yield* fileSystem
      .readFileString(path.join(workspaceRoot, SCRIPT_INDEX_FILE))
      .pipe(
        Effect.flatMap(decodeScriptIndex),
        Effect.orElseSucceed(() => NO_SCRIPT),
      );
    // script.md can be written without saveScript (by hand, by another tool); ids follow its lines.
    const assigned = assignBeatIds(index.beats, parseScript(text), index.nextId);
    return { docUrl: index.docUrl, savedAt: index.savedAt, ...assigned };
  });

  /**
   * The facts an agent would otherwise spend its first minute discovering, one per line.
   * Anything that blocks work (Premiere closed, no ffmpeg) is said plainly.
   */
  const describeProject = Effect.fn("VideoProjects.describeProject")(function* (
    workspaceRoot: string,
    synced: VideoProjectSyncResult,
  ) {
    const mediaRoot = path.dirname(workspaceRoot);
    const names = (folder: string) =>
      fileSystem
        .readDirectory(path.join(mediaRoot, folder))
        .pipe(Effect.orElseSucceed((): Array<string> => []));
    const footage = yield* listFootage(mediaRoot).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const index = yield* fileSystem.readFileString(path.join(workspaceRoot, PROXY_INDEX_PATH)).pipe(
      Effect.flatMap(decodeJson),
      Effect.map((value) => value as ProxyIndex),
      Effect.orElseSucceed(() => null),
    );
    const link = yield* fileSystem
      .readFileString(path.join(workspaceRoot, PREMIERE_LINK_PATH))
      .pipe(
        Effect.flatMap(decodeJson),
        Effect.map((value) => (value as { project?: string }).project ?? null),
        Effect.orElseSucceed(() => null),
      );
    const coverage = yield* onHost(transcriptCoverage(mediaRoot));
    const transcribed = transcribing.get(workspaceRoot)?.building;
    const transcripts = `${coverage.total - coverage.missing.length} of ${coverage.total} clips and takes word-timed${
      transcribed
        ? `, transcribing now (${transcribed.done} of ${transcribed.total} done)`
        : coverage.missing.length > 0
          ? ` (${(yield* resolveTranscriber).unavailable ?? "video_transcribe makes the rest"})`
          : ""
    }`;
    const conform = yield* onHost(readConformState(workspaceRoot));
    const frameRates = conformSummary(conform.index, conform.state);
    const takes = (yield* names(path.join("Audio", "VO"))).filter((name) => name.endsWith(".wav"));
    const script = yield* loadScript(workspaceRoot);
    const scriptLine =
      script.beats.length === 0 && script.docUrl === null
        ? "none (video_script saves one from the user's doc; a pre-recorded short needs none)"
        : `${script.beats.length} beats in Stellar/${SCRIPT_FILE}, Google Doc ${script.docUrl === null ? "not recorded" : "recorded"} (video_script)`;
    const hasFfmpeg = yield* spawner.string(ChildProcess.make("ffmpeg", ["-version"])).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    const running =
      synced.premiereRunning === null
        ? "may or may not be open (can't tell on this system)"
        : synced.premiereRunning
          ? "is open"
          : "is NOT open: video_premiere_open opens the project in it";
    const linked =
      link === null
        ? "no Premiere project is linked (save one into the Premiere folder, then video_premiere_pull)"
        : synced.state === "offline"
          ? `linked project ${link} can't be read (drive unplugged or file moved)`
          : `linked to ${link} (${synced.state})`;
    const previews =
      index === null
        ? "none built yet"
        : index.building !== undefined
          ? `building, ${index.building.done} of ${index.building.total}`
          : `ready for ${Object.keys(index.media).length} files${index.failed ? `, ${index.failed} failed` : ""}`;
    return [
      `Project folder: ${mediaRoot}`,
      `Premiere ${running}; ${linked}.`,
      `Footage: ${footage.length} videos in Footage/. Previews: ${previews}.`,
      ...(frameRates === null ? [] : [frameRates]),
      `Transcripts: ${transcripts}. Script snapshot: ${scriptLine}. Voice-over takes: ${takes.length} in Audio/VO/.`,
      yield* runLine(workspaceRoot, {
        footage: footage.length,
        coverage,
      }),
      ...(hasFfmpeg
        ? []
        : ["ffmpeg is NOT installed: previews, imports and voice-over can't be made."]),
    ].join("\n");
  });

  const listTimelines = (workspaceRoot: string) =>
    fileSystem.readDirectory(path.join(workspaceRoot, "timelines")).pipe(
      Effect.orElseSucceed((): Array<string> => []),
      Effect.map((names) =>
        names
          .filter((name) => name.endsWith(".otio"))
          .map((name) => `timelines/${name}`)
          .toSorted(),
      ),
    );

  /**
   * The timeline meant when none is named: the cut linked to Premiere, since that is the one a
   * push reaches, else the first cut, else the footage timeline.
   */
  const defaultTimeline = (workspaceRoot: string, timelines: ReadonlyArray<string>) =>
    linkedTimelines(workspaceRoot).pipe(
      Effect.map(
        (linked) =>
          timelines.find((candidate) => linked.includes(candidate)) ??
          timelines.find((candidate) => candidate !== FOOTAGE_TIMELINE_PATH) ??
          timelines[0],
      ),
    );

  const loadTimeline = Effect.fn("VideoProjects.loadTimeline")(function* (
    workspaceRoot: string,
    timelinePath: string,
  ) {
    const timelines = yield* listTimelines(workspaceRoot);
    if (!timelines.includes(timelinePath)) {
      return yield* new VideoProjectError({
        reason: `No timeline ${timelinePath}. This project has: ${timelines.join(", ") || "none"}.`,
      });
    }
    return yield* fileSystem.readFileString(path.join(workspaceRoot, timelinePath)).pipe(
      Effect.flatMap(decodeJson),
      Effect.map((value) => value as Timeline),
      Effect.mapError(
        (cause) => new VideoProjectError({ reason: `Could not read ${timelinePath}.`, cause }),
      ),
    );
  });

  const loadTranscripts = Effect.fn("VideoProjects.loadTranscripts")(function* (
    workspaceRoot: string,
    timeline: Timeline,
  ) {
    const targets = new Set(
      layoutTimeline(timeline)
        .tracks.filter((track) => track.kind === "Audio")
        .flatMap((track) =>
          track.clips.map((item) => item.clip.media_references.DEFAULT_MEDIA.target_url),
        ),
    );
    const mediaRoot = path.dirname(workspaceRoot);
    const transcripts = new Map<string, ReadonlyArray<TranscriptWord>>();
    const files = new Map<string, string>();
    for (const target of targets) {
      if (target === "") continue;
      const file = yield* findTranscript(mediaRoot, target).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      if (file === null) continue;
      files.set(target, file);
      transcripts.set(
        target,
        yield* fileSystem.readFileString(file).pipe(
          Effect.flatMap(decodeTranscript),
          Effect.mapError(
            (cause) =>
              new VideoProjectError({
                reason: `Could not read the transcript ${file}.`,
                cause,
              }),
          ),
        ),
      );
    }
    return { transcripts, files };
  });

  const loadWords = Effect.fn("VideoProjects.loadWords")(function* (
    workspaceRoot: string,
    timeline: Timeline,
  ) {
    const { transcripts } = yield* loadTranscripts(workspaceRoot, timeline);
    return timelineWords(timeline, transcripts);
  });

  /**
   * A timeline's words with the measured levels of each source that has a transcript, made now
   * for the ones not measured yet. `unmeasured` says why any are missing, once per reason.
   */
  const loadSound = Effect.fn("VideoProjects.loadSound")(function* (
    workspaceRoot: string,
    timeline: Timeline,
  ) {
    const { transcripts, files } = yield* loadTranscripts(workspaceRoot, timeline);
    const mediaRoot = path.dirname(workspaceRoot);
    const levels = new Map<string, AudioLevels>();
    const unmeasured = new Set<string>();
    // A first measurement reads each whole recording, which off an external drive takes minutes:
    // a read waits only so long, the rest goes on behind it and is there for the next read.
    const until = (yield* Clock.currentTimeMillis) + MEASURE_WAIT_MILLIS;
    let waiting = 0;
    for (const [target, transcriptFile] of files) {
      const measurement = yield* FiberSet.run(
        background,
        measuring.withPermits(1)(onHost(ensureLevels({ mediaRoot, target, transcriptFile }))),
      );
      const left = Math.max(0, until - (yield* Clock.currentTimeMillis));
      const waited = yield* Fiber.join(measurement).pipe(Effect.timeoutOption(left));
      if (Option.isNone(waited)) {
        waiting += 1;
        continue;
      }
      const measured = waited.value;
      if ("unavailable" in measured) unmeasured.add(measured.unavailable);
      else levels.set(target, measured);
      // Nothing else will be measured either, and each try would spawn again.
      if ("unavailable" in measured && measured.unavailable === NO_FFMPEG) break;
    }
    if (waiting > 0) {
      unmeasured.add(
        `the sound of ${waiting} of ${files.size} recordings is still being measured, which can take minutes the first time; until then their cuts go by word timings, so read again shortly`,
      );
    }
    return {
      view: timelineWords(timeline, transcripts),
      transcripts,
      levels,
      unmeasured: [...unmeasured],
    };
  });

  const readWords: VideoProjects["Service"]["readWords"] = Effect.fn("VideoProjects.readWords")(
    function* (input) {
      // Merged first, as editTimeline does, so the word numbers here are the ones it cuts by.
      yield* syncForAgent(input.workspaceRoot);
      const timelines = yield* listTimelines(input.workspaceRoot);
      const chosen = input.timeline ?? (yield* defaultTimeline(input.workspaceRoot, timelines));
      if (chosen === undefined) {
        return yield* new VideoProjectError({ reason: "This project has no timeline to read." });
      }
      const timeline = yield* loadTimeline(input.workspaceRoot, chosen);
      const sound = yield* loadSound(input.workspaceRoot, timeline);
      const from = input.from === undefined ? {} : { from: input.from };
      const unmeasured = sound.unmeasured.map((reason) => `# Not measured: ${reason}.`);
      if (input.action !== "joins") {
        return {
          timeline: chosen,
          text: [
            wordsText(sound.view, {
              levels: sound.levels,
              ...(input.from === undefined ? {} : { fromWord: input.from }),
            }),
            ...unmeasured,
          ].join("\n"),
        };
      }
      const pauseOver = input.pauseOver === undefined ? {} : { pauseOver: input.pauseOver };
      const sources = [...sound.levels].map(
        ([target, levels]) =>
          `${path.basename(target)} speech ${levels.speech}, room tone ${levels.roomTone}`,
      );
      return {
        timeline: chosen,
        text: [
          joinAuditText(
            sound.view,
            auditJoins(sound.view, sound.transcripts, sound.levels, input.pauseOver),
            { ...from, ...pauseOver },
          ),
          ...(sources.length === 0 ? [] : [`# Levels in dBFS: ${sources.join("; ")}`]),
          ...unmeasured,
        ].join("\n"),
      };
    },
  );

  const soundPicture: VideoProjects["Service"]["soundPicture"] = Effect.fn(
    "VideoProjects.soundPicture",
  )(function* (input) {
    // Merged first, as readWords is, so the word numbers here are the ones it gives.
    yield* syncForAgent(input.workspaceRoot);
    const timelines = yield* listTimelines(input.workspaceRoot);
    const chosen = input.timeline ?? (yield* defaultTimeline(input.workspaceRoot, timelines));
    if (chosen === undefined) {
      return yield* new VideoProjectError({ reason: "This project has no timeline to read." });
    }
    const timeline = yield* loadTimeline(input.workspaceRoot, chosen);
    const wordCut =
      input.request.cutFromWord !== undefined || input.request.cutToWord !== undefined;
    // Only a cut named by words is placed on measured quiet, so only it needs the levels.
    const sound = wordCut
      ? yield* loadSound(input.workspaceRoot, timeline)
      : {
          ...(yield* loadTranscripts(input.workspaceRoot, timeline)),
          levels: new Map<string, AudioLevels>(),
          unmeasured: [],
        };
    const drawn = yield* onHost(
      drawSoundPicture({
        projectDir: input.workspaceRoot,
        timeline,
        transcripts: sound.transcripts,
        levels: sound.levels,
        unmeasured: sound.unmeasured,
        request: input.request,
      }),
    ).pipe(Effect.mapError((cause) => new VideoProjectError({ reason: cause.message, cause })));
    return { timeline: chosen, ...drawn };
  });

  const scriptView = Effect.fn("VideoProjects.scriptView")(function* (
    workspaceRoot: string,
    requested: string | undefined,
  ) {
    const script = yield* loadScript(workspaceRoot);
    const timelines = yield* listTimelines(workspaceRoot);
    const chosen = requested ?? (yield* defaultTimeline(workspaceRoot, timelines)) ?? null;
    const timeline = chosen === null ? null : yield* loadTimeline(workspaceRoot, chosen);
    const words =
      timeline === null
        ? { name: "", rate: 0, count: 0, clips: [] }
        : yield* loadWords(workspaceRoot, timeline);
    // A line whose words aren't found (its take has no transcript yet) is still where its take is.
    const voice =
      timeline === null
        ? null
        : placedVoiceOver(timeline, (yield* onHost(readTakeIndex(workspaceRoot))).takes);
    return {
      docUrl: script.docUrl,
      savedAt: script.savedAt,
      timeline: chosen,
      beats: alignBeats(script.beats, words).map((beat) => {
        const take = beat.startFrame === null ? voice?.get(beat.id) : undefined;
        return take === undefined
          ? beat
          : { ...beat, startFrame: take.startFrame, endFrame: take.endFrame };
      }),
    };
  });

  const readScript: VideoProjects["Service"]["readScript"] = Effect.fn("VideoProjects.readScript")(
    function* (input) {
      // Synced first, as readWords is, so the word numbers here are the ones it gives.
      yield* sync({ workspaceRoot: input.workspaceRoot });
      return yield* scriptView(input.workspaceRoot, input.timeline);
    },
  );

  const saveScript: VideoProjects["Service"]["saveScript"] = Effect.fn("VideoProjects.saveScript")(
    function* (input) {
      yield* requireProject(input.workspaceRoot);
      const { text, docUrl } = input;
      if (text === undefined && docUrl === undefined) {
        return yield* new VideoProjectError({ reason: "Saving the script needs text or docUrl." });
      }
      // One at a time, so two saves can't hand the same new id to different beats.
      yield* savingScript.withPermits(1)(
        Effect.gen(function* () {
          const previous = yield* loadScript(input.workspaceRoot);
          const { beats, nextId } =
            text === undefined
              ? previous
              : assignBeatIds(previous.beats, parseScript(text), previous.nextId);
          if (text !== undefined) {
            yield* fileSystem.writeFileString(path.join(input.workspaceRoot, SCRIPT_FILE), text);
          }
          yield* fileSystem.writeFileString(
            path.join(input.workspaceRoot, SCRIPT_INDEX_FILE),
            serializeJson({
              docUrl: docUrl ?? previous.docUrl,
              savedAt: yield* Clock.currentTimeMillis,
              beats: beats.map((beat) => ({ id: beat.id, text: beat.text })),
              nextId,
            } satisfies typeof ScriptIndex.Type),
          );
        }).pipe(
          Effect.mapError(
            (cause) => new VideoProjectError({ reason: "Could not save the script.", cause }),
          ),
        ),
      );
      return yield* readScript({ workspaceRoot: input.workspaceRoot });
    },
  );

  const transcribe: VideoProjects["Service"]["transcribe"] = Effect.fn("VideoProjects.transcribe")(
    function* (input) {
      yield* requireProject(input.workspaceRoot);
      const mediaRoot = path.dirname(input.workspaceRoot);
      const files = (input.files ?? []).map((file) =>
        path.relative(mediaRoot, path.resolve(mediaRoot, file)),
      );
      if (files.some((file) => file === "" || file.startsWith("..") || path.isAbsolute(file))) {
        return yield* new VideoProjectError({
          reason: `Files to transcribe are named relative to ${mediaRoot}.`,
        });
      }
      return yield* startTranscripts(input.workspaceRoot, {
        everything: input.files === undefined,
        files: files.map((file) => file.split(path.sep).join("/")),
        language: input.language,
      });
    },
  );

  const historyError = (cause: { readonly message: string }) =>
    new VideoProjectError({ reason: cause.message, cause });
  // Timeline paths come from clients: only a file in `timelines/` is one.
  const requireTimeline = Effect.fn("VideoProjects.requireTimeline")(function* (
    workspaceRoot: string,
    timelinePath: string,
  ) {
    yield* requireProject(workspaceRoot);
    const timelines = yield* listTimelines(workspaceRoot);
    if (!timelines.includes(timelinePath)) {
      return yield* new VideoProjectError({
        reason: `No timeline ${timelinePath}. This project has: ${timelines.join(", ") || "none"}.`,
      });
    }
  });

  // The footage timeline is rebuilt whenever footage changes, so an edit to it would be lost:
  // the first one goes to a cut made from it, and later ones are pointed at the cuts.
  const cutTarget = Effect.fn("VideoProjects.cutTarget")(function* (
    workspaceRoot: string,
    timelinePath: string,
  ) {
    if (timelinePath !== FOOTAGE_TIMELINE_PATH) return timelinePath;
    const cuts = (yield* listTimelines(workspaceRoot)).filter(
      (candidate) => candidate !== FOOTAGE_TIMELINE_PATH,
    );
    if (cuts.length === 0) return ROUGH_CUT_TIMELINE_PATH;
    return yield* new VideoProjectError({
      reason: `${FOOTAGE_TIMELINE_PATH} is rebuilt whenever footage changes, so an edit to it would be lost. Edit a cut instead: ${cuts.join(", ")}. Nothing was changed.`,
    });
  });
  const MADE_CUT = `Made ${ROUGH_CUT_TIMELINE_PATH} from the footage timeline, which is rebuilt whenever footage changes. Work on ${ROUGH_CUT_TIMELINE_PATH} from here on.`;
  /** Starts the cut's file and history from the footage as it was, before the first edit to it. */
  const startCut = (workspaceRoot: string, footage: Timeline) =>
    onHost(
      commitTimelineText({
        projectDir: workspaceRoot,
        timelinePath: ROUGH_CUT_TIMELINE_PATH,
        text: serializeTimeline(cutFromFootage(footage)),
        by: "user",
        label: "Started from the footage",
      }),
    ).pipe(Effect.mapError(historyError));

  const commitTimeline: VideoProjects["Service"]["commitTimeline"] = Effect.fn(
    "VideoProjects.commitTimeline",
  )(function* (input) {
    yield* requireTimeline(input.workspaceRoot, input.timeline);
    const target = yield* cutTarget(input.workspaceRoot, input.timeline);
    if (target === input.timeline) {
      return yield* syncing.withPermits(1)(
        onHost(
          commitFromClient({
            projectDir: input.workspaceRoot,
            timelinePath: input.timeline,
            contents: input.contents,
          }),
        ).pipe(Effect.mapError(historyError)),
      );
    }
    const edited = yield* decodeJson(input.contents).pipe(
      Effect.map((value) => value as Timeline),
      Effect.mapError(
        (cause) => new VideoProjectError({ reason: "What was sent is not a timeline.", cause }),
      ),
    );
    const footage = yield* loadTimeline(input.workspaceRoot, input.timeline);
    return yield* syncing.withPermits(1)(
      Effect.andThen(
        startCut(input.workspaceRoot, footage),
        onHost(
          commitFromClient({
            projectDir: input.workspaceRoot,
            timelinePath: target,
            contents: serializeTimeline(cutFromFootage(edited)),
          }),
        ).pipe(Effect.mapError(historyError)),
      ),
    );
  });

  const listVersions: VideoProjects["Service"]["listVersions"] = Effect.fn(
    "VideoProjects.listVersions",
  )(function* (input) {
    yield* requireTimeline(input.workspaceRoot, input.timeline);
    return yield* syncing.withPermits(1)(
      onHost(listTimelineVersions(input.workspaceRoot, input.timeline)).pipe(
        Effect.mapError(historyError),
      ),
    );
  });

  const readVersion: VideoProjects["Service"]["readVersion"] = Effect.fn(
    "VideoProjects.readVersion",
  )(function* (input) {
    yield* requireTimeline(input.workspaceRoot, input.timeline);
    const read = yield* syncing.withPermits(1)(
      onHost(readTimelineVersion(input.workspaceRoot, input.timeline, input.version)).pipe(
        Effect.mapError(historyError),
      ),
    );
    return { version: read.version, contents: read.contents, changesSince: read.changesSince };
  });

  const restoreVersion: VideoProjects["Service"]["restoreVersion"] = Effect.fn(
    "VideoProjects.restoreVersion",
  )(function* (input) {
    yield* requireTimeline(input.workspaceRoot, input.timeline);
    // Merged first, as an agent's edit is: the restore then starts from Premiere's latest save.
    const { result: before } = yield* syncForAgent(input.workspaceRoot);
    if (before.unmerged.includes(input.timeline)) {
      return yield* new VideoProjectError({
        reason: `${input.timeline} was edited here and in Premiere, and they can't be merged: ${NO_BASE} Nothing was changed. Choose a version in the Premiere badge first.`,
      });
    }
    const { recorded: _recorded, ...restored } = yield* syncing.withPermits(1)(
      onHost(
        restoreTimelineVersion({
          projectDir: input.workspaceRoot,
          timelinePath: input.timeline,
          ...(input.version === undefined ? {} : { version: input.version }),
          ...(input.step === undefined ? {} : { step: input.step }),
          by: input.by ?? "user",
          ...(input.review === undefined ? {} : { review: input.review }),
        }),
      ).pipe(Effect.mapError(historyError)),
    );
    return restored;
  });

  const listEdits: VideoProjects["Service"]["listEdits"] = Effect.fn("VideoProjects.listEdits")(
    function* (input) {
      yield* requireTimeline(input.workspaceRoot, input.timeline);
      return yield* syncing.withPermits(1)(
        onHost(listTimelineEdits(input.workspaceRoot, input.timeline)).pipe(
          Effect.mapError(historyError),
        ),
      );
    },
  );

  const reviewEdit: VideoProjects["Service"]["reviewEdit"] = Effect.fn("VideoProjects.reviewEdit")(
    function* (input) {
      yield* requireTimeline(input.workspaceRoot, input.timeline);
      if (input.action !== "keep" && input.action !== "reopen") {
        // Merged first, as a restore is: the change is carried onto Premiere's latest save.
        const { result: before } = yield* syncForAgent(input.workspaceRoot);
        if (before.unmerged.includes(input.timeline)) {
          return yield* new VideoProjectError({
            reason: `${input.timeline} was edited here and in Premiere, and they can't be merged: ${NO_BASE} Nothing was changed. Choose a version in the Premiere badge first.`,
          });
        }
      }
      return yield* syncing.withPermits(1)(
        onHost(
          reviewTimelineEdit({
            projectDir: input.workspaceRoot,
            timelinePath: input.timeline,
            edit: input.edit,
            action: input.action,
          }),
        ).pipe(Effect.mapError(historyError)),
      );
    },
  );

  /** What the user decided on the agent's edits, as the last line of a read; nothing with no edits. */
  const reviewedLine = Effect.fn("VideoProjects.reviewedLine")(function* (
    workspaceRoot: string,
    timeline: string,
  ) {
    const line = editsLine(yield* listEdits({ workspaceRoot, timeline }));
    return line === null ? null : [line];
  });

  const readTimeline: VideoProjects["Service"]["readTimeline"] = Effect.fn(
    "VideoProjects.readTimeline",
  )(function* (input) {
    const { result, view: synced } = yield* syncForAgent(input.workspaceRoot);
    const timelines = yield* listTimelines(input.workspaceRoot);
    const chosen =
      input.timeline ?? (yield* defaultTimeline(input.workspaceRoot, timelines)) ?? null;
    if (chosen === null) {
      return {
        timelines,
        timeline: null,
        premiere: synced.state,
        project: yield* describeProject(input.workspaceRoot, synced),
        changes: changesText(result),
        text: "",
      };
    }
    if (input.version !== undefined) {
      // A past version, or the list of them, in place of the timeline as it is now.
      const history = input.version === "list" || input.version === "edits" ? null : input.version;
      const text =
        input.version === "edits"
          ? editsText(yield* listEdits({ workspaceRoot: input.workspaceRoot, timeline: chosen }))
          : history === null
            ? versionsText(
                yield* listVersions({ workspaceRoot: input.workspaceRoot, timeline: chosen }),
              )
            : null;
      const past =
        history === null
          ? null
          : yield* onHost(readTimelineVersion(input.workspaceRoot, chosen, history)).pipe(
              Effect.mapError(historyError),
            );
      return {
        timelines,
        timeline: chosen,
        premiere: synced.state,
        project: yield* describeProject(input.workspaceRoot, synced),
        changes:
          past === null
            ? changesText(result)
            : [
                `Changed from ${past.version.id} to the timeline now:`,
                ...capped(diffTimelines(past.timeline, past.current).changes.map(changeLine)),
              ].join("\n"),
        text:
          text ??
          `# ${past?.version.id}, not the timeline as it is now\n${past === null ? "" : editableView(past.timeline)}`,
      };
    }
    const timeline = yield* loadTimeline(input.workspaceRoot, chosen);
    // Clips whose frame rate changes partway can't be cut by time until they are conformed.
    const index = yield* fileSystem
      .readFileString(path.join(input.workspaceRoot, PROXY_INDEX_PATH))
      .pipe(
        Effect.flatMap(decodeJson),
        Effect.map((value) => value as ProxyIndex),
        Effect.orElseSucceed(() => null),
      );
    const warnings = Object.entries(index?.media ?? {}).flatMap(([target, entry]) =>
      entry.rateChanges === undefined
        ? []
        : [
            `! ${path.basename(target)} changes frame rate (${entry.rateChanges.map((change) => `${change.fps} fps from ${change.at}s`).join(", ")}). Conform it whole to one rate before cutting it by time.`,
          ],
    );
    return {
      timelines,
      timeline: chosen,
      premiere: synced.state,
      project: yield* describeProject(input.workspaceRoot, synced),
      changes: changesText(result),
      text: [
        editableView(timeline),
        ...warnings,
        ...((yield* reviewedLine(input.workspaceRoot, chosen)) ?? []),
      ].join("\n"),
    };
  });

  /** What ffprobe says a file holds; null when it reads no picture or sound in it. */
  const probeMedia = (file: string) =>
    spawner
      .string(
        ChildProcess.make("ffprobe", [
          "-v",
          "error",
          "-show_entries",
          "stream=codec_type:stream_disposition=attached_pic:format=duration",
          "-of",
          "json",
          file,
        ]),
      )
      .pipe(
        Effect.flatMap(decodeJson),
        Effect.map((value): MediaFacts | null => {
          const probed = value as {
            streams?: ReadonlyArray<{
              codec_type?: string;
              disposition?: { attached_pic?: number };
            }>;
            format?: { duration?: string };
          };
          const streams = probed.streams ?? [];
          // Audio files can carry cover art as a one-frame "video" stream.
          const picture = streams.some(
            (stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1,
          );
          const sound = streams.some((stream) => stream.codec_type === "audio");
          const seconds = Number(probed.format?.duration);
          if (!picture && !sound) return null;
          return { ...(Number.isFinite(seconds) ? { seconds } : {}), picture, sound };
        }),
        Effect.orElseSucceed(() => null),
      );

  /**
   * The media files edits name for insert and overwrite, found in the project: what the
   * previews' index, the voice-over takes or a probe know of them. A file outside the project
   * must be brought in first.
   */
  const findMedia = Effect.fn("VideoProjects.findMedia")(function* (
    workspaceRoot: string,
    names: ReadonlyArray<string>,
  ) {
    const mediaRoot = path.dirname(workspaceRoot);
    const index = yield* fileSystem.readFileString(path.join(workspaceRoot, PROXY_INDEX_PATH)).pipe(
      Effect.flatMap(decodeJson),
      Effect.map((value) => value as ProxyIndex),
      Effect.orElseSucceed(() => null),
    );
    const known = new Map<string, MediaFacts>();
    for (const [target, entry] of Object.entries(index?.media ?? {})) {
      const still = STILL_PATH.test(target) || entry.still !== undefined;
      known.set(target, {
        ...(still ? {} : { seconds: entry.duration }),
        picture: still || entry.video !== undefined,
        sound: entry.audio !== undefined,
      });
    }
    for (const take of (yield* onHost(readTakeIndex(workspaceRoot))).takes) {
      if (!known.has(take.file)) {
        known.set(take.file, { seconds: take.seconds, picture: false, sound: true });
      }
    }
    // An original that switches frame rate is cut from its constant-rate copy.
    const { copyOf } = (yield* onHost(readConformState(workspaceRoot))).state;
    const base = (target: string) => target.slice(target.lastIndexOf("/") + 1).toLowerCase();
    const bare = (name: string) => name.replace(/\.[^.]+$/, "");
    const found = new Map<string, PlacedMedia | string>();
    for (const name of new Set(names)) {
      const asked = name.trim().replace(/^\.\//, "");
      const inside = path.isAbsolute(asked)
        ? asked.startsWith(`${mediaRoot}/`)
          ? asked.slice(mediaRoot.length + 1)
          : null
        : asked;
      if (inside === null) {
        found.set(
          name,
          `${asked} is outside the project folder (${mediaRoot}): bring it in first, with video_footage import for footage, or video_voice_over import for a voice-over recording`,
        );
        continue;
      }
      const target = copyOf.get(inside) ?? inside;
      const facts = known.get(target);
      if (facts !== undefined) {
        found.set(name, { target, facts });
        continue;
      }
      const file = path.join(mediaRoot, target);
      if (yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false))) {
        const probed = STILL_PATH.test(target)
          ? { picture: true, sound: false }
          : yield* probeMedia(file);
        found.set(
          name,
          probed === null
            ? `${target} has no picture or sound ffprobe can read`
            : { target, facts: probed },
        );
        continue;
      }
      const wanted = base(target);
      const byName = [...known.keys(), ...copyOf.keys()].filter(
        (key) => base(key) === wanted || bare(base(key)) === bare(wanted),
      );
      const targets = [...new Set(byName.map((key) => copyOf.get(key) ?? key))];
      const [only] = targets;
      const onlyFacts = only === undefined ? undefined : known.get(only);
      if (only !== undefined && targets.length === 1 && onlyFacts !== undefined) {
        found.set(name, { target: only, facts: onlyFacts });
        continue;
      }
      const listed = [...known.keys()].toSorted();
      found.set(
        name,
        targets.length > 1
          ? `"${asked}" names ${targets.length} files (${targets.join(", ")}): give its path`
          : `no media "${asked}" in this project. Media is known once it is in the project folder: video_footage imports footage, video_voice_over import brings in a recording${
              index?.building === undefined ? "" : ", and previews are still being built"
            }. Known: ${listed.length === 0 ? "none" : capped(listed).join(", ")}`,
      );
    }
    return { found, indexed: known, previewed: new Set(Object.keys(index?.media ?? {})) };
  });

  const editTimeline: VideoProjects["Service"]["editTimeline"] = Effect.fn(
    "VideoProjects.editTimeline",
  )(function* (input) {
    const { result: before } = yield* syncForAgent(input.workspaceRoot);
    if (before.unmerged.includes(input.timeline)) {
      return yield* new VideoProjectError({
        reason: `${input.timeline} was edited here and in Premiere, and they can't be merged: ${NO_BASE} Nothing was changed. Ask the user to choose a version in Stellar.`,
      });
    }
    const summary = (input.summary?.trim() ?? "").slice(0, 500);
    const check = (input.check?.trim() ?? "").slice(0, 300);
    const review = summary === "" ? undefined : { summary, ...(check === "" ? {} : { check }) };
    // A restore names no clip or frame, so a pull just now doesn't outdate it.
    const [only] = input.edits;
    if (only?.kind === "restoreVersion" && input.edits.length === 1) {
      const version = only.version;
      if (version === undefined) {
        return yield* new VideoProjectError({
          reason: "Edit 1 (restoreVersion): needs version. Nothing was changed.",
        });
      }
      const restored = yield* restoreVersion({
        workspaceRoot: input.workspaceRoot,
        timeline: input.timeline,
        version,
        by: input.by ?? "agent",
        ...(review === undefined ? {} : { review }),
      });
      const { result: after, view: synced } = yield* syncWithPremiere({
        workspaceRoot: input.workspaceRoot,
      });
      return {
        timelines: yield* listTimelines(input.workspaceRoot),
        timeline: input.timeline,
        premiere: synced.state,
        project: yield* describeProject(input.workspaceRoot, synced),
        changes: [
          `Restored ${version} as ${restored.versions[0]?.id ?? "a new version"}.`,
          ...(restored.keptFromPremiere.length === 0
            ? []
            : [
                `Kept from Premiere, changed there since ${version}:`,
                ...capped(restored.keptFromPremiere),
              ]),
          ...(restored.conflicts.length === 0
            ? []
            : [`Not brought back, Premiere's version stands:`, ...capped(restored.conflicts)]),
          changesText({ ...before, pending: after.pending }),
        ]
          .filter((line) => line !== "")
          .join("\n"),
        text: editableView(yield* loadTimeline(input.workspaceRoot, input.timeline)),
      };
    }
    // The edits name clips and frames from the agent's last read, which this pull just outdated.
    if (before.updated.includes(input.timeline)) {
      return yield* new VideoProjectError({
        reason: `${input.timeline} just changed: the user saved in Premiere and it was pulled in. None of your edits were applied. Read the timeline again and redo them against what is there now.`,
      });
    }
    const target = yield* cutTarget(input.workspaceRoot, input.timeline);
    const timeline = yield* loadTimeline(input.workspaceRoot, input.timeline);
    const timelineFile = path.join(input.workspaceRoot, input.timeline);
    const textAtRead = yield* fileSystem
      .readFileString(timelineFile)
      .pipe(Effect.orElseSucceed(() => null));
    const layout = layoutTimeline(timeline);
    const clipIds = new Set(layout.tracks.flatMap((track) => track.clips.map((clip) => clip.key)));
    const trackNames = new Set(layout.tracks.map((track) => track.name));
    const markerIds = new Set(timelineMarkers(timeline).map((marker) => marker.id));
    const by = input.by ?? "agent";
    // An agent's cut is checked against the sound; a person hears their own and may cut anywhere.
    const sound = input.edits.some(
      (edit) =>
        edit.kind === "removeWords" ||
        edit.kind === "trimPause" ||
        (by === "agent" && EDGE_MAKING_EDITS.has(edit.kind)),
    )
      ? yield* loadSound(input.workspaceRoot, timeline)
      : null;
    // Words are placed on the timeline as it was before the call, so a ripple word cut moves
    // the ones resolved after it by the frames it removed ahead of them.
    const rippled: Array<FrameRange> = [];
    const afterCuts = (frame: number) =>
      frame -
      rippled.reduce(
        (removed, cut) => removed + Math.max(0, Math.min(frame, cut.end) - cut.start),
        0,
      );
    const cutNotes: Array<string> = [];
    const placedEdges: Array<SourceEdge> = [];
    const framesOfWords: Parameters<typeof toTimelineEdit>[1] = (cut, ripple) => {
      const view = sound?.view ?? { name: timeline.name, rate: layout.rate, count: 0, clips: [] };
      const levels = sound?.levels ?? new Map<string, AudioLevels>();
      const range =
        "afterWord" in cut
          ? placePauseCut(view, levels, cut.afterWord, cut.leave)
          : placeWordCut(view, levels, cut.fromWord, cut.toWord);
      if (typeof range === "string") return range;
      if ("nothing" in range) {
        cutNotes.push(range.nothing);
        return null;
      }
      cutNotes.push(range.note);
      placedEdges.push(...range.edges);
      const placed = { start: afterCuts(range.start), end: afterCuts(range.end) };
      if (ripple) rippled.push(range);
      return placed;
    };
    const media = input.edits.some((edit) => PLACING_EDITS.has(edit.kind))
      ? yield* findMedia(
          input.workspaceRoot,
          input.edits.flatMap((edit) => (edit.media === undefined ? [] : [edit.media])),
        )
      : null;
    const mediaOf = (name: string) => media?.found.get(name) ?? `no media "${name}"`;
    const placing = {
      media: (target: string) =>
        media?.indexed.get(target) ??
        [...(media?.found.values() ?? [])].find(
          (found): found is PlacedMedia => typeof found !== "string" && found.target === target,
        )?.facts,
    };
    const edits: Array<TimelineEdit> = [];
    // The call's edit each applied one came from, since a pause with nothing to trim is skipped.
    const asked: Array<number> = [];
    for (const [index, edit] of input.edits.entries()) {
      const parsed = toTimelineEdit(edit, framesOfWords, by, mediaOf, layout.tracks);
      if (parsed === null) continue;
      const clipId = typeof parsed === "string" ? undefined : (editClipId(parsed) ?? undefined);
      const problem =
        typeof parsed === "string"
          ? parsed
          : clipId !== undefined && !clipIds.has(clipId) && !isSplitPiece(clipId)
            ? `no clip #${clipId}`
            : parsed.kind === "move" && !trackNames.has(parsed.toTrack)
              ? `no track ${parsed.toTrack}`
              : parsed.kind === "insert" || parsed.kind === "overwrite"
                ? placementProblem(applyEdits(timeline, edits, placing), parsed, placing)
                : (parsed.kind === "setMarker" || parsed.kind === "removeMarker") &&
                    !markerIds.has(parsed.markerId)
                  ? `no marker #${parsed.markerId}`
                  : null;
      if (problem !== null || typeof parsed === "string") {
        return yield* new VideoProjectError({
          reason: `Edit ${index + 1} (${edit.kind}): ${problem}. Nothing was changed.`,
        });
      }
      edits.push(parsed);
      asked.push(index);
    }
    // Ripple, roll, slip and slide stop where a file's media runs out, when its length is known.
    const proxies = edits.some((edit) => HANDLE_EDITS.has(edit.kind))
      ? yield* fileSystem.readFileString(path.join(input.workspaceRoot, PROXY_INDEX_PATH)).pipe(
          Effect.flatMap(decodeJson),
          Effect.map((value) => value as ProxyIndex),
          Effect.orElseSucceed(() => null),
        )
      : null;
    const options = {
      mediaSeconds: (target: string) => proxies?.media[target]?.duration,
      ...placing,
    };
    const edited = applyEdits(timeline, edits, options);
    if (sound !== null && by === "agent") {
      const clippedBy = (result: Timeline) =>
        clippedEdges(
          sound.view,
          timelineWords(result, sound.transcripts),
          sound.transcripts,
          sound.levels,
          placedEdges,
        );
      const clipped = clippedBy(edited);
      const [first] = clipped;
      if (first !== undefined) {
        // The first edit after which the edge is there made it.
        const made = edits.findIndex((_, index) =>
          clippedBy(applyEdits(timeline, edits.slice(0, index + 1), options)).some(
            (edge) =>
              edge.target === first.target &&
              edge.side === first.side &&
              edge.seconds === first.seconds,
          ),
        );
        const index = asked[made] ?? asked.at(-1) ?? 0;
        return yield* new VideoProjectError({
          reason: `Edit ${index + 1} (${input.edits[index]?.kind}): ${clippedEdgeReason(first, layout.rate)}.${clipped.length > 1 ? ` ${clipped.length - 1} more edges in this call cut a sounding word too.` : ""} Nothing was changed.`,
        });
      }
    }
    const cuts = [
      ...cutNotes,
      ...(cutNotes.length === 0 ? [] : (sound?.unmeasured ?? [])).map(
        (reason) => `Not measured: ${reason}.`,
      ),
    ];
    const madeCut = target !== input.timeline;
    // Measuring the sound can take a while, and the user may have saved in the meantime: what
    // was worked out here is from the timeline as it was read, so it must still be that.
    const unchanged = Effect.gen(function* () {
      const now = yield* fileSystem
        .readFileString(timelineFile)
        .pipe(Effect.orElseSucceed(() => null));
      if (now !== textAtRead) {
        return yield* new VideoProjectError({
          reason: `${input.timeline} changed while this edit was being worked out: the user saved it. None of your edits were applied. Read the timeline again and redo them against what is there now.`,
        });
      }
    });
    yield* syncing.withPermits(1)(
      Effect.andThen(
        Effect.andThen(unchanged, madeCut ? startCut(input.workspaceRoot, timeline) : Effect.void),
        onHost(
          commitTimelineText({
            projectDir: input.workspaceRoot,
            timelinePath: target,
            text: serializeTimeline(madeCut ? cutFromFootage(edited) : edited),
            by,
            label: input.by === "user" ? "Edited" : "Edited by an agent",
            ...(review === undefined ? {} : { review }),
          }),
        ).pipe(Effect.mapError(historyError)),
      ),
    );
    // Media new to the timelines gets its preview made, as a pull's would.
    if (
      edits.some(
        (edit) =>
          (edit.kind === "insert" || edit.kind === "overwrite") &&
          media?.previewed.has(edit.media) === false,
      )
    ) {
      yield* startProxies(input.workspaceRoot);
    }
    const { result: after, view: synced } = yield* syncWithPremiere({
      workspaceRoot: input.workspaceRoot,
    });
    return {
      timelines: yield* listTimelines(input.workspaceRoot),
      timeline: target,
      premiere: synced.state,
      project: yield* describeProject(input.workspaceRoot, synced),
      // What the sync before the edit pulled or merged in, then what is pending with the edit.
      changes: [madeCut ? MADE_CUT : "", changesText({ ...before, pending: after.pending })]
        .filter((line) => line !== "")
        .join("\n"),
      text: editableView(edited),
      ...(cuts.length === 0 ? {} : { cuts: cuts.join("\n") }),
    };
  });

  const saveVoiceOver: VideoProjects["Service"]["saveVoiceOver"] = Effect.fn(
    "VideoProjects.saveVoiceOver",
  )(function* (input) {
    yield* requireProject(input.workspaceRoot);
    if (input.recording.byteLength === 0) {
      return yield* new VideoProjectError({ reason: "The recording was empty." });
    }
    const mediaRoot = path.dirname(input.workspaceRoot);
    const folder = path.join("Audio", "VO");
    // Local time, so the name matches the clock the person recorded by.
    const stamp = yield* DateTime.nowAsDate;
    const two = (value: number) => String(value).padStart(2, "0");
    const name = `VO ${stamp.getFullYear()}-${two(stamp.getMonth() + 1)}-${two(stamp.getDate())} ${two(stamp.getHours())}.${two(stamp.getMinutes())}.${two(stamp.getSeconds())}`;
    const target = path.join(mediaRoot, folder, `${name}.wav`);
    const raw = path.join(mediaRoot, folder, `${name}.recording`);
    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(path.join(mediaRoot, folder), { recursive: true });
      yield* fileSystem.writeFile(raw, input.recording);
      yield* spawner.string(
        ChildProcess.make("ffmpeg", [
          "-v",
          "error",
          "-y",
          "-i",
          raw,
          "-vn",
          "-ar",
          "48000",
          ...(input.channels === undefined ? [] : ["-ac", String(input.channels)]),
          "-c:a",
          "pcm_s24le",
          target,
        ]),
      );
    }).pipe(
      Effect.ensuring(fileSystem.remove(raw).pipe(Effect.ignore)),
      Effect.mapError(
        (cause) =>
          new VideoProjectError({
            reason: "Could not save the voice-over. Is ffmpeg installed on this machine?",
            cause,
          }),
      ),
    );
    yield* transcribeMissing(input.workspaceRoot);
    return { path: path.join(folder, `${name}.wav`), absolutePath: target };
  });

  const exportForPremiere: VideoProjects["Service"]["exportForPremiere"] = Effect.fn(
    "VideoProjects.exportForPremiere",
  )(function* (input) {
    yield* requireProject(input.workspaceRoot);
    const timelines = yield* listTimelines(input.workspaceRoot);
    const chosen = input.timeline ?? (yield* defaultTimeline(input.workspaceRoot, timelines));
    if (chosen === undefined) {
      return yield* new VideoProjectError({ reason: "This project has no timeline to export." });
    }
    const timeline = yield* loadTimeline(input.workspaceRoot, chosen);
    const index = yield* fileSystem
      .readFileString(path.join(input.workspaceRoot, PROXY_INDEX_PATH))
      .pipe(
        Effect.flatMap(decodeJson),
        Effect.map((value) => value as ProxyIndex),
        Effect.orElseSucceed(() => null),
      );
    // A new name each time, so an import never replaces a sequence the user has worked on.
    const stamp = yield* DateTime.nowAsDate;
    const two = (value: number) => String(value).padStart(2, "0");
    const sequenceName = `${timeline.name} (Stellar ${two(stamp.getHours())}.${two(stamp.getMinutes())})`;
    // A clip's `in` is a source frame number; variable-rate media finds it in its frame table.
    const mediaIndex: MediaIndex = yield* onHost(readMediaIndex(input.workspaceRoot));
    const frameTimes: Record<string, ArrayLike<number>> = {};
    for (const track of timeline.tracks.children) {
      for (const child of track.children) {
        if (child.OTIO_SCHEMA !== "Clip.2") continue;
        const target = child.media_references.DEFAULT_MEDIA.target_url;
        if (target in frameTimes) continue;
        const timing = mediaIndex.media[mediaKey(target, path.dirname(input.workspaceRoot))];
        const times = yield* onHost(loadFrameTimes(input.workspaceRoot, timing));
        if (times !== null) frameTimes[target] = times;
      }
    }
    const exported = toFcpXml(timeline, {
      sequenceName,
      media: index?.media ?? {},
      frameTimes,
    });
    const folder = path.join(path.dirname(input.workspaceRoot), "Premiere");
    const file = path.join(folder, `${sequenceName.replace(/[/\\:]+/g, " ")}.xml`);
    yield* fileSystem.makeDirectory(folder, { recursive: true }).pipe(
      Effect.andThen(fileSystem.writeFileString(file, exported.xml)),
      Effect.mapError(
        (cause) => new VideoProjectError({ reason: `Could not write ${file}.`, cause }),
      ),
    );
    return {
      path: file,
      sequenceName,
      clips: exported.xml.split("<clipitem ").length - 1,
      // Speed changes travel as a plain cut, which the same list reports.
      skipped: [...exported.skipped, ...exported.approximated],
    };
  });

  const pushPlan: VideoProjects["Service"]["pushPlan"] = Effect.fn("VideoProjects.pushPlan")(
    function* (input) {
      // Not merged here: a merge rewrites the timeline, and the agent should read what it became.
      const { result, view: synced } = yield* syncWithPremiere({
        workspaceRoot: input.workspaceRoot,
      });
      const timelines = yield* listTimelines(input.workspaceRoot);
      const chosen = input.timeline ?? (yield* defaultTimeline(input.workspaceRoot, timelines));
      if (chosen === undefined) {
        return yield* new VideoProjectError({ reason: "This project has no timeline to push." });
      }
      const timeline = yield* loadTimeline(input.workspaceRoot, chosen);
      const state = {
        timeline: chosen,
        premiereRunning: synced.premiereRunning,
        linked: synced.state !== "unlinked",
        premiereIsNewer: synced.state === "conflict" && result.kept.includes(chosen),
      };
      const refuse = (refused: string): VideoPremierePushPlan => ({
        ...state,
        refused,
        steps: 0,
        manual: [],
        plan: "",
        instructions: refused,
      });
      if (synced.state === "unlinked") {
        return refuse(
          "No Premiere project is linked: save one into the project's Premiere folder and video_premiere_pull its sequence, or use video_premiere_export for a first cut.",
        );
      }
      if (synced.state === "offline") {
        return refuse("The linked Premiere project can't be read (drive unplugged or file moved).");
      }
      if (state.premiereIsNewer) {
        return refuse(
          "Pull first: Premiere saved a newer version of this sequence than the edits here started from. Call video_timeline_read, which merges it with the edits made here, then ask for the plan again.",
        );
      }
      const pulled = yield* onHost(pulledHash(input.workspaceRoot, chosen));
      const base = Option.fromNullishOr(
        pulled === null ? null : yield* onHost(readBase(input.workspaceRoot, chosen, pulled)),
      );
      if (Option.isNone(base)) {
        return refuse("No record of Premiere's version yet; sync once with Premiere open.");
      }
      const mediaRoot =
        (timeline.metadata[TIMELINE_NAMESPACE] as { mediaRoot?: string } | undefined)?.mediaRoot ??
        path.dirname(input.workspaceRoot);
      const plan = yield* Effect.try({
        try: () =>
          planPush(base.value, timeline, {
            mediaPath: (target) =>
              path.isAbsolute(target) ? target : path.join(mediaRoot, target),
          }),
        catch: (cause) =>
          new VideoProjectError({ reason: `Could not plan the push of ${chosen}.`, cause }),
      });
      const closed =
        synced.premiereRunning === false
          ? [
              "Premiere is NOT open: call video_premiere_open first, check with a Premiere tool that the project has loaded, then apply the steps.",
            ]
          : [];
      const instructions =
        plan.steps.length === 0 && plan.manual.length === 0
          ? "Nothing to push: Premiere's last save already holds this timeline."
          : [
              ...closed,
              `Open the sequence "${timeline.name}" in Premiere and apply the steps in order with the Premiere tools, one clip per step (linked partners have steps of their own). Each step gives its position as it is when that step runs; clip ids change after every edit, so read the sequence again before each step and find the clip by track and start time. Tracks are numbered as Premiere shows them (V1 is video track 1; a tool that counts from 0 takes one less). Seconds are exact for the frames beside them.`,
              ...(Number.isInteger(plan.rate)
                ? []
                : [
                    `The sequence runs at ${plan.rate.toFixed(3)} fps: a tool that takes whole frame rates only will refuse a ripple-remove; razor both ends of the range and ripple-delete what is between them.`,
                  ]),
              ...(plan.steps.some((step) => step.kind.endsWith("Marker"))
                ? [
                    "Marker steps come last and give each marker's final place. List the sequence's markers first and find each by name and comment: Premiere may have moved them with the ripple steps. Write a marker's comment exactly as given; a last line like [stellar: agent, resolved] is how Stellar reads back who made it and that it is resolved. A clip marker goes on the source clip in the project, at the source time given.",
                  ]
                : []),
              ...(plan.steps.some((step) => step.kind === "place")
                ? [
                    "An insert or overwrite step places a clip of a media file: find the file in the Premiere project by its path, importing it when it isn't there, then insert or overwrite it at the step's time on the tracks named, with the source in and out given. Target only those tracks; an insert moves every track's later clips (sync lock on), an overwrite moves nothing. A track to add comes first as its own step.",
                  ]
                : []),
              ...(plan.manual.length === 0
                ? []
                : [
                    "The plan's by-hand list is not covered by the steps: do what your Premiere tools can do safely yourself, and tell the user only what is left.",
                  ]),
              "Then save the project in Premiere and call video_timeline_read: `premiere` is `current` once Premiere matches, and `changes` lists what still differs.",
            ].join("\n");
      return {
        ...state,
        refused: null,
        steps: plan.steps.length,
        manual: plan.manual,
        plan: plan.text,
        instructions,
      };
    },
  );

  /** The `.prproj` a project follows, else the only one in its Premiere folder. */
  const premiereProjectOf = Effect.fn("VideoProjects.premiereProjectOf")(function* (
    workspaceRoot: string,
  ) {
    const linked = yield* fileSystem
      .readFileString(path.join(workspaceRoot, PREMIERE_LINK_PATH))
      .pipe(
        Effect.flatMap(decodeJson),
        Effect.map((value) => (value as { project?: string }).project ?? null),
        Effect.orElseSucceed(() => null),
      );
    if (linked !== null) {
      if (yield* fileSystem.exists(linked).pipe(Effect.orElseSucceed(() => false))) return linked;
      return yield* new VideoProjectError({
        reason: `The linked Premiere project ${linked} can't be found: its drive may be unplugged, or it moved.`,
      });
    }
    const folder = path.join(path.dirname(workspaceRoot), "Premiere");
    const found = (yield* fileSystem
      .readDirectory(folder)
      .pipe(Effect.orElseSucceed((): Array<string> => [])))
      .filter((name) => name.endsWith(".prproj") && !name.startsWith("."))
      .toSorted();
    const [only] = found;
    if (only !== undefined && found.length === 1) return path.join(folder, only);
    return yield* new VideoProjectError({
      reason:
        found.length === 0
          ? `No Premiere project yet: none is linked and ${folder} holds no .prproj. Make one in Premiere (a Premiere tool can create it) and save it there, then video_premiere_pull.`
          : `No Premiere project is linked and ${folder} holds ${found.length}: ${found.join(", ")}. video_premiere_pull the one to follow.`,
    });
  });

  const openInPremiere: VideoProjects["Service"]["openInPremiere"] = Effect.fn(
    "VideoProjects.openInPremiere",
  )(function* (input) {
    yield* requireProject(input.workspaceRoot);
    const project = yield* premiereProjectOf(input.workspaceRoot);
    const platform = yield* HostProcess.Platform;
    if (platform !== "darwin" && platform !== "win32") {
      return yield* new VideoProjectError({
        reason: `Premiere Pro runs on macOS and Windows only, and Stellar's host here is ${platform}. Open ${project} in Premiere on a Mac or PC that can reach it.`,
      });
    }
    const app = platform === "darwin" ? yield* onHost(findPremiereApp()) : null;
    if (platform === "darwin" && app === null) {
      return yield* new VideoProjectError({
        reason:
          "Premiere Pro isn't installed in /Applications on this Mac. Install it from Creative Cloud, then try again.",
      });
    }
    const wasRunning = yield* premiereRunning;
    // Both return once the app has the file: `open -a` also brings a running Premiere forward,
    // and `start` hands the project to the app Windows opens .prproj files with.
    const command =
      app !== null
        ? ChildProcess.make("open", ["-a", app, project])
        : // The empty argument is `start`'s window title, quoted by Node as "".
          ChildProcess.make("cmd.exe", ["/c", "start", "", project]);
    yield* spawner.string(command).pipe(
      Effect.mapError(
        (cause) =>
          new VideoProjectError({
            reason:
              app === null
                ? `Windows couldn't open ${project}. Is Premiere Pro installed, and does it open .prproj files?`
                : `Could not open ${project} with ${app}.`,
            cause,
          }),
      ),
    );
    // Premiere's process shows within seconds of launch; loading the project takes longer.
    const running =
      wasRunning === true
        ? true
        : yield* premiereRunning.pipe(
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              until: (now) => now !== false,
            }),
            Effect.timeoutOption("60 seconds"),
            Effect.map(Option.getOrElse((): boolean | null => false)),
          );
    const name = path.basename(project);
    return {
      project,
      app,
      wasRunning,
      premiereRunning: running,
      next:
        running === false
          ? `Premiere didn't start within a minute. Check the host for a sign-in or update prompt, then call video_premiere_open again.`
          : wasRunning === true
            ? `Premiere was running and has ${name} in front. Check with a Premiere tool that ${name} is the open project, then continue.`
            : `Premiere is starting with ${name}; loading takes up to a minute. Check with a Premiere tool (its connection check, then the open project) until it answers with ${name}, then continue.`,
    };
  });

  // One writer of the take index at a time, so two saves can't be given the same take id.
  const savingTakes = yield* Semaphore.make(1);

  const voiceOverView = Effect.fn("VideoProjects.voiceOverView")(function* (
    workspaceRoot: string,
    requested: string | undefined,
    changes: ReadonlyArray<string> = [],
  ) {
    const mediaRoot = path.dirname(workspaceRoot);
    const script = yield* loadScript(workspaceRoot);
    const index = yield* onHost(readTakeIndex(workspaceRoot));
    const timelines = yield* listTimelines(workspaceRoot);
    const chosen = requested ?? (yield* defaultTimeline(workspaceRoot, timelines)) ?? null;
    const placed =
      chosen === null
        ? null
        : placedVoiceOver(yield* loadTimeline(workspaceRoot, chosen), index.takes);
    const indexed = new Set(index.takes.map((take) => take.file));
    const recordings = yield* fileSystem
      .readDirectory(path.join(mediaRoot, TAKE_FOLDER))
      .pipe(Effect.orElseSucceed((): Array<string> => []));
    const lines = new Set(script.beats.map((beat) => beat.id));
    const orphaned = new Map<string, number>();
    for (const take of index.takes) {
      if (!lines.has(take.beatId)) orphaned.set(take.beatId, (orphaned.get(take.beatId) ?? 0) + 1);
    }
    const view: VideoVoiceOverView = {
      timeline: chosen,
      mediaRoot,
      beats: script.beats.map((beat) => {
        const on = placed?.get(beat.id);
        return {
          id: beat.id,
          text: beat.text,
          section: beat.section,
          takes: index.takes
            .filter((take) => take.beatId === beat.id)
            .map((take) => ({
              id: take.id,
              path: take.file,
              seconds: take.seconds,
              source: take.source,
              createdAt: take.createdAt,
            })),
          chosen: index.chosen[beat.id] ?? null,
          placed:
            on === undefined
              ? null
              : {
                  takeId: on.takeId,
                  track: on.track,
                  startFrame: on.startFrame,
                  endFrame: on.endFrame,
                },
        };
      }),
      loose: recordings
        .filter((name) => /\.wav$/i.test(name) && !name.startsWith("."))
        .map((name) => `${TAKE_FOLDER}/${name}`)
        .filter((file) => !indexed.has(file))
        .toSorted(),
      orphaned: [...orphaned].map(([beatId, takes]) => ({ beatId, takes })),
      changes: [...changes],
    };
    return view;
  });

  const readVoiceOver: VideoProjects["Service"]["readVoiceOver"] = Effect.fn(
    "VideoProjects.readVoiceOver",
  )(function* (input) {
    yield* requireProject(input.workspaceRoot);
    return yield* voiceOverView(input.workspaceRoot, input.timeline);
  });

  const takeIndexError = (cause: unknown) =>
    new VideoProjectError({ reason: "Could not save the list of takes.", cause });

  const saveTake: VideoProjects["Service"]["saveTake"] = Effect.fn("VideoProjects.saveTake")(
    function* (input) {
      yield* requireProject(input.workspaceRoot);
      const importPath = input.path;
      const script = yield* loadScript(input.workspaceRoot);
      if (!script.beats.some((beat) => beat.id === input.beatId)) {
        return yield* new VideoProjectError({
          reason: `The script has no line ${input.beatId}. Its lines are ${script.beats.map((beat) => beat.id).join(", ") || "not saved yet"}.`,
        });
      }
      const mediaRoot = path.dirname(input.workspaceRoot);
      yield* savingTakes.withPermits(1)(
        Effect.gen(function* () {
          const index = yield* onHost(readTakeIndex(input.workspaceRoot));
          const id = nextTakeId(index);
          const file = `${TAKE_FOLDER}/VO ${input.beatId.replace(/[^\w-]+/g, "_")} ${id}.wav`;
          const seconds = yield* onHost(
            encodeTake({
              source: path.resolve(mediaRoot, importPath),
              target: path.join(mediaRoot, file),
            }),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new VideoProjectError({ reason: `Could not read ${importPath} as audio.`, cause }),
            ),
          );
          if (seconds === null) {
            return yield* new VideoProjectError({ reason: "There is no audio in that file." });
          }
          yield* onHost(
            writeTakeIndex(
              input.workspaceRoot,
              addTake(index, {
                id,
                beatId: input.beatId,
                file,
                seconds,
                source: "imported",
                createdAt: yield* Clock.currentTimeMillis,
              }),
            ),
          ).pipe(Effect.mapError(takeIndexError));
        }),
      );
      yield* transcribeMissing(input.workspaceRoot);
      return yield* voiceOverView(input.workspaceRoot, input.timeline);
    },
  );

  const chooseTake: VideoProjects["Service"]["chooseTake"] = Effect.fn("VideoProjects.chooseTake")(
    function* (input) {
      yield* requireProject(input.workspaceRoot);
      yield* savingTakes.withPermits(1)(
        Effect.gen(function* () {
          const index = yield* onHost(readTakeIndex(input.workspaceRoot));
          const next = chooseIndexedTake(index, input.beatId, input.takeId);
          if (typeof next === "string") {
            return yield* new VideoProjectError({ reason: `Can't choose that take: ${next}.` });
          }
          yield* onHost(writeTakeIndex(input.workspaceRoot, next)).pipe(
            Effect.mapError(takeIndexError),
          );
        }),
      );
      return yield* voiceOverView(input.workspaceRoot, input.timeline);
    },
  );

  const applyVoiceOver: VideoProjects["Service"]["applyVoiceOver"] = Effect.fn(
    "VideoProjects.applyVoiceOver",
  )(function* (input) {
    if (input.timeline === FOOTAGE_TIMELINE_PATH) {
      return yield* new VideoProjectError({
        reason:
          "The footage timeline is rebuilt whenever footage changes, so voice-over placed on it would be lost. Place it on a cut.",
      });
    }
    const { result: before } = yield* syncForAgent(input.workspaceRoot);
    if (before.unmerged.includes(input.timeline)) {
      return yield* new VideoProjectError({
        reason: `${input.timeline} was edited here and in Premiere, and they can't be merged: ${NO_BASE} Nothing was changed. Choose a version in Stellar first.`,
      });
    }
    let timeline = yield* loadTimeline(input.workspaceRoot, input.timeline);
    const script = yield* loadScript(input.workspaceRoot);
    const index = yield* onHost(readTakeIndex(input.workspaceRoot));
    const order = script.beats.map((beat) => beat.id);
    const unknown = (input.beatIds ?? []).filter((beatId) => !order.includes(beatId));
    if (unknown.length > 0) {
      return yield* new VideoProjectError({
        reason: `The script has no line ${unknown.join(", ")}.`,
      });
    }
    const proxies = yield* fileSystem
      .readFileString(path.join(input.workspaceRoot, PROXY_INDEX_PATH))
      .pipe(
        Effect.flatMap(decodeJson),
        Effect.map((value) => value as ProxyIndex),
        Effect.orElseSucceed(() => null),
      );
    const takeSeconds = new Map(index.takes.map((take) => [take.file, take.seconds]));
    const mediaSeconds = (target: string) =>
      proxies?.media[target]?.duration ?? takeSeconds.get(target);
    const changes: Array<string> = [];
    const refused: Array<string> = [];
    for (const beatId of order) {
      if (input.beatIds !== undefined && !input.beatIds.includes(beatId)) continue;
      const take = index.takes.find((other) => other.id === index.chosen[beatId]);
      if (take === undefined) {
        if (input.beatIds !== undefined) refused.push(`${beatId} has no take to place.`);
        continue;
      }
      if (placedVoiceOver(timeline, index.takes).get(beatId)?.takeId === take.id) continue;
      const placement = placeTake(timeline, { take, takes: index.takes, order, mediaSeconds });
      if (typeof placement === "string") {
        refused.push(`${beatId} was not placed: ${placement}.`);
        continue;
      }
      timeline = placement.timeline;
      const frames = placement.endFrame - placement.startFrame;
      changes.push(
        [
          `${beatId}: take ${take.id} is on ${placement.track} at frames ${placement.startFrame}-${placement.endFrame}.`,
          ...(placement.movedBy === 0
            ? []
            : [
                `The line went from ${placement.previousFrames} to ${frames} frames, so everything after it moved ${placement.movedBy > 0 ? "+" : ""}${placement.movedBy} frames${placement.retimed === 0 ? "" : ` and ${placement.retimed} ${placement.retimed === 1 ? "clip" : "clips"} under it ${placement.retimed === 1 ? "was" : "were"} re-timed`}.`,
              ]),
          ...placement.short.map(
            (short) =>
              `${short.track} #${short.clipId} ${short.name} has no more source to stretch into: ${short.frames} frames are empty from frame ${short.atFrame}.`,
          ),
        ].join(" "),
      );
    }
    if (changes.length === 0) {
      if (refused.length > 0) {
        return yield* new VideoProjectError({
          reason: `${refused.join(" ")} Nothing was changed.`,
        });
      }
      return yield* voiceOverView(input.workspaceRoot, input.timeline);
    }
    yield* syncing.withPermits(1)(
      onHost(
        commitTimelineText({
          projectDir: input.workspaceRoot,
          timelinePath: input.timeline,
          text: serializeTimeline(timeline),
          by: input.by ?? "user",
          label: "Voice-over placed",
        }),
      ).pipe(Effect.mapError(historyError)),
    );
    yield* syncWithPremiere({ workspaceRoot: input.workspaceRoot });
    return yield* voiceOverView(input.workspaceRoot, input.timeline, [...changes, ...refused]);
  });

  const splitTake: VideoProjects["Service"]["splitTake"] = Effect.fn("VideoProjects.splitTake")(
    function* (input) {
      yield* requireProject(input.workspaceRoot);
      const mediaRoot = path.dirname(input.workspaceRoot);
      const source = path
        .relative(mediaRoot, path.resolve(mediaRoot, input.path))
        .split(path.sep)
        .join("/");
      if (source === "" || source.startsWith("..") || path.isAbsolute(source)) {
        return yield* new VideoProjectError({
          reason: `The recording to split is named relative to ${mediaRoot}.`,
        });
      }
      const transcript = yield* onHost(findTranscript(mediaRoot, source));
      if (transcript === null) {
        return yield* new VideoProjectError({
          reason: `${source} has no word-timed transcript yet, which is what finds each line in it. Transcribe it, then split it.`,
        });
      }
      const words = yield* fileSystem.readFileString(transcript).pipe(
        Effect.flatMap(decodeTranscript),
        Effect.mapError(
          (cause) =>
            new VideoProjectError({
              reason: `Could not read the transcript ${transcript}.`,
              cause,
            }),
        ),
      );
      const script = yield* loadScript(input.workspaceRoot);
      const slices = sliceByBeats(script.beats, words);
      if (slices.length === 0) {
        return yield* new VideoProjectError({
          reason: `None of the script's ${script.beats.length} lines are said in ${source}.`,
        });
      }
      const changes: Array<string> = [];
      yield* savingTakes.withPermits(1)(
        Effect.gen(function* () {
          let index = yield* onHost(readTakeIndex(input.workspaceRoot));
          for (const slice of slices) {
            const id = nextTakeId(index);
            const name = `VO ${slice.beatId.replace(/[^\w-]+/g, "_")} ${id}`;
            const file = `${TAKE_FOLDER}/${name}.wav`;
            const seconds = yield* onHost(
              encodeTake({
                source: path.join(mediaRoot, source),
                target: path.join(mediaRoot, file),
                from: slice.start,
                to: slice.end,
              }),
            );
            if (seconds === null) continue;
            // The slice's words are already known, so it needs no transcribing of its own.
            yield* fileSystem.writeFileString(
              path.join(mediaRoot, TRANSCRIPT_FOLDER, `${name}.words.json`),
              serializeJson(slice.words),
            );
            index = addTake(index, {
              id,
              beatId: slice.beatId,
              file,
              seconds,
              source: "split",
              createdAt: yield* Clock.currentTimeMillis,
            });
            changes.push(
              `${slice.beatId}: take ${id} (${seconds.toFixed(1)}s) cut from ${slice.start.toFixed(2)}-${slice.end.toFixed(2)}s.`,
            );
          }
          yield* onHost(writeTakeIndex(input.workspaceRoot, index));
        }).pipe(
          Effect.mapError(
            (cause) =>
              new VideoProjectError({
                reason: `Could not split ${source}. Is ffmpeg installed on this machine?`,
                cause,
              }),
          ),
        ),
      );
      return yield* voiceOverView(input.workspaceRoot, input.timeline, changes);
    },
  );

  /** What `preflight` needs that a caller has already read, so it isn't read twice. */
  interface KnownFacts {
    readonly footage: number;
    readonly coverage: { readonly total: number; readonly missing: ReadonlyArray<string> };
  }

  const readPreflight = Effect.fn("VideoProjects.readPreflight")(function* (
    workspaceRoot: string,
    known?: KnownFacts,
  ) {
    const mediaRoot = path.dirname(workspaceRoot);
    const footage = known?.footage ?? (yield* onHost(listFootage(mediaRoot))).length;
    const coverage = known?.coverage ?? (yield* onHost(transcriptCoverage(mediaRoot)));
    const intake = yield* fileSystem
      .readFileString(path.join(workspaceRoot, INTAKE_STATUS_FILE))
      .pipe(Effect.flatMap(decodeIntakeStatus), Effect.option);
    const index = yield* fileSystem.readFileString(path.join(workspaceRoot, PROXY_INDEX_PATH)).pipe(
      Effect.flatMap(decodeJson),
      Effect.map((value) => value as ProxyIndex),
      Effect.orElseSucceed(() => null),
    );
    const transcribed = transcribing.get(workspaceRoot);
    const report = yield* onHost(readRenderReport(workspaceRoot));
    const posted = yield* onHost(readPosted(workspaceRoot));
    const steps = derivePreflight({
      footage,
      intake: Option.getOrNull(intake),
      proxies:
        index === null
          ? null
          : {
              building: index.building ?? null,
              ready: Object.keys(index.media).length,
              failed: index.failed ?? 0,
              error: index.error ?? null,
            },
      transcripts: {
        ready: coverage.total - coverage.missing.length,
        total: coverage.total,
        building: transcribed?.building ?? null,
        failed: transcribed?.failed.length ?? 0,
        unavailable:
          coverage.missing.length > 0 && (yield* resolveTranscriber).unavailable !== null,
      },
      premiere: (yield* onHost(premiereLinkStatus(workspaceRoot))).state,
      hasExport: (yield* onHost(newestExport(mediaRoot))) !== null,
      render:
        report === null
          ? null
          : {
              level: report.level,
              problems: report.items.filter((item) => item.level !== "pass").length,
              stale: yield* onHost(renderStaleness(workspaceRoot, report)),
            },
      posted,
    });
    return { steps, render: report, posted } satisfies VideoPreflight;
  });

  /** The run in one line for `describeProject`: how far it is, and the step to take next. */
  const runLine = Effect.fn("VideoProjects.runLine")(function* (
    workspaceRoot: string,
    known: KnownFacts,
  ) {
    const { steps } = yield* readPreflight(workspaceRoot, known);
    const next = preflightHeadline(steps);
    const done = steps.filter((step) => step.state === "done").length;
    return `Run: ${done} of ${steps.length} steps done${next === null ? "" : `; next: ${preflightLine(next)}`}. video_preflight lists every step.`;
  });

  const preflight: VideoProjects["Service"]["preflight"] = Effect.fn("VideoProjects.preflight")(
    function* (input) {
      yield* requireProject(input.workspaceRoot);
      return yield* readPreflight(input.workspaceRoot);
    },
  );

  const checkRender: VideoProjects["Service"]["checkRender"] = Effect.fn(
    "VideoProjects.checkRender",
  )(function* (input) {
    yield* requireProject(input.workspaceRoot);
    // The export is of Premiere's sequence, so it is compared with Premiere's latest save. A
    // sync that can't run (the drive unplugged) leaves the timeline as it is.
    yield* syncWithPremiere({ workspaceRoot: input.workspaceRoot }).pipe(Effect.ignore);
    const timelines = yield* listTimelines(input.workspaceRoot);
    const chosen = input.timeline ?? (yield* defaultTimeline(input.workspaceRoot, timelines));
    if (chosen === undefined || !timelines.includes(chosen)) {
      return yield* new VideoProjectError({
        reason: `No timeline to check the export against. This project has: ${timelines.join(", ") || "none"}.`,
      });
    }
    const timelineText = yield* fileSystem
      .readFileString(path.join(input.workspaceRoot, chosen))
      .pipe(
        Effect.mapError(
          (cause) => new VideoProjectError({ reason: `Could not read ${chosen}.`, cause }),
        ),
      );
    const timeline = yield* decodeJson(timelineText).pipe(
      Effect.map((value) => value as Timeline),
      Effect.mapError(
        (cause) => new VideoProjectError({ reason: `Could not read ${chosen}.`, cause }),
      ),
    );
    return yield* onHost(
      runRenderCheck({
        projectDir: input.workspaceRoot,
        timelinePath: chosen,
        timelineText,
        timeline,
        exportPath: input.exportPath,
      }),
    ).pipe(Effect.mapError((cause) => new VideoProjectError({ reason: cause.message, cause })));
  });

  const setPosted: VideoProjects["Service"]["setPosted"] = Effect.fn("VideoProjects.setPosted")(
    function* (input) {
      yield* requireProject(input.workspaceRoot);
      const posted = input.posted
        ? { at: input.at ?? (yield* Clock.currentTimeMillis), urls: input.urls ?? [] }
        : null;
      yield* onHost(writePosted(input.workspaceRoot, posted)).pipe(
        Effect.mapError(
          (cause) => new VideoProjectError({ reason: "Could not save the project file.", cause }),
        ),
      );
      return yield* readPreflight(input.workspaceRoot);
    },
  );

  return VideoProjects.of({
    readVoiceOver,
    saveTake,
    chooseTake,
    applyVoiceOver,
    splitTake,
    checkRender,
    preflight,
    setPosted,
    exportForPremiere,
    pushPlan,
    openInPremiere,
    saveVoiceOver,
    readTimeline,
    readWords,
    soundPicture,
    readScript,
    saveScript,
    transcribe,
    editTimeline,
    commitTimeline,
    listVersions,
    readVersion,
    restoreVersion,
    listEdits,
    reviewEdit,
    inspectPremiere,
    createFromPremiere,
    createFromIdea,
    projectsFolder,
    scanIntake,
    importFootage,
    conformFootage,
    sync,
  });
});

export const layer = Layer.effect(VideoProjects, make);
