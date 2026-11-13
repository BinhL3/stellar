import { useAtomValue } from "@effect/atom-react";
import { XIcon } from "lucide-react";

import { useProjects } from "~/state/entities";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** The switch for noticing learnings, and the approved house rules with a way to remove each. */
export function HouseRulesSettings() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["learningsEnabled"]);
  const watched = useEnvironmentQuery(
    environmentId === null ? null : projectEnvironment.watchLearnings({ environmentId, input: {} }),
  );
  const canRemove = useAtomValue(projectEnvironment.removeHouseRule.permissionAtom(environmentId));
  const removeRule = useAtomCommand(projectEnvironment.removeHouseRule);
  const projects = useProjects();
  const rules = watched.data?.rules ?? [];
  const projectName = (projectId: string) =>
    projects.find((project) => project.environmentId === environmentId && project.id === projectId)
      ?.title ?? "one project";

  return (
    <>
      <SettingsRow
        {...searchableSetting("learnings")}
        description="When you state a standing editing preference in a video or carousel project, offer it as a house rule. Nothing is saved until you approve it."
        serverScoped
        settingKeys={["learningsEnabled"]}
        mixed={mixed}
        control={
          <Switch
            mixed={mixed}
            checked={mixed ? false : settings.learningsEnabled}
            onCheckedChange={(checked) => updateSettings({ learningsEnabled: Boolean(checked) })}
            aria-label="Notice house rules"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("house-rules")}
        description={
          rules.length === 0
            ? "No house rules yet. Approved rules are given to every agent turn in video and carousel projects."
            : "Given to every agent turn in video and carousel projects."
        }
      >
        {environmentId !== null && rules.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1">
            {rules.map((rule) => (
              <li key={rule.id} className="flex items-start gap-2 text-sm">
                <span className="min-w-0 flex-1">
                  {rule.text}
                  {rule.projectId === null ? null : (
                    <span className="text-muted-foreground"> · {projectName(rule.projectId)}</span>
                  )}
                </span>
                <Button
                  size="icon-xs"
                  variant="ghost-destructive"
                  aria-label={`Remove house rule: ${rule.text}`}
                  disabled={!canRemove}
                  onClick={() => void removeRule({ environmentId, input: { id: rule.id } })}
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </SettingsRow>
    </>
  );
}
