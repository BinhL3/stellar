/**
 * Replays a stored plan (an agent's edit tool calls, with their arguments) through this checkout's
 * timeline code, with no model call. The same plan replayed before and after a tool change shows
 * what the change does to the cut.
 */
import { VideoTimelineEdit } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { applyEdits, type TimelineEdit } from "../../packages/timeline/src/edits.ts";
import { layoutTimeline } from "../../packages/timeline/src/layout.ts";
import type { Timeline } from "../../packages/timeline/src/otio.ts";
import { timelineWords, wordRange } from "../../packages/timeline/src/words.ts";
import type { Transcripts } from "./score.ts";

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
});
// Undeclared keys are dropped, as the MCP server drops them, so a plan captured after a tool gained
// an optional argument still replays on a checkout without it.
const decodeEditInput = Schema.decodeUnknownOption(EditInput);

/** Tools that change a timeline in ways a plan alone can't reproduce. */
const UNREPLAYED = new Set(["video_voice_over", "video_footage", "video_premiere_pull"]);

export interface ReplayedCall {
  readonly index: number;
  readonly tool: string;
  readonly status: "applied" | "refused" | "skipped";
  /** Why a call was refused or skipped, or what an applied call left out. */
  readonly note?: string;
}

type FrameRange = { readonly start: number; readonly end: number };

/**
 * One call's typed edits, or why the call is refused. This mirrors `VideoProjects.editTimeline`,
 * which holds the same steps inside the server: word numbers are read once, before the call, and
 * one bad edit refuses the whole call.
 */
const resolveEdits = (
  timeline: Timeline,
  transcripts: Transcripts,
  edits: ReadonlyArray<VideoTimelineEdit>,
): { readonly edits: Array<TimelineEdit>; readonly left: Array<string> } | string => {
  const layout = layoutTimeline(timeline);
  const clipIds = new Set(layout.tracks.flatMap((track) => track.clips.map((clip) => clip.key)));
  const trackNames = new Set(layout.tracks.map((track) => track.name));
  const words = timelineWords(timeline, transcripts);
  const rippled: Array<FrameRange> = [];
  const afterCuts = (frame: number) =>
    frame -
    rippled.reduce((sum, cut) => sum + Math.max(0, Math.min(frame, cut.end) - cut.start), 0);
  const resolved: Array<TimelineEdit> = [];
  const left: Array<string> = [];
  for (const [index, edit] of edits.entries()) {
    const refuse = (problem: string) => `Edit ${index + 1} (${edit.kind}): ${problem}`;
    const { clipId } = edit;
    // A split names its later piece `<clipId>~<frame>` before that piece exists.
    const knownClip = clipId !== undefined && (clipIds.has(clipId) || clipId.includes("~"));
    switch (edit.kind) {
      case "removeWords": {
        if (edit.fromWord === undefined || edit.toWord === undefined) {
          return refuse("needs fromWord, toWord");
        }
        const range = wordRange(words, edit.fromWord, edit.toWord);
        if (typeof range === "string") return refuse(range);
        const ripple = edit.ripple ?? false;
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
  }
  return { edits: resolved, left };
};

/** `mcp__t3-code__video_timeline_edit` and Codex's `t3-code.video_timeline_edit`, as one name. */
export const bareToolName = (name: string) => name.replace(/^(mcp__)?t3[-_]code(__|\.)/, "");

export const replayPlan = (input: {
  readonly start: Timeline;
  readonly transcripts: Transcripts;
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
    const resolved = resolveEdits(timeline, input.transcripts, decoded.value.edits);
    if (typeof resolved === "string") {
      calls.push({ index, tool, status: "refused", note: resolved });
      continue;
    }
    timeline = applyEdits(timeline, resolved.edits);
    calls.push({
      index,
      tool,
      status: "applied",
      ...(resolved.left.length === 0 ? {} : { note: `left out: ${resolved.left.join(", ")}` }),
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
