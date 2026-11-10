import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, VideoProjectInspectPremiereResult } from "@t3tools/contracts";
import { ChevronLeftIcon, ClapperboardIcon, FolderIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
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
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { cn } from "~/lib/utils";
import { waitForProject } from "~/state/entities";
import { filesystemEnvironment } from "~/state/filesystem";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

const PREMIERE_EXTENSIONS = [".prproj"];

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Something went wrong.";

const parentOf = (folder: string) => {
  const trimmed = folder.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : `${trimmed.slice(0, index)}/`;
};

/**
 * Starts a video project from a Premiere project: pick the .prproj on the machine running Stellar,
 * pick a sequence, and the server creates the Stellar folder beside it, pulls the timeline and
 * builds proxies in the background.
 */
export function NewVideoProjectDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [folder, setFolder] = useState("~/");
  const [typed, setTyped] = useState<string | null>(null);
  const [chosen, setChosen] = useState<{
    readonly path: string;
    readonly inspected: VideoProjectInspectPremiereResult;
  } | null>(null);
  const [sequenceId, setSequenceId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"inspecting" | "creating" | null>(null);
  const inspect = useAtomCommand(projectEnvironment.inspectPremiere, { reportFailure: false });
  const create = useAtomCommand(projectEnvironment.createVideoProject, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();
  const listing = useEnvironmentQuery(
    props.open && chosen === null
      ? filesystemEnvironment.browse({
          environmentId: props.environmentId,
          input: { partialPath: folder, fileExtensions: PREMIERE_EXTENSIONS },
        })
      : null,
  );

  const fail = (title: string, error: unknown) =>
    toastManager.add(
      stackedThreadToast({ type: "error", title, description: errorMessage(error) }),
    );

  const choose = async (path: string) => {
    setBusy("inspecting");
    const result = await inspect({
      environmentId: props.environmentId,
      input: { premiereProjectPath: path },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        fail("Couldn't open that Premiere project", squashAtomCommandFailure(result));
      }
      return;
    }
    setChosen({ path, inspected: result.value });
    setSequenceId(result.value.sequences.at(-1)?.id ?? null);
  };

  const go = (value: string) => {
    const path = value.trim();
    if (path === "") return;
    if (path.toLowerCase().endsWith(".prproj")) void choose(path);
    else setFolder(path.endsWith("/") ? path : `${path}/`);
    setTyped(null);
  };

  const createProject = async () => {
    if (chosen === null || sequenceId === null) return;
    setBusy("creating");
    const result = await create({
      environmentId: props.environmentId,
      input: { premiereProjectPath: chosen.path, sequenceId },
    });
    if (result._tag === "Failure") {
      setBusy(null);
      if (!isAtomCommandInterrupted(result)) {
        fail("Couldn't create the video project", squashAtomCommandFailure(result));
      }
      return;
    }
    const projectRef = scopeProjectRef(props.environmentId, result.value.projectId);
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: result.value.existed
          ? `Updated ${chosen.inspected.title}`
          : `Created ${chosen.inspected.title}`,
        description: `Previews are building in the background. ${result.value.workspaceRoot}`,
      }),
    );
    // Drafts are keyed by the stored project path, so wait for the project before opening one.
    const project = await waitForProject(projectRef).catch((error: unknown) => {
      fail("Created the project, but couldn't open it", error);
      return null;
    });
    setBusy(null);
    props.onOpenChange(false);
    setChosen(null);
    if (project !== null) {
      await handleNewThread(projectRef).catch((error: unknown) =>
        fail("Couldn't open a thread", error),
      );
    }
  };

  const entries = listing.data?.entries ?? [];
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New video project</DialogTitle>
          <DialogDescription>
            Start from a Premiere project. Stellar keeps its files in a Stellar folder beside it, so
            they stay with your footage.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {chosen === null ? (
              <>
                <div className="flex items-center gap-2">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Up one folder"
                    onClick={() => setFolder(parentOf(folder))}
                  >
                    <ChevronLeftIcon />
                  </Button>
                  <Input
                    aria-label="Folder or Premiere project path"
                    value={typed ?? folder}
                    onChange={(event) => setTyped(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") go(event.currentTarget.value);
                    }}
                    placeholder="~/Movies or a path to a .prproj"
                  />
                </div>
                <div className="overflow-hidden rounded-lg border border-border/60">
                  <ScrollArea className="h-72">
                    {listing.isPending || busy === "inspecting" ? (
                      <div className="flex h-72 items-center justify-center text-muted-foreground">
                        <Spinner />
                      </div>
                    ) : entries.length === 0 ? (
                      <p className="p-4 text-sm text-muted-foreground">
                        {listing.error ?? "No folders or Premiere projects here."}
                      </p>
                    ) : (
                      <ul className="p-1">
                        {entries.map((entry) => (
                          <li key={entry.fullPath}>
                            <button
                              type="button"
                              className={cn(
                                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                                entry.kind === "file" && "font-medium",
                              )}
                              onClick={() =>
                                entry.kind === "file"
                                  ? void choose(entry.fullPath)
                                  : setFolder(`${entry.fullPath}/`)
                              }
                            >
                              {entry.kind === "file" ? (
                                <ClapperboardIcon className="size-4 shrink-0 text-primary" />
                              ) : (
                                <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                              )}
                              <span className="truncate">{entry.name}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </ScrollArea>
                </div>
              </>
            ) : (
              <>
                <div className="text-sm">
                  <p className="font-medium">{chosen.inspected.title}</p>
                  <p className="truncate text-xs text-muted-foreground">{chosen.path}</p>
                </div>
                <div className="flex flex-col gap-1">
                  <p className="text-xs text-muted-foreground">Sequence</p>
                  <div className="overflow-hidden rounded-lg border border-border/60">
                    <ScrollArea className="max-h-56">
                      <ul className="p-1" role="radiogroup" aria-label="Sequence">
                        {chosen.inspected.sequences.map((sequence) => (
                          <li key={sequence.id}>
                            <button
                              type="button"
                              role="radio"
                              aria-checked={sequence.id === sequenceId}
                              className={cn(
                                "flex w-full items-center rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                                sequence.id === sequenceId && "bg-accent font-medium",
                              )}
                              onClick={() => setSequenceId(sequence.id)}
                            >
                              {sequence.name || "Untitled sequence"}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </ScrollArea>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Files go in{" "}
                  <span className="text-foreground">{chosen.inspected.projectFolder}</span>
                </p>
              </>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          {chosen !== null ? (
            <Button variant="ghost" disabled={busy !== null} onClick={() => setChosen(null)}>
              Back
            </Button>
          ) : null}
          <Button
            disabled={chosen === null || sequenceId === null || busy !== null}
            onClick={() => void createProject()}
          >
            {busy === "creating" ? "Creating…" : "Create project"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
