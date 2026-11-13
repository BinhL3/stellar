import type { OrchestrationV2Command, ThreadId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Learnings from "./Learnings.ts";
import { buildLearningCheckPrompt, checkableMessage, rulesFor } from "./learningRules.ts";

/**
 * Reads what the user sends in a video or carousel project for a standing editing preference,
 * and puts one it finds on the waiting list. It runs beside the thread's turn, never in it.
 */
export class LearningCheck extends Context.Service<
  LearningCheck,
  {
    /** Starts the check and returns at once. Nothing it does or fails at reaches the caller. */
    readonly notice: (command: OrchestrationV2Command) => Effect.Effect<void>;
    /** The check itself, for a caller that waits on it. */
    readonly check: (input: {
      readonly threadId: ThreadId;
      readonly text: string;
    }) => Effect.Effect<void>;
  }
>()("t3/learnings/LearningCheck") {}

const make = Effect.gen(function* () {
  const learnings = yield* Learnings.Learnings;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const fileSystem = yield* FileSystem.FileSystem;
  const layerScope = yield* Effect.scope;
  // Each check spawns a provider CLI, so a burst of messages is read one at a time.
  const oneAtATime = yield* Semaphore.make(1);

  const run = Effect.fn("LearningCheck.run")(function* (input: {
    readonly threadId: ThreadId;
    readonly text: string;
  }) {
    const settings = yield* serverSettings.getSettings;
    if (!settings.learningsEnabled) return;
    const thread = yield* threads.getThreadShell(input.threadId);
    if (thread === null) return;
    const project = yield* projects.getById(thread.projectId);
    if (Option.isNone(project)) return;
    if (!(yield* learnings.isEditingProject(project.value.workspaceRoot))) return;

    const rules = rulesFor((yield* learnings.state).rules, thread.projectId);
    // Providers run in a working directory; the check must not read the project.
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-learning-check-" });
    const found = yield* textGeneration.generateLearningCheck({
      cwd,
      prompt: buildLearningCheckPrompt(input.text, rules),
      modelSelection: resolveProjectSettings(settings, thread.projectId).settings
        .textGenerationModelSelection,
    });
    if (found.rule.trim() === "") return;
    const proposal = {
      text: found.rule,
      projectId: thread.projectId,
      threadId: input.threadId,
      source: "message" as const,
    };
    yield* learnings.propose({ ...proposal, contradicts: found.contradicts }).pipe(
      // A quote that is in no rule was made up; the preference itself can still be offered.
      Effect.catchTags({
        LearningsError: () =>
          found.contradicts.trim() === ""
            ? Effect.void
            : learnings.propose({ ...proposal, contradicts: null }),
      }),
    );
  });

  const check: LearningCheck["Service"]["check"] = (input) =>
    oneAtATime
      .withPermits(1)(run(input).pipe(Effect.scoped, Effect.timeout("3 minutes")))
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Learning check failed", { threadId: input.threadId, cause }),
        ),
        Effect.asVoid,
      );

  return LearningCheck.of({
    check,
    notice: Effect.fn("LearningCheck.notice")(function* (command) {
      if (command.type !== "message.dispatch") return;
      const text = checkableMessage(command);
      if (text === null) return;
      yield* check({ threadId: command.threadId, text }).pipe(Effect.forkIn(layerScope));
    }),
  });
});

export const layer = Layer.effect(LearningCheck, make);
