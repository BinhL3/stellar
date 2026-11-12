import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";
import * as NodeZlib from "node:zlib";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { copyFootage, footageStringout, listFootage } from "@t3tools/timeline/footage";
import { serializeTimeline } from "@t3tools/timeline/otio";
import { timelineFingerprint } from "@t3tools/timeline/renderProbe";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { runTranscription, transcriptCoverage } from "./Transcriber.ts";
import * as VideoProjects from "./VideoProjects.ts";

// Tests close their scope after the service's layer, so background proxy builds have stopped
// before the temporary folder they write into is removed.

// The smallest project Premiere's reader accepts: one sequence with an empty video track group.
const prprojWithFrame = (frame: string) =>
  NodeZlib.gzipSync(`<?xml version="1.0" encoding="UTF-8" ?>
<PremiereData Version="3">
<VideoTrackGroup ObjectID="1"><TrackGroup><FrameRate>4237833600</FrameRate></TrackGroup><FrameRect>0,0,${frame}</FrameRect></VideoTrackGroup>
<Sequence ObjectUID="seq-1"><TrackGroups><TrackGroup Index="0"><First>v</First><Second ObjectRef="1"/></TrackGroup></TrackGroups><Name>Polish v1</Name></Sequence>
</PremiereData>`);
const prproj = prprojWithFrame("1080,1920");

// A project whose sequences each hold one video track of clips, placed in frames at 30 fps.
const FRAME_TICKS = 8467200000;
interface FixtureClip {
  readonly name: string;
  readonly start: number;
  readonly end: number;
}
const prprojWithSequences = (
  sequences: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly clips: ReadonlyArray<FixtureClip>;
  }>,
) => {
  let nextId = 100;
  const objects = sequences.flatMap((sequence) => {
    const items = sequence.clips.map((clip) => {
      const [source, video, sub, item] = [nextId++, nextId++, nextId++, nextId++];
      const media = `${sequence.id}-${clip.name}`;
      return {
        item,
        xml: `<Media ObjectUID="${media}"><FilePath>/media/Footage/${clip.name}</FilePath></Media>
<VideoMediaSource ObjectID="${source}"><MediaSource><Media ObjectURef="${media}"/></MediaSource></VideoMediaSource>
<VideoClip ObjectID="${video}"><Clip><Source ObjectRef="${source}"/><InPoint>0</InPoint><OutPoint>${(clip.end - clip.start) * FRAME_TICKS}</OutPoint></Clip></VideoClip>
<SubClip ObjectID="${sub}"><Clip ObjectRef="${video}"/><Name>${clip.name}</Name></SubClip>
<VideoClipTrackItem ObjectID="${item}"><ClipTrackItem><TrackItem><Node><ID>${clip.name.charCodeAt(0)}</ID></Node><Start>${clip.start * FRAME_TICKS}</Start><End>${clip.end * FRAME_TICKS}</End></TrackItem><SubClip ObjectRef="${sub}"/></ClipTrackItem></VideoClipTrackItem>`,
      };
    });
    const group = nextId++;
    return [
      ...items.map((entry) => entry.xml),
      `<VideoClipTrack ObjectUID="track-${sequence.id}"><ClipTrack><ClipItems><TrackItems>${items.map((entry, index) => `<TrackItem Index="${index}" ObjectRef="${entry.item}"/>`).join("")}</TrackItems></ClipItems></ClipTrack></VideoClipTrack>`,
      `<VideoTrackGroup ObjectID="${group}"><TrackGroup><FrameRate>${FRAME_TICKS}</FrameRate><Tracks><Track Index="0" ObjectURef="track-${sequence.id}"/></Tracks></TrackGroup><FrameRect>0,0,1080,1920</FrameRect></VideoTrackGroup>`,
      `<Sequence ObjectUID="${sequence.id}"><TrackGroups><TrackGroup Index="0"><First>v</First><Second ObjectRef="${group}"/></TrackGroup></TrackGroups><Name>${sequence.name}</Name></Sequence>`,
    ];
  });
  return NodeZlib.gzipSync(
    `<?xml version="1.0" encoding="UTF-8" ?>\n<PremiereData Version="3">\n${objects.join("\n")}\n</PremiereData>`,
  );
};

// Background work transcribes what it finds, so no test may reach a real transcriber on the PATH.
const missingTranscriber = "/nonexistent/stellar-test-stt";
const noTranscriber = ServerSettings.ServerSettingsService.layerTest({
  videoTranscribeCommand: missingTranscriber,
});

// Stands in for the host's transcriber: `words <media> -o <out> [--lang <code>]`.
const fakeTranscriber = `#!/bin/sh
echo "$2 \${6:-any}" >> "$(dirname "$0")/calls.log"
case "$2" in *broken*) exit 1 ;; esac
printf '[{"w":"hello","start":0,"end":0.5}]' > "$4"
`;

const withProjects = (created: Array<string>) =>
  Layer.mock(ProjectService.ProjectService)({
    getByWorkspaceRoot: (root) =>
      Effect.succeed(
        created.includes(root)
          ? Option.some({ id: ProjectId.make("existing") } as never)
          : Option.none(),
      ),
    create: (input) => {
      created.push(input.workspaceRoot);
      return Effect.succeed({ id: input.projectId } as never);
    },
  });

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-video-project-" });
  const premiereFolder = path.join(root, "SFUniqlo", "Premiere");
  yield* fs.makeDirectory(premiereFolder, { recursive: true });
  const premiereProjectPath = path.join(premiereFolder, "SFUniqlo.prproj");
  yield* fs.writeFile(premiereProjectPath, prproj);
  return { fs, path, root, premiereProjectPath };
});

it.live("lists sequences and places the project beside the Premiere folder's parent", () =>
  Effect.gen(function* () {
    const { path, root, premiereProjectPath } = yield* setup;
    const videoProjects = yield* VideoProjects.VideoProjects;
    const inspected = yield* videoProjects.inspectPremiere({ premiereProjectPath });
    assert.deepStrictEqual(inspected, {
      title: "SFUniqlo",
      sequences: [{ id: "seq-1", name: "Polish v1" }],
      projectFolder: path.join(root, "SFUniqlo", "Stellar"),
    });
  }).pipe(
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provideMerge(withProjects([])),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, noTranscriber)),
      ),
    ),
    Effect.scoped,
  ),
);

it.live("pulls the sequence into the project folder and reuses the project next time", () => {
  const created: Array<string> = [];
  return Effect.gen(function* () {
    const { fs, path, root, premiereProjectPath } = yield* setup;
    const videoProjects = yield* VideoProjects.VideoProjects;
    const first = yield* videoProjects.createFromPremiere({
      premiereProjectPath,
      sequenceId: "seq-1",
    });
    const folder = path.join(root, "SFUniqlo", "Stellar");
    assert.strictEqual(first.workspaceRoot, folder);
    assert.strictEqual(first.timelinePath, path.join("timelines", "Polish_v1.otio"));
    assert.isFalse(first.existed);
    assert.isTrue(yield* fs.exists(path.join(folder, first.timelinePath)));

    const again = yield* videoProjects.createFromPremiere({
      premiereProjectPath,
      sequenceId: "seq-1",
    });
    assert.isTrue(again.existed);
    assert.deepStrictEqual(created, [folder]);
  }).pipe(
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provideMerge(withProjects(created)),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, noTranscriber)),
      ),
    ),
    Effect.scoped,
  );
});

it.live("syncs Premiere's saves without overwriting edits made here", () => {
  const created: Array<string> = [];
  return Effect.gen(function* () {
    const { fs, path, root, premiereProjectPath } = yield* setup;
    const videoProjects = yield* VideoProjects.VideoProjects;
    const { workspaceRoot, timelinePath } = yield* videoProjects.createFromPremiere({
      premiereProjectPath,
      sequenceId: "seq-1",
    });
    const timelineFile = path.join(workspaceRoot, timelinePath);
    const frameWidth = Effect.map(
      fs.readFileString(timelineFile),
      (text) => JSON.parse(text).metadata.stellar.frame.width as number,
    );
    const sync = (usePremiere?: boolean) =>
      Effect.map(
        videoProjects.sync({ workspaceRoot, ...(usePremiere ? { usePremiere } : {}) }),
        ({ state, updated, kept }) => ({ state, updated, kept }),
      );

    assert.deepStrictEqual(yield* sync(), { state: "current", updated: [], kept: [] });

    // Each save has a different byte length, so the change shows even within one clock tick.
    yield* fs.writeFile(premiereProjectPath, prprojWithFrame("540,960"));
    assert.deepStrictEqual(yield* sync(), { state: "updated", updated: [timelinePath], kept: [] });
    assert.strictEqual(yield* frameWidth, 540);
    assert.deepStrictEqual(yield* sync(), { state: "current", updated: [], kept: [] });

    const edited = `${yield* fs.readFileString(timelineFile)}\n`;
    yield* fs.writeFileString(timelineFile, edited);
    assert.deepStrictEqual(yield* sync(), { state: "edited", updated: [], kept: [timelinePath] });

    yield* fs.writeFile(premiereProjectPath, prprojWithFrame("3840,2160,0"));
    assert.deepStrictEqual(yield* sync(), { state: "conflict", updated: [], kept: [timelinePath] });
    assert.strictEqual(yield* fs.readFileString(timelineFile), edited);
    // The conflict is remembered, so an unchanged save still reports it.
    assert.deepStrictEqual(yield* sync(), { state: "conflict", updated: [], kept: [timelinePath] });

    assert.deepStrictEqual(yield* sync(true), {
      state: "updated",
      updated: [timelinePath],
      kept: [],
    });
    assert.strictEqual(yield* frameWidth, 3840);
    assert.strictEqual(
      yield* fs.readFileString(
        path.join(workspaceRoot, "timelines", "replaced", path.basename(timelinePath)),
      ),
      edited,
    );

    yield* fs.remove(premiereProjectPath);
    assert.strictEqual((yield* sync()).state, "offline");

    const elsewhere = yield* videoProjects.sync({ workspaceRoot: root }).pipe(Effect.flip);
    assert.strictEqual(elsewhere.message, "That folder isn't a project here.");
  }).pipe(
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provideMerge(withProjects(created)),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, noTranscriber)),
      ),
    ),
    Effect.scoped,
  );
});

it.live(
  "says what Premiere changed, merges edits made on both sides, and finds new sequences",
  () => {
    const created: Array<string> = [];
    return Effect.gen(function* () {
      const { fs, path, premiereProjectPath } = yield* setup;
      const videoProjects = yield* VideoProjects.VideoProjects;
      let saves = 0;
      // Each save gets its own modified time, so it reads as new whatever its size.
      const save = (cEnd: number, more: ReadonlyArray<{ id: string; name: string }> = []) =>
        Effect.gen(function* () {
          const clips = [
            { name: "a.MOV", start: 0, end: 100 },
            { name: "b.MOV", start: 100, end: 200 },
            { name: "c.MOV", start: 200, end: cEnd },
          ];
          yield* fs.writeFile(
            premiereProjectPath,
            prprojWithSequences([
              { id: "seq-1", name: "Polish v1", clips },
              ...more.map((sequence) => ({ ...sequence, clips: clips.slice(0, 1) })),
            ]),
          );
          saves += 1;
          yield* fs.utimes(premiereProjectPath, 1_000_000 + saves, 1_000_000 + saves);
        });
      yield* save(300);
      const { workspaceRoot, timelinePath } = yield* videoProjects.createFromPremiere({
        premiereProjectPath,
        sequenceId: "seq-1",
      });
      const timelineFile = path.join(workspaceRoot, timelinePath);
      const baseFile = path.join(workspaceRoot, "timelines", ".base", path.basename(timelinePath));
      const sync = (merge?: boolean) =>
        videoProjects.sync({ workspaceRoot, ...(merge ? { merge } : {}) });
      const clipLines = (text: string) =>
        text
          .split("\n")
          .slice(1)
          .map((line) => line.replace(/ #\S+/, ""));
      const clipId = (text: string, name: string) =>
        text
          .split("\n")
          .find((line) => line.includes(name))
          ?.match(/#(\S+)/)?.[1] ?? "";

      assert.strictEqual(
        yield* fs.readFileString(baseFile),
        yield* fs.readFileString(timelineFile),
      );
      assert.strictEqual((yield* sync()).state, "current");

      // A pull says what it brought in and moves the base with it.
      yield* save(260);
      const pulled = yield* sync();
      assert.strictEqual(pulled.state, "updated");
      assert.deepStrictEqual(pulled.changes, ["Trimmed c.MOV on V1 at 0:06: cut 1.3s off its end"]);
      assert.deepStrictEqual([pulled.pending, pulled.conflicts], [[], []]);
      assert.strictEqual(
        yield* fs.readFileString(baseFile),
        yield* fs.readFileString(timelineFile),
      );

      // Edits made here are pending until they reach Premiere.
      const read = yield* videoProjects.readTimeline({ workspaceRoot });
      assert.strictEqual(read.changes, "");
      const edited = yield* videoProjects.editTimeline({
        workspaceRoot,
        timeline: timelinePath,
        edits: [
          { kind: "setEnabled", clipId: clipId(read.text, "b.MOV"), enabled: false },
          { kind: "trim", clipId: clipId(read.text, "c.MOV"), edge: "end", frame: 250 },
        ],
      });
      assert.strictEqual(edited.premiere, "edited");
      assert.include(edited.changes, `Edited here, not in Premiere yet (${timelinePath}):`);
      const pending = (yield* sync()).pending;
      assert.strictEqual(pending.length, 2);
      const ours = yield* fs.readFileString(timelineFile);

      // Premiere trims the same clip end: the UI sync leaves the choice to the user.
      yield* save(240);
      const conflict = yield* sync();
      assert.strictEqual(conflict.state, "conflict");
      assert.deepStrictEqual(conflict.pending, pending);
      assert.strictEqual(yield* fs.readFileString(timelineFile), ours);

      // Without the base there is nothing to merge against, and nothing is written.
      const base = yield* fs.readFileString(baseFile);
      yield* fs.remove(baseFile);
      const refused = yield* sync(true).pipe(Effect.flip);
      assert.include(refused.message, `Can't merge ${timelinePath}`);
      const blocked = yield* videoProjects
        .editTimeline({
          workspaceRoot,
          timeline: timelinePath,
          edits: [{ kind: "split", frame: 50 }],
        })
        .pipe(Effect.flip);
      assert.include(blocked.message, "Nothing was changed.");
      assert.strictEqual(yield* fs.readFileString(timelineFile), ours);
      yield* fs.writeFileString(baseFile, base);

      // A merge takes Premiere's trim, keeps the clip switched off here, and lists the lost trim.
      const merged = yield* sync(true);
      assert.strictEqual(merged.state, "edited");
      assert.deepStrictEqual(merged.changes, ["Trimmed c.MOV on V1 at 0:06: cut 0.7s off its end"]);
      assert.strictEqual(merged.conflicts.length, 1);
      assert.strictEqual(merged.pending.length, 1);
      assert.deepStrictEqual(
        clipLines((yield* videoProjects.readTimeline({ workspaceRoot })).text),
        ["V1 0-100 a.MOV", "V1 100-200 b.MOV (disabled)", "V1 200-240 c.MOV"],
      );
      assert.strictEqual(
        yield* fs.readFileString(
          path.join(workspaceRoot, "timelines", "replaced", path.basename(timelinePath)),
        ),
        ours,
      );

      // An agent's read merges on its own, and is told what the user did in Premiere.
      yield* save(220);
      assert.strictEqual((yield* sync()).state, "conflict");
      const reread = yield* videoProjects.readTimeline({ workspaceRoot });
      assert.strictEqual(reread.premiere, "edited");
      assert.include(reread.changes, `Changed in Premiere since your last read (${timelinePath}):`);
      assert.include(reread.changes, `Edited here, not in Premiere yet (${timelinePath}):`);
      assert.deepStrictEqual(clipLines(reread.text).slice(1), [
        "V1 100-200 b.MOV (disabled)",
        "V1 200-220 c.MOV",
      ]);

      // A sequence made in Premiere becomes a timeline; one deleted there is said once and kept.
      yield* save(220, [{ id: "seq-2", name: "Polish v2" }]);
      const found = yield* sync();
      assert.deepStrictEqual(found.changes, ["New sequence: Polish v2"]);
      assert.deepStrictEqual(found.updated, ["timelines/Polish_v2.otio"]);
      yield* save(220);
      assert.deepStrictEqual((yield* sync()).changes, [
        "Sequence Polish v2 was deleted in Premiere; timelines/Polish_v2.otio is kept here",
      ]);
      yield* save(220, []);
      assert.deepStrictEqual((yield* sync()).changes, []);
      assert.isTrue(yield* fs.exists(path.join(workspaceRoot, "timelines", "Polish_v2.otio")));
    }).pipe(
      Effect.provide(
        VideoProjects.layer.pipe(
          Layer.provideMerge(withProjects(created)),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, noTranscriber)),
        ),
      ),
      Effect.scoped,
    );
  },
);

it.live(
  "starts a project from an idea, and a Premiere project saved into it joins the same one",
  () => {
    const created: Array<string> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-video-idea-" });
      const videoProjects = yield* VideoProjects.VideoProjects;
      const project = yield* videoProjects.createFromIdea({
        title: "Jollibee: lần đầu",
        parentFolder: root,
      });
      const folder = path.join(root, "Jollibee lần đầu");
      assert.strictEqual(project.workspaceRoot, path.join(folder, "Stellar"));
      assert.isFalse(project.existed);
      for (const name of ["Footage", "Audio", "B-roll", "Graphics", "Premiere", "Exports"]) {
        assert.isTrue(yield* fs.exists(path.join(folder, name)));
      }
      assert.isTrue(yield* fs.exists(path.join(folder, "Stellar", "timelines")));
      assert.strictEqual(
        (yield* videoProjects.sync({ workspaceRoot: project.workspaceRoot })).state,
        "unlinked",
      );

      const premiereProjectPath = path.join(folder, "Premiere", "Jollibee.prproj");
      yield* fs.writeFile(premiereProjectPath, prproj);
      const pulled = yield* videoProjects.createFromPremiere({
        premiereProjectPath,
        sequenceId: "seq-1",
      });
      assert.strictEqual(pulled.workspaceRoot, project.workspaceRoot);
      assert.isTrue(pulled.existed);
      assert.deepStrictEqual(created, [project.workspaceRoot]);

      const missing = yield* videoProjects
        .createFromIdea({ title: "Nowhere", parentFolder: path.join(root, "missing") })
        .pipe(Effect.flip);
      assert.strictEqual(missing.message, "Choose an existing folder to create it in.");
    }).pipe(
      Effect.provide(
        VideoProjects.layer.pipe(
          Layer.provideMerge(withProjects(created)),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, noTranscriber)),
        ),
      ),
      Effect.scoped,
    );
  },
);

it.live("copies footage in, replacing a cut-short copy and leaving the originals", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-footage-" });
    const downloads = path.join(root, "Downloads");
    yield* fs.makeDirectory(downloads);
    const sources = ["IMG_2.MOV", "IMG_1.MOV", "IMG_3.HEIC"].map((name) =>
      path.join(downloads, name),
    );
    for (const source of sources) yield* fs.writeFileString(source, `clip ${source}`);
    const destination = path.join(root, "Jollibee", "Footage", "00 Raw");
    yield* fs.makeDirectory(destination, { recursive: true });
    yield* fs.writeFileString(path.join(destination, "IMG_1.MOV"), "cl");

    const progress: Array<number> = [];
    const copy = copyFootage({
      sources,
      destination,
      onCopied: (done) => Effect.sync(() => void progress.push(done)),
    });
    assert.strictEqual(yield* copy, 3);
    assert.deepStrictEqual(progress, [1, 2, 3]);
    assert.strictEqual(
      yield* fs.readFileString(path.join(destination, "IMG_1.MOV")),
      `clip ${sources[1]}`,
    );
    assert.deepStrictEqual((yield* fs.readDirectory(destination)).toSorted(), [
      "IMG_1.MOV",
      "IMG_2.MOV",
      "IMG_3.HEIC",
    ]);
    assert.isTrue(yield* fs.exists(sources[0]!));
    assert.deepStrictEqual(yield* listFootage(path.join(root, "Jollibee")), [
      "Footage/00 Raw/IMG_1.MOV",
      "Footage/00 Raw/IMG_2.MOV",
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("cuts by transcript words, numbered as they were before the call", () => {
  const created: Array<string> = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-video-words-" });
    const videoProjects = yield* VideoProjects.VideoProjects;
    const { workspaceRoot } = yield* videoProjects.createFromIdea({
      title: "Jollibee",
      parentFolder: root,
    });
    const mediaRoot = path.dirname(workspaceRoot);
    const timeline = "timelines/Footage.otio";
    const file = path.join(workspaceRoot, timeline);
    yield* fs.writeFileString(
      file,
      serializeTimeline(
        footageStringout(
          [
            { target: "Footage/a.MOV", duration: 2, width: 1080, height: 1920 },
            { target: "Footage/b.MOV", duration: 1, width: 1080, height: 1920 },
          ],
          mediaRoot,
        ),
      ),
    );
    // Some projects keep transcripts in Audio/, others in Audio/transcripts/; both are found.
    yield* fs.makeDirectory(path.join(mediaRoot, "Audio", "transcripts"), { recursive: true });
    yield* fs.writeFileString(
      path.join(mediaRoot, "Audio", "transcripts", "a.words.json"),
      JSON.stringify([
        { w: "Hãy", start: 0.5, end: 0.6, aligned: true },
        { w: "subscribe", start: 0.6, end: 1, aligned: true },
        { w: "cho", start: 1, end: 1.5, aligned: true },
        { w: "kênh", start: 1.5, end: 1.9, aligned: true },
      ]),
    );
    const wordLines = (text: string) =>
      text
        .split("\n")
        .slice(1)
        .map((line) => line.replace(/#\S+/, "#id"));

    const read = yield* videoProjects.readWords({ workspaceRoot });
    assert.strictEqual(read.timeline, timeline);
    assert.deepStrictEqual(wordLines(read.text), [
      "A1 0-120 #id a.MOV",
      "1:Hãy@30 2:subscribe@36 3:cho@60 4:kênh@90",
      "A1 120-180 #id b.MOV (no transcript)",
    ]);

    // The script is project data: each beat keeps an id and is placed where its words are said.
    assert.deepStrictEqual((yield* videoProjects.readScript({ workspaceRoot })).beats, []);
    const docUrl = "https://docs.google.com/document/d/abc/edit";
    const saved = yield* videoProjects.saveScript({
      workspaceRoot,
      docUrl,
      text: "# Jollibee\n\n## Outro\nHãy subscribe cho kênh!\n[b-roll: logo]\nHẹn gặp lại các bạn.",
    });
    const placed = { firstWord: 1, lastWord: 4, startFrame: 30, endFrame: 114 };
    const unsaid = { firstWord: null, lastWord: null, startFrame: null, endFrame: null };
    assert.deepStrictEqual(saved.beats, [
      { id: "b1", text: "Hãy subscribe cho kênh!", section: "Outro", ...placed },
      { id: "b2", text: "Hẹn gặp lại các bạn.", section: "Outro", ...unsaid },
    ]);
    // A reworded beat keeps its id, a new one never takes the id of the beat that was removed.
    yield* videoProjects.saveScript({
      workspaceRoot,
      text: "Chào các bạn, mình là Bình.\nHãy subscribe cho kênh nhé!",
    });
    const reread = yield* videoProjects.readScript({ workspaceRoot, timeline });
    assert.strictEqual(reread.docUrl, docUrl);
    assert.strictEqual(reread.timeline, timeline);
    assert.deepStrictEqual(reread.beats, [
      { id: "b3", text: "Chào các bạn, mình là Bình.", section: null, ...unsaid },
      { id: "b1", text: "Hãy subscribe cho kênh nhé!", section: null, ...placed },
    ]);
    assert.include(
      (yield* videoProjects.readTimeline({ workspaceRoot })).project,
      "Script snapshot: 2 beats in Stellar/script.md, Google Doc recorded",
    );

    const before = yield* fs.readFileString(file);
    const refused = yield* videoProjects
      .editTimeline({
        workspaceRoot,
        timeline,
        edits: [
          { kind: "removeWords", fromWord: 1, toWord: 1, ripple: true },
          { kind: "removeWords", fromWord: 4, toWord: 9 },
        ],
      })
      .pipe(Effect.flip);
    assert.strictEqual(
      refused.message,
      "Edit 2 (removeWords): no word 9 (the timeline has 4 words). Nothing was changed.",
    );
    assert.strictEqual(yield* fs.readFileString(file), before);

    // The second cut names word 3 by its number before the first cut moved it.
    yield* videoProjects.editTimeline({
      workspaceRoot,
      timeline,
      edits: [
        { kind: "removeWords", fromWord: 1, toWord: 1, ripple: true },
        { kind: "removeWords", fromWord: 3, toWord: 3, ripple: true },
      ],
    });
    const after = yield* videoProjects.readWords({ workspaceRoot, timeline });
    assert.deepStrictEqual(wordLines(after.text), [
      "A1 0-30 #id a.MOV (no words)",
      "A1 30-54 #id a.MOV",
      "1:subscribe@30",
      "A1 54-84 #id a.MOV",
      "2:kênh@54",
      "A1 84-144 #id b.MOV (no transcript)",
    ]);
  }).pipe(
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provideMerge(withProjects(created)),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, noTranscriber)),
      ),
    ),
    Effect.scoped,
  );
});

it.live("reads a timeline for an agent and applies its edits, refusing a bad one whole", () => {
  const created: Array<string> = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-video-edit-" });
    const videoProjects = yield* VideoProjects.VideoProjects;
    const { workspaceRoot } = yield* videoProjects.createFromIdea({
      title: "Jollibee",
      parentFolder: root,
    });
    const timeline = "timelines/Footage.otio";
    const file = path.join(workspaceRoot, timeline);
    yield* fs.writeFileString(
      file,
      serializeTimeline(
        footageStringout(
          [
            { target: "Footage/a.MOV", duration: 2, width: 1080, height: 1920 },
            { target: "Footage/b.MOV", duration: 1, width: 1080, height: 1920 },
          ],
          path.dirname(workspaceRoot),
        ),
      ),
    );

    const read = yield* videoProjects.readTimeline({ workspaceRoot });
    assert.deepStrictEqual(read.timelines, [timeline]);
    assert.strictEqual(read.premiere, "unlinked");
    const facts = read.project.split("\n");
    assert.strictEqual(facts[0], `Project folder: ${path.dirname(workspaceRoot)}`);
    assert.include(facts[1], "no Premiere project is linked");
    assert.include(facts[2], "Footage: 0 videos in Footage/.");
    assert.deepStrictEqual(read.text.split("\n").slice(1), [
      "V1 0-120 #0:0 a.MOV",
      "V1 120-180 #0:1 b.MOV",
      "A1 0-120 #1:0 a.MOV",
      "A1 120-180 #1:1 b.MOV",
    ]);

    const before = yield* fs.readFileString(file);
    const refused = yield* videoProjects
      .editTimeline({
        workspaceRoot,
        timeline,
        edits: [
          { kind: "split", frame: 60 },
          { kind: "trim", clipId: "0:9", edge: "end", frame: 30 },
        ],
      })
      .pipe(Effect.flip);
    assert.strictEqual(refused.message, "Edit 2 (trim): no clip #0:9. Nothing was changed.");
    assert.strictEqual(yield* fs.readFileString(file), before);

    const edited = yield* videoProjects.editTimeline({
      workspaceRoot,
      timeline,
      edits: [{ kind: "removeRange", start: 0, end: 120, ripple: true }],
    });
    assert.deepStrictEqual(
      edited.text
        .split("\n")
        .slice(1)
        .map((line) => line.replace(/#\S+/, "#id")),
      ["V1 0-60 #id b.MOV", "A1 0-60 #id b.MOV"],
    );
  }).pipe(
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provideMerge(withProjects(created)),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, noTranscriber)),
      ),
    ),
    Effect.scoped,
  );
});

it.live("transcribes media that has no transcript and lists what failed", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-video-transcribe-" });
    const command = path.join(root, "stt");
    yield* fs.writeFileString(command, fakeTranscriber);
    yield* fs.chmod(command, 0o755);
    const mediaRoot = path.join(root, "Jollibee");
    const projectDir = path.join(mediaRoot, "Stellar");
    for (const folder of ["Footage/00 Raw", "Audio/VO", "Audio/transcripts", "Stellar"]) {
      yield* fs.makeDirectory(path.join(mediaRoot, folder), { recursive: true });
    }
    for (const media of [
      "Footage/00 Raw/a.MOV",
      "Footage/00 Raw/b.MOV",
      "Footage/00 Raw/broken.MOV",
      "Audio/VO/take.wav",
    ]) {
      yield* fs.writeFileString(path.join(mediaRoot, media), "media");
    }
    yield* fs.writeFileString(path.join(mediaRoot, "Audio", "transcripts", "a.words.json"), "[]");

    const coverage = yield* transcriptCoverage(mediaRoot);
    assert.deepStrictEqual(coverage, {
      total: 4,
      missing: ["Footage/00 Raw/b.MOV", "Footage/00 Raw/broken.MOV", "Audio/VO/take.wav"],
    });
    const progress: Array<number | null> = [];
    const status = yield* runTranscription({
      projectDir,
      command,
      language: "vi",
      targets: coverage.missing,
      coverage,
      onStatus: (reported) =>
        Effect.sync(() => void progress.push(reported.building?.done ?? null)),
    });

    const expected = {
      building: null,
      ready: 3,
      total: 4,
      failed: ["Footage/00 Raw/broken.MOV"],
      unavailable: null,
    };
    assert.deepStrictEqual(status, expected);
    assert.deepStrictEqual(progress, [0, 1, 2, null]);
    assert.deepStrictEqual(
      JSON.parse(yield* fs.readFileString(path.join(projectDir, "transcripts.json"))),
      expected,
    );
    assert.deepStrictEqual((yield* fs.readDirectory(path.join(mediaRoot, "Audio"))).toSorted(), [
      "VO",
      "b.words.json",
      "take.words.json",
      "transcripts",
    ]);
    // The clip that already had a transcript never reached the transcriber.
    assert.deepStrictEqual(
      (yield* fs.readFileString(path.join(root, "calls.log"))).trim().split("\n"),
      ["b.MOV", "broken.MOV", "take.wav"].map(
        (name) =>
          `${path.join(mediaRoot, name.endsWith(".wav") ? "Audio/VO" : "Footage/00 Raw", name)} vi`,
      ),
    );
    assert.deepStrictEqual((yield* transcriptCoverage(mediaRoot)).missing, [
      "Footage/00 Raw/broken.MOV",
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("reports that nothing can be transcribed when the host has no transcriber", () => {
  const created: Array<string> = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-video-no-stt-" });
    const videoProjects = yield* VideoProjects.VideoProjects;
    const { workspaceRoot } = yield* videoProjects.createFromIdea({
      title: "Jollibee",
      parentFolder: root,
    });
    const mediaRoot = path.dirname(workspaceRoot);
    yield* fs.writeFileString(path.join(mediaRoot, "Footage", "a.MOV"), "media");
    yield* fs.writeFileString(path.join(mediaRoot, "Footage", "b.MOV"), "media");
    yield* fs.writeFileString(path.join(mediaRoot, "Audio", "a.words.json"), "[]");

    const unavailable = `The transcribe command set in Settings (${missingTranscriber}) isn't on this machine.`;
    const expected = { building: null, ready: 1, total: 2, failed: [], unavailable };
    assert.deepStrictEqual(yield* videoProjects.transcribe({ workspaceRoot }), expected);
    assert.deepStrictEqual(
      JSON.parse(yield* fs.readFileString(path.join(workspaceRoot, "transcripts.json"))),
      expected,
    );
    assert.include(
      (yield* videoProjects.readTimeline({ workspaceRoot })).project,
      `Transcripts: 1 of 2 clips and takes word-timed (${unavailable}).`,
    );

    const outside = yield* videoProjects
      .transcribe({ workspaceRoot, files: ["../secret.mov"] })
      .pipe(Effect.flip);
    assert.strictEqual(outside.message, `Files to transcribe are named relative to ${mediaRoot}.`);
  }).pipe(
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provideMerge(withProjects(created)),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, noTranscriber)),
      ),
    ),
    Effect.scoped,
  );
});

// The service reads the home folder when it is built, so the test's home has a fixed path.
const intakeHome = `${NodeOS.tmpdir()}/stellar-intake-home-${process.pid}`;

it.live("scans Downloads for new footage and only imports from there", () => {
  const created: Array<string> = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const downloads = path.join(intakeHome, "Downloads");
    yield* fs.makeDirectory(downloads, { recursive: true });
    yield* Effect.addFinalizer(() =>
      fs.remove(intakeHome, { recursive: true }).pipe(Effect.ignore),
    );
    yield* fs.writeFileString(path.join(downloads, "IMG_8139.MOV"), "clip");
    yield* fs.writeFileString(path.join(downloads, "notes.txt"), "not footage");
    const videoProjects = yield* VideoProjects.VideoProjects;
    const { workspaceRoot } = yield* videoProjects.createFromIdea({
      title: "Jollibee",
      parentFolder: intakeHome,
    });

    const scan = yield* videoProjects.scanIntake({ workspaceRoot });
    assert.strictEqual(scan.source, downloads);
    assert.deepStrictEqual(
      scan.files.map((file) => [file.path, file.size]),
      [[path.join(downloads, "IMG_8139.MOV"), 4]],
    );

    const outside = yield* videoProjects
      .importFootage({
        workspaceRoot,
        paths: [path.join(intakeHome, "secret.mov")],
        folder: "00 Raw",
      })
      .pipe(Effect.flip);
    assert.strictEqual(outside.message, `Footage is imported from ${downloads}.`);
    const unnamed = yield* videoProjects
      .importFootage({ workspaceRoot, paths: [scan.files[0]!.path], folder: ".." })
      .pipe(Effect.flip);
    assert.strictEqual(unnamed.message, "Name the folder the footage goes in.");
  }).pipe(
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provideMerge(withProjects(created)),
        Layer.provideMerge(Layer.succeed(HostProcess.HomeDirectory, intakeHome)),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, noTranscriber)),
      ),
    ),
    Effect.scoped,
  );
});

it.live("rejects files that aren't Premiere projects", () =>
  Effect.gen(function* () {
    const videoProjects = yield* VideoProjects.VideoProjects;
    const error = yield* videoProjects
      .inspectPremiere({ premiereProjectPath: "/tmp/not-a-project.mov" })
      .pipe(Effect.flip);
    assert.strictEqual(error.message, "Choose a Premiere project (.prproj) file.");
  }).pipe(
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provideMerge(withProjects([])),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, noTranscriber)),
      ),
    ),
  ),
);

it.live("plans a push from Premiere's last save, and says why when it can't", () => {
  const created: Array<string> = [];
  return Effect.gen(function* () {
    const { fs, path, premiereProjectPath } = yield* setup;
    const videoProjects = yield* VideoProjects.VideoProjects;
    const save = (cEnd: number, modified: number) =>
      Effect.gen(function* () {
        yield* fs.writeFile(
          premiereProjectPath,
          prprojWithSequences([
            {
              id: "seq-1",
              name: "Polish v1",
              clips: [
                { name: "a.MOV", start: 0, end: 100 },
                { name: "b.MOV", start: 100, end: 200 },
                { name: "c.MOV", start: 200, end: cEnd },
              ],
            },
          ]),
        );
        yield* fs.utimes(premiereProjectPath, modified, modified);
      });
    yield* save(300, 1_000_001);
    const { workspaceRoot, timelinePath } = yield* videoProjects.createFromPremiere({
      premiereProjectPath,
      sequenceId: "seq-1",
    });
    const push = videoProjects.pushPlan({ workspaceRoot });
    assert.deepStrictEqual([(yield* push).steps, (yield* push).refused], [0, null]);

    yield* videoProjects.editTimeline({
      workspaceRoot,
      timeline: timelinePath,
      edits: [{ kind: "removeRange", start: 100, end: 200, ripple: true }],
    });
    const planned = yield* push;
    assert.deepStrictEqual(
      [planned.linked, planned.premiereIsNewer, planned.refused, planned.plan],
      [true, false, null, "1. ripple-remove 3.333333s-6.666667s (frames 100-200) on V1"],
    );

    // A newer save in Premiere must be merged in before anything is pushed onto it.
    yield* save(260, 1_000_002);
    const stale = yield* push;
    assert.deepStrictEqual([stale.premiereIsNewer, stale.steps, stale.plan], [true, 0, ""]);
    assert.match(stale.refused ?? "", /^Pull first/);
    yield* videoProjects.readTimeline({ workspaceRoot });
    assert.strictEqual((yield* push).plan, planned.plan);

    yield* fs.remove(path.join(workspaceRoot, "timelines", ".base", path.basename(timelinePath)));
    assert.strictEqual(
      (yield* push).refused,
      "No record of Premiere's version yet; sync once with Premiere open.",
    );
  }).pipe(
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provideMerge(withProjects(created)),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, noTranscriber)),
      ),
    ),
    Effect.scoped,
  );
});

it.live("follows a short's run from an idea to posted, and takes posted back", () => {
  const created: Array<string> = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-video-finish-" });
    const videoProjects = yield* VideoProjects.VideoProjects;
    const { workspaceRoot } = yield* videoProjects.createFromIdea({
      title: "Jollibee",
      parentFolder: root,
    });
    const mediaRoot = path.dirname(workspaceRoot);
    const states = (preflight: { readonly steps: ReadonlyArray<{ id: string; state: string }> }) =>
      Object.fromEntries(preflight.steps.map((step) => [step.id, step.state]));

    const empty = yield* videoProjects.preflight({ workspaceRoot });
    assert.deepStrictEqual(
      empty.steps.map((step) => step.state),
      Array.from({ length: 8 }, () => "todo"),
    );
    assert.strictEqual(empty.render, null);
    assert.strictEqual(
      (yield* videoProjects.checkRender({ workspaceRoot }).pipe(Effect.flip)).message,
      "No timeline to check the export against. This project has: none.",
    );

    // What each step reads: the script snapshot, Footage, intake.json, the proxy index.
    yield* videoProjects.saveScript({ workspaceRoot, text: "Hãy subscribe cho kênh!" });
    yield* fs.makeDirectory(path.join(mediaRoot, "Footage", "raw"), { recursive: true });
    yield* fs.writeFileString(path.join(mediaRoot, "Footage", "raw", "a.MOV"), "");
    yield* fs.writeFileString(path.join(mediaRoot, "Audio", "a.words.json"), "[]");
    yield* fs.writeFileString(
      path.join(workspaceRoot, "intake.json"),
      JSON.stringify({ state: "done", folder: "raw", done: 1, total: 1 }),
    );
    yield* fs.makeDirectory(path.join(workspaceRoot, "proxies"), { recursive: true });
    yield* fs.writeFileString(
      path.join(workspaceRoot, "proxies", "index.json"),
      JSON.stringify({ version: 1, media: { "Footage/raw/a.MOV": {} } }),
    );
    const timeline = "timelines/Footage.otio";
    const timelineFile = path.join(workspaceRoot, timeline);
    yield* fs.writeFileString(
      timelineFile,
      serializeTimeline(
        footageStringout(
          [{ target: "Footage/raw/a.MOV", duration: 2, width: 1080, height: 1920 }],
          mediaRoot,
        ),
      ),
    );
    assert.strictEqual(
      (yield* videoProjects.checkRender({ workspaceRoot }).pipe(Effect.flip)).message,
      "No video in the project's Exports folder to check. Export the sequence from Premiere into it, or name the file.",
    );

    // A report as a check leaves it, for an export that is still the one in Exports.
    const exportPath = path.join(mediaRoot, "Exports", "Jollibee.mp4");
    yield* fs.writeFileString(exportPath, "export");
    const stat = yield* fs.stat(exportPath);
    const writeReport = (timelineText: string) =>
      fs.writeFileString(
        path.join(workspaceRoot, "render", "report.json"),
        JSON.stringify({
          timeline,
          timelineHash: timelineFingerprint(timelineText),
          exportPath,
          exportSize: Number(stat.size),
          exportModifiedAt: Option.getOrThrow(stat.mtime).getTime(),
          checkedAt: 1,
          level: "pass",
          items: [{ id: "duration", level: "pass", title: "Length", detail: "2.00 s" }],
          contactSheet: null,
          contactSheetLabelled: false,
          contactSheetTiles: [],
        }),
      );
    yield* fs.makeDirectory(path.join(workspaceRoot, "render"), { recursive: true });
    yield* writeReport(yield* fs.readFileString(timelineFile));
    const checked = yield* videoProjects.preflight({ workspaceRoot });
    assert.deepStrictEqual(states(checked), {
      script: "done",
      footage: "done",
      proxies: "done",
      transcripts: "done",
      premiereLink: "todo",
      premiereSync: "todo",
      render: "done",
      posted: "todo",
    });
    assert.include(
      (yield* videoProjects.readTimeline({ workspaceRoot })).project,
      "Run: 5 of 8 steps done; next: todo Premiere project: None linked (video_premiere_pull). video_preflight lists every step.",
    );

    // An edit to the timeline, or a newer export, makes the check stale.
    yield* videoProjects.editTimeline({
      workspaceRoot,
      timeline,
      edits: [{ kind: "removeRange", start: 0, end: 30, ripple: true }],
    });
    const edited = (yield* videoProjects.preflight({ workspaceRoot })).steps[6];
    assert.deepStrictEqual(
      [edited?.state, edited?.detail],
      ["warn", "Timeline changed since the check"],
    );
    yield* writeReport(yield* fs.readFileString(timelineFile));
    yield* fs.writeFileString(exportPath, "a longer export");
    const reExported = (yield* videoProjects.preflight({ workspaceRoot })).steps[6];
    assert.deepStrictEqual(
      [reExported?.state, reExported?.detail],
      ["warn", "A newer export isn't checked"],
    );

    // Posted is project data beside the stage, and comes back off the same way.
    const projectFile = path.join(workspaceRoot, "project.json");
    yield* fs.writeFileString(projectFile, JSON.stringify({ language: "vi", stage: "polish" }));
    const url = "https://www.tiktok.com/@binh/video/1";
    const posted = yield* videoProjects.setPosted({
      workspaceRoot,
      posted: true,
      urls: [url],
      at: 5,
    });
    assert.deepStrictEqual(posted.posted, { at: 5, urls: [url] });
    assert.strictEqual(states(posted).posted, "done");
    assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(projectFile)), {
      language: "vi",
      stage: "posted",
      posted: { at: 5, urls: [url] },
    });
    const undone = yield* videoProjects.setPosted({ workspaceRoot, posted: false });
    assert.strictEqual(undone.posted, null);
    assert.deepStrictEqual(JSON.parse(yield* fs.readFileString(projectFile)), {
      language: "vi",
      stage: "polish",
    });
  }).pipe(
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provideMerge(withProjects(created)),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, noTranscriber)),
      ),
    ),
    Effect.scoped,
  );
});
