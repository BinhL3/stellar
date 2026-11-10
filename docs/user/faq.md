# FAQ

## What is Stellar?

Stellar is an AI video editor. You describe the edit in a thread, an agent works on your video
timeline, and you finish the cut in Premiere Pro. Stellar is a fork of the open-source
[pingdotgg/t3code](https://github.com/pingdotgg/t3code) project (MIT).

## Which agents can I use?

Bring your own: Claude Code, Codex, Cursor, Grok Build, OpenCode, Google Antigravity, Pi, or
Muse Code. Stellar drives the agent you already have installed and signed in. [Provider setup](./install.md#providers)

## Can I use Stellar with my Claude Code subscription?

Yes. You still pay your provider like you already do.

## How much does Stellar cost?

Nothing. It is free and open source (MIT). Remote access through T3 Connect is a separate,
hosted service. Every T3 Connect account can connect up to 3 machines; phones and browsers that
connect to them do not count. Linking a paid T3 Chat account raises that limit.
[More machines](./remote-access.md#more-machines-with-t3-chat) LAN pairing and Tailscale have no
machine limit.

## Can I use an API key or OpenRouter instead of a subscription?

Yes. Add another provider instance in Settings and give it its own keys and endpoint. Claude has a
full OpenRouter recipe. Your subscription setup stays untouched.
[OpenRouter](./providers-claude.md#openrouter) · [Provider instances](./install.md#providers)

## How do I use Stellar remotely?

Your agents run wherever Stellar runs: your desktop, a server, a VPS. Run `t3 up` on that
machine to connect to it from other devices. T3 Connect is the easy path; LAN pairing and
Tailscale work too. [Remote access](./remote-access.md)

## Why does T3 Connect keep disconnecting?

Open **Settings > Environments**, find the machine, and select **Details**. The first part marked
as failed is the cause. Tailscale is a good fallback route.
[T3 Connect troubleshooting](./t3-connect-troubleshooting.md)

## Does my footage go to Stellar servers?

No. Your files and prompts go from your machine to your provider (Anthropic, OpenAI, and so on).
With T3 Connect, traffic rides a Cloudflare tunnel (`cloudflared` on your machine); the relay sets
up the link but does not proxy your HTTP or WebSocket sessions. Stellar sends no product usage
events. [Product usage data](./telemetry.md)

## Is there voice input?

Yes. On iPhone and Android, dictation uses on-device speech by default; you can opt in to a paired
environment instead. Web and desktop require you to choose an environment first. The transcript
goes into your draft for review. See [Voice input](./voice-input.md).

## Does it work on Windows, Mac, and Linux?

Yes. Windows users can also run agents inside WSL. [Install](./install.md)

## Why is my provider not showing up?

Almost always, the CLI is not installed or not on the `PATH` of the machine that runs the server
(the computer, not your phone). Log in on that machine first, like `codex login` or
`claude auth login`. Still missing? Point **Binary path** at it in provider settings. Version
managers often cause this. [Provider setup](./install.md#providers)
