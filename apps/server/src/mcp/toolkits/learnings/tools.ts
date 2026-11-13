import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as Learnings from "../../../learnings/Learnings.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ProposeTool = Tool.make("house_rule_propose", {
  description:
    "In a video or carousel project, offer the user a standing editing preference they stated as a house rule, in one sentence. It is not a rule until the user approves it in Stellar. `replaces` quotes, word for word, a house rule it contradicts.",
  parameters: Schema.Struct({ rule: Schema.String, replaces: Schema.optional(Schema.String) }),
  success: Schema.Struct({ status: Schema.Literals(["waiting", "known"]) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProjectService.ProjectService,
    Learnings.Learnings,
  ],
})
  .annotate(Tool.Title, "Propose a house rule")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const LearningsToolkit = Toolkit.make(ProposeTool);
