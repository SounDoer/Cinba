# AGENTS.md — Cinba

Cinba is a personal agent-development project built on [pi.dev](https://pi.dev/): a Node 24 +
TypeScript monorepo, one core server serving web, TUI and desktop clients.

This file records only what the code cannot reveal. Add an entry only when all three hold: the code
does not show it, automation cannot reliably catch it, and getting it wrong is expensive.

**When the docs and the code disagree, the code on `master` wins.**

## Language

**Code is English.** Everything that enters the repository as code — commit messages, branch names,
PR titles and descriptions, comments, test descriptions, identifiers, and user-facing product text
(buttons, hints, status lines, reasons sent to the model) — is written in English.

**`docs/` is Chinese.** Specs, plans and notes are thinking records written for a human reader;
Chinese carries the nuance better and stays easier to re-read later.

**Conversation is Chinese.** Discussion, explanations and status reports default to Chinese.
Technical terms, API names, commands and error strings stay in their original English.

**Explain concretely.** The user is treating this project as a learning case for AI frameworks and
software development. Favour plain, concrete explanations over jargon when discussing a design or
diagnosing a problem.

**Sources.** Prefer <https://pi.dev/docs/latest> and <https://pi.dev/packages> when researching a
design or a bug.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run check` | **The merge gate**: format + lint + typecheck + test + e2e + build. |
| `npm start` | Run the built web application — the real usage shape. |
| `npm run dev` | Vite dev server plus the core server. |
| `npm run tui` | Run the TUI client. |
| `npm test` | Unit tests, `node --test`, single run. |
| `npm run test:e2e` | End-to-end tests against real processes; slower than the unit run. |

`scripts/launch.ts` owns every launcher; the Dev Core is fixed to 4527, Dev Sync to 4528 and the web
dev server to 5173. The installed Cinba keeps 4517 (Core) and 4518 (Sync), so both can run at once.
Start processes through it, not around it. The `*.cmd` files at the root are double-click wrappers
over the same scripts.

## Project structure

- `packages/contract/` — the protocol and types between server and clients. Changing it changes
  every client; confirm all three followed.
- `packages/agent/` — the layer that talks to the pi process.
- `packages/core-client/` — the shared connection wrapper. Web, TUI and desktop all go through it.
- `packages/extensions/` — extensions such as the permission gate.
- `docs/specs/`, `docs/plans/`, `docs/notes/` — designs, implementation plans, research records,
  each filename date-prefixed. Look for an existing spec before starting work.

## Git workflow

**Commits follow [Conventional Commits](https://www.conventionalcommits.org/) with a scope:
`fix(agent): ...`.** The scope is the workspace package name without the `@cinba/` prefix.

**Work lands on `master` by default** and history stays linear. If a change needs isolating, say so
and let the user decide — do not branch silently.

## Boundaries

**Never**

- Reach the core server directly, bypassing `packages/core-client/`.
- Push without running `npm run check`.

**Ask first**

- Moving work off `master`.
- Adding a runtime dependency.

**Always**

- Run `npm run check` before merging.
- After changing `packages/contract/`, confirm web, TUI and desktop are all in sync.

## Known pitfalls

Nothing recorded yet. Add an entry here the first time a trap costs real time — see the admission
test at the top of this file.
