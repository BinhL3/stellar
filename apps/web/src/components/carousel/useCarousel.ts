import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  CarouselDocument,
  CarouselEdit,
  CarouselRenderRequest,
  CarouselView,
  EnvironmentId,
} from "@t3tools/contracts";
import { applyCarouselEdits } from "@t3tools/timeline/carousel";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { toastManager } from "~/components/ui/toast";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { type PhotoLookup, renderRequest } from "./drawSlide";

const HISTORY_LIMIT = 100;

const describe = (error: unknown) =>
  error instanceof Error && error.message.trim() !== "" ? error.message : "Try again in a moment.";

interface History {
  readonly past: ReadonlyArray<CarouselDocument>;
  readonly future: ReadonlyArray<CarouselDocument>;
}

const NO_HISTORY: History = { past: [], future: [] };

/**
 * A carousel as this client edits it. Edits apply here at once with the same function the
 * server runs, then go to the server, whose answer replaces the local copy. The server's
 * stream brings changes made elsewhere (an agent, another window) and the pictures it wants
 * drawn.
 */
export function useCarousel(environmentId: EnvironmentId, workspaceRoot: string) {
  const watched = useEnvironmentQuery(
    projectEnvironment.watchCarousel({ environmentId, input: { workspaceRoot } }),
  );
  const server = watched.data?.view ?? null;
  // An edit shows before the server confirms it; `revision` is null until it has.
  const [local, setLocal] = useState<{
    readonly document: CarouselDocument;
    readonly revision: number | null;
  } | null>(null);
  const [history, setHistory] = useState(NO_HISTORY);
  const [seenRevision, setSeenRevision] = useState<number | null>(null);
  const editCarousel = useAtomCommand(projectEnvironment.editCarousel, { reportFailure: false });
  const inFlight = useRef(0);
  const sending = useRef<Promise<void>>(Promise.resolve());

  const confirmed =
    local !== null &&
    (local.revision === null || server === null || local.revision >= server.revision);
  const document = confirmed ? local.document : (server?.document ?? null);

  if (server !== null && server.revision !== seenRevision) {
    setSeenRevision(server.revision);
    // A change from elsewhere: undoing past it would silently throw that change away.
    if (seenRevision !== null && local?.revision !== server.revision && local?.revision !== null) {
      setHistory(NO_HISTORY);
    }
  }

  const send = (edits: ReadonlyArray<CarouselEdit>) => {
    inFlight.current += 1;
    sending.current = sending.current.then(async () => {
      const result = await editCarousel({ environmentId, input: { workspaceRoot, edits } });
      inFlight.current -= 1;
      if (result._tag === "Success") {
        const view: CarouselView = result.value;
        // Later edits are still on their way; the last answer is the one to settle on.
        if (inFlight.current === 0) setLocal({ document: view.document, revision: view.revision });
        return;
      }
      setLocal(null);
      setHistory(NO_HISTORY);
      if (!isAtomCommandInterrupted(result)) {
        toastManager.add({
          type: "error",
          title: "Could not save the change",
          description: describe(squashAtomCommandFailure(result)),
        });
      }
    });
  };

  /** Applies edits, or says why not. Returns the new document so a caller can read new ids. */
  const edit = (edits: ReadonlyArray<CarouselEdit>): CarouselDocument | null => {
    if (document === null) return null;
    const result = applyCarouselEdits(document, edits);
    if (!result.ok) {
      toastManager.add({ type: "error", title: "Can't do that", description: result.error });
      return null;
    }
    if (result.document === document) return document;
    setLocal({ document: result.document, revision: null });
    setHistory({ past: [...history.past, document].slice(-HISTORY_LIMIT), future: [] });
    send(edits);
    return result.document;
  };

  const step = (direction: "undo" | "redo") => {
    if (document === null) return;
    const target = direction === "undo" ? history.past.at(-1) : history.future.at(-1);
    if (target === undefined) return;
    const edits: ReadonlyArray<CarouselEdit> = [{ kind: "restore", document: target }];
    const result = applyCarouselEdits(document, edits);
    if (!result.ok) return;
    setLocal({ document: result.document, revision: null });
    setHistory(
      direction === "undo"
        ? { past: history.past.slice(0, -1), future: [...history.future, document] }
        : { past: [...history.past, document], future: history.future.slice(0, -1) },
    );
    send(edits);
  };

  return {
    document,
    view: server,
    renders: watched.data?.renders ?? NO_RENDERS,
    error: watched.error,
    isPending: watched.isPending && server === null,
    edit,
    undo: () => step("undo"),
    redo: () => step("redo"),
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}

const NO_RENDERS: ReadonlyArray<CarouselRenderRequest> = [];

/**
 * Draws the pictures the server asks for and sends them back. This is how an agent exports
 * and looks at its work: the same routine as the preview, run in whichever window is open.
 */
export function useCarouselRenders(input: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly document: CarouselDocument | null;
  readonly renders: ReadonlyArray<CarouselRenderRequest>;
  readonly photoOf: PhotoLookup;
  readonly photosReady: boolean;
}) {
  const submit = useAtomCommand(projectEnvironment.submitCarouselRender, { reportFailure: false });
  const handled = useRef(new Set<string>());
  const { environmentId, workspaceRoot, document, renders, photoOf, photosReady } = input;
  const answer = async (request: CarouselRenderRequest, current: CarouselDocument) => {
    const target = { workspaceRoot, requestId: request.id };
    try {
      await globalThis.document.fonts.ready;
      const images = await renderRequest(current, request, photoOf);
      for (const [index, data] of images.entries()) {
        await submit({ environmentId, input: { ...target, index, data } });
      }
    } catch (error) {
      await submit({
        environmentId,
        input: { ...target, index: 0, data: new Uint8Array(), error: describe(error) },
      });
    }
  };
  const answerPending = useEffectEvent(() => {
    if (document === null || !photosReady) return;
    for (const request of renders) {
      if (handled.current.has(request.id)) continue;
      handled.current.add(request.id);
      void answer(request, document);
    }
  });
  const requested = renders.map((request) => request.id).join(" ");
  const hasDocument = document !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The server asks for pictures over its stream; drawing and sending them is work outside React.
  useEffect(() => {
    if (requested !== "" && photosReady && hasDocument) answerPending();
  }, [requested, photosReady, hasDocument]);
}
