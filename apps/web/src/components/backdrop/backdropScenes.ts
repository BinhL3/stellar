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
  /** `i` and `j` are the dot's column and row, for details one dot wide. */
  readonly tone: (x: number, y: number, i: number, j: number) => number;
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
          return floorLit && lit ? 1 : 0;
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
    const dune = (
      ink: Ink,
      depth: number,
      base: number,
      amplitude: number,
      frequency: number,
      seed: number,
    ): SceneLayer => {
      // Long swells only: finer detail would flicker the lit and shaded faces.
      const ridge = (x: number) =>
        base -
        amplitude *
          (0.72 * noise1(x * frequency + seed, seed) ** 1.4 +
            0.28 * noise1(x * frequency * 2.3 + seed, seed + 1));
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
          const facing = smooth(-0.12, 0.12, slope * towards);
          const below = y - top;
          const crest = below < dot * 1.5 ? 0.35 * facing : 0;
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

const SCENE_BY_THEME_ID: Readonly<Record<string, Scene>> = {
  stellar: limb,
  "night-edit": city,
  darkroom: dunes,
  studio: soundstage,
  "drive-in": driveIn,
};

export const sceneForTheme = (themeId: string): Scene => SCENE_BY_THEME_ID[themeId] ?? orbit;
