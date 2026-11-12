import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  VideoProjectInspectPremiereResult,
} from "@t3tools/contracts";
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
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
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

// Projects usually sit side by side on one drive, so the browser reopens where the last one was.
const lastFolderKey = (environmentId: EnvironmentId) =>
  `stellar.videoProject.folder.${environmentId}`;

const readLastFolder = (environmentId: EnvironmentId) => {
  try {
    return window.localStorage.getItem(lastFolderKey(environmentId)) ?? "~/";
  } catch {
    return "~/";
  }
};

const writeLastFolder = (environmentId: EnvironmentId, folder: string) => {
  try {
    window.localStorage.setItem(lastFolderKey(environmentId), folder);
  } catch {
    // Storage is a convenience; the browser just starts from home next time.
  }
};

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Something went wrong.";

const parentOf = (folder: string) => {
  const trimmed = folder.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : `${trimmed.slice(0, index)}/`;
};

type Mode = "idea" | "premiere" | "carousel";

/**
 * Starts a video project on the machine running Stellar, either way round:
 * - from an idea: a name and a folder, before any footage or Premiere project exists;
 * - from a Premiere project: pick the .prproj and a sequence, and the server pulls the timeline
 *   into the Stellar folder beside it and builds proxies in the background.
 */
export function NewVideoProjectDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Opens straight on picking a Premiere project in this folder, for a project that has none. */
  readonly premiereFolder?: string;
  /** Called instead of opening a new thread, when the project is already open. */
  readonly onPulled?: () => void;
}) {
  const [mode, setMode] = useState<Mode>(props.premiereFolder === undefined ? "idea" : "premiere");
  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState(
    () => props.premiereFolder ?? readLastFolder(props.environmentId),
  );
  const [typed, setTyped] = useState<string | null>(null);
  const [chosen, setChosen] = useState<{
    readonly path: string;
    readonly inspected: VideoProjectInspectPremiereResult;
  } | null>(null);
  const [sequenceId, setSequenceId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"inspecting" | "creating" | null>(null);
  const inspect = useAtomCommand(projectEnvironment.inspectPremiere, { reportFailure: false });
  const create = useAtomCommand(projectEnvironment.createVideoProject, { reportFailure: false });
  const createFromIdea = useAtomCommand(projectEnvironment.createVideoProjectFromIdea, {
    reportFailure: false,
  });
  const createCarousel = useAtomCommand(projectEnvironment.createCarousel, {
    reportFailure: false,
  });
  // A carousel is named and placed like a video from an idea; only what is created differs.
  const named = mode !== "premiere";
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
    if (mode === "premiere" && path.toLowerCase().endsWith(".prproj")) void choose(path);
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
    // The folder holding this project's folder: out of "Premiere" if it's in one, then up one.
    const holder = parentOf(chosen.path);
    writeLastFolder(
      props.environmentId,
      parentOf(/\/premiere\/$/i.test(holder) ? parentOf(holder) : holder),
    );
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: result.value.existed
          ? `Pulled ${chosen.inspected.title}`
          : `Created ${chosen.inspected.title}`,
        description: `Previews are building in the background. ${result.value.workspaceRoot}`,
      }),
    );
    if (props.onPulled) {
      setBusy(null);
      props.onOpenChange(false);
      setChosen(null);
      props.onPulled();
      return;
    }
    await openProject(result.value.projectId);
  };

  // The folder being browsed, as the host resolved it ("~/" becomes an absolute path).
  const parentFolder = listing.data?.parentPath ?? null;
  const createIdeaProject = async () => {
    const name = title.trim();
    if (name === "" || parentFolder === null) return;
    setBusy("creating");
    const result = await (mode === "carousel" ? createCarousel : createFromIdea)({
      environmentId: props.environmentId,
      input: { title: name, parentFolder },
    });
    if (result._tag === "Failure") {
      setBusy(null);
      if (!isAtomCommandInterrupted(result)) {
        fail(
          mode === "carousel"
            ? "Couldn't create the carousel"
            : "Couldn't create the video project",
          squashAtomCommandFailure(result),
        );
      }
      return;
    }
    writeLastFolder(props.environmentId, folder);
    toastManager.add(
      stackedThreadToast({
        type: "success",
        title: result.value.existed ? `Opened ${name}` : `Created ${name}`,
        description: parentOf(result.value.workspaceRoot),
      }),
    );
    setTitle("");
    await openProject(result.value.projectId);
  };

  const openProject = async (projectId: ProjectId) => {
    const projectRef = scopeProjectRef(props.environmentId, projectId);
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

  const entries = (listing.data?.entries ?? []).filter((entry) => !named || entry.kind !== "file");
  const ideaName = title.trim();
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {props.premiereFolder === undefined ? "New project" : "New video project"}
          </DialogTitle>
          <DialogDescription>
            {mode === "carousel"
              ? "A photo carousel for Instagram: slides you lay out here and export as images, ready to post."
              : mode === "idea"
                ? "Start from an idea. Stellar makes the project's folders, so the script and footage have a home before Premiere does."
                : "Start from a Premiere project. Stellar keeps its files in a Stellar folder beside it, so they stay with your footage."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {chosen === null && props.premiereFolder === undefined ? (
              <ToggleGroup
                aria-label="Start from"
                className="w-full *:flex-1"
                value={[mode]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "idea" || value === "premiere" || value === "carousel") {
                    setMode(value);
                  }
                }}
              >
                <Toggle value="idea">Video from an idea</Toggle>
                <Toggle value="premiere">Video from Premiere</Toggle>
                <Toggle value="carousel">Photo carousel</Toggle>
              </ToggleGroup>
            ) : null}
            {chosen === null && named ? (
              <Input
                aria-label="Project name"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Project name, such as Jollibee lần đầu"
              />
            ) : null}
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
                    aria-label={
                      named ? "Folder to create it in" : "Folder or Premiere project path"
                    }
                    value={typed ?? folder}
                    onChange={(event) => setTyped(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") go(event.currentTarget.value);
                    }}
                    placeholder={named ? "~/Movies" : "~/Movies or a path to a .prproj"}
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
                        {listing.error ??
                          (named
                            ? "No folders in here. The project can still be created here."
                            : "No folders or Premiere projects here.")}
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
                {named && parentFolder !== null ? (
                  <p className="text-xs text-muted-foreground">
                    Creates{" "}
                    <span className="text-foreground">
                      {parentFolder.replace(/\/+$/, "")}/{ideaName === "" ? "…" : ideaName}
                    </span>{" "}
                    {mode === "carousel"
                      ? "with Photos, Exports and Stellar folders."
                      : "with Footage, Audio, B-roll, Graphics, Premiere, Exports and Stellar folders."}
                  </p>
                ) : null}
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
          {named ? (
            <Button
              disabled={ideaName === "" || parentFolder === null || busy !== null}
              onClick={() => void createIdeaProject()}
            >
              {busy === "creating" ? "Creating…" : "Create project"}
            </Button>
          ) : (
            <Button
              disabled={chosen === null || sequenceId === null || busy !== null}
              onClick={() => void createProject()}
            >
              {busy === "creating"
                ? "Pulling…"
                : props.onPulled
                  ? "Pull sequence"
                  : "Create project"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
