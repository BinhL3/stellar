/**
 * The places behind the app, one per built-in theme. A scene is a stack of layers, back to front,
 * each a tone function over scene space: y runs 0 (top) to 1 (bottom) and x is centred, in the
 * same units, so a wider pane sees more to the sides. Tones are ink densities, not colours; the
 * renderer turns them into dots in the theme's three inks.
 */

/** 0 is the theme's accent, 1 a mid ink beside it, 2 a deep ink near the paper. */
type Ink = 0 | 1 | 2;

export interface SceneLayer {
  readonly ink: Ink;
  /** Share of the pointer parallax this layer takes; 0 is fixed sky. */
  readonly depth: number;
  /** A solid layer hides what is behind it wherever its tone is not negative. */
  readonly solid?: boolean;
  /** Scene rows the layer can touch, so the rest is skipped. */
  readonly band?: readonly [number, number];
  /**
   * `i` and `j` are the dot's column and row, for details one dot wide. A layer with sprites also
   * gets the scene clock in seconds, or null for the still picture.
   */
  readonly tone: (x: number, y: number, i: number, j: number, time: number | null) => number;
  /**
   * Re-inks a lit dot as the clock runs: given its still tone, its tone at `time`. Only dots with a
   * positive still tone are asked, and null asks for the still picture's tone.
   */
  readonly shimmer?: (tone: number, i: number, j: number, time: number | null) => number;
  /**
   * Makes this a moving layer: blank but for these boxes, where `tone` is asked afresh each
   * tick. Null asks for the still picture's boxes.
   */
  readonly sprites?: (time: number | null) => ReadonlyArray<Sprite>;
}

/** Where a moving layer may ink at one time, in scene units, and a key that changes with its look. */
export interface Sprite {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly key?: number;
}

export interface SceneFrame {
  /** Visible width in scene units. */
  readonly aspect: number;
  /** One dot in scene units. */
  readonly dot: number;
}

export interface Scene {
  /** How far the mid and deep inks turn from the accent's hue, in degrees. */
  readonly hues: readonly [number, number];
  readonly layers: (frame: SceneFrame) => ReadonlyArray<SceneLayer>;
}

const OUTSIDE = -1;
// A dark window a shimmer may light: positive so it is asked, and exact in a Float32Array.
const UNLIT = 2 ** -9;
// How far left of the pane a sidebar continuing its picture can reach, so what moves crosses it too.
const SIDEBAR_REACH = 0.5;

function hash(i: number, j: number, seed = 0): number {
  let h = Math.imul(i, 374761393) ^ Math.imul(j, 668265263) ^ Math.imul(seed + 1, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

function smooth(from: number, to: number, value: number): number {
  const t = clamp01((value - from) / (to - from));
  return t * t * (3 - 2 * t);
}

function noise1(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i, 0, seed) * (1 - u) + hash(i + 1, 0, seed) * u;
}

function noise2(x: number, y: number, seed: number): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  const fx = x - i;
  const fy = y - j;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const top = hash(i, j, seed) * (1 - u) + hash(i + 1, j, seed) * u;
  const bottom = hash(i, j + 1, seed) * (1 - u) + hash(i + 1, j + 1, seed) * u;
  return top * (1 - v) + bottom * v;
}

function fbm1(x: number, seed: number): number {
  return (
    noise1(x, seed) * 0.5 +
    noise1(x * 2.03, seed + 1) * 0.25 +
    noise1(x * 4.01, seed + 2) * 0.125 +
    noise1(x * 8.07, seed + 3) * 0.125
  );
}

function fbm2(x: number, y: number, seed: number): number {
  return (
    noise2(x, y, seed) * 0.5 +
    noise2(x * 2.03, y * 2.03, seed + 1) * 0.3 +
    noise2(x * 4.01, y * 4.01, seed + 2) * 0.2
  );
}

/**
 * Share of a star's light at `time`: each one dims for a moment on some turns of its own slow
 * cycle, through a half step either side so it never blinks. `i` and `j` name the star.
 */
function twinkle(i: number, j: number, time: number | null): number {
  if (time === null) return 1;
  const period = 6 + 8 * hash(i, j, 16);
  const phase = time / period + hash(i, j, 17);
  const turn = Math.floor(phase);
  if (hash(i + turn * 7919, j, 18) > 0.4) return 1;
  const at = phase - turn;
  return at < 0.4 || at > 0.6 ? 1 : at < 0.44 || at > 0.56 ? 0.5 : 0.12;
}

/** A mote: a lit dot, a pair side by side (1), or a pair one over the other (2). */
type Mote = readonly [x: number, y: number, tone: number, shape?: 0 | 1 | 2];

/** A moving layer of motes, wherever `at` puts them at a time; nothing in the still picture. */
function motes(
  ink: Ink,
  depth: number,
  dot: number,
  at: (time: number) => ReadonlyArray<Mote>,
): SceneLayer {
  // Every dot a tick asks about wants the same list.
  let cachedTime = Number.NaN;
  let cached: ReadonlyArray<Mote> = [];
  const current = (time: number | null) => {
    if (time === null) return [];
    if (time !== cachedTime) {
      cachedTime = time;
      cached = at(time);
    }
    return cached;
  };
  return {
    ink,
    depth,
    sprites: (time) =>
      current(time).map(([x, y, tone, shape = 0]) => ({
        x0: x,
        y0: y,
        x1: x + (shape === 1 ? dot : 0),
        y1: y + (shape === 2 ? dot : 0),
        key: Math.round((x / dot) * 2) * 8191 + Math.round((y / dot) * 2) + tone + shape * 0.25,
      })),
    tone: (x, y, _i, _j, time) => {
      for (const [mx, my, tone, shape = 0] of current(time)) {
        const dx = (x - mx) / dot;
        const dy = (y - my) / dot;
        if (dx >= -0.5 && dx < (shape === 1 ? 1.5 : 0.5) && dy >= -0.5) {
          if (dy < (shape === 2 ? 1.5 : 0.5)) return tone;
        }
      }
      return 0;
    },
  };
}

/** Single-dot stars, thinning towards `floor`, with the odd four-point one in the accent ink. */
function stars(floor: number, density = 1): ReadonlyArray<SceneLayer> {
  // Sparse around the middle of the pane, where the new-thread heading sits.
  const thin = (x: number, y: number) =>
    density *
    smooth(floor, floor - 0.35, y) *
    (0.15 + 0.85 * smooth(0.9, 1.8, Math.hypot(x / 0.34, (y - 0.44) / 0.09)));
  return [
    {
      ink: 1,
      depth: 0,
      band: [-1, floor],
      tone: (x, y, i, j) => (hash(i, j, 11) < 0.003 * thin(x, y) ? 1 : 0),
      shimmer: (tone, i, j, time) => tone * twinkle(i, j, time),
    },
    {
      ink: 0,
      depth: 0,
      band: [-1, floor],
      tone: (x, y, i, j) => {
        const share = thin(x, y);
        if (hash(i, j, 12) < 0.0014 * share) return 1;
        // One candidate per 24-dot block, drawn as a plus.
        const blockI = Math.floor(i / 24);
        const blockJ = Math.floor(j / 24);
        if (hash(blockI, blockJ, 13) > 0.11 * share) return 0;
        const di = i - (blockI * 24 + 2 + Math.floor(hash(blockI, blockJ, 14) * 20));
        const dj = j - (blockJ * 24 + 2 + Math.floor(hash(blockI, blockJ, 15) * 20));
        return (di === 0 && Math.abs(dj) <= 1) || (dj === 0 && Math.abs(di) <= 1) ? 1 : 0;
      },
      // A four-point star dims as one.
      shimmer: (tone, i, j, time) =>
        tone * twinkle(Math.floor(i / 24), Math.floor(j / 24) + 4096, time),
    },
  ];
}

/** Stellar: the lit edge of a planet from orbit, with a small moon. */
const limb: Scene = {
  hues: [38, -24],
  layers: ({ aspect }) => {
    const centreX = -0.16 * aspect;
    const centreY = 2.32;
    const radius = 1.7;
    const height = (x: number, y: number) => Math.hypot(x - centreX, y - centreY) - radius;
    // Sunrise side: the limb brightens to the right.
    const lit = (x: number) => 0.3 + 0.7 * smooth(-0.5 * aspect, 0.4 * aspect, x);
    const moonX = 0.34 * aspect;
    return [
      ...stars(1.1),
      {
        ink: 1,
        depth: 0.4,
        band: [0.2, 1],
        tone: (x, y) => {
          const d = height(x, y);
          return d > 0 ? (0.62 * Math.exp(-d / 0.04) + 0.1 * Math.exp(-d / 0.11)) * lit(x) : 0;
        },
      },
      {
        ink: 2,
        depth: 0.4,
        solid: true,
        band: [0.55, 1],
        tone: (x, y) => {
          const d = height(x, y);
          if (d > 0) return OUTSIDE;
          const land = smooth(0.5, 0.6, fbm2(x * 3.1 + 4, y * 5.2, 21));
          const cloud = smooth(0.58, 0.75, fbm2(x * 7 + 9, y * 16, 25));
          return (0.12 + 0.36 * land + 0.3 * cloud) * (1 - 0.6 * smooth(0, 0.34, -d));
        },
      },
      {
        ink: 0,
        depth: 0.4,
        band: [0.5, 1],
        tone: (x, y) => {
          const d = height(x, y);
          const edge = 0.95 * Math.exp(-Math.abs(d) / 0.0035);
          return (edge + (d < 0 ? 0.4 * Math.exp(d / 0.028) : 0)) * lit(x);
        },
      },
      {
        ink: 0,
        depth: 0.1,
        solid: true,
        band: [0.14, 0.26],
        tone: (x, y) => {
          const d = Math.hypot(x - moonX, y - 0.2);
          if (d > 0.02) return OUTSIDE;
          return 0.35 + 0.6 * smooth(0.012, -0.02, x - moonX + (y - 0.2) * 0.5);
        },
      },
    ];
  },
};

/** Night Edit: a city skyline with lit windows under a full moon. */
const city: Scene = {
  hues: [-28, 22],
  layers: ({ aspect, dot }) => {
    const ground = 0.89;
    const moonX = 0.31 * aspect;
    const moonY = 0.19;
    const moonRadius = 0.052;
    const farTop = (x: number) => {
      const k = Math.floor(x / 0.042);
      return ground - 0.07 - 0.2 * hash(k, 0, 31) ** 1.6 - (hash(k, 0, 32) < 0.12 ? 0.1 : 0);
    };
    const nearTop = (x: number) => {
      const k = Math.floor(x / 0.075);
      const inset = (x / 0.075 - k - 0.5) * 2;
      const base = 0.06 + 0.3 * hash(k, 0, 33) ** 2;
      // A narrower upper stage on some towers.
      const crown = Math.abs(inset) < 0.55 && hash(k, 0, 34) < 0.5 ? 0.035 : 0;
      return ground - base - crown;
    };
    return [
      ...stars(0.75),
      {
        ink: 1,
        depth: 0.05,
        band: [0, 0.5],
        tone: (x, y) => {
          const d = Math.hypot(x - moonX, y - moonY) - moonRadius;
          return d > 0 ? 0.3 * Math.exp(-d / 0.07) : 0;
        },
      },
      {
        ink: 0,
        depth: 0.05,
        solid: true,
        band: [moonY - moonRadius, moonY + moonRadius],
        tone: (x, y) => {
          if (Math.hypot(x - moonX, y - moonY) > moonRadius) return OUTSIDE;
          return 0.96 - 0.3 * smooth(0.52, 0.62, fbm2(x * 24, y * 24, 35));
        },
      },
      {
        ink: 1,
        depth: 0.1,
        band: [0.4, ground],
        tone: (_x, y) => 0.62 * Math.exp(-(ground - y) / 0.13),
      },
      {
        ink: 2,
        depth: 0.35,
        solid: true,
        band: [0.45, ground],
        tone: (x, y) => (y > farTop(x) ? 0.42 : OUTSIDE),
      },
      {
        ink: 0,
        depth: 0.7,
        solid: true,
        band: [0.4, ground],
        tone: (x, y, i, j) => {
          const top = nearTop(x);
          if (y < top) return OUTSIDE;
          const k = Math.floor(x / 0.075);
          const inset = Math.abs(x / 0.075 - k - 0.5) * 2;
          // A gap of sky between towers, and a dark edge so each one reads as a block.
          if (inset > 0.86) return y > ground - 0.05 ? 0 : OUTSIDE;
          if (y - top < dot) return 0.4;
          if (y - top < dot * 3 || inset > 0.7 || i % 3 !== 1 || j % 4 > 1) return 0;
          // Whole floors go dark together; some towers are mostly asleep.
          const floorLit = hash(k, Math.floor(j / 4), 39) < 0.75;
          const lit = hash(Math.floor(i / 3), Math.floor(j / 4), 36) < 0.25 + 0.45 * hash(k, 0, 37);
          return floorLit && lit ? 1 : UNLIT;
        },
        // Now and then a room's light goes off, or a dark one comes on, for a while.
        shimmer: (tone, i, j, time) => {
          if (tone !== 1 && tone !== UNLIT) return tone;
          const lit = tone === 1;
          if (time === null) return lit ? 1 : 0;
          const room = Math.floor(i / 3);
          const level = Math.floor(j / 4);
          const period = 20 + 30 * hash(room, level, 41);
          const phase = time / period + hash(room, level, 42);
          const turn = Math.floor(phase);
          const at = phase - turn;
          const switched =
            at > 0.25 && at < 0.75 && hash(room + turn * 7919, level, 43) < (lit ? 0.05 : 0.025);
          return lit !== switched ? 1 : 0;
        },
      },
      {
        ink: 0,
        depth: 1,
        solid: true,
        band: [ground, 2],
        tone: (x, y, i, j) => {
          const row = Math.round((y - ground) / dot);
          // Street lamps along the kerb, then headlight trails on the road below.
          if (row === 2) return i % 9 === 0 ? 1 : 0;
          const depth = (y - ground) / (1 - ground);
          return row > 5 && row % 4 === 0 && noise1(x * (30 - 18 * depth) + j * 17.3, 38) > 0.74
            ? 0.8 - 0.4 * depth
            : 0;
        },
      },
    ];
  },
};

/** Darkroom: dunes at dusk with the sun on the horizon. */
const dunes: Scene = {
  hues: [-32, -50],
  layers: ({ aspect, dot }) => {
    const sunX = 0.27 * aspect;
    const sunY = 0.63;
    const sunRadius = 0.085;
    // Long swells only: finer detail would flicker the lit and shaded faces.
    const ridgeOf =
      (base: number, amplitude: number, frequency: number, seed: number) => (x: number) =>
        base -
        amplitude *
          (0.72 * noise1(x * frequency + seed, seed) ** 1.4 +
            0.28 * noise1(x * frequency * 2.3 + seed, seed + 1));
    const dune = (
      ink: Ink,
      depth: number,
      base: number,
      amplitude: number,
      frequency: number,
      seed: number,
    ): SceneLayer => {
      const ridge = ridgeOf(base, amplitude, frequency, seed);
      return {
        ink,
        depth,
        solid: true,
        band: [base - amplitude, 2],
        tone: (x, y) => {
          const top = ridge(x);
          if (y < top) return OUTSIDE;
          const slope = (ridge(x + 0.02) - ridge(x - 0.02)) / 0.04;
          // The face turned to the sun catches it; the lee side is in shadow.
          const towards = Math.max(-1, Math.min(1, (sunX - x) / 0.2));
          // Wide ramps: a narrow one turns each ridge peak into a vertical seam down the dune.
          const facing = smooth(-0.45, 0.45, slope * towards);
          const below = y - top;
          // A fading rim rather than a hard one-dot line, which steps visibly on shallow slopes.
          const crest = 0.3 * facing * Math.exp(-below / (dot * 3));
          const ripple = depth === 1 ? 0.08 * smooth(0.55, 0.9, noise1(y * 160 + x * 14, 44)) : 0;
          return (0.08 + 0.52 * facing) * Math.exp(-below / 0.12) + crest + ripple;
        },
      };
    };
    return [
      ...stars(0.55, 0.7),
      {
        ink: 1,
        depth: 0.05,
        band: [0.1, 0.8],
        tone: (x, y) => {
          const d = Math.hypot(x - sunX, y - sunY) - sunRadius;
          const band = 0.3 * Math.exp(-Math.abs(y - 0.68) / 0.03);
          return d > 0 ? 0.6 * Math.exp(-d / 0.07) + 0.12 * Math.exp(-d / 0.2) + band : 0;
        },
      },
      {
        ink: 0,
        depth: 0.05,
        solid: true,
        band: [sunY - sunRadius, sunY + sunRadius],
        tone: (x, y) => {
          if (Math.hypot(x - sunX, y - sunY) > sunRadius) return OUTSIDE;
          return 1 - 0.3 * smooth(sunY - sunRadius, sunY + sunRadius, y);
        },
      },
      dune(1, 0.3, 0.72, 0.1, 1.9, 41),
      dune(1, 0.6, 0.83, 0.15, 1.3, 42),
      dune(2, 1, 0.97, 0.17, 0.9, 43),
      // Sand blown off the near crests in short gusts, drifting downwind and settling.
      motes(1, 1, dot, (time) => {
        const near = ridgeOf(0.97, 0.17, 0.9, 43);
        const grains: Array<Mote> = [];
        for (let k = 0; k < 36; k++) {
          const life = 2.4 + 1.6 * hash(k, 0, 140);
          const phase = time / life + hash(k, 1, 140);
          const turn = Math.floor(phase);
          const at = phase - turn;
          // Gusts come and go across the whole field.
          const gust = noise1(time / 9 + k * 0.03, 143);
          if (hash(k + turn * 7919, 2, 140) > gust * 1.1 || at > 0.9) continue;
          const startX = (hash(k + turn * 7919, 3, 140) - 0.5) * aspect;
          const x = startX + at * 0.08;
          const y = near(startX) - dot * 1.5 - 0.014 * Math.sin(at * Math.PI) + at * 0.006;
          if (clearOfHeading(x, y) < 0.6) continue;
          grains.push([x, y, 0.75 * (1 - at)]);
        }
        return grains;
      }),
    ];
  },
};

/** Studio: an empty soundstage, lamps on a truss washing the back wall. */
const soundstage: Scene = {
  hues: [0, 0],
  layers: ({ aspect, dot }) => {
    const floor = 0.71;
    const truss = 0.05;
    const keyX = 0.31 * aspect;
    const keyY = 0.4;
    const keyRadius = 0.17;
    const fillX = -0.33 * aspect;
    const fillY = 0.47;
    const fillRadius = 0.12;
    const standX = keyX + 0.07;
    const beam = (lampX: number, x: number, y: number, toX: number, toY: number, r: number) => {
      const t = (y - truss) / (toY - truss);
      if (t <= 0 || t >= 1) return 0;
      const centre = lampX + (toX - lampX) * t;
      return Math.abs(x - centre) < r * (0.08 + 0.9 * t) ? 0.16 * (1 - 0.5 * t) : 0;
    };
    return [
      {
        ink: 2,
        depth: 0.1,
        band: [0, floor],
        tone: (x, y) =>
          0.2 * smooth(0.42, floor, y) +
          beam(keyX - 0.06, x, y, keyX, keyY, keyRadius) +
          beam(fillX + 0.04, x, y, fillX, fillY, fillRadius),
      },
      {
        ink: 0,
        depth: 0.1,
        band: [keyY - keyRadius, Math.min(floor, keyY + keyRadius)],
        tone: (x, y) => {
          const d = Math.hypot(x - keyX, y - keyY);
          return 0.62 * (1 - smooth(keyRadius * 0.72, keyRadius, d)) * (1 - 0.3 * (d / keyRadius));
        },
      },
      {
        ink: 1,
        depth: 0.1,
        band: [fillY - fillRadius, fillY + fillRadius],
        tone: (x, y) =>
          0.5 * (1 - smooth(fillRadius * 0.6, fillRadius, Math.hypot(x - fillX, y - fillY))),
      },
      {
        ink: 1,
        depth: 0.2,
        band: [truss - 0.02, truss + 0.05],
        tone: (x, y, i, j) => {
          const row = Math.round((y - truss) / dot);
          if (row === -3 || row === 3) return 0.9;
          if (row > -3 && row < 3) return (i + j) % 6 === 0 || (i - j + 6000) % 6 === 0 ? 0.9 : 0;
          // Lamp housings hang under the truss.
          const lamp = Math.min(Math.abs(x - keyX + 0.06), Math.abs(x - fillX - 0.04));
          return row > 3 && row < 11 && lamp < dot * (2 + (row - 3) * 0.45) ? 1 : 0;
        },
      },
      {
        ink: 2,
        depth: 0.6,
        solid: true,
        band: [floor, 2],
        tone: (x, y) => {
          const fall = y - floor + 0.012;
          // A taped grid on the floor, converging on the back wall.
          const across = 0.3 / fall;
          const along = (x / fall) * 1.2;
          // Each tape line stays about a dot wide however near it runs.
          const line =
            Math.abs(across - Math.round(across)) * fall * fall < dot * 0.18 ||
            Math.abs(along - Math.round(along)) * fall < dot * 0.72;
          return line ? 0.55 * smooth(0, 0.04, fall) : 0.06;
        },
      },
      {
        ink: 0,
        depth: 0.6,
        band: [floor, 2],
        tone: (x, y) => {
          const e = Math.hypot((x - keyX) / 0.3, (y - 0.86) / 0.07);
          return 0.4 * (1 - smooth(0.45, 1, e));
        },
      },
      {
        // A light stand in silhouette against the lit wall.
        ink: 2,
        depth: 0.85,
        solid: true,
        band: [0.46, 0.93],
        tone: (x, y) => {
          const dx = Math.abs(x - standX);
          const pole = dx < dot * 0.8 && y > 0.5 && y < 0.9;
          const head = dx < 0.014 + (y - 0.47) * 0.25 && y > 0.47 && y < 0.5;
          const legs = y > 0.84 && y < 0.92 && Math.abs(dx - (y - 0.84) * 0.6) < dot * 0.9;
          return pole || head || legs ? 0 : OUTSIDE;
        },
      },
      // Dust turning slowly in the key lamp's beam.
      motes(0, 0.1, dot, (time) => {
        const lampX = keyX - 0.06;
        const dust: Array<Mote> = [];
        for (let k = 0; k < 14; k++) {
          const down = 0.25 + 0.7 * noise1(time * 0.03 + k * 5.3, 160);
          const side = (noise1(time * 0.04 + k * 3.1, 161) - 0.5) * 1.6;
          const y = truss + (keyY - truss) * down;
          const x = lampX + (keyX - lampX) * down + side * keyRadius * (0.08 + 0.9 * down);
          dust.push([x, y, 0.55 + 0.4 * hash(k, 0, 162)]);
        }
        return dust;
      }),
    ];
  },
};

/** Drive-In: a lit screen in a dark field, the projector beam overhead, cars parked below. */
const driveIn: Scene = {
  hues: [52, 112],
  layers: ({ aspect, dot }) => {
    const horizon = 0.77;
    const screenX = -0.33 * aspect;
    const screenY = 0.5;
    const halfWidth = 0.17;
    const halfHeight = 0.105;
    const boothX = 0.34 * aspect;
    const boothY = 0.79;
    const outsideScreen = (x: number, y: number) =>
      Math.hypot(
        Math.max(0, Math.abs(x - screenX) - halfWidth),
        Math.max(0, Math.abs(y - screenY) - halfHeight),
      );
    // The beam fills the triangle from the booth to the screen's far corners.
    const side = (ax: number, ay: number, bx: number, by: number, x: number, y: number) =>
      (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    const topRightX = screenX + halfWidth;
    const topRightY = screenY - halfHeight;
    const bottomLeftX = screenX - halfWidth;
    const bottomLeftY = screenY + halfHeight;
    // Seen from behind, facing the screen: a boot, a cabin, a lit rear window, two tail lights.
    const cars = (depth: number, base: number, width: number, seed: number): SceneLayer => {
      const period = width * 1.55;
      const body = width * 0.3;
      const cabin = width * 0.27;
      return {
        ink: 0,
        depth,
        solid: true,
        band: [base - body - cabin - 0.01, 2],
        tone: (x, y) => {
          const slot = Math.floor(x / period);
          const u = (x - slot * period) / width;
          if (u > 1 || hash(slot, 0, seed) < 0.16) return y > base ? 0 : OUTSIDE;
          const across = Math.abs(u - 0.5) * 2;
          const shoulder = base - body;
          const roof = shoulder - cabin;
          const cabinEdge = 0.6 + 0.22 * ((y - roof) / cabin);
          if (y < roof || (y < shoulder && across > cabinEdge) || across > 1) {
            return y > base ? 0 : OUTSIDE;
          }
          if (y < shoulder) {
            if (y - roof < dot) return 0.5;
            const glass = across < cabinEdge - 0.14 && y > roof + dot * 1.5 && y < shoulder - dot;
            return glass ? 0.3 : 0;
          }
          if (y - shoulder < dot && across > cabinEdge) return 0.5;
          const light = across > 0.72 && across < 0.92 && Math.abs(y - shoulder - dot * 2.5) < dot;
          return light ? 1 : 0;
        },
      };
    };
    return [
      ...stars(horizon),
      {
        ink: 1,
        depth: 0.3,
        band: [0.1, 0.9],
        tone: (x, y) => {
          const d = outsideScreen(x, y);
          const glow = 0.5 * Math.exp(-d / 0.03) + 0.07 * Math.exp(-d / 0.1);
          const inBeam =
            side(boothX, boothY, topRightX, topRightY, x, y) < 0 &&
            side(boothX, boothY, bottomLeftX, bottomLeftY, x, y) > 0 &&
            x < boothX;
          if (!inBeam) return glow;
          const reach = (boothX - x) / (boothX - screenX);
          const dust = fbm2(x * 9, y * 22, 51);
          return glow + (0.07 + 0.2 * dust) * (0.5 + 0.5 * reach);
        },
      },
      {
        ink: 2,
        depth: 0.4,
        solid: true,
        band: [horizon - 0.09, 2],
        tone: (x, y) => {
          const top = horizon - 0.05 * fbm1(x * 7, 52) - 0.025 * noise1(x * 46, 53);
          if (y < top) return OUTSIDE;
          return y < horizon ? 0.3 : 0.16 * Math.exp(-(y - horizon) / 0.1) + 0.03;
        },
      },
      {
        // Screen legs, braced.
        ink: 2,
        depth: 0.3,
        solid: true,
        band: [screenY + halfHeight, horizon + 0.03],
        tone: (x, y, i, j) => {
          const dx = Math.abs(Math.abs(x - screenX) - halfWidth * 0.72);
          if (dx > 0.011) return OUTSIDE;
          return dx > 0.007 || (i + j) % 4 === 0 ? 0.75 : 0.1;
        },
      },
      {
        ink: 0,
        depth: 0.3,
        solid: true,
        band: [screenY - halfHeight, screenY + halfHeight],
        tone: (x, y) => {
          const dx = Math.abs(x - screenX);
          const dy = Math.abs(y - screenY);
          if (dx > halfWidth || dy > halfHeight) return OUTSIDE;
          if (halfWidth - dx < dot * 1.5 || halfHeight - dy < dot * 1.5) return 1;
          // A countdown leader: two rings and a crosshair.
          const d = Math.hypot(dx, dy);
          if (Math.abs(d - 0.074) < dot * 1.1 || Math.abs(d - 0.056) < dot * 0.8) return 0.25;
          if (dx < dot * 0.7 || dy < dot * 0.7) return 0.35;
          return 0.8 + 0.14 * noise2(x * 60, y * 60, 54) - 0.2 * (dx / halfWidth) ** 4;
        },
      },
      {
        // The projection booth: a dark hut with one lit port.
        ink: 0,
        depth: 0.5,
        solid: true,
        band: [boothY - 0.03, horizon + 0.04],
        tone: (x, y) => {
          const dx = x - boothX;
          if (dx < -0.008 || dx > 0.05 || y < boothY - 0.022 || y > horizon + 0.035) return OUTSIDE;
          return Math.abs(dx) < dot * 1.2 && Math.abs(y - boothY) < dot * 1.2 ? 1 : 0;
        },
      },
      cars(0.7, 0.9, 0.085, 55),
      cars(1, 1.0, 0.13, 56),
    ];
  },
};

/** A custom or imported theme: a ringed planet low in an open sky. */
const orbit: Scene = {
  hues: [40, -30],
  layers: ({ aspect }) => {
    const planetX = 0.27 * aspect;
    const planetY = 0.71;
    const radius = 0.125;
    const cos = Math.cos(-0.33);
    const sin = Math.sin(-0.33);
    const ring = (x: number, y: number, front: boolean) => {
      const dx = x - planetX;
      const dy = y - planetY;
      const along = dx * cos + dy * sin;
      const across = -dx * sin + dy * cos;
      if (across > 0 !== front) return 0;
      const r = Math.hypot(along, across / 0.26) / radius;
      if (r < 1.42 || r > 2.5) return 0;
      // Gaps between the bands, widest two thirds of the way out.
      const gap = Math.abs(r - 2.02) < 0.05 || Math.abs(r - 1.66) < 0.02;
      return gap ? 0 : 0.3 + 0.4 * noise1(r * 26, 61);
    };
    const moonX = -0.3 * aspect;
    return [
      ...stars(1.2),
      {
        ink: 2,
        depth: 0.2,
        band: [0.6, 2],
        tone: (x, y) => 0.22 * smooth(0.7, 1.05, y) * fbm2(x * 3, y * 9, 62),
      },
      {
        ink: 1,
        depth: 0.5,
        band: [planetY - 0.3, planetY + 0.3],
        tone: (x, y) => {
          const d = Math.hypot(x - planetX, y - planetY) - radius;
          return ring(x, y, false) + (d > 0 ? 0.3 * Math.exp(-d / 0.03) : 0);
        },
      },
      {
        ink: 0,
        depth: 0.5,
        solid: true,
        band: [planetY - radius, planetY + radius],
        tone: (x, y) => {
          const dx = (x - planetX) / radius;
          const dy = (y - planetY) / radius;
          const inside = 1 - dx * dx - dy * dy;
          if (inside < 0) return OUTSIDE;
          // Lit from the upper left, with cloud bands along the ring plane.
          const light = clamp01(-0.55 * dx - 0.6 * dy + 0.58 * Math.sqrt(inside));
          const bands = 0.1 * Math.sin((dy * cos - dx * sin) * 17);
          return 0.06 + 0.86 * light + bands * light;
        },
      },
      {
        ink: 1,
        depth: 0.5,
        band: [planetY - 0.3, planetY + 0.3],
        tone: (x, y) => ring(x, y, true),
      },
      {
        ink: 1,
        depth: 0.1,
        solid: true,
        band: [0.2, 0.3],
        tone: (x, y) => {
          const d = Math.hypot(x - moonX, y - 0.25);
          return d > 0.016 ? OUTSIDE : 0.3 + 0.6 * smooth(0.01, -0.016, x - moonX + (y - 0.25));
        },
      },
    ];
  },
};

/** Keeps the middle of the pane quiet, where the new-thread heading sits: 0 there, 1 well clear. */
function clearOfHeading(x: number, y: number): number {
  return smooth(0.85, 1.6, Math.hypot(x / 0.36, (y - 0.43) / 0.1));
}

/** Long Biên: the cantilever truss over a still river at dawn, mirrored, under a mackerel sky. */
const longBien: Scene = {
  hues: [205, 22],
  layers: ({ aspect, dot }) => {
    const deck = 0.655;
    const water = 0.745;
    const span = 0.56;
    const panel = span / 14;
    // Piers sit off-centre so a tower does not stand behind the heading.
    const pierOffset = span * 0.32;
    const pierU = (x: number) => (x - pierOffset) / span - Math.round((x - pierOffset) / span);
    // Over each pier the truss rises to a tower; between, the top chord sags towards mid-span.
    const top = (x: number) => {
      const u = Math.abs(pierU(x)) * 2;
      return deck - 0.072 - 0.088 * (1 - u) ** 1.7;
    };
    const truss = (x: number, y: number): number => {
      if (y > deck + dot * 2.5) {
        return Math.abs(pierU(x)) * span < 0.016 && y < water ? 0.5 : OUTSIDE;
      }
      const roof = top(x);
      if (y < roof - dot) return OUTSIDE;
      // Chords: a heavy deck with a rail on it, a lighter top chord.
      if (y > deck - dot * 0.5) return 0.95;
      if (y > deck - dot * 3.5 && y < deck - dot * 2.5) return 0.8;
      if (y < roof + dot * 0.9) return 0.95;
      const s = x / panel - Math.floor(x / panel);
      const t = (deck - y) / (deck - roof);
      // Verticals at each panel point, and an X across every panel.
      const width = dot / panel;
      if (s < width * 0.9) return 0.9;
      const cross = Math.min(Math.abs(t - s), Math.abs(t - (1 - s)));
      return cross < width * 0.55 * (1 + 0.6 * (1 - t)) ? 0.85 : OUTSIDE;
    };
    // Mackerel sky: rows of small cloudlets, gathered in drifting patches. Returns how much of
    // a cloudlet covers the point, and how much of that is its sunlit underside.
    const mackerel = (x: number, y: number): readonly [number, number] => {
      const v = y / 0.024 + 1.6 * fbm1(x * 2.6, 81);
      const row = Math.floor(v);
      const u = x / 0.04 + row * 0.5 + 0.5 * noise1(v * 0.7, 82);
      const column = Math.floor(u);
      const fu = u - column - 0.5 - 0.25 * (hash(column, row, 83) - 0.5);
      const fv = v - row - 0.5 - 0.25 * (hash(column, row, 84) - 0.5);
      const patch = smooth(0.28, 0.52, fbm2(x * 1.9 + y * 1.2, y * 3.1, 85));
      const size = patch * (0.7 + 0.35 * hash(column, row, 86));
      if (size <= 0.05) return [0, 0];
      const d = Math.hypot(fu / 0.46, fv / 0.38) / size;
      const cover = smooth(1, 0.75, d);
      return [cover, cover * smooth(-0.05, 0.3, fv)];
    };
    // Bright towards the horizon, where the mist sits.
    const blue = (y: number) => 0.04 + 0.24 * smooth(water - 0.04, 0.02, y);
    const mirror = (y: number) => 2 * water - y;
    // Below the waterline, a row breaks now and then where a breath of wind crosses it.
    const still = (x: number, j: number) => noise1(x * 7 + j * 13.1, 84) > 0.2;
    const mist = (y: number) => Math.exp(-Math.abs(y - water) / 0.025);
    const boats = [-0.58, -0.21, 0.13, 0.47].map((at, k) => ({
      x: at * aspect * 0.9 + 0.03 * hash(k, 0, 85),
      width: 0.045 + 0.03 * hash(k, 1, 85),
    }));
    const boat = (x: number, y: number) => {
      for (const { x: bx, width } of boats) {
        const dx = x - bx;
        if (Math.abs(dx) > width / 2) continue;
        const h = water - y;
        if (h < 0 || h > 0.022) continue;
        // Hull, then a cabin under a low curved roof.
        if (h < 0.006) return 0.85;
        const cabin = Math.abs(dx) < width * 0.36;
        const roof = 0.018 - 0.006 * (dx / width) ** 2 * 4;
        if (cabin && h < roof) return h > roof - dot ? 0.9 : 0.45;
      }
      return OUTSIDE;
    };
    // Now and then a train crosses, left to right, inside the truss.
    const carLength = 0.062;
    const train = carLength * 7;
    const trainHeight = 0.02;
    const trainHead = (time: number | null) =>
      time === null ? null : -aspect / 2 - SIDEBAR_REACH + (((time + 70) % 100) - 3) * 0.045;
    const carriage = (x: number, y: number, head: number) => {
      const along = head - x;
      const h = deck - dot * 0.5 - y;
      if (along < 0 || along > train || h < 0 || h > trainHeight) return OUTSIDE;
      const inCar = along % carLength;
      if (inCar > carLength - dot * 1.2) return OUTSIDE;
      // The engine's cab slopes back from its nose.
      if (along < 0.014 && h > trainHeight * 0.45 + (0.014 - along) * 0.9) return OUTSIDE;
      if (h > trainHeight - dot) return 0.85;
      const pane = (inCar / (dot * 4)) % 1;
      return h > trainHeight * 0.45 && h < trainHeight * 0.8 && pane > 0.3 ? 1 : 0.4;
    };
    const trainBox = (time: number | null, flip: boolean): ReadonlyArray<Sprite> => {
      const head = trainHead(time);
      if (head === null || head < -aspect / 2 - SIDEBAR_REACH || head - train > aspect / 2 + 0.02) {
        return [];
      }
      const lower = deck - dot * 0.5;
      const upper = lower - trainHeight;
      return [
        {
          x0: head - train,
          x1: head,
          y0: flip ? mirror(lower) : upper,
          y1: flip ? mirror(upper) : lower,
          key: Math.round(head / dot),
        },
      ];
    };
    return [
      {
        ink: 1,
        depth: 0,
        band: [-1, 2],
        tone: (x, y) => {
          const above = y < water;
          const sy = above ? y : mirror(y);
          const tone = blue(sy) * (1 - mackerel(x, sy)[0]);
          return above
            ? tone * (0.25 + 0.75 * clearOfHeading(x, y))
            : tone * 0.75 * (1 - 0.85 * mist(y));
        },
      },
      {
        // Dawn on the undersides of the cloudlets, and a peach haze low over the river.
        ink: 2,
        depth: 0,
        band: [-1, 2],
        tone: (x, y) => {
          const sy = y < water ? y : mirror(y);
          const lit = mackerel(x, sy)[1] * (0.25 + 0.4 * smooth(0, water, sy));
          return (lit + 0.22 * mist(y)) * (0.35 + 0.65 * clearOfHeading(x, y));
        },
      },
      {
        // The far bank: a low line of trees and roofs, half lost in mist.
        ink: 1,
        depth: 0.25,
        solid: true,
        band: [water - 0.06, water + 0.06],
        tone: (x, y) => {
          const bank = water - 0.012 - 0.022 * fbm1(x * 9, 86) - 0.012 * noise1(x * 40, 87);
          const below = bank + (water - bank) * 2;
          if (y < bank || y > below) return OUTSIDE;
          return (y < water ? 0.4 : 0.22) * (1 - 0.55 * mist(y));
        },
      },
      {
        ink: 0,
        depth: 0.6,
        solid: true,
        band: [deck - 0.17, water + 0.02],
        tone: (x, y) => boat(x, y),
      },
      {
        ink: 0,
        depth: 0.6,
        band: [water, water + 0.03],
        tone: (x, y, _i, j) => {
          const tone = boat(x, mirror(y));
          return tone > 0 && still(x, j) ? tone * 0.5 : 0;
        },
      },
      {
        // Behind the truss, so the train shows through the gaps between its members.
        ink: 1,
        depth: 0.6,
        solid: true,
        band: [deck - 0.05, deck],
        sprites: (time) => trainBox(time, false),
        tone: (x, y, _i, _j, time) => {
          const head = trainHead(time);
          return head === null ? OUTSIDE : carriage(x, y, head);
        },
      },
      {
        ink: 0,
        depth: 0.6,
        solid: true,
        band: [deck - 0.17, water],
        tone: (x, y) => truss(x, y),
      },
      {
        ink: 1,
        depth: 0.6,
        band: [water, 2],
        sprites: (time) => trainBox(time, true),
        tone: (x, y, _i, j, time) => {
          const head = trainHead(time);
          const tone = head === null ? OUTSIDE : carriage(x, mirror(y), head);
          return tone > 0 && still(x, j) ? tone * 0.45 : 0;
        },
      },
      {
        // The bridge upside down in the river, a little paler, broken by the odd ripple.
        ink: 0,
        depth: 0.6,
        band: [water, 2],
        tone: (x, y, _i, j) => {
          const tone = truss(x, mirror(y));
          return tone > 0 && still(x, j) ? tone * (0.62 - 0.3 * mist(y)) : 0;
        },
      },
    ];
  },
};

interface Capsule {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  readonly r: number;
}

/** Distance from a point to a capsule's surface; negative inside. */
function capsuleDistance(c: Capsule, x: number, y: number): number {
  const dx = c.bx - c.ax;
  const dy = c.by - c.ay;
  const t = clamp01(((x - c.ax) * dx + (y - c.ay) * dy) / (dx * dx + dy * dy || 1));
  return Math.hypot(x - c.ax - dx * t, y - c.ay - dy * t) - c.r;
}

/** Items bucketed by cell so a tone function only tests what is near it. */
function bucket<T>(items: ReadonlyArray<T>, cell: number, bounds: (item: T) => readonly number[]) {
  const cells = new Map<number, Array<T>>();
  const key = (i: number, j: number) => (i + 512) * 4096 + (j + 512);
  for (const item of items) {
    const [x0, y0, x1, y1] = bounds(item) as [number, number, number, number];
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) {
      for (let j = Math.floor(y0 / cell); j <= Math.floor(y1 / cell); j++) {
        const list = cells.get(key(i, j));
        if (list) list.push(item);
        else cells.set(key(i, j), [item]);
      }
    }
  }
  const empty: Array<T> = [];
  return (x: number, y: number) =>
    cells.get(key(Math.floor(x / cell), Math.floor(y / cell))) ?? empty;
}

/** Sakura: cherry boughs reaching in from the edges, blossom clusters and petals on the air. */
const sakura: Scene = {
  hues: [10, -25],
  layers: ({ aspect, dot }) => {
    const branches: Array<Capsule> = [];
    const flowers: Array<{ x: number; y: number; r: number; turn: number }> = [];
    let seed = 0;
    const grow = (
      x: number,
      y: number,
      angle: number,
      length: number,
      r: number,
      level: number,
    ) => {
      // Each limb bends a little as it goes, in three steps.
      let px = x;
      let py = y;
      let heading = angle;
      for (let step = 0; step < 3; step++) {
        heading += (hash(seed++, level, 91) - 0.5) * 0.5;
        const nx = px + Math.cos(heading) * (length / 3);
        const ny = py + Math.sin(heading) * (length / 3);
        // Limbs stop short of the heading rather than grow across it.
        if (clearOfHeading(nx, ny) < 0.75) return;
        branches.push({ ax: px, ay: py, bx: nx, by: ny, r: r * (1 - step * 0.12) });
        if (level >= 2) {
          const count = level >= 3 ? 3 : 1;
          for (let k = 0; k < count; k++) {
            const spread = 0.012 + 0.016 * hash(seed++, k, 92);
            const around = hash(seed++, k, 93) * Math.PI * 2;
            const fx = nx + Math.cos(around) * spread;
            const fy = ny + Math.sin(around) * spread;
            if (clearOfHeading(fx, fy) < 0.85) continue;
            flowers.push({
              x: fx,
              y: fy,
              r: 0.0085 + 0.006 * hash(seed++, k, 94),
              turn: hash(seed++, k, 95) * Math.PI,
            });
          }
        }
        px = nx;
        py = ny;
      }
      if (level >= 4) return;
      const children = level === 0 ? 3 : 2;
      for (let k = 0; k < children; k++) {
        const side = k % 2 === 0 ? 1 : -1;
        const turn = side * (0.35 + 0.35 * hash(seed++, k, 96));
        grow(
          px,
          py,
          heading + turn,
          length * (0.62 + 0.12 * hash(seed++, k, 97)),
          r * 0.6,
          level + 1,
        );
      }
    };
    const edge = aspect / 2;
    // One bough over the top left, one hanging from the top right, one rising at the lower right.
    grow(-edge - 0.04, 0.06, 0.32, 0.36, 0.011, 0);
    grow(edge + 0.03, -0.03, Math.PI - 0.62, 0.26, 0.009, 0);
    grow(edge + 0.04, 0.86, Math.PI + 0.78, 0.3, 0.01, 0);
    const branchesNear = bucket(branches, 0.08, (c) => [
      Math.min(c.ax, c.bx) - c.r,
      Math.min(c.ay, c.by) - c.r,
      Math.max(c.ax, c.bx) + c.r,
      Math.max(c.ay, c.by) + c.r,
    ]);
    const flowersNear = bucket(flowers, 0.08, (f) => [f.x - f.r, f.y - f.r, f.x + f.r, f.y + f.r]);
    // Five rounded petals with a notch at each tip; 1 inside, falling off over a dot at the edge.
    const blossom = (x: number, y: number): readonly [number, number] => {
      let petal = 0;
      let heart = 0;
      for (const f of flowersNear(x, y)) {
        const dx = x - f.x;
        const dy = y - f.y;
        const d = Math.hypot(dx, dy);
        if (d > f.r) continue;
        const a = Math.atan2(dy, dx) * 2.5 + f.turn;
        const lobe =
          f.r * (0.72 + 0.28 * Math.abs(Math.cos(a)) - 0.12 * Math.abs(Math.sin(a)) ** 8);
        if (d < lobe) petal = Math.max(petal, 0.55 + 0.35 * (d / lobe));
        if (d < f.r * 0.22) heart = 1;
      }
      return [petal, heart];
    };
    return [
      {
        // Blush haze thickening towards a low line of far hills.
        ink: 2,
        depth: 0.1,
        band: [0.3, 2],
        tone: (x, y) => {
          const hills = 0.86 - 0.1 * fbm1(x * 1.6, 98) - 0.03 * noise1(x * 7, 99);
          const haze = 0.16 * smooth(0.5, 1, y) * (0.4 + 0.6 * clearOfHeading(x, y));
          return y > hills ? 0.4 + 0.12 * smooth(hills, 1, y) : haze;
        },
      },
      {
        // A pale sun behind the blossom.
        ink: 2,
        depth: 0.05,
        band: [0.1, 0.45],
        tone: (x, y) => {
          const d = Math.hypot(x + edge * 0.5, y - 0.27) - 0.075;
          return d < 0 ? 0.4 : 0.14 * Math.exp(-d / 0.04);
        },
      },
      {
        // Petals drifting down and across, one or two dots each.
        ink: 1,
        depth: 0.35,
        band: [0, 1.2],
        tone: (x, y, i, j) => {
          const cellI = Math.floor(i / 9);
          const cellJ = Math.floor(j / 9);
          if (hash(cellI, cellJ, 100) > 0.11 * (0.2 + 0.8 * clearOfHeading(x, y))) return 0;
          const ci = cellI * 9 + 1 + Math.floor(hash(cellI, cellJ, 101) * 7);
          const cj = cellJ * 9 + 1 + Math.floor(hash(cellI, cellJ, 102) * 7);
          const long = hash(cellI, cellJ, 103) < 0.5;
          const hit =
            (i === ci && j === cj) || (long ? i === ci + 1 && j === cj : i === ci && j === cj + 1);
          return hit ? 0.95 : 0;
        },
      },
      {
        ink: 0,
        depth: 0.7,
        solid: true,
        band: [-0.2, 1.2],
        tone: (x, y) => {
          for (const c of branchesNear(x, y)) {
            const d = capsuleDistance(c, x, y);
            // Bark: dark through, with a lighter sheen down one side of the thicker limbs.
            if (d < 0) return c.r > dot * 2.5 && d > -c.r * 0.4 && y < (c.ay + c.by) / 2 ? 0.7 : 1;
          }
          return OUTSIDE;
        },
      },
      {
        ink: 1,
        depth: 0.75,
        solid: true,
        band: [-0.2, 1.2],
        tone: (x, y) => {
          const [petal, heart] = blossom(x, y);
          return heart > 0 ? OUTSIDE : petal > 0 ? petal : OUTSIDE;
        },
      },
      {
        ink: 0,
        depth: 0.75,
        band: [-0.2, 1.2],
        tone: (x, y) => (blossom(x, y)[1] > 0 ? 0.9 : 0),
      },
      // A few petals let go of the boughs at the sides, swaying and turning over as they fall.
      motes(1, 0.8, dot, (time) => {
        const falling: Array<Mote> = [];
        for (let k = 0; k < 14; k++) {
          const fall = 26 + 14 * hash(k, 0, 150);
          const phase = time / fall + hash(k, 1, 150);
          const turn = Math.floor(phase);
          const at = phase - turn;
          const side = k % 2 === 0 ? -1 : 1;
          const from = side * (0.24 + 0.24 * hash(k + turn * 7919, 2, 150)) * aspect;
          const x = from + at * 0.1 + 0.02 * Math.sin(time * 0.7 + k * 2.1);
          const y = -0.08 + at * 1.25;
          if (clearOfHeading(x, y) < 0.7) continue;
          const shape = Math.floor(time / 1.7 + k) % 3;
          falling.push([x, y, 0.95, shape === 0 ? 0 : shape === 1 ? 1 : 2]);
        }
        return falling;
      }),
    ];
  },
};

/** Shore: surf rolling onto a pale beach, foam lace on wet sand, open sea to the horizon. */
const shore: Scene = {
  hues: [-150, -28],
  layers: ({ aspect, dot }) => {
    const horizon = 0.25;
    // The waterline wanders up and down the beach.
    const shoreline = (x: number) =>
      0.74 + 0.035 * Math.sin(x * 3.1 + 0.6) + 0.02 * fbm1(x * 5, 111);
    // Breakers, far to near: each crest is a wavy line, closer ones larger and more spread.
    const crests = [
      { y: 0.565, amplitude: 0.008, seed: 112 },
      { y: 0.615, amplitude: 0.012, seed: 113 },
      { y: 0.672, amplitude: 0.016, seed: 114 },
    ];
    const crestAt = (k: number, x: number) => {
      const c = crests[k]!;
      return c.y + c.amplitude * (Math.sin(x * (9 - k * 2) + c.seed) + 0.8 * fbm1(x * 6, c.seed));
    };
    // Where along its length a crest is breaking; the rest is still a swell.
    const breaking = (k: number, x: number) => smooth(0.35, 0.6, fbm1(x * 2.2 + k * 3.7, 115 + k));
    const gulls = [
      [-0.36, 0.12, 0.026],
      [-0.315, 0.15, 0.018],
      [0.4, 0.085, 0.022],
    ] as const;
    const gullX = (at: number, time: number | null) => {
      const lap = aspect + 0.12;
      const x = at * aspect + 0.005 * (time ?? 0) + lap / 2;
      return x - Math.floor(x / lap) * lap - lap / 2;
    };
    // A wave runs up the beach every few seconds, its edge a line of foam, and slides back.
    const washPeriod = 9;
    let washed = { time: Number.NaN, reach: 0, fade: 0 };
    const wash = (time: number) => {
      if (washed.time === time) return washed;
      const at = (time / washPeriod) % 1;
      const up = at < 0.4 ? smooth(0, 0.4, at) : 1 - smooth(0.4, 1, at);
      const fade = at < 0.4 ? 1 : 1 - smooth(0.55, 1, at);
      washed = { time, reach: 0.004 + 0.036 * up, fade: Math.round(fade * 6) / 6 };
      return washed;
    };
    // The waterline by dot column, worked out once; a column can sit a margin outside the pane.
    const reachOut = 64;
    const shoreByColumn = new Float64Array(Math.ceil(aspect / dot) + reachOut * 2).fill(Number.NaN);
    const shoreAt = (i: number, x: number) => {
      const at = i + reachOut;
      if (at < 0 || at >= shoreByColumn.length) return shoreline(x);
      if (Number.isNaN(shoreByColumn[at]!)) shoreByColumn[at] = shoreline(x);
      return shoreByColumn[at]!;
    };
    // Narrow boxes follow the waterline's curve, so a tick redraws a strip, not the beach.
    const washBoxes: Array<readonly [number, number, number, number]> = [];
    const boxWidth = 0.025;
    for (let x = -aspect / 2 - boxWidth; x < aspect / 2 + boxWidth; x += boxWidth) {
      let low = Infinity;
      let high = -Infinity;
      for (let k = 0; k <= 4; k++) {
        const y = shoreline(x + (boxWidth * k) / 4);
        low = Math.min(low, y);
        high = Math.max(high, y);
      }
      washBoxes.push([x, x + boxWidth, low, high]);
    }
    return [
      {
        // A soft sky, a few long streaks of cloud, deepening upwards.
        ink: 2,
        depth: 0,
        band: [-1, horizon],
        tone: (x, y) => {
          const streak = smooth(0.55, 0.75, fbm2(x * 1.4, y * 22, 116));
          return (
            (0.12 * smooth(horizon, -0.1, y) + 0.22 * streak) * (0.4 + 0.6 * clearOfHeading(x, y))
          );
        },
      },
      {
        // The gulls glide slowly downwind, round from one side to the other.
        ink: 0,
        depth: 0.1,
        band: [0, horizon],
        sprites: (time) =>
          gulls.map(([gx, gy, span]) => {
            const x = gullX(gx, time);
            return { x0: x - span, x1: x + span, y0: gy - span * 0.4, y1: gy + span * 0.2 };
          }),
        tone: (x, y, _i, _j, time) => {
          for (const [gx, gy, span] of gulls) {
            const dx = (x - gullX(gx, time)) / span;
            if (Math.abs(dx) > 1) continue;
            // A gull is two shallow arcs meeting at the body.
            const wing =
              gy - span * 0.32 * Math.sin(Math.PI * Math.abs(dx)) + span * 0.1 * Math.abs(dx);
            if (Math.abs(y - wing) < dot * 0.75) return 0.9;
          }
          return 0;
        },
      },
      {
        // Open water: a dark line at the horizon, then swells that widen and part as they near.
        ink: 0,
        depth: 0.2,
        solid: true,
        band: [horizon, 2],
        tone: (x, y) => {
          if (y > shoreline(x)) return OUTSIDE;
          const near = (y - horizon) / (crests[0]!.y - horizon);
          if (y - horizon < dot * 1.2) return 0.7;
          const swell = Math.sin((1 / (near + 0.08)) * 6 + 2.2 * fbm1(x * 3 + y * 9, 117));
          const line = swell > 0.9 ? 0.5 - 0.25 * near : 0;
          return (line + 0.04) * (0.08 + 0.92 * clearOfHeading(x, y));
        },
      },
      {
        ink: 2,
        depth: 0.2,
        band: [horizon, 2],
        tone: (x, y) => {
          if (y > shoreline(x)) return 0;
          return (
            (0.34 - 0.2 * smooth(horizon, crests[0]!.y, y)) * (0.12 + 0.88 * clearOfHeading(x, y))
          );
        },
      },
      {
        // Each breaker: white foam on its lip, the face shadowed beneath, darkest under the curl.
        ink: 0,
        depth: 0.45,
        solid: true,
        band: [crests[0]!.y - 0.04, 0.82],
        tone: (x, y, i, j) => {
          if (y > shoreline(x)) return OUTSIDE;
          for (let k = crests.length - 1; k >= 0; k--) {
            const top = crestAt(k, x);
            const size = 0.012 + 0.008 * k;
            const breaks = breaking(k, x);
            const below = y - top;
            if (below < -size * 0.7 * breaks || below > size * 2.4) continue;
            if (below < 0) {
              // Foam: paper, flecked at its edges.
              return hash(i, j, 118 + k) < 0.12 * (1 + below / size) ? 0.6 : 0;
            }
            if (below < dot * 1.2) return 0.35 + 0.55 * breaks;
            return (0.55 * breaks + 0.18) * Math.exp(-below / (size * 0.9));
          }
          return OUTSIDE;
        },
      },
      {
        // The swash: a thin sheet running up the sand, a lace of foam at its edge.
        ink: 2,
        depth: 0.6,
        solid: true,
        band: [0.62, 0.86],
        tone: (x, y, i, j) => {
          const edge = shoreline(x);
          const run = edge + 0.035 + 0.015 * fbm1(x * 11, 119);
          if (y < edge || y > run) return OUTSIDE;
          const lace = Math.abs(y - run) < dot * 1.5 || noise2(x * 140, y * 260, 120) > 0.78;
          return lace ? (hash(i, j, 121) < 0.5 ? 0 : 0.2) : 0.42;
        },
      },
      {
        // Sand: darker where it is still wet, then dry and ribbed by the wind.
        ink: 1,
        depth: 0.8,
        solid: true,
        band: [0.6, 2],
        tone: (x, y) => {
          const run = shoreline(x) + 0.035 + 0.015 * fbm1(x * 11, 119);
          if (y < run) return OUTSIDE;
          const wet = Math.exp(-(y - run) / 0.05);
          const ribs = smooth(0.55, 0.8, noise1((y + 0.04 * fbm1(x * 4, 122)) * 120, 123));
          return 0.16 + 0.22 * wet + 0.12 * ribs * (1 - wet);
        },
      },
      {
        ink: 0,
        depth: 0.6,
        band: [0.6, 0.9],
        sprites: (time) => {
          if (time === null) return [];
          const { reach, fade } = wash(time);
          if (fade <= 0) return [];
          return washBoxes.map(([x0, x1, low, high]) => ({
            x0,
            x1,
            y0: low + reach - dot,
            y1: high + reach + dot,
            key: Math.round((reach / dot) * 2) + fade * 4096,
          }));
        },
        tone: (x, y, i, j, time) => {
          if (time === null) return 0;
          const { reach, fade } = wash(time);
          const edge = shoreAt(i, x) + reach;
          return Math.abs(y - edge) < dot * 0.8 && hash(i, j, 125) < 0.75 ? 0.55 * fade : 0;
        },
      },
    ];
  },
};

/** Train Street: narrow shophouses shoulder to shoulder, the railway running past their doors. */
const trainStreet: Scene = {
  hues: [-62, -118],
  layers: ({ aspect, dot }) => {
    const street = 0.8;
    const nearRail = 0.925;
    const farRail = 0.862;
    const storey = 0.085;
    // Tube houses: narrow, uneven, and lower towards the middle so the heading has open sky.
    const houses: Array<{ x0: number; x1: number; roof: number; seed: number }> = [];
    for (let x = -aspect / 2 - 0.1, k = 0; x < aspect / 2 + 0.1; k++) {
      const width = 0.09 + 0.06 * hash(k, 0, 131);
      const centre = x + width / 2;
      const out = Math.abs(centre);
      const chance = hash(k, 17, 137);
      const floors =
        out < 0.36 ? 2 + (chance < 0.35 ? 1 : 0) : 3 + Math.floor(chance * 3) + (out > 0.6 ? 1 : 0);
      houses.push({ x0: x, x1: x + width, roof: street - storey * floors - 0.03, seed: k });
      x += width;
    }
    const houseAt = (x: number) => houses.find((h) => x >= h.x0 && x < h.x1) ?? houses[0]!;
    // Power lines strung between poles, sagging; Hanoi has a great many.
    const poles = [-0.62, 0.66].map((at) => at * aspect * 0.8);
    const wire = (x: number, k: number) => {
      const top = 0.2 + 0.035 * k;
      const span = poles[1]! - poles[0]!;
      const t = (x - poles[0]!) / span;
      return top + (0.05 + 0.015 * k) * 4 * t * (1 - t);
    };
    const facade = (x: number, y: number, i: number, j: number) => {
      const h = houseAt(x);
      if (y < h.roof) return OUTSIDE;
      const u = (x - h.x0) / (h.x1 - h.x0);
      const across = (x - h.x0) / dot;
      // A dark party wall between neighbours.
      if (across < 1) return { ink: 0 as Ink, tone: 0.55 };
      // Parapet cap.
      if (y - h.roof < dot * 1.5) return { ink: 0 as Ink, tone: 0.75 };
      const floor = Math.floor((street - y) / storey);
      const inFloor = (street - y) / storey - floor;
      if (floor === 0) {
        // The shop front: an open roller door, dark inside, with a low stool or two.
        if (u > 0.14 && u < 0.86 && inFloor < 0.78) {
          const stool = inFloor < 0.14 && (Math.abs(u - 0.3) < 0.06 || Math.abs(u - 0.7) < 0.05);
          const shelf = Math.abs(inFloor - 0.5) < 0.04 || Math.abs(inFloor - 0.28) < 0.04;
          return { ink: 0 as Ink, tone: stool ? 0.95 : shelf ? 0.6 : 0.2 };
        }
        return { ink: 1 as Ink, tone: 0.42 };
      }
      // Balcony: a slab, then a railing of thin bars.
      if (inFloor < 0.05) return { ink: 0 as Ink, tone: 0.85 };
      if (inFloor < 0.28 && u > 0.06 && u < 0.94) {
        if (inFloor > 0.24) return { ink: 0 as Ink, tone: 0.85 };
        return { ink: 0 as Ink, tone: Math.round(across) % 3 === 0 ? 0.85 : -1 };
      }
      // Tall louvred shutters, some folded open on a dark room.
      if (u > 0.2 && u < 0.8 && inFloor > 0.2 && inFloor < 0.86) {
        const open = hash(h.seed, floor, 132) < 0.4;
        if (open && u > 0.32 && u < 0.68) return { ink: 0 as Ink, tone: 0.5 };
        return { ink: 0 as Ink, tone: j % 2 === 0 ? 0.72 : 0.38 };
      }
      return { ink: 1 as Ink, tone: 0.3 + 0.12 * hash(h.seed, 0, 133) + 0.04 * hash(i, j, 134) };
    };
    const car = 0.24;
    const train = car * 3;
    const trainBottom = nearRail - dot * 2;
    const trainHeight = 0.105;
    const trainHead = (time: number | null) =>
      time === null ? null : aspect / 2 + 0.02 - (((time + 60) % 140) - 4) * 0.06;
    const coach = (x: number, y: number, head: number) => {
      const along = x - head;
      const h = trainBottom - y;
      if (along < 0 || along > train || h < 0 || h > trainHeight) return OUTSIDE;
      const inCar = along % car;
      // Coupled low between coaches, and the leading cab's windscreen raked back.
      if (inCar > car - dot * 1.5) return h < trainHeight * 0.45 ? 0.3 : OUTSIDE;
      if (along < 0.03 && h > trainHeight * 0.6 + (0.03 - along) * 1.2) return OUTSIDE;
      if (h > trainHeight - dot * 1.5) return 0.9;
      if (h < dot * 2.5) return 0.2;
      if (Math.abs(h - trainHeight * 0.32) < dot * 0.8) return 0.95;
      const pane = (inCar / 0.03) % 1;
      if (h > trainHeight * 0.5 && h < trainHeight * 0.82 && pane > 0.15 && pane < 0.8) {
        return 0.15;
      }
      return 0.55;
    };
    // Lanterns hang under some balconies, one per house at most.
    const lantern = (x: number, y: number) => {
      const h = houseAt(x);
      if (hash(h.seed, 5, 135) > 0.55) return OUTSIDE;
      const floor = 1 + Math.floor(hash(h.seed, 6, 135) * 2);
      const cx = h.x0 + (h.x1 - h.x0) * (hash(h.seed, 7, 135) < 0.5 ? 0.16 : 0.84);
      const cy = street - storey * floor - 0.026;
      if (cy - 0.03 < h.roof) return OUTSIDE;
      const e = Math.hypot((x - cx) / 0.013, (y - cy) / 0.016);
      // Silk between ribs, with a tassel below.
      if (e < 1) return Math.abs(y - cy) % (dot * 3) < dot ? 0.6 : 1;
      if (Math.abs(x - cx) < dot * 0.6 && y > cy + 0.016 && y < cy + 0.026) return 1;
      // The cord.
      return Math.abs(x - cx) < dot * 0.5 && y < cy && y > cy - 0.022 ? 0.9 : OUTSIDE;
    };
    return [
      {
        // A warm noon haze over the roofs.
        ink: 2,
        depth: 0,
        band: [-1, street],
        tone: (x, y) => 0.07 * smooth(0.1, 0.6, y) * clearOfHeading(x, y),
      },
      {
        ink: 0,
        depth: 0.15,
        band: [0.15, street],
        tone: (x, y) => {
          if (poles.some((p) => Math.abs(x - p) < dot * 1.2) && y > 0.18) return 0.9;
          if (x < poles[0]! || x > poles[1]!) return 0;
          for (let k = 0; k < 3; k++) {
            // Thick enough on the slope that the line never breaks between columns.
            const slope = Math.abs(wire(x + dot, k) - wire(x, k));
            if (Math.abs(y - wire(x, k)) < dot * 0.55 + slope * 0.5) {
              return 0.85 * (0.15 + 0.85 * clearOfHeading(x, y));
            }
          }
          return 0;
        },
      },
      {
        ink: 0,
        depth: 0.5,
        solid: true,
        band: [0.25, street],
        tone: (x, y, i, j) => {
          const f = facade(x, y, i, j);
          return typeof f === "number" || f.ink !== 0 ? OUTSIDE : f.tone;
        },
      },
      {
        ink: 1,
        depth: 0.5,
        solid: true,
        band: [0.25, street],
        tone: (x, y, i, j) => {
          const lit = lantern(x, y);
          if (lit >= 0) return lit;
          const f = facade(x, y, i, j);
          return typeof f === "number" || f.ink !== 1 ? OUTSIDE : f.tone;
        },
      },
      {
        // The track: ballast, sleepers, then two rails right at the doorsteps.
        ink: 0,
        depth: 0.8,
        solid: true,
        band: [street, 2],
        tone: (x, y, i, j) => {
          if (Math.abs(y - farRail) < dot * 1.2 || Math.abs(y - nearRail) < dot * 1.6) return 0.95;
          const between = y > farRail && y < nearRail;
          // Sleepers lean with the view, so they read as lying across the line.
          const along = (x + (y - farRail) * 0.45) / 0.034;
          const sleeper = between && along - Math.floor(along) < 0.32;
          if (sleeper) return 0.55;
          if (y < street + dot * 1.5) return 0.6;
          return y > farRail && hash(i, j, 136) < 0.06 ? 0.5 : -1;
        },
      },
      {
        ink: 2,
        depth: 0.8,
        band: [street, 2],
        tone: (_x, y) => 0.22 + 0.1 * smooth(street, 1, y),
      },
      {
        // Every couple of minutes a train squeezes down the street, right to left.
        ink: 1,
        depth: 0.8,
        solid: true,
        band: [trainBottom - trainHeight - 0.01, trainBottom + 0.01],
        sprites: (time) => {
          const head = trainHead(time);
          if (
            head === null ||
            head > aspect / 2 + 0.02 ||
            head + train < -aspect / 2 - SIDEBAR_REACH
          ) {
            return [];
          }
          return [
            {
              x0: head,
              x1: head + train,
              y0: trainBottom - trainHeight,
              y1: trainBottom,
              key: Math.round(head / dot),
            },
          ];
        },
        tone: (x, y, _i, _j, time) => {
          const head = trainHead(time);
          return head === null ? OUTSIDE : coach(x, y, head);
        },
      },
    ];
  },
};

/** Nebula: the Milky Way's band crossing the sky on the diagonal, in clumped dots, over stars. */
const nebula: Scene = {
  hues: [-38, 26],
  layers: ({ aspect }) => {
    // Distance across the band and position along it; the band runs from the upper right down to
    // the left edge, over the heading, and on into the sidebar.
    const angle = -0.36;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const across = (x: number, y: number) => {
      const dx = x - 0.12 * aspect;
      const dy = y - 0.02;
      return -dx * sin + dy * cos + 0.06 * (fbm1(dx * 2.2, 81) - 0.5);
    };
    const along = (x: number, y: number) => (x - 0.12 * aspect) * cos + (y - 0.02) * sin;
    // The band thins out over the heading and the composer, wider than either, so neither reads
    // over clumps.
    const clear = (x: number, y: number) =>
      smooth(0.75, 1.2, Math.hypot(x / 0.48, (y - 0.44) / 0.16)) ** 2;
    const glow = (x: number, y: number, width: number) =>
      Math.exp(-((across(x, y) / width) ** 2)) * clear(x, y);
    // A dark rift splits the core, as the Great Rift does.
    const rift = (x: number, y: number) =>
      1 -
      0.75 *
        smooth(0.5, 0.68, fbm2(along(x, y) * 5 + 3, across(x, y) * 18, 83)) *
        Math.exp(-((across(x, y) / 0.05) ** 2));
    return [
      // No stars at all over the heading's letters.
      ...stars(1.15, 1.3).map((layer) => ({
        ...layer,
        tone: (x: number, y: number, i: number, j: number) =>
          Math.hypot(x / 0.33, (y - 0.37) / 0.05) < 1 ? 0 : layer.tone(x, y, i, j, null),
      })),
      {
        ink: 2,
        depth: 0,
        band: [-1, 1.2],
        tone: (x, y) =>
          0.3 * glow(x, y, 0.2) * smooth(0.35, 0.65, fbm2(x * 2.4, y * 2.4, 84)) * rift(x, y),
      },
      {
        ink: 1,
        depth: 0.05,
        band: [-1, 1.1],
        tone: (x, y) => {
          const clumps = smooth(0.38, 0.72, fbm2(x * 5.5 + 7, y * 5.5, 85));
          return 0.62 * glow(x, y, 0.16) * clumps * rift(x, y);
        },
      },
      {
        ink: 0,
        depth: 0.08,
        band: [-1, 1],
        tone: (x, y) => {
          const knots = smooth(0.6, 0.82, fbm2(x * 9 + 2, y * 9, 86));
          const core = glow(x, y, 0.07) * knots * rift(x, y);
          return core > 0.05 ? 0.8 * core : 0;
        },
      },
      {
        // Loose sparks along the band, which glint like the stars.
        ink: 0,
        depth: 0.08,
        band: [-1, 1],
        tone: (x, y, i, j) => {
          if (
            glow(x, y, 0.07) * smooth(0.6, 0.82, fbm2(x * 9 + 2, y * 9, 86)) * rift(x, y) >
            0.05
          ) {
            return 0;
          }
          return hash(i, j, 87) < 0.02 * glow(x, y, 0.12) ? 1 : 0;
        },
        shimmer: (tone, i, j, time) => tone * twinkle(i, j + 8192, time),
      },
    ];
  },
};

const SCENE_BY_THEME_ID: Readonly<Record<string, Scene>> = {
  nebula,
  stellar: limb,
  "night-edit": city,
  darkroom: dunes,
  studio: soundstage,
  "drive-in": driveIn,
  "long-bien": longBien,
  sakura,
  shore,
  "train-street": trainStreet,
};

export const sceneForTheme = (themeId: string): Scene => SCENE_BY_THEME_ID[themeId] ?? orbit;
