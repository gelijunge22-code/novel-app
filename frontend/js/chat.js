/* ============================================================
   chat.js — 「AI 对话」面板（window.Chat）
   纯原生 JS，无构建、无依赖；接口一律相对路径（见 api.js）。
   真实接口：API.sessions / newSession / snapshot / invoke / abort /
             command / stream(SSE) / chatProfiles / appModels / book
   SSE 事件形如：{seq, sessionId, invocationId, kind, event:{type, ...}}
     message_update.update.type = text_delta | thinking_delta | toolcall_start …
     tool_execution_start/end、session_entry、session_state_changed、agent_end
   ============================================================ */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const LS_KEY = 'nbapp.chat.v1';
  /* 工具名一律翻成人话再上屏 —— 界面上不许出现 promise_list 这种英文函数名。
     （多 Agent 编排那套工具也得在这儿登记，漏一个就会把原名直接甩到用户脸上。） */
  const TOOL_LABEL = {
    bash: '执行命令', read: '读文件', write: '写文件', edit: '改文件', multi_edit: '改文件',
    glob: '找文件', grep: '搜索', search: '检索', report_result: '汇报',
    web_search: '联网搜索', web_fetch: '抓网页', memory: '记忆', invoke_agent: '调度',
    lorebook: '设定', world_engine: '世界状态',
    list_files: '列目录', read_file: '读文件', write_file: '写文件', search_book: '翻书查找',
    world_state: '看世界状态', promise_list: '看伏笔',
    /* 第 31 轮接上来的：界面上本来就有这些能力，AI 之前够不着 —— 名字必须是**中文人话**，
       用户看「这一轮 AI 用了什么」那张卡片时要一眼看懂它干了啥。 */
    chapter_list: '看章节表', lore_list: '看设定清单', lore_read: '查设定',
    memory_search: '查记忆', outline_read: '看大纲', outline_write: '改大纲',
    notes_read: '看笔记', term_list: '看术语表', material_list: '翻素材',
    reference_list: '看参考资料', reference_read: '读参考资料',
    lint_check: '查 AI 味', consistency_check: '查前后矛盾', pacing_check: '查节奏',
  };
  /* 结果里那些键也是英文的，一并翻过来；没登记的键保持原样（总比丢掉强）。 */
  const KEY_LABEL = {
    promises: '没兑现的伏笔', result: '结论', files: '文件', file: '文件', path: '文件',
    text: '内容', content: '内容', count: '条数', ok: '结果', items: '条目', error: '出错',
  };

  /* 只用实测可用的人格（其余建会话会 500），默认主创。 */
  const PROFILES = ['leader.default', 'writer', 'inline.editor', 'rp.writer', 'rp.leader', 'simulator.leader', 'world.engine', 'researcher', 'leader.assets'];
  /* 默认只露这三个「写小说」用的，其余收进「更多角色」里 */
  const PROFILE_CORE = ['leader.default', 'writer', 'inline.editor'];
  const PROFILE_NOTE = {
    'leader.default': '主创 · 总管全书，改设定、排大纲、写正文都能派活（推荐）',
    writer: '正文写作 · 专写某一章，把要求说清楚它就动笔',
    'inline.editor': '改稿 · 润色、删水词、改语气，只动你选中的那段',
    'rp.writer': '跑团写作 · 按剧本站位渲染正文（进阶）',
    'rp.leader': '跑团主持 · 开局引导与剧情裁决（进阶）',
    'simulator.leader': '世界模拟 · 推演世界状态变化（进阶）',
    'world.engine': '世界引擎 · 维护世界观条目（进阶）',
    researcher: '联网研究 · 上网查资料核对细节',
    'leader.assets': '素材助手 · 整理设定与素材',
  };

  const S = {
    sid: null, profileKey: 'leader.default',
    modelKey: '', modelName: '', title: '',
    sessions: [], scopeAll: false,
    running: false, es: null, wired: false, strip: null,
    /* 默认「讨论」不是「执行」：执行模式会让写手直接往 manuscript/ 里落稿，
       新用户一进来随手发一句就可能改动自己的正文 —— 第一遍打磨时就是执行，
       等于把最危险的那个模式设成默认。要写正文自己切过去（切了会记住）。 */
    mode: 'discuss', modes: null, roles: null, modeFromPreset: false,
    divided: true,          // 谁来做：true=多 Agent 分工 / false=一个人干完
    seen: Object.create(null), lastSeq: -1, epoch: null,
    turnCtx: null,   /* 这一轮「AI 用了什么」的账（后端 turn_context 事件推过来） */
    waitT: null, waitN: 0,   /* "模型一直不出字"的看门狗计时器（见 waitTick） */
    live: null, pending: null, loading: false, inited: false,
    bookSlug: '',                     // 这一屏现在是哪本书的对话（换书就整屏重来）
  };

  /* ═══════════════ 小工具 ═══════════════ */
  /* 会话记忆**按书分开存**：以前一份 key 全站共用，换到第二本还带着第一本的人设/会话 ——
     正是用户说的"预设、工具分不清是哪本小说"。 */
  const store = {
    key() {
      const slug = (window.BookCtx && BookCtx.slug()) || '';
      return 'nbapp.chat.v2.' + (slug || '_none');
    },
    get() { try { return JSON.parse(localStorage.getItem(store.key()) || '{}'); } catch (e) { return {}; } },
    set(o) { try { localStorage.setItem(store.key(), JSON.stringify(Object.assign(store.get(), o))); } catch (e) {} },
    /* 老版本只有一份（不分书）：第一次进某本书时把它搬过去（只搬一次，不复制） */
    migrate() {
      try {
        const old = localStorage.getItem(LS_KEY);
        if (!old) return;
        if (!localStorage.getItem(store.key())) localStorage.setItem(store.key(), old);
        localStorage.removeItem(LS_KEY);
      } catch (e) {}
    },
  };

  /* 多 Agent 的中间步骤里，模型会把「工具调用」按协议原样写进正文 ——
     用户截图里读到的就是这些：
       promise_list {"promises": []}
       report_result {"result": "已为第6章规划了…"}
     有时还剩一截断掉的 JSON 尾巴（正文末尾甩一个 "}）。
     这些是给程序看的协议行，不该出现在用户读的对话里，渲染前统一清掉。
     （判据：tools/e2e-chatsafe.js 扫全部气泡，再出现这类残留就报红。） */
  const AGENT_TOOL_LINE = /^[ \t]*(?:list_files|read_file|search_book|world_state|promise_list|write_file|report_result)[ \t]*(?:\{.*\})?[ \t]*$/gm;
  const AGENT_JSON_LINE = /^[ \t]*\{[ \t]*"[A-Za-z_]+"[ \t]*:.*\}[ \t]*$/gm;
  function stripAgentNoise(src) {
    let t = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    for (let i = 0; i < 3; i++) t = t.replace(AGENT_TOOL_LINE, '').replace(AGENT_JSON_LINE, '');
    t = t.replace(/[ \t]*"\s*[\}\]]+[ \t]*$/, '');    // 断在半截的 JSON 尾巴（正文末尾甩一个 "}）
    /* 流**断在 JSON 中间**那一种：最后一行开了 { 或 [ 却整行没闭合，
       上面两条都匹配不到（它们都要求有闭合的 }），于是会原样漏进气泡。
       只认"末尾这一行"——中间那些完整 JSON 行上一行已经删干净了。 */
    t = t.replace(/(^|\n)[ \t]*[\{\[][^\n]*$/, '');
    return t.replace(/\n{3,}/g, '\n\n');
  }

  function mdHtml(src) {
    let t = esc(stripAgentNoise(src)).replace(/\r\n?/g, '\n');
    t = t.replace(/^\s*\[tool:[^\n]*$/gim, '');
    t = t.replace(/^\s*```[^\n]*$/gm, '');
    t = t.replace(/^(#{1,6})[ \t]+(.+)$/gm, '<span class="h">$2</span>');
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    return t;
  }

  /* 把 harness 的 JSON 值（{kind,preview}/{kind:'object',entries}）拍成一行文本 */
  function jval(v, depth) {
    depth = depth || 0;
    if (v == null || depth > 3) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v !== 'object') return '';
    if (v.kind === 'string') return String(v.preview != null ? v.preview : (v.value != null ? v.value : ''));
    if (v.kind === 'object') return (v.entries || []).map((e) => e.key + '=' + jval(e.value, depth + 1)).join(' · ');
    if (v.kind === 'array') return (v.items || []).map((x) => jval(x, depth + 1)).join(' ');
    if (v.kind === 'generic') return jval(v.value, depth + 1);
    if (Array.isArray(v)) return v.map((x) => jval(x, depth + 1)).join(' ');
    return Object.keys(v).slice(0, 6).map((k) => k + '=' + jval(v[k], depth + 1)).join(' · ');
  }

  function argLine(args) {
    try {
      if (args == null) return '';
      if (typeof args === 'string') return args;
      const v = (args.kind === 'generic') ? args.value : args;
      if (v && v.kind === 'object' && Array.isArray(v.entries)) {
        const want = ['command', 'path', 'file_path', 'query', 'pattern', 'prompt', 'title', 'text', 'result'];
        for (const k of want) {
          const hit = v.entries.filter((e) => e.key === k)[0];
          if (hit) return jval(hit.value);
        }
      }
      return jval(args);
    } catch (e) { return ''; }
  }

  const toolLabel = (n) => TOOL_LABEL[n] || n || '工具';
  const clip = (s, n) => (String(s || '').length > n ? String(s).slice(0, n) + '…' : String(s || ''));
  const two = (n) => (n < 10 ? '0' + n : '' + n);

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts), now = new Date();
    const hm = two(d.getHours()) + ':' + two(d.getMinutes());
    if (d.toDateString() === now.toDateString()) return hm;
    const y = new Date(now.getTime() - 86400000);
    if (d.toDateString() === y.toDateString()) return '昨天 ' + hm;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }
  function fmtAgo(ts) {
    if (!ts) return '';
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return fmtTime(ts);
  }

  /* ═══════════════ 顶上的控制块：收进「抽屉」 ═══════════════ */
  /* 用户原话（第 42 批）：「我用白线隔开了，**白线上面的是完全固定在那里的，完全动不了**，
     下面的是可以滑动的，**可以滑动的地方很少，可以看到的东西也少**」+「**做成抽屉式的行不行？太丑了**」。
     监督人量过：那一段吃掉屏高的 **35%**（298px），消息区只剩 50%。
     所以这里把「干活方式 / 说明 / 编排进度 / 人格·模型·出字·渠道那一排」整体收进 #chat-drawer：
     **默认收起成一行摘要**（讨论 · 主创 · 模型名 + 箭头），点一下才展开；
     展开后**它自己也滚得动**（.cd-body 自带 max-height + overflow），不许再出现"展开就吃掉半屏"。 */
  function ensureDrawer() {
    if (S.drawer) return S.drawer;
    const screen = $('#screen-chat');
    const body = $('#chat-body');
    if (!screen || !body) return null;
    const d = document.createElement('div');
    d.className = 'chat-drawer';
    d.id = 'chat-drawer';
    d.innerHTML =
      '<button class="cd-head" id="chat-drawer-head" aria-expanded="false" aria-controls="chat-drawer-body">' +
        '<span class="cd-sum" id="chat-drawer-sum">正在读…</span>' +
        '<span class="cd-chev" aria-hidden="true"></span>' +
      '</button>' +
      '<div class="cd-body" id="chat-drawer-body"></div>';
    screen.insertBefore(d, body);
    const head = d.querySelector('#chat-drawer-head');
    const setOpen = (open) => {
      d.classList.toggle('open', !!open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      try { if (window.Prefs) Prefs.set('chatDrawer', open ? 'open' : 'shut'); } catch (e) {}
    };
    if (drawerWantOpen()) setOpen(true);
    head.addEventListener('click', () => {
      setOpen(!d.classList.contains('open'));
      App.haptic && App.haptic();
    });
    S.drawer = d;
    S.drawerSet = setOpen;
    return d;
  }
  function drawerWantOpen() {
    try { return ((window.Prefs && Prefs.get('chatDrawer')) || 'shut') === 'open'; }
    catch (e) { return false; }
  }
  /* 收起态那一行摘要：模式 · 人格 · 模型（跑编排时加一棒）—— 收起也不瞎 */
  function drawDrawerSum() {
    const el = document.getElementById('chat-drawer-sum');
    if (!el) return;
    const m = modeOf(S.mode);
    const bits = [m ? m.name : '讨论', shortProfile(S.profileKey)];
    if (S.running) {
      const st = S.run && S.run.steps && S.run.steps.length
        ? '第 ' + Math.min((S.run.i || 0) + 1, S.run.steps.length) + '/' + S.run.steps.length + ' 棒'
        : '回复中…';
      bits.push(st);
    }
    bits.push(shortModel(S.modelName || '默认模型'));
    el.textContent = bits.join(' · ');
  }

  function ensureStrip() {
    if (S.strip) return S.strip;
    const drawer = ensureDrawer();
    const body = $('#chat-body');
    if (!drawer || !body) return null;
    const host = drawer.querySelector('#chat-drawer-body');
    const el = document.createElement('div');
    el.className = 'chat-strip';
    el.innerHTML =
      '<button class="pk" data-k="profile">' + iconHtml('spark') + '<b id="chat-pk-name">人格</b></button>' +
      '<button class="pk" data-k="model">' + iconHtml('settings') + '<b id="chat-md-name">模型</b></button>' +
      '<button class="pk" id="chat-stream-btn" data-k="stream">' + iconHtml('send') +
      '<b>出字 · ' + streamLabel() + '</b></button>' +
      '<button class="pk" data-k="setup">' + iconHtml('cpu') + '<b>渠道</b></button>' +
      '<span class="grow"></span><span class="st" id="chat-st">就绪</span>';
    // 模式胶囊单起一行：讨论 / 计划 / 执行（多 Agent 分工在这三种模式里真正生效）
    const row = document.createElement('div');
    row.className = 'mode-row';
    row.innerHTML = '<span class="mode-lab">干活方式</span><span class="mode-seg" id="chat-modes"></span>';
    S.modeRow = row;
    /* 「谁来做」单起一行 —— 跟「干活方式」挤在同一行会顶出屏幕（用户截图里的"穿模"）。
       这一行：分工 / 一个人 两枚胶囊 + 一个小小的「分工设置」跳转按钮。
       用户原话：「这三种都应该分别有一个单独 AI 完成所有流程的模式，然后也可以切换成多 agent 分工…
       以及应该在 AI 聊天那里增加一个快捷的小小的按钮…只是跳转就行，因为很多人可能不太懂」。 */
    const who = document.createElement('div');
    who.className = 'mode-row';
    who.innerHTML = '<span class="mode-lab">谁来做</span><span class="mode-seg" id="chat-split">'
      + '<button type="button" class="mode-btn on" data-split="1" title="多 Agent 分工：计划/取料/查证/写稿/挑刺各一个人，互相挑刺">分工</button>'
      + '<button type="button" class="mode-btn" data-split="0" title="一个人干完：同一个 AI 从头做到尾，快">一个人</button>'
      + '</span>'
      + '<button type="button" class="pk pk-mini" id="chat-goto-split" title="去调『哪一步交给谁』">分工设置</button>';
    S.whoRow = who;
    /* 编排进度行：只在多 Agent 真跑起来时出现（讨论/计划/执行），
       写着「第 2/4 棒 · 挑刺 · 复审 正在干活」。事件来自后端的 orchestra_* 。 */
    /* 模式说明行：**每个模式一句话说清它到底干什么**（讨论=先商量不落笔 / 计划=只出计划 /
       执行=直接改稿）。文案取自后端 orchestra.modes 的 desc —— 那是**唯一出处**，
       前端不许自己再编一套（本项目的红线：同一件事不许两套）。
       用户原话：「三个模式切换像没用」→ 所以说明、状态条、输入框提示都要跟着一起变。 */
    const hint = document.createElement('div');
    hint.className = 'mode-hint';
    hint.id = 'chat-mode-hint';
    S.modeHint = hint;
    const run = document.createElement('div');
    run.className = 'run-row hidden';
    run.id = 'chat-run';
    S.runRow = run;
    /* 第 42 轮：**「干活方式」和轮次胶囊摆在同一行**（用户：「展开之后这里非常非常的挤」）。
       以前各占一行，390 宽的屏上白白多出一整行空白；收一档之后并排放得下。 */
    const line = document.createElement('div');
    line.className = 'cd-line';
    line.appendChild(row);
    line.appendChild(run);
    host.appendChild(line);
    host.appendChild(who);          // 「谁来做」自己一行，不跟上面挤
    /* 这一行**自己**绑点击 —— 不能挂在别人身上：上一版就是挂错容器 + 被
       对方的 `if (!b) return` 提前 return 掉，表现是"点不了、像有 bug"（用户原话）。 */
    who.addEventListener('click', (e) => {
      const sp = e.target.closest('[data-split]');
      if (sp) {
        S.divided = sp.dataset.split === '1';
        renderSplit();
        try { store.set({ divided: S.divided }); } catch (e2) {}
        App.haptic && App.haptic();
        return;
      }
      if (e.target.closest('#chat-goto-split')) {   // 只是跳转：去预设页调"哪一步交给谁"
        try {
          if (window.Preset && Preset.open) Preset.open('project', (window.BookCtx && BookCtx.slug && BookCtx.slug()) || '');
          else App.show('preset');
        } catch (e2) { try { App.show('preset'); } catch (e3) {} }
      }
    });
    host.appendChild(hint);
    host.appendChild(el);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-k]');
      if (!b) return;
      if (b.dataset.k === 'profile') profileSheet(false);
      else if (b.dataset.k === 'stream') cycleStream();
      else if (b.dataset.k === 'setup') modelsSetupSheet();
      else modelSheet();
    });
    row.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mode]');
      if (!b) return;
      if (b.dataset.mode === S.mode) return;
      S.mode = b.dataset.mode;
      S.modeFromPreset = false;   // 用户自己选的，从此以后听用户的
      store.set({ mode: S.mode });
      renderModes();                 // 选中态 + 说明 + 状态条 + 输入框提示一起更新
      App.haptic && App.haptic();
    });
    S.strip = el;
    return el;
  }

  /* ═══════════════ 编排进度（多 Agent 真分工的可见证据） ═══════════════ */
  function renderRun() {
    const el = S.runRow || $('#chat-run');
    if (!el) return;
    const r = S.run;
    drawDrawerSum();
    /* 「轮次胶囊」和「模式说明」**共用同一行槽位**：真跑起来时说明让位给轮次，
       跑完再让回来。这样展开态永远不会"多出一行"（用户：「展开之后非常非常的挤」）。 */
    const hintEl = S.modeHint || document.getElementById('chat-mode-hint');
    if (hintEl) hintEl.classList.toggle('hidden', !!r);
    if (!r) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    const steps = r.steps || [];
    const done = r.done || {};
    el.innerHTML = '<span class="run-lab">' + esc(r.modeName || '编排') + '</span>' +
      steps.map((st, i) => {
        const n = i + 1;
        const cls = done[n] ? 'done' : (n === r.i ? 'now' : '');
        return '<span class="run-step ' + cls + '">' + n + '·' + esc(st.roleName) + '</span>';
      }).join('');
  }
  function runReset() { S.run = null; renderRun(); }

  /* 模式胶囊：只有这三种会让编排层真的分工（后端 /agent/orchestra 是唯一出处） */
  /* 三种模式在前端只做一件事：把"现在会怎么干活"显示出来。
     数据一律来自后端（name / desc / writes），前端不编第二套。 */
  function modeOf(key) {
    const list = S.modes || [];
    return list.filter((m) => m.key === key)[0] || null;
  }
  /* 谁来做那两枚胶囊（分工 / 一个人）—— 三种干活方式共用同一个开关 */

  /* ── 联网搜索那枚胶囊 ────────────────────────────────────────
     用户要求：默认跟主创共用一个模型（后端 web.enabled 只管"能不能上网"），
     一枚胶囊直接开/关；**开着才联网**，关着一个请求都不发。 */
  const NET = { on: null, busy: false };
  function bindNet() {
    const b = $('#chat-net');
    if (!b || b.dataset.bound === '1') return;
    b.dataset.bound = '1';
    b.addEventListener('click', (e) => { e.preventDefault(); toggleNet(); });
  }
  function paintNet() {
    const b = $('#chat-net');
    if (!b) return;
    const on = NET.on === true;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
    b.title = on ? '联网搜索：开着 —— 需要资料时后台用主创的模型自己上网找' : '联网搜索：关着 —— 一个请求都不发';
  }
  async function loadNet() {
    try {
      const d = await API.webConfig();
      NET.on = !!(d && d.enabled);
    } catch (e) { NET.on = null; }
    paintNet();
  }
  async function toggleNet() {
    if (NET.busy) return;
    NET.busy = true;
    const b = $('#chat-net');
    if (b) b.disabled = true;
    const want = !(NET.on === true);
    try {
      const r = await API.webSave({ enabled: want });
      NET.on = !!(r && r.enabled !== undefined ? r.enabled : want);
      try { window.WebSearch && WebSearch.invalidate && WebSearch.invalidate(); } catch (e2) {}
      App.toast(NET.on ? '联网搜索：已开启（后台用主创的模型跑）' : '联网搜索：已关闭（不会联网）');
      App.haptic && App.haptic();
    } catch (e) {
      App.toast('改不了联网开关：' + (e.message || e));
    } finally {
      NET.busy = false;
      if (b) b.disabled = false;
      paintNet();
    }
  }

  function renderSplit() {
    const box = $('#chat-split');
    if (!box) return;
    [...box.querySelectorAll('button[data-split]')].forEach((b) => {
      const on = (b.dataset.split === '1') === (S.divided !== false);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }
  function renderModes() {
    const box = $('#chat-modes');
    if (!box) return;
    const list = S.modes || [
      { key: 'discuss', name: '讨论' }, { key: 'plan', name: '计划' }, { key: 'execute', name: '执行' },
    ];
    box.innerHTML = list.map((m) =>
      '<button class="mode-btn' + (m.key === S.mode ? ' on' : '') + '" data-mode="' + esc(m.key) +
      '" aria-pressed="' + (m.key === S.mode ? 'true' : 'false') + '"' +
      ' title="' + esc(m.desc || '') + '">' + esc(m.name) + '</button>').join('');
    renderSplit();
    bindNet();          // 胶囊绑一次
    loadNet();          // 联网开关的真实状态每次进来都重读
    applyMode();
  }
  /* 切模式要**看得见地**变：说明文字 / 状态条 / 输入框提示 三处一起跟着走。
     （以前只把胶囊点成白色，用户说"像没用"。判据：这三处必须真的变，见 tools/e2e-chatsafe.js 己） */
  const PLACEHOLDER = {
    discuss: '想先商量什么？先说说你的想法…',
    plan: '让它先排个计划（不会动稿子）…',
    execute: '要改哪一章、怎么改？直接说…',
  };
  function applyMode() {
    const m = modeOf(S.mode);
    const hint = S.modeHint || document.getElementById('chat-mode-hint');
    if (hint) {
      hint.textContent = (m && m.desc ? m.desc : '') +
        (S.modeFromPreset ? ' · 预设里给这本书定的默认方式' : '');
      hint.classList.toggle('hidden', !!S.run);
    }
    const st = document.getElementById('chat-st');
    if (st && m) st.textContent = m.name + (m.writes ? ' · 会改稿' : ' · 不动文件');
    const ta = document.getElementById('chat-input');
    if (ta && m) ta.placeholder = PLACEHOLDER[m.key] || '说点什么…';
    drawDrawerSum();
  }

  async function loadModes() {
    try {
      const d = await API.orchestra((window.BookCtx && BookCtx.slug && BookCtx.slug()) || '');
      if (d && d.modes && d.modes.length) {
        S.modes = d.modes;
        S.roles = {};
        (d.roles || []).forEach((r) => { S.roles[r.key] = r; });
        /* 预设里主创的「干活方式」= 这本书的默认（第 33 轮起真生效）。
           只在"这本书我自己还没选过"时才拿它当初值 —— 用户在对话页选过就听用户的。 */
        const saved = store.get();
        if (!saved.mode && d.defaultMode && S.modes.some((m) => m.key === d.defaultMode)) {
          S.mode = d.defaultMode;
          S.modeFromPreset = true;
        }
        if (!S.modes.some((m) => m.key === S.mode)) S.mode = S.modes[0].key;
        /* 谁来做也一起恢复（上次选了"一个人"就还是一个人） */
        if (typeof saved.divided === 'boolean') S.divided = saved.divided;
      }
    } catch (e) { /* 拿不到就用默认三个，不拦着用户说话 */ }
    renderModes();
  }

  function setStatus(text, cls) {
    const el = $('#chat-st');
    if (el) { el.textContent = text; el.className = 'st' + (cls ? ' ' + cls : ''); }
  }
  /* 人格的中文短名（"leader.default" → "主创"、"inline.editor" → "改稿"）；
     拿不到就用 key 的最后一段，"默认"这两个字永远放得进。 */
  function shortProfile(k) {
    const note = PROFILE_NOTE[k] || '';
    const zh = note.split('·')[0].trim();
    return zh || String(k || '').split('.').pop() || '默认';
  }
  /* 模型名去掉渠道前缀（"[渠道]某模型" → "某模型"），
     再去掉结尾的 "-preview/-latest" 之类的噪音；太长的留头留尾。 */
  function shortModel(name) {
    let s2 = String(name || '').replace(/^\[[^\]]*\]\s*/, '').replace(/\s+/g, ' ').trim();
    s2 = s2.replace(/-(preview|latest|beta|exp)$/i, '');
    return s2.length > 18 ? (s2.slice(0, 10) + '…' + s2.slice(-6)) : s2;
  }

  function refreshStrip() {
    ensureStrip();
    const pn = $('#chat-pk-name'), mn = $('#chat-md-name'), t = $('#chat-title');
    /* 名字要**短到放得进那个小胶囊**：以前直接把 profileKey（"leader.default"）和
       模型全名塞进去，两个胶囊各被切掉一半（用户原话：「很多字儿都看不到」）。
       现在显示人话中文名 / 去掉渠道前缀的模型名，全名放 title（悬停、读屏都拿得到）。 */
    if (pn) { const nm = shortProfile(S.profileKey); pn.textContent = nm; pn.title = S.profileKey; }
    if (mn) { const nm = shortModel(S.modelName || '默认模型'); mn.textContent = nm;
      mn.title = S.modelName || '默认模型'; }
    if (t) t.textContent = S.title || '对话';
    setStatus(S.running ? '回复中…' : '就绪', S.running ? 'run' : '');
    renderModes();
    setSendMode();
    drawDrawerSum();
  }

  function setSendMode() {
    const btn = $('#chat-send');
    if (!btn) return;
    const icon = S.running ? 'stop' : 'send';
    btn.dataset.icon = icon;
    setIcon(btn, icon);
    btn.classList.toggle('stop', !!S.running);
    btn.setAttribute('aria-label', S.running ? '中断' : '发送');
  }

  /* ═══════════════ 渲染消息 ═══════════════ */
  function bodyEl() { return $('#chat-body'); }
  /* ── 自动滚动：**以用户的意图为准**（用户报的"一滑就被拽回去、来回跳"）
     原来是只看"离底部的距离"（<90px 就算还在底部、就贴底）。可流式输出时
     内容在**持续变长** —— 你刚往上滑几十像素，下一批字一进来又判定成"还在底部"，
     立刻被拽回最底下，来回跳。
     现在记住"用户是不是自己滑上去过"这个意图：一旦滑上去就**不再自动贴底**，
     直到他自己滑回最底下（或发新消息 / 切会话）。这样 AI 一边发一边能安心往上翻。 */
  let follow = true;                       // true = 跟着最新内容走
  function atBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 60; }
  function watchScroll() {
    const el = bodyEl();
    if (!el || el.dataset.scWired === '1') return;   // 只绑一次
    el.dataset.scWired = '1';
    el.addEventListener('scroll', () => { follow = atBottom(el); }, { passive: true });
    /* 手指一按到就停止跟随：不等 scroll 事件（那时候已经被拽回去了） */
    el.addEventListener('touchstart', () => {
      const e2 = bodyEl();
      if (e2) follow = atBottom(e2);
    }, { passive: true });
    el.addEventListener('wheel', () => {
      const e2 = bodyEl();
      if (e2) follow = atBottom(e2);
    }, { passive: true });
  }
  function scrollDown(force) {
    const el = bodyEl();
    if (!el) return;
    watchScroll();
    if (force) { follow = true; el.scrollTop = el.scrollHeight; return; }
    if (follow || atBottom(el)) el.scrollTop = el.scrollHeight;
  }

  function clearBody(emptyHtml) {
    const el = bodyEl();
    if (!el) return;
    el.innerHTML = emptyHtml || '';
    S.live = null;
    S.pending = null;
  }

  function addNode(html) {
    const el = bodyEl();
    if (!el) return null;
    const tpl = document.createElement('div');
    tpl.innerHTML = html;
    const node = tpl.firstElementChild;
    el.appendChild(node);
    scrollDown();
    return node;
  }

  /* ⚠ 第 42 轮抓到的**真 bug**（就是用户说的"刷新之后我发出来的消息看不到了，
     只有一个棕色的像圈一样的东西"）：
     库里 user 条目存的是 `blocks=[{"type":"text","content":"<字符串>"}]` —— **content 是字符串**，
     而这里原来写的是 `b.content.preview ?? b.content.value`：
     在字符串上取 `.preview/.value` 都是 `undefined` → 拼出来是空字符串
     → 用户自己那条消息渲染成一个**空的强调色气泡**（`.msg.me .bubble` 的底色就是 --accent=棕色）。
     而"刚发出去"时看得见，是因为那条是先本地画的（pendingUser）；一刷新走快照就变空了。
     现在三种形状都认：字符串 / {preview} / {value|text}。 */
  function blockText(b) {
    const c = b && b.content;
    if (c == null) return '';
    if (typeof c === 'string') return c;
    if (typeof c === 'object') {
      if (c.preview != null) return String(c.preview);
      if (c.value != null) return String(c.value);
      if (c.text != null) return String(c.text);
    }
    return String(c);
  }
  function userText(entry) {
    /* 判据反证钩子（跟 __NB_STORY_FORCE 一个套路）：把改前那版的行为还回来，
       用来证明"用户消息必须渲染出正文"这条判据**不是空判据**（见 tools/e2e-chatmsg.js）。 */
    if (globalThis.__NB_CHAT_FORCE === 'oldmsg') {
      const b0 = (entry.blocks || []).filter((b) => b.type === 'text');
      return b0.map((b) => (b.content && (b.content.preview != null ? b.content.preview : b.content.value)) || '').join('\n');
    }
    const blocks = (entry.blocks || []).filter((b) => b.type === 'text');
    const t = blocks.map(blockText).filter((x) => x && x.trim()).join('\n');
    /* 兜底：老数据/别的写入方可能把正文挂在 entry.text 上 */
    return t || String(entry.text || entry.summary || '');
  }
  const asstText = (entry) => (entry.content && (entry.content.preview != null ? entry.content.preview : entry.content.value)) || '';
  function toolResultText(t) {
    const c = (t.result && t.result.content) || [];
    const first = c.filter((x) => x.type === 'text')[0];
    return (first && (first.textPreview || first.text)) || '';
  }
  function reportTextFromArgs(args) {
    const v = args && args.value;
    if (v && v.kind === 'object' && Array.isArray(v.entries)) {
      const e = v.entries.filter((x) => x.key === 'result')[0];
      if (e) return jval(e.value);
    }
    return '';
  }
  function entryAnswer(entry) {
    const own = asstText(entry);
    if (own && own.trim()) return own;
    const tcs = entry.toolCalls || [];
    for (let i = tcs.length - 1; i >= 0; i--) {
      if (tcs[i].name === 'report_result') {
        const txt = reportTextFromArgs(tcs[i].args);
        if (txt) return txt;
      }
    }
    return '';
  }

  function chipsHtml(list) {
    if (!list || !list.length) return '';
    return '<div class="chip-row">' + list.map((t) =>
      '<span class="tool-chip ' + (t.cls || '') + '"><span class="nm">' + esc(toolLabel(t.name)) + '</span>' +
      (t.arg ? '<span class="ag">' + esc(clip(t.arg, 60)) + '</span>' : '') + '</span>').join('') + '</div>';
  }

  function renderUser(entry) {
    const id = entry.id || ('u' + Math.random());
    if (S.seen[id]) return;
    S.seen[id] = 1;
    const txt = userText(entry);
    addNode('<div class="msg me" data-id="' + esc(id) + '">' +
      /* 一条消息**永远不许渲染成一个空泡泡**：读不出正文就明说，别让用户对着一个
         棕色椭圆猜（判据：tools/e2e-chatsafe.js 扫"有没有空气泡"）。 */
      '<div class="bubble">' + (txt.trim() ? mdHtml(txt)
        : '<span class="dim">（这条消息的正文没能读出来）</span>') + '</div>' +
      '<div class="msg-meta">' + fmtTime(entry.timestamp) + '</div></div>');
  }

  function roleBadge(entry) {
    if (!entry || !entry.roleName) return '';
    return '<div class="role-badge" data-role="' + esc(entry.role || '') + '">' +
      '<span class="rn">' + esc(entry.roleName) + '</span>' +
      (entry.roleTitle ? '<span class="rt">' + esc(entry.roleTitle) + '</span>' : '') + '</div>';
  }

  function renderAssistant(entry) {
    const id = entry.id || ('a' + Math.random());
    if (S.seen[id]) return;
    S.seen[id] = 1;
    const text = entryAnswer(entry);
    const chips = (entry.toolCalls || []).map((t) => ({ name: t.name, arg: argLine(t.args), cls: 'done' }));
    const html = '<div class="msg ai" data-id="' + esc(id) + '">' +
      roleBadge(entry) +
      (text ? '<div class="bubble">' + mdHtml(text) + '</div>' : '') +
      chipsHtml(chips) +
      '<div class="msg-meta">' + (entry.model ? esc(entry.model) + ' · ' : '') + fmtTime(entry.timestamp) + '</div></div>';
    const node = addNode(html);
    drawUsage(node, entry.usage && entry.usage.context);
  }

  /* 工具返回的东西，上屏前先拍成一句人话：
     以前是直接 clip(原始文本) —— 于是气泡里就出现 `promise_list {"promises": []}` 这种东西，
     用户截图里读到的"JSON 尾巴"就是它。 */
  function prettyResult(txt) {
    const raw = String(txt == null ? '' : txt).trim();
    if (!raw) return '';
    if (raw[0] !== '{' && raw[0] !== '[') return raw;
    const label = (k) => KEY_LABEL[k] || k;
    const parts = [];
    const walk = (v, k) => {
      if (v == null) return;
      if (Array.isArray(v)) { parts.push(label(k) + '：' + (v.length ? v.length + ' 条' : '无')); return; }
      if (typeof v === 'object') { Object.keys(v).forEach((kk) => walk(v[kk], kk)); return; }
      parts.push((k ? label(k) + '：' : '') + String(v));
    };
    try {
      const o = JSON.parse(raw);
      if (Array.isArray(o)) walk(o, ''); else Object.keys(o).forEach((k) => walk(o[k], k));
      return parts.join(' · ') || '（没有内容）';
    } catch (e) {
      /* 不是合法 JSON（截断过）：至少把括号引号抠掉，别把裸 JSON 甩给用户 */
      return raw.replace(/[\{\}\[\]"]/g, ' ').replace(/[\s]+/g, ' ').trim();
    }
  }
  function renderToolResult(entry) {
    const id = entry.id || ('t' + Math.random());
    if (S.seen[id]) return;
    S.seen[id] = 1;
    const txt = toolResultText(entry);
    addNode('<div class="msg ai" data-id="' + esc(id) + '">' + chipsHtml([
      { name: entry.toolName, arg: clip(prettyResult(txt), 50), cls: entry.isError ? 'err' : 'done' },
    ]) + '</div>');
  }

  function renderSystem(entry) {
    const id = entry.id || ('s' + Math.random());
    if (S.seen[id]) return;
    S.seen[id] = 1;
    const txt = [entry.content && entry.content.preview, entry.text, entry.summary]
      .filter((x) => x && String(x).trim())[0] || '系统提示';
    const one = String(txt).replace(/\s+/g, ' ').trim();
    const node = addNode('<div class="msg center"><div class="msg-sys">' +
      esc(clip(one, 80)) + (one.length > 80 ? '<span class="toggle">展开</span>' : '') + '</div></div>');
    if (!node || one.length <= 80) return;
    node.addEventListener('click', () => {
      const t = node.querySelector('.msg-sys');
      const open = node.dataset.open === '1';
      node.dataset.open = open ? '0' : '1';
      t.innerHTML = open ? esc(clip(one, 80)) + '<span class="toggle">展开</span>' : esc(txt);
    });
  }

  function renderEntry(entry) {
    if (!entry || !entry.type) return;
    if (entry.type === 'user') renderUser(entry);
    else if (entry.type === 'assistant') renderAssistant(entry);
    else if (entry.type === 'tool_result') renderToolResult(entry);
    else if (entry.type === 'system') renderSystem(entry);
  }

  function emptyHtml() {
    return '<div class="chat-empty"><div class="big">和 AI 聊聊这本书</div>' +
      '可以直接提问、让它改某一章、整理设定。<br>点左下 + 看快捷指令。</div>';
  }

  /* ═══════════════ 流式渲染 ═══════════════ */
  /* `who` 是多 Agent 编排那一步的角色（主创/取上下文/查证/写手/挑刺）。
     踩过的坑：以前只按 messageId 建气泡，**编排角色徽章只有刷新后才看得到** ——
     实时那一屏是一条没有署名的回复，用户根本不知道"现在是谁在写"（e2e 抓到徽章数 0）。*/
  function ensureLive(messageId, who) {
    const el = bodyEl();
    if (!el) return null;
    if (S.live && S.live.id === messageId) return S.live;
    const node = document.createElement('div');
    node.className = 'msg ai live';
    node.innerHTML = roleBadge(who || {}) +
      '<div class="bubble"><span class="typing"><i></i><i></i><i></i></span>' +
      '<span class="txt"></span><span class="caret"></span></div><div class="chip-row"></div>';
    el.appendChild(node);
    S.live = { id: messageId, seq: (who && who.seq != null) ? who.seq : null,
      node: node, txt: node.querySelector('.txt'),
      chips: node.querySelector('.chip-row'), text: '', tools: {},
      typing: node.querySelector('.typing'), err: '', shown: 0, frames: [], pump: null };
    if (S.turnCtx) drawUsage(node, S.turnCtx);
    scrollDown();
    return S.live;
  }
  /* ── 「这一轮 AI 用了什么」的账 ──────────────────────────────────────
     用户原话：「**AI 必须真的会用那些模块和工具，并且用户看得见它用了什么**」。
     账由后端给（server/llm/prompts.py 的 digest_system：**只从真拼出来的 system 里读**，
     加上这一轮真跑过的工具与改过的文件），这里只负责画出来 + 别丢着不更新。
     ctx 为空就什么都不画（老会话没有这份账，不许凭空编一张）。 */
  function drawUsage(host, ctx) {
    if (!host || !ctx) return;
    const maker = (globalThis.UI && UI.usageCard) ? UI.usageCard : null;
    if (!maker) return;                              /* 组件层没加载时宁可不画，也不内联一套 */
    const had = host.querySelector('.usage-card');
    const open = !!(had && had.classList.contains('open'));   /* 卡片开着的时候更新，不许自己合上 */
    const card = maker(ctx, { label: toolLabel, open: open });
    if (had) had.replaceWith(card); else host.appendChild(card);
  }

  /** 第一个字到了就把「打字中」三个点收掉 */
  function dropTyping(L) {
    if (!L) return;
    if (!L.typing) L.typing = L.node ? L.node.querySelector('.typing') : null;
    if (!L.typing) return;
    try { L.typing.remove(); } catch (e) {}
    L.typing = null;
  }
  /* ── 逐字显现（打字机）────────────────────────────────────────────────
     用户原话：「**字要一个字一个字出，有光标/打字动效，能中途停止**」。
     实测（2026-09-21，两条渠道都验了）：**渠道把整段正文一次给全** ——
       · "修补站"（渠道-shim，声明 openai-responses）：`/responses` 流式只回 `data: [DONE]`，
         `/chat/completions` 流式能吐，但**一次就是一大截**（实测 2 片）；
       · 渠道 官方：`/responses` 只回**一个** `response.output_text.delta`，正文整段塞在里面。
     也就是说"一个字一个字蹦"在**链路上**做不到（不是我们没接流式 —— 后端已经两种接口都试了）。
     能做到、也必须做到的是**界面层**：分片一到先记全账（`L.text` 与 `S.turnAny` 立刻是完整正文，
     空回复检测/判据读的都是它），但**上屏**按节奏一点点显现，末尾跟一根闪的光标。
     三条规矩（都能报红）：
       ① 积压越多每拍显现越多 → 长文不会被拖成几十秒，短句就是"打字"手感；
       ② 一轮结束 / 出错 / 中断 → **立刻全部显现**（收尾必须是完整正文，不许留半截）；
       ③ 显现中气泡一直带 `.live`（光标闪）；停手就摘掉。 */
  const REVEAL_MS = 26;                    /* 每一拍的间隔 */
  /* 什么时候**不**打字：
     · 用户把「出字方式」选成 **整段**（`Prefs.chatStream === 'off'`）—— 他要的就是一次给全，
       我们不能一边说"整段"一边慢慢蹦（那是骗人）；
     · 判据钩子 `window.__chatNoType = true`（tools/e2e-chatstream.js 的反证用：
       把它打开，逐字显现这条判据必须报红 —— 证明这条判据真的在看着这个功能）。 */
  function typewriterOn() {
    if (typeof window !== 'undefined' && window.__chatNoType) return false;
    return streamPref() !== false;
  }
  function revealChars(L) {                /* 这一拍显现几个字：跟积压量走 */
    const backlog = L.text.length - L.shown;
    if (backlog <= 0) return 0;
    return Math.max(1, Math.min(48, Math.ceil(backlog / 8)));
  }
  function paintLive(L) {
    if (!L || !L.node || !L.txt) return;
    if (typeof L.text !== 'string') L.text = L.txt.textContent || '';   /* 快照来的气泡没有 text 字段 */
    if (L.shown === undefined || L.shown === null) L.shown = L.text.length;
    const shown = Math.max(0, Math.min(L.shown, L.text.length));
    const typing = shown < L.text.length;   /* 还没显现完 = 还在"打字" */
    if (typing) {
      if (!L.typing) L.typing = L.node.querySelector('.typing');
    } else if (shown > 0) dropTyping(L);
    L.txt.innerHTML = mdHtml(L.text.slice(0, shown));
    if (!L.frames) L.frames = [];
    L.frames.push([Math.round(performance.now()), shown]);   /* 帧账：什么时候画了几个字 */
    L.node.classList.toggle('live', typing);
  }
  function pumpLive(L) {                   /* 一拍一拍往前推，一拍一份 setTimeout（不用 interval） */
    if (!L || L.pump) return;
    if (L.shown >= L.text.length) return;
    L.pump = setTimeout(() => {
      L.pump = null;
      const n = revealChars(L);
      if (n > 0) { L.shown += n; paintLive(L); scrollDown(); }
      pumpLive(L);
    }, REVEAL_MS);
  }
  /** 把还没显现的一次性全放出来（收尾/报错/中断都走它，保证屏幕上永远是完整正文） */
  function flushLive(L) {
    if (!L) return;
    if (L.pump) { clearTimeout(L.pump); L.pump = null; }
    if (typeof L.text !== 'string') L.text = (L.node && L.txt) ? (L.txt.textContent || '') : '';
    L.shown = L.text.length;
    paintLive(L);
  }
  /** 一次性拿到**整段**正文时的入口（`report_result` / 快照 / 会话条目都走它）。
      为什么不直接 innerHTML 画完：这三条路给的也是**整段**（本机渠道根本不给分片），
      直接画完就是用户说的"一次性蹦出来"。这里把它塞进同一套逐字显现的队列。 */
  function liveBulk(L, txt) {
    if (!L || !L.node || !txt) return;
    if (L.text) return;                       /* 已经有正文了（分片先到）就不动，别把字弄重 */
    L.text = txt;
    L.shown = 0;
    if (typewriterOn()) pumpLive(L); else flushLive(L);
  }

  function liveAppend(messageId, delta) {
    const L = ensureLive(messageId);
    if (!L || !delta) return;
    if (L.shown === undefined) L.shown = L.text.length;   /* 这个气泡第一片：从 0 开始显现 */
    L.text += delta;                        /* 真账立刻记全（判据/空回复检测读的是这一份） */
    if (S.waitT || S.waitN) { clearWait(); S.waitN = 0; dropWaitNote(); }
    S.turnAny = (S.turnAny || '') + delta;   /* 整轮累计：编排一步一个气泡，但"这轮出没出过字"看全局 */
    if (typewriterOn()) pumpLive(L); else flushLive(L);
  }
  function liveChip(messageId, id, name, arg, cls) {
    const L = ensureLive(messageId);
    if (!L) return;
    let chip = L.tools[id];
    if (!chip) {
      const span = document.createElement('span');
      span.className = 'tool-chip';
      chip = { el: span };
      L.tools[id] = chip;
      L.chips.appendChild(span);
    }
    chip.el.className = 'tool-chip ' + (cls || '');
    chip.el.innerHTML = '<span class="nm">' + esc(toolLabel(name)) + '</span>' +
      (arg ? '<span class="ag">' + esc(clip(arg, 60)) + '</span>' : '');
    scrollDown();
  }
  function liveFinish() {
    const L = S.live;
    clearWait(); S.waitN = 0; dropWaitNote();
    if (!L) return;
    /* 收尾：**让逐字显现自己走完**（队列按积压量加速，最长也就二十几拍、约两百毫秒），
       而不是一刀切立刻画完 —— 那样"整段"这条路就又没有逐字感了。
       万一队列卡住（页面被切到后台等），600 毫秒后强制放完，屏幕上永远是完整正文。 */
    if (L.shown < L.text.length) {
      const t = L;
      setTimeout(() => { if (t.shown < t.text.length) flushLive(t); }, 600);
    } else {
      paintLive(L);
    }
    dropTyping(L);
    const c = L.node.querySelector('.caret');
    if (c) c.remove();
    L.node.classList.remove('live');
    S.lastLive = { node: L.node, text: L.text, shown: L.shown, frames: L.frames || [] };
    S.live = null;
  }

  /* 模型那边出错 / 一个字都没回 —— **必须让用户看见**。
     用户报的"发出去出不了字"就是这里以前什么都没有：错误更新被丢掉、空回复不吭声，
     界面于是干等（会话 160 那一轮 20 条事件里没有一条正文，界面也确实什么都没显示）。
     现在：气泡描红 + 写清原因 + 一个「重试」按钮（重发同一句）。 */
  function liveError(messageId, msg, opts) {
    const L = (S.live && (!messageId || S.live.id === messageId)) ? S.live
      : (S.live || S.lastLive);          /* 气泡刚收尾也能写进去（agent_end 之后才报空回复） */
    if (!L || !L.node) { App.toast(msg || '模型没有返回内容'); return; }
    const o = opts || {};
    L.err = msg || L.err || '模型没有返回内容';
    S.turnErr = L.err;
    clearWait(); S.waitN = 0; dropWaitNote();
    flushLive(L && L.node ? L : null);      /* 出错/空回复也要先把已收到的字放完，别留半截 */
    dropTyping(L && L.typing !== undefined ? L : null);
    const c = L.node.querySelector('.caret');
    if (c) c.remove();
    L.node.classList.remove('live');
    L.node.classList.add('err');
    const bub = L.node.querySelector('.bubble');
    if (bub && !bub.querySelector('.live-err')) {
      const box = document.createElement('div');
      box.className = 'live-err';
      const why = document.createElement('div');
      why.className = 'why';
      why.textContent = o.title || L.err;
      box.appendChild(why);
      if (o.detail) {
        const d = document.createElement('div');
        d.className = 'det';
        d.textContent = o.detail;
        box.appendChild(d);
      }
      const acts = document.createElement('div');
      acts.className = 'acts';
      const again = document.createElement('button');
      again.className = 'btn sm';
      again.dataset.liveRetry = '1';
      again.textContent = '重试';
      again.addEventListener('click', () => { const t = S.lastText; if (t) sendText(t); });
      acts.appendChild(again);
      if (o.model !== false) {
        const pick = document.createElement('button');
        pick.className = 'btn sm';
        pick.textContent = '换个模型';
        pick.addEventListener('click', () => modelSheet());
        acts.appendChild(pick);
      }
      box.appendChild(acts);
      bub.appendChild(box);
    }
    setStatus(String(L.err).slice(0, 24), 'err');
    scrollDown();
    S.live = null;
  }

  /* ── 「发出去一直没字」的看门狗 ────────────────────────────────────────
     用户原话：「**现在 AI 聊天，我输出东西之后，它是没办法出字儿的**」。
     第 27 轮把"渠道报错/空回复"都补上了；**还剩最后一种：渠道连得上、就是不吐字**
     （实测本机 8317 中转一次要 234 秒）。后端有硬看门狗兜底（默认 300 秒），
     但对用户来说五分钟的沉默和被冻住没区别 —— 所以界面自己先说话：
     30 秒没第一个字就写一句人话，之后每 45 秒把话说得更明白一点，并且给「换个模型」。
     一有字就把提示撤掉（不遮正文、不抢视觉）。 */
  const WAIT_MS = 30000;
  function clearWait() { if (S.waitT) { clearTimeout(S.waitT); S.waitT = null; } }
  function dropWaitNote() {
    if (S.live && S.live.node) {
      const n = S.live.node.querySelector('.live-wait');
      if (n) n.remove();
    }
    const stray = document.querySelectorAll('#chat-body > .live-wait');
    for (const n of stray) n.remove();
  }
  function waitTick(n) {
    S.waitT = null;
    if (!S.running || (S.turnAny && S.turnAny.trim())) { dropWaitNote(); return; }
    const waited = Math.round((n + 1) * WAIT_MS / 1000);
    const text = n === 0
      ? '模型还没开始回答（渠道可能慢，也可能排不上队）。继续等就行。'
      : '已经等了 ' + waited + ' 秒还没出字 —— 渠道像是卡住了。可以继续等，或者换个模型。';
    /* 优先写在"正在回的那条气泡"里；还没有气泡就写在用户那条消息下面；
       都没有（SSE 都没连上）才挂到消息区末尾 —— 总之必须让用户看得见。 */
    const host = (S.live && S.live.node && S.live.node.querySelector('.bubble'))
      || (S.pending && S.pending.el && S.pending.el.querySelector('.bubble'))
      || document.getElementById('chat-body');
    let box = host ? host.querySelector('.live-wait') : null;
    if (host && !box) {
      box = document.createElement('div');
      box.className = 'live-wait';
      host.appendChild(box);
    }
    if (box) {
      box.textContent = text;
      if (n >= 1 && !box.querySelector('button')) {
        const b = document.createElement('button');
        b.className = 'btn sm';
        b.textContent = '换个模型';
        b.addEventListener('click', () => modelSheet());
        box.appendChild(b);
      }
    }
    setStatus(n === 0 ? '等模型回答…' : '还在等模型…', 'run');
    S.waitN = n + 1;
    S.waitT = setTimeout(() => waitTick(S.waitN), WAIT_MS + 15000);
  }

  /** 这一轮跑完了，回头看它到底出没出字 —— 没出就必须补一句人话（不许静默） */
  function ensureTurnSpoke(stopStatus) {
    if (S.turnAny && S.turnAny.trim()) return;
    if (S.turnErr) return;                       /* 上面已经报过错了 */
    liveError(null, '模型没有返回内容', {
      title: stopStatus === 'aborted' ? '这一轮被停掉了，还没出字' : '模型没有返回内容',
      detail: '渠道这次没有吐正文（可能不支持这个模型 / 上下文太长 / 网络在中间断了）。' +
        '点「重试」再来一次，或点「换个模型」。',
    });
  }

  /* ═══════════════ 会话 ═══════════════ */
  async function curSlug() {
    if (window.BookCtx && BookCtx.has()) return BookCtx.slug();
    try { return await window.BookCtx.ensure() || null; } catch (e) { return null; }
  }

  async function loadSessions() {
    const slug = await curSlug();
    let d = null;
    try { d = await API.sessions(S.scopeAll ? null : slug); }
    catch (e) { if (!S.scopeAll) d = await API.sessions(null).catch(() => null); }
    const items = (d && (d.items || d.sessions)) || [];
    S.sessions = items.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return S.sessions;
  }

  function adoptSession(sess) {
    S.sid = sess.sessionId;
    S.profileKey = sess.profileKey || S.profileKey;
    S.title = sess.title || '对话';
    const m = sess.model || {};
    if (m.modelId) { S.modelName = m.modelId; S.modelKey = (m.providerConfigId ? m.providerConfigId + '/' : '') + m.modelId; }
    store.set({ sid: S.sid, profileKey: S.profileKey, modelKey: S.modelKey, modelName: S.modelName });
    refreshStrip();
  }

  async function newSession(profileKey) {
    const slug = await curSlug();
    const pk = profileKey || S.profileKey || 'leader.default';
    setStatus('新建中…', 'run');
    try {
      const sess = await API.newSession(pk, slug);
      S.profileKey = pk;
      S.seen = Object.create(null); S.lastSeq = -1; S.epoch = null;
      adoptSession(sess);
      S.title = sess.title || '新会话';
      refreshStrip();
      clearBody(emptyHtml());
      setStatus('就绪', '');
      if (sess.model && sess.model.modelId) S.modelName = sess.model.modelId;
      connect();
      refreshStrip();
      if (!profileKey) App.toast('已新建会话');
      return sess;
    } catch (e) {
      setStatus('新建失败', 'err');
      App.toast('新建会话失败：' + e.message);
      throw e;
    }
  }

  async function openSession(id, opts) {
    disconnect();
    S.sid = id;
    S.seen = Object.create(null); S.lastSeq = -1; S.epoch = null;
    S.turnCtx = null;                                  /* 上一轮的账不许跟到这一条会话来 */
    store.set({ sid: id });
    clearBody('<div class="chat-empty"><span class="spinner"></span></div>');
    setStatus('载入中…');
    let snap = null;
    try { snap = await API.snapshot(id); }
    catch (e) { setStatus('载入失败', 'err'); clearBody('<div class="chat-empty">会话打不开：' + esc(e.message) + '</div>'); return; }
    applySnapshot(snap);
    connect();
    if (opts && opts.focus) setTimeout(() => { const ta = $('#chat-input'); ta && ta.focus(); }, 120);
  }

  function applySnapshot(snap) {
    if (!snap) return;
    runReset();
    const s = snap.summary || {};
    S.title = s.title || snap.title || '对话';
    S.profileKey = s.profileKey || snap.profileKey || S.profileKey;
    const m = snap.model || s.model || {};
    if (m.modelId) { S.modelName = m.modelId; S.modelKey = (m.providerConfigId ? m.providerConfigId + '/' : '') + m.modelId; }
    S.running = !!(snap.activeInvocation || s.activeInvocation);
    /* 事件头：历史由这份快照渲染，事件流只负责"这之后"的（避免重放长出空气泡） */
    S.lastSeq = (typeof snap.lastEventSeq === 'number') ? snap.lastEventSeq : -1;
    S.invId = null;                       /* 当前这一轮的 id：只在真跑起来时认 */
    S.seen = Object.create(null);
    const entries = ((snap.history && snap.history.entries) || []);
    clearBody('');
    if (!entries.length) bodyEl().innerHTML = emptyHtml();
    entries.forEach(renderEntry);
    store.set({ profileKey: S.profileKey, modelKey: S.modelKey, modelName: S.modelName });
    refreshStrip();
    setStatus(S.running ? '回复中…' : '就绪', S.running ? 'run' : '');
    scrollDown(true);
  }

  async function refreshSnapshot() {
    if (!S.sid) return;
    try { const snap = await API.snapshot(S.sid); applySnapshot(snap); } catch (e) {}
  }

  /* ═══════════════ SSE ═══════════════ */
  function disconnect() {
    if (S.es) { try { S.es.close(); } catch (e) {} S.es = null; }
  }

  function connect() {
    disconnect();
    if (!S.sid) return;
    /* 已经读过快照了 → 从事件头之后开始收（`after=S.lastSeq`）。
       正在跑的那一轮例外：那种情况才需要把历史重放出来补课。
       （`S.lastSeq` 见 applySnapshot / session_state_changed） */
    const after = (typeof S.lastSeq === 'number' && S.lastSeq >= 0) ? S.lastSeq : 0;
    S.es = API.stream(S.sid, {
      after,
      onEvent: (data) => handleEvent(data),
      onError: () => {
        if (!S.running) setStatus('连接中断', 'err');
      },
    });
  }

  function handleEvent(data) {
    if (!data || typeof data !== 'object') return;
    const ev = data.event || {};
    const type = ev.type || '';
    if (data.eventEpoch && S.epoch && data.eventEpoch !== S.epoch) { S.lastSeq = -1; S.epoch = data.eventEpoch; }
    if (data.eventEpoch) S.epoch = data.eventEpoch;
    if (type !== 'connected' && type !== 'snapshot_required') {
      if (typeof data.seq === 'number' && data.seq <= S.lastSeq) return;
      if (typeof data.seq === 'number') S.lastSeq = data.seq;
    }

    if (type === 'connected') { setStatus(S.running ? '回复中…' : '就绪', S.running ? 'run' : ''); return; }
    if (type === 'snapshot_required') { refreshSnapshot(); return; }
    if (type === 'session_state_changed') {
      const st = (ev.state && ev.state.summary) || {};
      if (st.title) S.title = st.title;
      if (st.profileKey) S.profileKey = st.profileKey;
      const m = ev.state && ev.state.model;
      if (m && m.modelId) { S.modelName = m.modelId; S.modelKey = (m.providerConfigId ? m.providerConfigId + '/' : '') + m.modelId; }
      S.running = !!(ev.state && ev.state.activeInvocation);
      /* 当前这一轮的 id：重放的历史事件里也有 message_start，
         只认"这一轮"的才不会给上一轮再建一遍空气泡（见 e2e-chatmsg 丙）。 */
      S.invId = S.running ? (data.invocationId || S.invId || null) : null;
      if (S.running) setStatus('回复中…', 'run');
      else { liveFinish(); setStatus('就绪', ''); }
      refreshStrip();
      return;
    }
    if (type === 'session_entry') { onEntry(ev.entry); return; }
    if (type === 'orchestra_run_start') {
      S.run = { modeName: ev.modeName, steps: ev.steps || [], i: 0, done: {} };
      renderRun();
      setStatus('编排 · ' + (ev.modeName || '') + ' · ' + (ev.steps || []).length + ' 棒', 'run');
      return;
    }
    if (type === 'orchestra_step_start') {
      if (S.run) {
        S.run.i = ev.seq || 0;
        const total = (S.run.steps || []).length || 4;
        renderRun();
        setStatus('第 ' + (ev.seq || '?') + '/' + total + ' 棒 · ' + (ev.roleName || '') +
                  (ev.title ? ' · ' + ev.title : '') + ' 正在干活' +
                  (ev.handoffFrom ? '（接 ' + ev.handoffFrom + ' 的结论）' : ''), 'run');
      }
      return;
    }
    if (type === 'orchestra_step_end') {
      if (S.run) { (S.run.done = S.run.done || {})[ev.seq || 0] = true; renderRun(); }
      return;
    }
    if (type === 'orchestra_run_end') {
      if (S.run) {
        setStatus(ev.status === 'done'
          ? ('编排跑完' + ((ev.wrote || []).length ? ' · 改了 ' + ev.wrote.length + ' 个文件' : ' · 这次没有改动'))
          : ('编排结束（' + ev.status + '）'), ev.status === 'done' ? '' : 'err');
        S.run.i = 999; (S.run.steps || []).forEach((x, i) => { (S.run.done = S.run.done || {})[i + 1] = true; });
        renderRun();
      }
      return;
    }
    if (type === 'turn_context') {
      /* 后端在这一轮开始前就把它"看了什么"报过来（工具那部分边跑边补）——
         用户于是能在**等着出字的时候**就看见 AI 在读这本书的什么东西。 */
      S.turnCtx = ev.context || null;
      /* 编排是"一棒一个气泡"：这一棒的账只许画在**同一棒**的气泡上
         （少了这个判断，第 2 棒开跑时会把账画到第 1 棒那个还没收尾的泡泡上）。 */
      if (S.live && (ev.seq == null || S.live.seq === ev.seq)) drawUsage(S.live.node, S.turnCtx);
      return;
    }
    if (type === 'message_start') {
      /* ⚠ 第 42 轮：SSE 一接上，服务端会把**这个会话历史事件重放一遍**（这是补课用的）。
         上一轮已经跑完的 message_start 也会被重放 → 前端于是又长出几个"正在打字…"的气泡，
         **永远不填字**（用户看到的一屏空泡泡就是这么来的）。
         所以：**只有这一轮真的在跑**才建 live 气泡；重放的历史由快照/entry 事件负责渲染。 */
      if (!S.running) return;
      if (data.invocationId && S.invId && data.invocationId !== S.invId) return;
      if (ev.role === 'assistant') {
        const o = ev.orchestra || null;
        ensureLive(ev.messageId, o ? { role: o.role, roleName: o.roleName,
                                       roleTitle: o.title, seq: o.seq } : null);
      }
      return;
    }
    if (type === 'message_update') {
      const u = ev.update || {};
      if (u.type === 'text_delta' && u.delta) liveAppend(ev.messageId, u.delta);
      else if (u.type === 'error') {
        /* 后端把"模型调用失败"包在 message_update 里（type=error）——
           以前这里没分支，**这种更新会被直接丢掉**，用户只看到干等。 */
        const why = String(u.message || '没有说明');
        liveError(ev.messageId, /^(模型|渠道|连)/.test(why) ? why : ('模型调用失败：' + why));
      }
      else if (u.type === 'thinking_delta') { /* 思考不展示 */ }
      else if (u.type === 'toolcall_start' || u.type === 'tool_call_start') {
        liveChip(ev.messageId, u.toolCallId || u.id, u.toolName || u.name, '', 'run');
      } else if ((u.type === 'toolcall_delta' || u.type === 'tool_call_delta') && (u.toolCallId || u.id)) {
        liveChip(ev.messageId, u.toolCallId || u.id, u.toolName || u.name, argLine(u.arguments), 'run');
      }
      return;
    }
    if (type === 'tool_execution_start') {
      if (!S.running) return;                 /* 同上：重放的历史事件不许再画一遍 */
      const msg = S.live ? S.live.id : null;
      liveChip(msg, ev.toolCallId, ev.toolName, argLine(ev.args), 'run');
      setStatus('调用 ' + toolLabel(ev.toolName) + '…', 'run');
      return;
    }
    if (type === 'tool_execution_end') {
      const arg = ev.isError ? clip(toolResultText(ev), 40) : '';
      liveChip(S.live ? S.live.id : null, ev.toolCallId, ev.toolName, arg, ev.isError ? 'err' : 'done');
      if (ev.toolName === 'report_result') {
        const txt = reportTextFromArgs(ev.args) || toolResultText(ev);
        if (txt && S.live && !S.live.text) { liveBulk(S.live, txt); scrollDown(); }
      }
      setStatus('回复中…', 'run');
      return;
    }
    if (type === 'agent_end') {
      if (ev.status && ev.status !== 'completed') setStatus('已结束(' + ev.status + ')', 'err');
      S.running = false;
      liveFinish();
      ensureTurnSpoke(ev.status);
      if (S.run && S.run.i >= 900) { /* 编排自己会收尾，这里不抢 */ } else { runReset(); }
      refreshStrip();
      return;
    }
  }

  function onEntry(entry) {
    if (!entry || !entry.type) return;
    if (entry.type === 'user') {
      if (S.pending && S.pending.text === userText(entry) && !S.pending.done) {
        S.pending.done = true;
        S.pending.el.dataset.id = entry.id;
        S.pending.el.classList.remove('sending');
        S.seen[entry.id] = 1;
        S.pending = null;
        return;
      }
      renderUser(entry);
      return;
    }
    if (entry.type === 'assistant') {
      if (S.seen[entry.id]) return;
      if (S.live && !S.live.text) {
        const txt = entryAnswer(entry);
        if (txt) liveBulk(S.live, txt);          /* 同上：整段也走逐字显现 */
      }
      const ctxFull = entry.usage && entry.usage.context;
      if (S.live) {
        if (ctxFull) drawUsage(S.live.node, ctxFull);   /* 先补全，再收尾，卡片原地更新 */
        (entry.toolCalls || []).forEach((t) => {
          if (t.id && S.live.tools[t.id]) return;
        });
        liveFinish();
      }
      S.seen[entry.id] = 1;
      if (!entryAnswer(entry)) {
        // 没有正文也没有 report_result：只留 chip（工具过程）
        const chips = (entry.toolCalls || []).map((t) => ({ name: t.name, arg: argLine(t.args), cls: 'done' }));
        if (chips.length) addNode('<div class="msg ai" data-id="' + esc(entry.id) + '">' + chipsHtml(chips) + '</div>');
      }
      scrollDown();
      return;
    }
    if (entry.type === 'tool_result') { renderToolResult(entry); return; }
    if (entry.type === 'system') { renderSystem(entry); return; }
  }

  /* 出字方式：auto（默认）/ 流式 / 整段。设置存在本地 Prefs，跟着这一次发送走。 */
  function streamPref() {
    const v = (window.Prefs && Prefs.get('chatStream')) || 'auto';
    return v === 'stream' ? true : (v === 'off' ? false : undefined);
  }
  function streamLabel() {
    const v = (window.Prefs && Prefs.get('chatStream')) || 'auto';
    return v === 'stream' ? '流式' : (v === 'off' ? '整段' : '自动');
  }
  function cycleStream() {
    const v = (window.Prefs && Prefs.get('chatStream')) || 'auto';
    const next = v === 'auto' ? 'stream' : (v === 'stream' ? 'off' : 'auto');
    Prefs.set('chatStream', next);
    const b = $('#chat-stream-btn');
    if (b) b.querySelector('b').textContent = '出字 · ' + streamLabel();
    App.toast('出字方式：' + (next === 'stream' ? '流式（逐字出）'
      : next === 'off' ? '整段（一次出完）' : '自动（先流式，渠道不支持就整段）'));
  }

  /* ═══════════════ 发送 ═══════════════ */
  function pendingUser(text) {
    const node = addNode('<div class="msg me sending" data-id="p">' +
      '<div class="bubble">' + mdHtml(text) + '</div>' +
      '<div class="msg-meta">发送中…</div></div>');
    S.pending = { el: node, text: text, done: false };
    scrollDown(true);
    return node;
  }

  async function sendText(text) {
    const t = String(text == null ? ($('#chat-input') ? $('#chat-input').value : '') : text).trim();
    if (!t) return;
    if (!S.sid) {
      try { await ensureSession(); } catch (e) { return; }
    }
    if (S.running) { App.toast('AI 正在回复，先停一下再发'); return; }
    const ta = $('#chat-input');
    if (ta) { ta.value = ''; autoGrow(ta); }
    S.lastText = t;
    S.turnAny = ''; S.turnErr = ''; S.lastLive = null; S.turnCtx = null;
    pendingUser(t);
    S.running = true;
    setStatus('已发出…', 'run');
    clearWait(); dropWaitNote(); S.waitN = 0;
    S.waitT = setTimeout(() => waitTick(0), WAIT_MS);
    setSendMode();
    try {
      const r = await API.invoke(S.sid, t, S.mode, streamPref(), S.divided !== false);
      if (S.pending && S.pending.el) {
        const meta = S.pending.el.querySelector('.msg-meta');
        if (meta) meta.textContent = fmtTime(Date.now());
      }
      if (r && r.status && r.status !== 'completed' && r.status !== 'running') {
        S.running = false; refreshStrip();
      }
    } catch (e) {
      S.running = false; refreshStrip();
      if (S.pending && S.pending.el) {
        S.pending.el.classList.add('err');
        const meta = S.pending.el.querySelector('.msg-meta');
        if (meta) meta.textContent = '发送失败：' + e.message;
        S.pending = null;
      }
      App.toast('发送失败：' + e.message);
    }
  }

  async function abortRun() {
    if (!S.sid) return;
    try { await API.abort(S.sid); App.toast('已请求中断'); } catch (e) { App.toast('中断失败：' + e.message); }
  }

  async function ensureSession() {
    const saved = store.get();
    if (saved.profileKey) S.profileKey = saved.profileKey;
    let list = [];
    try { list = await loadSessions(); } catch (e) {}
    const want = S.sid || saved.sid;
    const hit = list.filter((x) => x.sessionId === want)[0];
    if (hit) { adoptSession(hit); await openSession(hit.sessionId, { focus: true }); return; }
    const first = list[0];
    if (first) { adoptSession(first); await openSession(first.sessionId, { focus: true }); return; }
    await newSession(S.profileKey);
  }

  /* ═══════════════ 抽屉：会话列表 ═══════════════ */
  async function sessionsSheet() {
    App.sheet('<div class="sheet-head"><h3>会话</h3>' +
      '<button class="btn sm" data-close>关闭</button></div><div class="picker-empty"><span class="spinner"></span></div>');
    let list = [];
    try { list = await loadSessions(); } catch (e) {
      App.sheet('<div class="sheet-head"><h3>会话</h3><button class="btn sm" data-close>关闭</button></div>' +
        '<div class="picker-empty">读不到会话列表：' + esc(e.message) + '</div>');
      return;
    }
    const rows = list.map((s) => {
      const on = s.sessionId === S.sid;
      const archived = s.archived || s.status === 'archived';
      return '<div class="sess' + (on ? ' on' : '') + '" data-id="' + s.sessionId + '">' +
        '<div class="main"><div class="t">' + esc(s.title || '未命名') + '</div>' +
        '<div class="s">' + esc(clip(s.lastMessagePreview || '', 46) || '（空会话）') +
        ' · ' + esc(fmtAgo(s.updatedAt)) + '</div></div>' +
        (archived ? '<span class="tag">已归档</span>' : '') +
        (s.status === 'running' ? '<span class="tag run">进行中</span>' : '') +
        '<button class="more" data-more="' + s.sessionId + '">' + iconHtml('more') + '</button></div>';
    }).join('');
    const html =
      '<div class="sheet-head"><h3>会话</h3><button class="btn sm" data-close>关闭</button></div>' +
      '<div class="sheet-acts">' +
      '<button class="btn sm btn-primary" data-new="1">新建会话</button>' +
      '<button class="btn sm" data-scope="1">' + (S.scopeAll ? '只看本书' : '看全部') + '</button>' +
      '<button class="btn sm" data-profile="1">换人格</button>' +
      '<button class="btn sm" data-model="1">换模型</button>' +
      '</div>' +
      (rows || '<div class="picker-empty">还没有会话，点「新建会话」开始。</div>');
    App.sheet(html, {
      onMount(p) {
        p.querySelector('[data-new]') && p.querySelector('[data-new]').addEventListener('click', () => { profileSheet(true); });
        p.querySelector('[data-scope]') && p.querySelector('[data-scope]').addEventListener('click', () => { S.scopeAll = !S.scopeAll; sessionsSheet(); });
        p.querySelector('[data-profile]') && p.querySelector('[data-profile]').addEventListener('click', () => { profileSheet(true); });
        p.querySelector('[data-model]') && p.querySelector('[data-model]').addEventListener('click', () => modelSheet());
        p.querySelectorAll('.sess').forEach((row) => {
          row.addEventListener('click', (e) => {
            if (e.target.closest('[data-more]')) return;
            const id = Number(row.dataset.id);
            App.closeSheet();
            openSession(id, { focus: true });
          });
        });
        p.querySelectorAll('[data-more]').forEach((b) => b.addEventListener('click', (e) => {
          e.stopPropagation();
          sessionActions(Number(b.dataset.more));
        }));
      },
    });
  }

  async function sessionActions(id) {
    const s = S.sessions.filter((x) => x.sessionId === id)[0] || {};
    const archived = s.archived || s.status === 'archived';
    App.sheet('<div class="sheet-head"><h3>' + esc(clip(s.title || '会话', 18)) + '</h3>' +
      '<button class="btn sm" data-close>关闭</button></div>' +
      '<div class="quick">' +
      '<button data-a="rename">' + iconHtml('edit') + '<span class="qt"><b>重命名</b><span>给这个会话起个名字</span></span></button>' +
      (archived
        ? '<button data-a="restore">' + iconHtml('refresh') + '<span class="qt"><b>恢复</b><span>移出归档</span></span></button>'
        : '<button data-a="archive">' + iconHtml('trash') + '<span class="qt"><b>归档</b><span>收起来，不再出现在列表里</span></span></button>') +
      '</div>', {
      onMount(p) {
        p.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', async () => {
          const a = b.dataset.a;
          /* rename 要接着弹一个输入框：走 closeSheet(回调) —— 同一拍"关完立刻弹"会让两层动画打架 */
          if (a === 'rename') App.closeSheet(() => {
            App.modal('<div style="font-size:var(--t-base);margin-bottom:var(--sp-3)">会话名字</div>' +
              '<input id="rn" class="input" value="' + esc(s.title || '') + '">' +
              '<div style="display:flex;gap:var(--sp-3);margin-top:var(--sp-4)">' +
              '<button class="btn btn-block" data-close>取消</button>' +
              '<button class="btn btn-primary btn-block" id="rn-ok">保存</button></div>', {
              onMount(mp) {
                const inp = mp.querySelector('#rn');
                inp.focus(); inp.select();
                mp.querySelector('#rn-ok').addEventListener('click', async () => {
                  const v = inp.value.trim();
                  if (!v) return App.toast('名字不能为空');
                  App.closeModal();
                  try {
                    await API.command(id, { command: 'rename', title: v });
                    if (id === S.sid) { S.title = v; refreshStrip(); }
                    App.toast('已重命名');
                    await loadSessions();
                  } catch (e) { App.toast('重命名失败：' + e.message); }
                });
              },
            });
          });
          if (a === 'rename') return;
          App.closeSheet();
          try {
            await API.command(id, { command: a === 'archive' ? 'archive' : 'restore' });
            App.toast(a === 'archive' ? '已归档' : '已恢复');
            if (a === 'archive' && id === S.sid) { S.sid = null; store.set({ sid: null }); await ensureSession(); }
            await loadSessions();
          } catch (e) { App.toast('操作失败：' + e.message); }
        }));
      },
    });
  }

  /* ═══════════════ 抽屉：人格 / 模型 ═══════════════ */
  async function profileSheet(forNew, showAll) {
    App.sheet('<div class="sheet-head"><h3>选人格</h3><button class="btn sm" data-close>关闭</button></div>' +
      '<div class="sheet-note">' + (forNew ? '选一个角色，然后新建会话。' : '下次新建会话时用这个人格。') + '</div>' +
      '<div class="picker-empty"><span class="spinner"></span></div>');
    let list = [];
    try {
      const d = await API.chatProfiles();
      const all = Array.isArray(d) ? d : (d.profiles || d.items || []);
      const byKey = {};
      all.forEach((p) => { byKey[p.profileKey] = p; });
      const keys = showAll ? PROFILES : PROFILE_CORE;
      list = keys.filter((k) => byKey[k]).map((k) => {
        const p = byKey[k];
        return {
          profileKey: k,
          name: (p && p.name) || k,
          description: PROFILE_NOTE[k] || (p && p.description) || '',
        };
      });
    } catch (e) {
      App.sheet('<div class="sheet-head"><h3>选人格</h3><button class="btn sm" data-close>关闭</button></div>' +
        '<div class="picker-empty">读不到人格列表：' + esc(e.message) + '</div>');
      return;
    }
    const cur = forNew ? (store.get().profileKey || S.profileKey) : S.profileKey;
    const items = list.map((p) => '<div class="picker-item' + (p.profileKey === cur ? ' on' : '') + '" data-k="' + esc(p.profileKey) + '">' +
      '<div class="nm"><b>' + esc(p.name || p.profileKey) + '</b><div class="desc">' + esc(p.description || '') + '</div></div>' +
      (p.profileKey === cur ? '<span class="ck">当前</span>' : '') + '</div>').join('');
    App.sheet('<div class="sheet-head"><h3>选人格</h3><button class="btn sm" data-close>关闭</button></div>' +
      '<div class="sheet-note">' + (forNew ? '选一个角色，然后新建会话。' : '下次新建会话时用这个人格。') + '</div>' +
      '<div class="sheet-acts"><button class="btn sm" data-toggle-all="1">' +
      (showAll ? '收起，只看写作角色' : '更多角色（跑团 / 世界引擎等）') + '</button></div>' +
      (items || '<div class="picker-empty">没有可用人格</div>'), {
      onMount(p) {
        p.querySelector('[data-toggle-all]') && p.querySelector('[data-toggle-all]')
          .addEventListener('click', () => profileSheet(forNew, !showAll));
        p.querySelectorAll('.picker-item').forEach((it) => it.addEventListener('click', async () => {
          const k = it.dataset.k;
          App.closeSheet();
          if (forNew) { S.profileKey = k; store.set({ profileKey: k }); await newSession(k); }
          else { S.profileKey = k; store.set({ profileKey: k }); refreshStrip(); App.toast('已选人格：' + k); }
        }));
      },
    });
  }

  let modelTimer = null;
  async function modelSheet(q) {
    const cur = S.modelKey;
    if (q === undefined) {
      App.sheet('<div class="sheet-head"><h3>选模型</h3><button class="btn sm" data-close>关闭</button></div>' +
        '<div class="picker-search"><input id="md-q" class="input" type="search" placeholder="搜模型名 / 渠道"></div>' +
        '<div id="md-list" class="picker-empty"><span class="spinner"></span></div>', {
        onMount(p) {
          const inp = p.querySelector('#md-q');
          inp.addEventListener('input', () => {
            clearTimeout(modelTimer);
            modelTimer = setTimeout(() => { renderModels(inp.value.trim()); }, 220);
          });
          renderModels('');
        },
      });
      return;
    }
    renderModels(q);
  }

  async function renderModels(q) {
    const box = $('#md-list');
    if (!box) return;
    box.className = 'picker-empty';
    box.innerHTML = '<span class="spinner"></span>';
    let d = null;
    try { d = await API.appModels(q || ''); }
    catch (e) { box.innerHTML = '读不到模型列表：' + esc(e.message); return; }
    const list = (d && d.models) || [];
    if (!list.length) { box.className = 'picker-empty'; box.innerHTML = '没找到匹配的模型'; return; }
    const top = list.slice(0, 80);
    box.className = '';
    box.innerHTML = top.map((m) => '<div class="picker-item' + (m.key === S.modelKey ? ' on' : '') + '" data-k="' + esc(m.key) + '">' +
      '<div class="nm"><b>' + esc(m.name) + '</b><div class="desc">' + esc(m.provider || '') + ' · ' + esc(m.key) + '</div></div>' +
      (m.key === S.modelKey ? '<span class="ck">当前</span>' : '') +
      /* 每行右侧的「⋯」：调这个模型自己的参数（上下文 1M/256K、推理、高级 JSON）。
         用户点名"三个点要放的就是这个地方" —— 就是这张「选模型」列表。
         面板复用预设页那一个（Preset.modelParams），不写第二套。 */
      '<button type="button" class="md-more" data-more="' + esc(m.key) + '" data-src="' + esc(m.provider || '')
      + '" aria-label="这个模型的参数">\u22ef</button>' + '</div>').join('') +
      (list.length > top.length ? '<div class="picker-empty">还有 ' + (list.length - top.length) + ' 个，输入关键词再筛</div>' : '');
    $$('.md-more', box).forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();                      // 别让它顺带把模型切了
      try { window.Preset.modelParams(b.dataset.more, b.dataset.src); } catch (err) {}
    }));
    $$('.picker-item', box).forEach((it) => it.addEventListener('click', async (e) => {
      if (e.target.closest('.md-more')) return;  // 点的是「⋯」，不算选中
      const k = it.dataset.k;
      /* 给某个编排角色定点换模型：换完**就地**把这张面板换成渠道页（不再先关再开） */
      if (MS.role) { const role = MS.role; MS.role = ''; await applyModelRole(role, k); modelsSetupSheet(); return; }
      App.closeSheet();
      await setModel(k);
    }));
  }

  /* ═══════════════ 模型与渠道（AI 对话的专门设置）═══════════════
     用户原话：「**AI 对话也得有专门的设置**，可以**设置一些模型商**之类的，
     **就是可以自己增加，然后自己拉取**这种」，还有「默认模型 / 备用模型」。
     这里的每一件事都对应后端一个只增不减的接口：
       GET  /api/config/models/providers   —— 渠道清单（密钥只回"配没配"）
       POST /api/config/models/provider    —— 自己加渠道
       POST /api/config/models/pull        —— 自己拉取模型（打这家 /models）
       POST /api/config/models/default     —— 默认模型
       POST /api/config/models/fallback    —— 备用模型（主模型不出字时自动换）
       POST /api/config/models/book        —— 这本书用哪个模型
     ⚠ 密钥**只往后端送、从不回显**（回显等于泄漏）。 */
  const ROLE_NAME = { def: '默认模型', fb: '备用模型', book: '这本书用' };
  let MS = { role: '', slug: '', book: '' };

  function msHead(title) {
    return '<div class="sheet-head"><h3>' + esc(title) + '</h3>' +
      '<button class="btn sm" data-close>关闭</button></div>';
  }

  async function modelsSetupSheet(role, key) {
    if (role) {                                   /* 选完模型往回写 */
      await applyModelRole(role, key);
      return modelsSetupSheet();
    }
    App.sheet(msHead('模型与渠道') +
      '<div class="sheet-note" style="margin:0 var(--sp-4) var(--sp-3)">' +
      '默认模型给所有会话用；备用模型在主模型这一轮没出字时自动顶上；' +
      '「这本书用」只影响当前打开的书。密钥只存在服务器上，界面不回显。</div>' +
      '<div id="ms-setup-body"><div class="picker-empty"><span class="spinner"></span></div></div>' +
      /* 联网搜索跟"用哪个模型"是同一件事的两半（用哪个脑子 / 能不能上网），
         所以放在同一张设置里；这一块跟大设置页共用同一份实现（js/websearch.js）。 */
      '<div id="ms-web"><div class="picker-empty"><span class="spinner"></span></div></div>', {
      onMount(p) { drawSetup(p); drawWeb(p); },
    });
  }

  /* 联网搜索那一节（大设置页 / 这里共用 js/websearch.js） */
  async function drawWeb(p) {
    const box = p.querySelector('#ms-web') || document.getElementById('ms-web');
    if (!box) return;
    let d = null;
    try { d = await WebCfg.load(true); }
    catch (e) { box.innerHTML = '<div class="picker-empty">读不到联网设置：' + esc(e.message) + '</div>'; return; }
    box.innerHTML = WebCfg.groupHtml(d, { id: 'webcfg', test: true });
    WebCfg.wire(box, { data: d, redraw: () => modelsSetupSheet() });
  }

  async function drawSetup(p) {
    const box = p.querySelector('#ms-setup-body') || $('#ms-setup-body');
    if (!box) return;
    const slug = (window.BookCtx && BookCtx.slug && BookCtx.slug()) || '';
    MS.slug = slug;
    let d = null;
    try { d = await API.modelsProviders(); }
    catch (e) { box.innerHTML = '<div class="picker-empty">读不到渠道：' + esc(e.message) + '</div>'; return; }
    const provs = (d && d.providers) || [];
    const cur = S.modelKey || '';
    let bookKey = '';
    try { bookKey = (await API.nb('api/config/models/book?slug=' + encodeURIComponent(slug))).modelKey || ''; }
    catch (e) { /* 读不到就当没指定 */ }
    MS.book = bookKey;
    const row = (role, label, value, sub) =>
      '<div class="settings-row" style="display:flex;align-items:center;gap:var(--sp-2)">' +
      '<span class="k" style="flex:0 0 auto"><b>' + esc(label) + '</b><small>' + esc(sub) + '</small></span>' +
      '<span class="grow" style="flex:1;min-width:0;text-align:right;color:var(--ink-3);font-size:var(--t-sm);' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(value || '（没设）') + '</span>' +
      '<button class="btn sm" data-role="' + role + '">换</button></div>';
    box.innerHTML =
      '<h3>这台机器现在用哪个</h3><div class="settings-group">' +
      row('def', ROLE_NAME.def, d && d.default, '所有会话的兜底') +
      row('fb', ROLE_NAME.fb, d && d.fallback, '主模型没出字时自动顶上') +
      row('book', ROLE_NAME.book, bookKey, slug ? ('当前书：' + slug.slice(0, 16)) : '还没选书') +
      row('session', '这条会话', cur, '只影响正在聊的这一条') +
      '</div>' +
      '<h3>渠道（' + provs.length + ' 个）</h3><div class="settings-group" id="ms-prov"></div>' +
      '<div class="sheet-acts" style="margin-top:var(--sp-3)">' +
      '<button class="btn sm btn-primary" data-act="add-prov">加一个渠道</button>' +
      '<button class="btn sm" data-act="refresh">刷新</button></div>' +
      '<div id="ms-prov-out" class="sheet-note" style="margin:var(--sp-3) var(--sp-4)"></div>';
    const list = box.querySelector('#ms-prov');
    if (!provs.length) list.innerHTML = '<div class="picker-empty">还没有渠道，点下面「加一个渠道」</div>';
    else {
      list.innerHTML = provs.map((x) =>
        '<div class="sess" style="cursor:default" data-pid="' + x.id + '">' +
        '<div class="main"><div class="t">' + esc(x.name) + (x.enabled ? '' : ' · 已停用') + '</div>' +
        '<div class="s">' + esc([x.modelApi, (x.models || 0) + ' 个模型',
          x.keyConfigured ? ('密钥 ' + esc(x.keyTail || '已配')) : '没配密钥'].join(' · ')) + '</div></div>' +
        '<button class="btn sm" data-pull="' + x.id + '">获取模型</button>' +
        '<button class="more" data-del="' + x.id + '" aria-label="删除渠道">' + iconHtml('close') + '</button></div>'
      ).join('');
    }
    box.querySelectorAll('[data-role]').forEach((b) => b.addEventListener('click', () => {
      MS.role = b.dataset.role;
      if (b.dataset.role === 'book' && !MS.slug) { App.toast('先打开一本书再设「这本书用」'); return; }
      pickModelFor(b.dataset.role);
    }));
    box.querySelectorAll('[data-pull]').forEach((b) => b.addEventListener('click', async () => {
      const pid = b.dataset.pull;
      const out = box.querySelector('#ms-prov-out');
      b.disabled = true; b.textContent = '获取中…';
      out.textContent = '正在问这家服务有哪些模型…（最多 25 秒）';
      let r = null;
      try { r = await API.modelsPull({ providerId: Number(pid) }); }
      catch (e) { out.textContent = '没取到：' + e.message; }
      if (r) {
        out.textContent = r.ok
          ? ('找到 ' + r.found + ' 个模型，存了 ' + r.saved + ' 个' + (r.note ? '（' + r.note + '）' : ''))
          : ('没取到：' + (r.error || '') + (r.hint ? '；' + r.hint : ''));
      }
      b.disabled = false; b.textContent = '获取模型';
      drawSetup(box.closest('.sheet-panel') || document);
    }));
    box.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
      const id = Number(b.dataset.del);
      App.confirm('删掉这个渠道？用它跑过的会话会退回默认模型。', async () => {
        try { await API.providerDelete(id); App.toast('已删掉渠道'); } catch (e) { App.toast('删不掉：' + e.message); }
        modelsSetupSheet();
      }, '删掉');
    }));
    const add = box.querySelector('[data-act="add-prov"]');
    if (add) add.addEventListener('click', () => addProviderSheet());
    const rf = box.querySelector('[data-act="refresh"]');
    if (rf) rf.addEventListener('click', () => modelsSetupSheet());
  }

  const API_TYPES = [['openai-completions', 'OpenAI 兼容（/chat/completions）'],
    ['openai-responses', 'Responses 接口（/responses）']];

  async function addProviderSheet() {
    let tpls = [];
    try { tpls = ((await API.providerTemplates()) || {}).templates || []; } catch (e) { /* 模板读不到就手填 */ }
    App.sheet(msHead('加一个渠道') +
      '<div class="sheet-note" style="margin:0 var(--sp-4) var(--sp-3)">' +
      '地址要写到 /v1 那一层（例：https://api.deepseek.com/v1）。密钥只发给服务器，不回显。</div>' +
      '<div class="settings-group">' +
      '<div class="settings-row stack"><span class="k">常用服务商</span>' +
      '<div class="seg grid" id="ap-tpl">' + tpls.map((t) =>
        '<button data-t="' + esc(t.id) + '">' + esc(t.name) + '</button>').join('') + '</div></div>' +
      '<div class="settings-row"><span class="k">名字</span>' +
      '<input class="input" id="ap-name" placeholder="随便起，比如 我的deepseek"></div>' +
      '<div class="settings-row"><span class="k">地址</span>' +
      '<input class="input" id="ap-base" placeholder="https://…/v1"></div>' +
      '<div class="settings-row"><span class="k">密钥</span>' +
      '<input class="input" id="ap-key" type="password" placeholder="sk-…"></div>' +
      '<div class="settings-row"><span class="k">接口类型</span>' +
      '<select class="input" id="ap-api">' + API_TYPES.map(([v, l]) =>
        '<option value="' + v + '">' + esc(l) + '</option>').join('') + '</select></div>' +
      '</div>' +
      '<div id="ap-out" class="sheet-note" style="margin:var(--sp-3) var(--sp-4)"></div>' +
      '<div class="sheet-acts"><button class="btn sm btn-primary" data-act="save">保存</button>' +
      '<button class="btn sm" data-act="save-pull">保存并获取模型</button></div>', {
      onMount(p) {
        const out = p.querySelector('#ap-out');
        p.querySelectorAll('#ap-tpl button').forEach((b) => b.addEventListener('click', () => {
          p.querySelectorAll('#ap-tpl button').forEach((x) => x.classList.remove('on'));
          b.classList.add('on');
          const t = tpls.filter((x) => x.id === b.dataset.t)[0];
          if (!t) return;
          if (!p.querySelector('#ap-name').value) p.querySelector('#ap-name').value = t.name;
          if (t.baseUrl) p.querySelector('#ap-base').value = t.baseUrl;
          p.querySelector('#ap-api').value = t.defaultModelApi || 'openai-completions';
        }));
        const save = async (thenPull) => {
          const body = { name: p.querySelector('#ap-name').value.trim(),
            baseUrl: p.querySelector('#ap-base').value.trim(),
            apiKey: p.querySelector('#ap-key').value.trim(),
            modelApi: p.querySelector('#ap-api').value };
          if (!body.name || !body.baseUrl) { out.textContent = '名字和地址都要填'; return; }
          out.textContent = '保存中…';
          let r = null;
          try { r = await API.providerSave(body); }
          catch (e) { out.textContent = '保存失败：' + e.message; return; }
          out.textContent = '已保存渠道「' + body.name + '」';
          if (!thenPull) { modelsSetupSheet(); return; }
          out.textContent += '，正在获取模型…';
          let pr = null;
          try { pr = await API.modelsPull({ providerId: r.id }); }
          catch (e) { out.textContent += ' 没取到：' + e.message; return; }
          out.textContent += pr.ok
            ? ('找到 ' + pr.found + ' 个模型，存了 ' + pr.saved + ' 个')
            : ('没取到：' + (pr.error || '') + (pr.hint ? '；' + pr.hint : ''));
          setTimeout(() => modelsSetupSheet(), 1200);
        };
        p.querySelector('[data-act="save"]').addEventListener('click', () => save(false));
        p.querySelector('[data-act="save-pull"]').addEventListener('click', () => save(true));
      },
    });
  }

  async function applyModelRole(role, key) {
    try {
      if (role === 'def') { await API.modelsDefault(key); App.toast('默认模型已换'); }
      else if (role === 'fb') { await API.modelsFallback(key); App.toast('备用模型已换'); }
      else if (role === 'book') { await API.modelsBook(MS.slug, key); App.toast('这本书的模型已换'); }
      else await setModel(key);
    } catch (e) { App.toast('没换成：' + e.message); }
  }

  /** 选模型（带"选了之后写到哪"的角色）。跟会话换模型复用同一套列表渲染。 */
  async function pickModelFor(role) {
    const title = role === 'session' ? '这条会话用哪个' : (ROLE_NAME[role] || '选模型');
    App.sheet(msHead(title) +
      '<div class="picker-search"><input id="md-q" class="input" type="search" placeholder="搜模型名 / 渠道"></div>' +
      '<div id="md-list" class="picker-empty"><span class="spinner"></span></div>' +
      '<div class="sheet-acts"><button class="btn sm" data-act="back">返回设置</button>' +
      (role === 'book' || role === 'fb' ? '<button class="btn sm" data-act="clear">取消指定</button>' : '') +
      '</div>', {
      onMount(p) {
        const inp = p.querySelector('#md-q');
        inp.addEventListener('input', () => {
          clearTimeout(modelTimer);
          modelTimer = setTimeout(() => { renderModels(inp.value.trim()); }, 220);
        });
        renderModels('');
        p.querySelector('[data-act="back"]').addEventListener('click', () => modelsSetupSheet());
        const c = p.querySelector('[data-act="clear"]');
        if (c) c.addEventListener('click', () => { applyModelRole(role, ''); setTimeout(() => modelsSetupSheet(), 300); });
      },
    });
  }

  async function setModel(key) {
    if (!S.sid) { try { await ensureSession(); } catch (e) { return; } }
    try {
      await API.command(S.sid, { command: 'model', modelKey: key });
      S.modelKey = key;
      S.modelName = key.split('/').slice(1).join('/') || key;
      store.set({ modelKey: key, modelName: S.modelName });
      refreshStrip();
      App.toast('已换模型');
    } catch (e) { App.toast('换模型失败：' + e.message); }
  }

  /* ═══════════════ 抽屉：快捷指令 ═══════════════ */
  async function quickSheet() {
    App.sheet('<div class="sheet-head"><h3>快捷指令</h3><button class="btn sm" data-close>关闭</button></div>' +
      '<div class="sheet-note">先填进输入框，你改完再点发送。</div>' +
      '<div class="quick">' +
      '<button data-q="chapter">' + iconHtml('edit') + '<span class="qt"><b>改当前章节</b><span>带上正在看的这一章，说明要改什么</span></span></button>' +
      '<button data-q="next">' + iconHtml('spark') + '<span class="qt"><b>续写下一段</b><span>接着最新一章往下写</span></span></button>' +
      '<button data-q="polish">' + iconHtml('text') + '<span class="qt"><b>润色一段</b><span>贴一段文字让它改顺</span></span></button>' +
      '<button data-q="typo">' + iconHtml('check') + '<span class="qt"><b>校对错别字</b><span>检查当前章节的错字与标点</span></span></button>' +
      '<button data-q="summary">' + iconHtml('list') + '<span class="qt"><b>本章小结</b><span>概括当前章节写了什么</span></span></button>' +
      '<button data-q="ask">' + iconHtml('search') + '<span class="qt"><b>问设定</b><span>就本书设定提问</span></span></button>' +
      '</div>', {
      onMount(p) {
        p.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', async () => {
          App.closeSheet();
          await fillQuick(b.dataset.q);
        }));
      },
    });
  }

  async function curChapter() {
    const slug = await curSlug();
    try {
      const p = Progress.get(slug);
      if (p && p.path) return { path: p.path, name: String(p.path).split('/').pop().replace(/\.md$/, '') };
    } catch (e) {}
    try {
      const d = await API.book(slug);
      const ch = (d.chapters || [])[0];
      if (ch) return { path: ch.path, name: ch.name };
    } catch (e) {}
    return null;
  }

  async function fillQuick(kind) {
    const ta = $('#chat-input');
    if (!ta) return;
    let text = '';
    if (kind === 'chapter' || kind === 'typo' || kind === 'summary') {
      setStatus('找当前章节…');
      const ch = await curChapter();
      setStatus('就绪');
      const ref = ch ? '《' + ch.name + '》（' + ch.path + '）' : '当前章节';
      if (kind === 'chapter') text = '【改当前章节】请修改' + ref + '：\n\n要改的地方：\n1. \n2. \n\n要求：只动这一章，保持既有设定与文风。';
      if (kind === 'typo') text = '【校对】请检查' + ref + '里的错别字、标点和不通顺的句子，只列出问题和建议，先不要改文件。';
      if (kind === 'summary') text = '【小结】请用 5 条要点概括' + ref + '写了什么，并指出埋下的伏笔。';
    } else if (kind === 'next') {
      text = '【续写】请接着最新一章往下写下一段（300 字左右），保持同一视角与文风。先给草稿，我确认后再写进正文。';
    } else if (kind === 'polish') {
      text = '【润色】下面这段帮我改顺（不改情节，只改表达）：\n\n';
    } else if (kind === 'ask') {
      text = '【问设定】关于本书的设定：\n';
    }
    ta.value = text;
    autoGrow(ta);
    ta.focus();
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
    App.toast('已填入，改完再发');
  }

  /* ═══════════════ 输入框 ═══════════════ */
  function autoGrow(ta) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(140, Math.max(42, ta.scrollHeight)) + 'px';
  }

  function wire() {
    if (S.wired) return;
    S.wired = true;
    ensureStrip();
    const send = $('#chat-send');
    if (send) send.addEventListener('click', () => { if (S.running) abortRun(); else sendText(); });
    const plus = $('#chat-plus');
    if (plus) plus.addEventListener('click', () => quickSheet());
    const ta = $('#chat-input');
    if (ta) {
      ta.addEventListener('input', () => autoGrow(ta));
      const coarse = window.matchMedia && window.matchMedia('(pointer:coarse)').matches;
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !coarse) { e.preventDefault(); sendText(); }
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const m = $('#modal');
      if (m && !m.classList.contains('hidden')) App.closeModal();
    });
  }

  /* ═══════════════ 常用指令（第 19 轮新功能 ②，用户要的「一键把话说完」）═══════════════
     站在写小说的人的角度：**90% 的话是重复的**（"接着写 800 字""这段改口语一点"），
     而手机上打这些字最烦。所以攒一排自己常用的，点一下就发出去。
     规矩：
       · **按书存**（后端 quick_cmd 带 slug）——这本的指令不会串到那本；
       · 点一条 = 直接把这句话发给 AI（走的是同一个 sendText，不另开一条路）；
       · 长按一条 = 删掉；末尾「＋」= 加一条；
       · 读不到就明说"读不到常用指令"，不装作没有。 */
  let quickBar = null, quickItems = [], quickSlug = '';
  /* 常用指令条住进**抽屉**里（跟"干活方式/人格/模型"一起）。
     为什么：它原来插在消息区前面，白白又占一行（监督人量的 50px / 6%）——
     而用户的原话是「可以滑动的地方很少，可以看到的东西也少」，消息区必须尽量大。
     指令是"控件"，控件就该跟控件住一起（抽屉默认收起，展开就看得见、点了就发出去）。 */
  function quickBarEl() {
    if (quickBar) return quickBar;
    const d = ensureDrawer();
    if (!d) return null;
    const host = d.querySelector('#chat-drawer-body');
    if (!host) return null;
    quickBar = document.createElement('div');
    quickBar.className = 'chat-quick';
    quickBar.id = 'chat-quick';
    host.insertBefore(quickBar, host.firstChild);
    return quickBar;
  }
  async function refreshQuick() {
    const el = quickBarEl();
    if (!el) return;
    const slug = (window.BookCtx && BookCtx.slug && BookCtx.slug()) || '';
    quickSlug = slug;
    if (!slug) { el.innerHTML = ''; el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    try {
      const d = await API.nb('api/quick?slug=' + encodeURIComponent(slug));
      quickItems = (d && d.items) || [];
    } catch (e) {
      el.innerHTML = '<span class="cq-hint">读不到常用指令：' + esc(e.message) + '</span>';
      return;
    }
    paintQuick();
  }
  function paintQuick() {
    const el = quickBarEl(); if (!el) return;
    /* data-hscroll：这一条本来就是“横滑的一排指令”，显式声明给 UI 体检脚本看
       （判据不再拿 overflow-x:auto 猜，见 tools/e2e-uicheck.js）。 */
    el.innerHTML = '<div class="cq-scroll" data-hscroll>' +
      quickItems.map((c, i) => '<button class="cq-chip" data-i="' + i + '">' + esc(c.text) + '</button>').join('') +
      '<button class="cq-chip add" data-add="1">' + iconHtml('plus') + '<span>加一条</span></button>' +
      '</div>';
    el.querySelectorAll('.cq-chip').forEach((b) => {
      let lp = null, fired = false;
      b.addEventListener('pointerdown', () => {
        fired = false;
        lp = setTimeout(async () => {                       /* 长按 = 删掉这条 */
          lp = null; fired = true;
          const i = Number(b.dataset.i);
          const cmd = quickItems[i];
          if (!cmd) return;
          const yes = await App.confirm('删掉「' + cmd.text + '」？', () => {}, '删掉');
          if (!yes) return;
          try {
            await API.nb('api/quick?slug=' + encodeURIComponent(quickSlug) + '&id=' + cmd.id,
              { method: 'DELETE', body: {} });
            App.toast('删了');
            refreshQuick();
          } catch (e) { App.toast('删不掉：' + e.message); }
        }, 520);
      });
      const cancel = () => { if (lp) { clearTimeout(lp); lp = null; } };
      b.addEventListener('pointerup', cancel);
      b.addEventListener('pointercancel', cancel);
      b.addEventListener('pointermove', cancel);
      b.addEventListener('click', async () => {
        if (fired) { fired = false; return; }
        if (b.dataset.add) { addQuick(); return; }
        const cmd = quickItems[Number(b.dataset.i)];
        if (!cmd) return;
        App.haptic(6);
        sendText(cmd.text);            /* 走同一个发消息入口，不另写一套 */
      });
    });
  }
  async function addQuick() {
    if (!quickSlug) { App.toast('先选一本书'); return; }
    const v = await App.ask('加一条常用指令', '', { placeholder: '例：接着写 800 字，别赶进度' });
    if (!v || !String(v).trim()) return;
    try {
      await API.nb('api/quick', { method: 'POST', body: { slug: quickSlug, text: String(v).trim() } });
      App.toast('加好了');
      refreshQuick();
    } catch (e) { App.toast('加不上：' + e.message); }
  }

  /* ═══════════════ 导出 ═══════════════ */
  /* 换书：整屏重来（会话、消息、滚动位置都不是上一本的）。
     这就是用户要的隔离：「切到第二本，它看不到第一本」。 */
  function resetForBook() {
    disconnect();
    S.sid = null; S.inited = false; S.title = '';
    S.seen = Object.create(null); S.lastSeq = -1; S.epoch = null;
    clearBody('');
    setStatus('换书了…');
  }
  function switchBook() {
    const slug = (window.BookCtx && BookCtx.slug()) || '';
    if (slug === S.bookSlug) return;
    S.bookSlug = slug;
    refreshQuick();                      /* 换书 → 常用指令也跟着换（这本的指令不串到那本） */
    store.migrate();
    resetForBook();
    S.inited = true;
    setStatus('载入会话…');
    ensureSession().then(() => setStatus('就绪')).catch(() => setStatus('就绪'));
  }

  window.Chat = {
    onShow() {
      wire();
      ensureStrip();
      refreshQuick();
      loadModes();
      if (window.BookCtx) BookCtx.mount('chat-book', () => switchBook());
      const bk = (window.BookCtx && BookCtx.slug()) || '';
      if (bk && bk !== S.bookSlug) { S.bookSlug = bk; store.migrate(); resetForBook(); }
      refreshStrip();
      if (S.inited && S.sid) { refreshStrip(); return; }
      S.inited = true;
      const saved = store.get();
      if (saved.mode) S.mode = saved.mode;
      if (saved.profileKey && PROFILES.indexOf(saved.profileKey) >= 0) S.profileKey = saved.profileKey;
      else S.profileKey = 'leader.default';
      if (saved.modelKey) { S.modelKey = saved.modelKey; S.modelName = saved.modelName || saved.modelKey.split('/').pop(); }
      setStatus('载入会话…');
      ensureSession().then(() => setStatus('就绪')).catch(() => {});
    },
    /* 判据专用入口：**跟气泡走的是同一条渲染管线**（mdHtml → stripAgentNoise），
       不是另写一套。为什么要它：会话里一条消息都没有时（比如刚开的新会话），
       tools/e2e-chatsafe.js 那条"气泡里没有 JSON 残留"的判据会变成**空判据**
       —— 空判据比没有更坏，所以给判据一个"渲染一段文本，看看会不会漏残留"的入口。 */
    renderText(src) { return mdHtml(src); },
    /* 判据入口：「这一轮用了什么」那张卡片（跟气泡里画的是同一个组件）。 */
    usageCard(ctx, opt) { return (globalThis.UI && UI.usageCard) ? UI.usageCard(ctx, opt) : null; },
    /* 判据专用入口：把一条 SSE 事件喂给**真正在处理它的那个函数**（handleEvent），
       省得判据自己另写一套"我以为的"解析（那种判据谁都不信）。
       tools/e2e-chatstream.js 用它证：模型报错时界面**确实会显示出原因 + 重试**。 */
    feed(ev) { handleEvent(ev); return 1; },
    /* 判据入口：**这一轮气泡的显现账**（画了几帧、每帧几个字、什么时候画满）。
       tools/e2e-chatstream.js 的「乙」用它在页面里以 20 毫秒的节奏采样：
       用户看到的"一个字一个字出"就是这些帧，不是脚本自己造的样本。 */
    revealLog() {
      const L = S.live || S.lastLive;
      return (L && L.frames) ? L.frames.slice() : [];
    },
    /* 判据入口：读/写「出字方式」（auto / 流式 / 整段），跟那颗按钮走同一份 Prefs。 */
    streamMode(v) {
      if (v === undefined) return (window.Prefs && Prefs.get('chatStream')) || 'auto';
      if (window.Prefs) Prefs.set('chatStream', v);
      const b = $('#chat-stream-btn');
      if (b) b.textContent = streamLabel(v);
      return v;
    },
    lastText() { return S.lastText || ''; },
    /* 判据入口：抽屉开合（e2e 要按用户真实路径量"收起时消息区 ≥70% 屏高"） */
    drawer(open) {
      const d = ensureDrawer();
      if (!d) return null;
      if (open === undefined) return d.classList.contains('open');
      (S.drawerSet || (() => {}))(!!open);
      return d.classList.contains('open');
    },
    menu() { sessionsSheet(); },
    /* 判据入口：把「模型与渠道」那块设置打开（e2e 要按用户真实路径点进去看） */
    modelsSetup() { return modelsSetupSheet(); },
    sessions() { return S.sessions; },
    open(id, opts) { return openSession(id, opts); },
    newSession(pk) { return newSession(pk); },
    send(text) { return sendText(text); },
    quick(kind) { return fillQuick(kind); },
    /* 供其它面板（设定编辑器）把草稿塞进输入框，不发送。 */
    draft(text) {
      wire(); ensureStrip();
      const ta = $('#chat-input');
      if (!ta) return;
      ta.value = String(text || '');
      autoGrow(ta);
      try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) {}
      ta.focus();
    },
    state: S,
  };
})();
