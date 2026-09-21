#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ 1. 它清单里现在怎么写的（跟 20 有关的） ═══"
grep -nE "20 条|20个|20 个|作废|5 个|五个" docs/待办清单.md 2>/dev/null | head -12 | cut -c1-130 | sed 's/^/  /'
echo
echo "═══ 2. I 节还在不在（那 20 条） ═══"
grep -cE "^\*\*I[0-9]+" docs/待办清单.md 2>/dev/null | sed 's/^/  I 节条目数: /'
sed -n '181,186p' docs/待办清单.md 2>/dev/null | cut -c1-120 | sed 's/^/  /'
echo
echo "═══ 3. 我最后发给它的原话（收件箱里搜） ═══"
grep -an "全部作废" logs/inbox.txt 2>/dev/null | tail -4 | cut -c1-160 | sed 's/^/  /'
echo
echo "═══ 4. 5 个新功能那条现在怎么写的 ═══"
sed -n '383,392p' docs/待办清单.md 2>/dev/null | cut -c1-140 | sed 's/^/  /'
