# Cinba

Cinba is a personal AI coding agent built on [pi.dev](https://pi.dev/). One Core owns the agent
state while Desktop, Web, and terminal clients connect through the same protocol.

Cinba is personal, experimental software. Release artifacts are intentionally unsigned. Windows
SmartScreen and macOS Gatekeeper may therefore require an explicit user decision before the first
launch.

## Install Cinba

Formal builds are distributed only through this repository's
[GitHub Releases](https://github.com/SounDoer/Cinba/releases). Each published release contains the
exact Windows, macOS, and Linux artifacts, `cinba-release.json`, `SHA256SUMS`, and bilingual
installation notes. If no release is listed yet, no formal Cinba build has been published.

### Windows Desktop

Download `Cinba-X.Y.Z-windows-x64.exe` from one published release and run it. Installation is for
the current user, requires no administrator privileges, and adds Cinba to the Start Menu and the
current user's command path.

### macOS Desktop

Download `Cinba-X.Y.Z-macos-arm64.dmg` on an Apple Silicon Mac, open it, and run the Cinba installer
inside. Cinba installs to `~/Applications/Cinba.app` for the current user.

If Gatekeeper blocks the unsigned application, first verify that the DMG came from the selected
GitHub Release, then run:

```sh
xattr -dr com.apple.quarantine "$HOME/Applications/Cinba.app"
```

### Linux Headless

Each published release supplies its own version-locked `install.sh` command in the release notes.
The script installs the self-contained Linux x64 artifact for the current non-root user. It does not
install Node.js, clone this repository, start the TUI, start Core, or create a background service.

For an offline installation, copy the Linux archive and `SHA256SUMS` from the same release, verify
the archive, extract it, and run the bundled `install.sh`.

## Use an installed release

The `cinba` command defaults to the TUI in the current directory:

```sh
cinba
cinba /path/to/project
cinba desktop
```

Desktop is available on Windows and macOS. The installed command also owns product lifecycle and
diagnostics:

```sh
cinba version
cinba doctor
cinba update
cinba core status
cinba core start
cinba core stop
cinba core mode background
cinba core mode on-demand
cinba uninstall
cinba uninstall --purge
```

Core starts on demand by default. Background mode is an explicit per-user choice and uses the
platform service manager. Core and Sync have independent modes even though both reuse the same
service-management foundation.

Desktop and TUI check for updates at a low frequency, download and verify a candidate in the
background, and ask before installation. An update waits while Core or Sync has work that cannot be
safely interrupted. `cinba update` performs an immediate explicit check.

Normal uninstall removes the program, release cache, launchers, and managed service registrations
while preserving user data. `--purge` requires confirmation and also removes Cinba data. It never
removes an independently owned Pi installation. Desktop offers the same two choices under the tray's
Uninstall menu, and an installed TUI offers them through `/uninstall`; both refuse while Core has
active work, hand removal to a separate helper, and quit before anything is deleted.

## Cinba and Cinba Dev

`Cinba` is an installed release. `Cinba Dev` is a local source checkout. They use separate native
data, state, cache, log, credentials, Pi, and session directories, so development cannot silently
modify a formal installation. They also use separate loopback ports: Cinba Core and Sync listen on
`127.0.0.1:4517` and `4518`, Cinba Dev Core and Sync on `4527` and `4528`.

To work on Cinba Dev, install Node.js 24, npm, and Git, then:

```sh
git clone https://github.com/SounDoer/Cinba.git
cd Cinba
npm install
npm run dev
```

Useful source commands:

```sh
npm start
npm run tui -- /path/to/project
npm run desktop
npm run sync:dev
npm run check
```

Source development exposes `cinba-dev`, never `cinba`. To link it from other working directories:

```sh
npm link
cinba-dev /path/to/project
```

Remove that development link with `npm unlink --global cinba`. Source launchers all go through
`scripts/launch.ts`; root `.cmd` files are double-click wrappers around the same development entry
points.

## Data and network boundaries

Program releases are immutable and replaceable. User data is stored outside release directories.
Runtime locks, process records, update candidates, logs, and caches are separate from durable
configuration, credentials, conversations, and Pi data. This separation lets installation,
updates, rollback, and normal uninstall operate without treating user data as program files.

Cinba binds its local services to loopback. Tailscale, Caddy, HTTPS, LAN exposure, public ingress,
DNS, and firewall policy are external infrastructure owned by the user; Cinba does not install or
configure them.

## Architecture

```text
Desktop / TUI / Web
        │
        ▼
   core-client
        │ WebSocket
        ▼
      server ──► agent ──► Pi process
        ▲           ▲
        │           └── extensions / permission gate
        └── core-manager / installed service framework

GitHub Release
        └── platform installer ──► stable launcher ──► immutable release ──► user data
```

| Package                  | Responsibility                                                   |
| ------------------------ | ---------------------------------------------------------------- |
| `@cinba/contract`        | Browser-safe protocol, ledger, commands, and shared labels       |
| `@cinba/core-client`     | Shared Core connection used by every client                      |
| `@cinba/core-manager`    | Starts, inspects, and safely stops one local Core                |
| `@cinba/server`          | HTTP, WebSocket, sessions, credentials, draining, and health     |
| `@cinba/agent`           | Pi process lifecycle, RPC transport, events, and stored sessions |
| `@cinba/extensions`      | Pi extensions, including the mandatory permission gate           |
| `@cinba/web`             | React Web interface                                              |
| `@cinba/tui`             | Terminal interface built with `pi-tui`                           |
| `@cinba/desktop`         | Electron client and local Core tray/menu-bar controller          |
| `@cinba/installer`       | Release contracts, installation, update, rollback, and services  |
| `@cinba/product-runtime` | Installed CLI, product identity, lifecycle, and diagnostics      |

## Release process

The root `package.json` version is the only product version. The manual **Prepare product release**
workflow locks one full commit from `master`, runs the repository gate, builds on native Windows,
macOS Apple Silicon, and Linux runners, generates artifact attestations and release metadata, and
creates a draft GitHub Release only after the complete platform set passes. A human reviews and
publishes the draft. Repository release immutability must be enabled before publication.

## Documentation

Design records are written in Chinese:

- [Product distribution design](docs/specs/2026-09-17-cinba-product-distribution-design.md)
- [Product distribution implementation plan](docs/plans/2026-09-17-cinba-product-distribution.md)
- [Cinba Sync product experience](docs/specs/2026-09-17-cinba-sync-product-experience.md)
- [Other specifications](docs/specs/)
- [Implementation plans](docs/plans/)
- [Research and verification notes](docs/notes/)

## License

Cinba is available under the [MIT License](LICENSE).
