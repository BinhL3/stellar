# Video editor on Stellar — design

Status: brainstorming. Decisions are recorded as they land; open questions are listed at the end.

## Goal

One editor whose agentic edits are app-agnostic. Agents edit a neutral timeline through MCP, driven
by the user's local Claude Code or Codex. The result opens in Premiere, CapCut, Meta Edits,
DaVinci or Remotion with minimal conversion. The same app also covers the media pipeline: ingest
(AirDrop into `~/Downloads`, drag and drop), project organization on a working SSD, and relinking.

## Evidence from real edits

- **Premiere MCP** (CEP/ExtendScript) can cut, place, keyframe, mix and export. It cannot apply user
  effect presets (`.prfpset`) or set bezier easing; presets were applied by injecting XML into the
  closed, gzipped `.prproj`. Scripted edits can leave track items out of time order, which makes layers
  render invisibly in export, so a scripted edit counts as done only after it checks out in a real render.
- **Meta Edits MCP** rebuilt a finished 62 s Premiere edit automatically. Cuts, trims, overlay
  position/scale/alpha, transform keyframes with preset easings, opacity keyframes, volumes, SFX and
  music came across. Audio crossfades, motion blur, exact easing curves and caption styling did not, and
  the 59.94→60 fps conform made clips ~0.1% short.
  **Structure and simple keyframes are portable; finishing is per-app.**
- **Remotion** is good for code-generated graphics but is source-available, not OSI open source, and its
  `<Timeline>` component is paid. An open-source editor needs its own timeline.
- **OpenTimelineIO** is the natural neutral model for cuts, tracks, ranges, markers and metadata, with
  per-app adapters.
- Binh edits by hand between agent turns. `_pipeline/seq_state.py` already diffs the Premiere
  sequence against a baseline before each agent change. Round-tripping _from_ the editing app matters as
  much as exporting to it.
- No proxies were used in these edits. The layers that went missing in export were caused by scripted
  edits (removing, re-placing or `clip.move` on a track left items out of time order), not by
  performance. Premiere's own import (`overwriteClip`, FCP XML) inserts items in order.

### What the past threads showed (AQW, DictationIsland, SF Uniqlo, frame accuracy)

- **Taste and editorial judgement drew most of the corrections, not mechanics:** generated graphics
  read as "AI slop", Binh's own presets were not used, assets didn't fit the line, he cut what "doesn't
  move the story". Mechanical failures came second: Premiere's call-by-call fragility, frame rates,
  layers that vanished in export.
- **Every round has the same shape.** Binh hand-edits, gives notes, the agent duplicates the
  sequence as `vN+1` and applies them. Agents missed or overwrote his hand edits until they diffed
  first; once, an agent extended a clip he had trimmed.
- **Transcripts drove nearly every cut** (retakes, dead air, stumbles). `_pipeline/stt` (Parakeet
  plus a chunked Qwen aligner) times cut points to a 20–30 ms median and keeps retakes; Whisper
  dropped retakes and ran 140 ms late.
- **iPhone footage is variable-rate, and some clips switch rate partway** (60→30). Seconds × fps
  was the real sync bug. The fix is a per-clip table of frame timestamps (`clip_fps.frame_at`), the
  sequence fixed at 59.94, and rate-switching clips conformed whole, never just the used range.
- **Generated graphics were a large share of the polish.** Python, Swift and ffmpeg generators
  (cards, maps, notifications, terminal, island UI, search animation) rendered MP4/PNG/ProRes 4444
  into `Graphics/`. Revisions were re-rendered and relinked in place. Sources and licences went in
  `SOURCES.md`.
- **Layout modes** (face plus overhead pop-up by default, split, full takeover) decide where captions
  and emoji go. Captions have no styling API in Premiere; Binh upgrades them to graphics by hand.
- **Failures only showed up in full renders**: blank or missing layers, an export missing the hook,
  stretched clips from a 3825:3824 pixel aspect. Stills and playback looked fine.
- **Pulling everything is hard.** `seq_state` sees clips but not effects, keyframes, transitions or
  markers. Premiere's FCP XML export drops Transform and Drop Shadow. `pp_dump.json` (an
  ExtendScript dump with keyframes and parameters) is the closest thing to a full read today.
- **Applying presets** means injecting XML into the closed `.prproj` (max 0.0 difference from a
  hand-applied preset). It costs a close and reopen (~8 s) and wipes Premiere's undo history, so it
  can't run while Binh is editing.
- **Parallel agents worked** for research, asset gathering and generators, alongside one strictly
  serial agent driving Premiere. One risk was seen: background agents nobody started rewrote a live doc
  three times.
- **Never asked for:** a timeline view outside Premiere, proxies, or offload. Binh reviews in
  Premiere and from before/after stills.

## What we build on in Stellar

- **The server owns the workspace.** Media, renders and app adapters run where the SSD is; web,
  desktop and mobile clients control it remotely ([overview](../internals/overview.md)).
- **Checkpoints** snapshot the workspace as hidden Git refs after each turn. A text timeline file in the
  project gets per-turn diff and restore for free; media is referenced, never committed.
- **MCP toolkits** (`apps/server/src/mcp/toolkits/`) are how every provider reaches server
  capabilities.
- **Delegation** (`delegate_task`, child threads) is the multi-agent layer.
- **Right-panel tabs** host per-thread tools (diff, files, browser, terminal, device).

## Decisions

### 1. Product shape: a neutral timeline in Stellar's shell, editing apps as adapters

- The canonical timeline file is the product. Agents edit it through MCP. Adapters push it into
  Premiere, Edits, CapCut, DaVinci or anything with MCP support, and pull hand edits back.
- We never discourage the user's own editor or subscription. We unify them; finishing stays in the
  app the user picks.
- The UI is Stellar's: projects and threads in the sidebar, chat in the middle. What's new is an
  **Assets** view (bins, ingest, relink status) and a **Viewer** (player plus timeline) as right-panel
  tabs.
- Remotion's "video is code" form factor fits graphics, not footage edits. Structure (cuts, tracks,
  ranges, keyframes) is **data**. A generated graphic is one clip type whose source is code (an HTML or
  React composition rendered to frames). Data for structure, code for graphics.

### 2. Compute topology: originals live with the compute, proxies travel

- Where originals live is the user's choice, per project. A project has one **media root**, a
  directory owned by one environment: the internal disk by default, or an external SSD, a NAS mount,
  or a folder on another machine. The other environments get proxies.
- Proxies are automatic and invisible: made in the background at ingest, by whichever environment
  owns the originals, and attached by each adapter (Premiere and DaVinci support this natively). The
  user only ever sees a "proxy / full quality" toggle in the Viewer.
- A removable media root (an SSD) can go offline. The project shows as offline instead of failing,
  and moving the drive to another machine is a handoff to that machine's environment plus a relink.
- Lag comes from decoding long-GOP 4K HEVC and rendering effects, not from the agent. Moving the
  agent elsewhere doesn't fix it. What does:
  - **Proxies** for interactive editing: intra-frame, low-res copies that every target app can attach
    (Premiere and DaVinci natively). Generating them is a batch job.
  - **App streaming** when the full-res editor must run elsewhere: Premiere runs on the PC next to the
    media and the Mac is a thin client (Parsec, Jump Desktop, Sunshine/Moonlight).
  - **Remote batch jobs** for everything else: proxies, transcription, analysis, generated graphics,
    and final renders of the portable layer.
- **Originals live with the compute; proxies travel.** The exFAT working SSD can move between the Mac
  and the PC.
- The PC is a second T3 environment (`npx t3`), already reachable over LAN, Tailscale or T3 Connect.
  Heavy jobs are dispatched to whichever environment holds the originals.
- App licenses are per app: an Adobe single-app plan installs on two computers but runs on one at a
  time. Our Viewer needs no third-party license, so a phone or a second laptop can review and make
  portable edits without Premiere.

### 3. Timeline model: standard OTIO plus our own typed schemas

Until the product is named, `<product>` stands for our namespace.

**Don't fork the format.** OTIO's Apache-2.0 licence would allow it, but a fork stops opening in every
other OTIO tool, which is the whole point. We extend it the way OTIO intends instead:

- **Schema plugins.** Our objects are registered OTIO schemas with their own versions
  (`<product>.Transform.1`, `<product>.EffectRef.1`). A tool that doesn't know them still reads the
  timeline and carries our data along unchanged.
- **Our data lives under `metadata.<product>`.** Per-app data lives under `metadata.premiere`,
  `metadata.edits` and so on.

**Effects come in three tiers, and the tier is the guardrail:**

| Tier     | Examples                                                                   | What agents may do                                                                                                                      |
| -------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Portable | transform, opacity, crop, speed, gain, fades, crossfades, text             | Read and write the values; every adapter maps them                                                                                      |
| Mappable | easing curves, Gaussian blur, basic colour, LUT, drop shadow, rounded crop | Read and write the values; adapters map them to the nearest equivalent and record the loss                                              |
| Native   | Sapphire or other third-party plugins, `.prfpset` stacks we can't parse    | Keep it, move it with its clip, toggle it on or off. Never change its parameters. Flag it in the parity report for targets that lack it |

**Native data is content-addressed, not inlined.**

- Each native blob (a Premiere effect's XML, an Edits effect JSON) is stored once in the project as
  `effects/<sha256>.<app>.json`.
- A clip references it as
  `{ "ref": "sha256:…", "app": "premiere", "label": "Malice slide in", "tier": "native", "fingerprint": "…" }`.
- **Deduplicated:** a card stack used 20 times is stored once.
- **Cheap for agents:** they see the short label, not kilobytes of XML.
- **Stale detection:** the `fingerprint` hashes the portable values the blob was tuned against
  (duration, scale, position). If an agent changes those, the ref is flagged stale instead of being
  reapplied blindly.

Easing is mappable, not portable. The Malice slide is a two-key bezier; Edits' nearest preset was
close, and a 25-key approximation looked "floaty".

A native stack keeps its **effect order**: Rounded Crop, then Drop Shadow, then Transform. Adapters
apply it in the target's insertion order; QE inserts at the top, so a Premiere stack goes in reverse.

**Presets are named, parameterized library entries.** One example is `card-in`, Binh's card stack
(Rounded Crop, then Drop Shadow, then Transform with a Malice slide).

- Each preset has portable parameters and one realization per app: a native blob ref for Premiere,
  nearest-equivalent keyframes for Edits.
- Agents place `preset: card-in` with parameters. The adapter expands it.
- Binh's style learnings (`style.md` values) become library entries instead of prose an agent has to
  re-read.

**The file is for tools; agents work through a compact view.**

- The `.otio` file stays canonical: pretty-printed with stable key order, so checkpoints diff
  cleanly.
- Agents don't read it raw. The `timeline` MCP toolkit returns a compact text projection with one
  line per item and integer frames at the sequence rate:
  `V2 2058–2166 emoji_dumpling src 0–108 preset:pop-in scale 1→1.15`. It also has a changes-only
  diff since the agent's last read, the way `seq_state.py check` works today.
- Agents write through typed operations (`place`, `trim`, `ripple`, `keyframe`, `applyPreset`), not file
  rewrites. Every operation is checked on the frame grid, so stills and graphics land on exact frames.

**Learnings become invariants in code, not notes in prompts.** The toolkit enforces what past edits
taught us on every write. Today these rules live in `premiere-automation.md`:

- Items stay in time order on a track.
- Everything snaps to the frame grid.
- No unintended gaps.
- Export duration matches the sequence.
- Source ranges are **source frame indices**, never seconds, so they don't change when an app
  interprets a clip at a different rate. Each media reference records its fingerprint and frame
  timestamp table (or at least its rate segments). Seconds from a transcript become frames only
  through that table.
- A clip that switches rate partway can't be cut until it is conformed whole.
- A user-trimmed range is protected. An agent may not extend it without saying so.
- Overlays never drop dialogue audio. Crossfades are centred on the cut.

**Typed items beyond plain clips:**

- **Words.** Each source's transcript (per-word times, kept retakes and fillers) is timeline data,
  so agents can cut by words (`cut words 112–131`) and get frame-exact ranges.
- **Generated clips.** A clip whose source is a recipe: the generator script, its parameters, and the
  last render. Revising it re-renders and relinks in place, so the clip's id and timing don't change.
  Generators can be in any language; most are Python today.
- **Captions** are their own item type: text from the transcript plus style tokens. Each adapter
  realizes them in its app's caption or graphic form.
- **Layout mode** is a timeline-level span (face plus pop-up, split, takeover). It derives caption and
  overlay placement, so moving into a split moves the captions.
- **Provenance.** Every asset records where it came from and its licence (today's `SOURCES.md`).

App quirks (Premiere's item order, Edits' 60 fps conform) live in each adapter's code and tests.

### 4. Adapters: push is a rebuild, pull is a turn, every push writes a parity report

- **Push** builds the whole sequence in one import as a new version, for example an FCP XML imported
  into Premiere as `<Name> vN`. It then attaches native effects and presets by reference. Import keeps
  track items in time order, so the out-of-order export bug can't happen. Live MCP calls are only for
  small, safe tweaks (a level, a marker).
  - Push starts from the latest pull. If the app's sequence changed since then, it pulls first.
  - Native items the model can't express survive every rebuild: upgraded caption graphics, grades,
    masks, plugin layers. They are re-attached by reference.
  - Attaching presets in Premiere means injecting into the closed `.prproj`, so push needs the app.
    See "the baton" below.
  - After a push, the adapter reads back where cuts actually landed and checks that against the plan
    instead of trusting conform maths.
- **Pull** reads _everything_: clips, effects with their order and parameters, keyframes,
  transitions, markers and captions. For Premiere that means an ExtendScript dump (like
  `pp_dump.json`) or parsing the `.prproj`. FCP XML is not enough, because it drops the user's
  finishing. Pull diffs the result against the last push and records the user's hand edits as a turn
  on the canonical timeline. That turn is checkpointed and labeled as the user's, so agents always
  start from the user's latest version.
  - A pull is also a learning moment. The agent proposes style or preset entries from what the user
    changed, such as "cut graphics that add context but don't move the story".
- **The baton.** At any moment either the user (in the app) or the agents hold the timeline.
  - An agent turn takes the baton: it pulls, edits the canonical file, pushes, and hands the baton back.
  - Push refuses while the user holds it, if the app shows a modal dialog, or if a destructive step
    (closing the project) would cost the user's undo history mid-edit.
  - The thread shows who holds it.
- **The parity report** lists, per item:
  - what landed exactly;
  - what was approximated, with the difference;
  - what was dropped;
  - which native effects were kept as-is.

  It is shown in the UI and returned to the agent. For a Premiere round trip it is mostly a check that
  native items survived. It matters most for cross-app pushes.

- **Render check.** "Done" means the change checked out in a real render: range renders of the changed
  spans, a contact sheet, frame checks, and export duration against sequence duration. The results
  come back to the thread as images.

### 5. MVP: one short, start to finish, round-tripped through Premiere (proposed)

Built from the past threads: it targets where time and failures actually went, and reuses
`_pipeline` instead of rewriting it.

1. **Project and media.** Each project records its media root. On import a clip gets a fingerprint
   and a frame timestamp table, and rate-switching clips are conformed whole (`clip_fps` becomes core).
2. **`timeline` MCP toolkit.** The compact view, a changes-only diff, and typed operations including
   `cut words`, `placeGenerated`, `applyPreset` and `caption`, with the invariants above enforced on
   every write.
3. **Premiere adapter.** A full pull (dump), push as a rebuild with native re-attach and preset
   injection, the baton, read-back after push, and a short parity and survival report.
   `seq_state.py`, `make_xml2.py`, `build_polish.py` and `apply_preset*.py` become this adapter.
4. **Timeline tab and player**: a track strip of the canonical timeline and a player, as described
   in Decision 6.
5. **Render check** through Premiere's export: range renders, contact sheets and duration checks,
   posted to the thread.
6. **Jobs and helpers.** Transcription (`stt`), generators and asset research run as delegated
   tasks. Exactly one agent, the thread's own, writes the timeline. Helpers deliver files and
   metadata and never write the timeline.

**Build status.**

- **Where a project lives: decided.** A video project's files (timelines, effect blobs, proxies)
  go in a `Stellar` folder beside the Premiere project: `SFUniqlo/Premiere/SFUniqlo.prproj` gives
  `SFUniqlo/Stellar`. They sit with the footage on whatever drive holds it, internal or external,
  and are visible in Finder. Never inside the app's own data folder.
- **New video project: done.** The new-thread screen offers "start a new video project": pick a
  `.prproj` on the host and a sequence. The server's `VideoProjects` service creates the folder,
  pulls the sequence, adds (or reuses) the project, and builds proxies in the background.
- **Video-only: decided.** Stellar has no code projects. Every project is a video project
  (`VIDEO_ONLY` in `apps/web/src/branding.ts`), git surfaces stay off (`SHOW_GIT_SURFACES`), and
  a server no longer adds the folder it starts in as a project. The code behind those surfaces
  is switched off, not deleted, so merges from upstream stay small. The cost is that Stellar
  can't be used to work on a repository, including its own.
- **Starting from an idea: done (milestone 1).** The same dialog also takes a name and a folder
  and makes the project's folders (`Footage`, `Audio`, `B-roll`, `Graphics`, `Premiere`,
  `Exports`, `Stellar/timelines`). A project is a video project once it has `timelines/`, so
  the Timeline tab opens empty with "Pull from Premiere", which starts in the project's own
  `Premiere` folder. A `.prproj` saved there resolves to the same Stellar folder, so pulling
  joins the existing project instead of making a second one. Agents can't call either start
  yet; that comes with the toolkit in milestone 4.
- **Intake: the copy and the preview are done (milestone 2, first half).**
  - "Import footage" in the Timeline tab lists the videos and photos that arrived in the
    host's Downloads in the last three days, by Spotlight's date added, grouped by the day they
    were shot. The chosen files are copied into `Footage/<folder>` in the background, each
    copy checked against its source's size. The originals stay in Downloads.
  - Progress is `intake.json` in the project folder, re-read by clients while it copies.
  - The proxy build now covers everything under `Footage`, not only what a timeline uses.
  - When a build ends, `timelines/Footage.otio` is rewritten: every clip back to back, so the
    footage plays in the Timeline tab before a Premiere project exists. A pulled sequence is
    still the one shown first.
  - Not built: the card in chat (it is a dialog), flagging overlap with a neighbouring
    project, and deleting from Downloads after the copy.
- **Agent tools: started (milestone 4, first two parts).** The `video_*` MCP tools call the
  same service the clients do: `video_timeline_read` (syncs with Premiere first, then one line
  per clip with its id and frames), `video_timeline_edit` (the typed edits in
  `packages/timeline/src/edits.ts`; one bad edit refuses the call), `video_project_start`,
  `video_premiere_pull`, `video_footage` and `video_premiere_export`. The read also reports what
  exists and whether Premiere is open and linked, so an agent doesn't spend its first minute
  finding out. Export is the first form of push: an FCP 7 XML in the Premiere folder that
  imports as a new sequence. It carries the cut only (not effects, text or stills), so it
  suits a rough cut and not a polished sequence, and it has not been imported into a real
  Premiere yet. For a sequence that already exists in Premiere, `video_premiere_push` instead
  returns an ordered plan (`packages/timeline/src/premiere/pushPlan.ts`) that the agent applies
  to the live sequence with its Premiere tools, touching only what differs from Premiere's last
  save; Stellar's server cannot drive Premiere itself, and the next read's sync is the check.
  No plan has been applied to a real Premiere yet. The baton and native re-attach are not built. The tool text has not been through
  `evals/mcp-tool-use` yet.
- **Cutting by words: built.** `video_timeline_words` numbers the words heard on a timeline and
  the `removeWords` edit cuts a run of them. It reads `Audio/<clip>.words.json` files, which a
  project's own pipeline may write and which Stellar makes for the rest: after an import, a
  proxy build or a saved voice-over take, and on `video_transcribe`, it runs the host's
  transcriber (the transcribe command in settings, else `stt` on the PATH) over footage and
  takes that have none, reporting to `transcripts.json` in the project folder.
- **The script as project data: built.** The Google Doc stays the script's source of truth;
  the project keeps a snapshot (`script.md`, with beat ids in `script.json`). `video_script`
  and `videoProjects.readScript` split it into beats (`packages/timeline/src/script.ts`) and
  place each on a timeline by matching its words against the transcripts, so a beat knows its
  word numbers and frames. Stellar doesn't fetch the doc itself: an agent reads it and passes
  the text in.
- **Frame rates: tables and whole-clip conforming, built (milestone 2, second half).** Ahead
  of every proxy build the server reads each footage clip's frame times from its packets
  (`ffprobe`, no decoding: 1.6 s for a 3.3 GB, 8-minute 4K clip) and records them in
  `media.json` in the project folder, with a frame table per variable-rate clip under
  `frames/` (`packages/timeline/src/frameTimes.ts`, the port of `clip_fps`).
  - Only a clip with more than one rate segment is conformed, as the pipeline did by hand;
    a steady 30 fps clip or ordinary iPhone jitter is cut through its table instead. The copy
    is the whole clip at constant 59.94, beside its original as `<name>_5994.mov`:
    `ffmpeg -vf fps=60000/1001,setsar=1 -c:v hevc_videotoolbox -b:v 45M -tag:v hvc1 -c:a pcm_s16le`,
    rotation baked in. About 5.8 MB per second and a little slower than real time for 4K.
  - It runs by itself after an approved import, as a step in `intake.json` that the Timeline
    tab shows. Footage that arrived another way is only measured; `video_footage` with
    `conform` makes its copies. Nothing else writes into `Footage`.
  - `media.json` ties each copy to its original with the original's size and modified time,
    so a replaced original shows as stale. A `_5994.mov` made by hand is taken up as a tie
    and never rewritten. Transcripts resolve by either name, proxies and the Footage
    timeline use the copy, and the XML export takes a variable-rate clip's `in` frame from
    its table. A timeline pulled from Premiere keeps whichever file it names.
  - The proxy build still records `rateChanges` itself; the Premiere badge reads those.
- **Voice-over: recording only (milestone 5, first step).** "Record voice-over" in the Timeline
  tab records this device's microphone and saves a 48 kHz WAV under `Audio/VO`, then drops its
  path into the chat. Takes aren't tied to script beats or placed on the timeline.
- **Stage: started.** A video project has a stage (Scripting, Footage in, Rough cut, Polish,
  Posted), kept as `stage` in `project.json` in the project folder, so the person, an agent
  editing the file and every client read the same thing. Unset, it reads Rough cut once a
  timeline is pulled and Scripting before. It shows on the new-thread screen and the Timeline
  tab. This is the catalog pill from Decision 7 without the catalog: nothing writes the
  Google Doc yet, and the agent doesn't propose moves.
- **Following Premiere's saves: done, one way.** `premiere.json` in the project folder records
  which `.prproj` the project follows and, per timeline, a hash of the text last pulled and of
  what Premiere's latest save reads as.
  - A `.prproj` only changes when Premiere saves, so its size and modified time say whether
    there is anything to pull. An unchanged save costs one `stat` (2–3 ms on SF Uniqlo); a
    changed one is re-read and re-pulled whole (about 260 ms). Pulling was never the slow part,
    so there is no incremental pull.
  - The Timeline tab syncs when it opens, when the window comes back into focus (the moment
    after a save in Premiere) and after a commit. The Premiere badge shows the result.
  - A timeline edited here is never overwritten. It shows as **Edited here**, or **Conflict**
    once Premiere saves something different. "Use Premiere's version" replaces it and keeps the
    replaced file in `timelines/replaced/`.
  - Projects pulled before the link existed are linked on first sync when their media root
    holds exactly one `.prproj`.
- **Pull, from the `.prproj`: done** (`packages/timeline`).
  - Reads clips, gaps, source ranges, media relative to the media root, the effect stack in order as
    content-addressed native refs with preset names, static Motion, Opacity and gain, transitions,
    and out-of-order items.
  - On SF Uniqlo Polish v1 it matches the live-Premiere `seq_state` baseline on 163 of 163 clips.
- **Pull also reads** the sequence frame size and keyframes for animated Motion, Opacity and
  Volume, as seconds from each clip's start. Easing stays in the native blob.
- **Timeline tab: working.** Video projects open a Timeline tab with the canvas player from
  Decision 6, editor transport keys, in and out marks with loop, full screen, thumbnail strips,
  waveforms and clip details.
- **Hand edits: started.** In the Timeline tab people drag clips (overwriting what they land
  on), trim edges (stopping at neighbours and the media's first frame) and delete. Edits stay
  pending, drawn as dashed outlines with ghosts and played by the preview, until a commit writes
  the `.otio`. They are the same pure operations an agent's toolkit will call
  (`packages/timeline/src/edits.ts`). A commit does not reach Premiere yet: that is the push in
  Decision 4, and it should honour the baton. Until then a committed timeline reads **Edited
  here** on the Premiere badge.
- **Not read yet:** Premiere's caption track (empty in SF Uniqlo, whose subtitles are V7 text
  graphics, now read), linked audio and video, and disabled clips.

The proof is a real short taken through rough cut, Binh's hand pass, polish, a revision round and
export. His hand edits and presets survive every push, nothing goes missing in export, and the round
takes fewer turns than the `short-edit` skill does today.

**Proactive editing craft.** Agents propose edits a human editor would, not only the ones they are
asked for:

- J and L cuts: audio leads or trails the picture across a cut.
- Cutting on action.
- Hiding jump cuts with a punch-in or an angle change.
- Choosing angles in multicam.

Each suggestion shows up in the thread as a card the user accepts or dismisses.

The user-facing surface is the Timeline tab and nothing more. Suggestions show as markers on it
and as cards in the chat.

Backlog: multicam coverage. Each source would record its angle (front, side profile, wide), with
angle-switch rules such as "switch to hide a jump cut". A top-down coverage map, or later a 3D
blocking model, was judged too much information for users for now.

Deferred: the Assets view, the Edits and other
adapters, Downloads ingest and proxies, PC offload, the preset library UI, and the rebrand.

### 6. Preview: an instant draft we draw ourselves, plus app renders for what only the app can draw

The player has to feel like an editor's, on a 60-second short and on a one-hour video with
thousands of clips.

- **Engine.** Playback runs on proxies (Decision 2): H.264 at 960 px on the long edge with a
  keyframe every 12 frames, so any seek decodes at most 11 frames. Each clip near the playhead gets
  a pooled browser decoder, and one canvas draws the active layers with their Motion and Opacity.
  The picture holds until every layer has its frame, so cuts don't flash. Normal speeds play the
  decoders and correct drift; paused, reverse and fast speeds seek. Moving to WebCodecs and WebGL
  is the upgrade path if shaders or long reverse play need it. The timeline renders only the clips
  near the visible range and shows thumbnail strips and waveforms made with the proxies.
- **Proxies today** come from `packages/timeline` (`proxies <project>`), keyed by each file's path,
  size and modification time, with `proxies/index.json` mapping clips to them. The server builds
  them when a project is created, when a pull brings new media, and when a sync finds a build
  that never finished.
  - One ffmpeg run per file makes the proxy, thumbnail strip, audio and waveform, with hardware
    decode where the machine has it. The source is read and decoded once instead of four times:
    a 43 s 4K HEVC clip on the SSD took 56 s before and 23 s after, with the same output.
  - The index is rewritten as each file finishes and the Timeline tab re-reads it while a build
    runs, so clips switch from their original file to their proxy one by one.
  - Outputs are written under `.part` names and renamed, so a killed build leaves no truncated
    proxy that later counts as done.
  - The player keeps the most recently used proxies in memory up to 768 MB and fetches the rest
    three at a time, nearest the playhead first.
- **Controls follow editors.** Space plays and pauses. J, K and L shuttle, with repeated presses
  speeding up. Left and right step a frame, Shift steps ten. Up and down jump between edits.
  Home and End go to the ends. I and O mark a range, and there's loop playback and full screen.
  These are the keys Premiere, Resolve and Final Cut users already know.
- **Effects in three kinds,** following the tiers in Decision 3:
  1. Portable effects (position, scale, rotation, crop, opacity, speed, crossfades, basic colour,
     text) are drawn by our engine, close to exact, for any app.
  2. Presets that are keyframed transforms underneath, such as the Malice slide-ins (Premiere's
     Transform with keyframes), are read from their native blob and drawn the same way.
  3. Plugins and app-owned graphics (Sapphire, motion graphics templates, caption styles) are
     rendered by the app that owns them, only for the seconds they cover, in the background. The
     result is cached by effect ref and time range and spliced into the preview. Premiere and
     Resolve can be scripted to do this. Apps that can't, such as CapCut, stay at the draft look.

Backlog: **AI-approximated effects.** For kind 3, an agent looks at the effect (its preset name,
parameters and a reference render from the app) and writes an approximation in our portable effect
language, such as a shader or keyframes. Because native blobs are content-addressed, one
approximation serves every use of the same preset. Approximations are labelled as such in the
player, never pushed back to the app, and can be scored against the app's render of the same frames
before they're trusted. This gives a close preview of apps that can't render for us and an
instant one before an app render arrives.

### 7. The run as a flow: from AirDrop to posted, in one window (proposed)

Drafted from the Jollibee run (2026-11-09), the first short taken end to end with a Claude parent
coordinating and Codex children (gpt-6.1-sol, low effort) doing the skill work. Every step below
happened in that run as chat text. The design turns each one into a surface Binh can see and act on,
without leaving the window.

**Layout.** Nothing new. Threads on the left, the chat in the middle, the right panel's tabs as
they are. The script is a step before the timeline, not a tab beside it. While scripting, the script
doc is open in an ordinary **Browser** tab with the chat on its left. Once the footage is in, the
**Timeline** tab takes over. The catalog opens in a Browser tab too, on demand.

**The steps, mapped to the run.**

| #   | Step                 | In the run                                                                                                                       | Where it lives                                                                       | Binh's gate                   |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------- |
| 1   | Preflight            | SSD at 480 Mb/s, Drive needed re-auth, Edits MCP down. The parent stopped and explained in chat.                                 | A **preflight strip** at the top of the thread                                       | Fix, or **Continue anyway**   |
| 2   | Script               | A child wrote the VN script doc and added it to the catalog under Available. (It ran after intake; it doesn't need the footage.) | A **Browser** tab beside the chat; a **catalog status pill**                         | Edits the doc freely          |
| 3   | Intake               | 25 files found via Spotlight's date-added, thumbnails checked, overlap with SFUniqlo ruled out, copied and verified.             | An **intake card** in the chat                                                       | **Approve** (per file or all) |
| 4   | Setup and transcribe | Folders, `clip_fps` (two ~30 fps clips, one horizontal), `stt --lang vi`.                                                        | **Job rows** in the chat with progress; clip warnings as badges in the media list    | None                          |
| 5   | Hook pick            | Hook candidates and the first-bite moment with timestamps.                                                                       | A **hook card**: each candidate plays as an in/out range in the preview              | **Pick one** (his gate)       |
| 6   | Rough cut            | Built in Premiere, serial, `seq_state` check before and after.                                                                   | Timeline tab; Premiere badge shows sync state                                        | None                          |
| 7   | Hand pass            | Binh refines in Premiere.                                                                                                        | Timeline tab pulls his version; the **diff** of his changes shows as dashed outlines | **Done refining**             |
| 8   | Polish, captions, QA | Beat map, motion, b-roll, captions, contact sheets.                                                                              | Beat markers on the ruler; QA stills as a card                                       | Revision notes                |
| 9   | Post                 | Export, then catalog to Posted.                                                                                                  | Export card; catalog pill to **Posted** with the link                                | **Mark posted**               |

**1. Preflight strip.** One row of checks when a video thread opens, and again before any step
that needs them:

- drive mounted and its link speed (`system_profiler`)
- free space
- each connector's auth (Google Drive)
- each MCP server's health (Premiere, Edits)

A green check stays collapsed. A failed one expands to one plain sentence on why it blocks, such
as: "The SSD is on a USB 2 cable (480 Mb/s). Phone video plays, but layered tracks, ProRes and
copies will crawl." Next to it go the fix ("Use the drive's own USB-C cable, straight into the
Mac") and a **Continue anyway** button. An override is recorded in the thread, so the agent and
later turns know it was a choice. An auth failure links straight to the connector's sign-in.

**2. Script, in a Browser tab.**

- **Where it sits:** a normal Browser tab in the right panel, the chat on its left, so Binh and the
  agent work on the script together. The agent opens it there when it creates the doc.
- **Sign-in persists** through the desktop browser's persistent profiles, which already exist: a
  named profile keeps its cookies across restarts, and cookies can be imported from Chrome
  (`docs/user/browser-import.md`). The video project picks one profile (default "Google"), so
  Binh signs in once. Stellar hides Settings → Browser today. Bring back only its Browser profiles
  section, or let the Browser tab's menu pick the profile.
- **The browser and the agent are separate.** The browser's cookies are Binh's and never go to the
  agent. The agent reads and writes the doc through the Google Docs/Drive connector, which has its
  own sign-in (checked in preflight). On web and mobile clients there is no built-in browser, so
  the agent posts the doc as a link that opens in Google Docs.

**Order and hand-offs, from script to footage on the timeline.** The table reads as a line, but
the first steps don't depend on each other, and today the app only enters at step 6.

- **The project starts at the idea, not at the `.prproj`.** "New video project" gets a second
  start: a title and a folder. It creates the folder skeleton (`Footage`, `Audio`, `B-roll`,
  `Graphics`, `Premiere`, `Exports`, `Stellar`) and adds the project, so the script, the intake
  card and the preflight strip have a thread and a place for files. Starting from an existing
  `.prproj` stays for projects already under way.
- **Script and intake run side by side.** Neither needs the other. Preflight comes first; then
  the script child and the intake scan start together. The intake gate (Approve) unblocks setup
  and transcription. The script only has to exist by the hook pick.
- **Google Docs is the script's source (decided).** Binh writes and edits there, in the
  Browser tab beside the chat wherever the client has one. `/video-script-catalog` creates the
  doc and its catalog entry, and can run at either end: before recording, from the idea alone,
  or after import, written against the footage.
- **The project keeps a snapshot, never a second source.** At each gate the agent saves the doc
  as `Stellar/script.md`, one heading per beat with its id. Transcript alignment and beat
  markers read the snapshot, so they are checkpointed with the timeline and show what the
  script said when a cut was made. Edits always go to the doc; the snapshot is only refreshed.
- **Proxies start at intake.** Once files are copied and verified, the server builds proxies
  for everything in `Footage`, not only for what a timeline already uses. They are keyed by
  file, so the first pull finds them ready and the rough cut plays at once.
- **The link is made when the rough cut is saved.** The agent creates the `.prproj`, saves it,
  and links it through the same service the dialog uses. From then on the Timeline tab follows
  Premiere's saves (see Build status), and new sequences (`v2`, `v3`) are offered as they
  appear instead of needing the dialog again.
- **Every gate is a save point.** Approve, Pick one and Done refining each end with the agent
  saving the Premiere project, so what Binh sees in the Timeline tab is what the next step
  starts from.

Built so far: the last bullet's sync. The rest is proposed.

**3. Intake card.** The agent posts it; Binh approves it.

- Files are grouped by capture session (shoot date and time gaps), with a thumbnail strip per
  group.
- Anything that also matches a neighbouring project is flagged: same evening, filename range next
  to SFUniqlo's.
- The card shows the destination path and an Exclude toggle per file.
- **Approve** runs copy, then size verify, then delete from Downloads, with progress, and leaves
  the card as a receipt.
- Lesson from the run: AirDrop keeps the original file dates, so finding "today's drop" must use
  Spotlight's date-added. Ask it with one `mdfind` query on `kMDItemDateAdded` scoped to
  `~/Downloads`, not `mdls` per file, which took over two minutes on 2,448 files.

**Keeping the script, transcript and timeline in sync.** The script's beats are the shared key.

- **Beats get stable ids.** When the agent writes the script, each beat (hook, setup, first bite,
  reactions, verdict, outro) becomes a heading wrapped in a Docs named range `beat-<n>`. Named
  ranges survive Binh's edits around them, so a beat keeps its id while its words change.
- **Beat ↔ transcript.** After transcription the agent aligns each beat's lines to the words that
  were actually said and stores the span on the beat. Placeholder reactions ("[real reaction from
  footage]") get filled with real quotes and their timecodes, written back into the doc. Nothing is
  invented, as in the run.
- **Beat ↔ timeline.** Each beat becomes an OTIO marker carrying its id
  (`metadata.stellar.beat`). Markers show on the ruler. Clicking one moves the playhead, and its
  menu opens the doc at that heading in a Browser tab (Docs heading anchors in the URL).
- **Binh's doc edits flow back as proposals, never as silent changes.** The server watches the doc
  revision (when its Browser tab loses focus, and every minute while the thread is active). When it changes, it
  diffs beats by id and posts a card: "You rewrote the hook line in beat 1. Recut the hook to
  match?" Accepting runs a normal agent turn. The timeline is only ever written by the thread's
  agent (Decision 5).

**Catalog status.** A pill in the thread header: **Available → In
progress → Posted**.

- The agent proposes each move at a natural point: In progress when intake is approved, Posted
  when the export is delivered. Binh confirms with one click, or sets the pill himself.
- A move rewrites the smart chip's place in the [2026] Video Idea Catalog through the Docs
  connector. Posted asks for the post link.
- Every write is checked by reading the doc back. Drive metadata reported `canEdit: false` for the
  catalog in the run even though the write succeeded, so permission flags alone aren't trusted.

**Who does what.** The parent (the thread's agent) owns gates, cards and the timeline. Children run
skill steps (script, intake scan, transcription, generators) and report files and metadata back.
Cards are where a gate waits for Binh. While a card is open, nothing past that gate starts, and the
thread shows it as waiting on him rather than working.

## Milestones

All seven are in scope. Premiere stays the finishing tool, so Stellar never needs its own
renderer; "done" is checked through Premiere's export.

1. **A project before Premiere.** Start from a title and a folder; create the folder skeleton;
   link the `.prproj` when it exists. Done when a new idea's script, footage and timeline land
   in one project without the dialog again.
2. **Intake.** The approve card, copy and verify, proxies for everything in `Footage`, frame
   timestamp tables and whole-clip conforming. Done when footage plays in Stellar minutes after
   approval, before any Premiere project exists.
3. **Script and transcript as project data.** The Google Doc in the Browser tab, its snapshot
   with beat ids, word timings attached to clips, and Vietnamese transcription that survives
   restaurant noise. Done when a script beat jumps to its words in the footage and back.
4. **Agents edit through Stellar, and edits reach Premiere.** The `timeline` toolkit with its
   invariants, push as a rebuilt sequence, the baton, and a diff of the hand pass. Done when
   the agent's next change keeps every hand edit.
5. **Voice-over.** Record or import takes per beat, align them to the script, conform picture
   to the voice. Done when re-recording one line re-times only that beat.
6. **A preview to trust.** Crop, speed, transitions, easing, caption styling, browser-unfriendly
   stills, ranged proxy reads, audio crossfades. Done when a cut can be approved without
   opening Premiere to check it.
7. **Finish.** Render check, contact sheets, catalog to Posted, and the preflight strip. Done
   when one short goes from idea to posted with no step living only in chat.

**Order by flow.**

- Script, then record, then edit: 1, 3 (script), 2, 3 (transcript), 4, 6, 7.
- Import, then script, then voice-over, then edit: 1, 2, 3, 5, 4, 6, 7.

Build order: 1, 2 and 4 first, with the transcript half of 3 alongside. They remove the most
manual work from a run like Jollibee.

## Holes

What the design promises and the code doesn't do yet, and what the code does that the design
hasn't faced. Grouped by where they bite; the first item in each group is the one to fix first.

**From script to import**

1. A project started from an idea is only folders. The script, intake and preflight steps
   still have no surfaces in it (hole 2), and the Premiere link is made by hand from the
   Timeline tab rather than when the agent saves the rough cut.
2. None of Decision 7's surfaces are built: no preflight strip, intake card, job rows, hook card,
   catalog pill or beat markers. The run is still chat text.
3. Agents can't reach any of it. Creating, linking and syncing a video project are UI-only, and
   the `timeline` toolkit doesn't exist. Agents edit Premiere through its own MCP, so the
   `.otio` is a mirror of Premiere today, not the thing agents edit.
4. The script exists only in Google Docs. That needs the connector signed in, a built-in
   browser (desktop only), and an undecided way to watch the doc (open questions 9 and 10).
5. Intake is a dialog the person opens. An agent can't run it or post it as a card, and it
   never removes the originals from Downloads.
6. New sequences aren't discovered. Each `vN+1` needs the new-project dialog again, and the
   timeline picker doesn't say which version is the latest.
7. Frame tables exist but the timeline doesn't cut by them. Source ranges in the `.otio` are
   still seconds at a rate, not the source frame indices Decision 3 asks for; only the XML
   export looks a frame up in a clip's table, and the push plan and the player don't. Nothing
   stops an edit on a rate-switching clip that has no copy yet. Ties are recognised by the
   `_5994.mov` name alone, so older copies under other names (`IMG_8168 CFR5994 FULL.mov`)
   stay untied, and staleness goes by size and modified time, which a drive moved between
   machines can shift. Conforming always targets 59.94 whatever the sequence, never checks
   free space, and off a Mac falls back to slow software HEVC.
8. Transcripts aren't timeline data. `*.words.json` sits in `Audio/` and nothing links it to
   clips, so "cut by words" and beat alignment have nothing to stand on.
9. Nothing checks for ffmpeg and ffprobe. A machine without them builds no proxies; the badge
   now reports how many files failed, but not why.
10. The dialog browses host folders (it now reopens where the last project was). No recent
    projects, no drag and drop, one sequence at a time.

**Sync with Premiere**

11. It is one way. Commits made in the Timeline tab never reach Premiere: push, the baton and
    the parity report are unbuilt. A conflict offers one side or the other, never a merge.
12. Only saved state is seen. Unsaved work in Premiere is invisible, and nothing asks Premiere
    to save.
13. Sync runs when a web or desktop client opens the tab, regains focus or commits. An agent
    turn, a phone, or a server with no client open never triggers it, so an agent can read a
    stale `.otio`.
14. A pull replaces the whole file. What changed isn't shown (step 7's dashed diff), the user's
    hand pass isn't recorded as their turn, and "Sync now" drops uncommitted edits without
    asking. Focus sync holds off while there are any.
15. A sequence deleted or renamed in Premiere silently stops updating its timeline.
16. A read that lands while Premiere is writing shows as Offline until the next sync.
17. The pull doesn't read speed changes, the caption track, linked audio and video, or nested
    sequences. Transitions are read but only kept as metadata.

**Playback**

18. A proxy is fetched whole into memory before it plays. Fine for shorts; a one-hour camera
    file's proxy is over a gigabyte and won't load. Long-form needs ranged reads.
19. The preview draws Motion, Opacity, gain and plain text. It doesn't draw crop, speed,
    transitions, blend modes or easing (keyframes are linear), and text uses a system font at
    a guessed size. App renders for plugin effects (kind 3) are unbuilt.
20. Audio is one media element per clip: no crossfades, steering by small rate changes, muted
    above 2×, silent in reverse.
21. Stills are served as the original file. PSD, TIFF and HEIC don't decode in a browser, so
    those layers draw nothing.
22. Proxy keys include the absolute path. Moving the drive to another machine or mount point
    orphans every proxy, which is the opposite of "proxies travel". Orphans are never cleaned.
23. Without proxies the player uses the 4K originals through video elements. It now switches
    over file by file, but the first minutes of a new project still stutter.
24. Remote clients fetch the same 960 px proxies over the relay, with no smaller rendition.
    Firefox and Safari fall back to video elements where WebCodecs is missing.
25. Proxy progress reaches clients by re-reading the index every 2.5 s during a build. There
    is no event for it.

**The Timeline tab**

26. It exists on web and desktop only. Mobile has no timeline or preview.
27. "Timeline saved" is true of the `.otio` and nothing else. The badge now says so, but
    nothing reads the commit downstream.
28. No markers, beat markers, suggestion cards or version history. Undo stops at a commit.
29. `TimelineViewer.tsx` is one 2,100-line component under `components/files/`.

**The model**

30. Native blobs are stored by hash, but there is no fingerprint or stale detection, no preset
    library and no tier guard on writes, because nothing writes yet.
31. The invariants in Decision 3 are prose. Only "items stay in time order" is checked, as a
    warning on pull.
32. The render check (Decision 4) is unbuilt, so "done" still means "looked right in playback".
33. The namespace is `stellar` in code; this document still says `<product>` and lists the name
    as open.

## Open questions

4. Preview engine details: proxy codec and size, and whether app renders run on the user's machine
   or the compute machine (Decision 2).
5. Runtime split (default unless Binh objects): the timeline model, toolkit and rules live in the
   TypeScript server. The Python `_pipeline` jobs and the OTIO library run as subprocesses behind a
   JSON boundary.
6. Media and ingest pipeline (Downloads intake, proxies).
7. Licensing (stay MIT-compatible).
8. Product name. The fork is rebranded (the upstream project's MIT licence and copyright notice stay in the
   source). Branding is centralized (`apps/web/src/branding.ts`, desktop branding), so the rebrand
   is small and upstream merges stay easy. The extension namespace in the timeline file
   (`metadata.<name>`) takes the product name.
9. Watching the script doc: poll its revision (simple, works anywhere) or use Drive push
   notifications (needs a public endpoint, which a local server doesn't have).
