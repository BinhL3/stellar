import { describe, expect, it } from "vite-plus/test";

import { LEVEL_SAMPLE_RATE, makeLevelMeter, quietCeiling, soundFloor } from "./levels.ts";

/** Signed 16-bit mono: a 440 Hz tone at `amplitude` wherever `loud` says, silence elsewhere. */
const pcm = (seconds: number, amplitude: number, loud: (at: number) => boolean) => {
  const bytes = new Uint8Array(Math.round(seconds * LEVEL_SAMPLE_RATE) * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < bytes.length / 2; i++) {
    const at = i / LEVEL_SAMPLE_RATE;
    const value = loud(at) ? Math.sin(2 * Math.PI * 440 * at) * amplitude * 32767 : 0;
    view.setInt16(i * 2, Math.round(value), true);
  }
  return bytes;
};

describe("makeLevelMeter", () => {
  it("measures each 10 ms window, and reads room tone and speech off the spread", () => {
    const audio = pcm(2, 0.1, (at) => at >= 0.5 && at < 1.5);
    const whole = makeLevelMeter();
    whole.push(audio);
    const levels = whole.finish();
    expect(levels.step).toBe(0.01);
    expect(levels.db).toHaveLength(200);
    // A sine at a tenth of full scale has an RMS of -23 dBFS.
    expect([levels.db[49], levels.db[50], levels.db[149], levels.db[150]]).toEqual([
      -100, -23, -23, -100,
    ]);
    expect([levels.roomTone, levels.speech]).toEqual([-100, -23]);
    expect([soundFloor(levels), quietCeiling(levels)]).toEqual([-35, -94]);
    // A restaurant: the room is 10 dB under the voice, and its noise is not speech.
    const noisy = { ...levels, roomTone: -30, speech: -20 };
    expect([soundFloor(noisy), quietCeiling(noisy)]).toEqual([-24, -27]);

    // A decoder hands audio over in chunks that can split a sample in two.
    const chunked = makeLevelMeter();
    for (let at = 0; at < audio.length; at += 4097) chunked.push(audio.subarray(at, at + 4097));
    expect(chunked.finish()).toEqual(levels);
  });
});
