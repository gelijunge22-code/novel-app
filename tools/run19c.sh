#!/bin/bash
cd /home/ubuntu/novel-app
export NODE_OPTIONS=--max-old-space-size=384
echo "############ 遮挡体检（滚到底最后一行有没有被压住）$(date +%T)"
node tools/e2e-cover.js
echo "--- 反证 pad0 ---"; COVER_FORCE=pad0 node tools/e2e-cover.js
echo "--- 反证 bar ---"; COVER_FORCE=bar node tools/e2e-cover.js
echo "############ 接口实跑核查 $(date +%T)"
node tools/e2e-iface.js
echo "############ UI 硬判据（断行/热区/溢出/居中/动效）$(date +%T)"
node tools/e2e-uicheck.js
echo "--- 反证 wrap ---"; UICHK_FORCE=wrap node tools/e2e-uicheck.js
echo "--- 反证 small ---"; UICHK_FORCE=small node tools/e2e-uicheck.js
echo "--- 反证 wide ---"; UICHK_FORCE=wide node tools/e2e-uicheck.js
echo "############ 5 个新功能 $(date +%T)"
node tools/e2e-new5.js
echo "############ 夜间体检（全量重跑，带"被压住"记账）$(date +%T)"
NIGHT_ROUND=r19 node tools/e2e-night.js
echo "--- 判定 ---"
server/venv/bin/python tools/night_check.py
echo "############ 夜间体检反证：整屏被盖住（必须红）$(date +%T)"
NIGHT_FORCE=cover NIGHT_ROUND=r19nc NIGHT_OUT=docs/夜间体检实测-反证cover.json NIGHT_TO=6 node tools/e2e-night.js
NIGHT_SRC=docs/夜间体检实测-反证cover.json NIGHT_REPORT=docs/夜间体检报告-反证cover.json server/venv/bin/python tools/night_check.py
echo "############ 夜间体检反证：夜间字看不清（必须红）$(date +%T)"
NIGHT_FORCE=dim NIGHT_ROUND=r19nd NIGHT_OUT=docs/夜间体检实测-反证dim.json NIGHT_TO=6 node tools/e2e-night.js
NIGHT_SRC=docs/夜间体检实测-反证dim.json NIGHT_REPORT=docs/夜间体检报告-反证dim.json server/venv/bin/python tools/night_check.py
echo "############ 全部跑完 $(date +%T)"
