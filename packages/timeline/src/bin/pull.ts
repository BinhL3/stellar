#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { Argument, Command, Flag } from "effect/cli";

import { compactView } from "../compactView.ts";
import { parsePrproj } from "../premiere/prproj.ts";
import { pullToProject } from "../pullToProject.ts";

const pull = Effect.fn("timeline.pull")(function* (input: {
  readonly project: string;
  readonly sequence: Option.Option<string>;
  readonly out: string;
  readonly mediaRoot: Option.Option<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const bytes = yield* fs.readFile(input.project);
  const project = parsePrproj(bytes);
  if (Option.isNone(input.sequence)) {
    for (const sequence of project.sequences)
      yield* Console.log(`${sequence.id}  ${sequence.name}`);
    return;
  }
  const pulled = yield* pullToProject({
    prproj: bytes,
    sequence: input.sequence.value,
    projectDir: input.out,
    ...(Option.isSome(input.mediaRoot) ? { mediaRoot: input.mediaRoot.value } : {}),
  });
  yield* Console.log(compactView(pulled.timeline));
  yield* Console.log(
    `\n${pulled.blobs.size} native effect blob(s) · ${pulled.warnings.length} warning(s)`,
  );
  for (const warning of pulled.warnings) yield* Console.log(`! ${warning}`);
});

const pullCommand = Command.make(
  "pull",
  {
    project: Argument.String("project").pipe(
      Argument.withDescription("Path to a .prproj file; it is only read."),
    ),
    sequence: Flag.String("sequence").pipe(
      Flag.withDescription("Sequence name or id. Without it, lists the project's sequences."),
      Flag.optional,
    ),
    out: Flag.String("out").pipe(
      Flag.withDescription(
        "Directory for timelines/<sequence>.otio and effects/<sha>.premiere.json.",
      ),
      Flag.withDefault("."),
    ),
    mediaRoot: Flag.String("media-root").pipe(
      Flag.withDescription("Media paths under this directory are stored relative to it."),
      Flag.optional,
    ),
  },
  pull,
).pipe(Command.withDescription("Pull a Premiere sequence into an OTIO timeline."));

if (import.meta.main) {
  Command.run(pullCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
