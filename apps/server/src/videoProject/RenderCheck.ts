/**
 * The finish of a video project: checking Premiere's export against the timeline, and recording
 * that the short is posted. The report and contact sheet live in the project folder's `render/`,
 * the posted record in its `project.json`, so every client and agent reads the same thing.
 */
import { type VideoPlatform, VideoPosted, VideoRenderReport } from "@t3tools/contracts";
import { serializeJson, type Timeline } from "@t3tools/timeline/otio";
import { clipFraming, largeSpeedChanges, placedText } from "@t3tools/timeline/framing";
import { PROXY_INDEX_PATH, type ProxyIndex } from "@t3tools/timeline/proxies";
import {
  compareRender,
  contactSheetTiles,
  detectFlashes,
  reportLevel,
  timelineItems,
  timelineRenderFacts,
} from "@t3tools/timeline/renderCheck";
import { safeZoneInsets, safeZoneName } from "@t3tools/timeline/safeZones";
import {
  analyseExport,
  probeExport,
  timelineFingerprint,
  writeContactSheet,
} from "@t3tools/timeline/renderProbe";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** Where Premiere's exports go, inside the media root (the Stellar folder's parent). */
const EXPORTS_FOLDER = "Exports";
const RENDER_REPORT_PATH = "render/report.json";
const CONTACT_SHEET_PATH = "render/contact-sheet.jpg";
const PROJECT_FILE = "project.json";
const EXPORT_FILE = /\.(mp4|mov|m4v)$/i;

export class RenderCheckError extends Schema.TaggedError<RenderCheckError>()("RenderCheckError", {
  reason: Schema.Literals(["no-export", "missing-export", "not-a-video", "tools-failed"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "no-export":
        return `No video in the project's ${EXPORTS_FOLDER} folder to check. Export the sequence from Premiere into it, or name the file.`;
      case "missing-export":
        return "That export file doesn't exist.";
      case "not-a-video":
        return "That file has no picture to check.";
      case "tools-failed":
        return "Could not read the export. Is ffmpeg installed on this machine?";
    }
  }
}

const decodeReport = Schema.decodeUnknownEffect(Schema.fromJsonString(VideoRenderReport));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodePosted = Schema.decodeUnknownOption(VideoPosted);

interface ExportFile {
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: number;
}

const statExport = Effect.fn("VideoProjects.statExport")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const stat = yield* fs.stat(file).pipe(Effect.option);
  if (Option.isNone(stat) || stat.value.type !== "File") return null;
  return {
    path: file,
    size: Number(stat.value.size),
    modifiedAt: Option.match(stat.value.mtime, { onNone: () => 0, onSome: (d) => d.getTime() }),
  } satisfies ExportFile;
});

/** The video most recently written under the project's Exports folder, or null. */
export const newestExport = Effect.fn("VideoProjects.newestExport")(function* (mediaRoot: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = path.join(mediaRoot, EXPORTS_FOLDER);
  const names = yield* fs
    .readDirectory(folder, { recursive: true })
    .pipe(Effect.orElseSucceed((): Array<string> => []));
  let newest: ExportFile | null = null;
  for (const name of names) {
    if (!EXPORT_FILE.test(name) || path.basename(name).startsWith(".")) continue;
    const file = yield* statExport(path.join(folder, name));
    if (file !== null && (newest === null || file.modifiedAt > newest.modifiedAt)) newest = file;
  }
  return newest;
});

export const readRenderReport = Effect.fn("VideoProjects.readRenderReport")(function* (
  projectDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(path.join(projectDir, RENDER_REPORT_PATH)).pipe(
    Effect.flatMap(decodeReport),
    Effect.orElseSucceed(() => null),
  );
});

/**
 * Whether a report still describes the project: `timeline` when the timeline it was checked
 * against has changed, `export` when the file it checked has, or a newer export has arrived.
 */
export const renderStaleness = Effect.fn("VideoProjects.renderStaleness")(function* (
  projectDir: string,
  report: VideoRenderReport,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs
    .readFileString(path.join(projectDir, report.timeline))
    .pipe(Effect.orElseSucceed(() => ""));
  if (timelineFingerprint(text) !== report.timelineHash) return "timeline" as const;
  const checked = yield* statExport(report.exportPath);
  const newest = yield* newestExport(path.dirname(projectDir));
  const changed =
    checked === null ||
    checked.size !== report.exportSize ||
    checked.modifiedAt !== report.exportModifiedAt ||
    (newest !== null && newest.modifiedAt > report.exportModifiedAt);
  return changed ? ("export" as const) : null;
});

/**
 * Compares an export with a timeline, makes its contact sheet, and saves both in the project
 * folder. `exportPath` is absolute or relative to the media root; omitted, the newest export.
 */
export const runRenderCheck = Effect.fn("VideoProjects.runRenderCheck")(function* (input: {
  readonly projectDir: string;
  readonly timelinePath: string;
  readonly timelineText: string;
  readonly timeline: Timeline;
  readonly exportPath: string | undefined;
  readonly platform: VideoPlatform | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mediaRoot = path.dirname(input.projectDir);
  const file =
    input.exportPath === undefined
      ? yield* newestExport(mediaRoot)
      : yield* statExport(path.resolve(mediaRoot, input.exportPath));
  if (file === null) {
    return yield* new RenderCheckError({
      reason: input.exportPath === undefined ? "no-export" : "missing-export",
    });
  }
  const probe = yield* probeExport(file.path).pipe(
    Effect.mapError((cause) => new RenderCheckError({ reason: "tools-failed", cause })),
  );
  if (probe === null) return yield* new RenderCheckError({ reason: "not-a-video" });
  const analysis = yield* analyseExport(file.path, probe).pipe(
    Effect.mapError((cause) => new RenderCheckError({ reason: "tools-failed", cause })),
  );
  const facts = timelineRenderFacts(input.timeline);
  const insets = safeZoneInsets(input.platform);
  // Media sizes come from the preview build; a clip it hasn't measured isn't framed.
  const index = yield* fs.readFileString(path.join(input.projectDir, PROXY_INDEX_PATH)).pipe(
    Effect.flatMap(decodeJson),
    Effect.map((value) => value as ProxyIndex),
    Effect.orElseSucceed(() => null),
  );
  const sizes = new Map(
    Object.entries(index?.media ?? {}).map(([target, entry]) => [
      target,
      { width: entry.width, height: entry.height },
    ]),
  );
  const items = [
    ...compareRender(facts, probe, analysis),
    ...timelineItems({
      rate: facts.rate,
      framing: facts.frame === null ? null : clipFraming(input.timeline, facts.frame, sizes),
      speeds: largeSpeedChanges(input.timeline),
      texts: placedText(
        input.timeline,
        facts.frame ?? { width: probe.width, height: probe.height },
      ),
      insets,
      zonesFor: safeZoneName(input.platform),
    }),
  ];
  const tiles = contactSheetTiles(facts, probe, detectFlashes(analysis.diffs ?? []));
  const sheet = path.join(input.projectDir, CONTACT_SHEET_PATH);
  // The report stands without its picture: a sheet that can't be drawn is left out, not fatal.
  const labelled = yield* writeContactSheet({
    file: file.path,
    output: sheet,
    tiles,
    probe,
    zones: insets,
  }).pipe(
    Effect.tapError((cause) => Effect.logWarning("Contact sheet failed", { cause })),
    Effect.option,
  );
  const report: VideoRenderReport = {
    timeline: input.timelinePath,
    timelineHash: timelineFingerprint(input.timelineText),
    exportPath: file.path,
    exportSize: file.size,
    exportModifiedAt: file.modifiedAt,
    checkedAt: yield* Clock.currentTimeMillis,
    level: reportLevel(items),
    items,
    contactSheet: Option.isSome(labelled) ? sheet : null,
    contactSheetLabelled: Option.getOrElse(labelled, () => false),
    contactSheetTiles: Option.isSome(labelled) ? tiles : [],
  };
  const reportFile = path.join(input.projectDir, RENDER_REPORT_PATH);
  yield* fs.makeDirectory(path.dirname(reportFile), { recursive: true }).pipe(
    Effect.andThen(fs.writeFileString(`${reportFile}.part`, serializeJson(report))),
    Effect.andThen(fs.rename(`${reportFile}.part`, reportFile)),
    Effect.mapError((cause) => new RenderCheckError({ reason: "tools-failed", cause })),
  );
  return report;
});

const readProjectFile = Effect.fn("VideoProjects.readProjectFile")(function* (projectDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.readFileString(path.join(projectDir, PROJECT_FILE)).pipe(
    Effect.flatMap(decodeJson),
    Effect.map((value) =>
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {},
    ),
    Effect.orElseSucceed((): Record<string, unknown> => ({})),
  );
});

/**
 * The posted record, or null. A project whose stage someone set to Posted by hand counts as
 * posted with no date or link on record.
 */
export const readPosted = Effect.fn("VideoProjects.readPosted")(function* (projectDir: string) {
  const file = yield* readProjectFile(projectDir);
  const recorded = decodePosted(file["posted"]);
  if (Option.isSome(recorded)) return recorded.value;
  return file["stage"] === "posted" ? ({ at: 0, urls: [] } satisfies VideoPosted) : null;
});

/**
 * Records that the short is posted, or takes the record back. The stage in the same file
 * follows it, so the stage picker and the record never disagree.
 */
export const writePosted = Effect.fn("VideoProjects.writePosted")(function* (
  projectDir: string,
  posted: VideoPosted | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { posted: _previous, ...file } = yield* readProjectFile(projectDir);
  const next =
    posted !== null
      ? { ...file, stage: "posted", posted }
      : // Taking Posted back returns the project to the stage before it.
        { ...file, ...(file["stage"] === "posted" ? { stage: "polish" } : {}) };
  yield* fs.writeFileString(path.join(projectDir, PROJECT_FILE), serializeJson(next));
});
