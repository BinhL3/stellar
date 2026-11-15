/** Change sentences from one timeline; `timeline` is null for project-wide lines or a single timeline. */
export interface PremiereChangeGroup {
  readonly timeline: string | null;
  readonly items: ReadonlyArray<string>;
}

/** What the last sync that changed anything brought in, kept until the next one replaces it. */
export interface PremierePull {
  readonly changes: ReadonlyArray<PremiereChangeGroup>;
  /** Edits made here that a merge dropped. */
  readonly conflicts: ReadonlyArray<PremiereChangeGroup>;
  readonly merged: boolean;
}

/**
 * The first `limit` items and how many are left out. A single leftover is shown instead, since
 * "and 1 more" would take the line it saves.
 */
export const capList = <T>(
  items: ReadonlyArray<T>,
  limit: number,
): { readonly shown: ReadonlyArray<T>; readonly more: number } =>
  items.length <= limit + 1
    ? { shown: items, more: 0 }
    : { shown: items.slice(0, limit), more: items.length - limit };

const labelOf = (timelinePath: string) => timelinePath.replace(/^timelines\/|\.otio$/g, "");

/**
 * Splits sync sentences by the timeline the server prefixed them with (`<label>: `, only when
 * several timelines changed), so the prefix shows once as a heading instead of on every line.
 */
export const groupByTimeline = (
  lines: ReadonlyArray<string>,
  timelinePaths: ReadonlyArray<string>,
  nameOf: (timelinePath: string) => string,
): ReadonlyArray<PremiereChangeGroup> => {
  // Longest first, so a label that starts another label can't claim its lines.
  const prefixes = [...new Set(timelinePaths)]
    .map((path) => ({ prefix: `${labelOf(path)}: `, name: nameOf(path) }))
    .toSorted((a, b) => b.prefix.length - a.prefix.length);
  const groups = new Map<string | null, Array<string>>();
  for (const line of lines) {
    const match = prefixes.find(({ prefix }) => line.startsWith(prefix));
    const key = match?.name ?? null;
    const item = match === undefined ? line : line.slice(match.prefix.length);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  return [...groups].map(([timeline, items]) => ({ timeline, items }));
};

export const countChanges = (groups: ReadonlyArray<PremiereChangeGroup>) =>
  groups.reduce((total, group) => total + group.items.length, 0);

const KINDS: ReadonlyArray<readonly [prefix: string, word: string]> = [
  ["Added ", "added"],
  ["Removed ", "removed"],
  ["Moved ", "moved"],
  ["Trimmed ", "trimmed"],
  ["Changed ", "changed"],
  ["Renamed ", "renamed"],
  ["New sequence:", "new sequence"],
  ["Sequence ", "sequence change"],
];

/** The biggest kinds of change, as "9 removed, 6 moved, 4 trimmed"; the rest as "13 other". */
export const summarizeChanges = (groups: ReadonlyArray<PremiereChangeGroup>, kinds = 3): string => {
  const counts = new Map<string, number>();
  for (const group of groups) {
    for (const item of group.items) {
      const word = KINDS.find(([prefix]) => item.startsWith(prefix))?.[1] ?? "other";
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const other = counts.get("other") ?? 0;
  counts.delete("other");
  const ranked = [...counts].toSorted((a, b) => b[1] - a[1]);
  const shown = ranked.length <= kinds + (other > 0 ? 0 : 1) ? ranked : ranked.slice(0, kinds);
  const rest = ranked.slice(shown.length).reduce((total, [, count]) => total + count, other);
  return [
    ...shown.map(([word, count]) =>
      count > 1 && word.includes("sequence") ? `${count} ${word}s` : `${count} ${word}`,
    ),
    ...(rest > 0 ? [`${rest} other`] : []),
  ].join(", ");
};
