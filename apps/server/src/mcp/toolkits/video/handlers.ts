import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { beatsText } from "@t3tools/timeline/script";
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
} satisfies McpToolAccess.Handlers<typeof VideoToolkit.tools>;

export const layer = McpToolAccess.toLayer(VideoToolkit, handlers);
