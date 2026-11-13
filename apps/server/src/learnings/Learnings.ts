import {
  type HouseRule,
  type HouseRuleRemoveInput,
  type LearningApproveInput,
  type LearningDismissInput,
  HOUSE_RULES_MAX,
  LearningsState,
  type PendingLearning,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { CAROUSEL_FILE } from "@t3tools/timeline/carousel";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import {
  approveLearning,
  EMPTY_LEARNINGS,
  houseRulesInstructions,
  proposeLearning,
} from "./learningRules.ts";

export class LearningsError extends Schema.TaggedError<LearningsError>()("LearningsError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.reason;
  }
}

const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(LearningsState));

/**
 * House rules and the learnings waiting to become one. They are the user's taste, which holds
 * across projects, so they live in one file under T3 home rather than in each project folder.
 */
export class Learnings extends Context.Service<
  Learnings,
  {
    /** The rules and waiting learnings now, then as they change. */
    readonly changes: Stream.Stream<LearningsState>;
    readonly state: Effect.Effect<LearningsState>;
    /** Whether a folder is a video or carousel project, the only kind rules and learnings touch. */
    readonly isEditingProject: (workspaceRoot: string) => Effect.Effect<boolean>;
    /**
     * Puts a rule on the waiting list for the user. `None` when it is already a rule or already
     * waiting. Fails when `contradicts` quotes no rule the project has.
     */
    readonly propose: (input: {
      readonly text: string;
      readonly contradicts: string | null;
      readonly projectId: ProjectId;
      readonly threadId: ThreadId | null;
      readonly source: PendingLearning["source"];
    }) => Effect.Effect<Option.Option<PendingLearning>, LearningsError>;
    /** The only way a rule comes to be: the user approving a waiting learning. */
    readonly approve: (input: LearningApproveInput) => Effect.Effect<HouseRule, LearningsError>;
    readonly dismiss: (input: LearningDismissInput) => Effect.Effect<void, LearningsError>;
    readonly removeRule: (input: HouseRuleRemoveInput) => Effect.Effect<void, LearningsError>;
    /** The approved rules as a turn is told them; empty outside video and carousel projects. */
    readonly instructions: (input: {
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
    }) => Effect.Effect<string>;
  }
>()("t3/learnings/Learnings") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const file = path.join(stateDir, "learnings.json");
  const writing = yield* Semaphore.make(1);

  const saved = yield* fileSystem.readFileString(file).pipe(
    Effect.flatMap(decodeState),
    Effect.catch((cause) =>
      // No file yet is the usual case; an unreadable one is left alone until the next save.
      Effect.logDebug("No saved learnings were read", { cause }).pipe(Effect.as(EMPTY_LEARNINGS)),
    ),
  );
  const ref = yield* SubscriptionRef.make(saved);

  const failed = (reason: string) => (cause: unknown) => new LearningsError({ reason, cause });
  const newId = random.uuidV4().pipe(Effect.mapError(failed("Could not make an id.")));

  /** Saves the next state before anyone sees it, so a rule shown as approved is on disk. */
  const save = (next: LearningsState) =>
    fileSystem
      .writeFileString(`${file}.part`, `${JSON.stringify(next, null, 2)}\n`)
      .pipe(
        Effect.andThen(fileSystem.rename(`${file}.part`, file)),
        Effect.mapError(failed("Could not save the house rules.")),
        Effect.andThen(SubscriptionRef.set(ref, next)),
      );

  const isEditingProject = (workspaceRoot: string) =>
    Effect.all(
      [
        fileSystem.exists(path.join(workspaceRoot, "timelines")),
        fileSystem.exists(path.join(workspaceRoot, CAROUSEL_FILE)),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([video, carousel]) => video || carousel),
      Effect.orElseSucceed(() => false),
    );

  return Learnings.of({
    changes: SubscriptionRef.changes(ref),
    state: SubscriptionRef.get(ref),
    isEditingProject,
    propose: Effect.fn("Learnings.propose")(function* (input) {
      const id = yield* newId;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      return yield* writing.withPermits(1)(
        Effect.gen(function* () {
          const outcome = proposeLearning(yield* SubscriptionRef.get(ref), {
            ...input,
            id,
            createdAt,
          });
          if (outcome.type === "unknown-quote") {
            return yield* new LearningsError({
              reason:
                "That quote is not one of this project's house rules. Quote the rule word for word, or leave it out.",
            });
          }
          if (outcome.type === "empty") {
            return yield* new LearningsError({ reason: "Say the rule in one sentence." });
          }
          if (outcome.type === "known") return Option.none();
          yield* save(outcome.state);
          return Option.some(outcome.learning);
        }),
      );
    }),
    approve: Effect.fn("Learnings.approve")(function* (input) {
      const ruleId = yield* newId;
      const now = DateTime.formatIso(yield* DateTime.now);
      return yield* writing.withPermits(1)(
        Effect.gen(function* () {
          const outcome = approveLearning(yield* SubscriptionRef.get(ref), {
            ...input,
            ruleId,
            now,
          });
          if (outcome.type === "missing") {
            return yield* new LearningsError({ reason: "That learning is no longer waiting." });
          }
          if (outcome.type === "full") {
            return yield* new LearningsError({
              reason: `There are already ${HOUSE_RULES_MAX} house rules. Remove one in Settings first.`,
            });
          }
          yield* save(outcome.state);
          return outcome.rule;
        }),
      );
    }),
    dismiss: Effect.fn("Learnings.dismiss")(function* (input) {
      yield* writing.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* SubscriptionRef.get(ref);
          const pending = state.pending.filter((learning) => learning.id !== input.id);
          if (pending.length !== state.pending.length) yield* save({ ...state, pending });
        }),
      );
    }),
    removeRule: Effect.fn("Learnings.removeRule")(function* (input) {
      yield* writing.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* SubscriptionRef.get(ref);
          const rules = state.rules.filter((rule) => rule.id !== input.id);
          if (rules.length !== state.rules.length) yield* save({ ...state, rules });
        }),
      );
    }),
    instructions: Effect.fn("Learnings.instructions")(function* (input) {
      const text = houseRulesInstructions((yield* SubscriptionRef.get(ref)).rules, input.projectId);
      return text !== "" && (yield* isEditingProject(input.workspaceRoot)) ? text : "";
    }),
  });
});

export const layer = Layer.effect(Learnings, make);
