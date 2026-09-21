#!/bin/bash
# 第 27 轮收口：AI 对话"出不了字"修好 + 出字方式（流式/整段）+ 对话的模型与渠道设置
#              —— 全量回归（含既有各套判据，顺序跑、不并行，机器只有 3.6G 内存）。
cd /home/ubuntu/novel-app || exit 1
say(){ echo; echo "=== $* ==="; }

say "⓪ 同步前端到 apk 资源副本"
python3 tools/sync_pkg.py; echo "sync exit=$?"

say "① 模型层：发出去必须出字（假渠道复现 + 流式/非流式区分）"
server/venv/bin/python tools/check_chatstream.py; echo "chatstream exit=$?"
say "①b 反证 LLM_NOFALLBACK=1（回退没接上）"
LLM_NOFALLBACK=1 server/venv/bin/python tools/check_chatstream.py; echo "chatstream-nofb exit=$?"
say "①c 反证 LLM_NOFALLBACK=1 LLM_SILENT=1（静默无输出）"
LLM_NOFALLBACK=1 LLM_SILENT=1 server/venv/bin/python tools/check_chatstream.py; echo "chatstream-silent exit=$?"
say "①d 反证 LLM_FORCE_STREAM=1（装看不见「整段出」）"
LLM_FORCE_STREAM=1 server/venv/bin/python tools/check_chatstream.py; echo "chatstream-force exit=$?"

say "② 界面：真实路径发一句话必须出字（用用户报障那个模型）"
node tools/e2e-chatstream.js; echo "chatstream-ui exit=$?"
say "②b 反证 CHATSTREAM_FORCE=silent（错误与空回复都不上屏）"
CHATSTREAM_FORCE=silent node tools/e2e-chatstream.js; echo "chatstream-ui-silent exit=$?"

say "③ 界面：对话的模型与渠道设置（自己加渠道 / 自己拉取 / 默认+备用）"
node tools/e2e-chatmodels.js; echo "chatmodels exit=$?"
say "③b 反证 CHATMODELS_FORCE=stub（拉取假装成功）"
CHATMODELS_FORCE=stub node tools/e2e-chatmodels.js; echo "chatmodels-stub exit=$?"

say "③c 上下文：AI 真的带着这本书的东西 + 工具名都有中文 + 步骤留痕"
server/venv/bin/python tools/check_ai_context.py; echo "aicontext exit=$?"
say "③d 反证 AICHECK_DROP=promise_list（工具没中文名）"
AICHECK_DROP=promise_list server/venv/bin/python tools/check_ai_context.py; echo "aicontext-drop exit=$?"

say "④ 空间规范（静态 + 实机 8 桶）"
python3 tools/verify_layout.py; echo "layout-static exit=$?"
LAYOUT_FORCE=bare python3 tools/verify_layout.py; echo "layout-bare exit=$?"
node tools/e2e-layout.js; echo "layout exit=$?"
say "④b 反证 LAYOUT_FORCE=size（同类不同尺寸）"
LAYOUT_FORCE=size LAYOUT_ONLY=shelf,settings node tools/e2e-layout.js; echo "size exit=$?"

say "⑤ 大设置页（19 条）+ 反证"
node tools/e2e-settings.js; echo "settings exit=$?"
SETR_FORCE=olds node tools/e2e-settings.js; echo "olds exit=$?"

say "⑥ 阅读器底部面板 / 独立目录"
node tools/e2e-readerquick.js; echo "rdquick exit=$?"

say "⑦ 对话页安全（不压标题 / 不被切 / 文案无残留）+ 反证"
node tools/e2e-chatsafe.js; echo "chatsafe exit=$?"
CHATSAFE_FORCE=stub node tools/e2e-chatsafe.js; echo "chatsafe-stub exit=$?"
CHATSAFE_FORCE=raw node tools/e2e-chatsafe.js; echo "chatsafe-raw exit=$?"

say "⑧ 三态 / 不遮挡 / UI 硬判据 / 安全区 / 切书小方块 / 夜间"
node tools/e2e-states.js; echo "states exit=$?"
node tools/e2e-cover.js; echo "cover exit=$?"
node tools/e2e-uicheck.js; echo "uicheck exit=$?"
SAFE_ONLY=reader node tools/e2e-safearea.js; echo "safearea exit=$?"
node tools/e2e-bkmini.js; echo "bkmini exit=$?"
node tools/e2e-night.js; echo "night exit=$?"

say "⑨ 阅读器沉浸态（结构 + 逐像素）"
node tools/e2e-rdshell.js; echo "rdshell exit=$?"
server/venv/bin/python tools/check_rdshell.py; echo "rdshell-px exit=$?"

say "⑩ 令牌 / 文案 / 死代码 / 体量"
server/venv/bin/python tools/verify_tokens.py; echo "tokens exit=$?"
python3 tools/copy_check.py; echo "copy exit=$?"
python3 tools/deadcode_audit.py; echo "deadcode exit=$?"
python3 tools/size_report.py; echo "size exit=$?"

say "⑪ 无头浏览器收尾"
ps -eo args | grep -c "[h]eadless"
node tools/sweep_chrome.js
say "全部跑完"
