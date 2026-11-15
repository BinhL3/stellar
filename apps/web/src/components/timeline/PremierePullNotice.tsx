import { ChevronDownIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import {
  capList,
  countChanges,
  summarizeChanges,
  type PremiereChangeGroup,
  type PremierePull,
} from "./premiereChanges";

/** Change sentences, capped; the rest open in place. */
export function PremiereChangeList(props: {
  readonly items: ReadonlyArray<string>;
  readonly limit: number;
  readonly className?: string;
}) {
  // Expanding belongs to the list it was done on; a new sync's list starts capped again.
  const [expandedItems, setExpandedItems] = useState<ReadonlyArray<string> | null>(null);
  const { shown, more } =
    expandedItems === props.items
      ? { shown: props.items, more: 0 }
      : capList(props.items, props.limit);
  return (
    <ul className={cn("flex flex-col gap-0.5 text-muted-foreground", props.className)}>
      {shown.map((item, index) => (
        // oxlint-disable-next-line react/no-array-index-key -- Sentences can repeat and the list never reorders.
        <li key={index} className="wrap-break-word">
          {item}
        </li>
      ))}
      {more > 0 ? (
        <li className="-ml-1.5">
          <Button size="micro" variant="link" onClick={() => setExpandedItems(props.items)}>
            and {more} more
          </Button>
        </li>
      ) : null}
    </ul>
  );
}

/** Each timeline's sentences under its name; a lone or unnamed group gets no heading. */
export function PremiereChangeGroups(props: {
  readonly groups: ReadonlyArray<PremiereChangeGroup>;
  readonly limit: number;
  readonly className?: string;
}) {
  const headed = props.groups.length > 1;
  return (
    <div className="flex flex-col gap-1.5">
      {props.groups.map((group) => (
        <div key={group.timeline ?? ""} className="flex flex-col gap-0.5">
          {headed && group.timeline !== null ? (
            <span className="font-medium text-foreground">{group.timeline}</span>
          ) : null}
          <PremiereChangeList
            items={group.items}
            limit={props.limit}
            {...(props.className === undefined ? {} : { className: props.className })}
          />
        </div>
      ))}
    </div>
  );
}

export const pullTitle = (pull: PremierePull) => {
  const count = countChanges(pull.changes);
  const changes = `${count} ${count === 1 ? "change" : "changes"}`;
  if (count === 0) return pull.merged ? "Merged with Premiere" : "Pulled from Premiere";
  return pull.merged ? `Merged ${changes} from Premiere` : `Pulled ${changes} from Premiere`;
};

const droppedTitle = (count: number) =>
  `${count} ${count === 1 ? "edit" : "edits"} dropped: Premiere changed the same clip`;

export const DROPPED_EDITS_TITLE =
  "These edits were dropped because Premiere changed the same clip";

/**
 * What the last sync changed, one line above the timeline until it is dismissed or replaced.
 * The changes open on demand; dropped edits always show, since they are work that was lost.
 */
export function PremierePullNotice(props: {
  readonly pull: PremierePull;
  readonly onDismiss: () => void;
}) {
  const { pull } = props;
  // Opening belongs to the pull it was done on; a new pull starts closed.
  const [openPull, setOpenPull] = useState<PremierePull | null>(null);
  const open = openPull === pull;
  const changeCount = countChanges(pull.changes);
  const dropped = countChanges(pull.conflicts);
  return (
    <div role="status" className="mx-2 mt-1 flex shrink-0 flex-col text-xs">
      <div className="flex h-7 min-w-0 items-center gap-1.5 pl-1">
        <span className="flex h-4 shrink-0 items-center rounded-xs bg-premiere-bg px-1 text-2xs font-bold text-premiere">
          Pr
        </span>
        <span className="shrink-0 font-medium">{pullTitle(pull)}</span>
        {changeCount > 0 ? (
          <span className="min-w-0 truncate text-muted-foreground">
            {summarizeChanges(pull.changes)}
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        {changeCount > 0 ? (
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={open}
            onClick={() => setOpenPull(open ? null : pull)}
          >
            Details
            <ChevronDownIcon className={cn("transition-transform", open && "rotate-180")} />
          </Button>
        ) : null}
        <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={props.onDismiss}>
          <XIcon />
        </Button>
      </div>
      {dropped > 0 ? (
        <div className="mb-1 flex flex-col gap-1 rounded-sm bg-warning/10 py-1.5 pr-2 pl-2">
          <span className="flex items-center gap-1.5 font-medium text-warning">
            <TriangleAlertIcon className="size-3.5 shrink-0" />
            {droppedTitle(dropped)}
          </span>
          <div className="pl-5">
            <PremiereChangeGroups groups={pull.conflicts} limit={3} />
          </div>
        </div>
      ) : null}
      {open ? (
        <div className="mb-1 max-h-48 overflow-y-auto rounded-sm bg-muted/40 py-1.5 pr-2 pl-2">
          <PremiereChangeGroups groups={pull.changes} limit={Infinity} />
        </div>
      ) : null}
    </div>
  );
}
