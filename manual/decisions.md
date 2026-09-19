> **English (primary, this file)** ｜ **[中文文档](decisions.zh-CN.md)**

[← Back to README](../README.md)

# How decisions get made

This repository is built by a human and an AI working under a fixed division of labour: **the human plans and makes the key calls; the AI implements**. This page records the decisions that shaped the project, the mechanics that keep long-running work manageable, the documents the development process produced, and the line between what the AI decides alone and what it must bring back.

## Decision log

| Decision | Why | Outcome |
|---|---|---|
| **Separate planning from execution** | Execution sessions running long tasks had no room left for re-planning; planning and execution sharing one context crowd each other out | Planning sessions produce hand-off documents only; execution sessions run them without reading the planning context |
| **Write the boundary down** | The same class of technical question kept being escalated | The AI decides inside the boundary and escalates only outside it |
| **Concurrency protocol for shared documents** | Two sessions wrote the same index file within minutes of each other | Single-writer ownership, exact-replacement edits, commit after every change |
| **Locks at task level, not file level** | File-level locking did not stop two sessions working on the same task | Locks are per task, held for the whole task, released in reverse order |
| **Context-budget discipline** | One batch of work pushed session context to 270K tokens — and every later turn had to carry it | Prefer reference documents over transcripts, scripts over repeated interactive calls, and start a fresh session past a threshold |
| **Structure knowledge instead of accumulating history** | Long conversations fragment knowledge; rules agreed earlier get buried under later content | A short always-loaded core plus referenced documents, kept in a fixed layered shape |
| **Scope the open-source copy up front** | Merging internal documents into the code repository made accidental publication easy | An allow-list of directories; internal documents, and any reference to them, never enter the public copy |

## Decision timeline

The table above holds decisions that became **general rules**. This one lists the **one-off decisions** that never did — covering direction, technical judgement, risk anticipation and feature changes — in the order they were made.

Each row gives **how the ask was framed at the time** (quoted wording kept close to the original) and **what was decided**. Implementation detail, system identifiers and personal or machine information are deliberately left out.

| Date | Kind | The ask | Result |
|---|---|---|---|
| 09-10 | Feature | "Users must not upload plugins themselves; they only enable or disable them, and an admin manages them" | Plugin sources never reach users; users only toggle |
| 09-11 | Feature | "Users may create workspaces only inside their own directory, without seeing system paths" | Self-service without exposing the filesystem |
| 09-11 | Risk | "What worries me most is the AI creating piles of code and scripts while it works" | Clean-up targets generated artefacts, not the user's own conversation history |
| 09-12 | Direction | "Always choose the long-term best option, not short-term patching" | Became a general rule |
| 09-12 | Governance | "Before deleting something, look at what it does" | Became a general rule |
| 09-12 | Governance | "Finish it in one pass — don't stop except for a decision I have to make" | Became a general rule |
| 09-12 | Feature | "Move the admin entry under user management and fold it into capabilities" | Menus follow how users think |
| 09-12 | Risk | "Taking over by force-removing a lock … this must be forbidden" | Written into the red lines: never remove another session's lock |
| 09-13 | Risk | "Two live copies of the path will drift apart" | Move the working root wholesale, and drop the junction from the old drive |
| 09-13 | Direction | "I need to see it live to know whether it meets the need — no need to wait for my confirmation every time" | Reversible roll-outs go straight out; only changes that interrupt live users are announced first |
| 09-13 | Direction | "Just mention who was referenced at the end — don't open by talking about them" | Credit compressed to one closing line |
| 09-13 | Technical | "Drop that class of browser-automation approach" | Written into the rules; a better option replaces it |
| 09-13 | Governance | "Don't edit files that belong to someone else's task" | Boundary discipline |
| 09-13 | Direction | "Don't forget the docs are bilingual" | Paired languages: English primary, Chinese entry at the top |
| 09-13 | Risk | "Strip the user conversation data too … avoid leaking user, service, personal-machine or credential information" | Sensitive-information sweep before every export |
| 09-14 | Direction | "Finish it in one go; leave no loose ends" | Became a general rule |
| 09-14 | Technical | "It can connect to a database cluster — the database isn't the limit" | Architecture moves from single machine to manager + worker nodes |
| 09-14 | Technical | "Instance memory must not be affected by plugin toggles — only by the floor and ceiling" | Quota decoupled from plugin state |
| 09-14 | Risk | "Remove that — it was never verified; it should be flagged as unverified" | The unverified branch is removed from the published version in three steps |
| 09-15 | Technical | "Skip that part when pulling the development code later — keep the cleaned version" | Long-term policy: treat that branch as abandoned, no reflow |
| 09-15 | Risk | "Merging the docs repository into the code repository does not make the docs publishable — remember that" | Internal docs, and every reference to them, stay out of the public copy |
| 09-15 | Governance | "Unless asked otherwise, push normally" | Keeps history continuous |
| 09-15 | Feature | "Rename the management page and split plugins and skills into tabs" | Names and structure follow users |
| 09-15 | Technical | "Archive the source files after migration; rebuild shared dependencies centrally" | Avoids repeating the rebuild per user |
| 09-16 | Direction | "Even a single machine needs to interconnect — that is the point of the mesh" | The goal is connecting **heterogeneous** networks, not just standalone machines |
| 09-16 | Technical | "Judge carefully — an old project isn't automatically best on performance or security" | Evaluate existing options by this project's scenario, not by popularity |
| 09-16 | Technical | "The self-built relay" | Self-built relay adopted |
| 09-16 | Technical | "Open a fresh session automatically past 300K of context" | Auto-continuation past a threshold |
| 09-17 | Risk | "The last session hit a case where a decision was still pending but the continuation session had already started" | Only tasks the AI can decide alone may auto-continue |
| 09-17 | Direction | "Change it to: a human plans and makes the key calls; the AI implements" | Wording settled |

## Technology choices and routes

Routes and technology choices are made by the AI inside the boundary; the human steps in only where there is a **real trade-off**. The main ones, and what was settled:

| When | Area | What was chosen |
|---|---|---|
| from 09-09 | Isolation model | One OS account and one instance per user, plus a port guard and an egress guard; the path fence confines each user to their own directory |
| 09-11 | State storage | A single-machine file-based database first; later established that the database is not what caps growth |
| 09-12 | Memory basis | Instance memory governed by a floor and a ceiling, **decoupled** from plugin toggles — toggling a plugin does not change the reported quota |
| 09-12 | Model-side capability | Search exposed as a configurable provider, with enable/disable wired to its configuration |
| 09-13 | Permission default | Instance permission default moved to full access; the security boundary is enforced by isolation rather than by narrowing what users can do |
| 09-13 | Access shape | Sub-path, sub-domain and custom-domain forms coexist |
| 09-13 | Session self-healing | Stale credential clean-up on write-back plus transparent replay of 401, instead of asking the user to sign in again |
| 09-14 | Runtime environment | Base runtime version frozen; the Python runtime and command-line tools **shared centrally** instead of rebuilt per user |
| 09-14 | Native conversion | The native bindings need a newer system library than this host provides ⇒ **native conversion dropped**, worked around with a zero-dependency generator |
| 09-14 | Memory governance | Lowered the runtime heap limit and added threshold alerting |
| 09-14 | Cache governance | Added ETag and 304 short-circuiting; the page shell got its own cache treatment |
| 09-14 | Compatibility | Plugins are **pre-checked at import**; the compatibility verdict rests on umbrella-package version and prerelease semantics |
| 09-14 | Feature reuse | In-conversation file preview **adopted the recommended library's existing plugin** rather than building one |
| 09-14 | Architecture | From single machine to **manager plus worker nodes**, so user instances can spread across hosts |
| 09-15 | Shared skills | The shared skill layer is mounted **read-only** |
| 09-15 | Role-based configuration | Per-role configuration patches, so different roles see different settings surfaces |
| 09-15 | Concurrent writes | Routine commits plus a server-side lock, so parallel sessions do not collide |
| 09-16 | Network transport | Between opening ports and a self-built relay, the **self-built relay** was chosen |
| 09-16 | Network shape | The goal is connecting different network environments into one **interoperable** network, not just serving standalone machines |
| 09-16 | Client | Install a client on personal machines and let them join the mesh |
| 09-16 | Crash policy | A **circuit breaker** with a cool-down window and alerting |
| 09-17 | Relay structure | Rendezvous and relay **split apart**; the relay stays resident and can be switched |
| 09-17 | Core or plugin | Whether the network capability belongs **in a plugin or in the core** was made a separate architecture call before building |

## Keeping context clean

A long-running session accumulates everything it has ever read or run, and every later turn has to carry it. One batch of work once pushed a session past a quarter of a million tokens; from then on, each turn carried that weight. The mechanics that contain it:

- **Scripts over repetition.** Bulk work runs as a script rather than as a long series of individual calls, so only the result enters the context.
- **Bound large output.** Command results that would flood the context are intercepted and truncated before they land.
- **Limit repeated reads.** The same file is not re-read turn after turn; what is needed is extracted once.
- **Start a new session past a threshold.** Context is treated as a budget with a ceiling, not as something that grows indefinitely.

The priority order matters: **the number of calls inside one turn dominates**, then the water level, then the fixed prompt overhead. Bounding output without reducing the call count does not help much.

## Session continuation

When a session approaches its context ceiling, the work continues in a fresh one instead of degrading in place.

- A **state document** — not the old transcript — carries the work forward: what was done, what remains, and the next step. Replaying history would recreate the problem.
- A continuation **must not cost more than it saves**. A fresh session that begins by running dozens of tools has gained nothing.
- **Only work the AI can decide alone may start automatically.** If a decision is still waiting on the human, no continuation may be opened — there was a case where the decision was still open while the continuation had already begun.

## Working documents

Building this project produced a large body of documents — research, plans, projections, forensics and retrospectives. This is what the "human plans and makes the key calls, AI implements" way of working actually leaves behind.

Below is the full set of **plan and adjustment records**: **128 documents**, grouped by theme. Names are **post-redaction** — host identifiers, private domains, other business lines, third-party product names and internal reference numbers have been removed or reworded. **The documents themselves are not in this repository.**

Names are given in English here for readability; the Chinese edition lists the original file names.

```
plan and adjustment records/
  README                     index of the set
  poc/                       proof-of-concept directory

  Access and permissions (12)
    01 launch token carried automatically
    02 security hardening: permission boundary and data store
    03 unified key under administrator control
    04 user deletion
    05 login straight into a session, and plugin-ising capabilities: feasibility
    06 login straight into the session window
    07 red line: never auto-fetch the latest upstream version
    08 resident instance ceiling and one active session
    09 hiding model settings from ordinary users: role-based profile patch
    10 read-only deployment of shared skills
    11 skill management surface: shared and personal, API and pages
    12 third-party cloud API integration: survey and first phase

  Sessions and instance self-healing (14)
    13 fixing a cold-start race that returned 404
    14 auditing and hardening the exposure of sensitive information
    15 fixing expiry that did not redirect to login; reviewing what is visible
    16 navigation settled: three decisions for the skill and plugin surface
    17 checking what the workspace picker exposes
    18 directory picker narrowed to the user's own directory
    19 full review of plans and code
    20 crash self-healing: verifying the current state and hardening it
    21 diagnosing session sluggishness
    22 migrating the service domain
    23 checking the AI capability and permission limits inside an instance
    24 automatic recovery from 401 on the instance side
    25 fixing a crash loop and adding a not-running fallback
    26 upstream upgrade coupling points and a regression list

  Plugins, skills and runtime (23)
    27 assessing platform support for a business-workbench plugin
    28 user data clean-up policy
    29 source of the official allow-list plugins
    30 cleaning up orphan instances left by the orchestrator
    31 plugin page: two tabs and description-led visuals
    32 forensics on a business plugin session; checking sandbox permissions
    33 instance permission default moved to full access
    34 liveness probing on enable, and per-plugin isolation
    35 a clean-up script deleting a platform package
    36 rolling the capability section out to ordinary users
    37a session forensics and a list of platform defects
    37b capability section v0.2: official token and localisation
    38a shared software installation and checking network boundaries
    38b terminology: from business plugin to capability plugin
    39 narrowing what an instance exposes and blocking host access
    40 fixing the shared-skill layer mount
    41 hardening skill upload; enabling and disabling user skills
    42 a shared Python runtime; re-checking session forensics
    43 platform-owned files polluting a user workspace, and owner self-repair
    44 freezing the base runtime version
    45 prompting existing sessions to start a new one
    46 shared command-line tools inside an instance
    47 runtime environment page

  Management surface and interaction (14)
    49 feedback and self-healing on first visit after an instance was reclaimed
    50 inject script for session-expiry self-healing
    51 transparent replay of 401 after an instance was reclaimed
    52 a new user's instance would not start
    53 documentation quality review and a slimming plan
    54 documentation information architecture and a machine-readable index
    55 forensics on the latest session and items to improve
    56 in-instance assistant and a file download endpoint
    57 user-management entry in settings; installation for everyone
    58 instance memory optimisation and lowering the quota
    59 reconnection feedback: a start-up animation
    60 renaming a settings section
    61 plugin page: taller official list and bottom spacing
    62 making the plugin catalogue cache visible, with a refetch button

  Stability and compatibility (15)
    64 integrating a third-party search provider
    65 coupling plugin enable/disable with the web provider configuration
    66 a false positive on a business plugin, and explicit trust
    67 redoing the capability-management section to the UI spec
    68 root-owned files from the candidate pool, fixed at the root
    69 concurrency governance: routine commits and a server-side lock
    70 an incompatible third-party search plugin causing a crash loop
    71 compatibility pre-check at import and upload
    72 waking and reconnecting automatically on returning to the page
    73 making the lock actually block: wording fixes and hook enforcement
    74 instance memory: lowering the heap limit and adding threshold alerts
    75 two new evaluation axes for plugins: hosting friendliness and resource cost
    76 adapting a third-party spreadsheet plugin: unix socket and same-origin proxy
    77 self-check and in-place recovery on returning, made visible
    78 crash circuit breaker: cool-down and alerting

  Platformisation and experience (24)
    79 two platform defects in plugin enable/disable
    80 architecture and feature review: refactoring while keeping behaviour
    81 target architecture and naming conventions: the refactoring outline
    82 making the management surface native to the platform
    83 aligning the login and register pages to the UI spec; show-password
    84 unifying the instance memory quota; removing a false reading
    85 letting users configure their own model keys: two key layers
    86 cross-user instance management; two renames
    87 model settings: user-supplied providers and a shared toggle
    88 detecting the built-in install path; fixing a silent failure
    89 in-conversation file preview using the recommended library
    90 upstream upgrade from 0.1.2-rc.1 to 0.1.5-rc.1
    91 model settings mirroring the official interaction
    92 filtering the recommended plugin list by upstream version
    93 settling compatibility checks: umbrella version and prerelease semantics
    94 instance memory basis settled
    95 HTML shell caching, fixing the root cause of a plugin load failure
    96 decoupling the instance quota from plugin toggles
    97 adding ETag and 304 short-circuiting to the plugin bundler
    98 fixing at the root: cleaning up a stale auth cookie on write-back
    99 why self-decision failed, and strengthening a stop hook
    100 merging in-instance personal skills into the capability group
    101 capability management: rename, tabs and three-line cards
    102 moving language switching into user settings; removing preferences

  Network capability (22)
    103 client installation and mesh interconnection: feasibility
    104 mesh network: global architecture retrospective
    105 mesh network: backbone layer
    106 mesh network: hundred-node projection, v2
    107 mesh network: thousand-node, all-scenario projection
    108 mesh network: game case study
    109 mesh network: research on game traffic and group-chat limits
    110 mesh network: group chat, backup, migration and confidentiality
    111 mesh network: addenda and reference options
    112 mesh network: nine bottlenecks and how to land them
    113 mesh network: transport trade-offs — open ports versus a self-built relay
    114 mesh network: use cases and remaining gaps
    115 mesh network: plugin versus core change, an architecture call
    116 mesh network: working through each problem
    117 mesh network: parameter table and observation basis
    118 splitting the rendezvous relay: forensics and a change plan
    119 clustering: manager and worker
    120 cross-node migration and node bootstrapping
    121 code layering paradigm and iteration risk
    122 moving user data and rebuilding shared state
    123 planning method distilled from the mesh line
    124 audit of non-informative content in the documents

  Client form factor (4)
    125 session continuation: retrospective and fixes
    126 session continuation conventions
    127 client-side deployment
    128 desktop client development plan
```

There is also a body of **process artefacts**: release and export reports, push and execution checklists, test-environment deployment and assessment records, cross-repository correspondence, the export and verification tooling (link checking, English/Chinese structure parity, release-process checking, pre-upload audit, full static verification, type checking), and the unpublished decision evidence.

> The names above are **post-redaction**, and **the documents themselves are not in this repository**. For what the public copy contains, see the documentation map in the README.

## What the AI decides on its own

**Decides alone** — technical selection, implementation path, naming and structure, parameter tuning, deployment detail, debugging method, dependency versions, compatibility fallbacks, and any trade-off *inside* an agreed approach.

**Must ask** — business goals and priorities, spending or resource commitments, external commitments and compliance, credentials or approvals only the human can provide, taste and wording preferences, and anything whose blast radius exceeds the current system.

**Hard gates** — widening permissions or the attack surface, anything that interrupts live users, bulk changes (more than ten files), and irreversible operations.

> The test is never whether this is important, but **whether it goes beyond the boundary**. Everything inside it is decided and reported; only what falls outside is brought back.
