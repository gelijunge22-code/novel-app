#!/bin/bash
cd /home/ubuntu/novel-app
F=docs/待办清单.md
echo "=== 统计 ==="
echo "  总条数: $(grep -cE '^[[:space:]]*[-*] \[' $F)"
echo "  已勾:   $(grep -cE '^[[:space:]]*[-*] \[x\]' $F)"
echo "  未勾:   $(grep -cE '^[[:space:]]*[-*] \[ \]' $F)"
echo
echo "=== 未勾的逐条 ==="
grep -nE '^[[:space:]]*[-*] \[ \]' $F | head -40
echo
echo "=== 已勾的逐条（看它声称做完了什么） ==="
grep -nE '^[[:space:]]*[-*] \[x\]' $F | head -20
