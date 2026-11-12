import { XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { capList, type PremierePull } from "./premiereChanges";

/** Change sentences, capped; the rest open in place. */
export function PremiereChangeList(props: {
  readonly items: ReadonlyArray<string>;
  readonly limit: number;
}) {
  // Expanding belongs to the list it was done on; a new sync's list starts capped again.
  const [expandedItems, setExpandedItems] = useState<ReadonlyArray<string> | null>(null);
  const { shown, more } =
    expandedItems === props.items
      ? { shown: props.items, more: 0 }
      : capList(props.items, props.limit);
  return (
    <ul className="flex flex-col gap-0.5 text-muted-foreground">
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

export const pullTitle = (pull: PremierePull) =>
  pull.merged ? "Merged with Premiere" : "Pulled from Premiere";

export const DROPPED_EDITS_TITLE =
  "These edits were dropped because Premiere changed the same clip";

/** What the last sync changed, above the timeline until it is dismissed or replaced. */
export function PremierePullNotice(props: {
  readonly pull: PremierePull;
  readonly onDismiss: () => void;
}) {
  const { pull } = props;
  return (
    <div
      role="status"
      className="mx-3 mt-2 flex shrink-0 items-start gap-2 rounded-lg border border-border bg-card py-1.5 pr-1.5 pl-3 text-xs shadow-xs/5"
    >
      <div className="flex max-h-48 min-w-0 flex-1 flex-col gap-1 overflow-y-auto py-0.5">
        <span className="font-medium">{pullTitle(pull)}</span>
        {pull.changes.length > 0 ? <PremiereChangeList items={pull.changes} limit={5} /> : null}
        {pull.conflicts.length > 0 ? (
          <>
            <span className="font-medium text-warning">{DROPPED_EDITS_TITLE}</span>
            <PremiereChangeList items={pull.conflicts} limit={5} />
          </>
        ) : null}
      </div>
      <Button size="icon-xs" variant="ghost" aria-label="Dismiss" onClick={props.onDismiss}>
        <XIcon />
      </Button>
    </div>
  );
}
