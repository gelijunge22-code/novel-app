#!/usr/bin/env bash
# 第 30 轮回归（一）：前端改完（切屏空白 + 读器面板参数被吞）之后，把手上这套判据整体再过一遍。
# 一台 3.6G 的机器：**串行**跑，别并行；跑完收无头浏览器。
set -u
cd /home/ubuntu/novel-app
say(){ echo; echo "=== $* ==="; }
run(){ echo; echo "--- $* ---"; "$@"; echo "  exit=$?"; }

say "0 同步（前端改完必须 sync，否则 e2e 跑的是旧副本）"
run python3 tools/sync_pkg.py
say "1 静态判据"
run python3 tools/copy_check.py
run server/venv/bin/python tools/verify_layout.py
run server/venv/bin/python tools/check_probe_timeouts.py
run python3 tools/size_report.py
say "2 界面判据"
run node tools/e2e-layout.js
run node tools/e2e-bkmini.js
run node tools/e2e-readerquick.js
run node tools/e2e-rdshell.js
run server/venv/bin/python tools/check_rdshell.py
say "2.5 切屏判据（含反证对照）"
run node tools/e2e-nav.js
say "2.6 截图自证（拍前过 gate + 拍完当场量像素）"
run node tools/shots-30.js
run server/venv/bin/python tools/shots_check.py r30
run server/venv/bin/python tools/shots_audit.py --selftest   # 判据自己的单测（藏在里面的反证：旧写法必须判错）
run server/venv/bin/python tools/shots_audit.py
say "3 三态 / 对话"
run node tools/e2e-states.js
run node tools/e2e-chatstream.js
say "4 收尾"
ps -eo args | grep -c "[h]eadless"
node tools/sweep_chrome.js
free -m
echo; echo "=== 全部跑完 ==="
