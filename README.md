# Cinba

Cinba is a personal AI coding agent client built on [pi.dev](https://pi.dev/). It keeps one Core
service as the source of truth while Web and terminal clients connect to it through the same
protocol.

The project is also a learning exercise: its layers stay deliberately visible so the agent loop,
tool calls, permission decisions, sessions, credentials, and remote deployment can be understood
rather than hidden behind a framework.

## Current status

Cinba is personal, experimental software. The local Windows workflow is usable today. The guarded
VPS deployment machinery is implemented and tested locally, while the first real deployment with
Tailscale, Caddy, and systemd is still in progress.

Available now:

- Web and terminal interfaces backed by one Core;
- multiple conversations with switching, naming, deletion, and message editing;
- provider credential management and model switching;
- streamed text, reasoning, tool cards, token usage, and cost;
- an always-on permission gate for tool execution;
- Core identity display and automatic Web reconnection;
- development and production-style launchers;
- guarded `master` to `prod` promotion and rollback-capable VPS deployment logic.

Cinba is not designed to be exposed directly to the public internet. The planned remote shape keeps
the Core on loopback and places Tailscale access control and a Caddy HTTPS proxy in front of it.

## Requirements

- Windows for the current local launcher workflow;
- Node.js 24 or newer;
- npm and Git;
- an API key for a model provider supported by Pi.

## Quick start

```powershell
git clone https://github.com/SounDoer/Cinba.git
cd Cinba
npm install
npm start
```

`npm start` builds the Web UI, ensures the shared local Core is running on `127.0.0.1:4517`, and
opens it in the browser. The launcher can then exit: the Core stays in the background while any
client is connected and stops safely after ten client-free minutes. On Windows, `cinba-web.cmd`
provides the same flow as a double-click launcher.

For development with Core watch mode and Vite hot reload:

```powershell
npm run dev
```

The development UI opens on `127.0.0.1:5173`. The equivalent Windows launcher is `cinba-dev.cmd`.

To open the terminal client:

```powershell
npm run tui -- C:\path\to\project
```

You can also drag a project directory onto `cinba-tui.cmd`.

To make the TUI available as `cinba` from every PowerShell working directory, link the repository
once through npm:

```powershell
cd C:\path\to\Cinba
npm link
Get-Command cinba
```

Change to any project and start the terminal client:

```powershell
cd C:\path\to\project
cinba
```

The command starts the shared local Core when necessary, then opens the TUI in the current
directory. A Web window, Desktop window, and any other TUI reuse that same Core. The global command
stays linked to this checkout and passes the current directory to the same `scripts/launch.ts tui`
entry used by `npm run tui` and `cinba-tui.cmd`. Remove it with `npm unlink --global cinba`. The Web
launcher is named `cinba-web.cmd`, so the global `cinba` command remains unambiguous in both
PowerShell and `cmd.exe`.

The local Core log is appended to `%USERPROFILE%\.cinba\core.log`. `npm run dev` remains a
foreground development stack; stop the ordinary local Core before starting it if port 4517 is
already occupied. Setting `CINBA_SERVER` for the TUI selects an explicitly managed remote Core and
does not start the local one.

### VPS terminal command

The deployed Linux release includes a small `cinba` command for the service user. Install it once
from the active release without editing `.bashrc`:

```sh
/home/cinba/.local/node/bin/node \
  /home/cinba/current/packages/deploy/src/install-user-launcher.ts
```

The installer creates `/home/cinba/.local/bin/cinba` as a managed symlink through `current`, so it
automatically follows later deployments. Start a new login shell, then verify and run it:

```sh
command -v cinba
readlink /home/cinba/.local/bin/cinba
cinba
```

For the `cinba` user, the command always uses `/home/cinba/.local/node/bin/node`, loads the TUI from
`/home/cinba/current`, and defaults the project to `/home/cinba/Cinba`. An optional first argument
selects another project directory.

## Architecture

```text
native launchers ──► core-manager ──► ensure one local server
                                         │
Web / TUI / Desktop                      │
        │                                │
        ▼                                │
   core-client                           │
        │ WebSocket                      │
        ▼                                │
      server ◄───────────────────────────┘
        │
        └──► agent ──► Pi process per active conversation
                 ▲              │
                 └── contract ◄─┘
                              └── extensions / permission gate

master ──► prod ──► deploy ──► releases/current ──► systemd service
```

| Package | Responsibility |
| --- | --- |
| `@cinba/contract` | Browser-safe protocol, ledger, commands, and shared labels |
| `@cinba/core-client` | Shared Core connection used by every client |
| `@cinba/core-manager` | Starts and inspects the one shared Core on the local computer |
| `@cinba/server` | HTTP, WebSocket, sessions, credentials, draining, and health |
| `@cinba/agent` | Pi process lifecycle, RPC transport, events, and stored sessions |
| `@cinba/extensions` | Pi extensions, including the mandatory permission gate |
| `@cinba/web` | React Web interface |
| `@cinba/tui` | Terminal interface built with `pi-tui` |
| `@cinba/desktop` | Electron host for the shared Web interface |
| `@cinba/deploy` | Safe release preparation, activation, verification, and rollback |

Runtime configuration and Pi data live outside the repository in `~/.cinba` and `~/.pi`. A release
switch changes program files without replacing conversations, configuration, credentials, or user
projects.

## Quality checks

```powershell
npm run check
```

This is the repository gate and runs formatting checks, linting, TypeScript checks, unit tests,
end-to-end tests, and the Web build.

Individual commands are also available:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:e2e
npm run build
```

## Documentation

The design history is intentionally kept in Chinese because it records not only decisions, but why
they were made:

- [Main design](docs/specs/2026-09-06-cinba-design.md)
- [VPS and Tailscale design](docs/specs/2026-09-12-phase3b2-vps-tailscale-design.md)
- [Implementation plans](docs/plans/)
- [Research and verification notes](docs/notes/)

## Roadmap

The current sequence is:

1. complete and verify the first VPS deployment through Tailscale and Caddy;
2. adapt the Web interface for phones;
3. consider a Core switcher only after two real Cores are in regular use;
4. continue UI and conversation-tree refinement.

## License

Cinba is available under the [MIT License](LICENSE).
