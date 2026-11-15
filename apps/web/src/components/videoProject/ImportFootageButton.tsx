import { useProvideTimelineCommand } from "~/components/timeline/timelineCommands";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, VideoProjectScanIntakeResult } from "@t3tools/contracts";
import { ImportIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

type IntakeFile = VideoProjectScanIntakeResult["files"][number];

const dayOf = (file: IntakeFile) =>
  new Date(file.capturedAt).toLocaleDateString([], { month: "short", day: "numeric" });

const sizeLabel = (bytes: number) =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;

/** Files shot on the same day, in shooting order; AirDrop keeps the camera's dates. */
const byDay = (files: ReadonlyArray<IntakeFile>) => {
  const days = new Map<string, Array<IntakeFile>>();
  for (const file of files) {
    const day = dayOf(file);
    days.set(day, [...(days.get(day) ?? []), file]);
  }
  return [...days];
};

const failureMessage = (error: unknown) =>
  error instanceof Error && error.message.trim() !== "" ? error.message : "Try again in a moment.";

/**
 * Intake: finds the videos and photos that recently arrived in the host's Downloads, lets the
 * person choose which belong to this project, and copies them into its Footage folder.
 */
export function ImportFootageButton(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  /** Called once the copy has started; progress then comes from the project's intake status. */
  readonly onStarted: () => void;
  readonly size?: "sm" | "micro";
  /** A quiet toolbar button with a short name, explained by its tooltip. */
  readonly toolbar?: boolean;
}) {
  const scan = useAtomCommand(projectEnvironment.scanVideoIntake, { reportFailure: false });
  const startImport = useAtomCommand(projectEnvironment.importVideoFootage, {
    reportFailure: false,
  });
  const [found, setFound] = useState<VideoProjectScanIntakeResult | null>(null);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState<"scanning" | "starting" | null>(null);

  const open = async () => {
    setBusy("scanning");
    const result = await scan({
      environmentId: props.environmentId,
      input: { workspaceRoot: props.workspaceRoot },
    });
    setBusy(null);
    if (result._tag !== "Success") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Could not look in Downloads",
          description: failureMessage(squashAtomCommandFailure(result)),
        });
      }
      return;
    }
    const [first] = result.value.files;
    setExcluded(new Set());
    setFolder(first === undefined ? "" : `00 Raw (${dayOf(first)})`);
    setFound(result.value);
  };

  useProvideTimelineCommand("importFootage", busy === null ? () => void open() : null);

  const files = found?.files ?? [];
  const chosen = files.filter((file) => !excluded.has(file.path));
  const toggle = (paths: ReadonlyArray<string>, include: boolean) => {
    const next = new Set(excluded);
    for (const path of paths) {
      if (include) next.delete(path);
      else next.add(path);
    }
    setExcluded(next);
  };

  const copy = async () => {
    setBusy("starting");
    const result = await startImport({
      environmentId: props.environmentId,
      input: {
        workspaceRoot: props.workspaceRoot,
        paths: chosen.map((file) => file.path),
        folder: folder.trim(),
      },
    });
    setBusy(null);
    if (result._tag !== "Success") {
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Could not start the import",
          description: failureMessage(squashAtomCommandFailure(result)),
        });
      }
      return;
    }
    setFound(null);
    props.onStarted();
  };

  return (
    <>
      {props.toolbar ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant="ghost"
                aria-label="Import footage"
                disabled={busy !== null}
                onClick={() => void open()}
              />
            }
          >
            {busy === "scanning" ? <Spinner size="xs" /> : <ImportIcon />}
            Import
          </TooltipTrigger>
          <TooltipPopup side="bottom">Import footage from Downloads</TooltipPopup>
        </Tooltip>
      ) : (
        <Button
          variant="outline"
          {...(props.size ? { size: props.size } : {})}
          disabled={busy !== null}
          onClick={() => void open()}
        >
          <ImportIcon />
          {busy === "scanning" ? "Looking in Downloads…" : "Import footage"}
        </Button>
      )}
      <Dialog open={found !== null} onOpenChange={(next) => (next ? undefined : setFound(null))}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Import footage</DialogTitle>
            <DialogDescription>
              {files.length === 0
                ? `Nothing new in ${found?.source ?? "Downloads"} from the last few days.`
                : `New in ${found?.source ?? "Downloads"}. Choose what belongs to this project; the originals stay where they are.`}
            </DialogDescription>
          </DialogHeader>
          {files.length > 0 ? (
            <DialogPanel>
              <div className="flex flex-col gap-3">
                <div className="overflow-hidden rounded-lg border border-border/60">
                  <ScrollArea className="h-72">
                    <div className="flex flex-col gap-2 p-2">
                      {byDay(files).map(([day, dayFiles]) => {
                        const paths = dayFiles.map((file) => file.path);
                        const included = dayFiles.filter((file) => !excluded.has(file.path));
                        return (
                          <div key={day} className="flex flex-col">
                            <label className="flex items-center gap-2 px-1 py-1 text-xs text-muted-foreground">
                              <Checkbox
                                checked={included.length === dayFiles.length}
                                indeterminate={
                                  included.length > 0 && included.length < dayFiles.length
                                }
                                onCheckedChange={(checked) => toggle(paths, checked === true)}
                              />
                              <span className="font-medium text-foreground">Shot {day}</span>
                              <span>
                                {dayFiles.length} {dayFiles.length === 1 ? "file" : "files"} ·{" "}
                                {sizeLabel(dayFiles.reduce((sum, file) => sum + file.size, 0))}
                              </span>
                            </label>
                            {dayFiles.map((file) => (
                              <label
                                key={file.path}
                                className="flex items-center gap-2 rounded-md px-1 py-1 pl-6 text-sm hover:bg-accent"
                              >
                                <Checkbox
                                  checked={!excluded.has(file.path)}
                                  onCheckedChange={(checked) =>
                                    toggle([file.path], checked === true)
                                  }
                                />
                                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                                  {new Date(file.capturedAt).toLocaleTimeString([], {
                                    hour: "numeric",
                                    minute: "2-digit",
                                  })}{" "}
                                  · {sizeLabel(file.size)}
                                </span>
                              </label>
                            ))}
                          </div>
                        );
                      })}
                    </div>
                  </ScrollArea>
                </div>
                <div className="flex flex-col gap-1">
                  <p className="text-xs text-muted-foreground">Folder inside Footage</p>
                  <Input
                    aria-label="Folder inside Footage"
                    value={folder}
                    onChange={(event) => setFolder(event.target.value)}
                  />
                </div>
              </div>
            </DialogPanel>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFound(null)}>
              {files.length === 0 ? "Close" : "Cancel"}
            </Button>
            {files.length > 0 ? (
              <Button
                disabled={chosen.length === 0 || folder.trim() === "" || busy !== null}
                onClick={() => void copy()}
              >
                {busy === "starting"
                  ? "Starting…"
                  : `Copy ${chosen.length} ${chosen.length === 1 ? "file" : "files"} · ${sizeLabel(
                      chosen.reduce((sum, file) => sum + file.size, 0),
                    )}`}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
