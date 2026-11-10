/**
 * Water over the dithered planet art: a half-resolution wave field bends and shades the smooth
 * pre-dither image, which is re-dithered (8x8 Bayer, five levels) each frame, so the dots change
 * as waves pass. Once the water settles it shows the exact still art and stops animating.
 */

const LEVELS = 5;
const SIM_SCALE = 2;
// Waves lose this share of their height each step; lower settles sooner.
const DAMPING = 0.975;
const STEPS_PER_FRAME = 2;
// How far a wave's slope bends what's seen through it, and how much light it catches.
const REFRACTION = 7;
const SHADING = 0.22;
// A pointer moving this far, in art pixels, drops another disturbance along its path.
const DROP_SPACING = 4;
const DROP_HEIGHT = 1.4;
const DROP_RADIUS = 2;
// Below this height everywhere the water counts as still.
const STILL = 0.004;

const bayer8 = (() => {
  let matrix = [
    [0, 2],
    [3, 1],
  ];
  while (matrix.length < 8) {
    const size = matrix.length;
    const next: Array<Array<number>> = [];
    for (let y = 0; y < size * 2; y++) {
      const row: Array<number> = [];
      for (let x = 0; x < size * 2; x++) {
        const base = matrix[y % size]![x % size]! * 4;
        row.push(base + [0, 2, 3, 1][(y >= size ? 2 : 0) + (x >= size ? 1 : 0)]!);
      }
      next.push(row);
    }
    matrix = next;
  }
  return Float32Array.from(matrix.flat(), (value) => (value + 0.5) / 64);
})();

export function startLimbRipples(input: {
  readonly canvas: HTMLCanvasElement;
  readonly still: HTMLImageElement;
  readonly tone: HTMLImageElement;
}): () => void {
  const { canvas } = input;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return () => undefined;
  const width = canvas.width;
  const height = canvas.height;

  context.drawImage(input.tone, 0, 0, width, height);
  const tone = context.getImageData(0, 0, width, height).data;
  context.drawImage(input.still, 0, 0, width, height);
  const still = context.getImageData(0, 0, width, height);
  const frame = context.createImageData(width, height);

  const simWidth = Math.ceil(width / SIM_SCALE);
  const simHeight = Math.ceil(height / SIM_SCALE);
  let current = new Float32Array(simWidth * simHeight);
  let previous = new Float32Array(simWidth * simHeight);
  let lastDrop: { x: number; y: number } | null = null;
  let handle = 0;

  const drop = (artX: number, artY: number) => {
    const cx = Math.round(artX / SIM_SCALE);
    const cy = Math.round(artY / SIM_SCALE);
    for (let dy = -DROP_RADIUS; dy <= DROP_RADIUS; dy++) {
      for (let dx = -DROP_RADIUS; dx <= DROP_RADIUS; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 1 || y < 1 || x >= simWidth - 1 || y >= simHeight - 1) continue;
        const falloff = Math.max(0, 1 - Math.hypot(dx, dy) / (DROP_RADIUS + 1));
        current[y * simWidth + x]! -= DROP_HEIGHT * falloff;
      }
    }
  };

  /** One wave step; returns the active area in sim cells, or null once the water is still. */
  const step = () => {
    let minX = simWidth;
    let minY = simHeight;
    let maxX = -1;
    let maxY = -1;
    for (let y = 1; y < simHeight - 1; y++) {
      for (let x = 1; x < simWidth - 1; x++) {
        const i = y * simWidth + x;
        const value =
          ((current[i - 1]! + current[i + 1]! + current[i - simWidth]! + current[i + simWidth]!) /
            2 -
            previous[i]!) *
          DAMPING;
        previous[i] = value;
        if (value > STILL || value < -STILL) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    [current, previous] = [previous, current];
    return maxX < 0 ? null : { minX, minY, maxX, maxY };
  };

  const render = (area: { minX: number; minY: number; maxX: number; maxY: number }) => {
    frame.data.set(still.data);
    const pixels = frame.data;
    const x0 = Math.max(0, (area.minX - 2) * SIM_SCALE);
    const x1 = Math.min(width - 1, (area.maxX + 2) * SIM_SCALE);
    const y0 = Math.max(0, (area.minY - 2) * SIM_SCALE);
    const y1 = Math.min(height - 1, (area.maxY + 2) * SIM_SCALE);
    for (let y = y0; y <= y1; y++) {
      const sy = Math.min(simHeight - 2, Math.max(1, Math.round(y / SIM_SCALE)));
      for (let x = x0; x <= x1; x++) {
        const sx = Math.min(simWidth - 2, Math.max(1, Math.round(x / SIM_SCALE)));
        const i = sy * simWidth + sx;
        const slopeX = current[i + 1]! - current[i - 1]!;
        const slopeY = current[i + simWidth]! - current[i - simWidth]!;
        const fromX = Math.min(width - 1, Math.max(0, Math.round(x + slopeX * REFRACTION)));
        const fromY = Math.min(height - 1, Math.max(0, Math.round(y + slopeY * REFRACTION)));
        const light = 1 - (slopeX + slopeY) * SHADING;
        const from = (fromY * width + fromX) * 4;
        const to = (y * width + x) * 4;
        const threshold = bayer8[(y % 8) * 8 + (x % 8)]!;
        for (let channel = 0; channel < 3; channel++) {
          const value = (tone[from + channel]! / 255) * light;
          const level = Math.min(
            LEVELS - 1,
            Math.max(0, Math.floor(value * (LEVELS - 1) + threshold)),
          );
          pixels[to + channel] = Math.round((level / (LEVELS - 1)) * 255);
        }
      }
    }
    context.putImageData(frame, 0, 0);
  };

  const tick = () => {
    handle = 0;
    let area: ReturnType<typeof step> = null;
    for (let i = 0; i < STEPS_PER_FRAME; i++) area = step();
    if (area === null) {
      // Settled: show the exact still art and stop.
      context.putImageData(still, 0, 0);
      current.fill(0);
      previous.fill(0);
      return;
    }
    render(area);
    handle = requestAnimationFrame(tick);
  };

  const onPointerMove = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    // Invert object-fit: cover with the art pinned to the top.
    const scale = Math.max(rect.width / width, rect.height / height);
    const x = (event.clientX - rect.left - (rect.width - width * scale) / 2) / scale;
    const y = (event.clientY - rect.top) / scale;
    if (x < 0 || y < 0 || x >= width || y >= height) {
      lastDrop = null;
      return;
    }
    if (lastDrop !== null) {
      // Drops along the path, so a quick sweep leaves a wake rather than a few far-apart rings.
      const distance = Math.hypot(x - lastDrop.x, y - lastDrop.y);
      if (distance < DROP_SPACING) return;
      const count = Math.min(12, Math.floor(distance / DROP_SPACING));
      for (let i = 1; i <= count; i++) {
        const t = i / count;
        drop(lastDrop.x + (x - lastDrop.x) * t, lastDrop.y + (y - lastDrop.y) * t);
      }
    } else {
      drop(x, y);
    }
    lastDrop = { x, y };
    if (handle === 0) handle = requestAnimationFrame(tick);
  };

  window.addEventListener("pointermove", onPointerMove);
  return () => {
    window.removeEventListener("pointermove", onPointerMove);
    cancelAnimationFrame(handle);
  };
}
