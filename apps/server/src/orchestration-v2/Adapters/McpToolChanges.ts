// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

export interface McpServerToolList {
  readonly name: string;
  readonly status: string;
  readonly serverInfo?: { readonly version: string } | undefined;
  readonly tools?:
    | ReadonlyArray<{ readonly name: string; readonly description?: string | undefined }>
    | undefined;
}

interface McpServerFingerprint {
  readonly version: string | undefined;
  /** Tool name to a digest of its description; tool lists carry no input schemas. */
  readonly tools: ReadonlyMap<string, string>;
}

/** The last tool lists a native thread saw, by server name. */
export type McpToolFingerprints = ReadonlyMap<string, McpServerFingerprint>;

const LISTED_TOOLS_LIMIT = 8;
const LISTED_TOOLS_WHEN_CAPPED = 5;

function fingerprint(
  status: McpServerToolList & { readonly tools: NonNullable<McpServerToolList["tools"]> },
): McpServerFingerprint {
  return {
    version: status.serverInfo?.version,
    tools: new Map(
      status.tools.map((tool) => [
        tool.name,
        NodeCrypto.hash("sha1", tool.description ?? "", "base64"),
      ]),
    ),
  };
}

function listTools(names: ReadonlyArray<string>): string {
  if (names.length <= LISTED_TOOLS_LIMIT) return names.join(", ");
  return `${names.length} tools, including ${names.slice(0, LISTED_TOOLS_WHEN_CAPPED).join(", ")}`;
}

/**
 * Compares connected servers' tool lists with the thread's last ones. Servers that are not
 * connected keep their last fingerprint, and a server the thread has not seen connected is only
 * recorded, so a first turn or a status change alone says nothing.
 */
export function compareMcpTools(input: {
  readonly previous: McpToolFingerprints | undefined;
  readonly statuses: ReadonlyArray<McpServerToolList>;
  readonly qualifiedToolName: (server: string, tool: string) => string;
}): { readonly next: McpToolFingerprints; readonly note: string | undefined } {
  const next = new Map(input.previous);
  const lines: Array<string> = [];
  let example: string | undefined;
  for (const status of input.statuses) {
    if (status.status !== "connected" || status.tools === undefined) continue;
    const current = fingerprint({ ...status, tools: status.tools });
    const before = input.previous?.get(status.name);
    next.set(status.name, current);
    if (before === undefined) continue;
    const added = [...current.tools.keys()].filter((name) => !before.tools.has(name));
    const removed = [...before.tools.keys()].filter((name) => !current.tools.has(name));
    const changed = [...current.tools].flatMap(([name, digest]) =>
      before.tools.has(name) && before.tools.get(name) !== digest ? [name] : [],
    );
    const versionChanged =
      before.version !== undefined &&
      current.version !== undefined &&
      before.version !== current.version;
    const parts = [
      ...(added.length === 0 ? [] : [`added ${listTools(added)}`]),
      ...(removed.length === 0 ? [] : [`removed ${listTools(removed)}`]),
      ...(changed.length === 0 ? [] : [`changed description: ${listTools(changed)}`]),
      ...(versionChanged ? [`version ${before.version} → ${current.version}`] : []),
    ];
    if (parts.length === 0) continue;
    lines.push(
      `The tools from MCP server \`${status.name}\` changed since this thread last used them: ${parts.join("; ")}.`,
    );
    const exampleTool = changed[0] ?? added[0] ?? current.tools.keys().next().value;
    example ??=
      exampleTool === undefined ? undefined : input.qualifiedToolName(status.name, exampleTool);
  }
  if (lines.length === 0) return { next, note: undefined };
  const lookup =
    example === undefined
      ? "load it again with ToolSearch if it is deferred"
      : `load it again with ToolSearch if it is deferred (for example \`select:${example}\`)`;
  return {
    next,
    note: [
      "<system-reminder>",
      ...lines,
      `Your earlier copies of ${lines.length === 1 ? "this server's" : "these servers'"} tools may be out of date, including their parameters. Before using one, ${lookup}, and follow its newest definition.`,
      "</system-reminder>",
    ].join("\n"),
  };
}

/** Whether a server this thread has used is still connecting, so its tool list is not known yet. */
export function awaitsKnownMcpServer(
  previous: McpToolFingerprints | undefined,
  statuses: ReadonlyArray<McpServerToolList>,
): boolean {
  return (
    previous !== undefined &&
    statuses.some((status) => status.status === "pending" && previous.has(status.name))
  );
}
