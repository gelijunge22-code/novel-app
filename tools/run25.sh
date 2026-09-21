#!/bin/bash
# 第 25 轮收口：空间规范（间距标尺 / 对齐 / 权重 / 呼吸 / 同类同尺寸）落地后的**全量回归**。
# 顺序跑、不并行（这台机器 3.6G 内存，一个无头 Chrome 约 180MB，AGENTS.md 里有血泪）。
cd /home/ubuntu/novel-app || exit 1
say(){ echo; echo "=== $* ==="; }

say "⓪ 同步前端到 apk 资源副本"
python3 tools/sync_pkg.py; echo "sync exit=$?"

say "① 空间规范（静态）：间距标尺 + 字号权重表"
python3 tools/verify_layout.py; echo "layout-static exit=$?"
say "①b 反证 LAYOUT_FORCE=bare（塞裸值）"
LAYOUT_FORCE=bare python3 tools/verify_layout.py; echo "layout-bare exit=$?"

say "② 空间布局（实机）：对齐 / 呼吸 / 权重 / 同类同尺寸 ×44 屏"
node tools/e2e-layout.js; echo "layout exit=$?"
say "②b 反证 LAYOUT_FORCE=grid（6px 左偏移）"
LAYOUT_FORCE=grid LAYOUT_ONLY=shelf,settings node tools/e2e-layout.js; echo "grid exit=$?"
say "②c 反证 LAYOUT_FORCE=breath（6px 间距）"
LAYOUT_FORCE=breath LAYOUT_ONLY=shelf,settings node tools/e2e-layout.js; echo "breath exit=$?"
say "②d 反证 LAYOUT_FORCE=weight（21px 字号）"
LAYOUT_FORCE=weight LAYOUT_ONLY=shelf,settings node tools/e2e-layout.js; echo "weight exit=$?"
say "②e 反证 LAYOUT_FORCE=size（某一个分段按钮字号 18px）"
LAYOUT_FORCE=size LAYOUT_ONLY=shelf,settings node tools/e2e-layout.js; echo "size exit=$?"

say "③ 回归 · 大设置页（13 条）"
node tools/e2e-settings.js; echo "settings exit=$?"

say "④ 回归 · 三态（空/载/错）"
node tools/e2e-states.js; echo "states exit=$?"

say "⑤ 回归 · 不遮挡"
node tools/e2e-cover.js; echo "cover exit=$?"

say "⑥ 回归 · UI 硬判据（断行/热区/溢出/居中/动效）"
node tools/e2e-uicheck.js; echo "uicheck exit=$?"

say "⑦ 回归 · 安全区 + 手势"
node tools/e2e-safearea.js; echo "safearea exit=$?"

say "⑧ 回归 · 切书小方块（不穿模）"
node tools/e2e-bkmini.js; echo "bkmini exit=$?"

say "⑨ 回归 · 夜间模式"
node tools/e2e-night.js; echo "night exit=$?"

say "⑩ 回归 · 阅读器底部面板 / 独立目录"
node tools/e2e-readerquick.js; echo "rdquick exit=$?"

say "⑪ 阅读器沉浸态（结构）"
node tools/e2e-rdshell.js; echo "rdshell exit=$?"
say "⑪b 阅读器沉浸态（逐像素）"
server/venv/bin/python tools/check_rdshell.py; echo "rdshell-px exit=$?"
say "⑪c 反证 RDCH_FORCE=keep（栏不让高度）"
RDCH_FORCE=keep node tools/e2e-rdshell.js; echo "rdshell-rev exit=$?"
RDCH_FORCE=keep server/venv/bin/python tools/check_rdshell.py; echo "rdshell-px-rev exit=$?"

say "⑫ 对话页安全（顶栏不压标题 / 横排不切 / 文案无残留）"
node tools/e2e-chatsafe.js; echo "chatsafe exit=$?"
say "⑫b 反证 CHATSAFE_FORCE=left（小方块回左边）"
CHATSAFE_FORCE=left node tools/e2e-chatsafe.js; echo "chatsafe-left exit=$?"
say "⑫c 反证 CHATSAFE_FORCE=clip（横排不给滚动/换行）"
CHATSAFE_FORCE=clip node tools/e2e-chatsafe.js; echo "chatsafe-clip exit=$?"
say "⑫d 反证 CHATSAFE_FORCE=raw（气泡里塞原始 JSON）"
CHATSAFE_FORCE=raw node tools/e2e-chatsafe.js; echo "chatsafe-raw exit=$?"

say "⑬ 设计令牌 + 主题色卡"
server/venv/bin/python tools/verify_tokens.py; echo "tokens exit=$?"
SWATCH_FORCE=mismatch server/venv/bin/python tools/verify_tokens.py; echo "swatch-rev exit=$?"

say "⑭ 文案体检（去口语化 / 去开发术语）"
python3 tools/copy_check.py; echo "copy exit=$?"
COPY_FORCE=bad python3 tools/copy_check.py; echo "copy-rev exit=$?"

say "⑮ 死代码 / 体量"
python3 tools/deadcode_audit.py; echo "deadcode exit=$?"
python3 tools/size_report.py; echo "size exit=$?"

say "⑯ 无头浏览器收尾"
ps -eo args | grep -c "[h]eadless"
node tools/sweep_chrome.js
say "全部跑完"
