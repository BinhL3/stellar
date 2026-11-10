# Stellar

Stellar is an AI video editor. You talk to agents in a chat on the left; they cut your footage on
an [OpenTimelineIO](https://opentimeline.io) timeline you can watch, scrub and mark on the right.
When the cut is right, Premiere Pro is where you finish it.

Stellar runs on your own machine and uses the agent subscriptions you already have. If Claude Code
or Codex is set up on your computer, Stellar can drive it.

## What it does

- **Preview first.** The editor opens on the preview with a scrub bar. Show the timeline when you
  want tracks, clips and trims.
- **Point at a moment.** Mark an in and out, or pick a single frame, and add it to the chat so the
  agent knows exactly which part you mean.
- **Agents edit, you watch.** Every agent edit lands on the timeline as it happens.
- **Finish in Premiere.** The timeline goes to Premiere Pro for effects, captions and export.

## Install

> [!WARNING]
> Install and sign in to at least one provider first:
>
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`

There is no installer yet. Build the desktop app from source with [`vp`](https://viteplus.dev),
which provides the Node version it needs:

```bash
git clone https://github.com/BinhL3/stellar
cd stellar && vp i && vp run build:desktop
vp run start:desktop
```

Builds are published to [GitHub Releases](https://github.com/BinhL3/stellar/releases) when they
exist. See [Install and first run](./docs/user/install.md) for the details.

## Privacy

Your footage and prompts go from your machine to your provider and nowhere else. Stellar sends no
product usage data. See [Product usage data](./docs/user/telemetry.md).

## Documentation

- [Install and first run](./docs/user/install.md)
- [FAQ](./docs/user/faq.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Appearance](./docs/user/appearance.md)
- [Connect agents over MCP](./docs/user/outside-agents.md)
- [Video editor design](./docs/video-editor/DESIGN.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## Development

Install the `vp` command:

```bash
curl -fsSL https://vite.plus | bash
```

Then install dependencies and start the dev app:

```bash
vp i
vp run dev
```

## Credits

Stellar is built on [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools Inc., under the
[MIT licence](./LICENSE).
