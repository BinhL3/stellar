export default `---
name: multi-pov-group-edit
description: A gaming or group video with one main character, several POV recordings and game audio, cut around what is said.
---

# Multi-POV group edit

Defaults below are this recipe's; say them to the user when you start and use theirs instead when they give any.

Expect one main-character recording, one per secondary POV, and game audio, each on its own tracks of the timeline. Read \`video_timeline_read\` first and name which track is whose; ask when you can't tell. Every POV needs a transcript: \`video_transcribe\` the ones \`video_timeline_words\` shows without.

## 1. Sync on a buzz word

Find a clear, distinctive word the main character says that every POV mic also picked up: in \`video_timeline_words\` it appears in each audio clip as \`index:word@startFrame\`. For each POV, the offset is the main clip's frame for that word minus the POV clip's. Move that POV's video and audio clips by the offset with \`video_timeline_edit\` move (same track, \`startFrame\` plus the offset); clips are not linked, so move both. Confirm with a second word later in the recording: its frames should match within a frame or two. If no word is shared, or the second word disagrees, draw the passage on the main and POV clips with \`video_timeline_words\` \`picture\` and line up the same sound by eye; tell the user the sync is by eye. Stellar has no waveform auto-sync.

## 2. Cut by listening

Pick the worthwhile dialogue from the words, not the picture: read the main character's words and each POV's, and keep the exchanges that carry the story or a joke. Cut dead air and dull stretches with removeWords and trimPause on the main character's audio, then read \`action: "joins"\` and fix what it flags.

Premiere's Track Select Forward (A) has no single edit here. To shift everything after a frame, move every clip on every track that starts at or after it by the same amount in one call, the last clip first so nothing overwrites. Keep the main character's picture on screen throughout.

## 3. POV swaps: 10 s

Every 10 seconds, show the secondary POV of whoever is speaking then: the speaker is the POV whose clip has words in that stretch. Split the POV video tracks at each 10 s boundary (split with \`tracks\`), then setEnabled false on the pieces of POVs that aren't speaking. Leave a stretch as it is when nobody else speaks. Where each POV sits on screen (picture-in-picture size and position) is set in Premiere; Stellar doesn't.

## 4. Split plotlines: 30–60 s stretches

When the group splits up, find the frames where characters leave and rejoin from their words. Cut the main story there (split), open a gap by moving everything after the cut forward as in step 2, and move the split-off plotline's clips into the gap from their POV track, 30 seconds to a minute at a time, back and forth until they rejoin. Stellar can only move clips already on the timeline: footage that isn't there needs \`video_footage\`, or the user adds it in Premiere. Leave a marker at each switch so the user can judge it.

## 5. Finish in Premiere

Stellar's timeline has no clip gain, audio effects or transitions, so say so and do these in Premiere. Push the cut first with \`video_premiere_push\`. If you have Premiere tools, look each effect and transition name up in Premiere's lists before applying it and report any that are missing; otherwise give the user this checklist.

- Levels: main mic -4 dB, secondary POV mics -12 dB, game audio -20 dB (per audio track, e.g. a set-clips-volume tool).
- Vocal Booster then Hard Limiter on the dialogue tracks (the user does it in the Audio Track Mixer, or apply it per clip with an audio-effect tool).
- Audio fades: Preferences > Timeline > Audio Transition Default Duration 0.10 s, select all clips, then Cmd/Ctrl+Shift+D for the default audio transition at every cut. Premiere tools add only video transitions, so this one is the user's.

Then \`video_render_check\` the export.
`;
