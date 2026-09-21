#!/bin/bash
cd /home/ubuntu/novel-app
export NODE_OPTIONS=--max-old-space-size=384
echo "=== [1/4] readerquick 正常态 $(date +%T) ==="; node tools/e2e-readerquick.js
echo "=== [2/4] readerquick 反证 RDQ_FORCE=noq $(date +%T) ==="; RDQ_FORCE=noq node tools/e2e-readerquick.js
echo "=== [3/4] bkmini 正常态 $(date +%T) ==="; node tools/e2e-bkmini.js
echo "=== [4/4] bkmini 反证 E2E_OVERLAP=1 $(date +%T) ==="; E2E_OVERLAP=1 node tools/e2e-bkmini.js
echo "=== done $(date +%T) ==="
