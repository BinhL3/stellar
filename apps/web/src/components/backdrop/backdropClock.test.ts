import { expect, it } from "vite-plus/test";

import { BACKDROP_FPS, createBackdropClock } from "./backdropClock";

function setup() {
  let step: (() => void) | null = null;
  let timers = 0;
  let setHeld: ((reason: string, held: boolean) => void) | null = null;
  let watching = 0;
  const clock = createBackdropClock({
    every: (ms, next) => {
      expect(ms).toBe(1000 / BACKDROP_FPS);
      timers += 1;
      step = next;
      return () => {
        timers -= 1;
        step = null;
      };
    },
    watch: (held) => {
      watching += 1;
      setHeld = held;
      return () => {
        watching -= 1;
        setHeld = null;
      };
    },
  });
  return {
    clock,
    /** Fires the timer `count` times, if it is running. */
    fire: (count = 1) => {
      for (let n = 0; n < count; n++) step?.();
    },
    page: (reason: string, held: boolean) => setHeld?.(reason, held),
    running: () => timers === 1,
    watching: () => watching,
  };
}

it("ticks only while someone listens, and every listener sees the same time", () => {
  const { clock, fire, running, watching } = setup();
  expect(running()).toBe(false);
  const main: Array<number> = [];
  const sidebar: Array<number> = [];
  const stopMain = clock.subscribe((time) => main.push(time));
  const stopSidebar = clock.subscribe((time) => sidebar.push(time));
  expect(running()).toBe(true);
  expect(watching()).toBe(1);
  fire(3);
  expect(main).toEqual([0.1, 0.2, 0.3]);
  expect(sidebar).toEqual(main);
  stopMain();
  expect(running()).toBe(true);
  stopSidebar();
  expect(running()).toBe(false);
  expect(watching()).toBe(0);
});

it("stops for every hold and carries on from where it stopped", () => {
  const { clock, fire, page, running } = setup();
  const seen: Array<number> = [];
  clock.subscribe((time) => seen.push(time));
  fire(2);
  page("hidden", true);
  expect(running()).toBe(false);
  const releasePlayback = clock.hold();
  page("hidden", false);
  // Video still playing.
  expect(running()).toBe(false);
  releasePlayback();
  expect(running()).toBe(true);
  fire();
  expect(seen).toEqual([0.1, 0.2, 0.3]);
  expect(clock.time()).toBe(0.3);
});

it("keeps separate holds apart and a release only frees its own", () => {
  const { clock, page, running } = setup();
  clock.subscribe(() => undefined);
  const releaseVideo = clock.hold();
  const releaseTurn = clock.hold();
  page("blurred", true);
  releaseVideo();
  releaseVideo();
  page("blurred", false);
  expect(running()).toBe(false);
  releaseTurn();
  expect(running()).toBe(true);
});

it("forgets the page's holds once nobody listens, and asks the page again", () => {
  const { clock, page, running } = setup();
  const stop = clock.subscribe(() => undefined);
  page("still", true);
  stop();
  clock.subscribe(() => undefined);
  // The fresh watch reports the page as it is now; reduced motion was turned off meanwhile.
  expect(running()).toBe(true);
  page("still", true);
  expect(running()).toBe(false);
});
