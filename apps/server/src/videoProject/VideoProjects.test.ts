import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NodeZlib from "node:zlib";

import * as ProjectService from "../project/ProjectService.ts";
import * as VideoProjects from "./VideoProjects.ts";

// The smallest project Premiere's reader accepts: one sequence with an empty video track group.
const prproj = NodeZlib.gzipSync(`<?xml version="1.0" encoding="UTF-8" ?>
<PremiereData Version="3">
<VideoTrackGroup ObjectID="1"><TrackGroup><FrameRate>4237833600</FrameRate></TrackGroup><FrameRect>0,0,1080,1920</FrameRect></VideoTrackGroup>
<Sequence ObjectUID="seq-1"><TrackGroups><TrackGroup Index="0"><First>v</First><Second ObjectRef="1"/></TrackGroup></TrackGroups><Name>Polish v1</Name></Sequence>
</PremiereData>`);

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
    Effect.scoped,
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provideMerge(withProjects([])),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
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
    Effect.scoped,
    Effect.provide(
      VideoProjects.layer.pipe(
        Layer.provideMerge(withProjects(created)),
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
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
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);
