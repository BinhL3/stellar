import { AuthFilesystemWriteScope, type EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { toastManager } from "~/components/ui/toast";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { useProjectFileQuery } from "../files/projectFilesQueryState";

/**
 * Where a video is in its life, kept as `stage` in the project folder's `project.json` so the
 * person, an agent editing the file, and every client read the same thing.
 */
const VIDEO_PROJECT_FILE = "project.json";

const STAGES = [
  { value: "scripting", label: "Scripting" },
  { value: "footage", label: "Footage in" },
  { value: "rough-cut", label: "Rough cut" },
  { value: "polish", label: "Polish" },
  { value: "posted", label: "Posted" },
] as const;

type Stage = (typeof STAGES)[number]["value"];

const parseProjectFile = (text: string | undefined): Record<string, unknown> => {
  if (text === undefined) return {};
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
};

const stageOf = (file: Record<string, unknown>): Stage | null =>
  STAGES.find((stage) => stage.value === file["stage"])?.value ?? null;

/**
 * Shows and sets a video project's stage. Until someone sets it, a project with a pulled
 * timeline reads as Rough cut and one without as Scripting.
 */
export function VideoStageSelect(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly hasTimeline: boolean;
  /** Ghost sits quietly in a toolbar beside a more important control. */
  readonly variant?: "ghost";
}) {
  const file = useProjectFileQuery(props.environmentId, props.workspaceRoot, VIDEO_PROJECT_FILE);
  const canWrite = useEnvironmentScope(props.environmentId, AuthFilesystemWriteScope);
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const contents = parseProjectFile(file.data?.contents);
  const stage = stageOf(contents) ?? (props.hasTimeline ? "rough-cut" : "scripting");

  const setStage = async (next: Stage) => {
    const result = await writeFile({
      environmentId: props.environmentId,
      input: {
        cwd: props.workspaceRoot,
        relativePath: VIDEO_PROJECT_FILE,
        contents: `${JSON.stringify({ ...contents, stage: next }, null, 2)}\n`,
      },
    });
    if (result._tag === "Success") {
      file.refresh();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not change the stage",
        description: error instanceof Error ? error.message : "Try again in a moment.",
      });
    }
  };

  return (
    <Select
      value={stage}
      disabled={!canWrite}
      onValueChange={(value) => {
        const next = STAGES.find((candidate) => candidate.value === value);
        if (next !== undefined && next.value !== stage) void setStage(next.value);
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Stage"
        {...(props.variant ? { variant: props.variant } : {})}
      >
        <SelectValue>
          {(value: string) =>
            `Stage: ${STAGES.find((candidate) => candidate.value === value)?.label ?? value}`
          }
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        {STAGES.map((candidate) => (
          <SelectItem key={candidate.value} value={candidate.value}>
            {candidate.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
