import type { LaidOutClip, TimelineLayout } from "@t3tools/timeline/layout";

/**
 * Transitions the preview plays. A pull keeps each track's transitions as frames on
 * `metadata.premiere.transitions`; here they are tied to the clips either side of the cut, so
 * the engine can play an outgoing clip past its end and an incoming one before its start.
 */

export type TransitionKind =
  | "dissolve"
  | "dip-black"
  | "dip-white"
  | "constant-power"
  | "constant-gain"
  | "exponential";

export interface TransitionSpan {
  readonly name: string;
  /** Null when the preview has no drawing for it: the cut plays as a cut and is reported. */
  readonly kind: TransitionKind | null;
  readonly start: number;
  readonly end: number;
  /** A clip on each side; false for a fade in or out with nothing on the other side. */
  readonly twoSided: boolean;
}

export interface ClipTransitions {
  /** The transition this clip comes in through, and the one it goes out through. */
  readonly in: TransitionSpan | null;
  readonly out: TransitionSpan | null;
}

interface StoredTransition {
  readonly name?: string;
  readonly matchName?: string;
  readonly startFrame?: number;
  readonly endFrame?: number;
  readonly cutFrame?: number;
  readonly outgoing?: boolean;
  readonly incoming?: boolean;
}

/** What a transition is drawn as, from Premiere's names for the built-in ones. */
export const transitionKind = (
  trackKind: "Video" | "Audio",
  transition: { readonly name?: string; readonly matchName?: string },
): TransitionKind | null => {
  const name = `${transition.name ?? ""} ${transition.matchName ?? ""}`.toLowerCase();
  if (trackKind === "Audio") {
    if (name.includes("constant power")) return "constant-power";
    if (name.includes("constant gain")) return "constant-gain";
    if (name.includes("exponential fade")) return "exponential";
    return null;
  }
  if (name.includes("dip to black")) return "dip-black";
  if (name.includes("dip to white")) return "dip-white";
  // Film Dissolve differs from Cross Dissolve only in blending in linear light.
  if (name.includes("cross dissolve") || name.includes("film dissolve")) return "dissolve";
  return null;
};

const NEAR = 0.5;

/** Each clip's transitions, by clip key. Transitions whose clips have moved away are dropped. */
export const planTransitions = (layout: TimelineLayout): ReadonlyMap<string, ClipTransitions> => {
  const plan = new Map<string, { in: TransitionSpan | null; out: TransitionSpan | null }>();
  const entry = (item: LaidOutClip) => {
    let found = plan.get(item.key);
    if (found === undefined) {
      found = { in: null, out: null };
      plan.set(item.key, found);
    }
    return found;
  };
  for (const track of layout.tracks) {
    const stored = (track.metadata?.["premiere"] as { transitions?: unknown } | undefined)
      ?.transitions;
    if (!Array.isArray(stored)) continue;
    for (const transition of stored as ReadonlyArray<StoredTransition>) {
      const { startFrame: start, endFrame: end } = transition;
      if (start === undefined || end === undefined || end <= start) continue;
      const cut = transition.cutFrame;
      const within = (frame: number) => frame >= start - NEAR && frame <= end + NEAR;
      const atCut = (frame: number) => cut === undefined || Math.abs(frame - cut) <= NEAR;
      const outgoing =
        transition.outgoing === false
          ? undefined
          : track.clips.find(
              (item) =>
                item.startFrame < start + NEAR && within(item.endFrame) && atCut(item.endFrame),
            );
      const incoming =
        transition.incoming === false
          ? undefined
          : track.clips.find(
              (item) =>
                item.endFrame > end - NEAR && within(item.startFrame) && atCut(item.startFrame),
            );
      if (outgoing === undefined && incoming === undefined) continue;
      const span: TransitionSpan = {
        name: transition.name ?? "Transition",
        kind: transitionKind(track.kind, transition),
        start,
        end,
        twoSided: outgoing !== undefined && incoming !== undefined,
      };
      if (outgoing !== undefined) entry(outgoing).out = span;
      if (incoming !== undefined) entry(incoming).in = span;
    }
  }
  return plan;
};

export interface TransitionMix {
  /** Multiplies the layer's opacity. */
  opacity: number;
  /** How much of the dip colour covers the layer, 0 to 1. */
  dip: number;
  dipWhite: boolean;
  /** Multiplies the clip's audio level. */
  gain: number;
  /** False while the other clip of a dip has the screen. */
  visible: boolean;
}

export const emptyMix = (): TransitionMix => ({
  opacity: 1,
  dip: 0,
  dipWhite: false,
  gain: 1,
  visible: true,
});

const apply = (span: TransitionSpan, incoming: boolean, frame: number, mix: TransitionMix) => {
  if (span.kind === null || frame < span.start || frame >= span.end) return;
  const progress = (frame - span.start) / (span.end - span.start);
  // How far this clip is toward fully there: rising for the incoming clip, falling for the other.
  const presence = incoming ? progress : 1 - progress;
  switch (span.kind) {
    case "dissolve":
      // Over an outgoing clip at full strength, the incoming one at `progress` is the exact mix.
      mix.opacity *= span.twoSided && !incoming ? 1 : presence;
      return;
    case "dip-black":
    case "dip-white":
      mix.dipWhite = span.kind === "dip-white";
      if (!span.twoSided) {
        mix.dip = 1 - presence;
        return;
      }
      // Each clip has half the transition: out to the colour, then in from it.
      if (presence < 0.5) mix.visible = false;
      else mix.dip = 2 * (1 - presence);
      return;
    case "constant-power":
      mix.gain *= Math.sin((presence * Math.PI) / 2);
      return;
    case "constant-gain":
      mix.gain *= presence;
      return;
    case "exponential":
      mix.gain *= presence * presence;
      return;
  }
};

/** What a clip's transitions do to it at `frame`. Pass `into` to reuse an object per frame. */
export const mixAt = (
  transitions: ClipTransitions | undefined,
  frame: number,
  into: TransitionMix = emptyMix(),
): TransitionMix => {
  into.opacity = 1;
  into.dip = 0;
  into.dipWhite = false;
  into.gain = 1;
  into.visible = true;
  if (transitions === undefined) return into;
  if (transitions.in !== null) apply(transitions.in, true, frame, into);
  if (transitions.out !== null) apply(transitions.out, false, frame, into);
  return into;
};

/** The first frame a clip is on screen or heard, earlier than its start under a transition. */
export const windowStart = (item: LaidOutClip, transitions: ClipTransitions | undefined) => {
  const span = transitions?.in;
  return span && span.kind !== null ? Math.min(item.startFrame, span.start) : item.startFrame;
};

export const windowEnd = (item: LaidOutClip, transitions: ClipTransitions | undefined) => {
  const span = transitions?.out;
  return span && span.kind !== null ? Math.max(item.endFrame, span.end) : item.endFrame;
};
