import { ProjectThemeId } from "@t3tools/contracts";
import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";
import * as Schema from "effect/Schema";

import { useCustomThemes } from "../../hooks/useCustomThemes";
import { useEnvironmentThemeDefinitions } from "../../hooks/useEnvironmentTheme";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { getThemeCardDefinition, ThemePreviewCircle } from "./ThemePreviewCircles";

const USE_MY_THEME = "__mine";
const isProjectThemeId = Schema.is(ProjectThemeId);

/** Built-in, custom and published themes a project can name; the user's own theme clears it. */
export function ProjectThemeSelect({
  value,
  disabled,
  onChange,
}: {
  value: string | null;
  disabled: boolean;
  onChange: (themeId: string | null) => void;
}) {
  const customThemes = useCustomThemes();
  const environmentThemes = useEnvironmentThemeDefinitions();
  const seen = new Set<string>();
  const cards = [...BUILT_IN_THEMES, ...customThemes, ...environmentThemes]
    .filter((definition) => {
      if (seen.has(definition.id) || !isProjectThemeId(definition.id)) return false;
      seen.add(definition.id);
      return true;
    })
    .map(getThemeCardDefinition);
  const current = value === null ? undefined : cards.find((card) => card.id === value);
  return (
    <Select
      value={value ?? USE_MY_THEME}
      disabled={disabled}
      onValueChange={(next) => {
        if (typeof next !== "string" || next === (value ?? USE_MY_THEME)) return;
        onChange(next === USE_MY_THEME ? null : next);
      }}
    >
      <SelectTrigger size="sm" className="w-full sm:w-64" aria-label="Project theme">
        <SelectValue>
          {value === null
            ? "Use my theme"
            : (current?.label ?? `${value} (not on this device; using yours)`)}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        <SelectItem hideIndicator value={USE_MY_THEME}>
          Use my theme
        </SelectItem>
        {cards.map((card) => (
          <SelectItem hideIndicator key={card.id} value={card.id}>
            <span className="flex items-center gap-2">
              <ThemePreviewCircle
                colors={card.colors}
                appearance={card.appearance}
                className="size-3 border-0"
              />
              {card.label}
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
