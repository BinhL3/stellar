import { useEffect, useRef } from "react";

import type { VoiceTake } from "./useVoiceRecorder";

// A dozen updates a second reads as live without repainting every frame.
const METER_INTERVAL_MS = 80;

/** One bar per recorded channel, so a stereo take shows both sides moving. Mounted only while recording. */
export function InputLevelMeter(props: { readonly take: VoiceTake }) {
  const barsRef = useRef<Array<HTMLSpanElement | null>>([]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reads the live microphone stream through Web Audio for the duration of the take.
  useEffect(() => {
    const context = new AudioContext();
    const source = context.createMediaStreamSource(props.take.stream);
    const splitter = context.createChannelSplitter(props.take.channels);
    source.connect(splitter);
    const analysers = Array.from({ length: props.take.channels }, (_, channel) => {
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      splitter.connect(analyser, channel);
      return analyser;
    });
    const samples = new Float32Array(1024);
    const timer = window.setInterval(() => {
      analysers.forEach((analyser, channel) => {
        analyser.getFloatTimeDomainData(samples);
        let peak = 0;
        for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
        const bar = barsRef.current[channel];
        if (bar) bar.style.transform = `scaleY(${Math.min(1, peak)})`;
      });
    }, METER_INTERVAL_MS);
    return () => {
      window.clearInterval(timer);
      void context.close();
    };
  }, [props.take]);

  return (
    <span aria-hidden className="flex h-4 shrink-0 items-stretch gap-px px-0.5">
      {Array.from({ length: props.take.channels }, (_, channel) => (
        <span key={channel} className="flex w-1 items-end overflow-hidden rounded-full bg-muted">
          <span
            ref={(element) => {
              barsRef.current[channel] = element;
            }}
            // Set here, not as a scale class: Tailwind's `scale` property would stack with it.
            style={{ transform: "scaleY(0)" }}
            className="h-full w-full origin-bottom bg-success"
          />
        </span>
      ))}
    </span>
  );
}
