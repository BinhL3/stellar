/**
 * The run of a short, from script to posted, as steps with a state each. Derived from what the
 * project folder already records, so the strip in the Timeline tab and an agent read one answer.
 */
import type { RenderCheckLevel } from "./renderCheck.ts";

export type PreflightStepId =
  | "script"
  | "footage"
  | "proxies"
  | "transcripts"
  | "premiereLink"
  | "premiereSync"
  | "render"
  | "posted";

/** `todo` is a step not reached yet; `warn` and `fail` are steps that need the person. */
export type PreflightState = "done" | "working" | "todo" | "warn" | "fail";

export type PreflightAction =
  | "openScript"
  | "importFootage"
  | "sync"
  | "merge"
  | "transcribe"
  | "linkPremiere"
  | "checkRender"
  | "markPosted"
  | "unmarkPosted";

export interface PreflightStep {
  readonly id: PreflightStepId;
  readonly label: string;
  readonly state: PreflightState;
  /** What is there or what is missing, in a few words. */
  readonly detail: string;
  /** What moves the step on, where something does. */
  readonly action: PreflightAction | null;
}

interface Progress {
  readonly done: number;
  readonly total: number;
}

export interface PreflightFacts {
  /** Beats in the script snapshot. */
  readonly scriptBeats: number;
  /** Video files in Footage. */
  readonly footage: number;
  /** The last import, or null when nothing was imported through Stellar. */
  readonly intake: {
    readonly state: "copying" | "conforming" | "done" | "failed";
    readonly done: number;
    readonly total: number;
    readonly error?: string | undefined;
    /** While `conforming`: how many of the clips that need a constant-rate copy have one. */
    readonly conform?: { readonly done: number; readonly total: number } | undefined;
  } | null;
  /** The proxy index, or null before any build. */
  readonly proxies: {
    readonly building: Progress | null;
    readonly ready: number;
    readonly failed: number;
    /** Why the last build made nothing at all, such as ffmpeg not being installed. */
    readonly error?: string | null | undefined;
  } | null;
  readonly transcripts: {
    readonly ready: number;
    readonly total: number;
    readonly building: Progress | null;
    readonly failed: number;
    /** No transcriber on the host. */
    readonly unavailable: boolean;
  };
  /**
   * How the timelines stand against the linked Premiere project, read without pulling:
   * `behind` is a save in Premiere not pulled yet, `edited` edits here Premiere doesn't have.
   */
  readonly premiere: "unlinked" | "offline" | "current" | "behind" | "edited" | "conflict";
  /** Whether a video file is waiting in Exports. */
  readonly hasExport: boolean;
  /** The last render check; `stale` says what changed since it ran. */
  readonly render: {
    readonly level: RenderCheckLevel;
    readonly problems: number;
    readonly stale: "timeline" | "export" | null;
  } | null;
  readonly posted: { readonly urls: ReadonlyArray<string> } | null;
}

const count = (value: number, one: string, many = `${one}s`) =>
  `${value} ${value === 1 ? one : many}`;

/** The run's steps in the order a short goes through them. */
export const derivePreflight = (facts: PreflightFacts): Array<PreflightStep> => {
  const { intake, proxies, transcripts, render } = facts;
  const step = (
    id: PreflightStepId,
    label: string,
    state: PreflightState,
    detail: string,
    action: PreflightAction | null = null,
  ): PreflightStep => ({ id, label, state, detail, action });

  const missingTranscripts = transcripts.total - transcripts.ready;
  return [
    facts.scriptBeats > 0
      ? step("script", "Script", "done", count(facts.scriptBeats, "beat"))
      : step("script", "Script", "todo", "No script saved", "openScript"),

    intake?.state === "copying"
      ? step("footage", "Footage", "working", `Copying ${intake.done} of ${intake.total}`)
      : intake?.state === "conforming"
        ? step(
            "footage",
            "Footage",
            "working",
            intake.conform === undefined
              ? "Conforming frame rates"
              : `Conforming ${intake.conform.done + 1} of ${intake.conform.total} to a constant frame rate`,
          )
        : intake?.state === "failed"
          ? step(
              "footage",
              "Footage",
              "fail",
              `Import failed${intake.error === undefined ? "" : `: ${intake.error}`}`,
              "importFootage",
            )
          : facts.footage === 0
            ? step("footage", "Footage", "todo", "No footage imported", "importFootage")
            : step("footage", "Footage", "done", count(facts.footage, "video")),

    proxies === null
      ? facts.footage === 0
        ? step("proxies", "Previews", "todo", "Nothing to preview yet")
        : step("proxies", "Previews", "todo", "Not built", "sync")
      : proxies.building !== null
        ? step(
            "proxies",
            "Previews",
            "working",
            `Making ${proxies.building.done} of ${proxies.building.total}`,
          )
        : typeof proxies.error === "string"
          ? step("proxies", "Previews", "fail", proxies.error, "sync")
          : proxies.failed > 0
            ? step(
                "proxies",
                "Previews",
                "warn",
                `${count(proxies.failed, "file has", "files have")} no preview`,
              )
            : step("proxies", "Previews", "done", `Ready for ${count(proxies.ready, "file")}`),

    transcripts.building !== null
      ? step(
          "transcripts",
          "Transcripts",
          "working",
          `Transcribing ${transcripts.building.done} of ${transcripts.building.total}`,
        )
      : transcripts.total === 0
        ? step("transcripts", "Transcripts", "todo", "Nothing to transcribe yet")
        : missingTranscripts === 0
          ? step("transcripts", "Transcripts", "done", `All ${count(transcripts.total, "clip")}`)
          : transcripts.unavailable
            ? step("transcripts", "Transcripts", "warn", "No transcriber on this machine")
            : step(
                "transcripts",
                "Transcripts",
                "todo",
                `${transcripts.ready} of ${transcripts.total} clips${transcripts.failed > 0 ? `, ${transcripts.failed} failed` : ""}`,
                "transcribe",
              ),

    facts.premiere === "unlinked"
      ? step("premiereLink", "Premiere project", "todo", "None linked", "linkPremiere")
      : step("premiereLink", "Premiere project", "done", "Linked"),

    ((): PreflightStep => {
      const label = "In sync with Premiere";
      switch (facts.premiere) {
        case "unlinked":
          return step("premiereSync", label, "todo", "Waits for a Premiere project");
        case "offline":
          return step("premiereSync", label, "warn", "The Premiere project can't be read");
        case "conflict":
          return step("premiereSync", label, "fail", "Edited here and in Premiere", "merge");
        case "behind":
          return step("premiereSync", label, "warn", "Premiere has a newer save", "sync");
        case "edited":
          return step("premiereSync", label, "todo", "Edits here aren't in Premiere yet");
        case "current":
          return step("premiereSync", label, "done", "Matches Premiere's last save");
      }
    })(),

    render === null
      ? facts.hasExport
        ? step("render", "Render check", "todo", "Export not checked", "checkRender")
        : step("render", "Render check", "todo", "No export in Exports yet")
      : render.stale === "timeline"
        ? step("render", "Render check", "warn", "Timeline changed since the check", "checkRender")
        : render.stale === "export"
          ? step("render", "Render check", "warn", "A newer export isn't checked", "checkRender")
          : render.level === "pass"
            ? step("render", "Render check", "done", "Export matches the timeline", "checkRender")
            : step(
                "render",
                "Render check",
                render.level,
                render.level === "fail"
                  ? count(render.problems, "problem")
                  : `${render.problems} to look at`,
                "checkRender",
              ),

    facts.posted === null
      ? step("posted", "Posted", "todo", "Not posted", "markPosted")
      : step(
          "posted",
          "Posted",
          "done",
          facts.posted.urls.length === 0
            ? "No link recorded"
            : count(facts.posted.urls.length, "link"),
          "unmarkPosted",
        ),
  ];
};

/**
 * The one step worth showing when there is room for one: a failure anywhere, else the first
 * step in the run that isn't done. Null when the whole run is done.
 */
export const preflightHeadline = (steps: ReadonlyArray<PreflightStep>): PreflightStep | null =>
  steps.find((step) => step.state === "fail") ??
  steps.find((step) => step.state !== "done") ??
  null;

// The tool an agent moves each step on with.
const ACTION_TOOLS: Record<PreflightAction, string | null> = {
  openScript: "video_script",
  importFootage: "video_footage",
  sync: "video_timeline_read",
  merge: "video_timeline_read",
  transcribe: "video_transcribe",
  linkPremiere: "video_premiere_pull",
  checkRender: "video_render_check",
  markPosted: "video_posted",
  unmarkPosted: null,
};

/** A step as an agent reads it, such as `todo Render check: Export not checked (video_render_check)`. */
export const preflightLine = (step: PreflightStep): string => {
  const tool =
    step.state === "done"
      ? null
      : step.id === "premiereSync" && step.detail.startsWith("Edits here")
        ? "video_premiere_push"
        : step.action === null
          ? null
          : ACTION_TOOLS[step.action];
  return `${step.state} ${step.label}: ${step.detail}${tool === null ? "" : ` (${tool})`}`;
};
