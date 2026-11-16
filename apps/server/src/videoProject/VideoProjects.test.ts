import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as NodeOS from "node:os";
import * as NodeZlib from "node:zlib";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { copyFootage, footageStringout, listFootage } from "@t3tools/timeline/footage";
import { layoutTimeline } from "@t3tools/timeline/layout";
import { applyEdits } from "@t3tools/timeline/edits";
import { serializeTimeline, type Timeline, timeRange } from "@t3tools/timeline/otio";
import { hashOfText } from "@t3tools/timeline/versions";
import { timelineFingerprint } from "@t3tools/timeline/renderProbe";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PremiereApp from "./PremiereApp.ts";
import { findTranscript, runTranscription, transcriptCoverage } from "./Transcriber.ts";
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

    // A pull by an older reader is read again once, with no new save in Premiere.
    const fresh = JSON.parse(yield* fs.readFileString(timelineFile)) as Timeline;
    const stale = serializeTimeline({ ...fresh, name: "Read by an older Stellar" });
    const linkFile = path.join(workspaceRoot, "premiere.json");
    const { reader: _reader, ...link } = JSON.parse(yield* fs.readFileString(linkFile));
    link.timelines[timelinePath] = {
      ...link.timelines[timelinePath],
      pulled: hashOfText(stale),
      premiere: hashOfText(stale),
    };
    yield* fs.writeFileString(timelineFile, stale);
    yield* fs.writeFileString(linkFile, JSON.stringify(link));
    assert.deepStrictEqual(yield* sync(), { state: "updated", updated: [timelinePath], kept: [] });
    assert.strictEqual(yield* fs.readFileString(timelineFile), serializeTimeline(fresh));
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
    // The text that was replaced is a version, though nothing of Stellar's wrote it.
    const history = yield* videoProjects.listVersions({ workspaceRoot, timeline: timelinePath });
    assert.deepStrictEqual(
      history.versions.map((version) => [version.by, version.label]),
      [
        ["premiere", "Replaced by Premiere's version"],
        ["outside", "Changed outside Stellar"],
        ["premiere", "Pulled from Premiere"],
        ["outside", "Changed outside Stellar"],
        ["premiere", "Pulled from Premiere"],
        ["premiere", "Pulled from Premiere"],
      ],
    );
    const replaced = yield* videoProjects.readVersion({
      workspaceRoot,
      timeline: timelinePath,
      version: history.versions[1]?.id ?? "",
    });
    assert.strictEqual(replaced.contents, edited);

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
      // Premiere's last save is kept in the history's store, under the hash of its text.
      const baseFileOf = (text: string) =>
        path.join(
          workspaceRoot,
          "timelines",
          ".history",
          path.basename(timelinePath),
          `${hashOfText(text)}.otio`,
        );
      const sync = (merge?: boolean) =>
        videoProjects.sync({ workspaceRoot, ...(merge ? { merge } : {}) });
      const clipLines = (text: string) =>
        text
          .split("\n")
          .slice(1)
          .filter((line) => !line.startsWith("#"))
          .map((line) => line.replace(/ #\S+/, ""));
      const clipId = (text: string, name: string) =>
        text
          .split("\n")
          .find((line) => line.includes(name))
          ?.match(/#(\S+)/)?.[1] ?? "";

      assert.isTrue(yield* fs.exists(baseFileOf(yield* fs.readFileString(timelineFile))));
      assert.strictEqual((yield* sync()).state, "current");

      // A pull says what it brought in and moves the base with it.
      yield* save(260);
      const pulled = yield* sync();
      assert.strictEqual(pulled.state, "updated");
      assert.deepStrictEqual(pulled.changes, ["Trimmed c.MOV on V1 at 0:06: cut 1.3s off its end"]);
      assert.deepStrictEqual([pulled.pending, pulled.conflicts], [[], []]);

      // An edit made here, then made in Premiere and saved, is a push that landed: no conflict.
      const beforePush = yield* videoProjects.readTimeline({ workspaceRoot });
      yield* videoProjects.editTimeline({
        workspaceRoot,
        timeline: timelinePath,
        summary: "Trimmed the end of c.",
        edits: [
          { kind: "trim", clipId: clipId(beforePush.text, "c.MOV"), edge: "end", frame: 255 },
        ],
      });
      yield* save(255);
      const pushed = yield* sync();
      assert.deepStrictEqual([pushed.state, pushed.kept, pushed.pending], ["updated", [], []]);
      assert.strictEqual((yield* sync()).state, "current");
      // The pull that confirmed the push changed nothing, so the edit can still come out alone.
      const takenOut = yield* videoProjects.reviewEdit({
        workspaceRoot,
        timeline: timelinePath,
        edit: 1,
        action: "undo",
      });
      assert.strictEqual(takenOut.blocked, null);
      assert.strictEqual((yield* sync()).state, "edited");
      // Premiere takes the undo too, and the two hold the same text again.
      yield* save(260);
      assert.strictEqual((yield* sync()).state, "current");

      const base = yield* fs.readFileString(timelineFile);
      const baseFile = baseFileOf(base);
      assert.isTrue(yield* fs.exists(baseFile));

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
      // What the merge replaced is the version before it.
      const history = yield* videoProjects.listVersions({ workspaceRoot, timeline: timelinePath });
      assert.deepStrictEqual(
        history.versions.slice(0, 2).map((version) => [version.by, version.label]),
        [
          ["premiere", "Merged Premiere's save with the edits made here"],
          ["agent", "Edited by an agent"],
        ],
      );
      assert.strictEqual(
        (yield* videoProjects.readVersion({
          workspaceRoot,
          timeline: timelinePath,
          version: history.versions[1]?.id ?? "",
        })).contents,
        ours,
      );

      // An agent's read merges on its own, and is told what the user did in Premiere. It may name
      // the sequence rather than the file; the resource forks an exFAT drive leaves are not timelines.
      yield* save(220);
      assert.strictEqual((yield* sync()).state, "conflict");
      const fork = path.join(path.dirname(timelineFile), `._${path.basename(timelinePath)}`);
      yield* fs.writeFileString(fork, "\u0000");
      const reread = yield* videoProjects.readTimeline({ workspaceRoot, timeline: "Polish v1" });
      assert.strictEqual(reread.timeline, timelinePath);
      assert.notInclude(reread.timelines, `timelines/._${path.basename(timelinePath)}`);
      yield* fs.remove(fork);
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

it.live(
  "starts a project in the projects folder when none is chosen, but not on an unplugged drive",
  () => {
    const created: Array<string> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* HostProcess.HomeDirectory;
      const videoProjects = yield* VideoProjects.VideoProjects;
      const settings = yield* ServerSettings.ServerSettingsService;
      const projectsFolder = path.join(home, "Movies", "Stellar");

      assert.deepStrictEqual(yield* videoProjects.projectsFolder, {
        path: projectsFolder,
        exists: false,
        unavailable: null,
      });
      const project = yield* videoProjects.createFromIdea({ title: "Jollibee" });
      assert.strictEqual(project.workspaceRoot, path.join(projectsFolder, "Jollibee", "Stellar"));
      assert.isTrue((yield* videoProjects.projectsFolder).exists);

      const unplugged = "/Volumes/stellar-test-unplugged-drive/Short-Form Projects";
      yield* settings.updateSettings({ projectsFolder: unplugged });
      const folder = yield* videoProjects.projectsFolder;
      assert.isFalse(folder.exists);
      assert.include(folder.unavailable, "stellar-test-unplugged-drive, which isn't connected");
      const refused = yield* videoProjects.createFromIdea({ title: "Phở" }).pipe(Effect.flip);
      assert.include(refused.message, "which isn't connected");
      const chosen = yield* videoProjects
        .createFromIdea({ title: "Phở", parentFolder: `${unplugged}/Project Folders` })
        .pipe(Effect.flip);
      assert.include(chosen.message, "which isn't connected");
      assert.isFalse(yield* fs.exists("/Volumes/stellar-test-unplugged-drive"));
      assert.deepStrictEqual(created, [project.workspaceRoot]);
    }).pipe(
      Effect.provide(
        VideoProjects.layer.pipe(
          Layer.provideMerge(withProjects(created)),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, noTranscriber)),
        ),
      ),
      Effect.provideServiceEffect(
        HostProcess.HomeDirectory,
        FileSystem.FileSystem.pipe(
          Effect.flatMap((fs) => fs.makeTempDirectoryScoped({ prefix: "stellar-home-" })),
          Effect.provide(NodeServices.layer),
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
    const timeline = "timelines/Cut.otio";
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
      // The footage itself isn't there, so nothing says where its words are quiet.
      "# Not measured: Footage/a.MOV is not on this machine.",
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
      "# Not measured: Footage/a.MOV is not on this machine.",
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

it.live("refuses an agent's edit when the user saved while its sound was being measured", () => {
  const created: Array<string> = [];
  let saveDuringDecode: Effect.Effect<void> = Effect.void;
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-video-race-" });
    const videoProjects = yield* VideoProjects.VideoProjects;
    const { workspaceRoot } = yield* videoProjects.createFromIdea({
      title: "Race",
      parentFolder: root,
    });
    const mediaRoot = path.dirname(workspaceRoot);
    const timeline = "timelines/Cut.otio";
    const file = path.join(workspaceRoot, timeline);
    const text = serializeTimeline(
      footageStringout(
        [{ target: "Footage/a.MOV", duration: 4, width: 1080, height: 1920 }],
        mediaRoot,
      ),
    );
    yield* fs.writeFileString(file, text);
    yield* fs.writeFileString(
      path.join(mediaRoot, "Footage", "a.MOV"),
      JSON.stringify({ seconds: 4, loud: [[0.5, 0.8]] }),
    );
    yield* fs.writeFileString(
      path.join(mediaRoot, "Audio", "a.words.json"),
      JSON.stringify([{ w: "So", start: 0.5, end: 0.8 }]),
    );
    // The user's save lands while ffmpeg is still decoding for the agent's edit.
    const saved = `${text}\n`;
    saveDuringDecode = fs.writeFileString(file, saved).pipe(Effect.orDie);
    const refused = yield* videoProjects
      .editTimeline({
        workspaceRoot,
        timeline,
        summary: "Cut the tail.",
        edits: [{ kind: "removeRange", start: 120, end: 180, ripple: true }],
      })
      .pipe(Effect.flip);
    assert.include(refused.message, "changed while this edit was being worked out");
    assert.strictEqual(yield* fs.readFileString(file), saved);
  }).pipe(
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provideMerge(withProjects(created)),
        Layer.provideMerge(
          fakeDecoder(
            [],
            Effect.suspend(() => saveDuringDecode),
          ),
        ),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, noTranscriber)),
      ),
    ),
    Effect.scoped,
  );
});

it.live("makes the first edit to the footage timeline on a cut of its own", () => {
  const created: Array<string> = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-video-cut-" });
    const videoProjects = yield* VideoProjects.VideoProjects;
    const { workspaceRoot } = yield* videoProjects.createFromIdea({
      title: "First",
      parentFolder: root,
    });
    const footage = "timelines/Footage.otio";
    const footageText = serializeTimeline(
      footageStringout(
        [{ target: "Footage/a.MOV", duration: 2, width: 1080, height: 1920 }],
        path.dirname(workspaceRoot),
      ),
    );
    yield* fs.writeFileString(path.join(workspaceRoot, footage), footageText);

    const edited = yield* videoProjects.editTimeline({
      workspaceRoot,
      timeline: footage,
      summary: "Cut the first second.",
      edits: [{ kind: "removeRange", start: 0, end: 60, ripple: true }],
    });
    const cutPath = "timelines/Rough cut.otio";
    assert.strictEqual(edited.timeline, cutPath);
    assert.include(edited.changes, "Made timelines/Rough cut.otio from the footage timeline");
    // The footage timeline is as it was, and the cut can step back to the uncut footage.
    assert.strictEqual(yield* fs.readFileString(path.join(workspaceRoot, footage)), footageText);
    const cut = JSON.parse(yield* fs.readFileString(path.join(workspaceRoot, cutPath))) as Timeline;
    assert.strictEqual(cut.name, "Rough cut");
    assert.notProperty(cut.metadata["stellar"] as object, "generated");
    assert.deepStrictEqual(
      (yield* videoProjects.listVersions({ workspaceRoot, timeline: cutPath })).versions
        .map((version) => version.label)
        .toReversed(),
      ["Started from the footage", "Edited by an agent"],
    );

    // With a cut there, an edit aimed at the footage timeline is sent to it, by an agent or a client.
    const refused = yield* videoProjects
      .editTimeline({
        workspaceRoot,
        timeline: footage,
        summary: "Again.",
        edits: [{ kind: "removeRange", start: 0, end: 10, ripple: true }],
      })
      .pipe(Effect.flip);
    assert.include(refused.message, "Edit a cut instead: timelines/Rough cut.otio");
    const refusedCommit = yield* videoProjects
      .commitTimeline({ workspaceRoot, timeline: footage, contents: footageText })
      .pipe(Effect.flip);
    assert.include(refusedCommit.message, "Edit a cut instead");
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

// Stands in for ffmpeg decoding audio, which CI doesn't have: a "recording" is JSON of its
// length and the stretches that sound, played back as a tone at a tenth of full scale. A
// recording that says "no decoder" is one this machine has no ffmpeg for.
const fakeDecoder = (decoded: Array<string>, onDecode: Effect.Effect<void> = Effect.void) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      return ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) return yield* real.spawn(command);
          const args = command.args.map(String);
          if (command.command !== "ffmpeg" || !args.includes("s16le")) {
            return yield* real.spawn(command);
          }
          const media = args[args.indexOf("-i") + 1] ?? "";
          const spec = yield* fs.readFileString(media).pipe(Effect.orDie);
          if (spec === "no decoder") {
            return yield* real.spawn(ChildProcess.make("/nonexistent/stellar-test-ffmpeg", []));
          }
          decoded.push(media);
          yield* onDecode;
          const { seconds, loud } = JSON.parse(spec) as {
            seconds: number;
            loud: ReadonlyArray<readonly [number, number]>;
          };
          const pcm = new Uint8Array(seconds * 16000 * 2);
          const samples = new DataView(pcm.buffer);
          for (let i = 0; i < pcm.length / 2; i++) {
            const at = i / 16000;
            const sounding = loud.some(([from, to]) => at >= from && at < to);
            samples.setInt16(i * 2, sounding ? Math.sin(at * 2764.6) * 3276 : 0, true);
          }
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(pcm),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );
    }),
  ).pipe(Layer.provide(NodeServices.layer));

it.live(
  "puts word cuts on measured quiet and refuses an agent's cut inside a sounding word",
  () => {
    const created: Array<string> = [];
    const decoded: Array<string> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-video-levels-" });
      const videoProjects = yield* VideoProjects.VideoProjects;
      const { workspaceRoot } = yield* videoProjects.createFromIdea({
        title: "Levels",
        parentFolder: root,
      });
      const mediaRoot = path.dirname(workspaceRoot);
      const timeline = "timelines/Cut.otio";
      const file = path.join(workspaceRoot, timeline);
      yield* fs.writeFileString(
        file,
        serializeTimeline(
          footageStringout(
            [
              { target: "Footage/a.MOV", duration: 4, width: 1080, height: 1920 },
              { target: "Footage/b.MOV", duration: 1, width: 1080, height: 1920 },
            ],
            mediaRoot,
          ),
        ),
      );
      // "um" is timed 60 ms before it sounds, and only a 30 ms dip at 1.44 s parts it from "we".
      yield* fs.writeFileString(
        path.join(mediaRoot, "Footage", "a.MOV"),
        JSON.stringify({
          seconds: 4,
          loud: [
            [0.5, 0.8],
            [1.06, 1.44],
            [1.47, 2.1],
            [3.3, 3.6],
          ],
        }),
      );
      yield* fs.writeFileString(path.join(mediaRoot, "Footage", "b.MOV"), "no decoder");
      yield* fs.writeFileString(
        path.join(mediaRoot, "Audio", "a.words.json"),
        JSON.stringify([
          { w: "So", start: 0.5, end: 0.8 },
          { w: "um", start: 1, end: 1.3 },
          { w: "we", start: 1.5, end: 1.8 },
          { w: "go", start: 1.8, end: 2.1 },
          { w: "now", start: 3.3, end: 3.6 },
        ]),
      );
      yield* fs.writeFileString(
        path.join(mediaRoot, "Audio", "b.words.json"),
        JSON.stringify([{ w: "hey", start: 0.2, end: 0.8 }]),
      );
      const lines = (text: string) =>
        text
          .split("\n")
          .filter((line) => !line.startsWith("# Footage"))
          .map((line) => line.replace(/#\d+:\d+(~\d+)*/g, "#id"));

      const read = yield* videoProjects.readWords({ workspaceRoot });
      assert.deepStrictEqual(lines(read.text), [
        "A1 0-240 #id a.MOV",
        "1:So@30 2:um@60 3:we@90 4:go@108 (1.20s quiet) 5:now@198",
        "A1 240-300 #id b.MOV",
        "6:hey@252",
        "# Not measured: ffmpeg is not installed on this machine, so audio levels can't be measured.",
      ]);
      // Measured once and kept beside the transcript; the second read decodes nothing.
      yield* videoProjects.readWords({ workspaceRoot });
      assert.deepStrictEqual(decoded, [path.join(mediaRoot, "Footage", "a.MOV")]);
      assert.isTrue(yield* fs.exists(path.join(mediaRoot, "Audio", "a.levels.json")));

      const [a, b] = layoutTimeline(
        JSON.parse(yield* fs.readFileString(file)) as Timeline,
      ).tracks.flatMap((track) => (track.kind === "Audio" ? track.clips : []));
      const before = yield* fs.readFileString(file);
      // Frame 72 is 1.2 s into a.MOV, in the middle of "um".
      const refused = yield* videoProjects
        .editTimeline({
          workspaceRoot,
          timeline,
          edits: [
            { kind: "addMarker", frame: 10, name: "note" },
            { kind: "removeRange", start: 72, end: 150, ripple: true },
          ],
          summary: "Cut the false start.",
        })
        .pipe(Effect.flip);
      assert.strictEqual(
        refused.message,
        `Edit 2 (removeRange): it would end #${a?.key} (a.MOV, A1) inside word 2 "um" while it sounds: -23 dBFS at the edge, where this recording's speech sits at -23 and its room tone at -100. The nearest quiet is 9 frames (0.15s earlier) at -100 dBFS. Cut by word instead (removeWords, or trimPause with afterWord), which puts the edge on measured quiet, or move the edge to the quiet point. Nothing was changed.`,
      );
      assert.strictEqual(yield* fs.readFileString(file), before);
      // A refused call is no edit to review and no version.
      assert.deepStrictEqual(
        (yield* videoProjects.listEdits({ workspaceRoot, timeline })).edits,
        [],
      );
      const versionsBefore = (yield* videoProjects.listVersions({ workspaceRoot, timeline }))
        .versions.length;

      // A clip that can't be measured is not refused, and its word cut says it was not measured.
      const unmeasured = yield* videoProjects.editTimeline({
        workspaceRoot,
        timeline,
        edits: [{ kind: "trim", clipId: b?.key ?? "", edge: "end", frame: 270 }],
      });
      assert.isUndefined(unmeasured.cuts);

      const cut = yield* videoProjects.editTimeline({
        workspaceRoot,
        timeline,
        edits: [
          { kind: "removeWords", fromWord: 2, toWord: 2, ripple: true },
          { kind: "trimPause", afterWord: 4 },
          { kind: "trimPause", afterWord: 1, leave: 1 },
        ],
        summary: "Cut the um and the long pause.",
      });
      assert.deepStrictEqual(cut.cuts?.split("\n"), [
        "word 2: frames 60-87, start at -100 dBFS, end moved 0.05s earlier to -100 dBFS",
        "the pause after 4:go: 1.20s of quiet (at most -100 dBFS), removed frames 135-192, 0.25s left",
        "the pause after 1:So: 0.25s of quiet, already about 1.00s; nothing removed",
        "Not measured: ffmpeg is not installed on this machine, so audio levels can't be measured.",
      ]);
      const joins = yield* videoProjects.readWords({ workspaceRoot, action: "joins" });
      assert.deepStrictEqual(lines(joins.text).slice(2), [
        "J A1 @60 (1.00s) #id|#id: 1:So [-100 dBFS] | [-100 dBFS] 2:we 3:go · ok",
        "J A1 @108 (1.80s) #id|#id: 2:we 3:go [-100 dBFS] | [-100 dBFS] 4:now · ok",
        "J A1 @156 (2.60s) #id|#id: 4:now [-100 dBFS] | [unmeasured] 5:hey · ok",
        "# Levels in dBFS: a.MOV speech -23, room tone -100",
        "# Not measured: ffmpeg is not installed on this machine, so audio levels can't be measured.",
      ]);

      // Review listens to what really went: the word cut where it was moved to, not its timings.
      const reviewed = yield* videoProjects.listEdits({ workspaceRoot, timeline });
      assert.deepStrictEqual(
        reviewed.edits.map((edit) => [edit.number, edit.removed]),
        [[1, { start: 60, end: 87 }]],
      );
      assert.strictEqual(
        (yield* videoProjects.listVersions({ workspaceRoot, timeline })).versions.length,
        versionsBefore + 2,
      );

      // A person cutting in Stellar hears their own cut and is not refused.
      yield* videoProjects.editTimeline({
        workspaceRoot,
        timeline,
        by: "user",
        edits: [{ kind: "removeRange", start: 36, end: 40, ripple: false }],
      });
    }).pipe(
      Effect.provide(
        VideoProjects.layer.pipe(
          Layer.provideMerge(withProjects(created)),
          Layer.provideMerge(fakeDecoder(decoded)),
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, noTranscriber)),
        ),
      ),
      Effect.scoped,
    );
  },
);

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
    const timeline = "timelines/Cut.otio";
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

    const unsized = yield* videoProjects
      .editTimeline({ workspaceRoot, timeline, edits: [{ kind: "slip", clipId: "0:0" }] })
      .pipe(Effect.flip);
    assert.strictEqual(unsized.message, "Edit 1 (slip): needs frames. Nothing was changed.");
    // A roll moves the cut on the picture and its linked sound together.
    const rolled = yield* videoProjects.editTimeline({
      workspaceRoot,
      timeline,
      edits: [{ kind: "roll", clipId: "0:0", edge: "end", frame: 130 }],
    });
    assert.deepStrictEqual(rolled.text.split("\n").slice(1), [
      "V1 0-130 #0:0 a.MOV",
      "V1 130-180 #0:1 b.MOV",
      "A1 0-130 #1:0 a.MOV",
      "A1 130-180 #1:1 b.MOV",
    ]);

    const edited = yield* videoProjects.editTimeline({
      workspaceRoot,
      timeline,
      edits: [{ kind: "removeRange", start: 0, end: 130, ripple: true }],
    });
    assert.deepStrictEqual(
      edited.text
        .split("\n")
        .slice(1)
        .map((line) => line.replace(/#\S+/, "#id")),
      ["V1 0-50 #id b.MOV", "A1 0-50 #id b.MOV"],
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
      // A conformed copy shares its original's transcript and is never transcribed itself.
      "Footage/00 Raw/a_5994.mov",
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
    assert.strictEqual(
      yield* findTranscript(mediaRoot, "Footage/00 Raw/a_5994.mov"),
      path.join(mediaRoot, "Audio", "transcripts", "a.words.json"),
    );
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

    // Premiere's save is a snapshot in the history's store; without it there is nothing to plan from.
    yield* fs.remove(path.join(workspaceRoot, "timelines", ".history"), { recursive: true });
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

it.live("plans an inserted still as a step that places its file", () => {
  const created: Array<string> = [];
  return Effect.gen(function* () {
    const { fs, path, root, premiereProjectPath } = yield* setup;
    const videoProjects = yield* VideoProjects.VideoProjects;
    yield* fs.writeFile(
      premiereProjectPath,
      prprojWithSequences([
        {
          id: "seq-1",
          name: "Polish v1",
          clips: [
            { name: "a.MOV", start: 0, end: 100 },
            { name: "b.MOV", start: 100, end: 200 },
          ],
        },
      ]),
    );
    const { workspaceRoot, timelinePath } = yield* videoProjects.createFromPremiere({
      premiereProjectPath,
      sequenceId: "seq-1",
    });
    const mediaRoot = path.join(root, "SFUniqlo");
    yield* fs.makeDirectory(path.join(mediaRoot, "Footage"), { recursive: true });
    yield* fs.writeFileString(path.join(mediaRoot, "Footage", "card.png"), "png");
    const insert = (media: string) =>
      videoProjects.editTimeline({
        workspaceRoot,
        timeline: timelinePath,
        edits: [{ kind: "insert", media, toTrack: "V1", startFrame: 100, duration: 30 }],
      });
    const refused = yield* insert("/elsewhere/card.png").pipe(Effect.flip);
    assert.match(
      refused.message,
      /^Edit 1 \(insert\): \/elsewhere\/card.png is outside the project/,
    );
    const edited = yield* insert("Footage/card.png");
    assert.include(edited.text, "V1 100-130 #V1@100 card.png");
    assert.include(edited.text, "V1 130-230 #");

    const planned = yield* videoProjects.pushPlan({ workspaceRoot });
    assert.strictEqual(
      planned.plan,
      `1. insert "card.png" on V1 (picture only) at 3.333333s-4.333333s (frames 100-130; a still of ${path.join(mediaRoot, "Footage", "card.png")}): everything from 3.333333s on every track moves 1.000s later`,
    );
    assert.deepStrictEqual(planned.manual, []);
    assert.include(planned.instructions, "importing it when it isn't there");
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

/**
 * Stands in for the host's process list and app launcher: Premiere runs once `open` or
 * `start` has been called, or from the start when `running`. Records every such command.
 */
const fakeLauncher = (calls: Array<string>, options: { readonly running: boolean }) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      let running = options.running;
      const answer = (stdout: string) =>
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      return ChildProcessSpawner.make((command) => {
        if (!ChildProcess.isStandardCommand(command)) return real.spawn(command);
        const line = [command.command, ...command.args.map(String)].join(" ");
        switch (command.command) {
          case "ps":
          case "tasklist":
            return Effect.succeed(
              answer(
                running
                  ? "/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026\n"
                  : "launchd\n",
              ),
            );
          case "open":
          case "cmd.exe":
            calls.push(line);
            running = true;
            return Effect.succeed(answer(""));
          default:
            return real.spawn(command);
        }
      });
    }),
  ).pipe(Layer.provide(NodeServices.layer));

const openLayer = (created: Array<string>, calls: Array<string>, running: boolean) =>
  VideoProjects.layer.pipe(
    Layer.provideMerge(withProjects(created)),
    Layer.provideMerge(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        noTranscriber,
        fakeLauncher(calls, { running }),
      ),
    ),
  );

/** A linked project, and an Applications folder holding these Premiere releases. */
const openSetup = (releases: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { fs, path, root, premiereProjectPath } = yield* setup;
    const videoProjects = yield* VideoProjects.VideoProjects;
    const { workspaceRoot } = yield* videoProjects.createFromPremiere({
      premiereProjectPath,
      sequenceId: "seq-1",
    });
    const applications = path.join(root, "Applications");
    for (const release of releases) {
      yield* fs.makeDirectory(path.join(applications, release, `${release}.app`), {
        recursive: true,
      });
    }
    return { videoProjects, workspaceRoot, premiereProjectPath, applications, path };
  });

it.live("opens the project with the newest Premiere release and waits for it to run", () => {
  const created: Array<string> = [];
  const calls: Array<string> = [];
  return Effect.gen(function* () {
    const { videoProjects, workspaceRoot, premiereProjectPath, applications, path } =
      yield* openSetup([
        "Adobe Premiere Pro 2025",
        "Adobe Premiere Pro 2026",
        "Adobe Premiere Pro (Beta)",
      ]);
    const app = path.join(applications, "Adobe Premiere Pro 2026", "Adobe Premiere Pro 2026.app");
    const opened = yield* videoProjects
      .openInPremiere({ workspaceRoot })
      .pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(PremiereApp.ApplicationFolders, [applications]),
      );
    assert.deepStrictEqual(calls, [`open -a ${app} ${premiereProjectPath}`]);
    assert.deepStrictEqual(
      [opened.project, opened.app, opened.wasRunning, opened.premiereRunning],
      [premiereProjectPath, app, false, true],
    );
    assert.match(opened.next, /^Premiere is starting with SFUniqlo.prproj/);
  }).pipe(Effect.provide(openLayer(created, calls, false)), Effect.scoped);
});

it.live("brings an open Premiere forward, and opens with the app Windows picks", () => {
  const created: Array<string> = [];
  const calls: Array<string> = [];
  return Effect.gen(function* () {
    const { videoProjects, workspaceRoot, premiereProjectPath, applications } = yield* openSetup([
      "Adobe Premiere Pro 2026",
    ]);
    const mac = yield* videoProjects
      .openInPremiere({ workspaceRoot })
      .pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(PremiereApp.ApplicationFolders, [applications]),
      );
    assert.deepStrictEqual([mac.wasRunning, mac.premiereRunning], [true, true]);
    assert.match(mac.next, /^Premiere was running/);
    const windows = yield* videoProjects
      .openInPremiere({ workspaceRoot })
      .pipe(Effect.provideService(HostProcess.Platform, "win32"));
    assert.strictEqual(windows.app, null);
    assert.strictEqual(calls[1], `cmd.exe /c start  ${premiereProjectPath}`);
  }).pipe(Effect.provide(openLayer(created, calls, true)), Effect.scoped);
});

it.live("says why it can't open Premiere: not installed, or a host it doesn't run on", () => {
  const created: Array<string> = [];
  const calls: Array<string> = [];
  return Effect.gen(function* () {
    const { videoProjects, workspaceRoot, applications } = yield* openSetup([]);
    const open = (platform: NodeJS.Platform) =>
      videoProjects.openInPremiere({ workspaceRoot }).pipe(
        Effect.provideService(HostProcess.Platform, platform),
        Effect.provideService(PremiereApp.ApplicationFolders, [applications]),
        Effect.flip,
        Effect.map((error) => error.message),
      );
    assert.match(yield* open("darwin"), /^Premiere Pro isn't installed in \/Applications/);
    assert.match(yield* open("linux"), /^Premiere Pro runs on macOS and Windows only/);
    assert.deepStrictEqual(calls, []);
  }).pipe(Effect.provide(openLayer(created, calls, false)), Effect.scoped);
});

// Stands in for ffmpeg and ffprobe, which CI doesn't have: a "recording" is its length in
// seconds as text, encoding copies that (or the length of the stretch asked for), and probing
// reads it back. Every other command runs for real. `encodes` collects each ffmpeg call's args.
const recordingEncoder = (encodes: Array<ReadonlyArray<string>>) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const real = yield* ChildProcessSpawner.ChildProcessSpawner;
      const answer = (stdout: string) =>
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode(stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      return ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (!ChildProcess.isStandardCommand(command)) return yield* real.spawn(command);
          const args = command.args.map(String);
          const target = args.at(-1) ?? "";
          if (command.command === "ffprobe") {
            return answer(yield* fs.readFileString(target).pipe(Effect.orDie));
          }
          if (command.command !== "ffmpeg" || !args.includes("-i"))
            return yield* real.spawn(command);
          encodes.push(args);
          const after = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
          const whole = yield* fs.readFileString(after("-i")).pipe(Effect.orDie);
          const seconds = args.includes("-to")
            ? String(Math.round((Number(after("-to")) - Number(after("-ss"))) * 100) / 100)
            : whole;
          yield* fs.writeFileString(target, seconds).pipe(Effect.orDie);
          return answer("");
        }),
      );
    }),
  ).pipe(Layer.provide(NodeServices.layer));
const fakeEncoder = recordingEncoder([]);

it.live("keeps a stereo voice-over take in two channels and folds a mono one to one", () => {
  const created: Array<string> = [];
  const encodes: Array<ReadonlyArray<string>> = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-video-vo-" });
    const workspaceRoot = path.join(root, "Short", ".stellar");
    yield* fs.makeDirectory(workspaceRoot, { recursive: true });
    created.push(workspaceRoot);
    const videoProjects = yield* VideoProjects.VideoProjects;
    const recording = new TextEncoder().encode("2");
    for (const channels of [2, 1, undefined] as const) {
      yield* videoProjects.saveVoiceOver({ workspaceRoot, recording, channels });
    }
    const channelsOf = (args: ReadonlyArray<string>) =>
      args.includes("-ac") ? args[args.indexOf("-ac") + 1] : "as recorded";
    assert.deepStrictEqual(encodes.filter((args) => args.includes("pcm_s24le")).map(channelsOf), [
      "2",
      "1",
      "as recorded",
    ]);
  }).pipe(
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provide(recordingEncoder(encodes)),
        Layer.provideMerge(withProjects(created)),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, noTranscriber)),
      ),
    ),
    Effect.scoped,
  );
});

it.live("places a line's take on a cut, and re-recording the line re-times only that beat", () => {
  const created: Array<string> = [];
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stellar-video-voice-" });
    const videoProjects = yield* VideoProjects.VideoProjects;
    const { workspaceRoot } = yield* videoProjects.createFromIdea({
      title: "Jollibee",
      parentFolder: root,
    });
    const mediaRoot = path.dirname(workspaceRoot);
    const timeline = "timelines/Cut.otio";
    const shot = (name: string) => ({
      OTIO_SCHEMA: "Clip.2" as const,
      name,
      source_range: timeRange(0, 60, 30),
      media_references: {
        DEFAULT_MEDIA: {
          OTIO_SCHEMA: "ExternalReference.1" as const,
          target_url: `Footage/${name}`,
          metadata: {},
        },
      },
      active_media_reference_key: "DEFAULT_MEDIA" as const,
      enabled: true,
      metadata: { stellar: { id: name } },
    });
    const cut: Timeline = {
      OTIO_SCHEMA: "Timeline.1",
      name: "Cut",
      global_start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: 30 },
      tracks: {
        OTIO_SCHEMA: "Stack.1",
        name: "tracks",
        enabled: true,
        metadata: {},
        children: [
          {
            OTIO_SCHEMA: "Track.1",
            name: "V1",
            kind: "Video",
            children: [shot("one.mov"), shot("two.mov"), shot("three.mov")],
            enabled: true,
            metadata: {},
          },
        ],
      },
      metadata: {},
    };
    yield* fs.writeFileString(path.join(workspaceRoot, timeline), serializeTimeline(cut));
    // The proxy index is where a clip's full length comes from; two.mov runs for ten seconds.
    yield* fs.makeDirectory(path.join(workspaceRoot, "proxies"), { recursive: true });
    yield* fs.writeFileString(
      path.join(workspaceRoot, "proxies", "index.json"),
      JSON.stringify({
        version: 1,
        media: { "Footage/two.mov": { key: "", width: 1080, height: 1920, duration: 10 } },
      }),
    );
    yield* videoProjects.saveScript({
      workspaceRoot,
      text: "Line one is here.\nLine two comes next.\nLine three ends it.",
    });
    const spans = Effect.gen(function* () {
      const saved = JSON.parse(
        yield* fs.readFileString(path.join(workspaceRoot, timeline)),
      ) as Timeline;
      return layoutTimeline(saved).tracks.flatMap((track) =>
        track.clips.map((item) => `${track.name} ${item.startFrame}-${item.endFrame} ${item.key}`),
      );
    });
    const record = (beatId: string, seconds: string) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(mediaRoot, "Audio", `${beatId}.m4a`), seconds);
        return yield* videoProjects.saveTake({
          workspaceRoot,
          beatId,
          path: `Audio/${beatId}.m4a`,
          timeline,
        });
      });

    yield* record("b1", "2");
    yield* record("b2", "2");
    const recorded = yield* record("b3", "2");
    assert.deepStrictEqual(
      recorded.beats.map((beat) => [beat.id, beat.chosen, beat.placed, beat.takes[0]?.path]),
      [
        ["b1", "t1", null, "Audio/VO/VO b1 t1.wav"],
        ["b2", "t2", null, "Audio/VO/VO b2 t2.wav"],
        ["b3", "t3", null, "Audio/VO/VO b3 t3.wav"],
      ],
    );
    yield* videoProjects.applyVoiceOver({ workspaceRoot, timeline });
    const placed = [
      "V1 0-60 one.mov",
      "V1 60-120 two.mov",
      "V1 120-180 three.mov",
      "A1 0-60 vo-b1-t1",
      "A1 60-120 vo-b2-t2",
      "A1 120-180 vo-b3-t3",
    ];
    assert.deepStrictEqual(yield* spans, placed);

    // The newest take is the line's chosen one.
    yield* fs.writeFileString(path.join(mediaRoot, "Audio", "retake.m4a"), "3");
    const retaken = yield* videoProjects.saveTake({
      workspaceRoot,
      beatId: "b2",
      path: "Audio/retake.m4a",
      timeline,
    });
    assert.deepStrictEqual(
      retaken.beats.map((beat) => [beat.chosen, beat.placed?.takeId]),
      [
        ["t1", "t1"],
        ["t4", "t2"],
        ["t3", "t3"],
      ],
    );
    assert.strictEqual(retaken.beats[1]?.takes[1]?.source, "imported");
    assert.deepStrictEqual(yield* spans, placed);

    const applied = yield* videoProjects.applyVoiceOver({ workspaceRoot, timeline });
    assert.deepStrictEqual(applied.changes, [
      "b2: take t4 is on A1 at frames 60-150. The line went from 60 to 90 frames, so everything after it moved +30 frames and 1 clip under it was re-timed.",
    ]);
    assert.deepStrictEqual(yield* spans, [
      "V1 0-60 one.mov",
      "V1 60-150 two.mov",
      "V1 150-210 three.mov",
      "A1 0-60 vo-b1-t1",
      "A1 60-150 vo-b2-t4",
      "A1 150-210 vo-b3-t3",
    ]);
    // With no transcript of the takes, a line is still found where its take sits.
    const script = yield* videoProjects.readScript({ workspaceRoot, timeline });
    assert.deepStrictEqual(
      script.beats.map((beat) => [beat.startFrame, beat.endFrame]),
      [
        [0, 60],
        [60, 150],
        [150, 210],
      ],
    );

    const wrongLine = yield* videoProjects
      .chooseTake({ workspaceRoot, beatId: "b1", takeId: "t4" })
      .pipe(Effect.flip);
    assert.strictEqual(
      wrongLine.message,
      "Can't choose that take: take t4 was recorded for b2, not b1.",
    );
    const noLine = yield* record("b9", "2").pipe(Effect.flip);
    assert.strictEqual(noLine.message, "The script has no line b9. Its lines are b1, b2, b3.");
    const footage = yield* videoProjects
      .applyVoiceOver({ workspaceRoot, timeline: "timelines/Footage.otio" })
      .pipe(Effect.flip);
    assert.include(footage.message, "The footage timeline is rebuilt whenever footage changes");

    assert.deepStrictEqual((yield* videoProjects.readVoiceOver({ workspaceRoot })).loose, []);

    // A read of the whole script is cut into a take per line it says, with the words it had.
    yield* fs.writeFileString(path.join(mediaRoot, "Audio/VO/whole.wav"), "9");
    yield* fs.writeFileString(
      path.join(mediaRoot, "Audio", "whole.words.json"),
      JSON.stringify([
        { w: "Line", start: 1, end: 1.2 },
        { w: "one", start: 1.2, end: 1.4 },
        { w: "is", start: 1.4, end: 1.5 },
        { w: "here.", start: 1.5, end: 2 },
        { w: "Line", start: 4, end: 4.2 },
        { w: "three", start: 4.2, end: 4.5 },
        { w: "ends", start: 4.5, end: 4.8 },
        { w: "it.", start: 4.8, end: 5 },
      ]),
    );
    const split = yield* videoProjects.splitTake({
      workspaceRoot,
      path: "Audio/VO/whole.wav",
      timeline,
    });
    assert.deepStrictEqual(split.loose, ["Audio/VO/whole.wav"]);
    assert.deepStrictEqual(split.changes, [
      "b1: take t5 (1.4s) cut from 0.85-2.30s.",
      "b3: take t6 (1.4s) cut from 3.85-5.30s.",
    ]);
    assert.deepStrictEqual(
      split.beats.map((beat) => beat.chosen),
      ["t5", "t4", "t6"],
    );
    assert.deepStrictEqual(
      JSON.parse(yield* fs.readFileString(path.join(mediaRoot, "Audio", "VO b3 t6.words.json"))),
      [
        { w: "Line", start: 0.15, end: 0.35 },
        { w: "three", start: 0.35, end: 0.65 },
        { w: "ends", start: 0.65, end: 0.95 },
        { w: "it.", start: 0.95, end: 1.15 },
      ],
    );
  }).pipe(
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provide(fakeEncoder),
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
      Array.from({ length: 7 }, () => "todo"),
    );
    assert.strictEqual(empty.render, null);
    assert.strictEqual(
      (yield* videoProjects.checkRender({ workspaceRoot }).pipe(Effect.flip)).message,
      "No timeline to check the export against. This project has: none.",
    );

    // What each step reads: Footage, intake.json, the proxy index.
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
    const timeline = "timelines/Cut.otio";
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
      "Run: 4 of 7 steps done; next: todo Premiere project: None linked (video_premiere_pull). video_preflight lists every step.",
    );

    // An edit to the timeline, or a newer export, makes the check stale.
    yield* videoProjects.editTimeline({
      workspaceRoot,
      timeline,
      edits: [{ kind: "removeRange", start: 0, end: 30, ripple: true }],
    });
    const edited = (yield* videoProjects.preflight({ workspaceRoot })).steps[5];
    assert.deepStrictEqual(
      [edited?.state, edited?.detail],
      ["warn", "Timeline changed since the check"],
    );
    yield* writeReport(yield* fs.readFileString(timelineFile));
    yield* fs.writeFileString(exportPath, "a longer export");
    const reExported = (yield* videoProjects.preflight({ workspaceRoot })).steps[5];
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

it.live(
  "keeps a version of every write, steps back and forward, and restores onto Premiere's latest save",
  () => {
    const created: Array<string> = [];
    return Effect.gen(function* () {
      const { fs, path, premiereProjectPath } = yield* setup;
      const videoProjects = yield* VideoProjects.VideoProjects;
      let saves = 0;
      const save = (aEnd: number) =>
        Effect.gen(function* () {
          yield* fs.writeFile(
            premiereProjectPath,
            prprojWithSequences([
              {
                id: "seq-1",
                name: "Polish v1",
                clips: [
                  { name: "a.MOV", start: 0, end: aEnd },
                  { name: "b.MOV", start: 100, end: 200 },
                  { name: "c.MOV", start: 200, end: 300 },
                ],
              },
            ]),
          );
          saves += 1;
          yield* fs.utimes(premiereProjectPath, 1_000_000 + saves, 1_000_000 + saves);
        });
      yield* save(100);
      const { workspaceRoot, timelinePath: timeline } = yield* videoProjects.createFromPremiere({
        premiereProjectPath,
        sequenceId: "seq-1",
      });
      const file = path.join(workspaceRoot, timeline);
      const lines = (text: string) =>
        text
          .split("\n")
          .filter((line) => !line.startsWith("#"))
          .map((line) => line.replace(/ #\S+/, ""));
      const versions = videoProjects.listVersions({ workspaceRoot, timeline });

      // The user leaves a note at a frame and commits it from the Timeline tab.
      const pulled = yield* fs.readFileString(file);
      const committed = serializeTimeline(
        applyEdits(JSON.parse(pulled) as Timeline, [
          {
            kind: "addMarker",
            markerId: "m1",
            frame: 250,
            name: "Cut too early",
            note: "end at the laugh",
          },
        ]),
      );
      yield* videoProjects.commitTimeline({ workspaceRoot, timeline, contents: committed });
      assert.strictEqual(yield* fs.readFileString(file), committed);
      const notATimeline = yield* videoProjects
        .commitTimeline({ workspaceRoot, timeline, contents: "{}" })
        .pipe(Effect.flip);
      assert.strictEqual(notATimeline.message, "What was sent is not a timeline.");

      // The agent finds the note in its read, acts on it and resolves it.
      const read = yield* videoProjects.readTimeline({ workspaceRoot });
      assert.deepStrictEqual(lines(read.text).slice(-1), [
        "M 250 user open Cut too early: end at the laugh",
      ]);
      const clipC = read.text
        .split("\n")
        .find((line) => line.includes("c.MOV"))
        ?.match(/#(\S+)/)?.[1];
      const unknownMarker = yield* videoProjects
        .editTimeline({
          workspaceRoot,
          timeline,
          edits: [{ kind: "setMarker", markerId: "nope", resolved: true }],
        })
        .pipe(Effect.flip);
      assert.strictEqual(
        unknownMarker.message,
        "Edit 1 (setMarker): no marker #nope. Nothing was changed.",
      );
      const answered = yield* videoProjects.editTimeline({
        workspaceRoot,
        timeline,
        edits: [
          { kind: "trim", clipId: clipC ?? "", edge: "end", frame: 250 },
          { kind: "setMarker", markerId: "#m1", resolved: true, note: "Trimmed to the laugh." },
          { kind: "addMarker", frame: 120, name: "Soft focus", note: "worth a look" },
        ],
      });
      assert.deepStrictEqual(lines(answered.text).slice(-3), [
        "V1 200-250 c.MOV",
        "M 120 agent open Soft focus: worth a look",
        "M 250 user done Cut too early: Trimmed to the laugh.",
      ]);
      const agentText = yield* fs.readFileString(file);

      const history = yield* versions;
      assert.deepStrictEqual(
        history.versions.map((version) => [version.id, version.by, version.label, version.changes]),
        [
          [
            "v3",
            "agent",
            "Edited by an agent",
            [
              "Trimmed c.MOV on V1 at 0:06: cut 1.7s off its end",
              "Added marker “Soft focus” at 0:04",
              "Changed the note and resolved of marker “Cut too early” at 0:08",
            ],
          ],
          ["v2", "user", "Committed in the Timeline tab", ["Added marker “Cut too early” at 0:08"]],
          ["v1", "premiere", "Pulled from Premiere", []],
        ],
      );
      assert.deepStrictEqual([history.undo, history.redo], ["v2", null]);

      // A version is read without changing anything, by the user and by an agent.
      const second = yield* videoProjects.readVersion({ workspaceRoot, timeline, version: "v2" });
      assert.strictEqual(second.contents, committed);
      assert.strictEqual(second.changesSince.length, 3);
      const listed = yield* videoProjects.readTimeline({ workspaceRoot, version: "list" });
      assert.match(
        listed.text.split("\n")[1] ?? "",
        /^v3 \d{4}-\d\d-\d\d \d\d:\d\dZ agent Edited by an agent: /,
      );
      const past = yield* videoProjects.readTimeline({ workspaceRoot, version: "v2" });
      assert.deepStrictEqual(lines(past.text).slice(-2), [
        "V1 200-300 c.MOV",
        "M 250 user open Cut too early: end at the laugh",
      ]);
      assert.include(past.changes, "Changed from v2 to the timeline now:");
      assert.strictEqual(yield* fs.readFileString(file), agentText);

      // Undo crosses the commit, and redo comes back; each step is itself a version.
      const undone = yield* videoProjects.restoreVersion({ workspaceRoot, timeline, step: "undo" });
      assert.strictEqual(yield* fs.readFileString(file), committed);
      assert.deepStrictEqual(
        [undone.versions[0]?.label, undone.undo, undone.redo],
        ["Undo: back to v2", "v1", "v3"],
      );
      const redone = yield* videoProjects.restoreVersion({ workspaceRoot, timeline, step: "redo" });
      assert.strictEqual(yield* fs.readFileString(file), agentText);
      assert.deepStrictEqual([redone.undo, redone.redo], ["v2", null]);
      const nothing = yield* videoProjects
        .restoreVersion({ workspaceRoot, timeline, step: "redo" })
        .pipe(Effect.flip);
      assert.include(nothing.message, "Nothing to redo");
      yield* videoProjects.restoreVersion({ workspaceRoot, timeline, step: "undo" });
      assert.strictEqual(yield* fs.readFileString(file), committed);

      // The user trims a.MOV in Premiere and saves. Bringing the agent's version back keeps
      // that trim: its edits go on top of Premiere's latest save, not its text over it.
      yield* save(80);
      const restored = yield* videoProjects.editTimeline({
        workspaceRoot,
        timeline,
        edits: [{ kind: "restoreVersion", version: "v3" }],
      });
      assert.deepStrictEqual(lines(restored.text), [
        "V1 0-80 a.MOV",
        "V1 100-200 b.MOV",
        "V1 200-250 c.MOV",
        "M 120 agent open Soft focus: worth a look",
        "M 250 user done Cut too early: Trimmed to the laugh.",
      ]);
      assert.include(restored.changes, "Kept from Premiere, changed there since v3:");
      assert.include(restored.changes, "Trimmed a.MOV on V1 at 0:00: cut 0.7s off its end");
      const after = yield* versions;
      assert.deepStrictEqual(
        after.versions.slice(0, 2).map((version) => [version.by, version.label]),
        [
          ["agent", "Restored v3"],
          ["premiere", "Merged Premiere's save with the edits made here"],
        ],
      );
      // Stepping back from the restore lands on what it replaced.
      yield* videoProjects.restoreVersion({ workspaceRoot, timeline, step: "undo" });
      assert.deepStrictEqual(lines((yield* videoProjects.readTimeline({ workspaceRoot })).text), [
        "V1 0-80 a.MOV",
        "V1 100-200 b.MOV",
        "V1 200-300 c.MOV",
        "M 250 user open Cut too early: end at the laugh",
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
  },
);
