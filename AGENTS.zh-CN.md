# AGENTS.md

> **English (primary): [AGENTS.md](AGENTS.md)** ｜ **[中文文档](AGENTS.zh-CN.md)（当前）**

给**在本仓库里干活的 AI agent** 的指令。人类读者请看 [README.md](README.md)。

## 这个项目是什么

把「本机单用户」的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）变成**可对公网托管的多用户服务**：
按用户各拉起一个独立 `dsh` 子进程，外面套一层控制面（账号与审核、路由与反代、隔离与护栏、插件与技能统一管理、崩溃自愈）。

**不修改、不内嵌** dsh 的代码 —— 只以子进程调用本机已安装的 `dsh`。

> **只想「把它装起来用」？不要读本文件** —— 执行 [install.md](install.md)。本文件是给**改代码**的 agent 的。

## 常用命令

| 目的 | 命令 |
|---|---|
| 装依赖 | `npm ci` |
| 构建（`src/` → `lib/`） | `npm run build` |
| 类型检查（不产出） | `npm run typecheck` |
| **完整验证（提交前跑这个）** | `npm run verify` |
| 起控制面（开发） | `node lib/cli.js --port 3080 --db ./dev.local.db` |

## 改动纪律

1. **只改 `src/` 与 `web/`，不要改 `lib/`** —— `lib/` 是 `npm run build` 的产物，改了会被覆盖。
2. **改完必须过 `npm run verify`**（它含 `npm run build` + 静态校验脚本）。只跑 `typecheck` 不够。
3. **关键决策都写成了纯函数**（崩溃策略、路径围栏、patch 渲染、安装路径解析…）——它们不依赖进程与网络，
   ⇒ 改这类逻辑时**请同时补 `scripts/verify-*.mjs` 断言**，而不是只改实现。回归网是这类代码唯一的保险。
4. **改了注入脚本（`assets/inject/`）** 要跑 `node scripts/verify-inject.cjs lib/supervisor/proxy.js`（`npm run verify` 已含）。
5. **注释写「为什么」不写「是什么」**：本仓库的注释以「踩过的坑 + 判据 + 数值」为主；改行为时请同步改注释，别留下过期说明。

## 不要动（安全边界）

- **不要把任何密钥提交进仓库**：`<dataRoot>/secret.key`、用户 `$DSH_HOME/.credentials.yaml`、`/etc/dsh-users-platform.env` 都不进版本库。
- **不要改 `install.sh` 里几步的先后顺序**：管理员必须**先建、服务后启**（顺序反了会撞 SQLite 锁，表现为「装完却登录不了」）。
- **不要往实例 env 里塞平台密钥**：实例 env 从白名单重建后注入该用户自己的值，这是隔离边界，不是可优化项。
- **不要让新的失败路径静默降级**：定位不到资源时要**留下可观测痕迹**（告警 / 诊断字段），否则会变成「功能好像没做」。
  参考 `src/web/model-catalog.ts` 的 `catalogDiagnostics()`。

## 目录速查

| 路径 | 内容 |
|---|---|
| `src/web/` | 控制面：Fastify 路由（`routes/`）、认证与会话、桌面、文件服务、插件与技能投放、模型设置 |
| `src/supervisor/` | 进程编排：spawn / 崩溃策略 / 守护实例接管 / 心跳与空闲回收 / nginx 生成 / 反代与端口守卫 |
| `src/fs/` | 每用户文件根、路径围栏、回收站 |
| `src/db/` | 数据层：SQLite 与 Postgres 双后端、迁移账本、prepared statement 记忆化 |
| `web/` | 前端页面（登录 / 注册 / 管理台 / 唤醒页） |
| `assets/inject/` | 注入实例页面的运行时脚本（自愈、恢复、补丁） |
| `scripts/` | 运维脚本 + `verify-*.mjs` 静态校验（`npm run verify` 的组成部分） |

## 交付前自检

- [ ] `npm run verify` 全绿
- [ ] 新增/修改的行为有对应断言（`scripts/verify-*.mjs`）
- [ ] 没有把密钥、内部文档编号、内网地址写进代码或注释
- [ ] 注释与实际行为一致（改了行为就改注释）
