import { useProvideTimelineCommand } from "./timelineCommands";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AssetResource,
  EnvironmentId,
  VideoPreflight,
  VideoPreflightStep,
  VideoRenderReport,
} from "@t3tools/contracts";
import { preflightHeadline } from "@t3tools/timeline/preflight";
import { type ReactNode, useEffect, useEffectEvent, useState } from "react";

import { useAssetUrls } from "~/assets/assetUrls";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { type VideoStageState, VideoStageStepper } from "../videoProject/VideoStage";

type Action = NonNullable<VideoPreflightStep["action"]>;
type State = VideoPreflightStep["state"];

/**
 * What the Timeline tab does for each step's action: a function for a plain button, or the
 * control itself when the action already has one (the import dialog's button). The strip runs
 * the render check and the posted record itself; an action left out is not offered.
 */
export type PreflightActions = Partial<
  Record<Exclude<Action, "checkRender" | "markPosted" | "unmarkPosted">, (() => void) | ReactNode>
>;

const DOT: Record<State, string> = {
  done: "bg-success",
  working: "bg-info",
  todo: "bg-muted-foreground/35",
  warn: "bg-warning",
  fail: "bg-destructive",
};

const DETAIL: Record<State, string> = {
  done: "text-muted-foreground",
  working: "text-muted-foreground",
  todo: "text-muted-foreground",
  warn: "text-warning",
  fail: "text-destructive",
};

const ACTION_LABEL: Record<Action, string> = {
  importFootage: "Import footage",
  sync: "Sync",
  merge: "Merge",
  transcribe: "Transcribe",
  linkPremiere: "Pull from Premiere",
  checkRender: "Check render",
  markPosted: "Mark posted",
  unmarkPosted: "Undo",
};

const failureMessage = (error: unknown) =>
  error instanceof Error && error.message.trim() !== "" ? error.message : "Try again in a moment.";

const dayOf = (time: number) =>
  new Date(time).toLocaleDateString([], { month: "short", day: "numeric" });

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** The last render check: what it found, and the contact sheet to look the export over. */
function RenderReport(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly report: VideoRenderReport;
}) {
  const { report } = props;
  const [sheetOpen, setSheetOpen] = useState(false);
  const resources: ReadonlyArray<AssetResource> =
    report.contactSheet === null
      ? []
      : [{ _tag: "draft-workspace-file", cwd: props.workspaceRoot, path: report.contactSheet }];
  const [sheetUrl] = useAssetUrls(props.environmentId, resources);
  const findings = report.items.filter((item) => item.level !== "pass");
  return (
    <div className="flex flex-col gap-1.5 rounded-sm border border-border/60 p-2">
      <span className="text-muted-foreground">
        {fileName(report.exportPath)}, checked {dayOf(report.checkedAt)}.{" "}
        {report.items.length - findings.length} of {report.items.length} checks passed.
      </span>
      {findings.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {findings.map((item) => (
            <li key={item.id} className="flex flex-col wrap-break-word">
              <span className={cn("font-medium", DETAIL[item.level === "fail" ? "fail" : "warn"])}>
                {item.title}
              </span>
              <span className="text-muted-foreground">{item.detail}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {sheetUrl ? (
        <>
          <button
            type="button"
            aria-label="Open the contact sheet"
            className="cursor-zoom-in overflow-hidden rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            onClick={() => setSheetOpen(true)}
          >
            <img
              // The sheet keeps its path across checks; the check's time fetches the new one.
              src={`${sheetUrl}${sheetUrl.includes("?") ? "&" : "?"}v=${report.checkedAt}`}
              alt="Contact sheet of the export"
              className="max-h-40 w-full object-cover object-top"
            />
          </button>
          <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
            <DialogPopup className="max-w-5xl">
              <DialogHeader>
                <DialogTitle>Contact sheet: {fileName(report.exportPath)}</DialogTitle>
              </DialogHeader>
              <DialogPanel>
                <img
                  src={`${sheetUrl}${sheetUrl.includes("?") ? "&" : "?"}v=${report.checkedAt}`}
                  alt="Contact sheet of the export"
                  className="w-full"
                />
              </DialogPanel>
            </DialogPopup>
          </Dialog>
        </>
      ) : null}
    </div>
  );
}

/**
 * Where the short is, in one control in the Timeline tab's bar: its stage, and a pip per step
 * of the run. It opens the stages, to move the project along, over the full list of steps with
 * what moves each one on. A step that went wrong is also said in words beside it; a step that is
 * merely next is not.
 */
export function PreflightStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly stage: VideoStageState;
  readonly workspaceRoot: string;
  /**
   * What the tab already loads that the steps are derived from: the last sync with Premiere,
   * the timeline's text and the status files' text. The steps are read again when one changes.
   */
  readonly watched: {
    readonly sync: unknown;
    readonly timeline: string | undefined;
    readonly proxies: string | undefined;
    readonly intake: string | undefined;
    readonly transcripts: string | undefined;
  };
  readonly canWrite: boolean;
  /** Edits in the viewer that aren't saved; a sync before the render check would drop them. */
  readonly uncommittedEdits: boolean;
  readonly actions: PreflightActions;
  /** Brings the timeline up to Premiere's last save before an export is checked against it. */
  readonly onBeforeRenderCheck: () => Promise<void>;
}) {
  const readPreflight = useAtomCommand(projectEnvironment.readVideoPreflight, {
    reportFailure: false,
  });
  const checkRender = useAtomCommand(projectEnvironment.checkVideoRender, { reportFailure: false });
  const setPosted = useAtomCommand(projectEnvironment.setVideoPosted, { reportFailure: false });
  const [loaded, setLoaded] = useState<{
    readonly preflight: VideoPreflight;
    /** What it was read for, so a newer request shows as still reading. */
    readonly readFor: ReadonlyArray<unknown>;
  } | null>(null);
  const [reloads, setReloads] = useState(0);
  const [checking, setChecking] = useState(false);
  const [links, setLinks] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const { sync, timeline, proxies, intake, transcripts } = props.watched;

  const read = useEffectEvent(() =>
    readPreflight({
      environmentId: props.environmentId,
      input: { workspaceRoot: props.workspaceRoot },
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The steps are derived on the server from the project folder; they are read again when what the tab already watches there changes, with no timer of their own.
  useEffect(() => {
    let current = true;
    const readFor = [reloads, sync, timeline, proxies, intake, transcripts];
    void read().then((result) => {
      if (current && result._tag === "Success") setLoaded({ preflight: result.value, readFor });
    });
    return () => {
      current = false;
    };
  }, [reloads, sync, timeline, proxies, intake, transcripts]);

  const runCheck = async () => {
    setChecking(true);
    await props.onBeforeRenderCheck();
    const result = await checkRender({
      environmentId: props.environmentId,
      input: { workspaceRoot: props.workspaceRoot },
    });
    setChecking(false);
    setReloads((count) => count + 1);
    if (result._tag === "Success") {
      const findings = result.value.items.filter((item) => item.level !== "pass").length;
      toastManager.add({
        type: result.value.level === "fail" ? "error" : "success",
        title:
          result.value.level === "pass"
            ? "The export matches the timeline"
            : `Render check: ${findings} to look at`,
        description: fileName(result.value.exportPath),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not check the export",
        description: failureMessage(squashAtomCommandFailure(result)),
      });
    }
  };

  useProvideTimelineCommand(
    "checkRender",
    props.canWrite && !checking && !props.uncommittedEdits ? () => void runCheck() : null,
  );

  const preflight = loaded?.preflight ?? null;
  const reading =
    loaded === null ||
    [reloads, sync, timeline, proxies, intake, transcripts].some(
      (value, index) => value !== loaded.readFor[index],
    );
  const steps = preflight?.steps ?? [];
  const headline = preflightHeadline(steps);
  const done = steps.filter((step) => step.state === "done").length;

  const recordPosted = async (posted: boolean) => {
    const urls = (links ?? "")
      .split(/\s+/)
      .map((url) => url.trim())
      .filter((url) => url !== "");
    const result = await setPosted({
      environmentId: props.environmentId,
      input: { workspaceRoot: props.workspaceRoot, posted, ...(posted ? { urls } : {}) },
    });
    if (result._tag === "Success") {
      setLoaded({ preflight: result.value, readFor: loaded?.readFor ?? [] });
      setLinks(null);
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not save that",
        description: failureMessage(squashAtomCommandFailure(result)),
      });
    }
  };

  const control = (step: VideoPreflightStep): ReactNode => {
    const { action } = step;
    if (action === null || !props.canWrite) return null;
    const button = (onClick: () => void, disabled = false) => (
      <Button size="micro" variant="outline" disabled={disabled} onClick={onClick}>
        {ACTION_LABEL[action]}
      </Button>
    );
    switch (action) {
      case "checkRender":
        return button(() => void runCheck(), checking || props.uncommittedEdits);
      case "markPosted":
        return button(() => {
          // The links are asked for in the list, which has room for them.
          setLinks("");
          setOpen(true);
        }, links !== null);
      case "unmarkPosted":
        return button(() => void recordPosted(false));
      default: {
        const provided = props.actions[action];
        if (provided === undefined) return null;
        return typeof provided === "function"
          ? button(provided, action === "merge" && props.uncommittedEdits)
          : provided;
      }
    }
  };

  const detail = (step: VideoPreflightStep) =>
    step.id === "render" && checking
      ? "Checking the export…"
      : step.id === "posted" && preflight?.posted && preflight.posted.at > 0
        ? `${dayOf(preflight.posted.at)} · ${step.detail}`
        : step.detail;

  const attention =
    headline !== null && (headline.state === "warn" || headline.state === "fail") ? headline : null;
  return (
    <div className="flex min-w-14 items-center gap-1.5 text-xs">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // Opening the list reads the steps again: an export or a post since would not show otherwise.
          if (next) setReloads((count) => count + 1);
        }}
      >
        <PopoverTrigger
          render={
            <Button
              size="xs"
              variant="ghost"
              aria-label={
                preflight === null
                  ? `Stage: ${props.stage.label}`
                  : `Stage: ${props.stage.label}. ${done} of ${steps.length} steps done`
              }
              aria-busy={reading}
            />
          }
        >
          {preflight === null ? (
            <span>Steps</span>
          ) : (
            <>
              <span aria-hidden className="flex items-center gap-0.5 pl-0.5">
                {steps.map((step) => (
                  <span key={step.id} className={cn("h-2.5 w-1 rounded-full", DOT[step.state])} />
                ))}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {done}/{steps.length}
              </span>
            </>
          )}
        </PopoverTrigger>
        <PopoverPopup side="bottom" align="start" className="w-88">
          <div className="flex flex-col gap-3 text-xs">
            <section className="flex flex-col gap-1.5">
              <h3 className="label-caps text-muted-foreground">Stage</h3>
              <VideoStageStepper state={props.stage} />
            </section>
            {preflight === null ? null : (
              <section className="flex flex-col gap-1.5 border-t border-border/60 pt-3">
                <h3 className="label-caps text-muted-foreground">
                  Steps · {done} of {steps.length} done
                </h3>
                <ol className="flex flex-col gap-1.5">
                  {steps.map((step) => (
                    <li key={step.id} className="flex flex-col gap-1.5">
                      <div className="flex min-h-5 items-center gap-2">
                        <span aria-hidden className={cn("size-1.5 shrink-0", DOT[step.state])} />
                        <span className="shrink-0 font-medium">{step.label}</span>
                        <span className={cn("min-w-0 flex-1 truncate", DETAIL[step.state])}>
                          {detail(step)}
                        </span>
                        {control(step)}
                      </div>
                      {step.id === "render" && preflight.render !== null ? (
                        <RenderReport
                          environmentId={props.environmentId}
                          workspaceRoot={props.workspaceRoot}
                          report={preflight.render}
                        />
                      ) : null}
                      {step.id === "posted" && preflight.posted !== null
                        ? preflight.posted.urls.map((url) => (
                            <a
                              key={url}
                              href={url}
                              target="_blank"
                              rel="noreferrer"
                              className="truncate pl-3.5 text-muted-foreground underline-offset-2 hover:underline"
                            >
                              {url}
                            </a>
                          ))
                        : null}
                      {step.id === "posted" && links !== null ? (
                        <form
                          className="flex flex-col gap-1.5"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void recordPosted(true);
                          }}
                        >
                          <Textarea
                            aria-label="Links to the posts"
                            size="sm"
                            placeholder="Links to the posts, one per line (optional)"
                            value={links}
                            onChange={(event) => setLinks(event.target.value)}
                          />
                          <div className="flex justify-end gap-1">
                            <Button size="xs" variant="ghost" onClick={() => setLinks(null)}>
                              Cancel
                            </Button>
                            <Button size="xs" type="submit">
                              Mark posted
                            </Button>
                          </div>
                          <p className="text-muted-foreground">
                            Ask the agent to set the catalog row to Posted; it updates the sheet.
                          </p>
                        </form>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </div>
        </PopoverPopup>
      </Popover>
      {attention === null ? null : (
        <>
          <span className={cn("min-w-0 truncate", DETAIL[attention.state])}>
            {attention.label}: {detail(attention)}
          </span>
          {control(attention)}
        </>
      )}
    </div>
  );
}
