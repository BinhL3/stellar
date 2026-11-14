import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronLeftIcon, ClapperboardIcon, FolderIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { filesystemEnvironment } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";

export const parentOf = (folder: string) => {
  const trimmed = folder.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index <= 0 ? "/" : `${trimmed.slice(0, index)}/`;
};

/** Lists a folder on the host, with any files of these extensions; `null` lists nothing. */
export function useHostFolderListing(
  environmentId: EnvironmentId,
  folder: string | null,
  fileExtensions?: ReadonlyArray<string>,
) {
  return useEnvironmentQuery(
    folder === null
      ? null
      : filesystemEnvironment.browse({
          environmentId,
          input: {
            partialPath: folder,
            ...(fileExtensions === undefined ? {} : { fileExtensions: [...fileExtensions] }),
          },
        }),
  );
}

/**
 * Browses folders on the host, which may be another machine: a path field, an up button and the
 * folder's contents. Files show only when the listing asked for their extensions.
 */
export function HostFolderBrowser(props: {
  readonly folder: string;
  readonly onFolderChange: (folder: string) => void;
  readonly listing: ReturnType<typeof useHostFolderListing>;
  readonly onChooseFile?: (path: string) => void;
  /** A typed path that names a file rather than a folder, such as a `.prproj`. */
  readonly isFilePath?: (path: string) => boolean;
  readonly busy?: boolean;
  readonly inputLabel: string;
  readonly placeholder: string;
  readonly emptyText: string;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const go = (value: string) => {
    const path = value.trim();
    if (path === "") return;
    if (props.isFilePath?.(path) && props.onChooseFile) props.onChooseFile(path);
    else props.onFolderChange(path.endsWith("/") ? path : `${path}/`);
    setTyped(null);
  };
  const entries = (props.listing.data?.entries ?? []).filter(
    (entry) => props.onChooseFile !== undefined || entry.kind !== "file",
  );
  return (
    <>
      <div className="flex items-center gap-2">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Up one folder"
          onClick={() =>
            props.onFolderChange(parentOf(props.listing.data?.parentPath ?? props.folder))
          }
        >
          <ChevronLeftIcon />
        </Button>
        <Input
          aria-label={props.inputLabel}
          value={typed ?? props.folder}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") go(event.currentTarget.value);
          }}
          placeholder={props.placeholder}
        />
      </div>
      <div className="overflow-hidden rounded-lg border border-border/60">
        <ScrollArea className="h-72">
          {props.listing.isPending || props.busy ? (
            <div className="flex h-72 items-center justify-center text-muted-foreground">
              <Spinner />
            </div>
          ) : entries.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              {props.listing.error ?? props.emptyText}
            </p>
          ) : (
            <ul className="p-1">
              {entries.map((entry) => (
                <li key={entry.fullPath}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                      entry.kind === "file" && "font-medium",
                    )}
                    onClick={() =>
                      entry.kind === "file"
                        ? props.onChooseFile?.(entry.fullPath)
                        : props.onFolderChange(`${entry.fullPath}/`)
                    }
                  >
                    {entry.kind === "file" ? (
                      <ClapperboardIcon className="size-4 shrink-0 text-primary" />
                    ) : (
                      <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{entry.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </ScrollArea>
      </div>
    </>
  );
}
