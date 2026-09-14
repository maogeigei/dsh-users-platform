> **English (primary, this file)** ｜ **[中文文档](AGENTS.zh-CN.md)**

# AGENTS.md

Instructions for **AI agents working inside this repository**. Human readers should start with [README.md](README.md).

## What this project is

It turns the "single-user, local" [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) into a **multi-user service that can be hosted on the public internet**:
one dedicated `dsh` child process per user, wrapped in a control plane (accounts and approval, routing and reverse proxying, isolation and guards, unified plugin and skill management, crash self-healing).

It **neither modifies nor embeds** dsh's code — the locally installed `dsh` is only ever invoked as a child process.

> **Just want to install and use it? Do not read this file** — follow [install.md](install.md). This file is for agents **changing the code**.

## Common commands

| Purpose | Command |
|---|---|
| Install dependencies | `npm ci` |
| Build (`src/` → `lib/`) | `npm run build` |
| Type check (no output) | `npm run typecheck` |
| Unit tests + injection-script check | `npm test` |
| **Full verification (run before committing)** | `npm run verify` |
| End-to-end smoke | `npm run smoke` |
| Start the control plane (development) | `node lib/cli.js --port 3080 --db ./dev.local.db` |

## Ground rules for changes

1. **Change `src/` and `web/` only; never `lib/`** — `lib/` is the output of `npm run build` and your edits will be overwritten.
2. **`npm run verify` must pass afterwards** (it includes `npm run build`, the unit tests and five static verification scripts). Running only `typecheck` is not enough.
3. **Key decisions are written as pure functions** (crash policy, path fence, patch rendering, install-path resolution…) — they depend on neither processes nor the network,
   ⇒ when changing such logic **add assertions to `test/` or `scripts/verify-*.mjs` at the same time** instead of only changing the implementation. For this kind of code the regression net is the only safety belt.
4. **If you touch the injection scripts (`assets/inject/`)** run `node scripts/verify-inject.cjs lib/supervisor/proxy.js` (already included in `npm test`).
5. **Comments explain "why", not "what"**: the comments in this repository are mostly "the pitfall we hit + the criterion + the numbers"; when you change behaviour, update the comment with it and do not leave stale explanations behind.

## Do not touch (security boundaries)

- **Never commit any secret**: `<dataRoot>/secret.key`, a user's `$DSH_HOME/.credentials.yaml` and `/etc/dsh-users-platform.env` all stay out of version control.
- **Do not reorder the steps in `install.sh`**: the administrator must be **created first and the service started second** (reversed, they collide on the SQLite lock, which presents as "installed but cannot log in").
- **Do not put platform secrets into an instance's env**: the instance env is rebuilt from an allowlist and then the user's own values are injected. This is an isolation boundary, not an optimisation opportunity.
- **Never let a new failure path degrade silently**: when a resource cannot be located, **leave an observable trace** (a warning or a diagnostics field), otherwise it turns into "the feature seems not to exist".
  See `catalogDiagnostics()` in `src/web/model-catalog.ts`.

## Directory cheat sheet

| Path | Contents |
|---|---|
| `src/web/` | Control plane: Fastify routes (`routes/`), auth and sessions, desktop, file service, plugin and skill delivery, model settings |
| `src/supervisor/` | Process orchestration: spawn / crash policy / guardian-instance takeover / heartbeat and idle reaping / nginx generation / reverse proxy and port guard |
| `src/fs/` | Per-user file roots, the path fence and trash |
| `src/db/` | Data layer: both SQLite and Postgres backends, migration ledger, prepared-statement memoisation |
| `web/` | Frontend pages (login / register / admin console / wake page) |
| `assets/inject/` | Runtime scripts injected into instance pages (self-healing, recovery, patch) |
| `scripts/` | Operations scripts plus the `verify-*.mjs` static checks (part of `npm run verify`) |
| `test/` | Unit tests (mostly pure functions) |

## Self-check before handing work over

- [ ] `npm run verify` is green
- [ ] New or changed behaviour has matching assertions (unit tests or `scripts/verify-*.mjs`)
- [ ] No secrets, internal document numbers or intranet addresses ended up in code or comments
- [ ] Comments match the actual behaviour (changed the behaviour ⇒ changed the comment)
