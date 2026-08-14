# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, and OpenCode. If they're set up on your computer, T3 Code can control them.

## What this fork adds

This repository is a downstream fork of [T3 Code upstream](https://github.com/pingdotgg/t3code). It keeps the upstream product as its base and maintains a small, explicit layer for integrations and release behavior that are specific to this fork.

- **Pi provider:** native Pi RPC integration with model discovery, model and thinking-level selection, streamed assistant/thinking events, attachments, and independent provider instances. Startup RPC calls such as `set_model` use an initialization timeout separate from normal prompt requests.
- **Antigravity provider:** an `agy-direct`/Antigravity CLI adapter that consumes `stream-json` output and maps streamed text, completion, interruption, and process errors into T3 Code runtime events. Each configured instance keeps its own process and session state.
- **Prime Agent provider:** a separate Prime Agent driver built on the shared Pi-style RPC transport.
- **Downstream AppImage releases:** this fork builds from a pinned upstream release and applies the patch recorded in [`downstream/overlay.json`](./downstream/overlay.json). The release workflow verifies the upstream repository, tag, commit, overlay checksum, and generated source match before publishing the AppImage to [this fork's releases](https://github.com/oliveralerubio/t3code/releases).

This is a downstream overlay, not a manual copy of T3 Code. Upstream owns the base source; this fork maintains only its delta and rebuilds the distributable image when the upstream pin moves. See [`docs/downstream-releases.md`](./docs/downstream-releases.md) for the maintenance model.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> This fork supports the upstream Codex, Claude, Cursor, Grok Build and OpenCode integrations, plus Pi, Antigravity and Prime Agent. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Try it out (install-free)

The easiest way to test T3 Code is to run the server in your terminal (requires Node.js 22.16+, 23.11+, or 24.10+):

```bash
npx t3@latest
```

This will launch T3 Code's backend on your machine as well as the local web app to control your agents.

Tip: Use `npx t3@latest --help` for the full CLI reference.

The `npx` command and package-registry commands in this section are the upstream T3 Code distribution. To use the fork-specific Pi, Antigravity, and Prime Agent integrations, install the fork's desktop AppImage from its releases below.

### Desktop app

Install the latest version of this fork's desktop app from [its GitHub Releases](https://github.com/oliveralerubio/t3code/releases). The original upstream T3 Code releases are published separately at [pingdotgg/t3code](https://github.com/pingdotgg/t3code/releases).

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Customize a project icon](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- Linux: [run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
