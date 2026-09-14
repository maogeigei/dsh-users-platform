> **English (primary, this file)** ｜ **[中文文档](project.zh-CN.md)**

[← Back to README](../README.md)

# Development, contributing, versions, AI generation

## Development

```sh
npm install          # pnpm or npm; Node ^22.19 || >=24
npm run typecheck    # tsc --noEmit
npm test             # build + node:test unit tests (data layer / path fence / crash policy)
npm run verify       # build + unit tests + five static verification scripts  ← run before committing
npm run smoke        # plus smoke:admin / smoke:auth / smoke:fs / smoke:dsh / smoke:domain … end-to-end smoke suites
```

The smoke suites exercise a **running service** end to end (creating temporary users and sessions, deleting them afterwards), so they are the right regression step after touching the proxy or the routes.

Agents working inside this repository should read [AGENTS.md](../AGENTS.md) — it lists the rules for changes (change `src/`, never `lib/`; always run `npm run verify`; add assertions for pure-function logic) and the security boundaries not to cross.

## Contributing

Issues and pull requests are welcome.

- **Bug** — include reproduction steps, error messages and your environment (OS / Node / DSH versions)
- **Suggestion** — describe the use case and the outcome you expect
- **PR** — make sure `npm run typecheck && npm test` passes first; changes to the proxy or routes should include `npm run smoke:*` results
- Commit messages are best prefixed with `feat:` / `fix:` / `chore:`

## Versions

Version numbers follow [semantic versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).
The release history — every version with its list of changes — lives on the homepage:
**[README → Version history](../README.md#version-history)**.

## AI generation

**All code and documentation in this repository are AI-generated** — model **DeepSeek V4 / V4.1 flash**.

| Scope | Origin |
|---|---|
| `src/` · `web/` · `scripts/` · `Dockerfile` | ✅ AI-generated |
| `README.md` · `PLUGIN-PORTING.md` · `install.md` · `AGENTS.md` and the `manual/` documents | ✅ AI-generated |
| `test/` and the 9 `smoke:*` end-to-end suites | ✅ AI-generated |
| `examples/` (plugin porting example) · `screenshots/` · `diagrams/` | ✅ AI-generated |
