> **English (primary): [project.md](project.md)** ｜ **[中文文档](project.zh-CN.md)（当前）**

[← 回到 README](../README.zh-CN.md)

# 开发 · 贡献 · 版本 · 人与 AI 分工

## 开发

```sh
npm install          # pnpm / npm 均可；Node ^22.19 || >=24
npm run typecheck    # tsc --noEmit
npm run verify       # 构建 + 静态校验脚本  ← 提交前跑这个
```

在本仓库里改代码的 agent 请看 [AGENTS.zh-CN.md](../AGENTS.zh-CN.md) —— 里面写了改动纪律（只改 `src/`、不改 `lib/`；改完必过 `npm run verify`；纯函数逻辑要补断言）与不可触碰的安全边界。

## 贡献

欢迎 Issue 与 PR。

- **Bug** —— 附复现步骤、报错信息、运行环境（系统 / Node / DSH 版本）
- **建议** —— 说明使用场景与期望效果
- **PR** —— 请先 `npm run typecheck && npm run verify` 通过
- 提交信息建议用 `feat:` / `fix:` / `chore:` 前缀

## 版本与迭代

版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)（`MAJOR.MINOR.PATCH`）。
发布历史 —— 每个版本及其更新点 —— 在主页上：**[README → 版本更新说明](../README.zh-CN.md#版本更新说明)**。

## 项目如何建成

**人负责规划与关键判断，AI 负责实施** —— 模型 **DeepSeek V4 / V4.1 flash**。

| 环节 | 由谁负责 |
|---|---|
| 方向、范围、架构决策、评审与验收 | 人 |
| 代码、测试、文档、插件改造示例 | AI |
