# Photo carousels

Lay out an Instagram photo carousel in Stellar and export it as images you post
from your phone. You can build it by hand, ask an agent to build it, or do both
at once: the agent's edits appear on the slide as it makes them.

## Start one

Choose **New project** in the sidebar, **New video project** in the command
palette, or **or start a new video or carousel** on a new thread's screen, pick **Photo carousel** and
name it. On mobile, **New project** offers the same choice. Stellar makes a folder with `Photos`, `Exports`
and `Stellar` inside it in your projects folder, `~/Movies/Stellar` unless you
change it in **Settings → General → Projects folder**. Open the **Carousel** tab
in the right panel to work on it.

## Add photos

**Add photos** takes files from the device you are on, or from the Downloads
folder of the computer running Stellar, which is where AirDrop leaves them.
Photos are copied into the project's `Photos` folder; the originals are not
moved. HEIC, TIFF and raw photos work as well as JPEG and PNG.

Pick a photo in the inspector, then make it a new slide, the slide's
background, or a layer on top.

## Lay out the slides

- Drag a layer to move it, drag a corner to scale it, and drag the round handle
  to turn it. Double-click text to type on the slide.
- Drag slides in the strip to reorder them.
- The ratio applies to every slide, as it does on Instagram: 4:5 (1080×1350),
  3:4 (1080×1440) or 1:1 (1080×1080).
- **Guides** shows what to keep clear: the dashed frame is a margin for text,
  the red box is where the feed draws the slide counter, and the dimmed edges
  are what the profile grid crops off the first slide. Guides are never
  exported.
- To run one wide photo across several slides, add it as a photo layer, make it
  that many slides wide, and set **Runs across slides**.
- Write the caption and each slide's alt text in the inspector.

**Preview** shows the post as the feed does, so you can swipe through it.

## Export and post

**Export** writes `01.jpg`, `02.jpg` and so on to the project's
`Exports/Carousel` folder at the exact size Instagram shows, with the caption
and alt text in `caption.txt`. Each export replaces the last one. Stellar does
not post for you: send the files to your phone and select them in order.

What you see on the slide is what is exported, because the same window draws
both. That also means an agent can only export, or look at its own work, while
the Carousel tab is open in a Stellar window; it will tell you if it isn't.
Slides use fonts installed on the computer that draws them, so export from the
computer you designed on.

## Limits

Instagram takes up to 20 slides, 2,200 caption characters and 30 hashtags.
Stellar stops at the first two and warns about the third when you export.
