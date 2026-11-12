import {
  OrchestratorMcpFailure,
  type VideoPosted,
  type VideoVoiceOverView,
} from "@t3tools/contracts";
import { preflightLine } from "@t3tools/timeline/preflight";
import { beatsText } from "@t3tools/timeline/script";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Project from "../../../project/ProjectService.ts";
import * as VideoProjects from "../../../videoProject/VideoProjects.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readThread, unavailable } from "../../threadAccess.ts";
import { VideoToolkit } from "./tools.ts";

const refused = (error: VideoProjects.VideoProjectError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

/** The folder of the project the calling thread belongs to. */
const callerWorkspaceRoot = Effect.gen(function* () {
  const {
    projection: { thread },
  } = yield* readThread();
  const projects = yield* Project.ProjectService;
  const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(unavailable));
  if (Option.isNone(project)) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "The project was not found.",
    });
  }
  return project.value.workspaceRoot;
});

/** The takes as an agent reads them: a line per beat, then what belongs to no line. */
const voiceOverText = (view: VideoVoiceOverView) =>
  [
    ...view.beats.map((beat) => {
      const take = beat.takes.find((other) => other.id === beat.chosen);
      if (take === undefined) return `${beat.id} no voice-over: ${beat.text}`;
      const where =
        beat.placed === null
          ? "chosen, not on the timeline"
          : beat.placed.takeId === take.id
            ? `on ${beat.placed.track} frames ${beat.placed.startFrame}-${beat.placed.endFrame}`
            : `chosen, but ${beat.placed.takeId} is on ${beat.placed.track} frames ${beat.placed.startFrame}-${beat.placed.endFrame}`;
      return `${beat.id} take ${take.id} ${take.seconds.toFixed(1)}s ${where} (takes ${beat.takes.map((other) => other.id).join(" ")}): ${beat.text}`;
    }),
    ...(view.loose.length === 0
      ? []
      : [`Recordings that belong to no line (split can cut one up): ${view.loose.join(", ")}`]),
    ...view.orphaned.map(
      (orphan) => `${orphan.takes} takes are for ${orphan.beatId}, which the script no longer has.`,
    ),
  ].join("\n");

/** The posted record as an agent reads it: the day it went up, when one is on record. */
const postedView = (posted: VideoPosted | null) =>
  posted === null
    ? null
    : {
        on: posted.at > 0 ? DateTime.formatIsoDateUtc(DateTime.makeUnsafe(posted.at)) : null,
        urls: posted.urls,
      };

const handlers = {
  video_timeline_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* callerWorkspaceRoot;
      const videoProjects = yield* VideoProjects.VideoProjects;
      return yield* videoProjects
        .readTimeline({
          workspaceRoot,
          ...(input.timeline === undefined ? {} : { timeline: input.timeline }),
        })
        .pipe(Effect.mapError(refused));
    }),
  ),
  video_timeline_edit: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* callerWorkspaceRoot;
      const videoProjects = yield* VideoProjects.VideoProjects;
      return yield* videoProjects
        .editTimeline({ workspaceRoot, timeline: input.timeline, edits: input.edits })
        .pipe(Effect.mapError(refused));
    }),
  ),
  video_timeline_words: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* callerWorkspaceRoot;
      const videoProjects = yield* VideoProjects.VideoProjects;
      return yield* videoProjects
        .readWords({
          workspaceRoot,
          ...(input.timeline === undefined ? {} : { timeline: input.timeline }),
        })
        .pipe(Effect.mapError(refused));
    }),
  ),
  video_transcribe: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* callerWorkspaceRoot;
      const videoProjects = yield* VideoProjects.VideoProjects;
      return yield* videoProjects
        .transcribe({
          workspaceRoot,
          ...(input.files === undefined ? {} : { files: input.files }),
          ...(input.language === undefined ? {} : { language: input.language }),
        })
        .pipe(Effect.mapError(refused));
    }),
  ),
  video_script: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* callerWorkspaceRoot;
      const videoProjects = yield* VideoProjects.VideoProjects;
      const { text, docUrl, timeline } = input;
      const view = yield* (
        text === undefined && docUrl === undefined
          ? videoProjects.readScript({
              workspaceRoot,
              ...(timeline === undefined ? {} : { timeline }),
            })
          : videoProjects.saveScript({
              workspaceRoot,
              ...(text === undefined ? {} : { text }),
              ...(docUrl === undefined ? {} : { docUrl }),
            })
      ).pipe(Effect.mapError(refused));
      return {
        docUrl: view.docUrl,
        timeline: view.timeline,
        beats: view.beats.length,
        text: beatsText(view.beats),
      };
    }),
  ),
  video_voice_over: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* callerWorkspaceRoot;
      const videoProjects = yield* VideoProjects.VideoProjects;
      const { beatId, takeId, path, timeline } = input;
      const action = input.action ?? "read";
      const on = timeline === undefined ? {} : { timeline };
      const needs = (...missing: ReadonlyArray<string>) =>
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `\`${action}\` needs ${missing.join(" and ")}.`,
        });
      const view = yield* Effect.gen(function* () {
        switch (action) {
          case "read":
            return yield* videoProjects.readVoiceOver({ workspaceRoot, ...on });
          case "choose":
            if (beatId === undefined || takeId === undefined) {
              return yield* needs("beatId", "takeId");
            }
            return yield* videoProjects.chooseTake({ workspaceRoot, beatId, takeId, ...on });
          case "import":
            if (beatId === undefined || path === undefined) return yield* needs("beatId", "path");
            return yield* videoProjects.saveTake({ workspaceRoot, beatId, path, ...on });
          case "split":
            if (path === undefined) return yield* needs("path");
            return yield* videoProjects.splitTake({ workspaceRoot, path, ...on });
          case "apply":
            if (timeline === undefined) return yield* needs("timeline");
            return yield* videoProjects.applyVoiceOver({
              workspaceRoot,
              timeline,
              ...(input.beatIds === undefined ? {} : { beatIds: input.beatIds }),
            });
        }
      }).pipe(Effect.catchTags({ VideoProjectError: (error) => Effect.fail(refused(error)) }));
      return { timeline: view.timeline, text: voiceOverText(view), changes: view.changes };
    }),
  ),
  video_premiere_export: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* callerWorkspaceRoot;
      const videoProjects = yield* VideoProjects.VideoProjects;
      return yield* videoProjects
        .exportForPremiere({
          workspaceRoot,
          ...(input.timeline === undefined ? {} : { timeline: input.timeline }),
        })
        .pipe(Effect.mapError(refused));
    }),
  ),
  video_premiere_push: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* callerWorkspaceRoot;
      const videoProjects = yield* VideoProjects.VideoProjects;
      return yield* videoProjects
        .pushPlan({
          workspaceRoot,
          ...(input.timeline === undefined ? {} : { timeline: input.timeline }),
        })
        .pipe(Effect.mapError(refused));
    }),
  ),
  video_project_start: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const videoProjects = yield* VideoProjects.VideoProjects;
      return yield* videoProjects.createFromIdea(input).pipe(Effect.mapError(refused));
    }),
  ),
  video_premiere_pull: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const videoProjects = yield* VideoProjects.VideoProjects;
      const { premiereProjectPath } = input;
      const inspected = yield* videoProjects
        .inspectPremiere({ premiereProjectPath })
        .pipe(Effect.mapError(refused));
      if (input.sequence === undefined) return { sequences: inspected.sequences, pulled: null };
      const sequence = inspected.sequences.find(
        (candidate) => candidate.id === input.sequence || candidate.name === input.sequence,
      );
      if (sequence === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `No sequence "${input.sequence}". This project has: ${inspected.sequences.map((s) => s.name).join(", ")}.`,
        });
      }
      const created = yield* videoProjects
        .createFromPremiere({ premiereProjectPath, sequenceId: sequence.id })
        .pipe(Effect.mapError(refused));
      return {
        sequences: inspected.sequences,
        pulled: { workspaceRoot: created.workspaceRoot, timeline: created.timelinePath },
      };
    }),
  ),
  video_footage: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* callerWorkspaceRoot;
      const videoProjects = yield* VideoProjects.VideoProjects;
      if (input.action === "scan") {
        const scan = yield* videoProjects
          .scanIntake({ workspaceRoot })
          .pipe(Effect.mapError(refused));
        return { scan, importing: null };
      }
      if (input.action === "conform") {
        const conforming = yield* videoProjects
          .conformFootage({ workspaceRoot })
          .pipe(Effect.mapError(refused));
        return { scan: null, importing: null, conforming };
      }
      const { paths, folder } = input;
      if (paths === undefined || paths.length === 0 || folder === undefined) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Importing needs `paths` from a scan and a `folder` name.",
        });
      }
      yield* videoProjects
        .importFootage({ workspaceRoot, paths, folder })
        .pipe(Effect.mapError(refused));
      return { scan: null, importing: { files: paths.length, folder } };
    }),
  ),
  video_render_check: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* callerWorkspaceRoot;
      const videoProjects = yield* VideoProjects.VideoProjects;
      const report = yield* videoProjects
        .checkRender({
          workspaceRoot,
          ...(input.timeline === undefined ? {} : { timeline: input.timeline }),
          ...(input.exportPath === undefined ? {} : { exportPath: input.exportPath }),
        })
        .pipe(Effect.mapError(refused));
      return {
        level: report.level,
        timeline: report.timeline,
        exportPath: report.exportPath,
        report: [
          ...report.items.map((item) => `${item.level} ${item.title}: ${item.detail}`),
          // Without drawn labels, the tiles are named here in the order they appear.
          ...(report.contactSheet !== null && !report.contactSheetLabelled
            ? [
                `Contact sheet tiles, left to right then down: ${report.contactSheetTiles.map((tile) => `frame ${tile.frame}${tile.kind === "even" ? "" : ` (${tile.kind})`}`).join(", ")}`,
              ]
            : []),
        ].join("\n"),
        contactSheet: report.contactSheet,
      };
    }),
  ),
  video_preflight: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const workspaceRoot = yield* callerWorkspaceRoot;
      const videoProjects = yield* VideoProjects.VideoProjects;
      const preflight = yield* videoProjects
        .preflight({ workspaceRoot })
        .pipe(Effect.mapError(refused));
      return {
        steps: preflight.steps.map(preflightLine).join("\n"),
        contactSheet: preflight.render?.contactSheet ?? null,
        posted: postedView(preflight.posted),
      };
    }),
  ),
  video_posted: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const workspaceRoot = yield* callerWorkspaceRoot;
      const videoProjects = yield* VideoProjects.VideoProjects;
      const day =
        input.postedOn === undefined ? undefined : Option.getOrNull(DateTime.make(input.postedOn));
      const at = day === undefined || day === null ? undefined : DateTime.toEpochMillis(day);
      if (day === null) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "`postedOn` is a date as YYYY-MM-DD.",
        });
      }
      const preflight = yield* videoProjects
        .setPosted({
          workspaceRoot,
          posted: input.posted,
          ...(input.urls === undefined ? {} : { urls: input.urls }),
          ...(at === undefined ? {} : { at }),
        })
        .pipe(Effect.mapError(refused));
      return {
        posted: postedView(preflight.posted),
        next: input.posted
          ? "Recorded in Stellar. Now set this video's row in the user's video catalog (their Google Sheet) to Posted with the post link, through their Google connector, and read the row back to confirm. Stellar does not write to Google; without a connector, ask the user to update the catalog."
          : "The posted record is removed. If the video catalog row says Posted, set it back through the user's Google connector.",
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof VideoToolkit.tools>;

export const layer = McpToolAccess.toLayer(VideoToolkit, handlers);
