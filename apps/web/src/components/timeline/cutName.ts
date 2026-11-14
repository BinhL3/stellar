/**
 * A cut's name as a person would write it: the sequence's own name where the timeline has been
 * read, otherwise its file name with the separators put back to spaces. The project's name is
 * left off the front, since the cut is already shown inside that project.
 */
export const cutName = (
  path: string,
  options?: { readonly title?: string | null; readonly project?: string | null },
): string => {
  const file = path.slice(path.lastIndexOf("/") + 1).replace(/\.otio$/i, "");
  const written = options?.title?.trim();
  const name = written ? written : file.replace(/[_\s]+/g, " ").trim();
  const project = options?.project?.trim().toLowerCase();
  const prefixed = /^(.+?)\s+[-–—:]\s+(.+)$/.exec(name);
  if (project && prefixed && prefixed[1]?.toLowerCase() === project && prefixed[2]) {
    return prefixed[2];
  }
  return name === "" ? file : name;
};
