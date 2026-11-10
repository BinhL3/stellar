import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { MicIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

interface Take {
  readonly recorder: MediaRecorder;
  readonly stream: MediaStream;
  readonly chunks: Array<Blob>;
}

const releaseMicrophone = (take: Take) => {
  for (const track of take.stream.getTracks()) track.stop();
};

/**
 * Records a voice-over take from this device's microphone and saves it into the project as a
 * WAV. Play the timeline while recording to narrate to picture; the take is not placed for you.
 */
export function RecordVoiceOverButton(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  /** Called with the saved file's path, relative to the project's media root. */
  readonly onSaved: (path: string) => void;
}) {
  const save = useAtomCommand(projectEnvironment.saveVideoVoiceOver, { reportFailure: false });
  const takeRef = useRef<Take | null>(null);
  const [state, setState] = useState<"idle" | "recording" | "saving">("idle");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Releases the microphone if the panel closes mid-take.
  useEffect(
    () => () => {
      if (takeRef.current !== null) releaseMicrophone(takeRef.current);
    },
    [],
  );

  const fail = (title: string, error: unknown) =>
    toastManager.add({
      type: "error",
      title,
      description:
        error instanceof Error && error.message.trim() !== ""
          ? error.message
          : "Try again in a moment.",
    });

  const start = async () => {
    try {
      // Voice-over wants the raw voice: call processing pumps and gates narration audibly.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const take: Take = { recorder: new MediaRecorder(stream), stream, chunks: [] };
      take.recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) take.chunks.push(event.data);
      });
      take.recorder.addEventListener("stop", () => void finish(take));
      take.recorder.start();
      takeRef.current = take;
      setState("recording");
    } catch (error) {
      fail("Could not use the microphone", error);
    }
  };

  const finish = async (take: Take) => {
    releaseMicrophone(take);
    takeRef.current = null;
    setState("saving");
    const recording = new Uint8Array(await new Blob(take.chunks).arrayBuffer());
    const result = await save({
      environmentId: props.environmentId,
      input: { workspaceRoot: props.workspaceRoot, recording },
    });
    setState("idle");
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Voice-over saved",
        description: result.value.path,
      });
      props.onSaved(result.value.path);
    } else if (!isAtomCommandInterrupted(result)) {
      fail("Could not save the voice-over", squashAtomCommandFailure(result));
    }
  };

  return state === "recording" ? (
    <Button size="sm" variant="destructive" onClick={() => takeRef.current?.recorder.stop()}>
      <SquareIcon />
      Stop recording
    </Button>
  ) : (
    <Button size="sm" variant="outline" disabled={state === "saving"} onClick={() => void start()}>
      <MicIcon />
      {state === "saving" ? "Saving…" : "Record voice-over"}
    </Button>
  );
}
