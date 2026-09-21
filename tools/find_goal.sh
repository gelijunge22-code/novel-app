#!/bin/bash
# 找 Goal Mode 的入口：非交互下怎么开「目标模式」
BIN=/home/ubuntu/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex
echo "=== 1) 斜杠命令 /goal ==="
strings "$BIN" | grep -E "^/goal$|^goal$" | sort -u | head
echo "=== 2) 相关标识符 ==="
strings "$BIN" | grep -iE "goal_(mode|id|state|status)|goalId|setGoal|createGoal|goals?:" | sort -u | head -20
echo "=== 3) 配置键 ==="
strings "$BIN" | grep -iE "^goal" | sort -u | head -20
echo "=== 4) 帮助文本里的 goal ==="
strings "$BIN" | grep -i "goal" | grep -iE "mode|目标|pursue|achiev" | sort -u | head -15
