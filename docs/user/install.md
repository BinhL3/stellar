# Install Stellar

Stellar is an AI video editor. Agents edit your video timeline on your computer,
and Premiere Pro is where you finish the cut. Set up the machine where the
agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch Stellar and configure providers afterwards.

## Desktop app

Stellar has no installer or package-manager release yet. Download a desktop
build from [GitHub Releases](https://github.com/BinhL3/stellar/releases) when one
is published, or build it from source with `vp`, which provides the Node version
it needs:

```bash
git clone https://github.com/BinhL3/stellar
cd stellar && vp i && vp run build:desktop
vp run start:desktop
```

Update a source build with `git pull` and a rebuild.

### The `stellar` command

The desktop app includes the `stellar` command-line tool. To run it from any
terminal, open **Settings → About** and choose **Install** next to
**stellar command**. On macOS and Linux it adds a `stellar` link to a folder on your
`PATH`; on Windows it adds the app's command folder to your `PATH`. Open a new
terminal afterwards. **Remove** takes it off again.

| Task                                             | Command                                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Start the server without a browser               | `stellar serve`                                                              |
| Use it from your other devices                   | `stellar up` ([details](./remote-access.md))                                 |
| Keep it running in the background (macOS, Linux) | `stellar service install` ([details](./background-service.md))               |
| Reclaim database space                           | `stellar doctor` ([details](./background-service.md#reclaim-database-space)) |

Run `stellar help` or `stellar --help` for the full reference.

If `stellar serve` reports an already running server, connect to that server
instead. Stop it before starting a replacement, or use a different `--base-dir`
for an independent server.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Sharing & access** to run agents and projects
there. Install the provider CLIs inside that distro. Stellar installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
t3 app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `t3 app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

Stellar's mobile app is not in the App Store or Google Play. It lives in
`apps/mobile` in the repository and can be built from source. The phone connects
to a server on another machine. Follow [remote access](./remote-access.md) to
link it through T3 Connect or a pairing URL.

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack. Copy the report and paste it into a
[GitHub issue](https://github.com/BinhL3/stellar/issues). Error messages can quote
values from the app, so read it over before sharing.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| Kiro        | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from Stellar's provider settings.                                                                                         |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx          | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |

Provider CLIs must be on the server's `PATH`. If Stellar cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

Stellar warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or the
CLI's own update command when Stellar cannot tell. Update a CLI installed with
mise through mise. Cursor and Antigravity update with Stellar. Homebrew and
Chocolatey installs compare against the version their package manager offers,
which can trail the npm release; update Claude installed with Chocolatey
through Chocolatey.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, Stellar does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Kiro](./providers-kiro.md),
[Pi](./providers-pi.md), [Muse Code](./providers-muse.md), and [fx](./providers-fx.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating Stellar](./updating.md): update the app and connected servers.
- [Managed policy](./managed-policy.md): configure Stellar for everyone on a machine.
