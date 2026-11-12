import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, VideoProjectIntakeFile } from "@t3tools/contracts";
import { STILL_PATH } from "@t3tools/timeline/proxies";
import { ImagePlusIcon } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { toastManager } from "~/components/ui/toast";
import { projectEnvironment } from "~/state/projects";
import { useAtomCommand } from "~/state/use-atom-command";

const describe = (error: unknown) =>
  error instanceof Error && error.message.trim() !== "" ? error.message : "Try again in a moment.";

/**
 * Brings photos into the project: from the device this window is on (uploaded to the host),
 * or from the host's Downloads folder, where AirDrop leaves them. Either way the server
 * copies them into the project's Photos folder; the originals stay where they are.
 */
export function AddPhotosButton(props: {
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [found, setFound] = useState<{
    readonly source: string;
    readonly files: ReadonlyArray<VideoProjectIntakeFile>;
  } | null>(null);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const upload = useAtomCommand(projectEnvironment.uploadCarouselPhoto, { reportFailure: false });
  const scan = useAtomCommand(projectEnvironment.scanVideoIntake, { reportFailure: false });
  const importPhotos = useAtomCommand(projectEnvironment.importCarouselPhotos, {
    reportFailure: false,
  });
  const target = { environmentId: props.environmentId };
  const report = (failed: ReadonlyArray<string>, added: number) => {
    if (failed.length > 0) {
      toastManager.add({
        type: "error",
        title: `Couldn't add ${failed.length === 1 ? "a photo" : `${failed.length} photos`}`,
        description: failed.join("\n"),
      });
    } else if (added > 0) {
      toastManager.add({
        type: "success",
        title: `Added ${added === 1 ? "1 photo" : `${added} photos`}`,
      });
    }
  };

  const uploadFiles = async (files: ReadonlyArray<File>) => {
    const failed: Array<string> = [];
    let added = 0;
    for (const [index, file] of files.entries()) {
      setBusy(`Adding ${index + 1} of ${files.length}`);
      const result = await upload({
        ...target,
        input: {
          workspaceRoot: props.workspaceRoot,
          name: file.name,
          data: new Uint8Array(await file.arrayBuffer()),
        },
      });
      if (result._tag === "Success") {
        added += result.value.imported.length;
        failed.push(...result.value.failed);
      } else if (!isAtomCommandInterrupted(result)) {
        failed.push(`${file.name}: ${describe(squashAtomCommandFailure(result))}`);
      }
    }
    setBusy(null);
    report(failed, added);
  };

  const openDownloads = async () => {
    setBusy("Looking in Downloads");
    const result = await scan({ ...target, input: { workspaceRoot: props.workspaceRoot } });
    setBusy(null);
    if (result._tag === "Success") {
      setExcluded(new Set());
      setFound({
        source: result.value.source,
        files: result.value.files.filter((file) => STILL_PATH.test(file.name)),
      });
    } else if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Couldn't look in Downloads",
        description: describe(squashAtomCommandFailure(result)),
      });
    }
  };

  const chosen = found?.files.filter((file) => !excluded.has(file.path)) ?? [];
  const importChosen = async () => {
    setFound(null);
    setBusy(`Copying ${chosen.length === 1 ? "1 photo" : `${chosen.length} photos`}`);
    const result = await importPhotos({
      ...target,
      input: { workspaceRoot: props.workspaceRoot, paths: chosen.map((file) => file.path) },
    });
    setBusy(null);
    if (result._tag === "Success") report(result.value.failed, result.value.imported.length);
    else if (!isAtomCommandInterrupted(result)) {
      report([describe(squashAtomCommandFailure(result))], 0);
    }
  };

  return (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        accept="image/*,.heic,.heif,.tif,.tiff,.dng"
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          if (files.length > 0) void uploadFiles(files);
        }}
      />
      <Menu>
        <MenuTrigger
          disabled={busy !== null}
          render={<Button size="sm" variant="outline" aria-label="Add photos" />}
        >
          <ImagePlusIcon />
          <span className="@max-[38rem]/bar:sr-only">{busy ?? "Add photos"}</span>
        </MenuTrigger>
        <MenuPopup align="end" side="bottom">
          <MenuItem onClick={() => picker.current?.click()}>From this device…</MenuItem>
          <MenuItem onClick={() => void openDownloads()}>From Downloads on the host…</MenuItem>
        </MenuPopup>
      </Menu>
      <Dialog open={found !== null} onOpenChange={(open) => (open ? undefined : setFound(null))}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add photos from Downloads</DialogTitle>
            <DialogDescription>
              Photos that arrived in {found?.source ?? "Downloads"} in the last few days. They are
              copied into the project; nothing is moved or deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="overflow-hidden rounded-lg border border-border/60">
              <ScrollArea className="h-72">
                {found === null || found.files.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">No recent photos there.</p>
                ) : (
                  <ul className="p-1">
                    {found.files.map((file) => (
                      <li key={file.path}>
                        <label className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent">
                          <Checkbox
                            checked={!excluded.has(file.path)}
                            onCheckedChange={(checked) => {
                              const next = new Set(excluded);
                              if (checked === true) next.delete(file.path);
                              else next.add(file.path);
                              setExcluded(next);
                            }}
                          />
                          <span className="min-w-0 flex-1 truncate">{file.name}</span>
                          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                            {(file.size / 1_000_000).toFixed(1)} MB
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </ScrollArea>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setFound(null)}>
              Cancel
            </Button>
            <Button disabled={chosen.length === 0} onClick={() => void importChosen()}>
              {chosen.length === 0
                ? "Add photos"
                : `Add ${chosen.length === 1 ? "1 photo" : `${chosen.length} photos`}`}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
