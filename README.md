# Cinba

Cinba is a personal AI coding agent client built on [pi.dev](https://pi.dev/). It keeps one Core
service as the source of truth while Web and terminal clients connect to it through the same
protocol.

The project is also a learning exercise: its layers stay deliberately visible so the agent loop,
tool calls, permission decisions, sessions, credentials, and remote deployment can be understood
rather than hidden behind a framework.

## Current status

Cinba is personal, experimental software. The local Windows workflow and the private VPS workflow
are both usable today. The first real deployment through Tailscale, Caddy, and systemd has been
completed and verified from an iPhone and the VPS terminal.

Available now:

- Web and terminal interfaces backed by one Core;
- multiple conversations with switching, naming, deletion, and message editing;
- provider credential management and model switching;
- streamed text, reasoning, tool cards, token usage, and cost;
- an always-on permission gate for tool execution;
- Core identity display and automatic Web reconnection;
- a Windows system tray for local Core status and controls;
- development and production-style launchers;
- guarded `master` to `prod` promotion and rollback-capable VPS deployment logic;
- Tailscale-only VPS access through Caddy HTTPS, with no public Cinba port.

Cinba is not designed to be exposed directly to the public internet. The deployed remote shape keeps
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
directory. `cinba tui [project]` is the explicit form, while `cinba [project]` is a project-path
shortcut. A Web window, Desktop window, and any other TUI reuse that same Core.

The global npm shim and `cinba-tui.cmd` both enter the product command parser in
`scripts/cinba.ts`. It delegates TUI process orchestration to the importable `launchTui()` function
in `scripts/launch.ts`; `npm run tui` reaches that same function through the launcher's developer
command interface. The global command stays linked to this checkout, so code updates take effect
without relinking. Remove it with `npm unlink --global cinba`. The Web launcher is named
`cinba-web.cmd`, so the global `cinba` command remains unambiguous in both PowerShell and `cmd.exe`.

The local Core log is appended to `%USERPROFILE%\.cinba\core.log`. `npm run dev` remains a
foreground development stack; stop the ordinary local Core before starting it if port 4517 is
already occupied. Setting `CINBA_SERVER` for the TUI selects an explicitly managed remote Core and
does not start the local one.

The same global command exposes the local Core lifecycle without opening a client:

```powershell
cinba core status
cinba core start
cinba core stop
```

`status` reports whether the Core is stopped, running, or draining, plus its managed PID, lifecycle,
connected client count, and stop safety when available. `stop` uses the Core's protected local
control channel and existing drain behavior; it never kills a PID directly. A Core started outside
the manager, such as the foreground development Core, is reported as `external` and is not stopped
by this command.

On Windows, the same manager is available from a system tray controller:

```powershell
cinba tray
```

The command returns after starting one background tray instance. It does not start the Core until
you choose `Start Core` or `Open Cinba`. The tray reports stopped, running, draining, and external
Core states; offers graceful start and stop controls; and can open the local Core log. Closing the
Desktop window releases its Core connection while leaving the tray available. `Quit Tray` exits
only the controller, so the Core keeps its existing safe idle-shutdown behavior.

For command guidance and read-only environment diagnosis:

```powershell
cinba help
cinba doctor
cinba doctor C:\path\to\project
```

`doctor` checks the Node.js runtime, linked checkout, project directory, and effective Core. A
stopped local Core is informational because clients start it on demand. A missing project,
unsupported runtime, incomplete checkout, or unreachable Core selected through `CINBA_SERVER`
produces a failed result and a non-zero exit code; the command never attempts a repair.

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
in the form `cinba /path/to/project` selects another project directory. Product subcommands such as
`cinba help` and `cinba doctor` go through the same entry.

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
| `@cinba/core-manager` | Starts, inspects, and safely stops the shared Core on the local computer |
| `@cinba/server` | HTTP, WebSocket, sessions, credentials, draining, and health |
| `@cinba/agent` | Pi process lifecycle, RPC transport, events, and stored sessions |
| `@cinba/extensions` | Pi extensions, including the mandatory permission gate |
| `@cinba/web` | React Web interface |
| `@cinba/tui` | Terminal interface built with `pi-tui` |
| `@cinba/desktop` | Electron host and Windows tray controller for the shared Web interface |
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

1. ~~complete and verify the first VPS deployment through Tailscale and Caddy~~ — completed;
2. adapt the Web interface for phones — next;
3. consider a Core switcher only after switching between two real Cores becomes a recurring need;
4. continue UI and conversation-tree refinement.

## License

Cinba is available under the [MIT License](LICENSE).
