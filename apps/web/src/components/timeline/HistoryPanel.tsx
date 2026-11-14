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

import { Bay } from "./bay";

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
      <Bay.Label className="text-foreground/80">{props.title}</Bay.Label>
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
          {loaded.error === null ? null : <EmptyDescription>{loaded.error}</EmptyDescription>}
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ol className="flex h-full min-h-0 flex-col gap-px overflow-auto bg-card px-1.5 pb-1.5 text-card-foreground">
      {versions.map((version, index) => {
        const isCurrent = index === 0;
        const shown = preview?.version.id === version.id;
        const who = WHO[version.by];
        const WhoIcon = who.icon;
        return (
          <Bay.Item key={version.id} selected={shown}>
            <Bay.ItemButton
              selected={shown}
              aria-expanded={shown}
              aria-current={isCurrent && preview === null ? "true" : undefined}
              onClick={() => void open(version, isCurrent)}
            >
              <WhoIcon
                role="img"
                aria-label={who.label}
                className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="min-w-0 truncate text-sm leading-5">{version.label}</span>
                <Bay.Label title={`${who.label} · ${version.id}`}>
                  {isCurrent ? <span className="text-primary">Now · </span> : null}
                  {when(version.at)}
                </Bay.Label>
                {!shown && version.changes[0] !== undefined ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {version.changes[0]}
                    {version.changes.length > 1 ? ` and ${version.changes.length - 1} more` : ""}
                  </span>
                ) : null}
              </span>
              {opening === version.id ? <Spinner /> : null}
            </Bay.ItemButton>
            {shown && preview !== null ? (
              <div className="mr-2 mb-2.5 ml-7.5 flex flex-col gap-2.5 border-t border-dotted border-input pt-2 text-xs">
                <ChangeList title="Changed here" changes={version.changes} />
                <ChangeList title="Changed since" changes={preview.changesSince} />
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
                      {restoring ? "Restoring…" : "Restore"}
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => props.onPreview(null)}>
                      Back to now
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </Bay.Item>
        );
      })}
    </ol>
  );
}
