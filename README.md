# dsh-users-platform

**DSH Users Platform** · **[中文文档](README.zh-CN.md)**

Securely **host** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) on the public internet: users self-register, an admin approves them, and each one gets a **dedicated instance** plus a private file root.

[![Node](https://img.shields.io/badge/node-%5E22.19%20%7C%20%3E%3D24-339933.svg)](https://nodejs.org/)
[![Version](https://img.shields.io/badge/version-v1.1.0-informational.svg)](#version-history)
[![DeepSeek Harness](https://img.shields.io/badge/built%20on-DeepSeek%20Harness-4D6BFE.svg)](https://github.com/deepseek-ai/deepseek-harness)
[![AI-generated](https://img.shields.io/badge/code%20%26%20docs-AI--generated-8A2BE2.svg)](manual/project.md#ai-generation)
[![Built with](https://img.shields.io/badge/DeepSeek%20V4%20%2F%20V4.1%20flash-2F6FED.svg)](manual/project.md#ai-generation)

The interesting part is **not** "multi-tenancy" itself, but the **three hard problems DSH exposes once it is hosted**:

1. **Process-level isolation** — one OS account and one instance per user, plus a port guard and an egress guard.
2. **Self-healing** — crashes, reaped instances and expired sessions all recover automatically, invisibly to the user.
3. **Governed plugins & skills** — pre-checked on import; enabling is reversible, isolatable and memory-capped.

**All code and documentation in this repository are AI-generated** (DeepSeek **V4 / V4.1 flash**) — see [AI generation](manual/project.md#ai-generation).

## Documentation map

This page keeps only the essentials. Details live in the documents below.

| Document | Contents |
|---|---|
| **[manual/highlights.md](manual/highlights.md)** | The six design themes in full (isolation · self-healing · plugin governance · models · testability · operations) |
| **[manual/architecture.md](manual/architecture.md)** | The base, request path, self-healing path, deployment shape, repository layout |
| **[manual/installation.md](manual/installation.md)** | Prerequisites, DNS and certificates, both deployment options, the `nip.io` rehearsal, manual dev setup, **everything about domains** |
| **[manual/configuration.md](manual/configuration.md)** | Every environment variable, defaults and gotchas |
| **[manual/security.md](manual/security.md)** | The security model, surface by surface |
| **[manual/api.md](manual/api.md)** | Control-plane API groups and permissions |
| **[manual/faq.md](manual/faq.md)** | The six problems people actually hit |
| **[manual/project.md](manual/project.md)** | Development, contributing, versions, AI generation |
| **[PLUGIN-PORTING.md](PLUGIN-PORTING.md)** | Making a plugin work on a multi-tenant platform — six failure modes, five rules, a full case study |
| **[examples/dsh-univer-office/](examples/dsh-univer-office/)** | That case study's porting patch, new modules and companion skill |
| **[install.md](install.md)** | Step-by-step installation instructions written for an AI agent |
| **[AGENTS.md](AGENTS.md)** | Rules for AI agents changing this codebase |

Every document has a Chinese counterpart (`*.zh-CN.md`).

## Highlights

The six themes, one line each:

| # | Theme | In one line |
|---|---|---|
| 1 | **Process-level isolation** | One deterministic uid and one instance per user, with a port guard and an egress guard — a kernel boundary, not a file-permission convention |
| 2 | **Self-healing** | Crash circuit-breaker, repair-on-demand guardian, and seamless recovery after reaping or session expiry |
| 3 | **Governed plugins & skills** | Pre-checked on import, enabled with probe + snapshot rollback + per-plugin isolation, and memory-estimated before enabling |
| 4 | **Models & access surface** | The platform writes credentials itself (the official model page cannot work here) and reads the instance's own provider catalogue; access by sub-path, subdomain or custom domain |
| 5 | **Testable & regressable** | Every key decision is a pure function, so it is unit-testable without an instance; plus 9 end-to-end smoke suites |
| 6 | **Deploy & operate** | One command, idempotent and rehearsable, with a self-adapting nginx reverse proxy |

👉 **Full detail: [manual/highlights.md](manual/highlights.md)**

## Architecture

<img src="diagrams/architecture.svg" width="100%" alt="Architecture: browser → nginx → control plane → per-user instances → data plane; cross-cutting: egress guard / port guard / self-healing / idle reaping">

The base is [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`), which is a **single-user, local** product by default. This project **neither modifies nor embeds** its code — it wraps a hosting platform around it and spawns one `dsh` child process per user.

**Request path**: browser → nginx (TLS) → control plane (auth / approval / admin / web desktop) → routed by `Host` or `/u/<userId>/dsh/*` → the user instance (loopback only).
**Self-healing**: a crash → spawn a guardian once to repair the profile → restart; repeated crashes back off and trip a circuit-breaker.

👉 **Full detail: [manual/architecture.md](manual/architecture.md)**

## Features

> One table plus a UI screenshot per module — **all 9 runtime screenshots in this repository live in this section**.
> Mechanism and trade-offs: see [Highlights](manual/highlights.md).

The administrative surface is grouped under "System management" in the settings panel:

<img src="screenshots/settings-admin.png" width="760" alt="System management: instances / models / users / skills / plugins / runtime">

### Accounts and portal

| Feature | Description |
|---|---|
| Registration and approval | The first administrator is created by `bootstrap-admin`; new users must be approved before they can log in |
| User management | Approve / disable / delete (cascading cleanup of sessions, instances and directories); admins can jump straight to a user's DSH session |
| Sessions and login | Opaque random tokens (only a SHA-256 hash is stored); one active session plus local idle reaping |
| Web desktop | Browse / create / upload / download files; start DSH per folder; double path fencing |

<img src="screenshots/admin-users.png" width="720" alt="User management: approve / disable / delete">

### Instances and runtime

| Feature | Description |
|---|---|
| Per-user isolation | A dedicated DSH instance: soft → OS-account hard isolation → port guard |
| Crash self-healing | Crash detection → repair via an on-demand guardian instance → automatic restart, with backoff, circuit-breaking and observability |
| Recovery after reaping | Returning to the page wakes it and re-establishes the connection; navigation goes through a transition page, XHR waits for readiness, 401 is replayed transparently |
| Session-expiry self-healing | A self-healing script injected into the instance HTML — no manual refresh |
| Shared runtime | A portable Python 3.12 plus static jq / ripgrep / ffmpeg; version baseline frozen and drift is inspected |
| Egress guard | Blocks cloud metadata endpoints, prevents instances from reaching the host itself, and observes new outbound connections |
| Memory governance | A tunable V8 heap limit per instance, sampling alerts and a breakdown probe |

An instance that was reaped, opened again, shows a **self-recovering** transition page rather than an error:

<img src="screenshots/instance-wakeup.png" width="600" alt="Workspace hibernated, waking up…">

The shared runtime (`/usr` is mounted read-only inside an instance, so what is installed is plain to see):

<img src="screenshots/admin-runtime.png" width="780" alt="Runtime: versions, sources and the version baseline for Python / Node / jq / ripgrep / ffmpeg">

### Plugins and skills

| Feature | Description |
|---|---|
| Candidate pool | Admins import (official-catalogue allowlist / tgz upload); users enable and disable per instance themselves |
| Compatibility pre-check | Dependency range plus exported symbols; incompatible plugins are rejected by default with the evidence shown |
| Safe enable/disable | Probe + snapshot rollback + a per-plugin isolation flag, so an incompatible plugin never drags the instance into a crash loop |
| Memory estimation | Estimated badges and status bars; exceeding the per-instance cap is blocked and requires confirmation |
| Provider coordination | After enable/disable, dsh-web's search provider is recomputed from the current bundles, avoiding multi-provider conflicts |
| Skill management | Shared plus personal skills: upload / list / enable / disable; two-phase zip replacement with symlink-traversal and zip-bomb protection |

Plugin management (the official recommended catalogue, re-fetchable in full):

<img src="screenshots/admin-plugin-catalog.png" width="780" alt="Plugin management: official recommended catalogue / category / import method / download count">

Batch memory usage and **per-plugin** estimates are shown in one panel, and exceeding the per-instance cap is blocked:

<img src="screenshots/settings-plugins.png" width="700" alt="Feature management: instance memory quota and per-plugin estimated memory">

Skill management (shared skills are read-only available to every user):

<img src="screenshots/admin-skills.png" width="720" alt="Skill management: shared skill upload / replace / delete">

### Models and credentials

| Feature | Description |
|---|---|
| Model entries | Built-in DeepSeek + the official provider catalogue + custom OpenAI-compatible gateways; each entry can be enabled / disabled / switched individually |
| Official provider catalogue | Reads the same `pi-ai` package the instance uses (currently 39 providers); picking one only needs an API key |
| How it lands | The platform writes enabled entries into the instance's `.credentials.yaml` and `settings.yaml`, touching only entries it wrote itself |
| Shared model | An admin can enable a shared key so users start without their own |
| Key security | AES-256-GCM encryption at rest; the shared platform env is not injected when the user brings their own key; switching restarts the instance to take effect |

The platform-wide shared model and the user's own entries are managed in **the same panel**, each independently switchable:

<img src="screenshots/settings-model.png" width="700" alt="Model settings: platform shared model / providers I added / new model entry">

### Access shapes and operations

| Feature | Description |
|---|---|
| Multiple access shapes | Sub-path `/u/<userId>/dsh/` ｜ per-user subdomain `<username>.<main-domain>` (HTTP + WebSocket) ｜ custom domains |
| Storage and cleanup | Per-user storage accounting; session retention, workspace cleanup and trash cleanup |
| Backup | One-click platform backup (a consistent SQLite snapshot plus configuration and artifacts) |
| Audit | Registration / login / approval / key changes / plugin delivery and more are written to `audit_log` |
| DSH chat | The complete chat interface users ultimately get (conversation + tool calls + plugin skills) |

<img src="screenshots/dsh-chat.png" width="780" alt="DSH chat interface: conversation + tool calls + results">

## Installation

**Requirements**: Linux (Debian/Ubuntu or RHEL family) + systemd + **root**, Node.js **^22.19 or ≥24**, and — for the full feature set — **a domain with a wildcard certificate**.

With a domain (recommended):

```sh
git clone https://github.com/maogeigei/dsh-users-platform.git
cd dsh-users-platform
sudo CF_API_TOKEN=xxx bash install.sh --domain dsh.example.com --email you@example.com
```

Without a domain (smoke-test the wiring only; the chat interface will not open):

```sh
sudo bash install.sh
```

Verify:

```sh
systemctl is-active dsh-users-platform                    # expect: active
curl -I http://dsh.example.com/                           # expect: 200 (or 301 to https)
curl -I https://test.dsh.example.com/                     # expect: 401 (not logged in)
```

Then log in to the admin console, approve your first user, and have them start DSH from the web desktop.

> 🤖 **Want an AI agent to install it?** Hand it [install.md](install.md) — step-by-step instructions with a check for every step and explicit "stop here" criteria.

👉 **Full detail: [manual/installation.md](manual/installation.md)** (DNS records, certificate issuance, both options compared, the `nip.io` rehearsal, manual dev setup, and everything about domains) · **Environment variables: [manual/configuration.md](manual/configuration.md)**

## Plugin porting

A hosting platform makes **completely different** assumptions from "running locally": `127.0.0.1` on the server side is the server, while `127.0.0.1` in the browser is **the user's own computer**. Plenty of plugins work fine locally and break completely once hosted — and the platform cannot compensate.

The six failure modes, one line each:

| Mode | Symptom | Fix |
|---|---|---|
| **Absolute URL handed to the browser** | The UI frame renders but the content stays blank — **blocking** | Make it a same-origin relative path |
| **Internal communication over TCP loopback** | The plugin's own service never starts | Use a unix domain socket or stdio |
| **Creating its own network listener** | Tenants interfere with each other | Reuse the host's single entry point |
| **Client assembles an absolute address** | Same as the first mode | The host must produce relative paths |
| **Version incompatibility with bundled packages** | The instance crash-loops | Align the dependency range and exported symbols |
| **Heavy dependency statically imported** | One plugin eats a sixth of the instance's memory | Lazy-load with `await import()` |

There is a quieter seventh one: a client plugin whose `inject` lists a UI package that is never delivered in that role **hangs forever, with no error and no log**.

👉 **Full guide with the five porting rules, the complete case study and a pre-release checklist: [PLUGIN-PORTING.md](PLUGIN-PORTING.md)**
📦 **Worked example: [examples/dsh-univer-office/](examples/dsh-univer-office/)** — the porting patch, new modules and companion skill, with the upstream baseline and how to apply it.

## Version history

### v1.1.0 — 2026-09-14 · feature

- **Model settings** — the model dialog mirrors the official interaction, and the recommended plugin catalogue is filtered by the dsh version actually installed.
- **Instance memory** — the per-instance budget is now a single rule (base 448 MiB → max 1024 MiB) and is decoupled from which plugins are enabled, so toggling a plugin no longer changes the quota it reports.
- **Faster page loads** — the browser no longer re-downloads the whole plugin script bundle (about 11 MB) on every page view: the merged `/plugins/` script table now carries an `ETag` and answers `304`, and the HTML shell is served `no-cache` so a stale shell can no longer leave the page stuck at "Failed to load plugins".
- **Proxy hardening** — stale `dsh-auth` cookies are cleared on rewrite, fixing a `431` that surfaced as "Failed to load plugins".
- **Single-machine only** — an unsupported `deployMode` now **fails loudly** instead of silently falling back to the single-machine backend.

### v1.0.0 — 2026-09-13 · first public release

- First public snapshot: one-shot single-machine deployment, per-user process isolation, crash self-healing, and governed plugin and skill management.

## Credits

- **DeepSeek Harness** — [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (**MIT**). This project neither modifies nor embeds DSH; it invokes the locally installed `dsh` as a child process. **Thanks to the DeepSeek team for open-sourcing it.**
- **`dsh-univer-office`** — [dream-num/dsh-univer-office](https://github.com/dream-num/dsh-univer-office) (**Apache-2.0**), by **[dream-num](https://github.com/dream-num)**. It is the real-world case study behind the plugin porting guide. **Thanks to the author and the Univer community** — being able to move a 41 MB online spreadsheet plugin into a hosted environment at all depends on someone having built it first.
- The porting patch and new modules under [examples/dsh-univer-office/](examples/dsh-univer-office/) are offered under **Apache-2.0** as well, so they stay consistent with upstream and are easy to merge back.

## License

Copyright (C) 2026 maogeigei

Licensed under the **GNU Affero General Public License v3.0** — see [LICENSE](LICENSE) for the full text.

In short: you may use, modify and distribute this software freely; **if you modify it and offer it to others as a network service, you must provide those users with your modified source code** (AGPL-3.0 §13).
