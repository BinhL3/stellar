import {
  type EnvironmentId,
  HOUSE_RULE_MAX_LENGTH,
  type PendingLearning,
  type ProjectId,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { LightbulbIcon } from "lucide-react";
import { useState } from "react";

import type { ComposerBannerStackItem } from "~/components/chat/ComposerBannerStack";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

const NO_BANNERS: ReadonlyArray<ComposerBannerStackItem> = [];

/**
 * The oldest learning waiting in this project, as a notice above the composer. One at a time:
 * the next shows once this one is approved or dismissed. Nothing is a rule until Approve.
 */
export function useLearningBanners(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): ReadonlyArray<ComposerBannerStackItem> {
  const watched = useEnvironmentQuery(
    environmentId !== null && projectId !== null
      ? projectEnvironment.watchLearnings({ environmentId, input: {} })
      : null,
  );
  const canDecide = useAtomValue(projectEnvironment.approveLearning.permissionAtom(environmentId));
  const approve = useAtomCommand(projectEnvironment.approveLearning);
  const dismiss = useAtomCommand(projectEnvironment.dismissLearning);
  const [draft, setDraft] = useState<{ readonly id: string; readonly text: string } | null>(null);

  const learning: PendingLearning | undefined = watched.data?.pending.find(
    (pending) => pending.projectId === projectId,
  );
  if (environmentId === null || learning === undefined || !canDecide) return NO_BANNERS;

  const editing = draft?.id === learning.id ? draft : null;
  const text = editing?.text.trim() ?? "";
  const save = (scope: "everywhere" | "project") => {
    if (editing !== null && text === "") return;
    void approve({
      environmentId,
      input: { id: learning.id, scope, ...(editing === null ? {} : { text }) },
    });
  };

  return [
    {
      id: `learning:${learning.id}`,
      variant: "info",
      icon: <LightbulbIcon />,
      title: "Make this a house rule?",
      description:
        editing === null
          ? learning.contradicts === null
            ? learning.text
            : `${learning.text} Replaces: ${learning.contradicts}`
          : undefined,
      children:
        editing === null ? undefined : (
          <Input
            size="sm"
            autoFocus
            aria-label="House rule wording"
            maxLength={HOUSE_RULE_MAX_LENGTH}
            value={editing.text}
            onChange={(event) => setDraft({ id: learning.id, text: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") save("everywhere");
              if (event.key === "Escape") setDraft(null);
            }}
          />
        ),
      actions: (
        <>
          <Button size="xs" variant="ghost" onClick={() => save("everywhere")}>
            Approve
          </Button>
          <Button size="xs" variant="ghost-muted" onClick={() => save("project")}>
            Only this project
          </Button>
          {editing === null ? (
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => setDraft({ id: learning.id, text: learning.text })}
            >
              Edit wording
            </Button>
          ) : null}
        </>
      ),
      dismissLabel: "Dismiss this house rule",
      onDismiss: () => void dismiss({ environmentId, input: { id: learning.id } }),
    },
  ];
}
