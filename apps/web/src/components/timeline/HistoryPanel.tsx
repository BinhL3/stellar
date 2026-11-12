import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  VideoTimelineVersion,
  VideoTimelineVersions,
  VideoTimelineVersionView,
} from "@t3tools/contracts";
import { ClapperboardIcon, FileIcon, SparklesIcon, UserIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Spinner } from "~/components/ui/spinner";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";

const WHO: Record<
  VideoTimelineVersion["by"],
  { readonly label: string; readonly icon: typeof UserIcon }
> = {
  user: { label: "You", icon: UserIcon },
  agent: { label: "Agent", icon: SparklesIcon },
  premiere: { label: "Premiere", icon: ClapperboardIcon },
  outside: { label: "Outside Stellar", icon: FileIcon },
};

const when = (time: number) =>
  new Date(time).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

/** The version on show in the Monitor instead of the timeline as it is now. */
export type VersionPreview = VideoTimelineVersionView;

function ChangeList(props: { readonly title: string; readonly changes: ReadonlyArray<string> }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium text-foreground/90">{props.title}</span>
      {props.changes.length === 0 ? (
        <span className="text-muted-foreground">Nothing.</span>
      ) : (
        <ul className="flex flex-col gap-0.5 text-muted-foreground">
          {props.changes.map((change, index) => (
            // Two changes can read the same; their place in the list tells them apart.
            // oxlint-disable-next-line react/no-array-index-key
            <li key={index} className="wrap-anywhere">
              {change}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Every version of the timeline, newest first. Choosing one shows it in the Monitor and lists
 * what it changed and what has changed since, without touching the timeline; Restore brings it
 * back as a new version.
 */
export function HistoryPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly timeline: string;
  /** Changes whenever the timeline's saved text does; the list is read again then. */
  readonly revision: string;
  readonly canWrite: boolean;
  readonly preview: VersionPreview | null;
  readonly onPreview: (preview: VersionPreview | null) => void;
  /** Resolves once the restore has finished, whether or not it worked. */
  readonly onRestore: (versionId: string) => Promise<void>;
}) {
  const listVersions = useAtomCommand(projectEnvironment.listVideoTimelineVersions, {
    reportFailure: false,
  });
  const readVersion = useAtomCommand(projectEnvironment.readVideoTimelineVersion, {
    reportFailure: false,
  });
  const [loaded, setLoaded] = useState<{
    readonly revision: string;
    readonly view: VideoTimelineVersions | null;
    readonly error: string | null;
  } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const { revision, preview } = props;

  const list = useEffectEvent(() =>
    listVersions({
      environmentId: props.environmentId,
      input: { workspaceRoot: props.workspaceRoot, timeline: props.timeline },
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The versions are kept by the server; they are read again whenever the timeline's saved text changes.
  useEffect(() => {
    let current = true;
    void list().then((result) => {
      if (!current) return;
      if (result._tag === "Success") setLoaded({ revision, view: result.value, error: null });
      else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setLoaded({
          revision,
          view: null,
          error: error instanceof Error ? error.message : "Could not read the history.",
        });
      }
    });
    return () => {
      current = false;
    };
  }, [revision]);

  const open = async (version: VideoTimelineVersion, isCurrent: boolean) => {
    if (isCurrent || preview?.version.id === version.id) {
      props.onPreview(null);
      return;
    }
    setOpening(version.id);
    const result = await readVersion({
      environmentId: props.environmentId,
      input: {
        workspaceRoot: props.workspaceRoot,
        timeline: props.timeline,
        version: version.id,
      },
    });
    setOpening(null);
    if (result._tag === "Success") props.onPreview(result.value);
  };

  if (loaded === null) {
    return (
      <div className="flex h-full items-center justify-center bg-card text-muted-foreground">
        <Spinner />
      </div>
    );
  }
  const versions = loaded.view?.versions ?? [];
  if (versions.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            {loaded.error === null ? "No versions yet" : "No history to show"}
          </EmptyTitle>
          <EmptyDescription>
            {loaded.error ??
              "Each commit, agent edit, pull from Premiere and voice-over placement is kept here, so any of them can be looked at again or brought back."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ol className="flex h-full min-h-0 flex-col gap-px overflow-auto bg-card p-1.5 text-card-foreground">
      {versions.map((version, index) => {
        const isCurrent = index === 0;
        const shown = preview?.version.id === version.id;
        const who = WHO[version.by];
        const WhoIcon = who.icon;
        return (
          <li key={version.id} className={cn("rounded-md", shown && "bg-accent/60")}>
            <button
              type="button"
              aria-expanded={shown}
              aria-current={isCurrent && preview === null ? "true" : undefined}
              onClick={() => void open(version, isCurrent)}
              className={cn(
                "flex w-full cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                !shown && "hover:bg-accent",
              )}
            >
              <WhoIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-baseline gap-1.5 text-sm leading-5">
                  <span className="min-w-0 truncate">{version.label}</span>
                  {isCurrent ? (
                    <span className="shrink-0 text-2xs font-medium text-primary">Now</span>
                  ) : null}
                </span>
                <span className="text-2xs text-muted-foreground">
                  {who.label} · {when(version.at)} · {version.id}
                </span>
                {!shown && version.changes[0] !== undefined ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {version.changes[0]}
                    {version.changes.length > 1 ? ` and ${version.changes.length - 1} more` : ""}
                  </span>
                ) : null}
              </span>
              {opening === version.id ? <Spinner /> : null}
            </button>
            {shown && preview !== null ? (
              <div className="flex flex-col gap-2.5 px-2 pt-1 pb-2.5 pl-7.5 text-xs">
                <ChangeList title="What this version changed" changes={version.changes} />
                <ChangeList
                  title="Changed since, in the timeline now"
                  changes={preview.changesSince}
                />
                {props.canWrite ? (
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="xs"
                      disabled={restoring}
                      onClick={() => {
                        setRestoring(true);
                        void props.onRestore(version.id).finally(() => setRestoring(false));
                      }}
                    >
                      {restoring ? "Restoring…" : "Restore this version"}
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => props.onPreview(null)}>
                      Back to now
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
