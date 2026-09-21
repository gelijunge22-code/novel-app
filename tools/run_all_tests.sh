#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# tools/run_all_tests.sh —— 一把跑完全部判据（第 9 遍打磨加）。
#
# 为什么需要它：判据已经十几套，手打容易漏、更容易**并发**跑 ——
# 而并发跑界面走查是假红的源头（perf_test 往书架塞 201 章的书，走查点到那本上，
# 后面全红）。所以这里**串行**跑，而且顺序是固定的：
#   ① 接口/引擎级（会建测试书、跑完自己清）
#   ② 界面走查（要求书架干净 —— preflight 会拦）
#   ③ 性能（唯一一个故意造"大书"的，放最后，免得污染前面几步）
#
# 用法：bash tools/run_all_tests.sh            # 全跑
#       bash tools/run_all_tests.sh --no-ui    # 只跑后端
# 产出：logs/run-all-<时间>.log + 末尾一张汇总表
# ---------------------------------------------------------------------------
set -uo pipefail
REPO=/home/ubuntu/novel-app
cd "$REPO"
PY=$REPO/server/venv/bin/python
STAMP=$(TZ=Asia/Shanghai date '+%m%d-%H%M%S')
LOG_DIR=$REPO/logs
mkdir -p "$LOG_DIR"
LOG=$LOG_DIR/run-all-$STAMP.log
NO_UI=0
[ "${1:-}" = "--no-ui" ] && NO_UI=1

declare -a NAMES=() RESULTS=()
run() {          # run <名字> <命令...>
  local name="$1"; shift
  printf '\n\033[1;36m=== %s ===\033[0m\n' "$name" | tee -a "$LOG"
  local t0=$SECONDS
  if "$@" >>"$LOG" 2>&1; then
    RESULTS+=("PASS  $name  ($((SECONDS - t0))s)")
  else
    RESULTS+=("FAIL  $name  ($((SECONDS - t0))s)")
  fi
  NAMES+=("$name")
  tail -3 "$LOG" | sed 's/^/    /'
}

run "接口实测 verify_api"        "$PY" tools/verify_api.py --no-llm
run "路由逐条 verify_routers"    "$PY" tools/verify_routers.py
run "边界 verify_edges"          "$PY" tools/verify_edges.py
run "错误参数 verify_badinput"   "$PY" tools/verify_badinput.py
run "质检引擎 verify_lint"       "$PY" tools/verify_lint.py
run "引擎单测 test_engine"       "$PY" tools/test_engine.py
run "对端同步 verify_peer_sync"  "$PY" tools/verify_peer_sync.py
run "设计规范 verify_tokens"     "$PY" tools/verify_tokens.py
if [ "$NO_UI" = "0" ]; then
  run "界面走查 e2e"             node tools/e2e.js
  run "界面走查 e2e-studio"      node tools/e2e-studio.js
  run "界面走查 e2e-new"         node tools/e2e-new.js
  run "界面走查 e2e-ui"          node tools/e2e-ui.js
  run "界面走查 e2e-tools12"     node tools/e2e-tools12.js
  run "界面走查 e2e-worldengine" node tools/e2e-worldengine.js
  run "界面走查 e2e-orchestra"   node tools/e2e-orchestra.js
  run "界面走查 e2e-version"     node tools/e2e-version.js
  run "界面走查 e2e-back"        node tools/e2e-back.js
  run "弹层四角 e2e-corners"      node tools/e2e-corners.js
  run "当前书 e2e-bookctx"        node tools/e2e-bookctx.js
fi
run "性能 perf_test"             "$PY" tools/perf_test.py

printf '\n\033[1;37m================ 汇总 ================\033[0m\n'
fails=0
for r in "${RESULTS[@]}"; do
  case "$r" in FAIL*) echo -e "  \033[1;31m$r\033[0m"; fails=$((fails+1));; *) echo -e "  \033[1;32m$r\033[0m";; esac
done
echo "  日志：$LOG"
[ "$fails" = "0" ] && echo "  全部通过" || echo "  失败 $fails 项"
exit $([ "$fails" = "0" ] && echo 0 || echo 1)
