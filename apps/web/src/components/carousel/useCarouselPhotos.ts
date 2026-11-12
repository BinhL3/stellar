import type { AssetResource, CarouselView, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useAssetUrls } from "~/assets/assetUrls";

import type { PhotoLookup } from "./drawSlide";

// Enough for a three-slide panorama at full height; a 48 MP original would hold 190 MB decoded.
const MAX_EDGE = 4320;

// One decode per photo, shared by every panel that shows it. Keyed by the photo's path, not its
// signed URL, so a re-minted URL doesn't decode it again.
const decoding = new Map<string, Promise<ImageBitmap | null>>();

const decode = async (url: string) => {
  const blob = await (await fetch(url)).blob();
  const full = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_EDGE / Math.max(full.width, full.height));
  if (scale === 1) return full;
  const { width, height } = full;
  full.close();
  return createImageBitmap(blob, {
    resizeWidth: Math.round(width * scale),
    resizeHeight: Math.round(height * scale),
    resizeQuality: "high",
  });
};

/**
 * The project's photos, decoded once and drawn from memory. `ready` is true once every photo
 * has loaded or failed, which is when an export can be trusted to have no holes.
 */
export function useCarouselPhotos(
  environmentId: EnvironmentId,
  workspaceRoot: string,
  view: CarouselView | null,
): { readonly photoOf: PhotoLookup; readonly ready: boolean } {
  const photos = view?.document.photos ?? [];
  const root = view?.mediaRoot.replace(/\/+$/, "") ?? "";
  const keys = photos.map((photo) => `${root}/${photo.file}`);
  const urls = useAssetUrls(
    environmentId,
    keys.map((path): AssetResource => ({ _tag: "draft-workspace-file", cwd: workspaceRoot, path })),
  );
  const [decoded, setDecoded] = useState<ReadonlyMap<string, ImageBitmap | null>>(new Map());
  // The lists are rebuilt every render; as text they change only when a photo or its URL does.
  const keyList = keys.join("\n");
  const urlList = urls.map((url) => url ?? "").join("\n");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Decoding a photo is asynchronous work outside React; the canvas redraws when one lands.
  useEffect(() => {
    let current = true;
    const wantedUrls = urlList.split("\n");
    for (const [index, key] of keyList.split("\n").entries()) {
      const url = wantedUrls[index];
      if (key === "" || !url) continue;
      let pending = decoding.get(key);
      if (pending === undefined) {
        pending = decode(url).catch(() => null);
        decoding.set(key, pending);
      }
      void pending.then((bitmap) => {
        if (!current) return;
        setDecoded((before) => (before.has(key) ? before : new Map(before).set(key, bitmap)));
      });
    }
    return () => {
      current = false;
    };
  }, [keyList, urlList]);

  const keyOf = (src: string) => {
    const index = photos.findIndex((photo) => photo.src === src);
    return index < 0 ? null : (keys[index] ?? null);
  };
  return {
    photoOf: (src) => {
      const key = keyOf(src);
      return key === null ? null : (decoded.get(key) ?? null);
    },
    ready: view !== null && keys.every((key) => decoded.has(key)),
  };
}
