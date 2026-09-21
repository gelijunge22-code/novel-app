#!/bin/bash
cd /home/ubuntu/novel-app
echo "=== 安装包 ==="
ls -la apk/手机写作台.apk apk/app-release.apk 2>/dev/null | awk '{print "  ",$9,$5"B",$6,$7,$8}'
echo
echo "=== 包里有什么（证据） ==="
A=apk/手机写作台.apk
echo "  前端文件: $(unzip -l $A 2>/dev/null | grep -c 'assets/www')"
echo "  后端 py 模块: $(unzip -l $A 2>/dev/null | grep -cE 'server/.*\.py[co]?$')"
echo "  Python 运行时: $(unzip -l $A 2>/dev/null | grep -c 'libpython')"
echo "  sha256: $(sha256sum $A | cut -c1-32)"
echo
echo "=== DONE.md 里老实交代的缺口 ==="
grep -nE "做不到|没做|未做|缺口|限制|真机|KVM|无法" DONE.md 2>/dev/null | head -12 | cut -c1-150
