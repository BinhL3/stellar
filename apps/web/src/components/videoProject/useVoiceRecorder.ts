import { useEffect, useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";

interface Capture {
  readonly recorder: MediaRecorder;
  readonly stream: MediaStream;
  readonly chunks: Array<Blob>;
}

/** The take being recorded: its stream, for a level meter, and the channels it really has. */
export interface VoiceTake {
  readonly stream: MediaStream;
  readonly channels: 1 | 2;
}

export interface VoiceRecorderInput {
  /** An input device id; empty records from the system default. */
  readonly deviceId: string;
  readonly stereo: boolean;
}

const releaseMicrophone = (capture: Capture) => {
  for (const track of capture.stream.getTracks()) track.stop();
};

const OPUS_IN_WEBM = "audio/webm;codecs=opus";

const microphoneError = (error: unknown) => {
  if (error instanceof DOMException && error.name === "OverconstrainedError") {
    return "The chosen microphone isn't connected. Pick another, or the system default.";
  }
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "Try again in a moment.";
};

/**
 * Records this device's microphone, one recording at a time. `start` takes what to do with the
 * recording once `stop` ends it, as the browser made it (WebM or MP4 audio), with the channels it
 * holds, and answers the take, or null when recording didn't begin.
 */
export function useVoiceRecorder(): {
  readonly take: VoiceTake | null;
  readonly start: (
    input: VoiceRecorderInput,
    onRecorded: (recording: Uint8Array, channels: 1 | 2) => void,
  ) => Promise<VoiceTake | null>;
  readonly stop: () => void;
} {
  const captureRef = useRef<Capture | null>(null);
  const [take, setTake] = useState<VoiceTake | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Releases the microphone if the panel closes mid-take.
  useEffect(
    () => () => {
      if (captureRef.current !== null) releaseMicrophone(captureRef.current);
    },
    [],
  );

  const start = async (
    input: VoiceRecorderInput,
    onRecorded: (recording: Uint8Array, channels: 1 | 2) => void,
  ) => {
    if (captureRef.current !== null) return null;
    try {
      // Voice-over wants the raw voice: call processing pumps and gates narration audibly.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: input.stereo ? 2 : 1 },
          ...(input.deviceId === "" ? {} : { deviceId: { exact: input.deviceId } }),
        },
      });
      // A browser that doesn't report the count gave what was asked for, as far as we can tell.
      const reported = stream.getAudioTracks()[0]?.getSettings().channelCount;
      const channels: 1 | 2 = input.stereo && (reported ?? 2) >= 2 ? 2 : 1;
      // Opus in WebM carries stereo; the bitrate leaves a voice room on both channels.
      const recorder = new MediaRecorder(stream, {
        ...(MediaRecorder.isTypeSupported(OPUS_IN_WEBM) ? { mimeType: OPUS_IN_WEBM } : {}),
        audioBitsPerSecond: channels === 2 ? 256_000 : 128_000,
      });
      const capture: Capture = { recorder, stream, chunks: [] };
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) capture.chunks.push(event.data);
      });
      recorder.addEventListener("stop", () => {
        releaseMicrophone(capture);
        captureRef.current = null;
        setTake(null);
        void new Blob(capture.chunks)
          .arrayBuffer()
          .then((buffer) => onRecorded(new Uint8Array(buffer), channels));
      });
      recorder.start();
      captureRef.current = capture;
      const started: VoiceTake = { stream, channels };
      setTake(started);
      return started;
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not use the microphone",
        description: microphoneError(error),
      });
      return null;
    }
  };

  return { take, start, stop: () => captureRef.current?.recorder.stop() };
}
