/**
 * The one clock every animated backdrop reads, so the sidebar's slice moves with its pane. It ticks
 * on a slow timer, never at the display's rate, and stops while anything holds it: a hidden or
 * unfocused window, reduced motion, video playing, an agent streaming. Scene time only advances
 * while it runs, so a resume carries on rather than jumps.
 */

export const BACKDROP_FPS = 10;

type Hold = string | symbol;

export interface BackdropClock {
  /** Scene seconds; only advances while the clock runs. */
  readonly time: () => number;
  /** Called with the new scene time on every tick. */
  readonly subscribe: (listener: (time: number) => void) => () => void;
  /** Stops the clock until the returned release is called. */
  readonly hold: () => () => void;
}

export interface BackdropClockDeps {
  /** Starts a repeating timer; returns the way to stop it. */
  readonly every: (ms: number, step: () => void) => () => void;
  /** Holds the clock for the page's own reasons while anything listens; returns the cleanup. */
  readonly watch: (setHeld: (reason: string, held: boolean) => void) => () => void;
}

export function createBackdropClock(deps: BackdropClockDeps): BackdropClock {
  const listeners = new Set<(time: number) => void>();
  const holds = new Set<Hold>();
  let ticks = 0;
  let stopTimer: (() => void) | null = null;
  let stopWatching: (() => void) | null = null;

  const step = () => {
    ticks += 1;
    const time = ticks / BACKDROP_FPS;
    for (const listener of listeners) listener(time);
  };
  const sync = () => {
    const run = listeners.size > 0 && holds.size === 0;
    if (run && stopTimer === null) stopTimer = deps.every(1000 / BACKDROP_FPS, step);
    if (!run && stopTimer !== null) {
      stopTimer();
      stopTimer = null;
    }
  };
  const setHeld = (reason: Hold, held: boolean) => {
    if (held) holds.add(reason);
    else holds.delete(reason);
    sync();
  };

  return {
    time: () => ticks / BACKDROP_FPS,
    subscribe: (listener) => {
      listeners.add(listener);
      if (stopWatching === null) stopWatching = deps.watch(setHeld);
      sync();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && stopWatching !== null) {
          stopWatching();
          stopWatching = null;
          for (const hold of holds) if (typeof hold === "string") holds.delete(hold);
        }
        sync();
      };
    },
    hold: () => {
      const token = Symbol("backdrop hold");
      setHeld(token, true);
      return () => setHeld(token, false);
    },
  };
}

function watchPage(setHeld: (reason: string, held: boolean) => void): () => void {
  const stillness = window.matchMedia("(prefers-reduced-motion: reduce)");
  const onVisibility = () => setHeld("hidden", document.visibilityState === "hidden");
  const onFocus = () => setHeld("blurred", false);
  const onBlur = () => setHeld("blurred", true);
  const onStillness = () => setHeld("still", stillness.matches);
  onVisibility();
  setHeld("blurred", !document.hasFocus());
  onStillness();
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  stillness.addEventListener("change", onStillness);
  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
    stillness.removeEventListener("change", onStillness);
  };
}

let pageClock: BackdropClock | null = null;

export function backdropClock(): BackdropClock {
  return (pageClock ??= createBackdropClock({
    every: (ms, step) => {
      const id = window.setInterval(step, ms);
      return () => window.clearInterval(id);
    },
    watch: watchPage,
  }));
}
