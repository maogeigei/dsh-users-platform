#!/usr/bin/env bash
# 平台侧 CI：类型检查 + 构建 + 单元测试
#
# 设计取舍：**不纳入** scripts/smoke-*.mjs —— 它们需要「平台正在运行 + 有效账号凭据」，
# 属于手工/回归冒烟，不适合无人值守 CI。其中：
#   - smoke-plugins.mjs  已删除（其目标 /api/plugins、/api/plugins/select 在阶段 0 移除）
#   - smoke-watchdog.mjs 已删除（watchdog 依赖 ENABLE_PATCH=true，线上为 false，从不启动）
#
# 用法：bash scripts/ci.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1/2 typecheck =="
npm run typecheck

echo "== 2/2 build + unit tests =="
npm test

echo "CI OK ✅"
