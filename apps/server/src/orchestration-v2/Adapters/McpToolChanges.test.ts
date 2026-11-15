import { describe, expect, it } from "vite-plus/test";

import {
  awaitsKnownMcpServer,
  compareMcpTools,
  type McpServerToolList,
  type McpToolFingerprints,
} from "./McpToolChanges.ts";

const qualifiedToolName = (server: string, tool: string) => `mcp__${server}__${tool}`;

const premiere = (
  tools: ReadonlyArray<readonly [string, string]>,
  overrides: Partial<McpServerToolList> = {},
): McpServerToolList => ({
  name: "premiere-pro",
  status: "connected",
  serverInfo: { version: "1.0.0" },
  tools: tools.map(([name, description]) => ({ name, description })),
  ...overrides,
});

const BASE = premiere([
  ["undo", "Undo the last edit."],
  ["redo", "Redo."],
  ["split_clip", "Split a clip."],
]);

const baseline = (statuses: ReadonlyArray<McpServerToolList> = [BASE]): McpToolFingerprints =>
  compareMcpTools({ previous: undefined, statuses, qualifiedToolName }).next;

const noteFor = (
  statuses: ReadonlyArray<McpServerToolList>,
  previous: McpToolFingerprints | undefined = baseline(),
) => compareMcpTools({ previous, statuses, qualifiedToolName }).note;

describe("compareMcpTools", () => {
  it("records the first turn's tools without a note", () => {
    const result = compareMcpTools({ previous: undefined, statuses: [BASE], qualifiedToolName });
    expect(result.note).toBeUndefined();
    expect(noteFor([BASE], result.next)).toBeUndefined();
  });

  it.each([
    ["the tools are unchanged", [BASE]],
    ["the server is still connecting", [{ ...BASE, status: "pending", tools: undefined }]],
    ["the server failed", [{ name: BASE.name, status: "failed" }]],
    ["the server is gone", []],
    [
      "a new server connected",
      [BASE, { name: "weather", status: "connected", tools: [{ name: "forecast" }] }],
    ],
  ] as const)("says nothing when %s", (_case, statuses) => {
    expect(noteFor(statuses)).toBeUndefined();
  });

  it("keeps a disconnected server's tools, so it reports changes when it reconnects", () => {
    const disconnected = compareMcpTools({
      previous: baseline(),
      statuses: [{ name: BASE.name, status: "pending" }],
      qualifiedToolName,
    }).next;
    expect(noteFor([premiere([["undo", "Undo to a stack index."]])], disconnected)).toContain(
      "removed redo, split_clip; changed description: undo.",
    );
  });

  it("names added, removed, and rewritten tools and the version change", () => {
    const note = noteFor([
      premiere(
        [
          ["undo", "Undo the last edit, or to undo_to_stack_index."],
          ["redo", "Redo."],
          ["multiple_undo", "Undo several edits."],
        ],
        { serverInfo: { version: "1.1.0" } },
      ),
    ]);
    expect(note).toBe(
      [
        "<system-reminder>",
        "The tools from MCP server `premiere-pro` changed since this thread last used them: added multiple_undo; removed split_clip; changed description: undo; version 1.0.0 → 1.1.0.",
        "Your earlier copies of this server's tools may be out of date, including their parameters. Before using one, load it again with ToolSearch if it is deferred (for example `select:mcp__premiere-pro__undo`), and follow its newest definition.",
        "</system-reminder>",
      ].join("\n"),
    );
  });

  it("reports a version change alone, since tool lists carry no parameters", () => {
    expect(noteFor([{ ...BASE, serverInfo: { version: "2.0.0" } }])).toContain(
      "changed since this thread last used them: version 1.0.0 → 2.0.0.",
    );
  });

  it("counts long lists instead of naming every tool", () => {
    const added = Array.from({ length: 12 }, (_, index) => [`tool_${index}`, ""] as const);
    const note = noteFor([
      premiere([...BASE.tools!.map((t) => [t.name, t.description!] as const), ...added]),
    ]);
    expect(note).toContain("added 12 tools, including tool_0, tool_1, tool_2, tool_3, tool_4.");
    expect(note).not.toContain("tool_5");
  });

  it("covers each changed server in one note", () => {
    const weather = { name: "weather", status: "connected", tools: [{ name: "forecast" }] };
    const previous = baseline([BASE, weather]);
    const note = noteFor(
      [
        { ...BASE, tools: BASE.tools!.slice(0, 2) },
        { ...weather, tools: [{ name: "forecast", description: "Seven days." }] },
      ],
      previous,
    );
    expect(note).toContain(
      "MCP server `premiere-pro` changed since this thread last used them: removed split_clip.",
    );
    expect(note).toContain(
      "MCP server `weather` changed since this thread last used them: changed description: forecast.",
    );
    expect(note).toContain("these servers' tools");
  });
});

describe("awaitsKnownMcpServer", () => {
  it.each([
    ["a used server is connecting", baseline(), [{ name: BASE.name, status: "pending" }], true],
    ["it is the thread's first turn", undefined, [{ name: BASE.name, status: "pending" }], false],
    [
      "only an unused server is connecting",
      baseline(),
      [{ name: "weather", status: "pending" }],
      false,
    ],
    ["the used server failed", baseline(), [{ name: BASE.name, status: "failed" }], false],
  ] as const)("waits only when %s", (_case, previous, statuses, expected) => {
    expect(awaitsKnownMcpServer(previous, statuses)).toBe(expected);
  });
});
