import type { CarouselDocument, CarouselEdit, CarouselTextLayer } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyCarouselEdits,
  boxContains,
  captionFileText,
  carouselText,
  contactSheetLayout,
  coverCrop,
  emptyCarousel,
  exportFileNames,
  exportWarnings,
  imageSize,
  isExportFile,
  layersOnSlide,
  layoutText,
  MAX_SLIDES,
  photoResample,
  placeBackgroundPhoto,
  scaleLayer,
  slideGuides,
  slidePhotos,
  slideSize,
  wrapText,
} from "./carousel.ts";

const withPhotos: CarouselDocument = {
  ...emptyCarousel(),
  photos: [
    { src: "Photos/pho.heic", file: "Stellar/proxies/a.still.webp", width: 3024, height: 4032 },
    { src: "Photos/wide.jpg", file: "Photos/wide.jpg", width: 6000, height: 2500 },
  ],
};

const edit = (document: CarouselDocument, ...edits: ReadonlyArray<CarouselEdit>) => {
  const result = applyCarouselEdits(document, edits);
  if (!result.ok) throw new Error(result.error);
  return result.document;
};

const refusal = (document: CarouselDocument, ...edits: ReadonlyArray<CarouselEdit>) => {
  const result = applyCarouselEdits(document, edits);
  return result.ok ? null : result.error;
};

// Ten pixels a character: enough to make wrapping and alignment exact.
const measure = (text: string) => text.length * 10;

const textLayer = (overrides: Partial<CarouselTextLayer>): CarouselTextLayer => ({
  kind: "text",
  id: "l1",
  text: "",
  font: "sans",
  size: 40,
  weight: 700,
  color: "#111111",
  align: "center",
  x: 540,
  y: 675,
  maxWidth: 160,
  rotation: 0,
  lineHeight: 1.5,
  stroke: null,
  shadow: null,
  box: null,
  ...overrides,
});

describe("carousel edits", () => {
  it("adds, duplicates, reorders and removes slides with ids that are never reused", () => {
    const built = edit(
      withPhotos,
      { kind: "addSlide", layout: "photo", src: "Photos/pho.heic" },
      { kind: "addSlide", layout: "title", text: "Phở 101", index: 0 },
      { kind: "duplicateSlide", slide: "s3" },
      { kind: "moveSlide", slide: "s1", index: 3 },
    );
    expect(built.slides.map((slide) => slide.id)).toEqual(["s3", "s5", "s2", "s1"]);
    expect(built.slides[0]?.layers[0]).toMatchObject({ id: "l4", text: "Phở 101", x: 540, y: 675 });
    // The copy has its own layer ids, so an edit to it never lands on the original.
    expect(built.slides[1]?.layers[0]).toMatchObject({ id: "l6", text: "Phở 101" });
    expect(built.slides[2]?.background.photo).toMatchObject({
      src: "Photos/pho.heic",
      fit: "fill",
    });

    const removed = edit(built, { kind: "removeSlide", slide: "s5" }, { kind: "addSlide" });
    expect(removed.slides.map((slide) => slide.id)).toEqual(["s3", "s2", "s1", "s7"]);
  });

  it("refuses the whole call when one edit is bad, naming it", () => {
    expect(
      refusal(
        withPhotos,
        { kind: "setCaption", text: "kept?" },
        { kind: "removeSlide", slide: "s9" },
      ),
    ).toBe("Edit 2 (removeSlide): no slide s9 in this carousel.");
    expect(refusal(withPhotos, { kind: "removeSlide", slide: "s1" })).toMatch(/at least one slide/);
    expect(refusal(withPhotos, { kind: "setCaption", text: "x".repeat(2201) })).toMatch(/2200/);
    expect(
      refusal(withPhotos, { kind: "setAltText", slide: "s1", text: "x".repeat(1001) }),
    ).toMatch(/1000/);
    expect(
      refusal(withPhotos, { kind: "addSlide", layout: "photo", src: "Photos/missing.jpg" }),
    ).toMatch(/import it first/);
    const full = edit(
      withPhotos,
      ...Array.from({ length: MAX_SLIDES - 1 }, (): CarouselEdit => ({ kind: "addSlide" })),
    );
    expect(refusal(full, { kind: "addSlide" })).toMatch(/at most 20 slides/);
    expect(refusal(full, { kind: "duplicateSlide", slide: "s1" })).toMatch(/at most 20 slides/);
  });

  it("sets a background's colour and photo, keeping a photo's placement when only part changes", () => {
    const placed = edit(
      withPhotos,
      { kind: "setBackground", slide: "s1", color: "#102030", photo: { src: "Photos/pho.heic" } },
      {
        kind: "setBackground",
        slide: "s1",
        photo: { src: "Photos/pho.heic", scale: 1.4, offsetY: -80 },
      },
      { kind: "setBackground", slide: "s1", photo: { src: "Photos/pho.heic", fit: "fit" } },
    );
    expect(placed.slides[0]?.background).toEqual({
      color: "#102030",
      photo: {
        src: "Photos/pho.heic",
        fit: "fit",
        offsetX: 0,
        offsetY: -80,
        scale: 1.4,
        rotation: 0,
      },
    });
    expect(
      edit(placed, { kind: "setBackground", slide: "s1", photo: null }).slides[0]?.background.photo,
    ).toBeNull();
    expect(refusal(withPhotos, { kind: "setBackground", slide: "s1", color: "red" })).toMatch(
      /hex colour/,
    );
  });

  it("adds, changes, restacks and removes layers", () => {
    const layered = edit(
      withPhotos,
      {
        kind: "addLayer",
        slide: "s1",
        layer: { kind: "photo", src: "Photos/pho.heic", width: 600 },
      },
      { kind: "addLayer", slide: "s1", layer: { kind: "text", text: "Hà Nội", size: 90, y: 200 } },
      {
        kind: "updateLayer",
        slide: "s1",
        layerId: "l3",
        layer: { color: "#ffffff", align: "left" },
      },
    );
    const [photo, text] = layered.slides[0]?.layers ?? [];
    // A photo layer's frame starts in the photo's own shape.
    expect(photo).toMatchObject({ id: "l2", width: 600, height: 800, x: 540, y: 675, span: 1 });
    expect(text).toMatchObject({ id: "l3", size: 90, y: 200, color: "#ffffff", align: "left" });

    const restacked = edit(layered, { kind: "moveLayer", slide: "s1", layerId: "l3", index: 0 });
    expect(restacked.slides[0]?.layers.map((layer) => layer.id)).toEqual(["l3", "l2"]);
    expect(
      edit(restacked, { kind: "removeLayer", slide: "s1", layerId: "l2" }).slides[0]?.layers,
    ).toHaveLength(1);

    expect(
      refusal(layered, { kind: "updateLayer", slide: "s1", layerId: "l3", layer: { width: 300 } }),
    ).toMatch(/a text layer has no width/);
    expect(
      refusal(layered, { kind: "updateLayer", slide: "s1", layerId: "l2", layer: { opacity: 2 } }),
    ).toMatch(/opacity must be between 0 and 1/);
    expect(refusal(layered, { kind: "addLayer", slide: "s1", layer: { text: "no kind" } })).toMatch(
      /needs layer.kind/,
    );
  });

  it("keeps things at the same place down the slide when the ratio changes", () => {
    const tall = edit(
      withPhotos,
      { kind: "addLayer", slide: "s1", layer: { kind: "text", text: "Top", y: 135 } },
      { kind: "setRatio", ratio: "1:1" },
    );
    expect(tall.ratio).toBe("1:1");
    expect(tall.slides[0]?.layers[0]?.y).toBeCloseTo(108);
  });

  it("restores an earlier state for undo without losing photos imported since", () => {
    const before = edit(emptyCarousel(), { kind: "setCaption", text: "first" });
    const after = edit(
      { ...before, photos: withPhotos.photos },
      { kind: "addSlide", layout: "photo", src: "Photos/wide.jpg" },
      { kind: "setCaption", text: "second" },
    );
    const undone = edit(after, { kind: "restore", document: before });
    expect(undone.caption).toBe("first");
    expect(undone.slides.map((slide) => slide.id)).toEqual(["s1"]);
    expect(undone.photos).toHaveLength(2);
    // The slide that was undone took s2; the next new slide must not.
    expect(edit(undone, { kind: "addSlide" }).slides[1]?.id).toBe("s3");
  });

  it("describes the carousel in the ids and pixels edits take", () => {
    const described = carouselText(
      edit(
        withPhotos,
        { kind: "setBackground", slide: "s1", photo: { src: "Photos/pho.heic" } },
        { kind: "addLayer", slide: "s1", layer: { kind: "text", text: "Phở bò", y: 200 } },
        { kind: "setAltText", slide: "s1", text: "A bowl of pho" },
      ),
    );
    expect(described.split("\n")).toEqual([
      "Carousel 4:5, each slide 1080x1350, 1 of 20 slides, caption 0/2200 characters",
      '1. s1 background Photos/pho.heic fill on #ffffff alt "A bowl of pho"',
      '  l2 text "Phở bò" sans 64/700 #111111 center at 540,200 maxWidth 900',
      "Photos: Photos/pho.heic 3024x4032, Photos/wide.jpg 6000x2500",
    ]);
  });
});

describe("carousel layout", () => {
  it("sizes each ratio at Instagram's 1080-wide pixels", () => {
    expect(slideSize("4:5")).toEqual({ width: 1080, height: 1350 });
    expect(slideSize("1:1")).toEqual({ width: 1080, height: 1080 });
    expect(slideSize("3:4")).toEqual({ width: 1080, height: 1440 });
  });

  it("marks the profile grid's 3:4 centre crop", () => {
    expect(slideGuides("4:5").grid).toEqual({ x: 33.75, y: 0, width: 1012.5, height: 1350 });
    expect(slideGuides("1:1").grid).toEqual({ x: 135, y: 0, width: 810, height: 1080 });
    expect(slideGuides("3:4").grid).toEqual({ x: 0, y: 0, width: 1080, height: 1440 });
  });

  it("fills or fits a background photo, then applies its offset and scale", () => {
    const slide = slideSize("4:5");
    const portrait = { width: 3000, height: 4000 };
    const base = { src: "p", offsetX: 0, offsetY: 0, scale: 1, rotation: 0 };
    // 3:4 on 4:5: filling is limited by the width, fitting by the height.
    expect(placeBackgroundPhoto({ ...base, fit: "fill" }, slide, portrait)).toEqual({
      cx: 540,
      cy: 675,
      width: 1080,
      height: 1440,
      rotation: 0,
    });
    const fitted = placeBackgroundPhoto({ ...base, fit: "fit" }, slide, portrait);
    expect(fitted.width).toBeCloseTo(1012.5);
    expect(fitted.height).toBeCloseTo(1350);
    expect(
      placeBackgroundPhoto(
        { ...base, fit: "fill", scale: 2, offsetX: 30, offsetY: -40, rotation: 15 },
        slide,
        portrait,
      ),
    ).toEqual({ cx: 570, cy: 635, width: 2160, height: 2880, rotation: 15 });
  });

  it("crops a photo from its centre to fill a frame", () => {
    expect(coverCrop({ width: 500, height: 500 }, { width: 4000, height: 2000 })).toEqual({
      x: 1000,
      y: 0,
      width: 2000,
      height: 2000,
    });
  });

  it("wraps at spaces, keeps blank lines and breaks a word too long for the line", () => {
    expect(wrapText("one two three four", 90, measure)).toEqual(["one two", "three", "four"]);
    expect(wrapText("a\n\nb", 90, measure)).toEqual(["a", "", "b"]);
    expect(wrapText("abcdefghijkl mn", 50, measure)).toEqual(["abcde", "fghij", "kl mn"]);
  });

  it("lays text out about the block's centre for each alignment", () => {
    const lines = (align: CarouselTextLayer["align"]) =>
      layoutText(textLayer({ text: "aaaa bbbbbbbbbbbb", align }), measure).lines.map((line) => [
        line.text,
        line.x,
        line.y,
      ]);
    // Two lines of 40 and 120 px in a 160 px block with 60 px leading.
    expect(lines("left")).toEqual([
      ["aaaa", -80, -30],
      ["bbbbbbbbbbbb", -80, 30],
    ]);
    expect(lines("center")).toEqual([
      ["aaaa", -20, -30],
      ["bbbbbbbbbbbb", -60, 30],
    ]);
    expect(lines("right")).toEqual([
      ["aaaa", 40, -30],
      ["bbbbbbbbbbbb", -40, 30],
    ]);
  });

  it("hugs the widest line with the background box, padded", () => {
    const block = layoutText(
      textLayer({
        text: "aaaa bbbbbbbbbbbb",
        align: "right",
        box: { color: "#000000", padding: 10, radius: 0 },
      }),
      measure,
    );
    expect(block).toMatchObject({ width: 160, height: 120 });
    expect(block.box).toEqual({ x: -50, y: -70, width: 140, height: 140 });
    expect(
      layoutText(
        textLayer({ text: "", box: { color: "#000000", padding: 10, radius: 0 } }),
        measure,
      ).box,
    ).toBeNull();
  });

  it("hits a turned layer where it is drawn, not where it would sit upright", () => {
    const box = { cx: 500, cy: 500, width: 400, height: 40, rotation: 90 };
    expect(boxContains(box, { x: 500, y: 680 })).toBe(true);
    expect(boxContains(box, { x: 680, y: 500 })).toBe(false);
  });

  it("scales a photo's frame and a text's size and width together", () => {
    const layers = edit(
      withPhotos,
      {
        kind: "addLayer",
        slide: "s1",
        layer: { kind: "photo", src: "Photos/pho.heic", width: 600 },
      },
      {
        kind: "addLayer",
        slide: "s1",
        layer: { kind: "text", text: "Hi", size: 60, maxWidth: 400 },
      },
    ).slides[0]?.layers;
    expect(scaleLayer(layers![0]!, 1.5)).toEqual({ width: 900, height: 1200 });
    expect(scaleLayer(layers![1]!, 0.5)).toEqual({ size: 30, maxWidth: 200 });
  });

  it("carries a spanning photo onto the slides it crosses, shifted a slide at a time", () => {
    const panorama = edit(
      withPhotos,
      { kind: "addSlide" },
      { kind: "addSlide" },
      { kind: "addSlide" },
      {
        kind: "addLayer",
        slide: "s1",
        layer: {
          kind: "photo",
          src: "Photos/wide.jpg",
          x: 1620,
          width: 3240,
          height: 1350,
          span: 3,
        },
      },
      { kind: "addLayer", slide: "s2", layer: { kind: "text", text: "Middle" } },
    );
    const drawn = (index: number) =>
      layersOnSlide(panorama, index).map(({ layer, offsetX }) => [layer.id, offsetX]);
    expect(drawn(0)).toEqual([["l5", 0]]);
    // Under the slide's own layers, one slide width to the left.
    expect(drawn(1)).toEqual([
      ["l5", -1080],
      ["l6", 0],
    ]);
    expect(drawn(2)).toEqual([["l5", -2160]]);
    expect(drawn(3)).toEqual([]);
    // An export loads the originals a slide draws, and only those.
    const backed = edit(panorama, {
      kind: "setBackground",
      slide: "s2",
      photo: { src: "Photos/pho.heic" },
    });
    expect(slidePhotos(backed, 1)).toEqual(["Photos/pho.heic", "Photos/wide.jpg"]);
    expect(slidePhotos(backed, 3)).toEqual([]);
  });

  it("averages a reduced photo straight onto the canvas pixels it covers", () => {
    const canvas = { width: 1080, height: 1350 };
    const whole = { x: 0, y: 0, width: 6000, height: 4000 };
    // A 6000 px photo filling a 4:5 slide is 2025 px wide there: only the 1080 on the canvas
    // are made, each from the 2.96 px of the original under it.
    expect(
      photoResample({
        crop: whole,
        drawn: { x: -472.5, y: 0, width: 2025, height: 1350 },
        turned: false,
        canvas,
      }),
    ).toEqual({
      kind: "average",
      window: { x: 1400, y: 0, width: 3200, height: 4000 },
      target: { x: 0, y: 0, width: 1080, height: 1350 },
      aligned: true,
    });
    // An edge between pixels takes the pixels whose centre it passes, as a canvas does, so
    // the window can reach a little past the crop on one side and stop short on the other.
    expect(
      photoResample({
        crop: { x: 1000, y: 0, width: 4000, height: 4000 },
        drawn: { x: 100.25, y: 200.75, width: 400, height: 400 },
        turned: false,
        canvas,
      }),
    ).toEqual({
      kind: "average",
      window: { x: 997.5, y: 2.5, width: 4000, height: 4000 },
      target: { x: 100, y: 201, width: 400, height: 400 },
      aligned: true,
    });
    // Layout arithmetic a hair off a whole pixel adds no column.
    expect(
      photoResample({
        crop: whole,
        drawn: { x: -1e-9, y: 1e-9, width: 1080 + 2e-9, height: 720 },
        turned: false,
        canvas,
      }),
    ).toMatchObject({ target: { x: 0, y: 0, width: 1080, height: 720 } });
    // A turned photo is averaged to the size it is drawn at, for the canvas to turn.
    expect(
      photoResample({
        crop: whole,
        drawn: { x: 0, y: 0, width: 810.4, height: 540.3 },
        turned: true,
        canvas,
      }),
    ).toEqual({
      kind: "average",
      window: whole,
      target: { x: 0, y: 0, width: 810, height: 540 },
      aligned: false,
    });
  });

  it("leaves an enlarged photo to the canvas, and skips one that is off the slide", () => {
    const canvas = { width: 1080, height: 1350 };
    const small = { x: 0, y: 0, width: 800, height: 1000 };
    expect(
      photoResample({
        crop: small,
        drawn: { x: 0, y: 0, width: 1080, height: 1350 },
        turned: false,
        canvas,
      }),
    ).toEqual({ kind: "direct" });
    expect(
      photoResample({
        crop: small,
        drawn: { x: 140, y: 175, width: 800, height: 1000 },
        turned: true,
        canvas,
      }),
    ).toEqual({ kind: "direct" });
    // The part of a panorama that belongs to the next slide.
    expect(
      photoResample({
        crop: { x: 0, y: 0, width: 6000, height: 2500 },
        drawn: { x: 1080, y: 0, width: 3240, height: 1350 },
        turned: false,
        canvas,
      }),
    ).toEqual({ kind: "hidden" });
  });
});

describe("carousel export", () => {
  it("names files so they sort in slide order", () => {
    expect(exportFileNames(3, "jpeg")).toEqual(["01.jpg", "02.jpg", "03.jpg"]);
    expect(exportFileNames(11, "png").at(-1)).toBe("11.png");
    expect(isExportFile("07.jpg")).toBe(true);
    expect(isExportFile("caption.txt")).toBe(false);
    expect(isExportFile("IMG_07.jpg")).toBe(false);
  });

  it("reads the pixel size a PNG or a JPEG declares", () => {
    const png = new Uint8Array(24);
    const view = new DataView(png.buffer);
    view.setUint32(0, 0x89504e47);
    view.setUint32(16, 1080);
    view.setUint32(20, 1350);
    expect(imageSize(png)).toEqual({ format: "png", width: 1080, height: 1350 });

    // SOI, an APP0 segment to skip, then a baseline frame header of 1440 x 1080.
    const jpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0xa0,
      0x04, 0x38, 0x03, 0x00, 0x00,
    ]);
    expect(imageSize(jpeg)).toEqual({ format: "jpeg", width: 1080, height: 1440 });
    expect(imageSize(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it("lays a contact sheet out in rows of five", () => {
    const sheet = contactSheetLayout(7, slideSize("4:5"), 200);
    expect(sheet).toMatchObject({ width: 1060, height: 530 });
    expect(sheet.cells[0]).toEqual({ x: 10, y: 10, width: 200, height: 250 });
    expect(sheet.cells[5]).toEqual({ x: 10, y: 270, width: 200, height: 250 });
  });

  it("warns about what Instagram would refuse or change", () => {
    expect(exportWarnings(emptyCarousel())).toEqual([
      "One slide posts as a single photo; a carousel needs at least two.",
      "1 of 1 slides have no alt text.",
    ]);
    const tagged = edit(
      emptyCarousel(),
      { kind: "addSlide" },
      { kind: "setAltText", slide: "s1", text: "a" },
      { kind: "setAltText", slide: "s2", text: "b" },
      {
        kind: "setCaption",
        text: Array.from({ length: 31 }, (_, index) => `#phở${index}`).join(" "),
      },
    );
    expect(exportWarnings(tagged)).toEqual(["The caption has 31 hashtags; Instagram allows 30."]);
    expect(captionFileText(tagged).split("\n").slice(-4)).toEqual(["Alt text", "1. a", "2. b", ""]);
  });
});
