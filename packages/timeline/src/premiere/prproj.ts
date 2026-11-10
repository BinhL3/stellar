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

const PORTABLE_EFFECTS = new Set([
  "AE.ADBE Motion",
  "AE.ADBE Opacity",
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
  } => {
    const chain = graph.resolve(componentsRef);
    const effects: Array<EffectRef> = [];
    const transform: Record<string, unknown> = {};
    const keyframes: Record<string, unknown> = {};
    let words: string | undefined;
    let textPosition: ReadonlyArray<number> | undefined;
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
      const animated = params.some((p) => text(p, "IsTimeVarying") === "true");
      const intrinsic = text(inner, "Intrinsic") === "true";
      if (intrinsic) {
        const { values, keyframes: animatedValues } = intrinsicValues(matchName, params, inPoint);
        Object.assign(transform, values);
        Object.assign(keyframes, animatedValues);
        // Animated intrinsics also keep their native blob, which carries the easing.
        if (!animated) continue;
      }
      const blob = graph.canonicalSubgraph(component);
      const ref = `sha256:${NodeCrypto.createHash("sha256")
        .update(JSON.stringify(sortKeys(blob)))
        .digest("hex")}` as const;
      blobs.set(ref, blob);
      const kind = text(inner, "DisplayName") ?? matchName;
      if (matchName === "AE.ADBE Text") {
        const source = params.find((p) => text(p, "Name") === "Source Text");
        const value = text(source, "StartKeyframeValue");
        words ??= value === undefined ? undefined : sourceTextWords(value);
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
      });
    }
    if (Object.keys(keyframes).length > 0) transform["keyframes"] = keyframes;
    return { effects, transform, words, textPosition };
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
    const { effects, transform, words, textPosition } = effectRefs(
      at(clipTrackItem, "ComponentOwner", "Components"),
      inPoint,
    );
    const sourceStart = Number(inPoint - mediaStart) / Number(sourceTicksPerFrame);
    // A clip's OutPoint can stay at the media's end after a tail trim; the played length is the
    // record length (speed changes are not read yet).
    const sourceDuration = Number(end - start) / Number(sourceTicksPerFrame);
    const clip: Clip = {
      OTIO_SCHEMA: "Clip.2",
      name,
      source_range: timeRange(sourceStart, sourceDuration, sourceRate),
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
    return { clip, start, end, storedIndex };
  };

  const tracks: Array<Track> = [];
  for (const group of groups) {
    const kind =
      group.tag === "VideoTrackGroup" ? "Video" : group.tag === "AudioTrackGroup" ? "Audio" : null;
    const trackEntries = nodes(at(group.node, "TrackGroup", "Tracks")?.["Track"]).toSorted(byIndex);
    if (kind === null) {
      if (trackEntries.length > 0)
        warnings.push(`${group.tag}: ${trackEntries.length} track(s) not read yet (captions).`);
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
          return {
            name:
              text(transitionItem, "DisplayName") ??
              text(transitionItem, "MatchName") ??
              "transition",
            startFrame:
              Number(bigint(text(transitionItem, "TrackItem", "Start"), 0n)) /
              Number(ticksPerFrame),
            endFrame:
              Number(bigint(text(transitionItem, "TrackItem", "End"), 0n)) / Number(ticksPerFrame),
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

  const timeline: Timeline = {
    OTIO_SCHEMA: "Timeline.1",
    name: sequence.name,
    global_start_time: rationalTime(0, rate),
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      children: tracks,
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

/** The Motion, Opacity and Volume param an intrinsic param maps to, with Premiere's raw value parsed. */
const intrinsicParam = (
  matchName: string,
  name: string,
  raw: string,
): { readonly key: string; readonly value: IntrinsicValue; readonly isDefault: boolean } | null => {
  const value = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  if (matchName === "AE.ADBE Motion" && name in MOTION_DEFAULTS) {
    return {
      key: name.toLowerCase().replaceAll(" ", "_"),
      value: value.includes(":") ? value.split(":").map(Number) : Number(value),
      isDefault: value === MOTION_DEFAULTS[name],
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

/**
 * Non-default static values of Motion, Opacity and Volume, plus `keyframes` for animated ones as
 * [seconds from the clip's start, value] pairs. Keyframe times are media ticks, like `InPoint`.
 */
const intrinsicValues = (
  matchName: string,
  params: ReadonlyArray<XmlNode>,
  inPoint: bigint,
): {
  readonly values: Record<string, IntrinsicValue>;
  readonly keyframes: Record<string, ReadonlyArray<readonly [number, IntrinsicValue]>>;
} => {
  const out: Record<string, IntrinsicValue> = {};
  const keyframes: Record<string, Array<readonly [number, IntrinsicValue]>> = {};
  for (const param of params) {
    const name = text(param, "Name");
    if (name === undefined) continue;
    if (text(param, "IsTimeVarying") === "true") {
      const points = (text(param, "Keyframes") ?? "")
        .split(";")
        .map((entry) => entry.split(","))
        .filter((fields) => fields.length >= 2 && fields[0] !== "");
      const parsed = points.flatMap(([time = "0", raw = ""]) => {
        const point = intrinsicParam(matchName, name, raw);
        if (point === null) return [];
        const seconds = Number(BigInt(time) - inPoint) / Number(TICKS_PER_SECOND);
        return [{ key: point.key, point: [Math.round(seconds * 1e4) / 1e4, point.value] as const }];
      });
      const first = parsed[0];
      if (first !== undefined) keyframes[first.key] = parsed.map((entry) => entry.point);
      continue;
    }
    const raw = text(param, "StartKeyframe")?.split(",")[1];
    const value = raw === undefined ? null : intrinsicParam(matchName, name, raw);
    if (value !== null && !value.isDefault) out[value.key] = value.value;
  }
  return { values: out, keyframes };
};
