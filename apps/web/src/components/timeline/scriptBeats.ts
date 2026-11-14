import type { VideoScriptBeat } from "@t3tools/contracts";

const TICK_WORDS = 8;

/**
 * Where each placed script line starts, for the ruler: its section and first words on hover.
 * Lines the timeline doesn't say have no place and no tick.
 */
export const scriptTicks = (
  beats: ReadonlyArray<Pick<VideoScriptBeat, "id" | "startFrame" | "text" | "section">>,
): Array<{ readonly id: string; readonly frame: number; readonly label: string }> =>
  beats.flatMap((beat) => {
    if (beat.startFrame === null) return [];
    const words = beat.text.trim().split(/\s+/);
    const opening = `${words.slice(0, TICK_WORDS).join(" ")}${words.length > TICK_WORDS ? "…" : ""}`;
    return [
      {
        id: beat.id,
        frame: beat.startFrame,
        label: beat.section === null ? opening : `${beat.section}: ${opening}`,
      },
    ];
  });
