import { AuthFilesystemWriteScope, type EnvironmentId } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
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

export type VideoStageState = ReturnType<typeof useVideoStage>;

/**
 * A video project's stage and how to set it. Until someone sets it, a project with a pulled
 * timeline reads as Rough cut and one without as Scripting.
 */
export function useVideoStage(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly hasTimeline: boolean;
}) {
  const file = useProjectFileQuery(props.environmentId, props.workspaceRoot, VIDEO_PROJECT_FILE);
  const canWrite = useEnvironmentScope(props.environmentId, AuthFilesystemWriteScope);
  const writeFile = useAtomCommand(projectEnvironment.writeFile, { reportFailure: false });
  const contents = parseProjectFile(file.data?.contents);
  const stage = stageOf(contents) ?? (props.hasTimeline ? "rough-cut" : "scripting");

  const setStage = async (next: Stage) => {
    if (next === stage) return;
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

  return {
    stage,
    label: STAGES.find((candidate) => candidate.value === stage)?.label ?? stage,
    canWrite,
    setStage,
  };
}

/** The stages left to right, the current one marked; picking one moves the project there. */
export function VideoStageStepper(props: { readonly state: VideoStageState }) {
  const { stage, canWrite, setStage } = props.state;
  const current = STAGES.findIndex((candidate) => candidate.value === stage);
  return (
    <ol aria-label="Stage" className="flex">
      {STAGES.map((candidate, index) => {
        const isCurrent = index === current;
        return (
          <li key={candidate.value} className="relative flex min-w-0 flex-1 flex-col items-center">
            {index > 0 ? (
              <span
                aria-hidden
                className={cn(
                  "absolute top-2.5 right-1/2 left-[-50%] h-px",
                  index <= current ? "bg-foreground/50" : "bg-border",
                )}
              />
            ) : null}
            <button
              type="button"
              aria-current={isCurrent ? "step" : undefined}
              disabled={!canWrite}
              onClick={() => void setStage(candidate.value)}
              className="group/stage relative flex w-full cursor-pointer flex-col items-center gap-1 rounded-sm px-0.5 pt-1 pb-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default"
            >
              <span aria-hidden className="flex h-3 items-center justify-center">
                <span
                  className={cn(
                    "rounded-full ring-4 ring-popover",
                    isCurrent
                      ? "size-3 bg-primary"
                      : index < current
                        ? "bg-foreground/50"
                        : "bg-border group-hover/stage:bg-muted-foreground group-disabled/stage:bg-border",
                    isCurrent ? null : "size-2",
                  )}
                />
              </span>
              <span
                className={cn(
                  "text-center text-2xs leading-tight",
                  isCurrent
                    ? "font-medium text-foreground"
                    : "text-muted-foreground group-hover/stage:text-foreground group-disabled/stage:text-muted-foreground",
                )}
              >
                {candidate.label}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
