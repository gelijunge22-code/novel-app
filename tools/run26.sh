#!/bin/bash
# 第 26 轮收口：控件形态统一（二元开关只留 .switch）+ 大设置页排布重做 + 书里的设置并入 .seg
#              + 对话页三档模式"看得见地变" 之后的**全量回归**。
# 顺序跑、不并行（这台机器 3.6G 内存，一个无头 Chrome 约 180MB，AGENTS.md 里有血泪）。
cd /home/ubuntu/novel-app || exit 1
say(){ echo; echo "=== $* ==="; }

say "⓪ 同步前端到 apk 资源副本"
python3 tools/sync_pkg.py; echo "sync exit=$?"

say "① 空间规范（静态）：间距标尺 + 字号权重表"
python3 tools/verify_layout.py; echo "layout-static exit=$?"
say "①b 反证 LAYOUT_FORCE=bare（塞裸值）"
LAYOUT_FORCE=bare python3 tools/verify_layout.py; echo "layout-bare exit=$?"

say "② 空间布局（实机）：对齐/呼吸/权重/同类同尺寸/开关形态/硬截断/底栏压内容/呼吸不匀 ×N 屏"
node tools/e2e-layout.js; echo "layout exit=$?"
say "②b 反证 LAYOUT_FORCE=grid（6px 左偏移）"
LAYOUT_FORCE=grid LAYOUT_ONLY=shelf,settings node tools/e2e-layout.js; echo "grid exit=$?"
say "②c 反证 LAYOUT_FORCE=breath（6px 间距）"
LAYOUT_FORCE=breath LAYOUT_ONLY=shelf,settings node tools/e2e-layout.js; echo "breath exit=$?"
say "②d 反证 LAYOUT_FORCE=weight（21px 字号）"
LAYOUT_FORCE=weight LAYOUT_ONLY=shelf,settings node tools/e2e-layout.js; echo "weight exit=$?"
say "②e 反证 LAYOUT_FORCE=size（分段按钮 18px）"
LAYOUT_FORCE=size LAYOUT_ONLY=shelf,settings node tools/e2e-layout.js; echo "size exit=$?"
say "②f 反证 LAYOUT_FORCE=switch（开/关塞回两个方块）"
LAYOUT_FORCE=switch LAYOUT_ONLY=shelf,settings node tools/e2e-layout.js; echo "switch exit=$?"
say "②g 反证 LAYOUT_FORCE=clip（下拉文字硬截断）"
LAYOUT_FORCE=clip LAYOUT_ONLY=settings node tools/e2e-layout.js; echo "clip exit=$?"
say "②h 反证 LAYOUT_FORCE=pad0（正文底不留白，末项被底栏压）"
LAYOUT_FORCE=pad0 LAYOUT_ONLY=shelf,settings node tools/e2e-layout.js; echo "pad0 exit=$?"
say "②i 反证 LAYOUT_FORCE=cv（模块间距忽大忽小）"
LAYOUT_FORCE=cv LAYOUT_ONLY=settings node tools/e2e-layout.js; echo "cv exit=$?"

say "③ 回归 · 大设置页（19 条）"
node tools/e2e-settings.js; echo "settings exit=$?"
say "③b 反证 SETR_FORCE=olds（开/关换回两方块）"
SETR_FORCE=olds node tools/e2e-settings.js; echo "olds exit=$?"
say "③c 反证 SETR_FORCE=flatsw（色块涂同一个颜色）"
SETR_FORCE=flatsw node tools/e2e-settings.js; echo "flatsw exit=$?"
say "③d 反证 SETR_FORCE=nopref（抹掉 data-pref）"
SETR_FORCE=nopref node tools/e2e-settings.js; echo "nopref exit=$?"
say "③e 反证 SETR_FORCE=nopass（抹掉改密码 id）"
SETR_FORCE=nopass node tools/e2e-settings.js; echo "nopass exit=$?"
say "③f 反证 SETR_FORCE=notab（抹掉导航 active）"
SETR_FORCE=notab node tools/e2e-settings.js; echo "notab exit=$?"
say "③g 反证 SETR_FORCE=nogroup（删一个分组）"
SETR_FORCE=nogroup node tools/e2e-settings.js; echo "nogroup exit=$?"

say "④ 回归 · 阅读器底部面板 / 独立目录（22 条）"
node tools/e2e-readerquick.js; echo "rdquick exit=$?"

say "⑤ 回归 · 对话页安全 + 三档模式可观测差异"
node tools/e2e-chatsafe.js; echo "chatsafe exit=$?"
say "⑤b 反证 CHATSAFE_FORCE=stub（模式只变色不变内容）"
CHATSAFE_FORCE=stub node tools/e2e-chatsafe.js; echo "stub exit=$?"
say "⑤c 反证 CHATSAFE_FORCE=left（小方块回左边）"
CHATSAFE_FORCE=left node tools/e2e-chatsafe.js; echo "left exit=$?"
say "⑤d 反证 CHATSAFE_FORCE=clip（横排不给滚动/换行）"
CHATSAFE_FORCE=clip node tools/e2e-chatsafe.js; echo "clip exit=$?"
say "⑤e 反证 CHATSAFE_FORCE=raw（气泡塞原始 JSON）"
CHATSAFE_FORCE=raw node tools/e2e-chatsafe.js; echo "raw exit=$?"

say "⑥ 回归 · 三态（空/载/错）"
node tools/e2e-states.js; echo "states exit=$?"

say "⑦ 回归 · 不遮挡"
node tools/e2e-cover.js; echo "cover exit=$?"

say "⑧ 回归 · UI 硬判据（断行/热区/溢出/居中/动效）"
node tools/e2e-uicheck.js; echo "uicheck exit=$?"

say "⑨ 回归 · 安全区 + 手势（阅读器）"
SAFE_ONLY=reader node tools/e2e-safearea.js; echo "safearea exit=$?"

say "⑩ 回归 · 切书小方块（不穿模）"
node tools/e2e-bkmini.js; echo "bkmini exit=$?"

say "⑪ 回归 · 夜间模式"
node tools/e2e-night.js; echo "night exit=$?"

say "⑫ 阅读器沉浸态（结构 + 逐像素）"
node tools/e2e-rdshell.js; echo "rdshell exit=$?"
server/venv/bin/python tools/check_rdshell.py; echo "rdshell-px exit=$?"
say "⑫b 反证 RDCH_FORCE=keep（栏不让高度）"
RDCH_FORCE=keep node tools/e2e-rdshell.js; echo "rdshell-rev exit=$?"
RDCH_FORCE=keep server/venv/bin/python tools/check_rdshell.py; echo "rdshell-px-rev exit=$?"

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
