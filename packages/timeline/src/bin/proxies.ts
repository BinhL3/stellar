#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Argument, Command, Flag } from "effect/cli";

import { buildProjectProxies } from "../proxyBuilder.ts";

const proxiesCommand = Command.make(
  "proxies",
  {
    project: Argument.String("project").pipe(
      Argument.withDescription("Project directory holding timelines/*.otio."),
    ),
    concurrency: Flag.Int("concurrency").pipe(
      Flag.withDescription("Media files encoded at once."),
      Flag.withDefault(3),
    ),
  },
  (input) =>
    buildProjectProxies({
      projectDir: input.project,
      concurrency: input.concurrency,
      onProgress: (progress) =>
        progress.kind === "start"
          ? Console.log(`${progress.total} media file(s)`)
          : Console.log(
              `[${progress.done}/${progress.total}] ${progress.error ? `! ${progress.target}: ${progress.error}` : progress.target}`,
            ),
    }).pipe(Effect.flatMap((result) => Console.log(`Wrote ${result.indexPath}`))),
).pipe(
  Command.withDescription(
    "Make preview proxies, thumbnail strips and waveforms for every clip in a project's timelines.",
  ),
);

if (import.meta.main) {
  Command.run(proxiesCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
