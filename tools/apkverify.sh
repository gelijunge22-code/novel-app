#!/bin/bash
cd /home/ubuntu/novel-app
A=apk/build/outputs/apk/release/novelapp-release.apk
echo "═══ 包大小对比 ═══"
echo "  旧(纯壳):  306 KB"
echo "  新(带Python): $(du -h $A | cut -f1)"
echo
echo "═══ 包里有没有 Python 运行时 ═══"
unzip -l $A 2>/dev/null | grep -iE "libpython|libchaquopy|python3\.[0-9]|\.so$" | head -12
echo "  .so 库数量: $(unzip -l $A 2>/dev/null | grep -c '\.so$')"
echo
echo "═══ 有没有后端源码 ═══"
unzip -l $A 2>/dev/null | grep -iE "assets/chaquopy|server/|\.pyc|app\.py" | head -10
echo
echo "═══ 有没有内嵌前端 ═══"
echo "  assets/www: $(unzip -l $A 2>/dev/null | grep -c 'assets/www') 个文件"
echo
echo "═══ 大块头是什么 ═══"
unzip -l $A 2>/dev/null | sort -rn -k1 | head -12 | awk '{printf "  %10s  %s\n", $1, $4}'
