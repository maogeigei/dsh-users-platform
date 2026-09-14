> **English (primary): [project.md](project.md)** ｜ **[中文文档](project.zh-CN.md)（当前）**

[← 回到 README](../README.zh-CN.md)

# 开发 · 贡献 · 版本 · AI 生成

## 开发

```sh
npm install          # pnpm / npm 均可；Node ^22.19 || >=24
npm run typecheck    # tsc --noEmit
npm test             # 构建 + node:test 单测（数据层 / 路径围栏 / 崩溃策略）
npm run verify       # 构建 + 单测 + 5 个静态校验脚本  ← 提交前跑这个
npm run smoke        # 及 smoke:admin / smoke:auth / smoke:fs / smoke:dsh / smoke:domain … 端到端冒烟
```

Smoke 系列对**运行中的服务**做端到端验证（创建临时用户/会话，用完即删），适合改完代理或路由后回归。

在本仓库里改代码的 agent 请看 [AGENTS.zh-CN.md](../AGENTS.zh-CN.md) —— 里面写了改动纪律（只改 `src/`、不改 `lib/`；改完必过 `npm run verify`；纯函数逻辑要补断言）与不可触碰的安全边界。

## 贡献

欢迎 Issue 与 PR。

- **Bug** —— 附复现步骤、报错信息、运行环境（系统 / Node / DSH 版本）
- **建议** —— 说明使用场景与期望效果
- **PR** —— 请先 `npm run typecheck && npm test` 通过；改动代理 / 路由的请附 `npm run smoke:*` 结果
- 提交信息建议用 `feat:` / `fix:` / `chore:` 前缀

## 版本与迭代

版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)（`MAJOR.MINOR.PATCH`）。
发布历史 —— 每个版本及其更新点 —— 在主页上：**[README → 版本更新说明](../README.zh-CN.md#版本更新说明)**。

## AI 生成

本仓库的**全部代码与文档均由 AI 生成** —— 模型 **DeepSeek V4 / V4.1 flash**。

| 范围 | 来源 |
|---|---|
| `src/` · `web/` · `scripts/` · `Dockerfile` | ✅ AI 生成 |
| `README.md` · `PLUGIN-PORTING.md` · `install.md` · `AGENTS.md` 及 `manual/` 下的文档 | ✅ AI 生成 |
| `test/` 与 9 个 `smoke:*` 端到端冒烟 | ✅ AI 生成 |
| `examples/`（插件改造示例）· `screenshots/` · `diagrams/` | ✅ AI 生成 |
