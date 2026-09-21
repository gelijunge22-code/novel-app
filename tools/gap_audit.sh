#!/bin/bash
cd /home/ubuntu/novel-app
echo "═══ A. 现在前端有哪些面板 ═══"
grep -oE "name: '[^']+', sub:" frontend/js/studio.js frontend/js/tools.js | sed "s/.*name: //" | tr '\n' ' '
echo; echo
echo "═══ B. 后端有哪些模块 ═══"
ls server/routers/*.py | xargs -n1 basename | sed 's/.py//' | tr '\n' ' '
echo; echo
echo "═══ C. 我关心的"高级功能"有没有 ═══"
for k in 搜索 全局搜索 离线 导入 写作目标 番茄 关系图 地图 时间线 伏笔提醒 角色卡 多端 分享 音色 克隆 语义 检索 图谱 知识库 联网 大纲 卡片 灵感 语音输入 暗黑 无障碍 快捷键 备份 版本历史 对比 diff 回收站 撤销; do
  n=$(grep -rl "$k" frontend/js/*.js frontend/index.html 2>/dev/null | wc -l)
  [ "$n" -gt 0 ] && printf "  ✅ %-10s (%s 个文件提到)\n" "$k" "$n" || printf "  ❌ %-10s\n" "$k"
done
echo
echo "═══ D. 后端接口 vs 前端调用 ═══"
echo "  后端: $(grep -rhcE '@router\.(get|post|put|patch|delete)\(' server/routers/*.py | paste -sd+ | bc) 个"
echo "  前端静态可见: $(grep -rhoE "/api/[a-z_/-]+" frontend/js/*.js | sort -u | wc -l) 个"
