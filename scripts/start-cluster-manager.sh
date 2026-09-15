#!/usr/bin/env bash
# 起一台 **cluster 模式的 Manager**（T08 跨机演练用；在 Manager 那台机器上跑）。
#
# 现场的对照（2026-09-15 演练实测）：
#   · Manager 在 **47**（本脚本所在机器），监听 `127.0.0.1:13080`（**不公网暴露**）
#   · Worker agent 在 **106**，经 SSH 反向隧道出现在本机 `127.0.0.1:19000` / `19001`
#   · 控制面 PG 也在 **106**，经同一条隧道出现在本机 `127.0.0.1:15432`
# 用法：bash scripts/start-cluster-manager.sh   （env 见下方 manager.env）
在 47 上：建 manager.env、bootstrap 管理员、起 cluster Manager（127.0.0.1:13080）
set -uo pipefail
cd <INSTALL_DIR>-cluster || exit 1

cat > <INSTALL_DIR>-cluster/manager.env <<'ENVEOF'
DSH_USERS_PLATFORM_DEPLOY_MODE=cluster
DSH_USERS_PLATFORM_DB_URL=postgres://dsh-users-platform:dsh-users-platform_cluster_test@127.0.0.1:15432/dsh-users-platform_cross
DSH_USERS_PLATFORM_DATA_ROOT=<INSTALL_DIR>-cluster/data
DSH_USERS_PLATFORM_CLUSTER_HOST_ID=m-47
DSH_USERS_PLATFORM_CLUSTER_AGENT_URL=http://127.0.0.1:19000
DSH_USERS_PLATFORM_CLUSTER_AGENT_TOKEN=cross-machine-token
DSH_USERS_PLATFORM_CLUSTER_INSTANCE_HOST=127.0.0.1
DSH_USERS_PLATFORM_CLUSTER_WORKER_DATA_ROOT=<INSTALL_DIR>-cluster/live-data
DSH_USERS_PLATFORM_CLUSTER_CAPACITY_MB=-1
DSH_USERS_PLATFORM_CLUSTER_REGISTER_SELF=0
DSH_USERS_PLATFORM_CLUSTER_LEASE_TTL_MS=30000
ENVEOF

set -a
# shellcheck disable=SC1091
. <INSTALL_DIR>-cluster/manager.env
set +a

echo "--- bootstrap 管理员 ---"
node lib/cli.js bootstrap-admin --username root --password crossmgr123 2>&1 | tail -1

echo "--- 起 Manager ---"
pkill -f "dsh-users-platform-cluster/lib/cli.js --port 13080" 2>/dev/null
sleep 1
nohup node lib/cli.js --port 13080 --host 127.0.0.1 --log-level warn > /tmp/manager-47.log 2>&1 &
sleep 7

echo "--- 自检 ---"
echo "  login.html : $(curl -s -o /dev/null -w '%{http_code}' -m 6 http://127.0.0.1:13080/login.html)"
echo "  进程       : $(pgrep -cf 'dsh-users-platform-cluster/lib/cli.js --port 13080')"
echo "  日志尾部   :"
tail -4 /tmp/manager-47.log 2>/dev/null | sed 's/^/    /'
