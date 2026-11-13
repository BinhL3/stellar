import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as LearningCheck from "./LearningCheck.ts";
import * as Learnings from "./Learnings.ts";
import { checkableMessage } from "./learningRules.ts";

const projectId = ProjectId.make("short-1");
const otherProjectId = ProjectId.make("short-2");
const threadId = ThreadId.make("thread-1");

const layerPlatform = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
const layerStore = (baseDir: string) =>
  Learnings.layer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provideMerge(layerPlatform),
  );

/** A folder under a fresh T3 home that looks like a video project, or like a coding one. */
const folders = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-learnings-" });
  const video = path.join(root, "short", "Stellar");
  const code = path.join(root, "app");
  yield* fs.makeDirectory(path.join(video, "timelines"), { recursive: true });
  yield* fs.makeDirectory(code, { recursive: true });
  return { home: path.join(root, "home"), video, code };
});

const propose = (text: string, contradicts: string | null = null, project = projectId) =>
  Learnings.Learnings.use((learnings) =>
    learnings.propose({
      text,
      contradicts,
      projectId: project,
      threadId,
      source: "message",
    }),
  );

it.effect("a learning reaches a turn only once the user approves it, and not after removal", () =>
  Effect.gen(function* () {
    const { home, video, code } = yield* folders;
    yield* Effect.gen(function* () {
      const learnings = yield* Learnings.Learnings;
      const waiting = Option.getOrThrow(
        yield* propose("Always keep the pause before a punchline."),
      );
      assert.strictEqual(
        yield* learnings.instructions({ projectId, workspaceRoot: video }),
        "",
        "a waiting learning is not a rule",
      );

      const rule = yield* learnings.approve({ id: waiting.id, scope: "everywhere" });
      assert.include(
        yield* learnings.instructions({ projectId, workspaceRoot: video }),
        "- Always keep the pause before a punchline.",
      );
      assert.strictEqual(
        yield* learnings.instructions({ projectId, workspaceRoot: code }),
        "",
        "a coding project gets no editing rules",
      );
      assert.deepStrictEqual(
        Option.getOrNull(yield* propose("always keep the pause before a punchline")),
        null,
      );

      yield* learnings.removeRule({ id: rule.id });
      assert.strictEqual(yield* learnings.instructions({ projectId, workspaceRoot: video }), "");
    }).pipe(Effect.provide(layerStore(home)));
  }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
);

it.effect("approved rules and dismissals are still there after a restart", () =>
  Effect.gen(function* () {
    const { home } = yield* folders;
    const ids = yield* Effect.gen(function* () {
      const learnings = yield* Learnings.Learnings;
      const kept = Option.getOrThrow(yield* propose("Never use the zoom preset on b-roll."));
      const scoped = Option.getOrThrow(yield* propose("Captions stay in Vietnamese."));
      const dismissed = Option.getOrThrow(yield* propose("Cut every breath."));
      const waiting = Option.getOrThrow(yield* propose("Open on the hook."));
      yield* learnings.approve({ id: kept.id, scope: "everywhere" });
      yield* learnings.approve({
        id: scoped.id,
        scope: "project",
        text: "Captions stay Vietnamese.",
      });
      yield* learnings.dismiss({ id: dismissed.id });
      return { waiting: waiting.id };
    }).pipe(Effect.provide(layerStore(home)));

    const state = yield* Learnings.Learnings.use((learnings) => learnings.state).pipe(
      Effect.provide(layerStore(home)),
    );
    assert.deepStrictEqual(
      state.rules.map((rule) => [rule.text, rule.projectId]),
      [
        ["Never use the zoom preset on b-roll.", null],
        ["Captions stay Vietnamese.", projectId],
      ],
    );
    assert.deepStrictEqual(
      state.pending.map((learning) => learning.id),
      [ids.waiting],
    );
  }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
);

it.effect(
  "a contradiction must quote a rule the project has, and approving it replaces that rule",
  () =>
    Effect.gen(function* () {
      const { home } = yield* folders;
      yield* Effect.gen(function* () {
        const learnings = yield* Learnings.Learnings;
        const first = Option.getOrThrow(yield* propose("Never use the zoom preset on b-roll."));
        yield* learnings.approve({ id: first.id, scope: "project" });

        const madeUp = yield* Effect.flip(propose("Zoom on b-roll is fine.", "Never zoom at all."));
        assert.include(madeUp.message, "not one of this project's house rules");
        const elsewhere = yield* Effect.exit(
          propose(
            "Zoom on b-roll is fine.",
            "Never use the zoom preset on b-roll.",
            otherProjectId,
          ),
        );
        assert.strictEqual(elsewhere._tag, "Failure", "another project's rule cannot be quoted");

        // A model may drop the full stop or change case; the stored quote is the rule's own text.
        const change = Option.getOrThrow(
          yield* propose("Zoom on b-roll is fine.", '"never use the zoom preset on b-roll"'),
        );
        assert.strictEqual(change.contradicts, "Never use the zoom preset on b-roll.");
        yield* learnings.approve({ id: change.id, scope: "project" });
        assert.deepStrictEqual(
          (yield* learnings.state).rules.map((rule) => rule.text),
          ["Zoom on b-roll is fine."],
        );
      }).pipe(Effect.provide(layerStore(home)));
    }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
);

const dispatch = (
  text: string,
  extra: Partial<Extract<OrchestrationV2Command, { type: "message.dispatch" }>> = {},
) =>
  ({
    type: "message.dispatch",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make("command-1"),
    threadId,
    messageId: MessageId.make("message-1"),
    text,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    ...extra,
  }) satisfies OrchestrationV2Command;

it("only the user's own sentences are checked", () => {
  assert.strictEqual(
    checkableMessage(dispatch("  always keep the pause  ")),
    "always keep the pause",
  );
  assert.isNull(checkableMessage(dispatch("/compact now please")));
  assert.isNull(checkableMessage(dispatch("ok thanks")));
  assert.isNull(
    checkableMessage(dispatch("always keep the pause", { senderThreadId: ThreadId.make("other") })),
  );
  assert.isNull(
    checkableMessage(
      dispatch("Continue from where you stopped", { restartContinuationOfRunId: "run-1" as never }),
    ),
  );
});

const layerCheck = (
  home: string,
  workspaceRoot: string,
  generateLearningCheck: TextGeneration.TextGeneration["Service"]["generateLearningCheck"],
  settings: { readonly learningsEnabled?: boolean } = {},
) =>
  LearningCheck.layer.pipe(
    Layer.provideMerge(layerStore(home)),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(TextGeneration.TextGeneration)({ generateLearningCheck }),
        ServerSettingsService.layerTest(settings),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome({ workspaceRoot } as never),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: () => Effect.succeed({ id: threadId, projectId } as never),
        }),
      ),
    ),
  );

const check = (text: string) =>
  LearningCheck.LearningCheck.use((service) => service.check({ threadId, text }));
const pendingTexts = Learnings.Learnings.use((learnings) => learnings.state).pipe(
  Effect.map((state) => state.pending.map((learning) => [learning.text, learning.contradicts])),
);

it.effect("the side run offers what it finds and drops a quote that is in no rule", () =>
  Effect.gen(function* () {
    const { home, video } = yield* folders;
    const prompts: Array<string> = [];
    yield* Effect.gen(function* () {
      yield* check("from now on always keep the pause before a punchline");
      assert.deepStrictEqual(yield* pendingTexts, [
        ["Always keep the pause before a punchline.", null],
      ]);
      assert.include(prompts[0], "from now on always keep the pause before a punchline");
    }).pipe(
      Effect.provide(
        layerCheck(home, video, (input) => {
          prompts.push(input.prompt);
          return Effect.succeed({
            rule: "Always keep the pause before a punchline.",
            contradicts: "Cut every pause.",
          });
        }),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
);

it.effect("a failing or disabled side run offers nothing and fails nothing", () =>
  Effect.gen(function* () {
    const { home, video, code } = yield* folders;
    let calls = 0;
    const failing: TextGeneration.TextGeneration["Service"]["generateLearningCheck"] = () => {
      calls += 1;
      return Effect.fail(
        new TextGenerationError({ operation: "generateLearningCheck", detail: "No provider." }),
      );
    };
    const dying: typeof failing = () => Effect.die("provider crashed");
    const answering: typeof failing = () => {
      calls += 1;
      return Effect.succeed({ rule: "Always keep the pause.", contradicts: "" });
    };
    const run = (layer: ReturnType<typeof layerCheck>) =>
      Effect.gen(function* () {
        yield* check("always keep the pause before a punchline");
        return yield* pendingTexts;
      }).pipe(Effect.provide(layer));

    assert.deepStrictEqual(yield* run(layerCheck(home, video, failing)), []);
    assert.strictEqual(calls, 1);
    assert.deepStrictEqual(yield* run(layerCheck(home, video, dying)), []);
    assert.deepStrictEqual(
      yield* run(layerCheck(home, video, answering, { learningsEnabled: false })),
      [],
    );
    assert.deepStrictEqual(yield* run(layerCheck(home, code, answering)), []);
    assert.strictEqual(calls, 1, "no model run when switched off or outside an editing project");
  }).pipe(Effect.scoped, Effect.provide(layerPlatform)),
);
