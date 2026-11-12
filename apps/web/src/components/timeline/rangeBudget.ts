/**
 * The connections the preview may use for media at once. A browser opens six to one server over
 * HTTP/1.1, so picture and sound draw their byte-range reads from one pool that stays under it,
 * and each keeps a share the other cannot take: a burst of video ranges never leaves a clip's
 * sound waiting, and audio never fills the pool.
 */

export type RangeKind = "video" | "audio" | "original";

/** Reads in flight for all media, leaving one of the browser's six for everything else. */
const RANGE_PARALLEL = 5;
// `original` is a clip with no rendition playing its file through a media element, which holds
// a connection for as long as the file is loaded. They count against picture's share as well
// as their own: sound's reads are few and must not wait behind one.
const KIND_PARALLEL: Record<RangeKind, number> = { video: 4, audio: 2, original: 2 };

export interface RangeBudget {
  /** Takes a slot when one is free for this kind; the caller must `release` it. */
  readonly take: (kind: RangeKind) => boolean;
  readonly release: (kind: RangeKind) => void;
  /** Calls `listener` once, the next time any slot frees up. */
  readonly whenFree: (listener: () => void) => void;
  readonly inFlight: () => number;
}

export const createRangeBudget = (
  total = RANGE_PARALLEL,
  perKind: Record<RangeKind, number> = KIND_PARALLEL,
): RangeBudget => {
  const active: Record<RangeKind, number> = { video: 0, audio: 0, original: 0 };
  const inFlight = () => active.video + active.audio + active.original;
  let waiting: Array<() => void> = [];
  return {
    take: (kind) => {
      if (inFlight() >= total || active[kind] >= perKind[kind]) return false;
      if (kind !== "audio" && active.video + active.original >= perKind.video) return false;
      active[kind] += 1;
      return true;
    },
    release: (kind) => {
      active[kind] -= 1;
      if (waiting.length === 0) return;
      const told = waiting;
      waiting = [];
      for (const listener of told) listener();
    },
    whenFree: (listener) => {
      if (!waiting.includes(listener)) waiting.push(listener);
    },
    inFlight,
  };
};

/** The one budget every proxy and audio read in the page shares. */
export const rangeBudget = createRangeBudget();

/** A media file's address without its signed token, which changes when the URL is renewed. */
export const assetIdentity = (url: string) =>
  url.replace(/\/api\/assets\/[^/]+\//, "/api/assets/-/");
