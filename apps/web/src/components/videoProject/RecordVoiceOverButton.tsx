import { useProvideTimelineCommand } from "~/components/timeline/timelineCommands";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { MicIcon, SquareIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
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
  /** A toolbar's icon, with how to use it in its tooltip, instead of the worded button. */
  readonly iconOnly?: boolean;
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

  useProvideTimelineCommand(
    "recordVoiceOver",
    saving
      ? null
      : recorder.recording
        ? recorder.stop
        : () => void recorder.start((recording) => void finish(recording)),
  );

  if (props.iconOnly) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            recorder.recording ? (
              <Button
                size="icon-sm"
                variant="destructive"
                aria-label="Stop recording"
                onClick={recorder.stop}
              />
            ) : (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Record voice-over"
                disabled={saving}
                onClick={() => void recorder.start((recording) => void finish(recording))}
              />
            )
          }
        >
          {recorder.recording ? <SquareIcon /> : saving ? <Spinner size="xs" /> : <MicIcon />}
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          {recorder.recording
            ? "Stop recording"
            : "Record voice-over. Press play first to narrate to picture; takes are saved in Audio/VO."}
        </TooltipPopup>
      </Tooltip>
    );
  }
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
