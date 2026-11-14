import { DEFAULT_PROJECTS_FOLDER, type EnvironmentId } from "@t3tools/contracts";
import { resolvePastedPath } from "@t3tools/shared/path";
import { useRef, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { HostFolderBrowser, useHostFolderListing } from "../videoProject/HostFolderBrowser";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

export function ProjectsFolderRow() {
  const { targets } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["projectsFolder"]);
  const edited = useRef(false);
  const draft = useRef("");
  const [picking, setPicking] = useState(false);
  const scopeKey = targets.map((target) => target.environmentId).join(",");
  // Browsing lists one host's folders, so it is offered when one environment is being set.
  const pickFrom = targets.length === 1 ? (targets[0]?.environmentId ?? null) : null;

  return (
    <SettingsRow
      {...searchableSetting("video-projects-folder")}
      description="Where new video and carousel projects are saved, on the machine running Stellar. It is created when the first project is made."
      serverScoped
      settingKeys={["projectsFolder"]}
      resetAction={
        mixed || settings.projectsFolder !== DEFAULT_PROJECTS_FOLDER ? (
          <SettingResetButton
            label="projects folder"
            onClick={() => updateSettings({ projectsFolder: DEFAULT_PROJECTS_FOLDER })}
          />
        ) : null
      }
      control={
        <div className="flex w-full items-center gap-2 sm:w-80">
          <Input
            key={`${scopeKey}:${mixed}:${settings.projectsFolder}`}
            aria-label="Projects folder"
            autoCapitalize="none"
            spellCheck={false}
            placeholder={mixed ? "Mixed" : DEFAULT_PROJECTS_FOLDER}
            defaultValue={mixed ? "" : settings.projectsFolder}
            onFocus={(event) => {
              draft.current = event.target.value;
            }}
            onChange={(event) => {
              edited.current = true;
              draft.current = resolvePastedPath(draft.current, event.target.value);
              event.target.value = draft.current;
            }}
            onBlur={(event) => {
              const value = event.target.value.trim() || DEFAULT_PROJECTS_FOLDER;
              if (edited.current && (mixed || value !== settings.projectsFolder))
                updateSettings({ projectsFolder: value });
              edited.current = false;
            }}
          />
          {pickFrom !== null ? (
            <Button size="sm" variant="outline" onClick={() => setPicking(true)}>
              Choose…
            </Button>
          ) : null}
          {pickFrom !== null && picking ? (
            <ProjectsFolderPicker
              environmentId={pickFrom}
              start={mixed ? "~/" : `${settings.projectsFolder.replace(/\/+$/, "")}/`}
              onClose={() => setPicking(false)}
              onPick={(folder) => {
                setPicking(false);
                updateSettings({ projectsFolder: folder });
              }}
            />
          ) : null}
        </div>
      }
    />
  );
}

function ProjectsFolderPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly start: string;
  readonly onClose: () => void;
  readonly onPick: (folder: string) => void;
}) {
  const [folder, setFolder] = useState(props.start);
  const listing = useHostFolderListing(props.environmentId, folder);
  // A folder that isn't there yet, such as the default before its first project, opens home.
  const missing = listing.error !== null && folder === props.start;
  const shown = missing ? "~/" : folder;
  const shownListing = useHostFolderListing(props.environmentId, missing ? "~/" : null);
  const current = missing ? shownListing : listing;
  const picked = current.data?.parentPath ?? null;
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Projects folder</DialogTitle>
          <DialogDescription>New video and carousel projects are saved here.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <HostFolderBrowser
              folder={shown}
              onFolderChange={setFolder}
              listing={current}
              inputLabel="Folder"
              placeholder="~/Movies"
              emptyText="No folders in here."
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button
            disabled={picked === null || current.error !== null}
            onClick={() => picked !== null && props.onPick(picked)}
          >
            Use this folder
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
