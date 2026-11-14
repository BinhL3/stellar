import {
  CheckIcon,
  CopyIcon,
  PaintbrushIcon,
  PenLineIcon,
  PlusIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useState } from "react";
import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";
import { useEnvironmentThemeDefinitions } from "../../hooks/useEnvironmentTheme";
import { cn } from "../../lib/utils";
import {
  DEFAULT_THEME_ID,
  getActiveThemeDefinition,
  removeCustomThemes,
  serializeThemeFile,
  type ThemeDefinition,
} from "../../themePalette";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { ThemeImportDialog } from "./ThemeImportDialog";
import { searchableSetting } from "./settingsSearch";
import { useThemeEditorStore } from "./themeEditorStore";
import {
  getThemeCardDefinition,
  ThemePreviewCircle,
  type ThemeCardDefinition,
} from "./ThemePreviewCircles";

function collectionVariantLabels(themes: ReadonlyArray<ThemeDefinition>): ReadonlyArray<string> {
  if (themes.length === 0) return [];
  const words = themes.map((theme) => theme.label.trim().split(/\s+/));
  const firstWords = words[0]!;
  const sharedWordCount = firstWords.findIndex((word, index) =>
    words.some((labelWords) => labelWords[index]?.toLocaleLowerCase() !== word.toLocaleLowerCase()),
  );
  const prefixLength = sharedWordCount === -1 ? firstWords.length - 1 : sharedWordCount;

  return themes.map((theme, index) => {
    const shortLabel = words[index]?.slice(Math.max(0, prefixLength)).join(" ").trim();
    return shortLabel || theme.label;
  });
}

function downloadThemeFile(filename: string, contents: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Delay revocation so browsers can open the download stream.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function ThemeLibraryCard({
  theme,
  title,
  isActive,
  onUse,
  onEdit,
  onDuplicate,
  onDownload,
  onRemove,
  variants,
}: {
  theme: ThemeCardDefinition;
  /** Shown instead of the theme's own label, for a collection's card. */
  title?: string;
  isActive: boolean;
  onUse: () => void;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDownload?: () => void;
  onRemove?: () => void;
  variants?: ReadonlyArray<{
    card: ThemeCardDefinition;
    label: string;
    isActive: boolean;
    onUse: () => void;
  }>;
}) {
  return (
    <div
      className={cn(
        "cursor-pointer overflow-hidden rounded-xl border border-border/70 bg-card/60 transition-colors hover:bg-accent/10",
        isActive && "bg-accent/30",
      )}
      data-theme-library-card={theme.id}
      onClick={onUse}
      style={isActive ? { boxShadow: "inset 0 0 0 1px var(--ring)" } : undefined}
    >
      {variants ? (
        <div
          aria-label="Theme variants"
          className="flex min-h-16 flex-wrap items-center justify-center gap-1.5 px-3 pt-3"
          role="group"
        >
          {variants.map((variant) => (
            <Tooltip key={variant.card.id}>
              <TooltipTrigger
                render={
                  <button
                    aria-label={`Use ${variant.label}${variant.isActive ? ", currently active" : ""}`}
                    aria-pressed={variant.isActive}
                    className={cn(
                      "flex size-9 cursor-pointer items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      variant.isActive && "ring-2 ring-inset ring-ring",
                    )}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      variant.onUse();
                    }}
                  >
                    <ThemePreviewCircle colors={variant.card.colors} className="size-7" />
                  </button>
                }
              />
              <TooltipPopup>{variant.label}</TooltipPopup>
            </Tooltip>
          ))}
        </div>
      ) : (
        <div className="flex min-h-16 items-center justify-center px-3 pt-3">
          <ThemePreviewCircle colors={theme.colors} />
        </div>
      )}
      <div className="flex items-center gap-2 px-3 pb-3 pt-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <button
              aria-label={`Use ${theme.label} theme${isActive ? ", currently active" : ""}`}
              aria-pressed={isActive}
              className="min-w-0 cursor-pointer truncate rounded-sm text-left text-sm font-medium text-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onUse();
              }}
            >
              {title ?? theme.label}
            </button>
          </div>
        </div>
        {onEdit || onDuplicate || onDownload || onRemove ? (
          <div className="flex shrink-0 items-center gap-1">
            {onDuplicate ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={`Duplicate ${theme.label}`}
                      size="icon-xs"
                      variant="ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDuplicate();
                      }}
                    >
                      <CopyIcon />
                    </Button>
                  }
                />
                <TooltipPopup>Duplicate theme</TooltipPopup>
              </Tooltip>
            ) : null}
            {onEdit ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={`Edit ${theme.label}`}
                      size="icon-xs"
                      variant="ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        onEdit();
                      }}
                    >
                      <PenLineIcon />
                    </Button>
                  }
                />
                <TooltipPopup>Edit theme</TooltipPopup>
              </Tooltip>
            ) : null}
            {onDownload ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={`Export ${theme.label}`}
                      size="icon-xs"
                      variant="ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDownload();
                      }}
                    >
                      <UploadIcon />
                    </Button>
                  }
                />
                <TooltipPopup>Export theme file</TooltipPopup>
              </Tooltip>
            ) : null}
            {onRemove ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={`Remove ${title ?? theme.label}`}
                      size="icon-xs"
                      variant="ghost-destructive"
                      onClick={(event) => {
                        event.stopPropagation();
                        onRemove();
                      }}
                    >
                      <Trash2Icon />
                    </Button>
                  }
                />
                <TooltipPopup>Remove theme</TooltipPopup>
              </Tooltip>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CustomThemeCollectionCard({
  themes,
  activeThemeId,
  onUse,
  onDuplicate,
  onEdit,
  onDownload,
  onRemove,
}: {
  themes: ReadonlyArray<ThemeDefinition>;
  activeThemeId: string;
  onUse: (theme: ThemeDefinition) => void;
  onDuplicate: (theme: ThemeDefinition) => void;
  onEdit: (theme: ThemeDefinition) => void;
  onDownload: (theme: ThemeDefinition) => void;
  onRemove: (theme: ThemeDefinition) => void;
}) {
  // The card's actions follow the last variant picked; the active one leads until then.
  const [pickedId, setPickedId] = useState<string | null>(null);
  const theme =
    themes.find((candidate) => candidate.id === pickedId) ??
    themes.find((candidate) => candidate.id === activeThemeId) ??
    themes[0];
  if (!theme) return null;
  const variantLabels = collectionVariantLabels(themes);

  return (
    <ThemeLibraryCard
      isActive={themes.some((candidate) => candidate.id === activeThemeId)}
      onDownload={() => onDownload(theme)}
      onDuplicate={() => onDuplicate(theme)}
      onEdit={() => onEdit(theme)}
      onRemove={() => onRemove(theme)}
      onUse={() => onUse(theme)}
      theme={getThemeCardDefinition(theme)}
      {...(themes.length > 1
        ? {
            title: theme.collection?.label ?? theme.label,
            variants: themes.map((variant, index) => ({
              card: getThemeCardDefinition(variant),
              label: variantLabels[index] ?? variant.label,
              isActive: variant.id === activeThemeId,
              onUse: () => {
                setPickedId(variant.id);
                onUse(variant);
              },
            })),
          }
        : {})}
    />
  );
}

export function ThemeLibrary({
  theme,
  setTheme,
  customThemes,
  refreshTheme,
  isImportOpen,
  onImportOpenChange,
}: {
  theme: string;
  setTheme: (theme: string) => boolean;
  customThemes: ReadonlyArray<ThemeDefinition>;
  refreshTheme: () => void;
  isImportOpen: boolean;
  onImportOpenChange: (open: boolean) => void;
}) {
  const openThemeEditor = useThemeEditorStore((store) => store.openThemeEditor);
  const environmentThemes = useEnvironmentThemeDefinitions();
  const [themeRemovalTarget, setThemeRemovalTarget] = useState<{
    theme: ThemeDefinition;
    collectionThemes: ReadonlyArray<ThemeDefinition>;
  } | null>(null);
  const [isThemeRemovalOpen, setIsThemeRemovalOpen] = useState(false);
  const [themeIdsToRemove, setThemeIdsToRemove] = useState<ReadonlyArray<string>>([]);
  const themeIdsToRemoveSet = new Set(themeIdsToRemove);
  const removeDialogTheme = themeRemovalTarget?.theme;
  const removeDialogCollectionThemes = themeRemovalTarget?.collectionThemes ?? [];
  const canRemoveCollection = removeDialogCollectionThemes.length > 1;
  const removeDialogCollectionLabel =
    removeDialogTheme?.collection?.label ?? removeDialogTheme?.label;

  const notifyThemeSaveFailure = () => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Couldn’t save theme selection",
        description: "Try again.",
      }),
    );
  };

  const notifyThemeRemovalFailure = () => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Couldn’t remove theme",
        description: "Try again.",
      }),
    );
  };

  const persistTheme = (nextTheme: string) => {
    const didSave = setTheme(nextTheme);
    if (!didSave) notifyThemeSaveFailure();
    return didSave;
  };

  const handleRemoveTheme = (
    customTheme: ThemeDefinition,
    collectionThemes: ReadonlyArray<ThemeDefinition>,
  ) => {
    setThemeRemovalTarget({ theme: customTheme, collectionThemes });
    setThemeIdsToRemove(collectionThemes.length > 1 ? [] : [customTheme.id]);
    setIsThemeRemovalOpen(true);
  };

  const activeThemeId = getActiveThemeDefinition(theme).id;

  const handleConfirmRemoveTheme = () => {
    if (!themeRemovalTarget) return;
    const removedIds = new Set(themeIdsToRemove);
    if (removedIds.size === 0) return;
    if (removedIds.has(activeThemeId) && !persistTheme(DEFAULT_THEME_ID)) return;
    try {
      removeCustomThemes([...removedIds]);
    } catch {
      notifyThemeRemovalFailure();
      return;
    }
    setIsThemeRemovalOpen(false);
  };

  const duplicate = (source: ThemeDefinition) =>
    openThemeEditor({
      editingThemeId: null,
      seedThemeId: source.id,
      seedName: `${source.label} copy`,
    });

  const customThemeCollections = [
    ...customThemes
      .reduce((groups, customTheme) => {
        const groupId = customTheme.collection
          ? `collection:${customTheme.collection.id}`
          : `theme:${customTheme.id}`;
        const group = groups.get(groupId);
        if (group) group.push(customTheme);
        else groups.set(groupId, [customTheme]);
        return groups;
      }, new Map<string, ThemeDefinition[]>())
      .entries(),
  ];

  return (
    <div className="space-y-3">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-3 px-3 sm:px-4">
        <h3 className="text-base font-semibold text-foreground">
          {searchableSetting("theme").title}
        </h3>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              openThemeEditor({ editingThemeId: null, seedThemeId: activeThemeId, seedName: null })
            }
          >
            <PaintbrushIcon />
            Create theme
          </Button>
          <Button size="xs" variant="outline" onClick={() => onImportOpenChange(true)}>
            <PlusIcon />
            Add theme
          </Button>
        </div>
      </div>
      <TooltipProvider>
        <div
          className="grid w-full gap-2"
          style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 16rem), 1fr))" }}
        >
          {[
            ...BUILT_IN_THEMES,
            // Saved themes win id resolution; show only their card to avoid duplicate keys.
            ...environmentThemes.filter(
              (environmentTheme) => !customThemes.some((saved) => saved.id === environmentTheme.id),
            ),
          ].map((libraryTheme) => (
            <ThemeLibraryCard
              isActive={libraryTheme.id === activeThemeId}
              key={libraryTheme.id}
              onDuplicate={() => duplicate(libraryTheme)}
              onUse={() => persistTheme(libraryTheme.id)}
              theme={getThemeCardDefinition(libraryTheme)}
            />
          ))}
          {customThemeCollections.map(([collectionId, themes]) => (
            <CustomThemeCollectionCard
              activeThemeId={activeThemeId}
              key={collectionId}
              onDownload={(customTheme) =>
                downloadThemeFile(`${customTheme.id}.json`, serializeThemeFile(customTheme))
              }
              onDuplicate={duplicate}
              onEdit={(customTheme) =>
                openThemeEditor({
                  editingThemeId: customTheme.id,
                  seedThemeId: null,
                  seedName: null,
                })
              }
              onRemove={(customTheme) => handleRemoveTheme(customTheme, themes)}
              onUse={(customTheme) => persistTheme(customTheme.id)}
              themes={themes}
            />
          ))}
        </div>
      </TooltipProvider>
      <ThemeImportDialog
        onImportedMany={(importedThemes, { updated }) => {
          if (updated) refreshTheme();
          const verb = updated ? "updated" : "added";
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title:
                importedThemes.length === 1
                  ? `${importedThemes[0]!.label} ${verb}`
                  : `${importedThemes.length} themes ${verb}`,
              description: importedThemes.map((imported) => imported.label).join(", "),
            }),
          );
        }}
        onImported={(importedTheme) => {
          if (!persistTheme(importedTheme.id)) return false;
          toastManager.add(
            stackedThreadToast({
              type: "success",
              title: `${importedTheme.label} added`,
              description: "It’s now active.",
            }),
          );
          return true;
        }}
        onOpenChange={onImportOpenChange}
        open={isImportOpen}
      />
      <AlertDialog open={isThemeRemovalOpen} onOpenChange={setIsThemeRemovalOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {canRemoveCollection
                ? `Remove themes from “${removeDialogCollectionLabel}”?`
                : `Remove “${removeDialogTheme?.label}”?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {canRemoveCollection
                ? "Select the variants you want to remove. You can restore them by importing the extension again."
                : "You can bring it back anytime by importing its JSON file."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {canRemoveCollection ? (
            <div className="grid max-h-72 grid-cols-1 gap-2 overflow-y-auto px-6 pb-6 sm:grid-cols-2">
              {removeDialogCollectionThemes.map((customTheme) => {
                const checked = themeIdsToRemoveSet.has(customTheme.id);
                const card = getThemeCardDefinition(customTheme);
                const checkboxId = `remove-theme-${customTheme.id}`;
                return (
                  <label
                    className="group relative flex min-h-28 cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border border-border/70 bg-muted/25 p-3 has-checked:border-ring has-checked:bg-accent/20 hover:bg-muted/40"
                    htmlFor={checkboxId}
                    key={customTheme.id}
                  >
                    <span className="absolute right-2 top-2 inline-grid size-5 grid-cols-1 sm:size-4">
                      <input
                        checked={checked}
                        className="col-start-1 row-start-1 size-full appearance-none rounded-sm border border-input bg-background outline-none checked:border-primary checked:bg-primary focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring checked:focus-visible:inset-ring-3 checked:focus-visible:inset-ring-background dark:not-checked:bg-input/32 forced-colors:appearance-auto"
                        id={checkboxId}
                        name="themes-to-remove"
                        type="checkbox"
                        onChange={(event) => {
                          const shouldRemove = event.currentTarget.checked;
                          setThemeIdsToRemove((current) =>
                            shouldRemove
                              ? [...current, customTheme.id]
                              : current.filter((themeId) => themeId !== customTheme.id),
                          );
                        }}
                      />
                      <CheckIcon className="pointer-events-none col-start-1 row-start-1 size-3.5 shrink-0 self-center justify-self-center stroke-primary-foreground opacity-0 group-has-checked:opacity-100 sm:size-3" />
                    </span>
                    <span className="flex size-11 shrink-0 items-center justify-center">
                      <span className="flex scale-75">
                        <ThemePreviewCircle colors={card.colors} />
                      </span>
                    </span>
                    <p className="max-w-full truncate text-center text-base font-medium text-foreground sm:text-sm">
                      {customTheme.label}
                    </p>
                  </label>
                );
              })}
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              disabled={themeIdsToRemove.length === 0}
              variant="destructive"
              onClick={handleConfirmRemoveTheme}
            >
              {canRemoveCollection
                ? `Remove selected${themeIdsToRemove.length > 0 ? ` (${themeIdsToRemove.length})` : ""}`
                : "Remove theme"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
