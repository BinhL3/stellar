import * as NodeBuffer from "node:buffer";
import * as NodeZlib from "node:zlib";
import { describe, expect, it } from "vite-plus/test";
import { compactView } from "../compactView.ts";
import { layoutTimeline } from "../layout.ts";
import { type Clip, type EffectRef, TIMELINE_NAMESPACE } from "../otio.ts";
import { parsePrproj } from "./prproj.ts";

// Ticks per frame: 59.94 sequence, 30 fps camera clip, 29.97 still.
const SEQ = 4237833600n;
const CAM = 8467200000n;
const STILL = 8475667200n;
const ONE_HOUR_DF_STILL = 107892n * STILL;

/** A minimal project with the same object graph shape Premiere writes. */
const fixture = () => {
  const objects: Array<string> = [];
  let nextId = 100;
  const add = (xml: (id: number) => string): number => {
    const id = nextId++;
    objects.push(xml(id));
    return id;
  };
  const param = (name: string, start: string, timeVarying = false, keyframes = "") =>
    add(
      (id) =>
        `<VideoComponentParam ObjectID="${id}"><Name>${name}</Name><StartKeyframe>-91445760000000000,${start},0,0,0,0,0,0</StartKeyframe>${timeVarying ? "<IsTimeVarying>true</IsTimeVarying>" : ""}${keyframes === "" ? "" : `<Keyframes>${keyframes}</Keyframes>`}</VideoComponentParam>`,
    );
  const motion = (scale: string, scaleKeyframes = "") => {
    const params = [
      param("Position", "0.5:0.25"),
      param("Scale", scale, scaleKeyframes !== "", scaleKeyframes),
      param("Rotation", "0."),
    ];
    return add(
      (id) =>
        `<VideoFilterComponent ObjectID="${id}"><Component><Params>${params.map((p, i) => `<Param Index="${i}" ObjectRef="${p}"/>`).join("")}</Params><DisplayName>Motion</DisplayName><Intrinsic>true</Intrinsic></Component><MatchName>AE.ADBE Motion</MatchName></VideoFilterComponent>`,
    );
  };
  const slideIn = () => {
    const position = param("Position", "0.5:-1.2", true);
    return add(
      (id) =>
        `<VideoFilterComponent ObjectID="${id}"><Component><Params><Param Index="0" ObjectRef="${position}"/></Params><DisplayName>Transform</DisplayName><InstanceName>Malice Slide In Down Fast</InstanceName></Component><MatchName>AE.ADBE Geometry2</MatchName></VideoFilterComponent>`,
    );
  };
  // Premiere's Source Text is a FlatBuffer: length-prefixed, null-terminated strings, words last.
  const textGraphic = (words: string) => {
    const strings = ["AnimationType", "BeVietnamPro-SemiBold", words].map((value) => {
      const bytes = NodeBuffer.Buffer.from(value, "utf8");
      const length = NodeBuffer.Buffer.alloc(4);
      length.writeUInt32LE(bytes.length);
      return NodeBuffer.Buffer.concat([length, bytes, NodeBuffer.Buffer.alloc(1)]);
    });
    const value = NodeBuffer.Buffer.concat([NodeBuffer.Buffer.alloc(8), ...strings]).toString(
      "base64",
    );
    const source = add(
      (id) =>
        `<ArbVideoComponentParam ObjectID="${id}"><Name>Source Text</Name><StartKeyframeValue Encoding="base64">${value}</StartKeyframeValue></ArbVideoComponentParam>`,
    );
    return add(
      (id) =>
        `<VideoFilterComponent ObjectID="${id}"><Component><Params><Param Index="0" ObjectRef="${source}"/></Params><DisplayName>Text</DisplayName></Component><MatchName>AE.ADBE Text</MatchName></VideoFilterComponent>`,
    );
  };
  const volume = (level: string) => {
    const p = add(
      (id) =>
        `<AudioComponentParam ObjectID="${id}"><Name>Level</Name><StartKeyframe>-91445760000000000,${level},0</StartKeyframe></AudioComponentParam>`,
    );
    return add(
      (id) =>
        `<AudioFilterComponent ObjectID="${id}"><AudioComponent><Component><Params><Param Index="0" ObjectRef="${p}"/></Params><Intrinsic>true</Intrinsic></Component></AudioComponent><FilterMatchName>Internal Volume Stereo</FilterMatchName></AudioFilterComponent>`,
    );
  };
  const chain = (tag: string, components: ReadonlyArray<number>) =>
    add(
      (id) =>
        `<${tag} ObjectID="${id}"><ComponentChain><Components>${components.map((c, i) => `<Component Index="${i}" ObjectRef="${c}"/>`).join("")}</Components></ComponentChain></${tag}>`,
    );
  let uid = 0;
  const media = (path: string, frameRate: bigint) => {
    const mediaUid = `media-${uid++}`;
    objects.push(`<Media ObjectUID="${mediaUid}"><FilePath>${path}</FilePath></Media>`);
    const logging = add(
      (id) =>
        `<ClipLoggingInfo ObjectID="${id}"><MediaFrameRate>${frameRate}</MediaFrameRate></ClipLoggingInfo>`,
    );
    const masterUid = `master-${uid++}`;
    objects.push(
      `<MasterClip ObjectUID="${masterUid}"><LoggingInfo ObjectRef="${logging}"/></MasterClip>`,
    );
    const source = add(
      (id) =>
        `<VideoMediaSource ObjectID="${id}"><MediaSource><Media ObjectURef="${mediaUid}"/></MediaSource></VideoMediaSource>`,
    );
    return { masterUid, source };
  };
  const item = (
    tag: "VideoClipTrackItem" | "AudioClipTrackItem",
    nodeId: number,
    m: { masterUid: string; source: number },
    name: string,
    range: { start: bigint; end: bigint; in: bigint; out: bigint },
    components: number,
  ) => {
    const clip = add(
      (id) =>
        `<VideoClip ObjectID="${id}"><Clip><Source ObjectRef="${m.source}"/><InPoint>${range.in}</InPoint><OutPoint>${range.out}</OutPoint></Clip></VideoClip>`,
    );
    const sub = add(
      (id) =>
        `<SubClip ObjectID="${id}"><Clip ObjectRef="${clip}"/><MasterClip ObjectURef="${m.masterUid}"/><Name>${name}</Name></SubClip>`,
    );
    return add(
      (id) =>
        `<${tag} ObjectID="${id}"><ClipTrackItem><ComponentOwner><Components ObjectRef="${components}"/></ComponentOwner><TrackItem><Node><ID>${nodeId}</ID></Node>${range.start === 0n ? "" : `<Start>${range.start}</Start>`}<End>${range.end}</End></TrackItem><SubClip ObjectRef="${sub}"/></ClipTrackItem></${tag}>`,
    );
  };
  const track = (tag: string, uidName: string, items: ReadonlyArray<number>) => {
    objects.push(
      `<${tag} ObjectUID="${uidName}"><ClipTrack><ClipItems><TrackItems>${items.map((it, i) => `<TrackItem Index="${i}" ObjectRef="${it}"/>`).join("")}</TrackItems></ClipItems></ClipTrack></${tag}>`,
    );
  };

  const camera = media("/media/root/Footage/IMG_1.MOV", CAM);
  const card = media("/media/root/Graphics/card.png", STILL);
  const v1a = item(
    "VideoClipTrackItem",
    1000003,
    camera,
    "IMG_1.MOV",
    { start: 0n, end: 120n * SEQ, in: 25n * CAM, out: 85n * CAM },
    // A punch-in from 100 to 120 over the clip's first second; keyframe times are media ticks.
    chain("VideoComponentChain", [
      motion("100.", `${25n * CAM},100.,0,0,0,0,0,0;${55n * CAM},120.,0,0,0,0,0,0;`),
    ]),
  );
  const v1b = item(
    "VideoClipTrackItem",
    1000004,
    camera,
    "IMG_1.MOV",
    { start: 150n * SEQ, end: 190n * SEQ, in: 100n * CAM, out: 125n * CAM },
    chain("VideoComponentChain", [motion("50."), textGraphic("This is the")]),
  );
  const cardA = item(
    "VideoClipTrackItem",
    1000005,
    card,
    "card.png",
    {
      start: 300n * SEQ,
      end: 360n * SEQ,
      in: ONE_HOUR_DF_STILL,
      out: ONE_HOUR_DF_STILL + 30n * STILL,
    },
    chain("VideoComponentChain", [slideIn()]),
  );
  const cardB = item(
    "VideoClipTrackItem",
    1000006,
    card,
    "card.png",
    {
      start: 100n * SEQ,
      end: 160n * SEQ,
      in: ONE_HOUR_DF_STILL,
      // Tail-trimmed: Premiere leaves OutPoint at the media's end, so length comes from the record.
      out: ONE_HOUR_DF_STILL + 300n * STILL,
    },
    chain("VideoComponentChain", [slideIn()]),
  );
  const a1 = item(
    "AudioClipTrackItem",
    1000007,
    camera,
    "IMG_1.MOV",
    { start: 0n, end: 120n * SEQ, in: 25n * CAM, out: 85n * CAM },
    chain("AudioComponentChain", [volume("0.017782794312")]),
  );

  track("VideoClipTrack", "track-v1", [v1a, v1b]);
  // V2 stores the later card first: the out-of-order layout Premiere's export can drop.
  track("VideoClipTrack", "track-v2", [cardA, cardB]);
  track("AudioClipTrack", "track-a1", [a1]);
  const video = add(
    (id) =>
      `<VideoTrackGroup ObjectID="${id}"><TrackGroup><FrameRate>${SEQ}</FrameRate><Tracks><Track Index="0" ObjectURef="track-v1"/><Track Index="1" ObjectURef="track-v2"/></Tracks></TrackGroup><FrameRect>0,0,1080,1920</FrameRect></VideoTrackGroup>`,
  );
  const audio = add(
    (id) =>
      `<AudioTrackGroup ObjectID="${id}"><TrackGroup><FrameRate>5292000</FrameRate><Tracks><Track Index="0" ObjectURef="track-a1"/></Tracks></TrackGroup></AudioTrackGroup>`,
  );
  objects.push(
    `<Sequence ObjectUID="seq-1"><TrackGroups><TrackGroup Index="0"><First>v</First><Second ObjectRef="${video}"/></TrackGroup><TrackGroup Index="1"><First>a</First><Second ObjectRef="${audio}"/></TrackGroup></TrackGroups><Name>Polish v1</Name></Sequence>`,
  );
  return `<?xml version="1.0" encoding="UTF-8" ?>\n<PremiereData Version="3">${objects.join("\n")}</PremiereData>`;
};

const pull = () =>
  parsePrproj(NodeZlib.gzipSync(fixture())).readSequence("Polish v1", { mediaRoot: "/media/root" });

const clipsOf = (trackName: string) => {
  const track = pull().timeline.tracks.children.find((t) => t.name === trackName);
  return track?.children ?? [];
};

describe("parsePrproj", () => {
  it("reads record frames, gaps and source ranges in each clip's own rate", () => {
    const [first, gap, second] = clipsOf("V1");
    expect(first?.OTIO_SCHEMA).toBe("Clip.2");
    expect(first?.source_range).toMatchObject({
      start_time: { value: 25, rate: 30 },
      duration: { value: 60.06, rate: 30 },
    });
    expect((first as Clip).media_references.DEFAULT_MEDIA.target_url).toBe("Footage/IMG_1.MOV");
    expect((first as Clip).metadata["premiere"]).toMatchObject({
      nodeId: "000f4243",
      record: { startFrame: 0, endFrame: 120 },
    });
    expect((first as Clip).metadata[TIMELINE_NAMESPACE]).toMatchObject({
      transform: {
        position: [0.5, 0.25],
        keyframes: {
          scale: [
            [0, 100],
            [1, 120],
          ],
        },
      },
      effects: [{ kind: "Motion", animated: true }],
    });
    expect(gap).toMatchObject({ OTIO_SCHEMA: "Gap.1", source_range: { duration: { value: 30 } } });
    expect((second as Clip).metadata[TIMELINE_NAMESPACE]).toMatchObject({
      text: "This is the",
      transform: { position: [0.5, 0.25], scale: 50 },
      effects: [{ kind: "Text", tier: "native" }],
    });
  });

  it("warns about items stored out of time order", () => {
    expect(pull().warnings).toEqual([
      "V2 card.png at frame 100 is stored out of time order; Premiere's export can drop it.",
    ]);
  });

  it("keeps native effects by reference, deduplicating identical stacks", () => {
    const { blobs, timeline } = pull();
    const v2 = timeline.tracks.children.find((t) => t.name === "V2")?.children ?? [];
    const refs = v2
      .filter((c): c is Clip => c.OTIO_SCHEMA === "Clip.2")
      .map(
        (c) => (c.metadata[TIMELINE_NAMESPACE] as { effects: ReadonlyArray<EffectRef> }).effects[0],
      );
    expect(refs[0]).toMatchObject({
      kind: "Transform",
      label: "Malice Slide In Down Fast",
      tier: "mappable",
      animated: true,
    });
    expect(refs[0]?.ref).toBe(refs[1]?.ref);
    // One shared Malice blob, plus V1's animated Motion and text graphic.
    expect(blobs.size).toBe(3);
  });

  it("zeroes still sources and reads audio level in dB", () => {
    const [, card] = clipsOf("V2");
    expect(card?.source_range).toMatchObject({ start_time: { value: 0 }, duration: { value: 30 } });
    expect((clipsOf("A1")[0] as Clip).metadata[TIMELINE_NAMESPACE]).toEqual({
      transform: { gain_db: -20 },
    });
  });

  it("records the sequence frame size", () => {
    expect(pull().timeline.metadata[TIMELINE_NAMESPACE]).toMatchObject({
      frame: { width: 1080, height: 1920 },
    });
  });

  it("lays clips out in timeline frames, top video track first", () => {
    const layout = layoutTimeline(pull().timeline);
    expect(layout.durationFrames).toBe(360);
    expect(layout.tracks.map((t) => t.name)).toEqual(["V2", "V1", "A1"]);
    expect(layout.tracks[0]?.clips.map((c) => [c.startFrame, c.endFrame])).toEqual([
      [100, 160],
      [300, 360],
    ]);
  });

  it("renders the compact view an agent reads", () => {
    expect(compactView(pull().timeline)).toBe(
      [
        "# Polish v1 · frames @59.94 · ~ = animated",
        "V1 0–120 IMG_1.MOV src 25–85.06@30 fx:Motion~ position=0.5:0.25 scale=100→120",
        'V1 150–190 IMG_1.MOV src 100–120.02@30 text:"This is the" fx:Text position=0.5:0.25 scale=50',
        'V2 100–160 card.png src 0–30@29.97 fx:Transform:"Malice Slide In Down Fast"~',
        'V2 300–360 card.png src 0–30@29.97 fx:Transform:"Malice Slide In Down Fast"~',
        "A1 0–120 IMG_1.MOV src 25–85.06@30 gain_db=-20",
      ].join("\n"),
    );
  });
});
