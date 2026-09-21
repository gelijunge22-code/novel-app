#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 切书条「小方块」做出来了吗 ═══"
sed -n '486,530p' frontend/css/base.css | sed 's/^/  /'
echo
echo "═══ 2. 参考书架收图片：后端接口有没有 ═══"
grep -nE "@router\.(get|post|delete)" server/routers/refs.py 2>/dev/null | head -10 | sed 's/^/  /'
echo "  ── 有没有图片相关:"
grep -nE "image|图片|png|jpg|upload|uploadfile" server/routers/refs.py 2>/dev/null | head -8 | sed 's/^/     /'
echo
echo "═══ 3. 它的参考图片自测跑了吗 ═══"
ls -la tools/refs_upload_test.py 2>/dev/null | awk '{print "  ",$9,$5"字节",$6,$7,$8}'
ls -t docs/*参考* docs/*refs* 2>/dev/null | head -3 | sed 's/^/  /'
echo
echo "═══ 4. 前端上传图片的入口 ═══"
grep -nE "accept=.*image|data-img|data-refimg|收图片" frontend/js/studio.js 2>/dev/null | head -6 | sed 's/^/  /'
echo
echo "═══ 5. UI 规范机器检测在跑什么 ═══"
python3 tools/verify_tokens.py 2>&1 | tail -12 | sed 's/^/  /'
echo
echo "═══ 6. 待办清单里 5 个新功能 / 剩余项 ═══"
grep -nE "^\- \[ \]" docs/待办清单.md 2>/dev/null | tail -14 | cut -c1-115 | sed 's/^/  /'
