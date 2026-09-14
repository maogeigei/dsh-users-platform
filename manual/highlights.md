> **English (primary, this file)** ｜ **[中文文档](highlights.zh-CN.md)**

[← Back to README](../README.md)

# Highlights in detail

The condensed overview is in [README → Highlights](../README.md#highlights).

## 1. Process-level isolation

- **One OS account per user** — every user gets a deterministic uid; the instance starts de-privileged under that uid. The isolation boundary is the **kernel**, not a file-permission convention.
- **Port guard** — instances bind a dynamic loopback port only; the platform blocks direct connections from other same-host accounts by uid (**refuses to start** where the host cannot support it — no silent downgrade).
- **Egress guard** — cloud metadata endpoints are blocked, instances are prevented from reaching the host itself, and new outbound connections are observed.
- **Browser trust fence** — the reverse proxy scrubs `Origin` / `Referer` / `X-Forwarded-For` and rewrites `Host` to loopback.
- **Environment allowlist** — an instance's env is rebuilt from an allowlist before the user's own values are injected; platform secrets never enter a user process.
- **Path fence** — lexical containment checks plus per-segment rejection of symlink components; you cannot leave your own root.
- **Tiered upload scanning** — a P0 hit is a hard `400`; P1 hits (dynamic execution / outbound calls / sensitive env / hidden files) are recorded for admin review.
- **Isolation in layers** — soft → OS-account hard isolation → port guard, each independently switchable.

## 2. Self-healing and state recovery

- **Crash circuit-breaker** — exponential backoff with a cooldown cap (from 10 minutes up to 6 hours); a bad instance is never restarted forever, and requests during cooldown get `503 instance_circuit_open`.
- **Repair on demand** — the guardian instance is spawned once, only when the main instance crashes, to repair the profile ⇒ in steady state each active user runs exactly one process.
- **Seamless recovery after reaping** — navigation goes through a transition page, XHR waits for readiness before forwarding, and **401 is replayed transparently**; returning to the page wakes the instance and re-establishes the connection.
- **Session-expiry self-healing** — a self-healing script injected into instance pages (25-second heartbeat plus a stall check; recovery only after two consecutive failures, so no false positives).
- **Plugin-load failure self-healing** — a "crashes on start" caused by an incompatible plugin is detected and isolated instead of restarting forever.
- **Concurrency convergence** — one active session (last login wins) plus idle reaping (resident cap + TTL).

## 3. Governed plugin and skill management

- **Pre-check on import** — dependency range and exported symbols; incompatible plugins are rejected by default, with the per-item evidence shown back.
- **"Compatible ≠ usable"** — delivering an **absolute URL** to the browser is classed as **blocking** (it always fails behind a hosting platform, and the platform cannot compensate). See the [plugin porting guide](../PLUGIN-PORTING.md).
- **Enabling in three steps** — probe → roll back to a snapshot on failure → per-plugin isolation flag: only the incompatible plugin is disabled, never the whole instance.
- **Memory estimation** — estimated badges and status bars from measured load cost; exceeding the per-instance cap is blocked and requires confirmation, because cost depends on *what* is installed.
- **Two skill layers** — shared (bundled with the platform, read-only for users) plus personal; zip uploads are replaced atomically in two phases, same-name conflicts require confirmation, and skills take effect without restarting the instance.
- **One-click official catalogue** — roughly 3,400 entries, with Chinese descriptions back-filled.

## 4. Models and the access surface

- **The official model page cannot work here, so the platform builds its own** — the official "Settings → Models" page requires a host-settings mirror, but the platform is "a browser reaching a remote server over a domain" ⇒ all three of its `isLoopback` checks fail and persistence degrades to memory, so the page cannot read the provider catalogue. The platform instead **writes files itself**: enabled entries from the credential vault are written straight into the instance's `$DSH_HOME/.credentials.yaml` and `settings.yaml`.
- **Only touch what we wrote** — the platform tracks a `managed` manifest: key entries and provider sections placed by the user are **never overwritten and never deleted**; a delete removes only the platform's own line or the span between its own markers.
- **Backed by the official provider catalogue** — it reads the **same** `pi-ai` package the instance uses (same data source ⇒ no drift), lists the providers it ships (currently 39, including `kimi-coding` / `moonshotai-cn` / `minimax-cn` / `zai` / `xiaomi` / `ant-ling`), and puts the "directly reachable from mainland China" group first; picking a provider means **filling in one API key** — endpoint, protocol and model list all come from the catalogue.
- **Shared and personal coexist** — an admin can enable one shared key so users start with zero configuration, while users can still add their own entries and enable them individually. When a user brings their own key the platform **does not inject the shared env**, otherwise env precedence would silently override the user's key.
- **Out-of-scope administration does not pollute existing boundaries** — service and file APIs always mean "address only your own resources"; when an admin manages someone else, a **separate `/api/admin/users/:id/...` group, entirely behind `requireAdmin`**, is used instead of stuffing `if (admin)` into the original routes.

## 5. Testable and regressable

- **Key decisions are pure functions** — crash policy, path fence and patch rendering depend on neither processes nor the network: **unit-testable without starting an instance and without touching production**, so changes can be regressed immediately.
- **Two test layers** — unit tests cover the data layer, the path fence and crash policy; on top of that there is a **runtime check of the injection scripts** (template evaluation plus `node --check`) and **9 end-to-end `smoke:*` suites** (regress them right after touching the proxy or the routes).

## 6. Deployment and operations

- **One command covers the whole flow** — environment pre-check → dependencies and build → DSH CLI → environment file → data root → first admin → reverse proxy → service → health check.
- **Idempotent and rehearsable** — re-running only fills in what is missing; `--dry-run` **prints without writing anything** and never emits "done"-style messages.
- **Admin first, service second** — the order is fixed (starting the service first would hold the database lock), avoiding the classic "deployment finished but login fails".
- **Self-adapting reverse proxy** — detects `/etc/nginx/conf.d` and panel (BT-Panel) vhost directories; reload tries systemd, then init scripts, then `nginx -s`, and **never touches existing sites**.
- **Register → approve → log in** — self-registration lands as `pending` and only becomes usable after admin approval.
- **One host per user** — in subdomain mode session cookies are naturally isolated per user (several users on one host would evict each other's sessions).
