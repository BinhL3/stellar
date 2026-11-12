/** Keeping a playing media element on a clock it does not own. */

// Playing elements follow the clock by speeding up or slowing down at most this much; only past
// RESYNC_SECONDS do they seek, because a seek flushes the decoder and stalls that clip.
const MAX_NUDGE = 0.08;
const RESYNC_SECONDS = 0.5;
// Changing an element's rate resets its audio resampler (a click), so rates move in steps.
const RATE_STEP = 0.01;

const setRate = (element: HTMLMediaElement, rate: number) => {
  const stepped = Math.round(rate / RATE_STEP) * RATE_STEP;
  if (Math.abs(element.playbackRate - stepped) >= RATE_STEP / 2) element.playbackRate = stepped;
};

/** Steers a playing element toward `target` seconds without seeking unless it is far off. */
export const follow = (element: HTMLMediaElement, target: number, speed: number) => {
  const drift = element.currentTime - target;
  if (Math.abs(drift) > RESYNC_SECONDS) {
    element.currentTime = target;
    setRate(element, speed);
    return;
  }
  // Inside a frame of drift, play at speed; past it, lean toward the target.
  const nudge = Math.abs(drift) < 0.02 ? 0 : Math.min(MAX_NUDGE, Math.max(-MAX_NUDGE, drift * 2));
  setRate(element, speed * (1 - nudge));
};

export const releaseMedia = (element: HTMLMediaElement) => {
  element.pause();
  element.removeAttribute("src");
  element.load();
};
