/**
 * Replays a stored plan (an agent's edit tool calls, with their arguments) through this checkout's
 * timeline code, with no model call. The same plan replayed before and after a tool change shows
 * what the change does to the cut.
 */
import { VideoTimelineEdit } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { applyEdits, type TimelineEdit } from "../../packages/timeline/src/edits.ts";
import {
  clippedEdgeReason,
  clippedEdges,
  placePauseCut,
  placeWordCut,
  type SourceEdge,
} from "../../packages/timeline/src/joins.ts";
import { layoutTimeline } from "../../packages/timeline/src/layout.ts";
import type { AudioLevels } from "../../packages/timeline/src/levels.ts";
import type { Timeline } from "../../packages/timeline/src/otio.ts";
import { timelineWords } from "../../packages/timeline/src/words.ts";
import type { Transcripts } from "./score.ts";

/** Each source's measured levels, by media `target_url`. A source with none is cut by timings. */
export type Levels = ReadonlyMap<string, AudioLevels>;

/**
 * A plan file. `calls` are the run's Stellar video tool calls in order; only `video_timeline_edit`
 * changes the replayed timeline. Times are ISO strings and optional: with `startedAt` and a call's
 * `at`, the score reports the time to the first edit.
 */
export const Plan = Schema.Struct({
  version: Schema.Literal(1),
  /** Where the plan came from: a thread and run, or `hand-written`. */
  source: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  startedAt: Schema.optional(Schema.String),
  calls: Schema.Array(
    Schema.Struct({
      /** The bare tool name, such as `video_timeline_edit`. */
      tool: Schema.String,
      at: Schema.optional(Schema.String),
      input: Schema.Unknown,
    }),
  ),
});
export type Plan = typeof Plan.Type;

const EditInput = Schema.Struct({
  timeline: Schema.optional(Schema.String),
  edits: Schema.Array(VideoTimelineEdit),
  summary: Schema.optional(Schema.String),
});
// Undeclared keys are dropped, as the MCP server drops them, so a plan captured after a tool gained
// an argument still replays on a checkout without it. `summary` is optional here though the tool
// requires it: plans captured before it existed still replay.
const decodeEditInput = Schema.decodeUnknownOption(EditInput);

/** Tools that change a timeline in ways a plan alone can't reproduce. */
const UNREPLAYED = new Set(["video_voice_over", "video_footage", "video_premiere_pull"]);

/** The edits that can leave a clip starting or ending somewhere new, as the server lists them. */
const EDGE_MAKING_EDITS: ReadonlySet<VideoTimelineEdit["kind"]> = new Set([
  "removeWords",
  "trimPause",
  "move",
  "trim",
  "delete",
  "rippleDelete",
  "removeRange",
  "setEnabled",
]);

export interface ReplayedCall {
  readonly index: number;
  readonly tool: string;
  readonly status: "applied" | "refused" | "skipped";
  /** Why a call was refused or skipped, or what an applied call left out. */
  readonly note?: string;
  /** What the agent said the call did, for the person reading the results. */
  readonly summary?: string;
}

type FrameRange = { readonly start: number; readonly end: number };

/**
 * One call's typed edits, or why the call is refused. This mirrors `VideoProjects.editTimeline`,
 * which holds the same steps inside the server: word numbers are read once, before the call, a
 * cut named by words goes where `packages/timeline`'s `joins.ts` places it on the measured
 * levels, an edge left inside a sounding word refuses the call, and so does one bad edit.
 */
const resolveEdits = (
  timeline: Timeline,
  transcripts: Transcripts,
  levels: Levels,
  edits: ReadonlyArray<VideoTimelineEdit>,
): { readonly timeline: Timeline; readonly left: Array<string> } | string => {
  const layout = layoutTimeline(timeline);
  const clipIds = new Set(layout.tracks.flatMap((track) => track.clips.map((clip) => clip.key)));
  const trackNames = new Set(layout.tracks.map((track) => track.name));
  const words = timelineWords(timeline, transcripts);
  const rippled: Array<FrameRange> = [];
  const afterCuts = (frame: number) =>
    frame -
    rippled.reduce((sum, cut) => sum + Math.max(0, Math.min(frame, cut.end) - cut.start), 0);
  const resolved: Array<TimelineEdit> = [];
  // The call's edit each resolved one came from, to name the edit that clips a word.
  const asked: Array<number> = [];
  const placedEdges: Array<SourceEdge> = [];
  const left: Array<string> = [];
  for (const [index, edit] of edits.entries()) {
    const refuse = (problem: string) => `Edit ${index + 1} (${edit.kind}): ${problem}`;
    const { clipId } = edit;
    // A split names its later piece `<clipId>~<frame>` before that piece exists.
    const knownClip = clipId !== undefined && (clipIds.has(clipId) || clipId.includes("~"));
    const before = resolved.length;
    switch (edit.kind) {
      case "removeWords":
      case "trimPause": {
        const { fromWord, toWord, afterWord } = edit;
        const range =
          edit.kind === "trimPause"
            ? afterWord === undefined
              ? "needs afterWord"
              : placePauseCut(words, levels, afterWord, edit.leave)
            : fromWord === undefined || toWord === undefined
              ? "needs fromWord, toWord"
              : placeWordCut(words, levels, fromWord, toWord);
        if (typeof range === "string") return refuse(range);
        if ("nothing" in range) {
          left.push(range.nothing);
          break;
        }
        // A trimmed pause closes up unless told not to; a word cut leaves a hole unless told to.
        const ripple = edit.ripple ?? edit.kind === "trimPause";
        placedEdges.push(...range.edges);
        resolved.push({
          kind: "removeRange",
          start: afterCuts(range.start),
          end: afterCuts(range.end),
          ripple,
        });
        if (ripple) rippled.push(range);
        break;
      }
      case "removeRange":
        if (edit.start === undefined || edit.end === undefined) return refuse("needs start, end");
        resolved.push({
          kind: "removeRange",
          start: edit.start,
          end: edit.end,
          ripple: edit.ripple ?? false,
        });
        break;
      case "split":
        if (edit.frame === undefined) return refuse("needs frame");
        resolved.push({
          kind: "split",
          frame: edit.frame,
          ...(edit.tracks === undefined ? {} : { tracks: edit.tracks }),
        });
        break;
      case "delete":
      case "rippleDelete":
        if (clipId === undefined || !knownClip) return refuse(`no clip #${clipId}`);
        resolved.push({ kind: edit.kind, clipId });
        break;
      case "trim":
        if (clipId === undefined || !knownClip) return refuse(`no clip #${clipId}`);
        if (edit.edge === undefined || edit.frame === undefined) return refuse("needs edge, frame");
        resolved.push({ kind: "trim", clipId, edge: edit.edge, frame: edit.frame });
        break;
      case "setEnabled":
        if (clipId === undefined || !knownClip) return refuse(`no clip #${clipId}`);
        if (edit.enabled === undefined) return refuse("needs enabled");
        resolved.push({ kind: "setEnabled", clipId, enabled: edit.enabled });
        break;
      case "move":
        if (clipId === undefined || !knownClip) return refuse(`no clip #${clipId}`);
        if (edit.toTrack === undefined || edit.startFrame === undefined) {
          return refuse("needs toTrack, startFrame");
        }
        if (!trackNames.has(edit.toTrack)) return refuse(`no track ${edit.toTrack}`);
        resolved.push({
          kind: "move",
          clipId,
          toTrack: edit.toTrack,
          startFrame: edit.startFrame,
          ...(edit.magnetic === undefined ? {} : { magnetic: edit.magnetic }),
        });
        break;
      case "restoreVersion":
        // A version id names a state of the run's own history, which a plan does not carry.
        return refuse("a restore can't be replayed");
      default:
        // Markers and text change no cut, so they are left out rather than refused.
        left.push(edit.kind);
    }
    if (resolved.length > before) asked.push(index);
  }
  const clippedBy = (result: Timeline) =>
    clippedEdges(words, timelineWords(result, transcripts), transcripts, levels, placedEdges);
  const edited = applyEdits(timeline, resolved);
  const [first] = edits.some((edit) => EDGE_MAKING_EDITS.has(edit.kind)) ? clippedBy(edited) : [];
  if (first !== undefined) {
    // The first edit after which the edge is there made it.
    const made = resolved.findIndex((_, index) =>
      clippedBy(applyEdits(timeline, resolved.slice(0, index + 1))).some(
        (edge) =>
          edge.target === first.target &&
          edge.side === first.side &&
          edge.seconds === first.seconds,
      ),
    );
    const index = asked[made] ?? asked.at(-1) ?? 0;
    return `Edit ${index + 1} (${edits[index]?.kind}): ${clippedEdgeReason(first, layout.rate)}`;
  }
  return { timeline: edited, left };
};

/** `mcp__t3-code__video_timeline_edit` and Codex's `t3-code.video_timeline_edit`, as one name. */
export const bareToolName = (name: string) => name.replace(/^(mcp__)?t3[-_]code(__|\.)/, "");

export const replayPlan = (input: {
  readonly start: Timeline;
  readonly transcripts: Transcripts;
  /** Omitted, nothing is measured: word cuts keep their word timings and no edge is judged. */
  readonly levels?: Levels | undefined;
  readonly plan: Plan;
  /** The timeline the case is about. Omitted, the one the plan's first edit names. */
  readonly timelineName?: string | undefined;
}) => {
  let timeline = input.start;
  let target = input.timelineName;
  const calls: Array<ReplayedCall> = [];
  for (const [index, call] of input.plan.calls.entries()) {
    const tool = bareToolName(call.tool);
    if (UNREPLAYED.has(tool)) {
      calls.push({ index, tool, status: "skipped", note: "this tool can't be replayed" });
      continue;
    }
    if (tool !== "video_timeline_edit") continue;
    const decoded = decodeEditInput(call.input);
    if (decoded._tag === "None") {
      calls.push({ index, tool, status: "refused", note: "this checkout can't read the input" });
      continue;
    }
    target ??= decoded.value.timeline;
    if (decoded.value.timeline !== undefined && decoded.value.timeline !== target) {
      calls.push({ index, tool, status: "skipped", note: `edits ${decoded.value.timeline}` });
      continue;
    }
    const summary = decoded.value.summary === undefined ? {} : { summary: decoded.value.summary };
    const resolved = resolveEdits(
      timeline,
      input.transcripts,
      input.levels ?? new Map(),
      decoded.value.edits,
    );
    if (typeof resolved === "string") {
      calls.push({ index, tool, status: "refused", note: resolved, ...summary });
      continue;
    }
    timeline = resolved.timeline;
    calls.push({
      index,
      tool,
      status: "applied",
      ...(resolved.left.length === 0 ? {} : { note: `left out: ${resolved.left.join(", ")}` }),
      ...summary,
    });
  }
  return { timeline, calls };
};

const ToolItem = Schema.Struct({
  type: Schema.Literal("dynamic_tool"),
  toolName: Schema.String,
  status: Schema.String,
  input: Schema.Unknown,
  runId: Schema.optional(Schema.NullOr(Schema.String)),
  startedAt: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeToolItem = Schema.decodeUnknownOption(ToolItem);

/**
 * A plan from a thread's stored turn items, oldest first: its completed `video_*` tool calls with
 * their inputs. Tool results are left behind, so no transcript text travels with a plan.
 * `runStarts` gives each run's request time by run id.
 */
export const planFromTurnItems = (input: {
  readonly threadId: string;
  readonly items: ReadonlyArray<unknown>;
  readonly runStarts: ReadonlyMap<string, string>;
  /** Only this run's calls. Omitted, the whole thread's. */
  readonly runId?: string | undefined;
}): Plan => {
  const items = input.items.flatMap((item) => {
    const decoded = decodeToolItem(item);
    if (decoded._tag === "None") return [];
    const tool = bareToolName(decoded.value.toolName);
    const wanted = input.runId === undefined || decoded.value.runId === input.runId;
    return tool.startsWith("video_") && decoded.value.status === "completed" && wanted
      ? [{ ...decoded.value, tool }]
      : [];
  });
  const firstRun = items[0]?.runId ?? undefined;
  const startedAt = firstRun === undefined ? undefined : input.runStarts.get(firstRun);
  return {
    version: 1,
    source: { thread: input.threadId, ...(firstRun === undefined ? {} : { run: firstRun }) },
    ...(startedAt === undefined ? {} : { startedAt }),
    calls: items.map(({ tool, startedAt: at, input: args }) => ({
      tool,
      ...(at === undefined || at === null ? {} : { at }),
      input: args,
    })),
  };
};
