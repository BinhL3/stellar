import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { MicIcon, SquareIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { useVoiceRecorder } from "./useVoiceRecorder";

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
  const recorder = useVoiceRecorder();
  const [saving, setSaving] = useState(false);

  const finish = async (recording: Uint8Array) => {
    setSaving(true);
    const result = await save({
      environmentId: props.environmentId,
      input: { workspaceRoot: props.workspaceRoot, recording },
    });
    setSaving(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Voice-over saved",
        description: result.value.path,
      });
      props.onSaved(result.value.path);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not save the voice-over",
        description:
          error instanceof Error && error.message.trim() !== ""
            ? error.message
            : "Try again in a moment.",
      });
    }
  };

  return recorder.recording ? (
    <Button size="sm" variant="destructive" onClick={recorder.stop}>
      <SquareIcon />
      Stop recording
    </Button>
  ) : (
    <Button
      size="sm"
      variant="outline"
      disabled={saving}
      onClick={() => void recorder.start((recording) => void finish(recording))}
    >
      <MicIcon />
      {saving ? "Saving…" : "Record voice-over"}
    </Button>
  );
}
