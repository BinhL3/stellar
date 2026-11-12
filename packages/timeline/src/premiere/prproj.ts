// @effect-diagnostics nodeBuiltinImport:off -- Pure synchronous gunzip and hashing of an in-memory project.
/**
 * Reads a Premiere `.prproj` (gzipped XML object graph) into an OTIO timeline without Premiere
 * running. Objects reference each other by `ObjectRef`/`ObjectURef`; see `ProjectGraph`.
 *
 * Times in a project are ticks: 254016000000 per second. A sequence's video `FrameRate` and a
 * clip's `MediaFrameRate` are ticks per frame.
 */
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";
import { XMLParser } from "fast-xml-parser";
import {
  type Clip,
  type EffectRef,
  type Gap,
  type Timeline,
  type Track,
  type TrackChild,
  TIMELINE_NAMESPACE,
  rationalTime,
  sortKeys,
  timeRange,
} from "../otio.ts";
import {
  DEFAULT_MARKER_COLOR,
  parsePremiereMarkerComment,
  PREMIERE_MARKER_COLORS,
} from "../markers.ts";
import type { Marker, TimeRange } from "../otio.ts";
import { linearTimeWarp } from "../speed.ts";
import { readTextStyle, type TextStyle, textOfRuns } from "./textStyle.ts";

export const TICKS_PER_SECOND = 254016000000n;
const STILL_EXTENSIONS = /\.(png|jpe?g|heic|tiff?|psd|gif|webp|bmp)$/i;

type XmlValue = string | XmlNode | ReadonlyArray<XmlValue>;
interface XmlNode {
  readonly [key: string]: XmlValue;
}
interface GraphObject {
  readonly tag: string;
  readonly node: XmlNode;
}

const isNode = (value: XmlValue | undefined): value is XmlNode =>
  value !== undefined && typeof value === "object" && !Array.isArray(value);

const list = (value: XmlValue | undefined): ReadonlyArray<XmlValue> =>
  value === undefined || value === "" ? [] : Array.isArray(value) ? value : [value];

const nodes = (value: XmlValue | undefined): ReadonlyArray<XmlNode> => list(value).filter(isNode);

const at = (node: XmlNode | undefined, ...path: ReadonlyArray<string>): XmlNode | undefined => {
  let current: XmlValue | undefined = node;
  for (const key of path) {
    if (!isNode(current)) return undefined;
    const next: XmlValue | undefined = current[key];
    current = Array.isArray(next) ? next[0] : next;
  }
  return isNode(current) ? current : undefined;
};

const text = (node: XmlNode | undefined, ...path: ReadonlyArray<string>): string | undefined => {
  let current: XmlValue | undefined = node;
  for (const key of path) {
    if (!isNode(current)) return undefined;
    const next: XmlValue | undefined = current[key];
    current = Array.isArray(next) ? next[0] : next;
  }
  if (typeof current === "string") return current;
  if (isNode(current) && typeof current["#text"] === "string") return current["#text"];
  return undefined;
};

// Keys and font names that sit beside the words in a Source Text value.
const SOURCE_TEXT_KEYS = new Set(["AnimationType"]);
const POSTSCRIPT_FONT = /^[A-Za-z0-9]+-[A-Za-z0-9]+$/;

/**
 * The words of a text graphic. Premiere keeps them in the Text effect's "Source Text" value, a
 * base64 FlatBuffer whose strings are length-prefixed and null-terminated; the words come after
 * the style keys and the PostScript font name.
 */
const sourceTextWords = (base64: string): string | undefined => {
  const bytes = NodeBuffer.Buffer.from(base64, "base64");
  const found: Array<string> = [];
  for (let i = 0; i + 4 < bytes.length; i++) {
    const length = bytes.readUInt32LE(i);
    const end = i + 4 + length;
    if (length === 0 || length > 4096 || end >= bytes.length || bytes[end] !== 0) continue;
    const value = bytes.subarray(i + 4, end).toString("utf8");
    if (value.includes("\uFFFD") || /[\u0000-\u0008\u000E-\u001F]/.test(value)) continue;
    found.push(value);
    i = end;
  }
  return found.findLast((value) => !SOURCE_TEXT_KEYS.has(value) && !POSTSCRIPT_FONT.test(value));
};

const bigint = (value: string | undefined, fallback: bigint): bigint =>
  value === undefined || value === "" ? fallback : BigInt(value);

const byIndex = (a: XmlNode, b: XmlNode): number =>
  Number(text(a, "@Index") ?? 0) - Number(text(b, "@Index") ?? 0);

class ProjectGraph {
  private readonly byId = new Map<string, GraphObject>();
  private readonly byUid = new Map<string, GraphObject>();

  constructor(root: XmlNode) {
    for (const [tag, value] of Object.entries(root)) {
      if (tag.startsWith("@")) continue;
      for (const node of nodes(value)) {
        const id = text(node, "@ObjectID");
        const uid = text(node, "@ObjectUID");
        if (id !== undefined) this.byId.set(id, { tag, node });
        if (uid !== undefined) this.byUid.set(uid, { tag, node });
      }
    }
  }

  resolve(ref: XmlNode | undefined): GraphObject | undefined {
    if (ref === undefined) return undefined;
    const id = text(ref, "@ObjectRef");
    if (id !== undefined) return this.byId.get(id);
    const uid = text(ref, "@ObjectURef");
    return uid === undefined ? undefined : this.byUid.get(uid);
  }

  sequences(): ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly node: XmlNode;
  }> {
    const out: Array<{ id: string; name: string; node: XmlNode }> = [];
    for (const [uid, object] of this.byUid) {
      const name = text(object.node, "Name");
      if (object.tag === "Sequence" && name !== undefined)
        out.push({ id: uid, name, node: object.node });
    }
    return out;
  }

  /**
   * A component and every object it references, with ids renumbered by first visit. Identical
   * effect stacks on different clips therefore hash the same.
   */
  canonicalSubgraph(root: GraphObject): unknown {
    const order = new Map<string, number>();
    const objects: Array<unknown> = [];
    const keyOf = (object: GraphObject) =>
      text(object.node, "@ObjectID") ?? `u:${text(object.node, "@ObjectUID")}`;
    const visit = (object: GraphObject): number => {
      const key = keyOf(object);
      const seen = order.get(key);
      if (seen !== undefined) return seen;
      const index = objects.length;
      order.set(key, index);
      objects.push(null);
      objects[index] = { tag: object.tag, node: rewrite(object.node) };
      return index;
    };
    const rewrite = (value: XmlValue): unknown => {
      if (typeof value === "string") return value;
      if (Array.isArray(value)) return value.map(rewrite);
      const node = value as XmlNode;
      const target = this.resolve(node);
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        if (key === "@ObjectID" || key === "@ObjectUID") continue;
        if (key === "@ObjectRef" || key === "@ObjectURef") {
          out["@Ref"] = target === undefined ? "missing" : visit(target);
          continue;
        }
        out[key] = rewrite(child);
      }
      return out;
    };
    visit(root);
    return { app: "premiere", objects };
  }
}

export interface ProjectSequence {
  readonly id: string;
  readonly name: string;
}

export interface PulledSequence {
  readonly timeline: Timeline;
  /** Content-addressed native effect blobs, keyed by `sha256:<hex>`. */
  readonly blobs: ReadonlyMap<string, unknown>;
  readonly warnings: ReadonlyArray<string>;
}

export interface PremiereProject {
  readonly sequences: ReadonlyArray<ProjectSequence>;
  readSequence(selector: string, options?: { readonly mediaRoot?: string }): PulledSequence;
}

export const parsePrproj = (bytes: Uint8Array): PremiereProject => {
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  const xml = new TextDecoder().decode(isGzip ? NodeZlib.gunzipSync(bytes) : bytes);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@",
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: true,
    htmlEntities: true,
  });
  const doc = parser.parse(xml) as XmlNode;
  const root = at(doc, "PremiereData");
  if (root === undefined) throw new Error("Not a Premiere project: no <PremiereData> root.");
  const graph = new ProjectGraph(root);
  const sequences = graph.sequences();
  return {
    sequences: sequences.map(({ id, name }) => ({ id, name })),
    readSequence: (selector, options) => {
      const matches = sequences.filter((s) => s.id === selector || s.name === selector);
      const sequence = matches[0];
      if (sequence === undefined) throw new Error(`No sequence named or with id "${selector}".`);
      if (matches.length > 1)
        throw new Error(`Several sequences are named "${selector}"; pass its id.`);
      return readSequence(graph, sequence, options?.mediaRoot);
    },
  };
};

const CROP = "AE.ADBE AECrop";
// Premiere's Transform effect. Presets carry it as Geometry2; one added by script is Geometry.
const TRANSFORM_EFFECTS = new Set(["AE.ADBE Geometry", "AE.ADBE Geometry2"]);
const PORTABLE_EFFECTS = new Set([
  "AE.ADBE Motion",
  "AE.ADBE Opacity",
  CROP,
  "Internal Volume Stereo",
  "Internal Volume Mono",
  "Internal Channel Volume",
]);
const MAPPABLE_EFFECTS = new Set([
  "AE.ADBE Geometry",
  "AE.ADBE Geometry2",
  "AE.ADBE Drop Shadow",
  "AE.ADBE Gaussian Blur 2",
  "AE.ADBE Crop",
  "AE.ADBE Lumetri",
]);

/**
 * Premiere's Blend Mode menu, top to bottom, as the Opacity effect's second "Blend Mode" param
 * indexes it: the menu's five separators take a number each, which is why the list has holes.
 */
const BLEND_MODES: ReadonlyArray<string | null> = [
  "normal",
  "dissolve",
  null,
  "darken",
  "multiply",
  "color-burn",
  "linear-burn",
  "darker-color",
  null,
  "lighten",
  "screen",
  "color-dodge",
  "linear-dodge",
  "lighter-color",
  null,
  "overlay",
  "soft-light",
  "hard-light",
  "vivid-light",
  "linear-light",
  "pin-light",
  "hard-mix",
  null,
  "difference",
  "exclusion",
  "subtract",
  "divide",
  null,
  "hue",
  "saturation",
  "color",
  "luminosity",
];

/** A param is animated when it has keyframes and its stopwatch isn't off; newer saves omit the flag. */
const isAnimated = (param: XmlNode): boolean => {
  const flag = text(param, "IsTimeVarying");
  if (flag !== undefined) return flag === "true";
  return (text(param, "Keyframes") ?? "").includes(",");
};

const effectTier = (matchName: string): EffectRef["tier"] =>
  PORTABLE_EFFECTS.has(matchName)
    ? "portable"
    : MAPPABLE_EFFECTS.has(matchName)
      ? "mappable"
      : "native";

interface ItemRead {
  readonly clip: Clip;
  readonly start: bigint;
  readonly end: bigint;
  readonly storedIndex: number;
}

const readSequence = (
  graph: ProjectGraph,
  sequence: { readonly id: string; readonly name: string; readonly node: XmlNode },
  mediaRoot: string | undefined,
): PulledSequence => {
  const warnings: Array<string> = [];
  const blobs = new Map<string, unknown>();
  const groups = nodes(at(sequence.node, "TrackGroups")?.["TrackGroup"])
    .map((entry) => graph.resolve(at(entry, "Second")))
    .filter((group): group is GraphObject => group !== undefined);

  const videoGroup = groups.find((g) => g.tag === "VideoTrackGroup");
  const ticksPerFrame = bigint(text(videoGroup?.node, "TrackGroup", "FrameRate"), 0n);
  if (ticksPerFrame === 0n) throw new Error(`Sequence "${sequence.name}" has no video frame rate.`);
  const rate = Number(TICKS_PER_SECOND) / Number(ticksPerFrame);
  const [, , width, height] = (text(videoGroup?.node, "FrameRect") ?? "").split(",").map(Number);
  const frame =
    width !== undefined && height !== undefined && width > 0 && height > 0
      ? { width, height }
      : undefined;

  const toFrames = (ticks: bigint, label: string): number => {
    if (ticks % ticksPerFrame !== 0n) {
      warnings.push(
        `${label} is off the frame grid (${Number(ticks) / Number(ticksPerFrame)} frames).`,
      );
    }
    return Number(ticks) / Number(ticksPerFrame);
  };

  const effectRefs = (
    componentsRef: XmlNode | undefined,
    inPoint: bigint,
  ): {
    effects: Array<EffectRef>;
    transform: Record<string, unknown>;
    words: string | undefined;
    textPosition: ReadonlyArray<number> | undefined;
    textStyle: TextStyle | undefined;
    blendMode: string | undefined;
  } => {
    const chain = graph.resolve(componentsRef);
    const effects: Array<EffectRef> = [];
    const transform: Record<string, unknown> = {};
    const keyframes: Record<string, unknown> = {};
    let words: string | undefined;
    let textPosition: ReadonlyArray<number> | undefined;
    let textStyle: TextStyle | undefined;
    let blendMode: string | undefined;
    const components = nodes(
      at(chain?.node, "ComponentChain", "Components")?.["Component"],
    ).toSorted(byIndex);
    for (const entry of components) {
      const component = graph.resolve(entry);
      if (component === undefined) continue;
      const inner =
        at(component.node, "Component") ?? at(component.node, "AudioComponent", "Component");
      const matchName =
        text(component.node, "MatchName") ??
        text(component.node, "FilterMatchName") ??
        component.tag;
      const params = nodes(at(inner, "Params")?.["Param"])
        .toSorted(byIndex)
        .map((p) => graph.resolve(p)?.node)
        .filter((p): p is XmlNode => p !== undefined);
      const animated = params.some(isAnimated);
      const intrinsic = text(inner, "Intrinsic") === "true";
      if (matchName === "AE.ADBE Opacity") {
        // Of the two params named Blend Mode, the menu index is the one with ParameterID 3.
        const menu = params.find(
          (p) => text(p, "Name") === "Blend Mode" && text(p, "ParameterID") === "3",
        );
        const mode = BLEND_MODES[Number(text(menu, "StartKeyframe")?.split(",")[1] ?? 0)];
        if (mode !== undefined && mode !== null && mode !== "normal") blendMode = mode;
      }
      if (matchName === CROP && text(inner, "Bypass") !== "true") {
        // Crop is drawn from these values and also keeps its blob, which has Zoom and feather.
        const { values, keyframes: animatedValues } = intrinsicValues(matchName, params, inPoint);
        Object.assign(transform, values);
        Object.assign(keyframes, animatedValues);
      }
      if (intrinsic) {
        const { values, keyframes: animatedValues } = intrinsicValues(matchName, params, inPoint);
        Object.assign(transform, values);
        Object.assign(keyframes, animatedValues);
        // Animated intrinsics also keep their native blob, which carries the easing.
        if (!animated) continue;
      }
      const bypassed = text(inner, "Bypass") === "true";
      // The portable description the preview draws from; the blob stays the truth for Premiere.
      const effectParams =
        TRANSFORM_EFFECTS.has(matchName) && !bypassed
          ? transformEffectParams(matchName, params, inPoint)
          : undefined;
      const blob = graph.canonicalSubgraph(component);
      const ref = `sha256:${NodeCrypto.createHash("sha256")
        .update(JSON.stringify(sortKeys(blob)))
        .digest("hex")}` as const;
      blobs.set(ref, blob);
      const kind = text(inner, "DisplayName") ?? matchName;
      if (matchName === "AE.ADBE Text") {
        const source = params.find((p) => text(p, "Name") === "Source Text");
        const value = text(source, "StartKeyframeValue");
        const style = value === undefined || words !== undefined ? undefined : readTextStyle(value);
        if (style !== undefined) {
          const scale = Number(
            text(
              params.find((p) => text(p, "Name") === "Scale"),
              "StartKeyframe",
            )?.split(",")[1] ?? 100,
          );
          textStyle = scale === 100 || !Number.isFinite(scale) ? style : { ...style, scale };
        }
        words ??=
          style !== undefined
            ? textOfRuns(style)
            : value === undefined
              ? undefined
              : sourceTextWords(value);
        const position = text(
          params.find((p) => text(p, "Name") === "Position"),
          "StartKeyframe",
        )?.split(",")[1];
        textPosition ??= position?.includes(":") ? position.split(":").map(Number) : undefined;
      }
      effects.push({
        ref,
        app: "premiere",
        kind,
        label: text(inner, "InstanceName") ?? kind,
        tier: effectTier(matchName),
        matchName,
        animated,
        ...(bypassed ? { bypassed } : {}),
        ...(effectParams === undefined ? {} : { params: effectParams }),
      });
    }
    if (Object.keys(keyframes).length > 0) transform["keyframes"] = keyframes;
    return { effects, transform, words, textPosition, textStyle, blendMode };
  };

  const readItem = (
    object: GraphObject,
    storedIndex: number,
    trackLabel: string,
  ): ItemRead | undefined => {
    const clipTrackItem = at(object.node, "ClipTrackItem");
    const trackItem = at(clipTrackItem, "TrackItem");
    const start = bigint(text(trackItem, "Start"), 0n);
    const end = bigint(text(trackItem, "End"), 0n);
    const subClip = graph.resolve(at(clipTrackItem, "SubClip"));
    const clipObject = graph.resolve(at(subClip?.node, "Clip"));
    const clipNode = at(clipObject?.node, "Clip");
    const media = graph.resolve(
      at(graph.resolve(at(clipNode, "Source"))?.node, "MediaSource", "Media"),
    );
    const master = graph.resolve(at(subClip?.node, "MasterClip"));
    const logging = graph.resolve(at(master?.node, "LoggingInfo"));
    const sourceTicksPerFrame = bigint(text(logging?.node, "MediaFrameRate"), ticksPerFrame);
    const sourceRate = Number(TICKS_PER_SECOND) / Number(sourceTicksPerFrame);
    const name = text(subClip?.node, "Name") ?? "untitled";
    const nodeIdDecimal = text(trackItem, "Node", "ID") ?? "";
    const label = `${trackLabel} ${name}`;
    if (clipNode === undefined) {
      warnings.push(`${label}: clip data missing; skipped.`);
      return undefined;
    }
    const inPoint = bigint(text(clipNode, "InPoint"), 0n);
    const outPoint = bigint(text(clipNode, "OutPoint"), inPoint);
    const rawPath = text(media?.node, "ActualMediaFilePath") ?? text(media?.node, "FilePath") ?? "";
    // Graphics and other synthetic media store an id where a file path would be.
    const syntheticId = /[\\/]/.test(rawPath) ? undefined : rawPath;
    const path = syntheticId === undefined ? rawPath : "";
    // Stills and graphics sit at an arbitrary timecode (01:00:00;00), so only their length means
    // anything; the raw ticks stay in `metadata.premiere.sourceTicks` for push.
    const still = path === "" || STILL_EXTENSIONS.test(path);
    const mediaStart = still ? inPoint : bigint(text(logging?.node, "MediaInPoint"), 0n);
    const { effects, transform, words, textPosition, textStyle, blendMode } = effectRefs(
      at(clipTrackItem, "ComponentOwner", "Components"),
      inPoint,
    );
    const sourceStart = Number(inPoint - mediaStart) / Number(sourceTicksPerFrame);
    // A clip's OutPoint can stay at the media's end after a tail trim; the played length is the
    // record length, and the media it covers is that length times the speed.
    const sourceDuration = Number(end - start) / Number(sourceTicksPerFrame);
    // InPoint stays the lowest source time whatever the speed. Reverse was not in any project
    // read so far: a negative speed or a PlayBackwards flag are both taken to mean it.
    const playbackSpeed = Number(text(clipNode, "PlaybackSpeed") ?? 1);
    const backwards = text(clipNode, "PlayBackwards") === "true";
    const speed =
      !Number.isFinite(playbackSpeed) || playbackSpeed === 0 || still
        ? 1
        : (Math.round(Math.abs(playbackSpeed) * 1e6) / 1e6) *
          (backwards || playbackSpeed < 0 ? -1 : 1);
    const clip: Clip = {
      OTIO_SCHEMA: "Clip.2",
      name,
      source_range: timeRange(sourceStart, sourceDuration, sourceRate),
      ...(speed === 1 ? {} : { effects: [linearTimeWarp(speed)] }),
      media_references: {
        DEFAULT_MEDIA: {
          OTIO_SCHEMA: "ExternalReference.1",
          target_url: relativeToRoot(path, mediaRoot),
          metadata: {},
        },
      },
      active_media_reference_key: "DEFAULT_MEDIA",
      enabled: true,
      metadata: {
        [TIMELINE_NAMESPACE]: {
          ...(words === undefined ? {} : { text: words }),
          // Where the text layer's anchor sits, as a fraction of the frame.
          ...(textPosition === undefined ? {} : { textPosition }),
          ...(textStyle === undefined ? {} : { textStyle }),
          ...(blendMode === undefined ? {} : { blendMode }),
          ...(Object.keys(transform).length > 0 ? { transform } : {}),
          ...(effects.length > 0 ? { effects } : {}),
        },
        premiere: {
          ...(syntheticId === undefined ? {} : { syntheticMediaId: syntheticId }),
          nodeId: nodeIdDecimal === "" ? null : Number(nodeIdDecimal).toString(16).padStart(8, "0"),
          sourceTicks: { in: inPoint.toString(), out: outPoint.toString() },
        },
      },
    };
    const markers = still
      ? []
      : clipMarkers(graph, clipNode, {
          mediaStart,
          ticksPerFrame: sourceTicksPerFrame,
          rate: sourceRate,
          from: sourceStart,
          to: sourceStart + sourceDuration * Math.abs(speed),
        });
    return {
      clip: markers.length === 0 ? clip : { ...clip, markers },
      start,
      end,
      storedIndex,
    };
  };

  /**
   * A caption track as a video track of text clips above the picture, so captions show in the
   * timeline and the preview like any text. `metadata.stellar.captions` marks it: Premiere
   * keeps captions apart from its video tracks, so it has no V number there.
   */
  const captionTrack = (trackObject: GraphObject, trackLabel: string): Track | undefined => {
    const items = nodes(
      at(trackObject.node, "DataClipTrack", "ClipTrack", "ClipItems", "TrackItems")?.["TrackItem"],
    )
      .map((entry) => graph.resolve(entry)?.node)
      .filter((item): item is XmlNode => item !== undefined)
      .map((item) => {
        const trackItem = at(item, "DataClipTrackItem", "ClipTrackItem", "TrackItem");
        const styles = nodes(at(item, "BlockVector")?.["BlockVectorItem"])
          .toSorted(byIndex)
          .map((block) => text(graph.resolve(block)?.node, "FormattedTextData"))
          .flatMap((data) => (data === undefined ? [] : (readTextStyle(data) ?? [])));
        return {
          start: bigint(text(trackItem, "Start"), 0n),
          end: bigint(text(trackItem, "End"), 0n),
          nodeId: text(trackItem, "Node", "ID") ?? "",
          styles,
        };
      })
      .filter((item) => item.end > item.start && item.styles.length > 0)
      .toSorted((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    if (items.length === 0) return undefined;
    const children: Array<TrackChild> = [];
    let cursor = 0n;
    for (const item of items) {
      if (item.start < cursor) {
        warnings.push(
          `${trackLabel} caption at frame ${toFrames(item.start, "")} overlaps the previous one; skipped.`,
        );
        continue;
      }
      if (item.start > cursor) {
        children.push(gap(toFrames(item.start - cursor, `${trackLabel} gap`), rate));
      }
      const [first, ...rest] = item.styles;
      if (first === undefined) continue;
      // A caption's blocks are its lines.
      const style: TextStyle = {
        ...first,
        runs: [
          ...first.runs,
          ...rest.flatMap((block) => [{ ...block.runs[0], text: "\r" }, ...block.runs]),
        ],
      };
      const words = textOfRuns(style);
      const startFrame = toFrames(item.start, `${trackLabel} caption start`);
      const endFrame = toFrames(item.end, `${trackLabel} caption end`);
      children.push({
        OTIO_SCHEMA: "Clip.2",
        name: words.replace(/\s+/g, " ").slice(0, 60),
        source_range: timeRange(0, endFrame - startFrame, rate),
        media_references: {
          DEFAULT_MEDIA: { OTIO_SCHEMA: "ExternalReference.1", target_url: "", metadata: {} },
        },
        active_media_reference_key: "DEFAULT_MEDIA",
        enabled: true,
        metadata: {
          [TIMELINE_NAMESPACE]: { caption: true, text: words, textStyle: style },
          premiere: {
            nodeId: item.nodeId === "" ? null : Number(item.nodeId).toString(16).padStart(8, "0"),
            record: { startFrame, endFrame },
          },
        },
      });
      cursor = item.end;
    }
    return {
      OTIO_SCHEMA: "Track.1",
      name: trackLabel,
      kind: "Video",
      children,
      enabled: true,
      metadata: { [TIMELINE_NAMESPACE]: { captions: true } },
    };
  };

  const tracks: Array<Track> = [];
  const captionTracks: Array<Track> = [];
  for (const group of groups) {
    const kind =
      group.tag === "VideoTrackGroup" ? "Video" : group.tag === "AudioTrackGroup" ? "Audio" : null;
    const trackEntries = nodes(at(group.node, "TrackGroup", "Tracks")?.["Track"]).toSorted(byIndex);
    if (kind === null) {
      trackEntries.forEach((entry, trackIndex) => {
        const trackObject = graph.resolve(entry);
        if (trackObject?.tag !== "CaptionDataClipTrack") {
          warnings.push(`${group.tag}: a ${trackObject?.tag ?? "missing"} track was not read.`);
          return;
        }
        const captions = captionTrack(trackObject, `C${trackIndex + 1}`);
        if (captions !== undefined) captionTracks.push(captions);
      });
      continue;
    }
    trackEntries.forEach((entry, trackIndex) => {
      const trackObject = graph.resolve(entry);
      const clipTrack = at(trackObject?.node, "ClipTrack");
      const trackLabel = `${kind === "Video" ? "V" : "A"}${trackIndex + 1}`;
      const items = nodes(at(clipTrack, "ClipItems", "TrackItems")?.["TrackItem"])
        .toSorted(byIndex)
        .map((itemEntry, storedIndex) => {
          const object = graph.resolve(itemEntry);
          return object === undefined ? undefined : readItem(object, storedIndex, trackLabel);
        })
        .filter((item): item is ItemRead => item !== undefined);

      let latestStart = -1n;
      for (const item of items) {
        if (item.start < latestStart) {
          warnings.push(
            `${trackLabel} ${item.clip.name} at frame ${toFrames(item.start, "")} is stored out of time order; Premiere's export can drop it.`,
          );
        }
        if (item.start > latestStart) latestStart = item.start;
      }

      const children: Array<TrackChild> = [];
      let cursor = 0n;
      for (const item of items.toSorted((a, b) =>
        a.start < b.start ? -1 : a.start > b.start ? 1 : 0,
      )) {
        if (item.start < cursor) {
          warnings.push(`${trackLabel} ${item.clip.name} overlaps the previous item.`);
        } else if (item.start > cursor) {
          children.push(gap(toFrames(item.start - cursor, `${trackLabel} gap`), rate));
        }
        const startFrame = toFrames(item.start, `${trackLabel} ${item.clip.name} start`);
        const endFrame = toFrames(item.end, `${trackLabel} ${item.clip.name} end`);
        children.push({
          ...item.clip,
          metadata: {
            ...item.clip.metadata,
            premiere: {
              ...(item.clip.metadata["premiere"] as Record<string, unknown>),
              record: { startFrame, endFrame },
            },
          },
        });
        cursor = item.end > cursor ? item.end : cursor;
      }

      const transitions = nodes(at(clipTrack, "TransitionItems", "TrackItems")?.["TrackItem"])
        .map((t) => graph.resolve(t)?.node)
        .filter((t): t is XmlNode => t !== undefined)
        .map((t) => {
          const transitionItem = at(t, "TransitionTrackItem");
          const startTicks = bigint(text(transitionItem, "TrackItem", "Start"), 0n);
          const matchName = text(transitionItem, "MatchName");
          const alignment = text(transitionItem, "Alignment");
          return {
            name:
              text(transitionItem, "DisplayName") ??
              text(transitionItem, "MatchName") ??
              "transition",
            startFrame: Number(startTicks) / Number(ticksPerFrame),
            endFrame:
              Number(bigint(text(transitionItem, "TrackItem", "End"), 0n)) / Number(ticksPerFrame),
            ...(matchName === undefined ? {} : { matchName }),
            // Alignment is how far into the transition the cut sits.
            ...(alignment === undefined
              ? {}
              : { cutFrame: Number(startTicks + bigint(alignment, 0n)) / Number(ticksPerFrame) }),
            ...(text(transitionItem, "HasOutgoingClip") === "false" ? { outgoing: false } : {}),
            ...(text(transitionItem, "HasIncomingClip") === "false" ? { incoming: false } : {}),
          };
        });

      tracks.push({
        OTIO_SCHEMA: "Track.1",
        name: trackLabel,
        kind,
        children,
        enabled: true,
        metadata: transitions.length > 0 ? { premiere: { transitions } } : {},
      });
    });
  }

  // Captions go after the last video track, so they draw on top and V numbers keep their meaning.
  const lastVideo = tracks.findLastIndex((track) => track.kind === "Video");
  tracks.splice(lastVideo + 1, 0, ...captionTracks);

  const timeline: Timeline = {
    OTIO_SCHEMA: "Timeline.1",
    name: sequence.name,
    global_start_time: rationalTime(0, rate),
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      children: tracks,
      ...sequenceMarkers(graph, sequence.node, ticksPerFrame, rate),
      enabled: true,
      metadata: {},
    },
    metadata: {
      [TIMELINE_NAMESPACE]: {
        rate,
        ...(frame === undefined ? {} : { frame }),
        ...(mediaRoot === undefined ? {} : { mediaRoot }),
      },
      premiere: { sequenceId: sequence.id, ticksPerFrame: ticksPerFrame.toString() },
    },
  };
  return { timeline, blobs, warnings };
};

/** A marker as Premiere stores it: a JSON object in a `Marker` its owner's `Markers` lists. */
interface PremiereMarker {
  readonly id: string;
  readonly start: bigint;
  readonly duration: bigint;
  readonly name: string;
  readonly comment: string;
  readonly colorIndex: number | undefined;
  readonly type: string;
}

const tickCount = (value: unknown): bigint => {
  const ticks = (value as { ticks?: unknown } | undefined)?.ticks;
  return typeof ticks === "number" && Number.isFinite(ticks) ? BigInt(Math.round(ticks)) : 0n;
};

/**
 * The markers of a sequence or a clip: `MarkerOwner` points at a `Markers` object that lists
 * `Marker` objects, each holding `{"DVAMarker": {...}}`. Premiere leaves out fields at their
 * defaults, so a plain marker has only an id, a start and a type.
 */
const readMarkers = (
  graph: ProjectGraph,
  owner: XmlNode | undefined,
): ReadonlyArray<PremiereMarker> => {
  const listed = graph.resolve(at(owner, "MarkerOwner", "Markers"));
  const out: Array<PremiereMarker> = [];
  for (const entry of nodes(at(listed?.node, "Markers")?.["Marker"]).toSorted(byIndex)) {
    const json = text(graph.resolve(at(entry, "Second"))?.node, "DVAMarker");
    if (json === undefined) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      continue;
    }
    const marker = (parsed as { DVAMarker?: Record<string, unknown> } | null)?.DVAMarker;
    if (marker === undefined || marker === null) continue;
    const string = (key: string) => (typeof marker[key] === "string" ? marker[key] : "");
    out.push({
      id: string("mMarkerID") || text(entry, "First") || `index-${out.length}`,
      start: tickCount(marker["mStartTime"]),
      duration: tickCount(marker["mDuration"]),
      name: string("mName"),
      comment: string("mComment"),
      colorIndex: typeof marker["mColorIndex"] === "number" ? marker["mColorIndex"] : undefined,
      type: string("mType") || "Comment",
    });
  }
  return out;
};

/** Ids agents can type: the first eight characters of Premiere's, or all of it on a clash. */
const markerIds = (markers: ReadonlyArray<PremiereMarker>): ReadonlyArray<string> => {
  const short = markers.map((marker) => marker.id.slice(0, 8));
  return markers.map((marker, index) =>
    short.indexOf(short[index] ?? "") === short.lastIndexOf(short[index] ?? "")
      ? (short[index] ?? marker.id)
      : marker.id,
  );
};

const otioMarker = (marker: PremiereMarker, id: string, range: TimeRange): Marker => {
  const { note, author, resolved } = parsePremiereMarkerComment(marker.comment);
  return {
    OTIO_SCHEMA: "Marker.2",
    name: marker.name,
    color: PREMIERE_MARKER_COLORS[marker.colorIndex ?? 0] ?? DEFAULT_MARKER_COLOR,
    comment: note,
    marked_range: range,
    metadata: {
      [TIMELINE_NAMESPACE]: { id, author, ...(resolved ? { resolved: true } : {}) },
      premiere: {
        markerId: marker.id,
        ...(marker.type === "Comment" ? {} : { type: marker.type }),
      },
    },
  };
};

/** Sequence markers for the stack, in timeline frames; nothing when the sequence has none. */
const sequenceMarkers = (
  graph: ProjectGraph,
  sequence: XmlNode,
  ticksPerFrame: bigint,
  rate: number,
): { readonly markers?: ReadonlyArray<Marker> } => {
  const read = readMarkers(graph, sequence);
  if (read.length === 0) return {};
  const ids = markerIds(read);
  const frames = (ticks: bigint) => Math.round(Number(ticks) / Number(ticksPerFrame));
  return {
    markers: read
      .map((marker, index) =>
        otioMarker(
          marker,
          ids[index] ?? marker.id,
          timeRange(frames(marker.start), frames(marker.duration), rate),
        ),
      )
      .toSorted((a, b) => a.marked_range.start_time.value - b.marked_range.start_time.value),
  };
};

/**
 * A clip's markers that fall on the media it plays, in media frames like its source range.
 * Premiere keeps them on the source clip, shared by every piece cut from it, so the ones
 * outside this piece are left to the pieces they fall on.
 */
const clipMarkers = (
  graph: ProjectGraph,
  clipNode: XmlNode,
  source: {
    readonly mediaStart: bigint;
    readonly ticksPerFrame: bigint;
    readonly rate: number;
    readonly from: number;
    readonly to: number;
  },
): ReadonlyArray<Marker> => {
  const read = readMarkers(graph, clipNode);
  if (read.length === 0) return [];
  const ids = markerIds(read);
  const frames = (ticks: bigint) => Number(ticks) / Number(source.ticksPerFrame);
  return read.flatMap((marker, index) => {
    const at = Math.round(frames(marker.start - source.mediaStart) * 1000) / 1000;
    if (at < source.from || at >= source.to) return [];
    return [
      otioMarker(
        marker,
        ids[index] ?? marker.id,
        timeRange(at, Math.round(frames(marker.duration) * 1000) / 1000, source.rate),
      ),
    ];
  });
};

const gap = (frames: number, rate: number): Gap => ({
  OTIO_SCHEMA: "Gap.1",
  name: "",
  source_range: timeRange(0, frames, rate),
  enabled: true,
  metadata: {},
});

const relativeToRoot = (path: string, mediaRoot: string | undefined): string => {
  if (mediaRoot === undefined || path === "") return path;
  const root = mediaRoot.endsWith("/") ? mediaRoot : `${mediaRoot}/`;
  return path.startsWith(root) ? path.slice(root.length) : path;
};

const MOTION_DEFAULTS: Record<string, string> = {
  Position: "0.5:0.5",
  Scale: "100",
  "Scale Width": "100",
  Rotation: "0",
  "Anchor Point": "0.5:0.5",
  Opacity: "100",
};

type IntrinsicValue = number | ReadonlyArray<number>;

// The Transform effect's params by ParameterID. Names are no guide: the checkboxes have none,
// and 3 and 4 are "Scale" and blank or "Scale Height" and "Scale Width" by how it was saved.
const TRANSFORM_PARAMS: Readonly<Record<string, readonly [key: string, initial: string]>> = {
  "1": ["anchor_point", "0.5:0.5"],
  "2": ["position", "0.5:0.5"],
  "3": ["scale", "100"],
  "4": ["scale_width", "100"],
  "5": ["skew", "0"],
  "6": ["skew_axis", "0"],
  "7": ["rotation", "0"],
  "8": ["opacity", "100"],
  "9": ["composition_shutter", "true"],
  "10": ["shutter_angle", "0"],
  "11": ["uniform_scale", "true"],
};
const TRANSFORM_PARAM_IDS: Readonly<Record<string, string>> = {
  "Anchor Point": "1",
  Position: "2",
  Scale: "3",
  "Scale Height": "3",
  "Scale Width": "4",
  Skew: "5",
  "Skew Axis": "6",
  Rotation: "7",
  Opacity: "8",
  "Shutter Angle": "10",
};

/** The Motion, Opacity and Volume param an intrinsic param maps to, with Premiere's raw value parsed. */
const intrinsicParam = (
  matchName: string,
  name: string,
  raw: string,
  parameterId?: string,
): { readonly key: string; readonly value: IntrinsicValue; readonly isDefault: boolean } | null => {
  const value = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  if (TRANSFORM_EFFECTS.has(matchName)) {
    const known = TRANSFORM_PARAMS[parameterId ?? TRANSFORM_PARAM_IDS[name] ?? ""];
    if (known === undefined) return null;
    const [key, initial] = known;
    return {
      key,
      value: value.includes(":")
        ? value.split(":").map(Number)
        : value === "true" || value === "false"
          ? Number(value === "true")
          : Number(value),
      isDefault: value === initial,
    };
  }
  if (matchName === "AE.ADBE Motion" && name in MOTION_DEFAULTS) {
    return {
      key: name.toLowerCase().replaceAll(" ", "_"),
      value: value.includes(":") ? value.split(":").map(Number) : Number(value),
      isDefault: value === MOTION_DEFAULTS[name],
    };
  }
  if (matchName === CROP && ["Left", "Top", "Right", "Bottom"].includes(name)) {
    // Percent of the picture taken off that edge.
    return {
      key: `crop_${name.toLowerCase()}`,
      value: Number(value),
      isDefault: Number(value) === 0,
    };
  }
  if (matchName === "AE.ADBE Opacity" && name === "Opacity") {
    return { key: "opacity", value: Number(value), isDefault: value === "100" };
  }
  if (matchName.startsWith("Internal") && name === "Level") {
    // Premiere stores Level as linear amplitude with 0 dB at 10^(-15/20).
    const db = Math.round((20 * Math.log10(Number(value)) + 15) * 10) / 10;
    return { key: "gain_db", value: db, isDefault: db === 0 };
  }
  return null;
};

/** How a keyframe leaves for the next one: held, or a cubic bezier as CSS writes it. */
type Easing = "hold" | readonly [number, number, number, number];
type KeyframePoint = readonly [number, IntrinsicValue] | readonly [number, IntrinsicValue, Easing];

// Premiere's interpolation modes: 0 is linear, 4 hold, 5 bezier (which the ease presets write).
const HOLD = "4";
const BEZIER = "5";

/**
 * The easing between two keyframes, undefined for linear. Premiere stores each key's speed in
 * and out (units a second) and its "influence", how far along the stretch that speed holds.
 */
// A linear key's stored speed can be stale, so only a bezier key's is used. A point's speed is
// along its path, taken as straight, which it can't overshoot; a number is kept near its values.
const easingBetween = (
  from: { readonly fields: ReadonlyArray<string>; readonly raw: IntrinsicValue },
  to: { readonly fields: ReadonlyArray<string>; readonly raw: IntrinsicValue },
  seconds: number,
): Easing | undefined => {
  if (from.fields[2] === HOLD) return "hold";
  const [start, target] = [from.raw, to.raw];
  const distance =
    typeof start === "number" || typeof target === "number"
      ? Number(target) - Number(start)
      : Math.hypot(...start.map((value, index) => (target[index] ?? value) - value));
  const [outSpeed, outInfluence] = [Number(from.fields[6]), Number(from.fields[7])];
  const [inSpeed, inInfluence] = [Number(to.fields[4]), Number(to.fields[5])];
  const eased = (fields: ReadonlyArray<string>) => fields[2] === BEZIER;
  if (!eased(from.fields) && !eased(to.fields)) return undefined;
  if (distance === 0 || seconds <= 0) return undefined;
  if (![outSpeed, outInfluence, inSpeed, inInfluence].every(Number.isFinite)) return undefined;
  const isPoint = typeof from.raw !== "number";
  const round = (value: number) => {
    const bounded = Math.min(isPoint ? 1 : 3, Math.max(isPoint ? 0 : -2, value));
    return Math.round(bounded * 1e4) / 1e4;
  };
  const x1 = Math.min(1, Math.max(0, outInfluence));
  const x2 = Math.min(1, Math.max(0, 1 - inInfluence));
  const curve = [
    round(x1),
    round(eased(from.fields) ? (outSpeed * outInfluence * seconds) / distance : x1),
    round(x2),
    round(eased(to.fields) ? 1 - (inSpeed * inInfluence * seconds) / distance : x2),
  ] as const;
  const linear = Math.abs(curve[1] - curve[0]) < 0.002 && Math.abs(curve[3] - curve[2]) < 0.002;
  return linear ? undefined : curve;
};

/**
 * Non-default static values of Motion, Opacity, Crop and Volume, plus `keyframes` for animated
 * ones as [seconds from the clip's start, value] points, with a third entry where the stretch
 * to the next point is eased or held. Keyframe times are media ticks, like `InPoint`.
 */
const intrinsicValues = (
  matchName: string,
  params: ReadonlyArray<XmlNode>,
  inPoint: bigint,
): {
  readonly values: Record<string, IntrinsicValue>;
  readonly keyframes: Record<string, ReadonlyArray<KeyframePoint>>;
} => {
  const out: Record<string, IntrinsicValue> = {};
  const keyframes: Record<string, Array<KeyframePoint>> = {};
  for (const param of params) {
    const name = text(param, "Name") ?? "";
    const parameterId = text(param, "ParameterID");
    if (isAnimated(param)) {
      const points = (text(param, "Keyframes") ?? "")
        .split(";")
        .map((entry) => entry.split(","))
        .filter((fields) => fields.length >= 2 && fields[0] !== "");
      const parsed = points.flatMap((fields) => {
        const [time = "0", raw = ""] = fields;
        const point = intrinsicParam(matchName, name, raw, parameterId);
        if (point === null) return [];
        const seconds = Number(BigInt(time) - inPoint) / Number(TICKS_PER_SECOND);
        // Speeds are in Premiere's own units: for Level that is amplitude, not the dB kept here.
        const plain = raw.endsWith(".") ? raw.slice(0, -1) : raw;
        const rawValue: IntrinsicValue = plain.includes(":")
          ? plain.split(":").map(Number)
          : Number(plain);
        return [{ key: point.key, seconds, value: point.value, fields, raw: rawValue }];
      });
      const first = parsed[0];
      if (first !== undefined) {
        keyframes[first.key] = parsed.map((entry, index): KeyframePoint => {
          const next = parsed[index + 1];
          const at = Math.round(entry.seconds * 1e4) / 1e4;
          const easing =
            next === undefined
              ? undefined
              : easingBetween(entry, next, next.seconds - entry.seconds);
          return easing === undefined ? [at, entry.value] : [at, entry.value, easing];
        });
      }
      continue;
    }
    const raw = text(param, "StartKeyframe")?.split(",")[1];
    const value = raw === undefined ? null : intrinsicParam(matchName, name, raw, parameterId);
    if (value !== null && !value.isDefault) out[value.key] = value.value;
  }
  return { values: out, keyframes };
};

/**
 * One Transform effect's non-default values, keyframes shaped as Motion's. Points are fractions
 * of the layer; `scale` is both axes unless `uniform_scale` is false, when it is the height.
 * `shutter_angle` stays whatever "Use Composition's Shutter Angle" says: a real export of a
 * preset saved with the box ticked and 360° is blurred at 360°.
 */
const transformEffectParams = (
  matchName: string,
  params: ReadonlyArray<XmlNode>,
  inPoint: bigint,
): Record<string, unknown> => {
  const { values, keyframes } = intrinsicValues(matchName, params, inPoint);
  const { composition_shutter: _, uniform_scale, ...out }: Record<string, unknown> = values;
  const animated: Record<string, unknown> = { ...keyframes };
  if (uniform_scale === 0) out["uniform_scale"] = false;
  else {
    delete out["scale_width"];
    delete animated["scale_width"];
  }
  delete animated["composition_shutter"];
  delete animated["uniform_scale"];
  delete animated["shutter_angle"];
  if (Object.keys(animated).length > 0) out["keyframes"] = animated;
  return out;
};
