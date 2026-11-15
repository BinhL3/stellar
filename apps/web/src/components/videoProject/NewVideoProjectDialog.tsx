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
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Button, InlineButton } from "~/components/ui/button";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { cn } from "~/lib/utils";
import { waitForProject } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { openFolderInCommandPalette } from "~/commandPaletteBus";
import { closeNewVideoProject, useNewVideoProjectRequest } from "~/videoProjectDialogBus";
import { HostFolderBrowser, parentOf, useHostFolderListing } from "./HostFolderBrowser";

const PREMIERE_EXTENSIONS = [".prproj"];

/** The dialog every "New project" entry point opens, through `openNewVideoProject`. */
export function NewVideoProjectDialogHost() {
  const { environmentId, open, session } = useNewVideoProjectRequest();
  return environmentId === null ? null : (
    <NewVideoProjectDialog
      key={session}
      environmentId={environmentId}
      open={open}
      onOpenChange={(next) => {
        if (!next) closeNewVideoProject();
      }}
    />
  );
}

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Something went wrong.";

type Mode = "idea" | "premiere" | "carousel";

/**
 * Starts a video project on the machine running Stellar, either way round:
 * - from an idea: just a name; it is saved in the environment's projects folder (Settings);
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
  // Null starts the Premiere browser in the projects folder; set once the user browses.
  const [browsedFolder, setBrowsedFolder] = useState<string | null>(null);
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
  const navigate = useNavigate();
  // A carousel is named and placed like a video from an idea; only what is created differs.
  const named = mode !== "premiere";
  const handleNewThread = useNewThreadHandler();
  const projectsFolder = useEnvironmentQuery(
    props.open
      ? projectEnvironment.projectsFolder({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const home = projectsFolder.data;
  const folder =
    browsedFolder ?? props.premiereFolder ?? (home?.exists === true ? `${home.path}/` : "~/");
  // Without a folder to start in, the browser waits to hear where the projects folder is.
  const startKnown =
    browsedFolder !== null || props.premiereFolder !== undefined || !projectsFolder.isPending;
  const listing = useHostFolderListing(
    props.environmentId,
    props.open && chosen === null && !named && startKnown ? folder : null,
    PREMIERE_EXTENSIONS,
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

  // The server saves it in the projects folder; an unavailable one (an unplugged drive) can't.
  const unavailable =
    home?.unavailable ??
    (projectsFolder.error === null
      ? null
      : "Couldn't find the projects folder. This Stellar server may need an update.");
  const canCreateNamed = home !== null && home.unavailable === null;
  const createIdeaProject = async () => {
    const name = title.trim();
    if (name === "" || !canCreateNamed) return;
    setBusy("creating");
    const result = await (mode === "carousel" ? createCarousel : createFromIdea)({
      environmentId: props.environmentId,
      input: { title: name },
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

  const openProjectsFolderSetting = () => {
    props.onOpenChange(false);
    void navigate({ to: "/settings/general", hash: "video-projects-folder" });
  };
  const openExistingFolder = () => {
    props.onOpenChange(false);
    openFolderInCommandPalette(props.environmentId);
  };
  const ideaName = title.trim();
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) setBrowsedFolder(null);
        props.onOpenChange(open);
      }}
    >
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
                onKeyDown={(event) => {
                  if (event.key === "Enter" && busy === null) void createIdeaProject();
                }}
                placeholder="Project name, such as Jollibee lần đầu"
              />
            ) : null}
            {chosen === null ? (
              <>
                {named && unavailable !== null ? (
                  <p className="text-xs text-warning-foreground">
                    {unavailable}{" "}
                    <InlineButton tone="default" onClick={openProjectsFolderSetting}>
                      Change the projects folder
                    </InlineButton>
                  </p>
                ) : named && home !== null ? (
                  <p className="text-xs text-muted-foreground">
                    Saved in{" "}
                    <Tooltip>
                      <TooltipTrigger render={<span />}>
                        {home.path.split(/[\\/]/).filter(Boolean).at(-1) ?? home.path}
                      </TooltipTrigger>
                      <TooltipPopup>{home.path}</TooltipPopup>
                    </Tooltip>
                  </p>
                ) : null}
                {!named ? (
                  <HostFolderBrowser
                    folder={folder}
                    onFolderChange={setBrowsedFolder}
                    listing={listing}
                    busy={busy === "inspecting"}
                    onChooseFile={(path) => void choose(path)}
                    isFilePath={(path) => path.toLowerCase().endsWith(".prproj")}
                    inputLabel="Folder or Premiere project path"
                    placeholder="~/Movies or a path to a .prproj"
                    emptyText="No folders or Premiere projects here."
                  />
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
          {chosen === null && props.premiereFolder === undefined ? (
            <div className="flex items-center sm:me-auto">
              <InlineButton tone="muted" onClick={openExistingFolder}>
                Open an existing folder…
              </InlineButton>
            </div>
          ) : null}
          {chosen !== null ? (
            <Button variant="ghost" disabled={busy !== null} onClick={() => setChosen(null)}>
              Back
            </Button>
          ) : null}
          {named ? (
            <Button
              disabled={ideaName === "" || !canCreateNamed || busy !== null}
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
