/**
 * The edges of a 9:16 frame each app covers with its own buttons and names, as fractions.
 * Binh posts everywhere, so the default is the union. Platforms publish these only for ads,
 * which cover a little more than a post does: text clear of them is clear on a post too.
 */

export type SafeZonePlatform = "reels" | "tiktok" | "shorts";

export interface Insets {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

/** A rectangle in fractions of the frame, 0 at the top left. */
export interface FrameBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export const SAFE_ZONE_PLATFORMS: Record<SafeZonePlatform, { name: string; insets: Insets }> = {
  // facebook.com/business/ads-guide/update/video/instagram-reels: "at least 14% of the top,
  // 35% of the bottom, and 6% on each side".
  reels: { name: "Instagram Reels", insets: { top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 } },
  // TikTok's In-Feed template (ads.tiktok.com help, a download) as third parties transcribe it:
  // 240 px top, 660 bottom, 120 each side of 1080x1920. TikTok states no figures in text.
  tiktok: { name: "TikTok", insets: { top: 0.125, bottom: 0.344, left: 0.111, right: 0.111 } },
  // services.google.com/fh/files/misc/universalsafezones-youtube.pdf: 288 px top, 672 bottom,
  // 48 left and 192 right of 1080x1920, for every YouTube surface Shorts included.
  shorts: {
    name: "YouTube Shorts",
    insets: { top: 0.15, bottom: 0.35, left: 0.044, right: 0.178 },
  },
};

/** One platform's covered edges, or the union of all three when none is named. */
export const safeZoneInsets = (platform?: SafeZonePlatform): Insets => {
  if (platform !== undefined) return SAFE_ZONE_PLATFORMS[platform].insets;
  const all = Object.values(SAFE_ZONE_PLATFORMS).map((entry) => entry.insets);
  const most = (edge: keyof Insets) => Math.max(...all.map((insets) => insets[edge]));
  return { top: most("top"), bottom: most("bottom"), left: most("left"), right: most("right") };
};

/** Who `insets` speaks for, as a report names it. */
export const safeZoneName = (platform?: SafeZonePlatform): string =>
  platform === undefined ? "Reels, TikTok and Shorts together" : SAFE_ZONE_PLATFORMS[platform].name;

/** The edges whose covered strip `box` reaches into. */
export const coveredEdges = (box: FrameBox, insets: Insets): Array<keyof Insets> => {
  const edges: Array<keyof Insets> = [];
  if (box.top < insets.top) edges.push("top");
  if (box.bottom > 1 - insets.bottom) edges.push("bottom");
  if (box.left < insets.left) edges.push("left");
  if (box.right > 1 - insets.right) edges.push("right");
  return edges;
};

/** Shades the covered strips of each frame, for an ffmpeg filter chain on a portrait picture. */
export const safeZoneDrawFilter = (insets: Insets): string =>
  [
    `drawbox=x=0:y=0:w=iw:h=ih*${insets.top}`,
    `drawbox=x=0:y=ih*${1 - insets.bottom}:w=iw:h=ih*${insets.bottom}`,
    `drawbox=x=0:y=ih*${insets.top}:w=iw*${insets.left}:h=ih*${1 - insets.top - insets.bottom}`,
    `drawbox=x=iw*${1 - insets.right}:y=ih*${insets.top}:w=iw*${insets.right}:h=ih*${1 - insets.top - insets.bottom}`,
  ]
    .map((box) => `${box}:color=red@0.22:t=fill`)
    .join(",");
