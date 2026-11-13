import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as Learnings from "../../../learnings/Learnings.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readThread, unavailable } from "../../threadAccess.ts";
import { LearningsToolkit } from "./tools.ts";

const refused = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const handlers = {
  // An agent only ever adds to the waiting list; approving is the user's, over the client RPC.
  house_rule_propose: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const {
        projection: { thread },
      } = yield* readThread();
      const projects = yield* Project.ProjectService;
      const learnings = yield* Learnings.Learnings;
      const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(unavailable));
      if (
        Option.isNone(project) ||
        !(yield* learnings.isEditingProject(project.value.workspaceRoot))
      ) {
        return yield* refused("House rules belong to video and carousel projects only.");
      }
      const waiting = yield* learnings
        .propose({
          text: input.rule,
          contradicts: input.replaces ?? null,
          projectId: thread.projectId,
          threadId: thread.id,
          source: "agent",
        })
        .pipe(Effect.mapError((error) => refused(error.message)));
      return { status: Option.isSome(waiting) ? ("waiting" as const) : ("known" as const) };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof LearningsToolkit.tools>;

export const layer = McpToolAccess.toLayer(LearningsToolkit, handlers);
