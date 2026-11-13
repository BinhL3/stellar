import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Every turn in a video or carousel project carries the rules, so each one stays a sentence. */
export const HOUSE_RULE_MAX_LENGTH = 240;
export const HOUSE_RULES_MAX = 30;

const RuleText = TrimmedNonEmptyString.check(Schema.isMaxLength(HOUSE_RULE_MAX_LENGTH));

/** A standing editing preference the user approved. Agents in video and carousel projects get it. */
export const HouseRule = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: RuleText,
  /** Null applies in every project; otherwise only in this one. */
  projectId: Schema.NullOr(ProjectId),
  createdAt: IsoDateTime,
});
export type HouseRule = typeof HouseRule.Type;

/** A rule Stellar or an agent noticed, waiting for the user. It reaches no agent until approved. */
export const PendingLearning = Schema.Struct({
  id: TrimmedNonEmptyString,
  text: RuleText,
  /** The text of the house rule this one would replace, word for word. */
  contradicts: Schema.NullOr(Schema.String),
  projectId: ProjectId,
  threadId: Schema.NullOr(ThreadId),
  source: Schema.Literals(["message", "agent"]),
  createdAt: IsoDateTime,
});
export type PendingLearning = typeof PendingLearning.Type;

export const LearningsState = Schema.Struct({
  rules: Schema.Array(HouseRule),
  pending: Schema.Array(PendingLearning),
});
export type LearningsState = typeof LearningsState.Type;

export const LearningApproveInput = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** The user's wording, when they edited it. */
  text: Schema.optional(RuleText),
  /** `project` keeps the rule to the project it was noticed in. */
  scope: Schema.Literals(["everywhere", "project"]),
});
export type LearningApproveInput = typeof LearningApproveInput.Type;

export const LearningDismissInput = Schema.Struct({ id: TrimmedNonEmptyString });
export type LearningDismissInput = typeof LearningDismissInput.Type;

export const HouseRuleRemoveInput = Schema.Struct({ id: TrimmedNonEmptyString });
export type HouseRuleRemoveInput = typeof HouseRuleRemoveInput.Type;
