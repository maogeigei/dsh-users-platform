> **English (primary, this file)** ｜ **[中文文档](PLUGIN-PORTING.zh-CN.md)**

# Making an open-source plugin work on a multi-tenant platform

> For **DSH plugin authors** and **maintainers of self-hosted platforms**.
> It answers one question: **why do so many plugins run fine locally and break completely once hosted**, and **exactly what to change**.
> Everything is grounded in one real case, **`dsh-univer-office`** (a 41 MB online spreadsheet plugin) — it went the whole way through "static pre-check passes → completely unusable on the platform → two independent root causes located → ported → regression green".

---

## 0. The conclusion first

| Symptom | Root-cause class | Fix | Can platform configuration work around it? |
|---|---|---|---|
| The plugin UI opens but data/charts never load | The address handed to the browser is an **absolute URL** | Make it a **same-origin relative path** | ❌ No — the plugin must change |
| The plugin's internal service never starts / health check times out | Internal communication over **TCP loopback** | Switch to a **unix domain socket** or stdio | ❌ No (the isolation layer exists precisely for this) |
| The instance **crashes and restarts repeatedly** after installing the plugin | **Version incompatibility** with the platform's bundled `@deepseek-ai/*` | Align the dependency range / exported symbols | ❌ No |
| One plugin eats a sixth of the instance's memory | A **heavy dependency statically imported at the entry point** | Switch to `await import()` **lazy loading** | ❌ No |
| Tenants interfere with each other | A **self-created listening port** | Reuse the host's single entry point | ❌ No |

**The one-line criterion:**

> **Can every outward interaction of the plugin go through "the one entry point the platform already has"?**
> That is — **on the browser side, relative paths only; on the instance side, no dependency on a network service on local loopback.**

---

## 1. How a hosting platform differs from "running locally"

Every assumption a plugin developer makes locally is **false** on a hosting platform:

| Local assumption | The hosting platform's reality |
|---|---|
| "`127.0.0.1` is my machine" | `127.0.0.1` on the server side = **the server**; `127.0.0.1` in the browser = **the user's own computer** — two different places |
| "The web page and the data service are on one machine, connect freely" | The instance process uid is constrained by the **egress guard**; it may not even reach a child process it spawned itself (see §4.1) |
| "Pick any port; if it collides, pick another" | Multi-tenant **shared host**: ports are a shared resource, and port drift plus cross-tenant reachability are real risks |
| "HTTP is fine" | Users visit an **HTTPS domain**; an HTTP resource inside an HTTPS page is **hard-blocked** by the browser (mixed content) |
| "The process is mine, memory is free" | Each user instance has a **memory quota**; a single plugin can bring the whole instance down |
| "Installing a plugin is just a directory" | The platform **pre-checks, enables, isolates and rolls back** plugins; an incompatible one drags the instance down |

---

## 2. Six failure modes (self-check before you publish)

### H1 · Hard-coded loopback service address

```js
// ❌ the in-instance service address is hard-coded
const gateway = `http://127.0.0.1:${port}`
```

**Symptom**: the host process cannot reach the child process it spawned itself (the health check always times out).
**Why**: the hosting platform rejects **outbound connections** from the instance uid range to `127.0.0.0/8` (only outbound initiation is rejected; replies are unaffected — otherwise the instance would be entirely unusable).
**Severity**: 🟡 warning (if it is internal only, switch to a socket; if it also goes to the browser → upgrade to 🔴)

### H2 · An absolute URL in the client bundle 🔴 **blocking**

```js
// ❌ this URL gets put into an iframe src and makes **the user's browser** connect to it
viewerUrl = `${gateway}/?file=${fileKey}`
```

**Symptom**: the page frame renders, but the content stays blank / spins forever.
**Why**: once a URL is handed to the browser it is **guaranteed to fail**: cross-machine (`127.0.0.1` means the user's computer) plus mixed content being blocked.
**The key point**: **the platform has no remedy whatsoever** — not configuration, not a reverse proxy, and certainly not "just use the server IP" (see §4.2).
**Criterion**: scan the **client-side artefacts only**; a literal `http://` hit counts as "will be handed to the browser" → **reject the upload**.

### H3 · Creating your own network listener

Scan the arguments of `listen(` / `createServer`:
- listening on a unix socket / stdio → ✅ good
- listening on loopback TCP → 🟡 a human must confirm whether it is the single entry point (if it is, handle it as H1/H2)

### H4 · The browser address is assembled by the client

The server returns a **path** (relative) and the client assembles an absolute address — same failure.
**Criterion**: any address handed to the browser **must be produced by the host and be relative**.

### H5 · Incompatible with the platform's bundled packages → crash loop

A hosting platform **bundles** the DSH-related packages in a fixed location. When a plugin declares or imports them, two conditions must both hold:

| Criterion | Explanation |
|---|---|
| **A. Dependency range** (semver, **default semantics**, no `includePrerelease`) | The `@deepseek-ai/*` range the plugin declares must **accept** the platform's bundled version. Declaring `>=0.1.1-rc.1 <0.1.2` while the platform is `0.1.2-rc.1` ⇒ not satisfied ⇒ the package manager installs the plugin's own **older** copy → conflict with the platform package |
| **B. Exported symbols** (runtime truth) | When the plugin does `import { X } from '@deepseek-ai/Y'`, `X` must exist in the **actual runtime exports** of the platform package Y. Obtain them via `await import()` then `Object.keys()` — more reliable than parsing `.d.ts` |

**Why default semantics are mandatory**: the package manager's real install decision *is* default semantics. Passing `includePrerelease` **misjudges** these bugs as satisfied and misses them.
**The easiest one to miss**: a platform API call hidden inside a **transitive dependency** (not inside the tgz you built) — static scanning cannot see it, so you must install and then re-scan `node_modules`.

**Symptom**: once installed the instance reports `plugin tree failed to load` → **crash loop** (it dies on every start, and the platform's crash restart only cuts losses, it does not disable anything).

### H6 · Heavy dependencies statically imported at the entry point

| Plugin | `rss` increase after loading |
|---|---|
| A heavy spreadsheet plugin | **+65.1 MiB** |
| Its indirect dependency (an embedded database) | +7.8 MiB |
| Three in-house lightweight plugins | **0.0 MiB** |
| A browser-automation library (**entry imported only, browser never launched**) | **0.0 MiB** |

**Conclusion**: **cost is decided by *what* is installed, not *how many*** — one heavy plugin is worth infinitely many lightweight ones.
**What to do**: for heavyweights such as native bindings, engines and browsers, switch to `await import()` and load them only when actually used.

---

### H7 · The client half "hangs silently": `inject` is never satisfied 🔴 **no error, no log**

**Symptom**: the server side is perfectly healthy (tools callable, data genuinely written to disk), but **there is nothing in the browser** — no preview UI, no error in the console, no trace in the logs.

**Mechanism**: the client plugin's `package.json` lists some **UI package** under `dsh.client.inject`, but that package is **never delivered in that role's page** (for example because the platform's role patch disables it) ⇒ cordis's `inject waiting` **is never satisfied** ⇒ **the client fiber is suspended forever ⇒ `apply()` never runs**.

**Criterion (the general diagnostic technique)**: take the instance page → parse `__DSH_BOOT__` → compute the **set difference** between every `inject` line and **the set of client plugins actually delivered in the page**;
**a non-empty difference = that client fiber hangs forever**. An A/B comparison makes it obvious: the same plugin under different roles is missing exactly those "disabled packages".

**Fix**: **remove** from `dsh.client.inject` any package that is not guaranteed to exist in the target role.

> ⚠️ **Hard rule**: a third-party client plugin **must not put "official UI packages" into `dsh.client.inject`** unless that package is confirmed to always exist in the **target role** —
> the platform's role patch disables these: `dsh-client-ui-settings-models` / `-settings-plugins` / `-settings-plugin-inventory` / `-cordis` / `dsh-client-hmr` / `dsh-host-directory-picker-auto`.
> **A typical case**: a plugin listed `@deepseek-ai/dsh-client-runtime` — that package **does not exist at all** in the current dsh version ⇒ its browser half hangs silently in exactly the same way.

> 📌 **What users should expect**: such plugins **do not register `tool.*.toolview`** ⇒ **tool cards look no different**; the only three places where content shows up are the session **turn-end card**, the **dock** above the input box, and the full-screen review overlay.
> **Old turns are not re-rendered** — after a hard refresh you must **run a new turn** that contains the tool call.

## 3. Five porting rules (R-a to R-e)

> Satisfy these five and the plugin runs on any hosting platform that is "single entry point + multi-tenant + HTTPS".

| # | Rule | How | Why |
|---|---|---|---|
| **R-a** | **One outward entry point** | Everything the browser can reach hangs off the host's webServer, under a **same-origin relative path** (e.g. `/myplugin-api/**`) | Reuses the platform's reverse proxy ⇒ **zero new exposed surface** |
| **R-b** | **Internal communication over IPC** | Use a **unix domain socket** or **stdio**, **not TCP loopback** | Never touches the IP layer ⇒ the egress guard cannot see it; **no port conflicts** by construction |
| **R-c** | **No new listening ports** | Need more processes? Use a socket / stdio. If TCP is genuinely required, it **must** bind `127.0.0.1` with the port passed in via env | On a shared multi-tenant host, a port = cross-tenant risk plus drift |
| **R-d** | **Lazy-load heavy dependencies** | Native bindings, engines, browsers and large parsers move to `await import()` | Measured: +65 MiB down to 0 MiB (when unused) |
| **R-e** | **Every browser-bound address is relative** | The server returns paths only; the client never assembles an absolute address | Absolute addresses are guaranteed to fail on a hosting platform |

**Compatibility (H5) is a release gate of its own**: the `@deepseek-ai/*` dependency range must accept the platform version under **default semantics**, and every imported symbol must genuinely exist in the platform package.

---

## 4. Case study: porting `dsh-univer-office`

> 📦 **The artefacts for this case** → [`examples/dsh-univer-office/`](examples/dsh-univer-office/)
> (the porting patch + new modules + companion skill, with the upstream baseline and how to apply it)
> 🙏 The original plugin is open-sourced by **[dream-num](https://github.com/dream-num)** (**Apache-2.0**) — **thanks to the author**.

### 4.1 The **two independent obstacles** behind the symptom

The plugin **passed every static pre-check** (dependency range ✅, exported symbols ✅) yet was completely unusable on the platform. The cause was two **mutually independent** obstacles — **either one alone is enough to break it**:

| Obstacle | Mechanism | Measured evidence |
|---|---|---|
| **① Host → Gateway** | The gateway is `spawn`ed by the host and **inherits the same uid**; the platform's egress guard answers the instance uid range → `127.0.0.0/8` with `reject with tcp reset` ⇒ **the host cannot reach the gateway it started itself** | Creating a document always reported `bundled Gateway did not become ready within 10000ms` |
| **② Browser → Viewer** | The source **hard-codes** `gateway = http://127.0.0.1:${port}` and `viewerUrl = ${gateway}/?file=…`, and the client uses it as an **iframe src** ⇒ the browser goes looking for the Viewer on **the user's own computer** at `127.0.0.1` | `grep -o "viewerUrl: [^,]*" lib/index.js` |

**⇒ Even unblocking the loopback in ① would not help** (② blocks on the browser side). **The plugin has to change.**

### 4.2 Why "just use the server IP" does not work

It is the first idea most people have, and the wrongest:

1. The egress guard's block list **already contains the server's own IP** — switching to it is rejected just the same;
2. On a shared multi-tenant host, **binding a port leaks across tenants**;
3. An HTTP iframe inside an HTTPS page is **hard-blocked by the browser**.

**The right answer is not "a different address" but "a different path".**

### 4.3 The change list (a realistic scale reference)

**New modules**

| Module | Purpose |
|---|---|
| `shared/gateway-socket` | Parses `UNIVER_DSH_GATEWAY_SOCKET` (a path value or `auto`) and defines the `unix:<path>` endpoint identity |
| `shared/unix-http` | A minimal **HTTP over unix socket** client (`status` / `headers` / `text` / `json` / `arrayBuffer` / `signal`) — **zero new dependencies** |
| `shared/gateway-request` | The **unified transport entry point** `requestGateway(endpoint, path, init)`: picks socket or TCP automatically from the endpoint prefix |
| `host/webServer/viewer-proxy` | A **same-origin reverse proxy**: HTTP (streaming, stripping hop-by-hop headers) plus **WebSocket upgrade forwarding** |
| `shared/viewer-paths` | Browser-side path constants (kept independent of webServer to avoid a reverse dependency) |

**Changed files**: the gateway listener gains unix socket support (**TCP default behaviour unchanged**), the launcher passes the socket path to the child through env, endpoints are tagged by transport (`http://127.0.0.1:<port>` or `unix:<path>`), health checks and probes support sockets, client call sites all go through `requestGateway`, the webServer registers the viewer proxy and data-plane routes, and **`viewerUrl` becomes a relative path**.

### 4.4 Three key design decisions (all learned the hard way)

**① The socket is an *optional transport*, not a replacement for TCP**

Enabled by env (either set a path, or set `auto` to derive a process-level path under a private temporary directory); **leave it unset and upstream behaviour is preserved exactly**.
The payoff: **upstream-friendly — the default behaviour is unchanged, so it can be merged safely**; rolling back means simply **deleting that env**.

**② Only two proxy rules**

Because **all data-plane requests** of this plugin live under one prefix (WebSocket included):

```
/uf/**                  → forward to the gateway (HTTP + WS upgrade)
/<plugin>-api/viewer/** → forward to the gateway's / and /assets/** (page + static assets)
```

⚠️ **The critical point**: once the Viewer page has loaded it requests `/uf/*` **using absolute paths**, so the proxy **must take over `/uf/*`** — otherwise the page opens but the data never arrives (the classic "half-working" state).

**③ Two subtle platform-side pitfalls**

| Pitfall | Symptom | Fix |
|---|---|---|
| **Prefix matching has no "longest wins"** | A shorter `/myplugin-api` **swallows** `/myplugin-api/viewer/...`; registering it separately gets hijacked by a 404 | The viewer proxy must live **inside the existing router's dispatch**; only non-conflicting prefixes get registered separately |
| **WS routes register exact paths** | The plugin's WS paths contain **dynamic segments** (`/uf/<enc>[/worktrees/<id>]/…`) ⇒ they cannot be registered all at once | **Register lazily per file**: seed on file open, de-duplicate with a Map, dispose them together |

### 4.5 How to verify (without touching production)

1. **Dependencies and build**: install dependencies → build (incremental, ~5–16 s);
2. **Regression**: run the plugin's own integration smoke suite (this plugin has **18 items**: create / status / import / export / screenshot / print / assets / worktree lifecycle…) — **proving the change did not break the original functionality**;
3. **Socket check on a real host**: put the build output in an **isolated temporary directory** (point native dependencies at the existing installation with read-only symlinks); after starting, confirm `listening on unix:…sock`, that `GET /` returns **200** with the page marker present, and that the data routes are reachable (a 4xx means the route works and only the parameters are wrong); **also run a TCP control case**;
4. **Clean up the temporary artefacts**.

> ⚠️ **unix sockets cannot be verified on Windows** (`AF_UNIX` gives `EACCES` directly, reproducible with plain `node:net` as well) — this is a **platform limitation, not a code problem**. **It must be verified on Linux.**

### 4.6 Known limitations (recorded honestly)

- The plugin's **worker side still uses TCP** (internally it assembles a dozen or so URLs with the standard `fetch`; the surface to port is large and the feature is peripheral); **the main flow (exporting a spreadsheet) is unaffected**;
- The WS layer for the worktree scenario registers only **file-level** paths;
- This is a **fork**: upstream updates have to be merged (see §7).

### 4.7 Rollback

- **At the code level**: leave that env unset ⇒ back to the original TCP behaviour immediately;
- **At the platform level**: rolling the version in the candidate pool back to the upstream release retires the whole thing.

---

## 5. The other half the platform must provide

Porting the plugin is not enough — the platform must also leave the interfaces open, or the work is wasted:

| Platform capability | Requirement |
|---|---|
| **env pass-through** | Platform → instance → plugin child process, so configuration such as "the socket path" reaches the plugin (in this case: platform env → instance env → the plugin's gateway env) |
| **Same-origin reverse proxy** | Forward the plugin's path prefix to the in-instance service, **support WebSocket upgrade**, set `Host` / `X-Forwarded-*` correctly, and **not buffer** streaming responses |
| **Memory budgeting** | **Annotate the loading cost** of every plugin (measured `rss` increase) and do the **estimate and interception before enabling** (require confirmation beyond the per-instance cap) |
| **Compatibility pre-check** | On import, decide "dependency range + exported symbols"; when incompatible, **reject by default** and show the per-item evidence back to the admin |
| **Safe enable/disable** | After enabling, **probe**; on failure **roll back to a snapshot**; keep a per-plugin **isolation flag** (disable the incompatible plugin alone instead of the whole instance) |
| **The boundaries of the isolation model** | Egress guard (instances may not connect out to loopback / metadata endpoints), the `/etc` allowlist, read-only platform policy files — a plugin must not assume these do not exist |

---

## 6. Pre-release self-check

```
[ ] No absolute URL on the browser side (grep the client artefacts for literal `http://` / `https://`)
[ ] Every resource address handed to the browser is produced by the host and relative
[ ] Internal process-to-process communication uses a unix socket / stdio, not TCP loopback
[ ] No new listening ports (when genuinely needed, bind 127.0.0.1 with the port passed in via env)
[ ] Heavy dependencies (native bindings / engines / browsers) are lazily loaded via await import()
[ ] The @deepseek-ai/* dependency range accepts the platform's bundled version under "default semantics"
[ ] Every imported platform symbol has a runtime export in the platform package (including the transitive layer)
[ ] The measured load memory increase (annotate above 30 MiB / be careful above 60 MiB)
[ ] The bundled regression tests pass, with identical results before and after the change
[ ] There is a way to fall back to the original behaviour when the plugin-specific env is not set
```

---

## 7. A better path: offer the port upstream

A fork is a **long-term cost** (who maintains it, how upstream updates get merged). The better move is to offer the change upstream as an **issue plus a patch**.

**Framing matters a lot**: do not say "please support our platform". Say —

> **"Your architecture can be simpler and safer in containerised / hosted / multi-tenant environments: replacing loopback TCP with a unix socket plus same-origin relative paths removes the assumptions about IPs and ports."**

Framed that way it is a **pure technical win for upstream** (fewer assumptions, fewer ports, safer) — and they will be happy to take it even without a hosting use case of their own.

---

## Appendix · quick self-check commands

```sh
# 1) Any absolute URL in the client artefacts (H2, blocking)
grep -rInoE "https?://[A-Za-z0-9._:/-]+" lib/ dist/ | grep -v "://127\.0\.0\.1" || true
grep -rIn  "127\.0\.0\.1:[0-9]" lib/ dist/ || true

# 2) Any self-created listener (H3)
grep -rInE "\.listen\(|createServer\(" lib/ dist/ | head

# 3) Which platform packages are declared (H5 criterion A)
node -e "const p=require('./package.json');console.log(p.dependencies,p.peerDependencies)"

# 4) Load memory (H6 — measure inside an **isolated cgroup**, never on a production instance)
node --expose-gc -e "const m0=process.memoryUsage().rss;import('./lib/index.js').then(()=>{global.gc();console.log('rss +' + ((process.memoryUsage().rss-m0)/1048576).toFixed(1) + ' MiB')})"
```

---

**Related**: the feature list and deployment options are in [`README.md`](README.md).
