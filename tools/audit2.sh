#!/bin/bash
cd /home/ubuntu/novel-app/server
echo "═══════ 1. 那 17 处空壳到底是什么 ═══════"
grep -rn -B3 "^\s*pass\s*$" --include='*.py' routers/ engine/ llm/ *.py 2>/dev/null | head -30
echo
echo "═══════ 2. return {} / [] 的地方，有没有注释说明 ═══════"
for spot in "routers/backup.py:63" "engine/memory.py:81" "engine/agent_runtime.py:409"; do
  f=${spot%%:*}; n=${spot##*:}
  echo "--- $f 第 $n 行 ---"
  sed -n "$((n-4)),$((n+2))p" $f
done
echo
echo "═══════ 3. 核心引擎：真实现了还是空架子 ═══════"
echo "--- world.py 的函数签名 ---"
grep -nE "^def |^class |^    def " engine/world.py | head -20
echo
echo "--- lint.py 的规则数（真规则 vs 说明） ---"
grep -cE "^\s*\{|^\s*Rule\(|^\s*\(" engine/lint.py
grep -nE "^RULES|^_RULES|规则" engine/lint.py | head -5
