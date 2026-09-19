> **English (primary, this file)** ｜ **[中文文档](project.zh-CN.md)**

[← Back to README](../README.md)

# Development, contributing, versions, who does what

## Development

```sh
npm install          # pnpm or npm; Node ^22.19 || >=24
npm run typecheck    # tsc --noEmit
npm run verify       # build + static verification scripts  ← run before committing
```

Agents working inside this repository should read [AGENTS.md](../AGENTS.md) — it lists the rules for changes (change `src/`, never `lib/`; always run `npm run verify`; add assertions for pure-function logic) and the security boundaries not to cross.

## Contributing

Issues and pull requests are welcome.

- **Bug** — include reproduction steps, error messages and your environment (OS / Node / DSH versions)
- **Suggestion** — describe the use case and the outcome you expect
- **PR** — make sure `npm run typecheck && npm run verify` passes first
- Commit messages are best prefixed with `feat:` / `fix:` / `chore:`

## Versions

Version numbers follow [semantic versioning](https://semver.org/) (`MAJOR.MINOR.PATCH`).
The release history — every version with its list of changes — lives on the homepage:
**[README → Version history](../README.md#version-history)**.

## How this project is built

**Human planning and key judgment; implementation by AI** — model **DeepSeek V4 / V4.1 flash**.

| Stage | Who |
|---|---|
| Direction, scope, architecture decisions, review and acceptance | Human |
| Code, tests, documentation, porting examples | AI |
