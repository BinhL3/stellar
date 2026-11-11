/** What the last sync that changed anything brought in, kept until the next one replaces it. */
export interface PremierePull {
  readonly changes: ReadonlyArray<string>;
  /** Edits made here that a merge dropped. */
  readonly conflicts: ReadonlyArray<string>;
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
