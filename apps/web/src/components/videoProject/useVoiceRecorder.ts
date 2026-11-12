import { useEffect, useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";

interface Capture {
  readonly recorder: MediaRecorder;
  readonly stream: MediaStream;
  readonly chunks: Array<Blob>;
}

const releaseMicrophone = (capture: Capture) => {
  for (const track of capture.stream.getTracks()) track.stop();
};

/**
 * Records this device's microphone, one recording at a time. `start` takes what to do with the
 * recording once `stop` ends it, as the browser made it (WebM or MP4 audio), and answers whether
 * recording began.
 */
export function useVoiceRecorder(): {
  readonly recording: boolean;
  readonly start: (onRecorded: (recording: Uint8Array) => void) => Promise<boolean>;
  readonly stop: () => void;
} {
  const captureRef = useRef<Capture | null>(null);
  const [recording, setRecording] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Releases the microphone if the panel closes mid-take.
  useEffect(
    () => () => {
      if (captureRef.current !== null) releaseMicrophone(captureRef.current);
    },
    [],
  );

  const start = async (onRecorded: (recording: Uint8Array) => void) => {
    if (captureRef.current !== null) return false;
    try {
      // Voice-over wants the raw voice: call processing pumps and gates narration audibly.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const capture: Capture = { recorder: new MediaRecorder(stream), stream, chunks: [] };
      capture.recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) capture.chunks.push(event.data);
      });
      capture.recorder.addEventListener("stop", () => {
        releaseMicrophone(capture);
        captureRef.current = null;
        setRecording(false);
        void new Blob(capture.chunks)
          .arrayBuffer()
          .then((buffer) => onRecorded(new Uint8Array(buffer)));
      });
      capture.recorder.start();
      captureRef.current = capture;
      setRecording(true);
      return true;
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not use the microphone",
        description:
          error instanceof Error && error.message.trim() !== ""
            ? error.message
            : "Try again in a moment.",
      });
      return false;
    }
  };

  return { recording, start, stop: () => captureRef.current?.recorder.stop() };
}
