/* ============================================================
   studio.js — 新加的那一批「工作室」面板：写作台 / 世界 / 剧情 / 质检 /
   统计 / 导出导入 / 听书 / 主题 / 术语 / 素材 / 日志。

   三条自己给自己定的规矩（用户强调过，见 docs/10 第六节）：
   1. 只用 tools.css / base.css 里已有的通用件和 CSS 变量，不另造一套样式；
   2. 面板一律走 `Tools.ui.push()`（顶部有返回、返回键逐层退），
      需要输入就走 `Tools.ui.ask()`；不开第二套栈、不开第二个水波纹；
   3. 每个按钮点了必须有反馈，失败一定说出为什么（不许静默）。
   ============================================================ */
(function () {
  'use strict';

  /* 复用 tools.js 的那一套（栈、loading、empty、问框、项目选择…）——
     这里**不重新实现**，免得像以前那样冒出两套水波纹。 */
  const U = () => window.Tools && window.Tools.ui;
  const nb = (p, o) => window.API.nb(p, o);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const qs = (o) => Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const ico = (n) => '<span class="tr-ico">' + window.iconHtml(n) + '</span>';
  const toast = (m) => { try { App.toast(m); } catch (e) {} };
  const hap = () => { try { App.haptic(8); } catch (e) {} };
  const push = (t, r) => U().push(t, r);
  const loading = (h, m) => U().loading(h, m);
  const empty = (h, m, i) => U().empty(h, m, i);
  const ask = (...a) => U().ask(...a);
  const confirmBox = (...a) => U().confirmBox(...a);
  const projects = () => U().projects();
  const pickProject = (h, cb) => U().pickProject(h, cb);
  /* 当前书：跟书有关的面板都用这一条（tools.js 里唯一那份实现），别各自弹书单 */
  const Push = { book: (t, r, o) => U().pushBook(t, r, o), curSlug: () => U().curSlug() };
  const ago = (t) => U().ago(t);
  const ts = (t) => U().ts(t);

  /* ── 常用的请求小件 ── */
  const get = (p, q) => nb(p + (q ? '?' + qs(q) : ''));
  const post = (p, body, q) => nb(p + (q ? '?' + qs(q) : ''), { method: 'POST', body: body || {} });
  const del = (p, q) => nb(p + (q ? '?' + qs(q) : ''), { method: 'DELETE', body: {} });

  /* 质检章节列表的排序方式：false = 按章节号（默认），true = 按分数（最脏的在前） */
  let lintByScore = false;

  const money = (n) => (Math.round((Number(n) || 0) * 1000) / 1000).toString();
  const KIND_CN = { character: '角色', place: '地点', faction: '势力', item: '物品',
                    system: '体系', concept: '概念', creature: '生物' };
  const STATUS_CN = { idea: '灵感', outline: '大纲', detail: '细纲', draft: '草稿',
                      polished: '润色', final: '定稿' };

  /* 章节选择：什么面板要挑章都走它 */
  function chapterPicker(host, slug, cb, opts) {
    opts = opts || {};
    loading(host, '读目录…');
    get('/api/book', { slug }).then((d) => {
      const chs = d.chapters || [];
      if (!chs.length) { empty(host, '这本书还没有章节', 'file'); return; }
      host.innerHTML = '<div class="t-hint" style="margin:0 0 var(--sp-3)">'
        + esc(opts.hint || '点一章开始') + '</div><div class="t-list">' + chs.map((c, i) =>
          '<div class="t-row" data-i="' + i + '">' + ico('file') +
          '<div class="tr-main"><div class="tr-title">' + esc(c.name || c.path) + '</div>' +
          '<div class="tr-sub">' + esc((c.words || 0) + ' 字') + '</div></div>' +
          '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('') + '</div>';
      host.querySelectorAll('[data-i]').forEach((r) => {
        r.onclick = () => { hap(); cb(chs[Number(r.dataset.i)]); };
      });
    }).catch((e) => empty(host, '读不到目录：' + e.message));
  }

  /* 流式写作：后端吐 SSE（data: {...}），这里边收边画 */
  async function streamWrite(path, body, on) {
    const r = await fetch(window.API.abs('api/write/' + path), {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    if (r.status === 401) { App.needLogin(); throw new Error('未登录'); }
    if (!r.ok) {
      let msg = '请求失败 ' + r.status;
      try { const d = await r.json(); msg = d.detail || msg; } catch (e) {}
      throw new Error(msg);
    }
    const rd = r.body.getReader(); const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        if (chunk.indexOf('data: ') !== 0) continue;
        let ev = null;
        try { ev = JSON.parse(chunk.slice(6)); } catch (e) { continue; }
        on(ev);
      }
    }
  }

  /* ══════════════════════════════════════════════════════════
     1. 写作台：生成 / 续写 / 改写 / 细纲 / 润色（设定自动注入）
     ══════════════════════════════════════════════════════════ */
  function openWrite(host) { Push.book('写作台', writeHome); }

  async function writeHome(host, slug) {
    loading(host, '看写作台…');
    let st, ov;
    try {
      st = await get('/api/write/status', { slug });
      ov = await get('/api/plot/overview', { slug });
    } catch (e) { empty(host, '读不到：' + e.message); return; }
    const chs = ov.chapters || [];
    const done = chs.filter((c) => ['polished', 'final'].includes(c.status)).length;
    host.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (st.words || 0) + '</b><span>全书字数</span></div>' +
      '<div class="t-stat"><b>' + chs.length + '</b><span>章节</span></div>' +
      '<div class="t-stat"><b>' + done + '</b><span>已润色/定稿</span></div>' +
      '</div>' +
      (st.ready ? '' :
        '<div class="t-form" style="margin-bottom:var(--sp-4)"><div class="t-field"><label>还没法开写</label>' +
        '<div class="t-hint" style="margin:0">' + esc(st.why || '没有可用模型') +
        '：去「工具 → 模型」里配一个，或在「预设」里选一个模型。</div></div></div>') +
      '<div class="t-bar"><button class="t-btn" data-newch>新建一章</button>' +
      '<button class="t-btn" data-ctx>它会读到什么</button></div>' +
      '<div class="t-bar"><button class="t-btn" data-batch>批量</button>' +
      '<button class="t-btn" data-pipe>流水线</button>' +
      '<button class="t-btn" data-purposes>用哪些模型</button></div>' +
      '<div class="t-list">' + (chs.length ? chs.map((c, i) =>
        '<div class="t-row" data-i="' + i + '">' + ico('file') +
        '<div class="tr-main"><div class="tr-title">' + esc(c.title || c.path) + '</div>' +
        '<div class="tr-sub">' + esc([(c.words || 0) + ' 字',
          STATUS_CN[c.status] || c.status || '草稿',
          c.target_words ? ('目标 ' + c.target_words) : '',
          c.outline && c.outline.length ? (c.outline.length + ' 条细纲') : '还没细纲',
          (c.cast && c.cast.length) ? ('出场 ' + c.cast.length + ' 人') : '',
          (c.events && c.events.length) ? (c.events.length + ' 个关键事件') : '',
        ].filter(Boolean).join(' · ')) + '</div></div>' +
        '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('')
        : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">还没有章节，点上面「新建一章」</div></div></div>') +
      '</div>';
    host.querySelectorAll('[data-i]').forEach((r) => {
      r.onclick = () => { hap(); const c = chs[Number(r.dataset.i)]; push('写 · ' + (c.title || c.path), (h2) => chapterStudio(h2, slug, c)); };
    });
    host.querySelector('[data-newch]').onclick = async () => {
      const name = await ask('新的一章叫什么', '', { placeholder: '例：第006章-雪夜之后' });
      if (!name) return;
      const p = 'manuscript/' + name.replace(/[\/\\]/g, '_') + (name.endsWith('.md') ? '' : '.md');
      try { await post('/api/chapter/new', { slug, path: p, content: '' }); toast('建好了'); hap(); writeHome(host, slug); }
      catch (e) { toast('建不了：' + e.message); }
    };
    host.querySelector('[data-ctx]').onclick = async () => {
      const path = st.lastChapter || '';
      if (!path) { toast('先写一章，才有上下文可看'); return; }
      push('它会读到什么', (h2) => contextView(h2, slug, path));
    };
    host.querySelector('[data-batch]').onclick = () => { hap(); push('批量', (h2) => batchView(h2, slug)); };
    host.querySelector('[data-pipe]').onclick = () => { hap(); push('流水线', (h2) => pipelineView(h2, slug)); };
    host.querySelector('[data-purposes]').onclick = () => {
      hap();
      const p = st.purposes || {};
      const rows = [['planner', '规划', '细纲、大纲'], ['writer', '写正文', '真正落笔'],
                    ['polish', '润色改写', '润色、行内 AI'], ['fast', '杂活', '摘要、起名']]
        .map(([k, n, h]) => '<div class="t-row static">' + ico('cpu') +
          '<div class="tr-main"><div class="tr-title">' + n + '</div>' +
          '<div class="tr-sub">' + esc(p[k] || '还没配模型') + ' · ' + h + '</div></div></div>').join('');
      App.sheet('<div class="sheet-head"><h3>这次会用哪些模型</h3>' +
        '<button class="btn sm" data-close>关闭</button></div>' +
        '<div style="padding:0 var(--sp-4) calc(var(--safe-b) + var(--sp-4))">' +
        '<div class="t-hint" style="margin:0 0 var(--sp-3)">想按用途分模型（规划用大模型、润色用便宜的），' +
        '去「工具 → 模型 → 模型组」建一个并启用。</div>' +
        '<div class="t-list">' + rows + '</div></div>');
    };
  }

  /* ══════════════════════════════════════════════════════════
     1.1 批量：一次处理多章（后台任务，进度和每一步结果都摊开）
     ══════════════════════════════════════════════════════════ */
  const BATCH_MODES = [['outline', '写细纲'], ['polish', '润色'], ['summary', '写摘要'],
                       ['chapter', '写正文'], ['continue', '续写']];

  async function batchView(host, slug) {
    loading(host, '读目录…');
    let d;
    try { d = await get('/api/book', { slug }); } catch (e) { empty(host, '读不到：' + e.message); return; }
    const chs = d.chapters || [];
    if (!chs.length) { empty(host, '这本书还没有章节', 'file'); return; }
    let mode = 'outline';
    const sel = {};
    const paintBatch = () => {
      const n = Object.keys(sel).filter((k) => sel[k]).length;
      host.innerHTML =
        '<div class="t-hint" style="margin:0 0 var(--sp-3)">挑几章，选一件事，一次跑完。' +
        '跑的时候是后台任务，可以退出去干别的；<b>正文和润色会先记进「改动」，等你确认才算数</b>。</div>' +
        '<div class="t-seg wide" data-modes>' + BATCH_MODES.map(([k, n2]) =>
          '<button class="' + (k === mode ? 'on' : '') + '" data-m="' + k + '">' + n2 + '</button>').join('') + '</div>' +
        '<div class="t-bar" style="margin-top:var(--sp-4)"><button class="t-btn" data-all>全选</button>' +
        '<button class="t-btn" data-none>全不选</button>' +
        '<button class="t-btn pri" data-go>开始（' + n + ' 章）</button></div>' +
        '<div class="t-list">' + chs.map((c, i) =>
          '<div class="t-row" data-ch="' + i + '">' + ico(sel[c.path] ? 'check' : 'file') +
          '<div class="tr-main"><div class="tr-title">' + esc(c.name || c.path) + '</div>' +
          '<div class="tr-sub">' + esc((c.words || 0) + ' 字') + '</div></div>' +
          (sel[c.path] ? '<span class="t-pill ok">选了</span>' : '') + '</div>').join('') + '</div>' +
        '<div data-job></div>';
      host.querySelector('[data-modes]').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-m]'); if (!b) return;
        hap(); mode = b.dataset.m; paintBatch();
      });
      host.querySelectorAll('[data-ch]').forEach((r) => {
        r.onclick = () => { const c = chs[Number(r.dataset.ch)]; sel[c.path] = !sel[c.path]; hap(); paintBatch(); };
      });
      host.querySelector('[data-all]').onclick = () => { chs.forEach((c) => { sel[c.path] = true; }); hap(); paintBatch(); };
      host.querySelector('[data-none]').onclick = () => { chs.forEach((c) => { sel[c.path] = false; }); hap(); paintBatch(); };
      host.querySelector('[data-go]').onclick = async () => {
        const paths = chs.filter((c) => sel[c.path]).map((c) => c.path);
        if (!paths.length) { toast('先挑几章'); return; }
        const box = host.querySelector('[data-job]');
        box.innerHTML = '<div class="t-load"><i></i><div class="t-hint" style="margin-top:var(--sp-3)">交给后台…</div></div>';
        let r;
        try { r = await window.API.writeBatch({ slug: slug, mode: mode, paths: paths, apply: true }); }
        catch (e) { box.innerHTML = '<div class="t-empty">跑不起来：' + esc(e.message) + '</div>'; return; }
        toast('跑起来了，进度在下面'); hap();
        window.Tools.Jobs.watch(r.jobId,
          (dd) => window.Tools.ui.paintJob(box, dd, { jobId: r.jobId }),
          (dd) => {
            window.Tools.ui.paintJob(box, dd || {}, { jobId: r.jobId });
            toast(dd && dd.status === 'done' ? '跑完了' : '任务结束了');
          });
      };
    };
    paintBatch();
  }

  /* ══════════════════════════════════════════════════════════
     1.2 流水线：把「细纲→正文→润色」这类套路存成一条命令
     ══════════════════════════════════════════════════════════ */
  const STEP_CN = { outline: '写细纲', write: '写正文', continue: '往下续写', polish: '润色',
                    summary: '写摘要', lint: '质检' };

  async function pipelineView(host, slug) {
    loading(host, '读流水线…');
    let d;
    try { d = await window.API.workflows(slug); } catch (e) { empty(host, '读不到：' + e.message); return; }
    const items = d.items || [];
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">一条流水线 = 几步连着跑。跑起来是后台任务，' +
      '退出去也不影响；每一步的结果跑完都能回看。</div>' +
      '<div class="t-bar"><button class="t-btn pri" data-new>新建一条</button>' +
      '<button class="t-btn" data-reload>刷新</button></div>' +
      '<div class="t-list">' + items.map((w, i) =>
        '<div class="t-row" data-i="' + i + '">' + ico('spark') +
        '<div class="tr-main"><div class="tr-title">' + esc(w.name) + '</div>' +
        '<div class="tr-sub wrap">' + esc((w.steps || []).map((x) => STEP_CN[x.kind] || x.kind).join(' → ')) +
        (w.slug ? ' · 只给这本书用' : ' · 所有书都能用') + '</div></div>' +
        '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('') + '</div>' +
      '<div data-run></div>';
    host.querySelectorAll('[data-i]').forEach((r) => {
      r.onclick = () => { hap(); workflowRun(host, slug, items[Number(r.dataset.i)]); };
    });
    host.querySelector('[data-new]').onclick = () => {
      ask('流水线叫什么', '', { placeholder: '例：一章到底', host: host }).then((name) => {
        if (!name) return;
        workflowEdit(host, slug, { name: name, slug: slug, steps: [] });
      });
    };
    host.querySelector('[data-reload]').onclick = () => pipelineView(host, slug);
  }

  function workflowRun(host, slug, wf) {
    const box = host.querySelector('[data-run]') || host;
    box.innerHTML = '<div class="t-bar" style="margin-top:var(--sp-4)"><button class="t-btn" data-go>跑「' + esc(wf.name) + '」</button>' +
      '<button class="t-btn" data-edit>改步骤</button></div>';
    box.querySelector('[data-go]').onclick = () => {
      hap();
      push('挑一章', (h2) => chapterPicker(h2, slug, async (c) => {
        h2.innerHTML = '<div class="t-load"><i></i><div class="t-hint" style="margin-top:var(--sp-3)">交给后台…</div></div>';
        let r;
        try { r = await window.API.workflowRun({ slug: slug, id: wf.id, path: c.path, name: wf.name }); }
        catch (e) { empty(h2, '跑不起来：' + e.message); return; }
        const out = document.createElement('div');
        h2.innerHTML = '';
        h2.appendChild(out);
        toast('跑起来了'); hap();
        window.Tools.Jobs.watch(r.jobId, (dd) => window.Tools.ui.paintJob(out, dd, { jobId: r.jobId }),
          (dd) => {
            window.Tools.ui.paintJob(out, dd || {}, { jobId: r.jobId });
            toast(dd && dd.status === 'done' ? '跑完了' : '任务结束了');
          });
      }, { hint: '这条流水线要跑在哪一章上' }));
    };
    box.querySelector('[data-edit]').onclick = () => { hap(); workflowEdit(host, slug, wf); };
  }

  function workflowEdit(host, slug, wf) {
    const steps = (wf.steps || []).map((x) => Object.assign({}, x));
    const paintWf = () => {
      host.innerHTML =
        '<div class="t-hint" style="margin:0 0 var(--sp-3)">' + esc(wf.name) + '：按顺序跑下面这几步。' +
        '点一步能上移/删掉。</div>' +
        '<div class="t-list">' + (steps.length ? steps.map((x, i) =>
          '<div class="t-row" data-s="' + i + '">' + ico('spark') +
          '<div class="tr-main"><div class="tr-title">' + (i + 1) + '. ' + esc(STEP_CN[x.kind] || x.kind) + '</div>' +
          '<div class="tr-sub">' + esc(x.kind === 'lint' ? '本地查 AI 味，不花钱' : '会调模型，结果先记进「改动」') + '</div></div>' +
          '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('')
          : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">还没有步骤，下面加一步</div></div></div>') + '</div>' +
        '<div class="t-bar" style="margin-top:var(--sp-3)"><button class="t-btn" data-add>加一步</button>' +
        '<button class="t-btn pri" data-save>保存</button></div>' +
        (wf.id ? '<div class="t-bar"><button class="t-btn dan" data-del>删掉这条流水线</button></div>' : '');
      host.querySelectorAll('[data-s]').forEach((r) => {
        r.onclick = () => {
          const i = Number(r.dataset.s);
          App.sheet('<div class="sheet-head"><h3>第 ' + (i + 1) + ' 步</h3>' +
            '<button class="btn sm" data-close>关闭</button></div>' +
            '<div style="padding:0 var(--sp-4) var(--sp-5)"><div class="t-bar"><button class="t-btn pri" data-up>上移一步</button>' +
            '<button class="t-btn dan" data-rm>删掉</button></div></div>');
          const pn = document.getElementById('sheet-panel');
          pn.querySelector('[data-up]').onclick = () => {
            if (i > 0) { const t = steps[i - 1]; steps[i - 1] = steps[i]; steps[i] = t; }
            App.closeSheet(); hap(); paintWf();
          };
          pn.querySelector('[data-rm]').onclick = () => { steps.splice(i, 1); App.closeSheet(); hap(); paintWf(); };
        };
      });
      host.querySelector('[data-add]').onclick = () => {
        App.sheet('<div class="sheet-head"><h3>加一步</h3><button class="btn sm" data-close>关闭</button></div>' +
          '<div style="padding:0 var(--sp-4) var(--sp-5)"><div class="t-list">' +
          Object.keys(STEP_CN).map((k) => '<div class="t-row" data-k="' + k + '">' + ico('spark') +
            '<div class="tr-main"><div class="tr-title">' + STEP_CN[k] + '</div></div></div>').join('') +
          '</div></div>');
        const pn = document.getElementById('sheet-panel');
        pn.querySelectorAll('[data-k]').forEach((r) => {
          r.onclick = () => { steps.push({ kind: r.dataset.k }); App.closeSheet(); hap(); paintWf(); };
        });
      };
      host.querySelector('[data-save]').onclick = async () => {
        if (!steps.length) { toast('至少加一步'); return; }
        try {
          await window.API.workflowSave({ slug: wf.slug === '' ? '' : slug, name: wf.name, steps: steps, note: wf.note || '' });
          toast('存好了'); hap(); pipelineView(host, slug);
        } catch (e) { toast('存不了：' + e.message); }
      };
      const delBtn = host.querySelector('[data-del]');
      if (delBtn) delBtn.onclick = async () => {
        if (!(await confirmBox('删掉流水线「' + wf.name + '」？', true))) return;
        try { await window.API.workflowDelete(wf.id, wf.slug || ''); toast('删了'); hap(); pipelineView(host, slug); }
        catch (e) { toast('删不了：' + e.message); }
      };
    };
    paintWf();
  }

  async function contextView(host, slug, path) {
    loading(host, '摊开上下文…');
    let d;
    try { d = await get('/api/write/context', { slug, path, mode: 'continue' }); }
    catch (e) { empty(host, '读不到：' + e.message); return; }
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">每次动笔前，这些内容会被一起交给 AI（共 ' +
      esc(d.chars) + ' 字）。这里让你看清它到底知道什么，不神秘。</div>' +
      '<h2 class="st-h">写作规矩</h2><div class="t-pre">' + esc(d.system) + '</div>' +
      '<h2 class="st-h">这一次的要求</h2><div class="t-pre">' +
      esc((d.messages || []).map((m) => m.content).join('\n\n')) + '</div>';
  }

  async function chapterStudio(host, slug, ch) {
    loading(host, '打开这一章…');
    let doc, outs;
    try {
      doc = await get('/api/chapter', { slug, path: ch.path });
      outs = await get('/api/plot/outline', { slug, path: ch.path });
    } catch (e) { empty(host, '读不到：' + e.message); return; }
    let text = doc.content || '';
    const outlines = outs.items || [];
    /* 这一章要用哪几条参考范文（写的时候随提示词一起喂进去） */
    let chosenRefs = [];
    host.innerHTML =
      '<div class="t-seg wide" data-tabs>' +
      '<button class="on" data-tab="draft">正文</button>' +
      '<button data-tab="outline">细纲</button>' +
      '<button data-tab="info">这一章的设置</button></div>' +
      '<div data-pane="draft" style="margin-top:var(--sp-3)">' +
        '<textarea class="t-area mono" data-src placeholder="这一章还没写。可以让它先写细纲，再按细纲出正文。">' +
        esc(text) + '</textarea>' +
        '<div class="t-hint" style="margin:var(--sp-2) 0 var(--sp-3)"><span data-count></span></div>' +
        '<div class="t-bar"><button class="t-btn pri" data-save>保存正文</button>' +
        '<button class="t-btn" data-continue>接着往下写</button>' +
        '<button class="t-btn" data-polish>润色这一章</button></div>' +
        '<div class="t-bar"><button class="t-btn" data-rewrite>改选中这段</button>' +
        '<button class="t-btn" data-chapter>按细纲写整章</button>' +
        '<button class="t-btn" data-refs>参考范文 <b data-refn>0</b></button></div>' +
        '<div data-out></div>' +
      '</div>' +
      '<div data-pane="outline" hidden></div>' +
      '<div data-pane="info" hidden></div>';

    const ta = host.querySelector('[data-src]');
    const out = host.querySelector('[data-out]');
    const count = host.querySelector('[data-count]');
    const refreshCount = () => {
      const n = (ta.value.match(/[\u4e00-\u9fa5]/g) || []).length;
      count.textContent = n + ' 字（汉字）';
    };
    refreshCount();
    ta.addEventListener('input', refreshCount);

    host.querySelector('[data-tabs]').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]'); if (!b) return;
      hap();
      host.querySelectorAll('[data-tabs] button').forEach((x) => x.classList.toggle('on', x === b));
      host.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
      if (b.dataset.tab === 'outline') renderOutline();
      if (b.dataset.tab === 'info') renderInfo();
    });

    /* 存正文：带着「我读到的服务器是哪一版」去存。
       两边都改过 → 让用户挑（两份都留着，不闷头覆盖）；
       没网 → 先存在本机，网一来自动推回去（工具 → 同步）。 */
    async function saveChapter(text) {
      try {
        const r = await nb('api/chapter', { method: 'PUT', body: {
          slug, path: ch.path, content: text, expectedMtimeMs: doc.mtimeMs } });
        doc.mtimeMs = r.mtimeMs;
        return true;
      } catch (e) {
        if (e.offline) {
          window.Offline && Offline.queueWrite(slug, ch.path, text, doc.mtimeMs);
          toast('现在没网，先存在本机了；有网会自动推回去');
          return false;
        }
        if (e.status === 409 && e.data && e.data.conflict) {
          const info = { id: e.data.conflictId, localText: text, serverText: e.data.serverText };
          const choice = await window.Tools.Conflicts.ask(info);
          if (choice === null) return false;
          try {
            const r = await window.Tools.Conflicts.resolve(info, choice);
            if (choice === 'server') {
              const d2 = await get('/api/chapter', { slug, path: ch.path });
              ta.value = d2.content || '';
              doc.mtimeMs = d2.mtimeMs;
              toast('用了服务器那版');
            } else {
              const t = (choice && choice.merged != null) ? choice.merged : text;
              ta.value = t;
              doc.mtimeMs = (r && r.mtimeMs) || 0;
              toast('存好了');
            }
            refreshCount();
          } catch (e2) { toast('处理冲突失败：' + e2.message); return false; }
          return true;
        }
        toast('存不了：' + e.message);
        return false;
      }
    }

    host.querySelector('[data-save]').onclick = async () => {
      if (await saveChapter(ta.value)) { toast('存好了'); hap(); }
    };

    /* 写完一个候选：写进正文 / 追加 / 丢弃。写进去走 origin=model → 先记进「改动」等确认。 */
    async function offerResult(kind, res) {
      const t = (res.text || '').trim();
      out.innerHTML =
        '<h2 class="st-h">AI 写好了' + (res.words ? '（' + res.words + ' 字）' : '') + '</h2>' +
        '<div class="t-pre selectable">' + esc(t || '（空）') + '</div>' +
        '<div class="t-bar"><button class="t-btn pri" data-apply>' +
        (kind === 'continue' ? '接到正文末尾' : '替换整章正文') + '</button>' +
        '<button class="t-btn" data-copy>复制</button>' +
        '<button class="t-btn dan" data-drop>不要</button></div>' +
        '<div class="t-hint">写进去的内容会先记进「改动」，你确认后才生效；不满意可以退回。</div>';
      out.querySelector('[data-apply]').onclick = async () => {
        const next = kind === 'continue'
          ? (ta.value.replace(/\s*$/, '') + '\n\n' + t) : t;
        // 走同一个保存口子：AI 写的东西也是「一次改动」，撞上冲突照样交给用户决定
        if (await saveChapter(next)) { ta.value = next; refreshCount(); toast('写进去了'); hap(); }
      };
      out.querySelector('[data-copy]').onclick = () => {
        try { navigator.clipboard.writeText(t); toast('复制了'); } catch (e) { toast('复制不了'); }
      };
      out.querySelector('[data-drop]').onclick = () => { out.innerHTML = ''; toast('不要就不要'); };
    }

    async function run(kind, extra) {
      if (!window.__writeReady || true) { /* 每次重新判断，别缓存状态 */ }
      if (!(await writeReady(slug))) return;
      const mode = kind === 'continue' ? 'continue' : kind === 'chapter' ? 'chapter'
        : kind === 'polish' ? 'polish' : 'rewrite';
      const body = Object.assign({ slug, path: ch.path, mode, stream: true, apply: false,
                                  refs: chosenRefs.slice() }, extra || {});
      out.innerHTML = '<div class="t-load"><i></i><div class="t-hint" style="margin-top:var(--sp-3)">'
        + (mode === 'continue' ? '接着往下写…' : mode === 'polish' ? '润色中…' : '写正文…') + '</div></div>';
      let acc = '';
      App.keepAlive && App.keepAlive(true);        // 写正文可能好几分钟：切后台也别被系统收掉
      const pre = document.createElement('div');
      const paint = () => {
        out.innerHTML = '<h2 class="st-h">正在写</h2><div class="t-pre selectable" data-live>' + esc(acc) + '</div>';
        const l = out.querySelector('[data-live]');
        if (l) l.scrollTop = l.scrollHeight;
      };
      try {
        await streamWrite('generate', body, (ev) => {
          if (ev.type === 'delta') { acc += ev.delta; paint(); }
          else if (ev.type === 'notice') { toast(ev.notice); }
          else if (ev.type === 'error') { throw new Error(ev.error); }
          else if (ev.type === 'done') {
            const text = ev.text || acc;
            if (!text) { out.innerHTML = '<div class="t-empty">它什么都没写出来，再试一次或换个模型</div>'; return; }
            offerResult(mode === 'continue' ? 'continue' : 'replace',
                        { text, words: ev.words });
          }
        });
      } catch (e) {
        out.innerHTML = '<div class="t-empty">写不动了：' + esc(e.message) + '</div>';
      } finally {
        App.keepAlive && App.keepAlive(false);
      }
      void pre;
    }

    host.querySelector('[data-continue]').onclick = () => run('continue', {
      instruction: '接着上文往下写，承接当前的场景和情绪，不要重复上文。', targetWords: 600 });
    host.querySelector('[data-polish]').onclick = () => run('polish', {});
    host.querySelector('[data-chapter]').onclick = () => run('chapter', { targetWords: ch.target_words || 2500 });
    const refBtn = host.querySelector('[data-refs]');
    if (refBtn) refBtn.onclick = () => {
      hap();
      push('挑参考范文', (h) => refPicker(h, slug, chosenRefs, () => {
        host.querySelector('[data-refn]').textContent = chosenRefs.length;
      }));
    };
    host.querySelector('[data-rewrite]').onclick = async () => {
      const sel = String(ta.value).substring(ta.selectionStart || 0, ta.selectionEnd || 0).trim();
      if (!sel) { toast('先在正文里选中一段'); return; }
      const note = await ask('这段要怎么改', '', { placeholder: '例：删掉解释句，动作写具体一点' });
      if (note === null) return;
      run('rewrite', { selection: sel, instruction: note });
    };

    /* ── 细纲 ── */
    async function renderOutline() {
      const pane = host.querySelector('[data-pane="outline"]');
      pane.innerHTML = '<div class="t-bar"><button class="t-btn pri" data-gen>让 AI 写细纲</button>' +
        '<button class="t-btn" data-add>自己写一条</button></div>' +
        '<div class="t-hint" style="margin-bottom:var(--sp-3)">细纲会被自动带进正文写作的上下文里。</div>' +
        '<div data-list></div>';
      const list = pane.querySelector('[data-list]');
      const paintList = () => {
        list.innerHTML = outs.length
          ? '<div class="t-list">' + outs.map((o, i) =>
            '<div class="t-row static">' + ico(o.approved ? 'check' : 'file') +
            '<div class="tr-main"><div class="tr-title" style="white-space:pre-wrap;font-weight:var(--w-normal)">' +
            esc(o.body) + '</div><div class="tr-sub">' + esc([o.level, o.approved ? '已采用' : '待确认'].join(' · ')) +
            '</div></div>' +
            (o.approved ? '' : '<button class="t-btn sm" data-ok="' + i + '">采用</button>') +
            '<button class="t-btn sm dim" data-rm="' + i + '">删</button></div>').join('') + '</div>'
          : '<div class="t-empty">这一章还没有细纲</div>';
        list.querySelectorAll('[data-ok]').forEach((b) => {
          b.onclick = async () => {
            const o = outs[Number(b.dataset.ok)];
            try { await post('/api/plot/outline/approve', { slug, ids: [o.id] }); hap(); refresh(); }
            catch (e) { toast('用不了：' + e.message); }
          };
        });
        list.querySelectorAll('[data-rm]').forEach((b) => {
          b.onclick = async () => {
            const o = outs[Number(b.dataset.rm)];
            if (!(await confirmBox('删掉这条细纲？'))) return;
            try { await del('/api/plot/outline', { slug, id: o.id }); refresh(); }
            catch (e) { toast('删不掉：' + e.message); }
          };
        });
      };
      const refresh = async () => {
        try { outs = (await get('/api/plot/outline', { slug, path: ch.path })).items || []; } catch (e) {}
        paintList();
      };
      paintList();
      pane.querySelector('[data-add]').onclick = async () => {
        const body = await ask('写一条细纲', '', { placeholder: '谁、在哪、做了什么、结果、留什么钩子', multiline: true });
        if (!body) return;
        try { await post('/api/plot/outline', { slug, path: ch.path, body, level: 'detail' }); refresh(); }
        catch (e) { toast('存不了：' + e.message); }
      };
      pane.querySelector('[data-gen]').onclick = async () => {
        if (!(await writeReady(slug))) return;
        list.innerHTML = '<div class="t-load"><i></i><div class="t-hint" style="margin-top:var(--sp-3)">想细纲…</div></div>';
        try {
          const r = await post('/api/write/outline', { slug, path: ch.path, save: true, maxTokens: 900 });
          if (!r.text) { list.innerHTML = '<div class="t-empty">没生成出来，再试一次</div>'; return; }
          toast('细纲写好了，看过再用'); hap(); refresh();
        } catch (e) { list.innerHTML = '<div class="t-empty">生成不了：' + esc(e.message) + '</div>'; }
      };
    }

    /* ── 这一章的设置（状态机 / 目标字数 / 视角 / 信息控制）── */
    function renderInfo() {
      const pane = host.querySelector('[data-pane="info"]');
      const meta = ch.info_control_json ? safeJson(ch.info_control_json) : {};
      pane.innerHTML =
        '<div class="t-form">' +
        '<div class="t-field"><label>这一章写到哪一步了</label><div class="t-seg wide" data-status>' +
        Object.keys(STATUS_CN).map((k) => '<button data-v="' + k + '" class="' +
          (ch.status === k ? 'on' : '') + '">' + STATUS_CN[k] + '</button>').join('') + '</div></div>' +
        '<div class="t-field"><label>目标字数</label><input class="t-input" data-tw type="number" value="' +
        esc(ch.target_words || 0) + '"></div>' +
        '<div class="t-field"><label>视角 / 叙事</label><input class="t-input" data-pov value="' +
        esc(ch.pov || '') + '" placeholder="例：第三人称限知（主角）"></div>' +
        '<div class="t-field"><label>这一章想让读者知道什么</label><textarea class="t-area" data-info rows="3">' +
        esc(meta['读者知'] || '') + '</textarea></div>' +
        '<div class="t-field"><label>什么人还不知道 / 要瞒着</label><textarea class="t-area" data-hide rows="2">' +
        esc(meta['隐瞒'] || '') + '</textarea></div>' +
        '<div class="t-field"><label>出场角色（逗号隔开）</label><input class="t-input" data-cast value="' +
        esc((ch.cast || []).join('，')) + '" placeholder="例：主角，老人"></div>' +
        '<div class="t-field"><label>关键事件（一行一条）</label><textarea class="t-area" data-events rows="3" ' +
        'placeholder="例：拿到木牌&#10;跟老人第一次交锋">' + esc((ch.events || []).join('\n')) + '</textarea></div>' +
        '</div><div class="t-bar"><button class="t-btn pri" data-savemeta>保存</button></div>';
      pane.querySelector('[data-status]').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        pane.querySelectorAll('[data-status] button').forEach((x) => x.classList.toggle('on', x === b));
      });
      pane.querySelector('[data-savemeta]').onclick = async () => {
        const cur = pane.querySelector('[data-status] button.on');
        try {
          const r = await nb('api/plot/chapter', { method: 'PATCH', body: {
            slug, path: ch.path, status: cur && cur.dataset.v,
            targetWords: Number(pane.querySelector('[data-tw]').value) || 0,
            pov: pane.querySelector('[data-pov]').value,
            infoControl: { '读者知': pane.querySelector('[data-info]').value,
                           '隐瞒': pane.querySelector('[data-hide]').value },
            cast: pane.querySelector('[data-cast]').value,
            events: pane.querySelector('[data-events]').value,
          } });
          Object.assign(ch, r.chapter || {});
          toast('记下了'); hap();
        } catch (e) { toast('存不了：' + e.message); }
      };
    }

    function safeJson(s) { try { return JSON.parse(s) || {}; } catch (e) { return {}; } }
    void renderOutline; void renderInfo; void chapterPicker;
  }

  async function writeReady(slug) {
    try {
      const st = await get('/api/write/status', { slug });
      if (st.ready) return true;
      toast(st.why || '还没有可用模型');
      return false;
    } catch (e) { toast('读不到模型状态：' + e.message); return false; }
  }

  /* ══════════════════════════════════════════════════════════
     2. 世界：实体 / 事实 / 关系 / 时间线 / 冲突
     ══════════════════════════════════════════════════════════ */
  function openWorld(host) { Push.book('世界', worldHome); }

  /* 记住上次停在哪个页签：从「新历法 / 换算 / 定时间」这类子页返回时，
     要回到刚才那个页签，别一脚踢回「实体」（用户会以为点错了）。 */
  let worldTab = 'entities';
  /* 页签之间会互相抢面板：点了「时间线」但更早发出的「实体」请求晚一步回来，
     就会把时间线盖掉（e2e 截图里抓到过：文字读出来是时间线，屏幕上是实体）。
     所以每次切页签发一个"代次"，回来时代次对不上就直接丢弃。 */
  let worldGen = 0;

  async function worldHome(host, slug, tab) {
    tab = tab || worldTab;
    worldTab = tab;
    loading(host, '翻世界…');
    let ov;
    try { ov = await get('/api/world/overview', { slug }); }
    catch (e) { empty(host, '读不到：' + e.message); return; }
    const c = ov.counts || {};
    host.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (c.entities || 0) + '</b><span>实体</span></div>' +
      '<div class="t-stat"><b>' + (c.facts || 0) + '</b><span>事实</span></div>' +
      '<div class="t-stat"><b>' + (c.moments || 0) + '</b><span>时刻</span></div>' +
      '</div>' +
      ((ov.conflicts || []).length
        ? '<div class="t-form" style="margin-bottom:var(--sp-3)"><div class="t-field"><label>有 ' +
          ov.conflicts.length + ' 处互相打架的设定</label><div class="t-hint" style="margin:0">' +
          esc(ov.conflicts.map((x) => x.entity + '·' + x.key + '：' + (x.values || []).join(' / ')).join('；')) +
          '</div></div></div>' : '') +
      '<div class="t-seg wide" data-tabs>' +
      '<button data-tab="entities" class="' + (tab === 'entities' ? 'on' : '') + '">实体</button>' +
      '<button data-tab="timeline" class="' + (tab === 'timeline' ? 'on' : '') + '">时间线</button>' +
      '<button data-tab="relations" class="' + (tab === 'relations' ? 'on' : '') + '">关系</button>' +
      '<button data-tab="calendar" class="' + (tab === 'calendar' ? 'on' : '') + '">历法</button>' +
      '<button data-tab="tools" class="' + (tab === 'tools' ? 'on' : '') + '">整理</button></div>' +
      '<div data-pane style="margin-top:var(--sp-3)"></div>';

    const pane = host.querySelector('[data-pane]');
    const go = (t) => {
      worldTab = t;                       // 返回键再进来时用得上
      host.querySelectorAll('[data-tabs] button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
      ({ entities: renderEntities, timeline: renderTimeline, relations: renderRelations,
         calendar: renderCalendar, tools: renderTools }[t] || renderEntities)();
    };
    host.querySelector('[data-tabs]').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]'); if (!b) return;
      hap(); go(b.dataset.tab);
    });

    async function renderEntities() {
      const gen = ++worldGen;   // 每次重绘自己领一个代次；晚回来的旧请求直接被丢掉
      loading(pane, '读实体…');
      let d;
      try { d = await get('/api/world/entities', { slug }); }
      catch (e) { if (gen === worldGen) empty(pane, '读不到：' + e.message); return; }
      if (gen !== worldGen) return;   // 切走了就别改屏幕
      const items = d.items || [];
      /* 出场统计：/api/plot/cast 按正文里真的出现来找人。
         以前这个接口没人用 —— 等于「角色有没有被写丢」这件事没人管。 */
      let cast = null;
      try { cast = await get('/api/plot/cast', { slug }); } catch (e) { cast = null; }
      if (gen !== worldGen) return;
      const castOf = {};
      ((cast && cast.items) || []).forEach((x) => { castOf[x.name] = x; });
      const vanished = (cast && cast.vanished) || [];
      const castBit = (name) => {
        const c = castOf[name];
        if (!c || !c.count) return '';
        return c.silentFor >= 5 ? ('出场 ' + c.count + ' 章 · 已 ' + c.silentFor + ' 章没露面')
                                : ('出场 ' + c.count + ' 章');
      };
      pane.innerHTML =
        (vanished.length
          ? '<div class="t-hint" style="margin-bottom:var(--sp-3)">' + vanished.length +
            ' 个角色已经有 5 章以上没露面了：' +
            esc(vanished.slice(0, 6).map((v) => v.name + '（' + v.silentFor + ' 章）').join('、')) +
            '。要么安排他们回来，要么承认这条线断了。</div>' : '') +
        '<div class="t-bar"><button class="t-btn pri" data-add>加一个</button>' +
        '<button class="t-btn" data-fromlore>从设定文件夹收进来</button></div>' +
        '<div class="t-list">' + (items.length ? items.map((it, i) =>
          '<div class="t-row" data-i="' + i + '">' + ico('users') +
          '<div class="tr-main"><div class="tr-title">' + esc(it.name) + '</div>' +
          '<div class="tr-sub wrap">' + esc([KIND_CN[it.kind] || it.kind,
            (it.aliases || []).length ? ('也叫 ' + it.aliases.join('、')) : '',
            (it.facts || []).length ? ((it.facts || []).length + ' 条事实') : '',
            castBit(it.name),
            (it.data && it.data.summary) ? String(it.data.summary).slice(0, 40) : '',
          ].filter(Boolean).join(' · ')) + '</div></div>' +
          '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('')
          : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">世界里还没有人。点「从设定文件夹收进来」把 lorebook 里的设定一次收好。</div></div></div>') +
        '</div>';
      pane.querySelectorAll('[data-i]').forEach((r) => {
        r.onclick = () => { hap(); const it = items[Number(r.dataset.i)]; push(it.name, (h2) => entityDetail(h2, slug, it, () => renderEntities())); };
      });
      pane.querySelector('[data-add]').onclick = async () => {
        const name = await ask('新加谁（或什么）', '', { placeholder: '例：主角 / 青云城 / 火系能力' });
        if (!name) return;
        push('新建：' + name, (h2) => entityForm(h2, slug, { name, kind: 'character', data: {}, aliases: [] }, () => renderEntities()));
      };
      pane.querySelector('[data-fromlore]').onclick = async () => {
        loading(pane, '收设定…');
        try {
          const r = await post('/api/world/import-lorebook', { slug });
          toast('收进来 ' + r.imported + ' 条设定'); hap(); renderEntities();
        } catch (e) { empty(pane, '收不进来：' + e.message); }
      };
    }

    async function entityDetail(host2, slug2, ent, after) {
      loading(host2, '读这个人…');
      let d;
      try { d = await get('/api/world/entities', { slug: slug2, q: ent.name }); }
      catch (e) { empty(host2, '读不到：' + e.message); return; }
      const me = (d.items || []).find((x) => x.id === ent.id) || ent;
      const facts = me.facts || [];
      host2.innerHTML =
        '<div class="t-stats">' +
        '<div class="t-stat"><b>' + esc(KIND_CN[me.kind] || me.kind) + '</b><span>类型</span></div>' +
        '<div class="t-stat"><b>' + facts.length + '</b><span>事实</span></div>' +
        '<div class="t-stat"><b>' + ((me.aliases || []).length) + '</b><span>别名</span></div></div>' +
        (me.data && me.data.summary
          ? '<div class="t-hint" style="margin-bottom:var(--sp-3)">' + esc(String(me.data.summary).slice(0, 300)) + '</div>' : '') +
        '<div class="t-bar"><button class="t-btn" data-edit>改资料</button>' +
        '<button class="t-btn" data-voice>说话方式</button>' +
        '<button class="t-btn" data-state>查某时刻的状态</button>' +
        '<button class="t-btn" data-arc>成长弧线</button></div>' +
        '<h2 class="st-h">事实（按时间生效）</h2>' +
        '<div data-facts></div>' +
        '<div class="t-bar" style="margin-top:var(--sp-3)"><button class="t-btn pri" data-addfact>加一条事实</button>' +
        '<button class="t-btn" data-merge>和另一个合并</button>' +
        '<button class="t-btn dan" data-del>删掉</button></div>';
      const fbox = host2.querySelector('[data-facts]');
      const paintFacts = () => {
        fbox.innerHTML = facts.length
          ? '<div class="t-list">' + facts.map((f, i) =>
            '<div class="t-row static">' + ico('dot') +
            '<div class="tr-main"><div class="tr-title">' + esc(f.key + '：' + f.value) + '</div>' +
            '<div class="tr-sub">' + esc([f.from || '一开始', f.to ? ('到 ' + f.to) : '至今',
              f.confidence === 'stated' ? '书里写明' : f.confidence === 'inferred' ? '推断' : '不确定',
              f.note || '', f.source_path || ''].filter(Boolean).join(' · ')) + '</div></div>' +
            '<button class="t-btn sm dim" data-rm="' + i + '">删</button></div>').join('') + '</div>'
          : '<div class="t-empty">还没有事实。事实就是「他在某段时间里是什么样」。</div>';
        fbox.querySelectorAll('[data-rm]').forEach((b) => {
          b.onclick = async () => {
            const f = facts[Number(b.dataset.rm)];
            if (!(await confirmBox('删掉这条事实？'))) return;
            try { await del('/api/world/fact', { slug: slug2, id: f.id }); hap(); entityDetail(host2, slug2, me, after); }
            catch (e) { toast('删不掉：' + e.message); }
          };
        });
      };
      paintFacts();
      host2.querySelector('[data-edit]').onclick = () => push('改：' + me.name, (h3) => entityForm(h3, slug2, me, after));
      host2.querySelector('[data-addfact]').onclick = async () => {
        const key = await ask('什么属性', '', { placeholder: '例：身份 / 年龄 / 能力 / 状态' });
        if (!key) return;
        const value = await ask('是什么', '', { placeholder: '例：青云城外门弟子' });
        if (!value) return;
        const from = await ask('从哪个时刻开始有效（可留空 = 一直有效）', '', { placeholder: '时刻名' });
        try {
          let fromId = null;
          if (from) {
            const ms = (await get('/api/world/moments', { slug: slug2 })).items || [];
            const hit = ms.find((m) => m.label === from);
            if (!hit) { toast('没有「' + from + '」这个时刻，先去时间线建一个'); return; }
            fromId = hit.id;
          }
          await post('/api/world/fact', { slug: slug2, entityId: me.id, key, value, fromMomentId: fromId });
          toast('记下了'); hap(); entityDetail(host2, slug2, me, after);
        } catch (e) { toast('记不下：' + e.message); }
      };
      host2.querySelector('[data-state]').onclick = () => push('查状态', (h3) => stateView(h3, slug2, me.name));
      host2.querySelector('[data-voice]').onclick = () => push('说话方式 · ' + me.name,
        (h3) => voiceForm(h3, slug2, me.name));
      host2.querySelector('[data-arc]').onclick = () => push('弧线 · ' + me.name, (h3) => arcView(h3, slug2, me));
      host2.querySelector('[data-merge]').onclick = async () => {
        const other = await ask('和谁合并（写另一个名字，它的名字会变成别名）', '', { placeholder: '另一个叫法' });
        if (!other) return;
        const list = (await get('/api/world/entities', { slug: slug2, q: other })).items || [];
        const hit = list.find((x) => x.name === other) || list[0];
        if (!hit) { toast('找不到「' + other + '」'); return; }
        if (!(await confirmBox('把「' + hit.name + '」并进「' + me.name + '」？事实都会跟过来。'))) return;
        try { await post('/api/world/entity/merge', { slug: slug2, fromId: hit.id, toId: me.id }); toast('并好了'); hap(); after(); U().back(); }
        catch (e) { toast('并不了：' + e.message); }
      };
      host2.querySelector('[data-del]').onclick = async () => {
        if (!(await confirmBox('把「' + me.name + '」从世界里删掉？（正文一个字不动）', true))) return;
        try { await del('/api/world/entity', { slug: slug2, id: me.id }); toast('删了'); hap(); after(); U().back(); }
        catch (e) { toast('删不掉：' + e.message); }
      };
    }

    function entityForm(host2, slug2, ent, after) {
      const d = ent.data || {};
      host2.innerHTML =
        '<div class="t-form">' +
        '<div class="t-field"><label>名字</label><input class="t-input" data-name value="' + esc(ent.name) + '"></div>' +
        '<div class="t-field"><label>类型</label><div class="t-seg wide" data-kind>' +
        Object.keys(KIND_CN).map((k) => '<button data-v="' + k + '" class="' +
          ((ent.kind || 'character') === k ? 'on' : '') + '">' + KIND_CN[k] + '</button>').join('') + '</div></div>' +
        '<div class="t-field"><label>别名（逗号隔开）</label><input class="t-input" data-alias value="' +
        esc((ent.aliases || []).join('，')) + '" placeholder="例：小诺，林小子"></div>' +
        '<div class="t-field"><label>一句话说明</label><textarea class="t-area" data-summary rows="2">' +
        esc(d.summary || '') + '</textarea></div>' +
        '<div class="t-field"><label>外貌</label><input class="t-input" data-look value="' + esc(d['外貌'] || '') + '"></div>' +
        '<div class="t-field"><label>性格</label><input class="t-input" data-temper value="' + esc(d['性格'] || '') + '"></div>' +
        '<div class="t-field"><label>目标 / 动机</label><input class="t-input" data-goal value="' + esc(d['目标'] || '') + '"></div>' +
        '<div class="t-field"><label>说话风格 / 口头禅</label><input class="t-input" data-voice value="' + esc(d['口头禅'] || '') + '"></div>' +
        '<div class="t-field" data-only="place" hidden><label>上级地点</label><input class="t-input" data-parent value="' +
        esc(d['上级地点'] || '') + '" placeholder="例：天斗帝国 &gt; 索托城 &gt; 客栈"></div>' +
        '<div class="t-field" data-only="place" hidden><label>坐标（可选）</label><input class="t-input" data-coord value="' +
        esc(d['坐标'] || '') + '" placeholder="例：西北 300 里 / 12,34"></div>' +
        '<div class="t-field" data-only="system" hidden><label>等级表（从低到高，逗号隔开）</label><input class="t-input" data-levels value="' +
        esc(d['等级表'] || '') + '" placeholder="例：一阶，二阶，三阶，四阶"></div>' +
        '<div class="t-field" data-only="item" hidden><label>现在在谁手里</label><input class="t-input" data-holder value="' +
        esc(d['持有者'] || '') + '" placeholder="例：主角（第 12 章起）"></div>' +
        '</div><div class="t-bar"><button class="t-btn pri" data-save>保存</button></div>' +
        '<div class="t-hint">结构化字段比一整段文字更好用：写作时 AI 会照着这些设定来，不会写偏。</div>';
      /* 只有相关类型才显示那几个字段：地点才要坐标，体系才要等级表，物品才问在谁手里 */
      const syncOnly = () => {
        const on = host2.querySelector('[data-kind] button.on');
        const k = (on && on.dataset.v) || 'character';
        host2.querySelectorAll('[data-only]').forEach((el) => { el.hidden = el.dataset.only !== k; });
      };
      syncOnly();
      host2.querySelector('[data-kind]').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        host2.querySelectorAll('[data-kind] button').forEach((x) => x.classList.toggle('on', x === b));
        syncOnly();
      });
      host2.querySelector('[data-save]').onclick = async () => {
        const kindBtn = host2.querySelector('[data-kind] button.on');
        const val = (s) => { const el = host2.querySelector(s); return el ? el.value.trim() : ''; };
        try {
          await post('/api/world/entity', {
            slug: slug2, kind: kindBtn && kindBtn.dataset.v, name: val('[data-name]'),
            aliases: val('[data-alias]').split(/[，,、\s]+/).filter(Boolean),
            replaceAliases: true,
            data: { summary: val('[data-summary]'), '外貌': val('[data-look]'),
                    '性格': val('[data-temper]'), '目标': val('[data-goal]'),
                    '口头禅': val('[data-voice]'),
                    '上级地点': val('[data-parent]'), '坐标': val('[data-coord]'),
                    '等级表': val('[data-levels]'), '持有者': val('[data-holder]') },
          });
          toast('存好了'); hap(); after(); U().back();
        } catch (e) { toast('存不了：' + e.message); }
      };
    }

    async function stateView(host2, slug2, name) {
      loading(host2, '想一想…');
      const ms = (await get('/api/world/moments', { slug: slug2 })).items || [];
      host2.innerHTML =
        '<div class="t-form"><div class="t-field"><label>谁</label><input class="t-input" data-name value="' + esc(name || '') + '"></div>' +
        '<div class="t-field"><label>哪个时刻（留空 = 现在）</label><div class="t-chips" data-ms>' +
        '<button class="t-pill" data-v="">现在</button>' +
        ms.map((m) => '<button class="t-pill" data-v="' + esc(m.label) + '">' + esc(m.label) + '</button>').join('') +
        '</div></div></div>' +
        '<div class="t-bar"><button class="t-btn pri" data-go>看它当时什么样</button></div>' +
        '<div data-out></div>';
      let at = '';
      host2.querySelector('[data-ms]').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        at = b.dataset.v; hap();
        host2.querySelectorAll('[data-ms] button').forEach((x) => x.classList.toggle('ok', x === b));
      });
      host2.querySelector('[data-go]').onclick = async () => {
        const out = host2.querySelector('[data-out]');
        loading(out, '推算…');
        try {
          const d = await get('/api/world/state', {
            slug: slug2, name: host2.querySelector('[data-name]').value.trim(), at });
          const kv = Object.entries(d.state || {});
          out.innerHTML = '<h2 class="st-h">' + esc(d.entity && d.entity.name) + (at ? '（' + esc(at) + ' 时）' : '（现在）') + '</h2>' +
            (kv.length ? '<div class="t-list">' + kv.map(([k, v]) =>
              '<div class="t-row static">' + ico('dot') + '<div class="tr-main"><div class="tr-title">' +
              esc(k + '：' + v) + '</div></div></div>').join('') + '</div>'
              : '<div class="t-empty">这个时刻还没有关于它的事实</div>');
        } catch (e) { out.innerHTML = '<div class="t-empty">' + esc(e.message) + '</div>'; }
      };
    }

    async function arcView(host2, slug2, ent) {
      loading(host2, '读弧线…');
      let d;
      try { d = await get('/api/world/arc', { slug: slug2, entityId: ent.id }); }
      catch (e) { d = { arc: null }; }
      const a = d.arc || {};
      const tps = a.turningPoints || [];
      host2.innerHTML =
        '<div class="t-form">' +
        '<div class="t-field"><label>他想要什么</label><input class="t-input" data-goal value="' + esc(a.goal || '') + '"></div>' +
        '<div class="t-field"><label>为什么（动机）</label><textarea class="t-area" data-motive rows="2">' + esc(a.motive || '') + '</textarea></div>' +
        '</div>' +
        '<h2 class="st-h">变化节点</h2>' +
        '<div class="t-list">' + (tps.length ? tps.map((t, i) =>
          '<div class="t-row static">' + ico('clock') + '<div class="tr-main"><div class="tr-title">' +
          esc(t.what || t.note || '') + '</div><div class="tr-sub">' + esc(t.at || '') + '</div></div></div>').join('')
          : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">还没记变化节点</div></div></div>') + '</div>' +
        '<div class="t-bar" style="margin-top:var(--sp-3)"><button class="t-btn" data-addtp>加一个节点</button>' +
        '<button class="t-btn pri" data-save>保存</button></div>';
      let list = tps.slice();
      host2.querySelector('[data-addtp]').onclick = async () => {
        const at = await ask('在哪个时刻', '', { placeholder: '时刻名，例：入城那晚' });
        if (!at) return;
        const what = await ask('发生了什么变化', '', { placeholder: '例：第一次杀人' });
        if (!what) return;
        list.push({ at, what });
        tps.push({ at, what });
        arcView(host2, slug2, ent);
      };
      host2.querySelector('[data-save]').onclick = async () => {
        try {
          await post('/api/world/arc', { slug: slug2, entityId: ent.id,
            goal: host2.querySelector('[data-goal]').value,
            motive: host2.querySelector('[data-motive]').value, turningPoints: list });
          toast('存好了'); hap();
        } catch (e) { toast('存不了：' + e.message); }
      };
    }

    async function renderTimeline() {
      const gen = ++worldGen;   // 每次重绘自己领一个代次；晚回来的旧请求直接被丢掉
      loading(pane, '读时间线…');
      let d;
      try { d = await get('/api/world/timeline', { slug }); }
      catch (e) { if (gen === worldGen) empty(pane, '读不到：' + e.message); return; }
      const ms = d.moments || [];
      const dated = {};
      try {
        const t = await get('/api/world/moment/times', { slug });
        (t.moments || []).forEach((x) => {
          // 有历法就用历法日期，没有就退回"第 N 天" —— 但一定说得清是哪个时刻
          if (x.abs_day != null) dated[x.id] = x.my_text || ('第 ' + x.abs_day + ' 天');
        });
      } catch (e) { /* 没定过时间就算了，不是错误 */ }
      if (gen !== worldGen) return;   // 切走了就别改屏幕
      pane.innerHTML =
        '<div class="t-bar"><button class="t-btn pri" data-add>加一个时刻</button>' +
        '<button class="t-btn" data-state>查某人当时的样</button>' +
        '<button class="t-btn" data-retro>回溯到某一刻</button></div>' +
        '<div class="t-hint" style="margin-bottom:var(--sp-3)">时刻就是「故事里的某个时间点」。' +
        '给时刻定个时间（按你的历法），时序就能自动排；倒叙、回忆、前传都不会穿帮。</div>' +
        '<div class="t-list">' + (ms.length ? ms.map((m, i) =>
          '<div class="t-row static">' + ico('clock') +
          '<div class="tr-main"><div class="tr-title">' + esc(m.label) + '</div>' +
          '<div class="tr-sub">' + esc([dated[i] || m.time_text || '还没定时间',
            (m.episodes || []).length ? ((m.episodes || []).length + ' 件事') : ''].filter(Boolean).join(' · ')) + '</div>' +
          ((m.episodes || []).length ? '<div class="tr-sub wrap">' + esc((m.episodes || []).map((e) => e.title).join('、')) + '</div>' : '') +
          '</div><button class="t-btn sm" data-settime="' + i + '">定时间</button>' +
          '<button class="t-btn sm" data-addep="' + i + '">加事</button>' +
          '<button class="t-btn sm dim" data-rm="' + i + '">删</button></div>').join('')
          : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">还没有时刻</div></div></div>') + '</div>';
      pane.querySelectorAll('[data-settime]').forEach((b) => {
        b.onclick = async () => {
          const m = ms[Number(b.dataset.settime)];
          hap();
          push('定时间：' + m.label, (h3) => momentTimeForm(h3, slug, m, () => renderTimeline()));
        };
      });
      pane.querySelector('[data-retro]').onclick = async () => {
        hap();
        push('回溯', (h3) => retroView(h3, slug, ms));
      };
      pane.querySelector('[data-add]').onclick = async () => {
        const label = await ask('这个时刻叫什么', '', { placeholder: '例：入城那晚 / 三年后 / 能力觉醒那天' });
        if (!label) return;
        const timeText = await ask('书里的时间（可留空）', '', { placeholder: '例：第二年冬天' });
        try { await post('/api/world/moment', { slug, label, timeText: timeText || '' }); toast('加好了'); hap(); renderTimeline(); }
        catch (e) { toast('加不了：' + e.message); }
      };
      pane.querySelectorAll('[data-addep]').forEach((b) => {
        b.onclick = async () => {
          const m = ms[Number(b.dataset.addep)];
          const title = await ask('发生了什么事', '', { placeholder: '例：第一次见到她' });
          if (!title) return;
          try { await post('/api/world/episode', { slug, momentId: m.id, title }); toast('记下了'); hap(); renderTimeline(); }
          catch (e) { toast('记不下：' + e.message); }
        };
      });
      pane.querySelectorAll('[data-rm]').forEach((b) => {
        b.onclick = async () => {
          const m = ms[Number(b.dataset.rm)];
          if (!(await confirmBox('删掉「' + m.label + '」这个时刻？', true))) return;
          try { await del('/api/world/moment', { slug, id: m.id }); renderTimeline(); }
          catch (e) { toast('删不掉：' + e.message); }
        };
      });
      pane.querySelector('[data-state]').onclick = () => push('查状态', (h2) => stateView(h2, slug, ''));
    }

    async function renderRelations() {
      const gen = ++worldGen;   // 每次重绘自己领一个代次；晚回来的旧请求直接被丢掉
      loading(pane, '读关系…');
      let d;
      try { d = await get('/api/world/relations', { slug }); }
      catch (e) { if (gen === worldGen) empty(pane, '读不到：' + e.message); return; }
      if (gen !== worldGen) return;   // 切走了就别改屏幕
      const items = d.items || [];
      pane.innerHTML =
        '<div class="t-bar"><button class="t-btn pri" data-add>加一条关系</button></div>' +
        '<div class="t-list">' + (items.length ? items.map((r, i) =>
          '<div class="t-row static">' + ico('link') +
          '<div class="tr-main"><div class="tr-title">' + esc(r.from_name + ' —' + r.kind + '→ ' + r.to_name) + '</div>' +
          '<div class="tr-sub">' + esc(['强度 ' + (r.strength || 3), r.since ? ('从 ' + r.since) : '',
            r.until ? ('到 ' + r.until) : '', r.note || ''].filter(Boolean).join(' · ')) + '</div></div>' +
          '<button class="t-btn sm dim" data-rm="' + i + '">删</button></div>').join('')
          : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">还没有关系。关系也能随时间变（第 5 章反目这种）。</div></div></div>') + '</div>';
      pane.querySelector('[data-add]').onclick = () => push('加关系', (h2) => relationForm(h2, slug, () => renderRelations()));
      pane.querySelectorAll('[data-rm]').forEach((b) => {
        b.onclick = async () => {
          const r = items[Number(b.dataset.rm)];
          if (!(await confirmBox('删掉这条关系？'))) return;
          try { await del('/api/world/relation', { slug, id: r.id }); renderRelations(); }
          catch (e) { toast('删不掉：' + e.message); }
        };
      });
    }

    function relationForm(host2, slug2, after) {
      host2.innerHTML =
        '<div class="t-form">' +
        '<div class="t-field"><label>谁</label><input class="t-input" data-from placeholder="名字"></div>' +
        '<div class="t-field"><label>怎么样</label><input class="t-input" data-kind placeholder="例：师徒 / 敌对 / 兄妹"></div>' +
        '<div class="t-field"><label>对谁</label><input class="t-input" data-to placeholder="名字"></div>' +
        '<div class="t-field"><label>强度（1-5）</label><input class="t-input" data-strength type="number" value="3"></div>' +
        '<div class="t-field"><label>从哪个时刻开始（可空）</label><input class="t-input" data-since placeholder="时刻名"></div>' +
        '</div><div class="t-bar"><button class="t-btn pri" data-save>保存</button></div>';
      host2.querySelector('[data-save]').onclick = async () => {
        const v = (s) => host2.querySelector(s).value.trim();
        try {
          await post('/api/world/relation', { slug: slug2, from: v('[data-from]'),
            kind: v('[data-kind]') || '认识', to: v('[data-to]'),
            strength: Number(v('[data-strength]')) || 3, since: v('[data-since]') });
          toast('存好了'); hap(); after(); U().back();
        } catch (e) { toast('存不了：' + e.message); }
      };
    }

    /* 定时间：写「开元 1024 年 3 月」这样的文本，按这本书的历法换算成绝对序号 */
    async function momentTimeForm(host3, slug3, moment, after) {
      loading(host3, '读历法…');
      let cals = [];
      try { cals = (await get('/api/world/calendars', { slug: slug3 })).items || []; }
      catch (e) { empty(host3, '读不到历法：' + e.message); return; }
      const cur = cals[0] || { name: '公历' };
      host3.innerHTML =
        '<div class="t-form">' +
        '<div class="t-field"><label>用哪套历法</label><div class="t-chips" data-mt-chips>' +
        cals.map((c, i) => '<button class="t-chip' + (i === 0 ? ' on' : '') + '" data-mt-chip="' + i + '">' +
          esc(c.name) + (c.builtin ? '' : '（自造）') + '</button>').join('') + '</div></div>' +
        '<div class="t-field"><label>「' + esc(moment.label) + '」是什么时候</label>' +
        '<input class="t-input" data-mt-text placeholder="例：第三纪 4 年 1 月 1 日 / 公元前 221 年 3 月 5 日"></div>' +
        '<div class="t-hint" data-mt-preview style="margin:0 0 var(--sp-2)">写完点「换算看看」</div>' +
        '</div>' +
        '<div class="t-bar"><button class="t-btn" data-mt-check>换算看看</button>' +
        '<button class="t-btn pri" data-mt-save>定这个时间</button></div>' +
        '<div class="t-hint">定完会按时间自动重排时刻顺序（没定时间的排在后面）。</div>';
      let ci = 0;
      const textOf = () => host3.querySelector('[data-mt-text]').value.trim();
      const showPreview = (z) => {
        host3.querySelector('[data-mt-preview]').textContent = z.ok
          ? ('= ' + z.date_text + '（绝对序号 ' + z.abs + '）')
          : (z.error || '看不懂这个时间');
      };
      host3.querySelectorAll('[data-mt-chip]').forEach((b) => {
        b.onclick = () => {
          hap(); ci = Number(b.dataset.mtChip);
          host3.querySelectorAll('[data-mt-chip]').forEach((x) => x.classList.toggle('on', x === b));
        };
      });
      host3.querySelector('[data-mt-check]').onclick = async () => {
        hap();
        try { showPreview(await post('/api/world/calendar/convert',
          { slug: slug3, text: textOf(), calendar: cals[ci].name })); }
        catch (e) { showPreview({ ok: false, error: '换算不了：' + e.message }); }
      };
      host3.querySelector('[data-mt-save]').onclick = async () => {
        if (!textOf()) { toast('先写上时间'); return; }
        try {
          const r = await post('/api/world/moment/time',
            { slug: slug3, momentId: moment.id, text: textOf(), calendar: cals[ci].name });
          toast('定好了：' + r.dateText); hap(); after();
        } catch (e) { toast('定不了：' + e.message); }
      };
    }

    /* 回溯：给定时刻 + 主体 → 那一刻的完整状态，每条事实都带出处 */
    async function retroView(host3, slug3, ms) {
      const at = await ask('回溯到哪个时刻', '', { placeholder: '时刻名；留空 = 最新状态' });
      if (at === null) return;
      loading(host3, '推算那一刻…');
      let d;
      try { d = await get('/api/world/retro', { slug: slug3, at: at || '' }); }
      catch (e) { empty(host3, '回溯不了：' + e.message); return; }
      if (d.error) { empty(host3, d.error); return; }
      const ents = d.entities || [];
      const rows = ents.map((e) => {
        const fs = e.facts || [];
        return '<h2 class="st-h">' + esc(e.name) + '</h2>' +
          '<div class="t-list">' + (fs.length ? fs.map((f) => (
            '<div class="t-row static">' + ico('dot') +
            '<div class="tr-main"><div class="tr-title">' + esc(f.key + '：' + f.value) + '</div>' +
            '<div class="tr-sub wrap">' + esc([f.sinceLabel ? ('从「' + f.sinceLabel + '」起') : '一开始就有',
              f.source || '没标出处',
              (f.evidence && f.evidence[0])
                ? ('第 ' + f.evidence[0].line + ' 行「' + String(f.evidence[0].quote || '').slice(0, 18) + '」') : '',
            ].filter(Boolean).join(' · ')) + '</div></div></div>')).join('')
            : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">那一刻还没有关于他的记录</div></div></div>') +
          '</div>';
      }).join('');
      host3.innerHTML =
        '<div class="t-hint" style="margin-bottom:var(--sp-3)">看到的是「' +
        esc(d.cutoffLabel || '最新状态') + '」那一刻的世界。每条事实都标了它从哪一章来、哪一行。' +
        '（这次推算只叠加了窗口内的改动，不重放整本书。）</div>' +
        (ents.length ? rows : '<div class="t-empty">那一刻世界里还没有人</div>');
    }

    /* 历法：定义自己的历法（月长 / 闰年 / 纪元），并换算、排序 */
    async function renderCalendar() {
      const gen = ++worldGen;   // 每次重绘自己领一个代次；晚回来的旧请求直接被丢掉
      loading(pane, '读历法…');
      let cals = [];
      try { cals = (await get('/api/world/calendars', { slug })).items || []; }
      catch (e) { if (gen === worldGen) empty(pane, '读不到：' + e.message); return; }
      if (gen !== worldGen) return;
      const fmtMonths = (c) => (c.desc && c.desc.months ? c.desc.months.join('/') : '');
      pane.innerHTML =
        '<div class="t-bar"><button class="t-btn pri" data-newcal>定义一套历法</button>' +
        '<button class="t-btn" data-conv>换算</button>' +
        '<button class="t-btn" data-sort>按时间重排时刻</button></div>' +
        '<div class="t-hint" style="margin-bottom:var(--sp-3)">架空世界可以有自己的年月日：一个月几天、几年闰一次都你说了算。' +
        '定好之后，时刻能自动排先后，回溯也按它算。</div>' +
        '<div class="t-list">' + cals.map((c, i) =>
          '<div class="t-row static">' + ico('clock') +
          '<div class="tr-main"><div class="tr-title">' + esc(c.name) +
          (c.builtin ? '（内置）' : '') + '</div>' +
          '<div class="tr-sub wrap">' + esc([(c.desc && c.desc.leapText) || '',
            (c.desc && c.desc.months) ? ('一年 ' + c.desc.yearDays + ' 天') : '',
            (c.desc && c.desc.eras || []).length ? ('纪元：' + (c.desc.eras || []).join('、')) : '',
            c.note || ''].filter(Boolean).join(' · ')) + '</div>' +
          (c.desc && c.desc.months ? '<div class="tr-sub wrap">每月天数：' + esc(fmtMonths(c)) + '</div>' : '') +
          '</div>' + (c.builtin ? '' : '<button class="t-btn sm dim" data-rmcal="' + i + '">删</button>') +
          '</div>').join('') + '</div>';

      pane.querySelector('[data-newcal]').onclick = () => { hap(); push('新历法', (h) => calendarForm(h, slug, () => renderCalendar())); };
      pane.querySelector('[data-conv]').onclick = () => { hap(); push('换算', (h) => convertForm(h, slug, cals, () => renderCalendar())); };
      pane.querySelector('[data-sort]').onclick = async () => {
        try { const r = await post('/api/world/reorder', { slug }); toast('重排了 ' + r.moved + ' 个时刻'); hap(); renderCalendar(); }
        catch (e) { toast('排不了：' + e.message); }
      };
      pane.querySelectorAll('[data-rmcal]').forEach((b) => {
        b.onclick = async () => {
          const c = cals[Number(b.dataset.rmcal)];
          if (!(await confirmBox('删掉「' + c.name + '」这套历法？', true))) return;
          try { await del('/api/world/calendar', { slug, name: c.name }); toast('删了'); hap(); renderCalendar(); }
          catch (e) { toast('删不掉：' + e.message); }
        };
      });
    }

    async function calendarForm(host3, slug3, after) {
      host3.innerHTML =
        '<div class="t-form">' +
        '<div class="t-field"><label>历法名字</label><input class="t-input" data-cal-name placeholder="例：四时历 / 大衍历"></div>' +
        '<div class="t-field"><label>一年几个月、每月几天</label>' +
        '<input class="t-input" data-cal-months placeholder="例：30,30,30,30,30,30,30,30,30,30,30,30"></div>' +
        '<div class="t-field"><label>纪元名（可留空）</label><input class="t-input" data-cal-era placeholder="例：第三纪"></div>' +
        '<div class="t-field"><label>几年一闰（0 = 不闰）</label><input class="t-input" data-cal-every placeholder="例：3"></div>' +
        '<div class="t-field"><label>闰哪个月、加几天</label>' +
        '<input class="t-input" data-cal-leap placeholder="例：5,5 表示闰月第 5 月多加 5 天"></div>' +
        '</div>' +
        '<div class="t-bar"><button class="t-btn pri" data-cal-save>存下来</button></div>' +
        '<div class="t-hint">看不懂就先照抄：一月 40 天 × 10 个月、每 3 年闰一次、闰月第 5 月加 5 天。</div>';
      host3.querySelector('[data-cal-save]').onclick = async () => {
        const name = host3.querySelector('[data-cal-name]').value.trim();
        const months = host3.querySelector('[data-cal-months]').value.split(/[,，\/\s]+/).filter(Boolean).map(Number);
        if (!name) { toast('起个名字'); return; }
        if (!months.length || months.some((n) => !(n > 0))) { toast('每月天数要写成数字，用逗号隔开'); return; }
        const every = Number(host3.querySelector('[data-cal-every]').value || 0);
        const lp = host3.querySelector('[data-cal-leap]').value.split(/[,，\s]+/).filter(Boolean).map(Number);
        const era = host3.querySelector('[data-cal-era]').value.trim();
        const def = { months, leap_rule: every > 0 ? { every } : {}, leap_month: lp[0] || 1,
          leap_days: lp[1] || 0, year_zero: true, week: 7,
          eras: era ? [{ name: era, sign: 1 }] : [],
          anchor: { year: 1, month: 1, day: 1, abs: 0 } };
        try { await post('/api/world/calendar', { slug: slug3, name, def }); toast('建好了'); hap(); after(); }
        catch (e) { toast('存不了：' + e.message); }
      };
    }

    async function convertForm(host3, slug3, cals, after) {
      host3.innerHTML =
        '<div class="t-form">' +
        '<div class="t-field"><label>用哪套历法</label><div class="t-chips" data-cal-chips>' +
        cals.map((c, i) => '<button class="t-chip' + (i === 0 ? ' on' : '') + '" data-cal-chip="' + i + '">' +
          esc(c.name) + '</button>').join('') + '</div></div>' +
        '<div class="t-field"><label>书里的时间</label>' +
        '<input class="t-input" data-conv-text placeholder="例：第三纪 4 年 1 月 1 日"></div>' +
        '<div class="t-field"><label>或者：绝对序号（反过来查）</label>' +
        '<input class="t-input" data-conv-abs placeholder="例：1205"></div>' +
        '</div>' +
        '<div class="t-bar"><button class="t-btn pri" data-conv-go>换算</button></div>' +
        '<div class="t-form"><div class="t-field"><label>结果</label>' +
        '<div class="t-hint" data-conv-out style="margin:0">还没算</div></div></div>';
      let ci = 0;
      host3.querySelectorAll('[data-cal-chip]').forEach((b) => {
        b.onclick = () => { hap(); ci = Number(b.dataset.calChip); host3.querySelectorAll('[data-cal-chip]').forEach((x) => x.classList.toggle('on', x === b)); };
      });
      host3.querySelector('[data-conv-go]').onclick = async () => {
        hap();
        const abs = host3.querySelector('[data-conv-abs]').value.trim();
        const text = host3.querySelector('[data-conv-text]').value.trim();
        const out = host3.querySelector('[data-conv-out]');
        try {
          const r = abs !== ''
            ? await post('/api/world/calendar/convert', { slug: slug3, abs: Number(abs), calendar: cals[ci].name })
            : await post('/api/world/calendar/convert', { slug: slug3, text, calendar: cals[ci].name });
          out.textContent = r.ok ? (r.direction + '：' + r.date_text + '（绝对序号 ' + r.abs + '）')
            : (r.error || '看不懂');
        } catch (e) { out.textContent = '算不了：' + e.message; }
      };
    }

    /* 「整理」页只在自己被点时才动（没有先 await 再改屏的竞态），不需要代次 */
    async function renderTools() {
      pane.innerHTML =
        '<div class="t-bar"><button class="t-btn" data-lore>从设定文件夹收进来</button>' +
        '<button class="t-btn" data-ex>从正文认人名</button>' +
        '<button class="t-btn primary" data-fx>从设定里认事实</button></div>' +
        '<div class="t-hint" style="margin-bottom:var(--sp-3)">「收设定」把 lorebook 里的每篇设定变成一个实体 + 一份素材；' +
        '「认人名」只在正文里做统计，认出来的是候选，收不收你定。' +
        '「**认事实**」把设定文件里的「**属性**：值」逐条认出来（按人物分好），你勾完一键收下 —— ' +
        '这是把设定真正喂进世界引擎的那一步。</div>' +
        '<div data-out></div>';
      const out = pane.querySelector('[data-out]');
      pane.querySelector('[data-lore]').onclick = async () => {
        loading(out, '收设定…');
        try {
          const r = await post('/api/world/import-lorebook', { slug });
          out.innerHTML = '<div class="t-hint">收进来 ' + r.imported + ' 条，跳过 ' + r.skipped + ' 条（目录页之类的）。</div>';
          toast('收好了'); hap();
        } catch (e) { out.innerHTML = '<div class="t-empty">收不进来：' + esc(e.message) + '</div>'; }
      };
      /* 从设定里认事实（监督人 2026-09-21 加）：
         设定文件本来就是 `<属性>：<值>` 的结构，后端纯本地规则认出来 → 这里勾选 → 一键收下。
         以前世界引擎里"事实 0 条、关系 0 条"，所以这个面板点开就是空的。 */
      pane.querySelector('[data-fx]').onclick = async () => {
        loading(out, '翻设定、认事实…');
        let r;
        try { r = await post('/api/world/extract-facts', { slug }); }
        catch (e) { out.innerHTML = '<div class="t-empty">认不了：' + esc(e.message) + '</div>'; return; }
        const fs = r.facts || [];
        if (!fs.length) {
          out.innerHTML = '<div class="t-hint">没认出新的事实（可能都收过了）。扫了 ' + (r.files || 0) + ' 个设定文件。</div>';
          return;
        }
        const byEnt = {};
        fs.forEach((x, i) => { (byEnt[x.entity] = byEnt[x.entity] || []).push(Object.assign({ _i: i }, x)); });
        out.innerHTML = '<h2 class="st-h">从设定里认出 <b>' + fs.length + '</b> 条事实（不要的勾掉，剩下的收下）</h2>' +
          Object.keys(byEnt).map((k) =>
            '<div class="t-hint" style="margin:var(--sp-3) 0 var(--sp-1)"><b>' + esc(k) + '</b> · ' + byEnt[k].length + ' 条</div>' +
            byEnt[k].map((x) =>
              '<label style="display:flex;gap:var(--sp-2);align-items:flex-start;padding:6px 0">' +
              '<input type="checkbox" checked data-f="' + x._i + '">' +
              '<span><b>' + esc(x.section ? x.section + ' · ' : '') + esc(x.key) + '</b>：' +
              esc(String(x.value).slice(0, 70)) + '</span></label>').join('')).join('') +
          '<div class="t-bar" style="margin-top:var(--sp-3)">' +
          '<button class="t-btn primary" data-save>收下勾选的</button>' +
          '<button class="t-btn" data-all>全不选</button></div>';
        out.querySelector('[data-all]').onclick = () => {
          const cs = [...out.querySelectorAll('input[data-f]')];
          const anyOn = cs.some((c) => c.checked);
          cs.forEach((c) => { c.checked = !anyOn; });
          out.querySelector('[data-all]').textContent = anyOn ? '全选' : '全不选';
        };
        out.querySelector('[data-save]').onclick = async () => {
          const picks = [...out.querySelectorAll('input[data-f]:checked')].map((c) => fs[+c.dataset.f]);
          if (!picks.length) { toast('一条都没勾'); return; }
          loading(out, '收 ' + picks.length + ' 条事实…');
          let ok = 0, bad = 0;
          for (const x of picks) {
            try {
              await post('/api/world/fact', { slug, entityId: x.entityId, key: x.key,
                value: x.value, sourcePath: x.sourcePath || '', note: x.section || '' });
              ok++;
            } catch (e) { bad++; }
          }
          out.innerHTML = '<div class="t-hint">收下 ' + ok + ' 条' + (bad ? '，失败 ' + bad + ' 条' : '') +
            '。<br>去「实体」页签点开一个人，就能看到他名下的事实了。</div>';
          toast('收了 ' + ok + ' 条事实'); hap();
        };
      };
      pane.querySelector('[data-ex]').onclick = async () => {
        loading(out, '在正文里数人名…');
        try {
          const r = await get('/api/world/extract', { slug });
          const items = r.items || [];
          out.innerHTML = '<h2 class="st-h">正文里反复出现的名字（' + items.length + ' 个候选）</h2>' +
            (items.length ? '<div class="t-chips">' + items.map((it) =>
              '<button class="t-pill" data-add="' + esc(it.name) + '">' + esc(it.name) + ' · ' + it.count + '</button>').join('') + '</div>' +
              '<div class="t-hint" style="margin-top:var(--sp-3)">点一个就收进世界（收进去之后可以补身份、别名、外貌）。</div>'
              : '<div class="t-empty">没认出新的名字</div>');
          out.querySelectorAll('[data-add]').forEach((b) => {
            b.onclick = async () => {
              try { await post('/api/world/entity', { slug, kind: 'character', name: b.dataset.add }); toast('收进世界了'); hap(); b.classList.add('ok'); }
              catch (e) { toast('收不了：' + e.message); }
            };
          });
        } catch (e) { out.innerHTML = '<div class="t-empty">数不了：' + esc(e.message) + '</div>'; }
      };
    }

    go(tab);
  }

  /* ══════════════════════════════════════════════════════════
     3. 剧情：承载树 / 伏笔账本 / 决策 / 场景
     ══════════════════════════════════════════════════════════ */
  function openPlot(host) { Push.book('剧情', plotHome); }

  async function plotHome(host, slug, tab) {
    tab = tab || 'tree';
    loading(host, '读剧情…');
    let ov;
    try { ov = await get('/api/plot/overview', { slug }); }
    catch (e) { empty(host, '读不到：' + e.message); return; }
    const c = ov.counts || {};
    host.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (c.chapters || 0) + '</b><span>章节</span></div>' +
      '<div class="t-stat"><b>' + (c.promisesOpen || 0) + '</b><span>没兑现的伏笔</span></div>' +
      '<div class="t-stat"><b>' + (c.promisesPaid || 0) + '</b><span>已兑现</span></div></div>' +
      '<div class="t-seg wide" data-tabs>' +
      ['tree:承载树', 'threads:剧情线', 'promises:伏笔', 'decisions:决策', 'scenes:场景']
        .map((s) => { const [k, n] = s.split(':'); return '<button data-tab="' + k + '" class="' +
          (tab === k ? 'on' : '') + '">' + n + '</button>'; }).join('') + '</div>' +
      '<div data-pane style="margin-top:var(--sp-3)"></div>';
    const pane = host.querySelector('[data-pane]');
    const go = (t) => {
      worldTab = t;                       // 返回键再进来时用得上
      /* ⚠ 必须把「现在在哪一页」记回闭包那个 tab：reload() 结尾是 `go(tab)`。
         只改 worldTab 的话 ——「在剧情线页点一下加一条」重画完会跳回承载树，
         用户看到的是「我刚点的页签自己跑了」（第 19 轮 e2e-pl 抓到的真 bug）。 */
      tab = t;
      host.querySelectorAll('[data-tabs] button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
      ({ tree: renderTree, threads: renderThreads, promises: renderPromises,
         decisions: renderDecisions, scenes: renderScenes }[t] || renderTree)();
    };
    host.querySelector('[data-tabs]').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]'); if (!b) return;
      hap(); go(b.dataset.tab);
    });

    async function reload() {
      ov = await get('/api/plot/overview', { slug });
      go(tab);
    }

    function renderTree() {
      const chs = ov.chapters || [];
      pane.innerHTML =
        '<div class="t-hint" style="margin-bottom:var(--sp-3)">按顺序排下来的章节。每章能看出写到哪一步、目标多少字、挂了几条细纲和伏笔。</div>' +
        '<div class="t-bar"><button class="t-btn pri" data-newch>新建章节</button></div>' +
        '<div class="t-list">' + (chs.length ? chs.map((ch, i) => {
          const words = ch.words || 0;
          const target = ch.target_words || 0;
          const pct = target ? Math.min(100, Math.round(words / target * 100)) : 0;
          return '<div class="t-row" data-i="' + i + '">' + ico('file') +
            '<div class="tr-main"><div class="tr-title">' + esc(ch.title || ch.path) + '</div>' +
            '<div class="tr-sub">' + esc([words + ' 字', STATUS_CN[ch.status] || ch.status || '草稿',
              target ? ('目标 ' + target) : '', (ch.promises || []).length ? ((ch.promises || []).length + ' 条伏笔') : '',
            ].filter(Boolean).join(' · ')) + '</div>' +
            (target ? '<div class="st-bar"><i style="width:' + pct + '%"></i></div>' : '') +
            '</div><span class="tr-go">' + window.iconHtml('chevron') + '</span></div>';
        }).join('') : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">还没有章节</div></div></div>') + '</div>';
      pane.querySelector('[data-newch]').onclick = async () => {
        hap();
        const name = await ask('新章节叫什么', '第' + String(chs.length + 1).padStart(3, '0') +
          '章-' + (ov.title || '').slice(0, 8), { placeholder: '第006章-名字' });
        if (!name) return;
        const p = 'manuscript/' + name.trim().replace(/\.md$/, '') + '.md';
        try { await post('/api/chapter/new', { slug, path: p, content: '# ' + name.trim() + '\n\n' }); }
        catch (e) { toast('建不了：' + e.message); return; }
        toast('建好了'); hap(); await reload();
      };
      pane.querySelectorAll('[data-i]').forEach((r) => {
        r.onclick = () => { hap(); const ch = chs[Number(r.dataset.i)]; push('剧情 · ' + ch.title, (h2) => chapterPlot(h2, slug, ch)); };
      });
    }

    async function chapterPlot(host2, slug2, ch) {
      loading(host2, '读这一章…');
      let ol, sc, du;
      try {
        ol = await get('/api/plot/outline', { slug: slug2, path: ch.path });
        du = await get('/api/plot/promises/due', { slug: slug2 });
        sc = ov.scenes.filter((s) => s.chapter_path === ch.path);
      } catch (e) { empty(host2, '读不到：' + e.message); return; }
      const outs = ol.items || [];
      const due = (du.items || []).filter((p) => p.due_chapter === ch.path);
      host2.innerHTML =
        '<div class="t-bar"><button class="t-btn" data-draft>去写这一章</button></div>' +
        '<h2 class="st-h">细纲</h2>' +
        '<div class="t-list">' + (outs.length ? outs.map((o) =>
          '<div class="t-row static">' + ico(o.approved ? 'check' : 'file') +
          '<div class="tr-main"><div class="tr-title" style="white-space:pre-wrap;font-weight:var(--w-normal)">' + esc(o.body) +
          '</div><div class="tr-sub">' + esc(o.approved ? '已采用' : '待确认') + '</div></div></div>').join('')
          : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">还没有细纲，去写作台生成</div></div></div>') + '</div>' +
        (due.length ? '<h2 class="st-h">这一章到期该收的线</h2><div class="t-list">' + due.map((p) =>
          '<div class="t-row static">' + ico('bookmark') + '<div class="tr-main"><div class="tr-title">' +
          esc(p.name) + '</div><div class="tr-sub">' + esc(p.status === 'paid' ? '已兑现' : '还欠着') + '</div></div></div>').join('') + '</div>' : '') +
        '<h2 class="st-h">场景</h2>' +
        '<div class="t-list">' + (sc.length ? sc.map((s) =>
          '<div class="t-row static">' + ico('layers') + '<div class="tr-main"><div class="tr-title">' +
          esc(s.title || '（没名字的场景）') + '</div><div class="tr-sub">' +
          esc([s.summary || '', (s.cast || []).join('、')].filter(Boolean).join(' · ')) + '</div></div>' +
          '<button class="t-btn sm dim" data-rm="' + s.id + '">删</button></div>').join('')
          : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">这一章还没拆场景</div></div></div>') + '</div>' +
        '<div class="t-bar" style="margin-top:var(--sp-3)"><button class="t-btn pri" data-addsc>加一个场景</button></div>';
      host2.querySelector('[data-draft]').onclick = () => {
        U().back();
        push('写 · ' + (ch.title || ch.path), (h3) => chapterStudio(h3, slug2, ch));
      };
      host2.querySelector('[data-addsc]').onclick = async () => {
        const title = await ask('场景名字', '', { placeholder: '例：城门被拦' });
        if (!title) return;
        const summary = await ask('这一场发生什么', '', { placeholder: '谁在哪做了什么', multiline: true });
        try {
          await post('/api/plot/scene', { slug: slug2, chapterPath: ch.path, title, summary: summary || '' });
          toast('加好了'); hap(); ov = await get('/api/plot/overview', { slug: slug2 });
        } catch (e) { toast('加不了：' + e.message); }
      };
      host2.querySelectorAll('[data-rm]').forEach((b) => {
        b.onclick = async () => {
          if (!(await confirmBox('删掉这个场景？'))) return;
          try { await del('/api/plot/scene', { slug: slug2, id: b.dataset.rm }); toast('删了'); hap(); U().back(); }
          catch (e) { toast('删不掉：' + e.message); }
        };
      });
    }

    /* 剧情线：主线/支线追踪。
       后端 /plot/overview 早就把 threads 一并返回了（连 counts.threads 都算好了），
       可这个面板以前 4 个页签一条都不显示 —— 数据白算，用户也没地方建。
       这里接上：能看、能建、能删、点开能看它挂了哪些场景（场景本身在「场景」页签里管）。 */
    /* 剧情线 —— 用户第 32 轮把它**当大纲用**：
       ① 防忘（书写长了，AI 记不住前面定过什么）② 防跑偏（别把书带成另一种调子）
       ③ 防 OOC（人物该是什么样，有一个锚）。
       它是**用户和 AI 都能改**的一栏，规矩是：**用户手改过的以用户为准，AI 不会自己覆盖**
       （后端 thread.origin 记着"这条是谁定的"，迁移 0013 加的；AI 那边走 outline_write 工具，
       碰到 origin=user 的条目会直接回"这条是用户定的，我不动"）。
       所以每一行都**把「谁定的」摆出来**，用户一眼能看见自己的改动生效了。 */
    /* 剧情线 —— **内容就是「大纲」**（用户第 36 轮拍板：名字留着，作用换成大纲）。
       这块 UI **一份实现两个入口**：本体在 js/outline.js，
       工具宫格的「故事线」点开也是同一块（用户原话：「点击这个故事线之后，它里面的
       前端和后端都要重做，就相当于删除了，把这个功能换成大纲」）。
       以前这里自己写了一套一模一样的（加/改/删 + 「谁定的」徽标）——
       两套并存正是用户点名的"UI 不统一"的来源，所以**删掉这一套，改成调那一个**。
       规矩不变（后端 + 工具层有判据，见 tools/check_outline.py）：防忘 / 防跑偏 / 防 OOC，
       **用户手改过的以用户为准，AI 不会自己覆盖**。 */
    function renderThreads() {
      if (!window.Outline) {
        pane.innerHTML = '<div class="t-empty">大纲模块没加载（页面缺 js/outline.js）</div>';
        return;
      }
      window.Outline.mount(pane, slug);
    }

    async function renderPromises() {
      const items = ov.promises || [];
      const open = items.filter((p) => p.status === 'open' || p.status === 'advanced');
      const paid = items.filter((p) => p.status === 'paid');
      const rows = (arr) => arr.map((p) => {
        let steps = [];
        try { steps = JSON.parse(p.advance_json || '[]') || []; } catch (e) { steps = []; }
        return '<div class="t-row static">' + ico('bookmark') +
          '<div class="tr-main"><div class="tr-title">' + esc(p.name) + '</div>' +
          '<div class="tr-sub">' + esc([p.kind === 'foreshadow' ? '伏笔' : p.kind,
            p.status === 'paid' ? '已兑现' : p.status === 'dropped' ? '放弃了' : '还欠着',
            p.due_chapter ? ('计划在 ' + p.due_chapter) : '', steps.length ? (steps.length + ' 次推进') : '',
          ].filter(Boolean).join(' · ')) + '</div>' +
          (p.note ? '<div class="tr-sub wrap">' + esc(p.note) + '</div>' : '') + '</div>' +
          (p.status !== 'paid' ? '<button class="t-btn sm" data-adv="' + p.id + '">兑现</button>' : '') +
          '<button class="t-btn sm" data-step="' + p.id + '">推进</button>' +
          '<button class="t-btn sm dim" data-rm="' + p.id + '">删</button></div>';
      }).join('');
      pane.innerHTML =
        '<div class="t-bar"><button class="t-btn pri" data-add>埋一条新伏笔</button></div>' +
        '<div class="t-hint" style="margin-bottom:var(--sp-3)">这里登记对读者的承诺；写到该兑现的章节会提醒（章节详情里列出本章到期的线索）。</div>' +
        (open.length ? '<h2 class="st-h">还欠着 ' + open.length + ' 条</h2><div class="t-list">' + rows(open) + '</div>' : '') +
        (paid.length ? '<h2 class="st-h">已兑现 ' + paid.length + ' 条</h2><div class="t-list">' + rows(paid) + '</div>' : '') +
        (!items.length ? '<div class="t-empty">还没有伏笔</div>' : '');
      pane.querySelector('[data-add]').onclick = async () => {
        const name = await ask('埋了什么', '', { placeholder: '例：木牌是谁给的' });
        if (!name) return;
        const note = await ask('备注（可空）', '', { placeholder: '打算怎么收' });
        try { await post('/api/plot/promise', { slug, name, note: note || '' }); toast('埋好了'); hap(); reload(); }
        catch (e) { toast('埋不了：' + e.message); }
      };
      pane.querySelectorAll('[data-adv]').forEach((b) => {
        b.onclick = async () => {
          try { await post('/api/plot/promise/advance', { slug, id: Number(b.dataset.adv), status: 'paid' });
            toast('兑现了'); hap(); reload(); }
          catch (e) { toast('记不下：' + e.message); }
        };
      });
      pane.querySelectorAll('[data-step]').forEach((b) => {
        b.onclick = async () => {
          const note = await ask('这次怎么推进的', '', { placeholder: '例：提了一句木牌上的字' });
          if (note === null) return;
          try { await post('/api/plot/promise/advance', { slug, id: Number(b.dataset.step), note }); toast('记下了'); hap(); reload(); }
          catch (e) { toast('记不下：' + e.message); }
        };
      });
      pane.querySelectorAll('[data-rm]').forEach((b) => {
        b.onclick = async () => {
          if (!(await confirmBox('删掉这条伏笔？'))) return;
          try { await del('/api/plot/promise', { slug, id: b.dataset.rm }); reload(); }
          catch (e) { toast('删不掉：' + e.message); }
        };
      });
    }

    async function renderDecisions() {
      const items = ov.decisions || [];
      pane.innerHTML =
        '<div class="t-bar"><button class="t-btn pri" data-add>记一条决策</button></div>' +
        '<div class="t-hint" style="margin-bottom:var(--sp-3)">为什么这么写、风险在哪。以后想推翻，旧的也不删，留着痕迹。</div>' +
        '<div class="t-list">' + (items.length ? items.map((d, i) =>
          '<div class="t-row static">' + ico('edit') +
          '<div class="tr-main"><div class="tr-title">' + esc(d.title) + '</div>' +
          '<div class="tr-sub wrap">' + esc([d.reason || '', d.risks ? ('风险：' + d.risks) : '',
            d.chapter_path || '', ago(d.at)].filter(Boolean).join(' · ')) + '</div>' +
          (d.status === 'superseded' ? '<div class="tr-sub">已被后来的决定取代</div>' : '') + '</div>' +
          (d.status === 'active' ? '<button class="t-btn sm" data-sup="' + d.id + '">推翻</button>' : '') +
          '<button class="t-btn sm dim" data-rm="' + d.id + '">删</button></div>').join('')
          : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">还没有决策记录</div></div></div>') + '</div>';
      pane.querySelector('[data-add]').onclick = async () => {
        const title = await ask('决定了什么', '', { placeholder: '例：让主角先示弱再爆发' });
        if (!title) return;
        const reason = await ask('为什么这么定', '', { placeholder: '理由' });
        const risks = await ask('有什么风险', '', { placeholder: '可能出的问题' });
        try { await post('/api/plot/decision', { slug, title, reason: reason || '', risks: risks || '' });
          toast('记下了'); hap(); reload(); }
        catch (e) { toast('记不下：' + e.message); }
      };
      pane.querySelectorAll('[data-sup]').forEach((b) => {
        b.onclick = async () => {
          const title = await ask('改成什么', '', { placeholder: '新的决定' });
          if (!title) return;
          const reason = await ask('为什么改', '', { placeholder: '理由' });
          try { await post('/api/plot/decision/supersede', { slug, id: Number(b.dataset.sup), title, reason: reason || '' });
            toast('改了'); hap(); reload(); }
          catch (e) { toast('改不了：' + e.message); }
        };
      });
      pane.querySelectorAll('[data-rm]').forEach((b) => {
        b.onclick = async () => {
          if (!(await confirmBox('删掉这条决策记录？'))) return;
          try { await del('/api/plot/decision', { slug, id: b.dataset.rm }); reload(); }
          catch (e) { toast('删不掉：' + e.message); }
        };
      });
    }

    async function renderScenes() {
      const scenes = ov.scenes || [];
      pane.innerHTML =
        '<div class="t-hint" style="margin-bottom:var(--sp-3)">场景是「一章里的一段戏」，可以挂世界时刻、地点和出场的人。</div>' +
        '<div class="t-list">' + (scenes.length ? scenes.map((s) =>
          '<div class="t-row static">' + ico('layers') +
          '<div class="tr-main"><div class="tr-title">' + esc(s.title || '（没名字）') + '</div>' +
          '<div class="tr-sub wrap">' + esc([s.chapter_path, s.summary || '',
            (s.cast || []).join('、')].filter(Boolean).join(' · ')) + '</div></div>' +
          '<button class="t-btn sm dim" data-rm="' + s.id + '">删</button></div>').join('')
          : '<div class="t-empty">还没有拆场景</div>') + '</div>';
      pane.querySelectorAll('[data-rm]').forEach((b) => {
        b.onclick = async () => {
          if (!(await confirmBox('删掉这个场景？'))) return;
          try { await del('/api/plot/scene', { slug, id: b.dataset.rm }); reload(); }
          catch (e) { toast('删不掉：' + e.message); }
        };
      });
    }

    go(tab);
  }

  /* ══════════════════════════════════════════════════════════
     通用小件：页签壳 / 分数色 / 日期
     ══════════════════════════════════════════════════════════ */

  /* 每个「一屏多页签」的面板都用它，省得各写一套页签逻辑。
     renders[k](pane, repaint)：pane 是这一页的容器，repaint 重新画这一页。 */
  /* 页签记性：从「说话方式 / 改一条参考」这类子页返回时，要回到刚才那一屏，
     别一脚踢回第一个页签（用户会以为点错了）。**跟世界面板同一个规矩**。 */
  const LAST_TAB = {};
  function tabShell(host, defs, renders) {
    const sig = defs.map(([k]) => k).join('|');
    const start = defs.some(([k]) => k === LAST_TAB[sig]) ? LAST_TAB[sig] : defs[0][0];
    host.innerHTML =
      '<div class="t-seg wide" data-tabs>' + defs.map(([k, l]) =>
        '<button data-tab="' + esc(k) + '"' + (k === start ? ' class="on"' : '') + '>' +
        esc(l) + '</button>').join('') +
      '</div>' +
      defs.map(([k]) => '<div data-pane="' + esc(k) + '" style="margin-top:var(--sp-3)"' +
        (k === start ? '' : ' hidden') + '></div>').join('');
    const paint = (k) => {
      const el = host.querySelector('[data-pane="' + k + '"]');
      if (!el) return;
      try { renders[k](el, () => paint(k)); }
      catch (e) { el.innerHTML = '<div class="t-empty">出错了：' + esc(e.message || e) + '</div>'; }
    };
    host.querySelector('[data-tabs]').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]'); if (!b) return;
      hap();
      LAST_TAB[sig] = b.dataset.tab;
      host.querySelectorAll('[data-tabs] button').forEach((x) => x.classList.toggle('on', x === b));
      host.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
      paint(b.dataset.tab);
    });
    paint(start);
  }

  /* 评分颜色：阈值**不写死在前端**，从 `/api/lint/rules` 的 gradeBands 读（后端 GRADE_BANDS 是唯一出处）。
     规则：≥90 绿（ok）/ 75–89 黄（mid）/ <75 红（warn）。接口拿不到时才退回这三个默认值。
     ——踩过的坑：以前前端写 85/70、后端用 90/75，同一本书两个界面两个颜色。 */
  let BANDS = [{ min: 90, name: '干净' }, { min: 75, name: '还行' }, { min: 0, name: '要改' }];
  let bandsAsked = false;
  /* 懒加载：**进质检页时**才去问后端要阈值。
     以前是脚本一加载就发请求 —— 那时候人还没登录，每次都吃一个 401，
     前端的"失败请求"统计里永远挂着一条假问题。 */
  async function loadBands() {
    if (bandsAsked) return;
    bandsAsked = true;
    try {
      const d = await API.raw('api/lint/rules');
      if (d && Array.isArray(d.gradeBands) && d.gradeBands.length) {
        BANDS = d.gradeBands.slice().sort((a, b) => b.min - a.min);
      }
    } catch (e) { /* 拿不到就用默认三段，不拦着人看 */ }
  }
  const bandOf = (s) => BANDS.find((b) => s >= b.min) || BANDS[BANDS.length - 1];
  /* 预算好的三段类名（阈值仍来自 gradeBands 的 min，不在这里另写一套数字）：
     ≥90 绿 ok，75–89 黄 mid，<75 红 warn。 */
  const pillOf = (s) => { const b = bandOf(s); return b.min >= 90 ? 'ok' : b.min >= 75 ? 'mid' : 'warn'; };
  window.LintScoreClass = pillOf;   // 给自测用（e2e-ui.js 会喂 92/88/80 断言颜色段）
  const gradeText = (s) => (s >= 90 ? '干净：没什么机器味'
    : s >= 75 ? '还行：有几处顺手就能改'
    : s >= 50 ? '有点 AI 味：建议改一改再往下写'
    : 'AI 味很重：填充词和套话太多，建议整章过一遍');
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  const fmtDate = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());

  /* 让浏览器去下文件。
     App 里页面是 file:// 的、拿不到 cookie，所以地址经过 API.media()：指向本机 127.0.0.1 并带上口令 */
  function download(url) {
    const a = document.createElement('a');
    a.href = window.API.media(url); a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* 带文件的表单（导入用）。和 api.js 的 j() 一样把错误说清楚，只是 body 是 FormData。 */
  async function upload(path, fd) {
    const r = await fetch(window.API.abs(path), { method: 'POST', credentials: 'include', body: fd });
    if (r.status === 401) { App.needLogin(); throw new Error('未登录'); }
    const txt = await r.text();
    let d = null; try { d = txt ? JSON.parse(txt) : null; } catch (e) { d = txt; }
    if (!r.ok) throw new Error((d && (d.detail || d.message)) || ('失败 ' + r.status));
    return d;
  }

  /* ══════════════════════════════════════════════════════════
     4. 质检：扫 AI 味 / 一键修 / 规则表
     ══════════════════════════════════════════════════════════ */
  function openLint(host) { Push.book('质检', lintHome); }

  function lintHome(host, slug) {
    tabShell(host, [['book', '全书'], ['one', '单章'], ['voice', '声音'],
                    ['body', '体检'], ['rules', '规则']], {
      book: (pane, repaint) => lintBook(pane, slug, repaint),
      voice: (pane) => lintVoice(pane, slug),
      body: (pane) => lintBody(pane, slug),
      one: (pane) => chapterPicker(pane, slug, (ch) => {
        push('质检 · ' + (ch.name || ch.path), (h2) => lintChapter(h2, slug, ch.path));
      }, { hint: '点一章，查它的 AI 味' }),
      rules: (pane) => lintRules(pane),
    });
  }

  function scoreLine(c) {
    const cats = Object.entries(c.byCategory || {}).filter(([, n]) => n)
      .sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => k + ' ' + n).join('、');
    return (c.hits || 0) + ' 处' + (cats ? ' · ' + cats : '') + ' · ' + (c.chars || 0) + ' 字';
  }

  async function lintBook(pane, slug, repaint) {
    loading(pane, '逐章扫一遍…');
    let d;
    try { d = await post('/api/lint/scan-book', { slug }); }
    catch (e) { empty(pane, '扫不了：' + e.message); return; }
    // 排序：默认**按章节序号升序**（001→002→003…，跟目录一致）。
    // 想先改最脏的那几章，点上面的「按分数排」切换 —— 切了以后标题上会写明排序方式，
    // 免得看着像乱序（踩过的坑：只按分数排又不说明，用户以为是 bug）。
    const natural = (arr) => arr.slice().sort((a, b) => String(a.path || '').localeCompare(
      String(b.path || ''), 'zh-Hans-CN', { numeric: true }));
    const byScoreArr = (arr) => arr.slice().sort((a, b) => (a.score || 0) - (b.score || 0));
    let scoreOrder = lintByScore;
    const chs = scoreOrder ? byScoreArr(d.chapters || []) : natural(d.chapters || []);
    pane.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (d.score || 0) + '</b><span>全书评分</span></div>' +
      '<div class="t-stat"><b>' + (d.totalHits || 0) + '</b><span>命中处</span></div>' +
      '<div class="t-stat"><b>' + chs.length + '</b><span>章</span></div></div>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">' + esc(gradeText(d.score || 0)) +
      '。分数按「每千字命中几次」算，本地规则扫的，不花一分钱。<br>' +
      (scoreOrder ? '现在是**按分数从低到高排**（最该改的在前）。' : '现在是**按章节顺序**排（001、002、003…）。') + '</div>' +
      '<div class="t-bar"><button class="t-btn" data-rescan>重新扫一遍</button>' +
      '<button class="t-btn" data-order>' + (scoreOrder ? '按章节排' : '按分数排') + '</button>' +
      '<button class="t-btn" data-llm>用模型看语境</button></div>' +
      '<div data-llmout></div>' +
      (chs.length ? '<div class="t-list">' + chs.map((c, i) =>
        '<div class="t-row" data-i="' + i + '">' + ico('file') +
        '<div class="tr-main"><div class="tr-title">' + esc(c.name || c.path) + '</div>' +
        '<div class="tr-sub">' + esc(scoreLine(c)) + '</div></div>' +
        '<span class="t-pill ' + pillOf(c.score || 0) + '">' + (c.score || 0) + ' 分</span></div>').join('') + '</div>'
        : '<div class="t-empty">这本书还没有章节</div>');
    pane.querySelectorAll('[data-i]').forEach((r) => {
      r.onclick = () => {
        hap();
        const c = chs[Number(r.dataset.i)];
        push('质检 · ' + (c.name || c.path), (h2) => lintChapter(h2, slug, c.path));
      };
    });
    pane.querySelector('[data-rescan]').onclick = () => { hap(); repaint(); };
    pane.querySelector('[data-order]').onclick = () => {
      lintByScore = !scoreOrder; hap(); lintBook(pane, slug, repaint);
    };
    pane.querySelector('[data-llm]').onclick = () => llmCheck(pane, slug, '');
  }

  async function lintChapter(host, slug, path) {
    await loadBands();
    loading(host, '扫这一章…');
    let d;
    try { d = await post('/api/lint/scan', { slug, path }); }
    catch (e) { empty(host, '扫不了：' + e.message); return; }
    const st = d.stats || {};
    const hits = d.hits || [];
    const byCat = {};
    hits.forEach((h) => { (byCat[h.category] = byCat[h.category] || []).push(h); });
    host.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (st.score == null ? '—' : st.score) + '</b><span>评分</span></div>' +
      '<div class="t-stat"><b>' + (st.total || 0) + '</b><span>命中处</span></div>' +
      '<div class="t-stat"><b>' + (st.densityPerK || 0) + '</b><span>每千字</span></div></div>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">' + esc(gradeText(st.score || 0)) +
      '（这一章 ' + (d.chars || 0) + ' 字）</div>' +
      '<div class="t-bar"><button class="t-btn pri" data-fix>一键修（先看）</button>' +
      '<button class="t-btn" data-llm>用模型看语境</button></div>' +
      '<div data-fixout></div><div data-llmout></div>' +
      (hits.length ? Object.keys(byCat).map((cat) =>
        '<h2 class="st-h">' + esc(cat) + ' · ' + byCat[cat].length + ' 处</h2>' +
        '<div class="t-list">' + byCat[cat].map((h) =>
          '<div class="t-row static">' + ico('edit') +
          '<div class="tr-main"><div class="tr-title">' + esc(h.name || h.rule) + '　' +
          (h.text ? '<span style="color:var(--danger)">' + esc(h.text) + '</span>' : '') + '</div>' +
          '<div class="tr-sub wrap">' + esc('第 ' + h.line + ' 行：' + (h.context || '')) + '</div>' +
          '<div class="tr-sub wrap">' + esc(h.advice || '') + '</div></div>' +
          (h.fixable ? '<span class="t-pill">可自动修</span>' : '') + '</div>').join('') + '</div>').join('')
        : '<div class="t-empty">这一章挺干净，没扫出问题</div>');
    host.querySelector('[data-fix]').onclick = () => lintFix(host, slug, path);
    host.querySelector('[data-llm]').onclick = () => llmCheck(host, slug, path);
  }

  async function lintFix(host, slug, path) {
    const slot = host.querySelector('[data-fixout]');
    loading(slot, '试着修一版…');
    let d;
    try { d = await post('/api/lint/fix', { slug, path, apply: false }); }
    catch (e) { slot.innerHTML = '<div class="t-empty">修不了：' + esc(e.message) + '</div>'; return; }
    if (!d.changed) {
      slot.innerHTML = '<div class="t-hint" style="margin-bottom:var(--sp-3)">这一章没有能自动删的东西，' +
        '得照上面的建议手动改。</div>';
      return;
    }
    slot.innerHTML =
      '<div class="t-form"><div class="t-field"><label>一键修会做什么</label>' +
      '<div class="t-hint" style="margin:0">删掉 ' + d.removed + ' 处「删了不影响意思」的赘余' +
      '（填充词、机械转折这类）。命中从 ' + d.before.hits + ' 处降到 ' + d.after.hits +
      ' 处，评分 ' + d.before.score + ' → ' + d.after.score + '。' +
      '改动会记进「改动」，来源标成「AI 改的」，随时能退回来。</div></div></div>' +
      '<div class="t-bar"><button class="t-btn pri" data-apply>就这么改</button>' +
      '<button class="t-btn" data-preview>看看改成什么样</button></div>' +
      '<div data-prev></div>';
    slot.querySelector('[data-preview]').onclick = () => {
      const box = slot.querySelector('[data-prev]');
      if (box.dataset.on) { box.innerHTML = ''; delete box.dataset.on; return; }
      box.dataset.on = '1';
      box.innerHTML = '<div class="t-pre selectable">' + esc(d.text || '') + '</div>';
    };
    slot.querySelector('[data-apply]').onclick = async () => {
      if (!(await confirmBox('真的按这个改这一章？改完能在「改动」里退回。'))) return;
      try {
        await post('/api/lint/fix', { slug, path, apply: true });
        toast('改好了，去「改动」里看'); hap();
        lintChapter(host, slug, path);
      } catch (e) { toast('改不了：' + e.message); }
    };
  }

  async function llmCheck(host, slug, path) {
    const slot = host.querySelector('[data-llmout]');
    if (!slot) return;
    loading(slot, '让模型读一遍…');
    try {
      const d = await post('/api/lint/llm', { slug, path });
      slot.innerHTML = '<h2 class="st-h">模型看到的语境问题</h2>' +
        '<div class="t-pre selectable">' + esc((d.model ? '（' + d.model + '）\n' : '') + d.text) + '</div>';
    } catch (e) {
      slot.innerHTML = '<div class="t-hint">看不了：' + esc(e.message) + '</div>';
    }
  }

  /* ── 质检 · 声音：谁和谁一个腔 ──────────────────────────────
     568 条规则只看"这段文字像不像 AI"，看不出"这句台词像不像**这个人**"。
     这一屏就是那一半：档案、台词指纹、两两像度，全在本地算，断网也能看。 */
  const statCell = (v, l) => '<div class="t-stat"><b>' + esc(v) + '</b><span>' + esc(l) + '</span></div>';

  async function lintVoice(pane, slug) {
    loading(pane, '听一遍所有人怎么说话…');
    let d;
    try { d = await get('/api/voice/report', { slug }); }
    catch (e) { empty(pane, '读不到：' + e.message); return; }
    const st = d.stats || {};
    const people = d.people || [];
    const pairs = d.pairs || [];
    const parts = [];
    parts.push('<div class="t-stats">' + statCell(d.score, '声音分') +
      statCell((st.characters || 0), '角色') +
      statCell((st.withProfile || 0) + '/' + (st.characters || 0), '有档案') +
      statCell((st.dialogueLines || 0), '台词句') + '</div>');
    parts.push('<div class="t-bar"><span class="t-pill ' + pillOf(d.score) + '">' + esc(d.grade) +
      '</span>' + (st.worstSimilarity ? '<span class="t-pill gray">最像的一对 ' +
      Math.round(st.worstSimilarity * 100) + '%</span>' : '') + '</div>');
    /* 这一段以前写成 `a ? x : '' + y` —— JS 里 `'' + y` 先算，于是"后面的东西全进了 else"，
       实测表现是：有建议时整个名单不渲染（一个「建档案」按钮都点不到）。*/
    if ((d.advice || []).length) {
      parts.push('<div class="t-hint" style="margin:var(--sp-3) 0">' +
        d.advice.map((a) => esc(a)).join('<br>') + '</div>');
    }
    if (pairs.length) {
      parts.push('<h2 class="st-h">像一个模子刻的</h2><div class="t-list">' + pairs.map((x) =>
        '<div class="t-row warn">' + ico('users') +
        '<div class="tr-main"><div class="tr-title">「' + esc(x.a) + '」和「' + esc(x.b) +
        '」像度 ' + Math.round(x.similarity * 100) + '%</div>' +
        '<div class="tr-sub wrap">' + esc(x.why) +
        (x.shared && x.shared.length ? ' · 都在说：' + esc(x.shared.join('、')) : '') +
        '</div></div></div>').join('') + '</div>');
    }
    parts.push('<h2 class="st-h">每个人怎么说话</h2>');
    if (people.length) {
      parts.push('<div class="t-list">' + people.map((q, i) => {
        const fp = q.fingerprint || {};
        const sub = fp.lines
          ? (fp.lines + ' 句台词 · 平均 ' + fp.avgLen + ' 字/句 · 问句 ' +
             Math.round((fp.askRatio || 0) * 100) + '%' +
             ((fp.topWords || []).length ? ' · 常说：' + fp.topWords.slice(0, 4).join('、') : ''))
          : '正文里还没找到他的台词（对话后面写一句「XX说」就能认出来）';
        return '<div class="t-row" data-who="' + esc(q.name) + '">' + ico('users') +
          '<div class="tr-main"><div class="tr-title">' + esc(q.name) +
          (q.hasProfile ? ' <span class="t-pill ok">有档案</span>'
                        : ' <span class="t-pill gray">没档案</span>') +
          '</div><div class="tr-sub wrap">' + esc(sub) +
          ((q.issues || []).length ? '<br>' + esc(q.issues[0].text) : '') + '</div></div>' +
          '<button class="t-btn sm" data-open="' + i + '">' +
          (q.hasProfile ? '改档案' : '建档案') + '</button></div>';
      }).join('') + '</div>');
    } else {
      parts.push('<div class="t-empty">这本书还没有角色。先去「世界」建几个人。</div>');
    }
    pane.innerHTML = parts.join('');
    pane.querySelectorAll('[data-open]').forEach((b) => {
      b.onclick = () => {
        hap();
        const q = people[Number(b.dataset.open)];
        push('说话方式 · ' + q.name, (h) => voiceForm(h, slug, q.name, () => lintVoice(pane, slug)));
      };
    });
  }

  /* 一个人的声音档案：照着后端给的字段定义渲染（只有一份定义，不在这里另写一遍） */
  async function voiceForm(host, slug, name, after) {
    loading(host, '读他的台词…');
    let d, fields;
    try {
      d = await get('/api/voice/profile', { slug, name });
      fields = (await get('/api/voice/fields')).items || [];
    } catch (e) { empty(host, '读不到：' + e.message); return; }
    const v = d.voice || {};
    const asLines = (k) => (v[k] || []).join('\n');
    const asPairs = (k) => Object.entries(v[k] || {}).map(([a, b]) => a + '=' + b).join('\n');
    const field = (f) => {
      const key = f.key, lab = '<label>' + esc(f.label) + '</label>';
      if (f.kind === 'choice') {
        return '<div class="t-field">' + lab + '<div class="t-chips" data-f="' + key + '">' +
          f.options.map((o) => '<button class="t-pill ' + (v[key] === o ? 'ok' : 'gray') +
            '" data-v="' + esc(o) + '">' + esc(o) + '</button>').join('') + '</div>' +
          '<div class="t-hint">' + esc(f.hint) + '</div></div>';
      }
      if (f.kind === 'lines') {
        return '<div class="t-field">' + lab + '<textarea class="t-area" data-f="' + key +
          '" style="min-height:72px" placeholder="一行一条">' + esc(asLines(key)) + '</textarea>' +
          '<div class="t-hint">' + esc(f.hint) + '</div></div>';
      }
      if (f.kind === 'pairs') {
        return '<div class="t-field">' + lab + '<textarea class="t-area" data-f="' + key +
          '" style="min-height:64px" placeholder="对谁=怎么叫">' + esc(asPairs(key)) + '</textarea>' +
          '<div class="t-hint">' + esc(f.hint) + '</div></div>';
      }
      if (f.kind === 'scale') {
        return '<div class="t-field">' + lab + '<input class="t-input" type="number" min="0" max="10" data-f="' +
          key + '" value="' + esc(v[key] == null ? '' : v[key]) + '">' +
          '<div class="t-hint">' + esc(f.hint) + '</div></div>';
      }
      return '<div class="t-field">' + lab + '<input class="t-input" data-f="' + key +
        '" value="' + esc(v[key] || '') + '"><div class="t-hint">' + esc(f.hint) + '</div></div>';
    };
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">填了这些，写正文时**这个人的台词**会照它来 —— ' +
      '「所有角色一个腔」是 AI 味里最典型的一种，568 条规则一条都管不到。</div>' +
      '<div class="t-form">' + fields.map(field).join('') + '</div>' +
      ((d.candidates || []).length
        ? '<h2 class="st-h">他常说的话（点一下加进口头禅）</h2><div class="t-chips" data-cands>' +
          d.candidates.map((c) => '<button class="t-pill gray" data-w="' + esc(c.word) + '">' +
            esc(c.word) + ' <b>' + c.count + '</b></button>').join('') + '</div>' : '') +
      ((d.issues || []).length
        ? '<h2 class="st-h">现在的问题</h2><div class="t-list">' + d.issues.map((i) =>
            '<div class="t-row' + (i.level === 'warn' ? ' warn' : '') + '">' + ico('dot') +
            '<div class="tr-main"><div class="tr-title">' + esc(i.text) + '</div>' +
            '<div class="tr-sub wrap">' + esc(i.advice || '') + '</div></div></div>').join('') + '</div>' : '') +
      ((d.samples || []).length
        ? '<h2 class="st-h">他的台词（带出处）</h2><div class="t-list">' + d.samples.slice(0, 8).map((x) =>
            '<div class="t-row static">' + ico('text') +
            '<div class="tr-main"><div class="tr-title">「' + esc(x.line) + '」</div>' +
            '<div class="tr-sub">' + esc((x.path || '').split('/').pop() + ' 第 ' + x.lineNo + ' 行') +
            '</div></div></div>').join('') + '</div>' : '') +
      '<div class="t-bar" style="margin-top:var(--sp-4)"><button class="t-btn pri" data-save>存下他的说话方式</button>' +
      '<button class="t-btn" data-clear>清空档案</button></div>';
    host.querySelectorAll('[data-f].t-chips').forEach((row) => {
      row.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        hap();
        row.querySelectorAll('button').forEach((x) => {
          x.classList.toggle('ok', x === b);
          x.classList.toggle('gray', x !== b);
        });
      });
    });
    const candBox = host.querySelector('[data-cands]');
    const catchTa = host.querySelector('[data-f="catchphrases"]');
    if (candBox && catchTa) {
      candBox.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-w]'); if (!b) return;
        hap();
        const w = b.dataset.w;
        const have = catchTa.value.split('\n').map((x) => x.trim()).filter(Boolean);
        if (have.indexOf(w) > -1) { toast('已经在里面了'); return; }
        have.push(w);
        catchTa.value = have.join('\n');
        toast('加上了：' + w);
      });
    }
    host.querySelector('[data-save]').onclick = async () => {
      const voice = {};
      host.querySelectorAll('[data-f]').forEach((el) => {
        const key = el.dataset.f;
        if (el.classList.contains('t-chips')) {
          const on = el.querySelector('button.ok');
          if (on) voice[key] = on.dataset.v;
        } else if (el.tagName === 'TEXTAREA') {
          if (el.value.trim()) voice[key] = el.value;
        } else if (el.value !== '' && el.value != null) {
          voice[key] = el.value;
        }
      });
      try {
        await post('/api/voice/profile', { slug, name, voice });
        toast('存下了'); hap();
        if (after) after();
        U().back();
      } catch (e) { toast('存不下：' + e.message); }
    };
    host.querySelector('[data-clear]').onclick = async () => {
      if (!(await confirmBox('清空「' + name + '」的声音档案？（他的事实、关系都不会动）'))) return;
      try {
        await del('/api/voice/profile', { slug, name });
        toast('清空了'); hap();
        if (after) after();
        U().back();
      } catch (e) { toast('清不掉：' + e.message); }
    };
  }

  /* ── 质检 · 角色体检：正文里写出来的和别处对不上 ── */
  async function lintBody(pane, slug) {
    loading(pane, '把全书的人对一遍…');
    let d;
    try { d = await get('/api/consistency/report', { slug }); }
    catch (e) { empty(pane, '读不到：' + e.message); return; }
    const st = d.stats || {};
    pane.innerHTML =
      '<div class="t-stats">' + statCell(d.score, '一致性分') + statCell(st.people || 0, '角色') +
      statCell(st.warn || 0, '要改的') + statCell(st.info || 0, '看看就好') + '</div>' +
      '<div class="t-bar"><span class="t-pill ' + pillOf(d.score) + '">' + esc(d.grade) + '</span></div>' +
      '<div class="t-hint" style="margin:var(--sp-3) 0">年龄、外貌、称呼、代词、像笔误的名字、' +
      '久了没露面的人 —— 长篇最容易在这里崩，而且作者自己看不出来。</div>' +
      ((d.issues || []).length
        ? '<div class="t-list">' + d.issues.map((i, n) =>
            '<div class="t-row' + (i.level === 'warn' ? ' warn' : '') + '">' + ico('dot') +
            '<div class="tr-main"><div class="tr-title">' + esc(i.text) + '</div>' +
            '<div class="tr-sub wrap">' + esc(i.advice || '') +
            (i.where || []).slice(0, 3).map((w) => '<br>' + esc((w.path || '').split('/').pop()) +
              (w.line ? ' 第 ' + w.line + ' 行' : '') + (w.quote ? '：' + esc(w.quote) : '')).join('') +
            '</div></div>' +
            (i.suggestAlias ? '<button class="t-btn sm" data-ali="' + n + '">登记别名</button>' : '') +
            '</div>').join('') + '</div>'
        : '<div class="t-empty">没挑出前后不一致的地方。</div>');
    pane.querySelectorAll('[data-ali]').forEach((b) => {
      b.onclick = async () => {
        const i = d.issues[Number(b.dataset.ali)];
        const [who, alias] = i.suggestAlias;
        if (!(await confirmBox('把「' + alias + '」登记成「' + who + '」的别名？以后出场统计会算在一起。'))) return;
        try {
          await post('/api/consistency/alias', { slug, name: who, alias });
          toast('登记好了'); hap(); lintBody(pane, slug);
        } catch (e) { toast('登记不了：' + e.message); }
      };
    });
  }

  async function lintRules(pane) {
    loading(pane, '读规则表…');
    let d;
    try { d = await get('/api/lint/rules'); } catch (e) { empty(pane, '读不到：' + e.message); return; }
    const cats = d.categories || [];
    const items = d.items || [];
    pane.innerHTML = '<div class="t-hint" style="margin:0 0 var(--sp-3)">' + esc(d.summary || '') + '</div>' +
      cats.map((c) => {
        const rs = items.filter((r) => r.category === c);
        if (!rs.length) return '';
        return '<h2 class="st-h">' + esc(c) + ' · ' + rs.length + ' 条</h2><div class="t-list">' +
          rs.map((r) => '<div class="t-row static">' + ico('check') +
            '<div class="tr-main"><div class="tr-title">' + esc(r.name) + '</div>' +
            '<div class="tr-sub wrap">' + esc(r.advice || '') + '</div>' +
            '<div class="tr-sub"><span style="font:400 var(--t-sm)/1.5 ui-monospace,Menlo,monospace">' +
            esc(r.pattern || '') + '</span></div></div>' +
            (r.fixable ? '<span class="t-pill">可自动修</span>' : '') + '</div>').join('') + '</div>';
      }).join('');
  }

  /* ══════════════════════════════════════════════════════════
     5. 统计与成就：日历 / 曲线 / 花费 / 日报周报
     ══════════════════════════════════════════════════════════ */
  function openStats(host) { Push.book('统计', statsHome); }

  function statsHome(host, slug) {
    tabShell(host, [['overview', '概览'], ['pacing', '节奏'], ['calendar', '日历'], ['ach', '成就'],
                    ['cost', '花费'], ['report', '报告']], {
      overview: (pane, repaint) => statsOverview(pane, slug, repaint),
      pacing: (pane) => statsPacing(pane, slug),
      calendar: (pane) => statsCalendar(pane, slug),
      ach: (pane) => statsAchievements(pane, slug),
      cost: (pane) => statsCost(pane, slug),
      report: (pane) => statsReport(pane, slug),
    });
  }

  async function statsOverview(pane, slug, repaint) {
    loading(pane, '算一算…');
    let d;
    try { d = await get('/api/stats/book', { slug, days: 30 }); }
    catch (e) { empty(pane, '读不到：' + e.message); return; }
    const perDay = d.perDay || [];
    const chs = d.perChapter || [];
    const maxDay = Math.max(1, ...perDay.map((x) => x.words || 0));
    const maxCh = Math.max(1, ...chs.map((c) => c.words || 0));
    pane.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (d.totalWords || 0) + '</b><span>全书字数</span></div>' +
      '<div class="t-stat"><b>' + (d.chapters || 0) + '</b><span>章节</span></div>' +
      '<div class="t-stat"><b>' + (d.todayWords || 0) + '</b><span>今天写了</span></div>' +
      '</div>' +
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (d.streak || 0) + '</b><span>连续写作（天）</span></div>' +
      '<div class="t-stat"><b>' + (d.avgPerDay || 0) + '</b><span>平均每天</span></div>' +
      '<div class="t-stat"><b>' + (d.daysWritten || 0) + '</b><span>写过的天数</span></div>' +
      '</div>' +
      (d.target ? '<div class="t-form"><div class="t-field"><label>目标 ' + d.target +
        ' 字 · 已完成 ' + (d.progress || 0) + '%</label>' +
        '<div class="st-bar"><i style="width:' + Math.min(100, d.progress || 0) + '%"></i></div></div></div>' : '') +
      '<div class="t-bar"><button class="t-btn" data-refresh>重新算一遍</button></div>' +
      '<h2 class="st-h">最近 30 天</h2>' +
      (perDay.length
        ? '<div class="st-chart">' + perDay.map((x) =>
            '<i style="height:' + Math.max(3, Math.round((x.words || 0) / maxDay * 100)) + '%" ' +
            'title="' + esc(x.date + ' ' + (x.words || 0) + ' 字') + '"></i>').join('') + '</div>' +
          '<div class="t-hint" style="margin:0 0 var(--sp-4)">柱子越高那天写得越多，最高的一天 ' + maxDay + ' 字</div>'
        : '<div class="t-empty">还没有写作记录</div>') +
      '<h2 class="st-h">每章字数</h2>' +
      (chs.length ? '<div class="t-list">' + chs.map((c) =>
        '<div class="t-row static">' + ico('file') +
        '<div class="tr-main"><div class="tr-title">' + esc(c.name || c.path) + '</div>' +
        '<div class="st-bar" style="margin-top:var(--sp-2)"><i style="width:' +
        Math.max(2, Math.round((c.words || 0) / maxCh * 100)) + '%"></i></div></div>' +
        '<span class="t-pill gray">' + (c.words || 0) + ' 字</span></div>').join('') + '</div>'
        : '<div class="t-empty">还没有章节</div>');
    pane.querySelector('[data-refresh]').onclick = () => { hap(); repaint(); };
  }

  /* ── 统计 · 节奏：连着三章都在吵架，图上看得出来 ── */
  async function statsPacing(pane, slug) {
    loading(pane, '算一遍节奏…');
    let d;
    try { d = await get('/api/pacing/curve', { slug }); }
    catch (e) { empty(pane, '算不了：' + e.message); return; }
    const pts = d.points || [];
    if (!pts.length) { empty(pane, '这本书还没有章节。'); return; }
    const sm = d.summary || {};
    const X = (i) => (pts.length <= 1 ? 50 : (i / (pts.length - 1)) * 100);
    const Y = (v) => (40 - Math.max(0, Math.min(1, v)) * 40).toFixed(2);
    const YV = (v) => (40 - ((Math.max(-1, Math.min(1, v)) + 1) / 2) * 40).toFixed(2);
    const path = (f) => pts.map((p, i) => X(i).toFixed(2) + ',' + f(p)).join(' ');
    const last = pts[pts.length - 1];
    pane.innerHTML =
      '<div class="t-stats">' + statCell(sm.chapters || pts.length, '章') +
      statCell(Math.round((sm.words || 0) / 1000) + 'k', '字数') +
      statCell((sm.dialogueAvg * 100).toFixed(0) + '%', '对白占比') +
      statCell(sm.arousalMaxAt ? ('第 ' + sm.arousalMaxAt + ' 章') : '-', '最紧的一章') + '</div>' +
      '<h2 class="st-h">张力曲线（粉）与情绪正负（绿上红下）</h2>' +
      '<div class="t-pre" style="padding:0"><svg viewBox="0 0 100 40" preserveAspectRatio="none" ' +
      'style="width:100%;height:110px;display:block">' +
      '<line x1="0" y1="20" x2="100" y2="20" style="stroke:var(--line);stroke-width:.4" ' +
      'vector-effect="non-scaling-stroke"></line>' +
      '<polyline fill="none" vector-effect="non-scaling-stroke" style="stroke:var(--accent);stroke-width:1.6" points="' +
      path((p) => Y(p.arousal)) + '"></polyline>' +
      '<polyline fill="none" vector-effect="non-scaling-stroke" style="stroke:var(--ok);stroke-width:1.2;opacity:.85" points="' +
      path((p) => YV(p.valence)) + '"></polyline>' +
      '</svg></div>' +
      '<div class="t-hint" style="margin:var(--sp-2) 0 var(--sp-4)">横轴是章节顺序，纵轴：张力 0（缓）→1（紧）；' +
      '中间那条虚线是"情绪不咸不淡"。曲线一路贴着上边 = 一直绷着，贴着下边 = 一路压着。</div>' +
      ((d.alerts || []).length
        ? '<h2 class="st-h">走势里的毛病</h2><div class="t-list">' + d.alerts.map((a) =>
            '<div class="t-row' + (a.level === 'warn' ? ' warn' : '') + '">' + ico('chart') +
            '<div class="tr-main"><div class="tr-title">' + esc(a.text) + '</div>' +
            '<div class="tr-sub wrap">' + esc(a.advice) + '</div></div></div>').join('') + '</div>'
        : '<div class="t-empty">走势没挑出毛病。</div>') +
      '<h2 class="st-h">每一章</h2><div class="t-list">' + pts.map((p) =>
        '<div class="t-row static">' + ico('file') +
        '<div class="tr-main"><div class="tr-title">' + esc((p.title || p.path).split('/').pop()) +
        '</div><div class="tr-sub">' + p.chars + ' 字 · 张力 ' + p.arousal.toFixed(2) +
        ' · 情绪 ' + p.valence.toFixed(2) + ' · 对白 ' + Math.round(p.dialogue * 100) +
        '% · 平均句长 ' + p.avgSent + ' 字</div></div></div>').join('') + '</div>' +
      '<div class="t-hint" style="margin-top:var(--sp-3)">最后一章（' +
      esc((last.title || last.path).split('/').pop()) + '）张力 ' + last.arousal.toFixed(2) + '。</div>';
  }

  async function statsCalendar(pane, slug) {
    loading(pane, '翻日历…');
    let d;
    try { d = await get('/api/stats/calendar', { slug, days: 182 }); }
    catch (e) { empty(pane, '读不到：' + e.message); return; }
    const days = d.days || [];
    if (!days.length) { empty(pane, '还没有写作记录', 'clock'); return; }
    const map = {};
    days.forEach((x) => { map[x.date] = x.words || 0; });
    const today = new Date();
    const start = new Date(days[0].date + 'T00:00:00');
    start.setDate(start.getDate() - start.getDay());          // 从那一周的周日排起
    const cells = [];
    const cur = new Date(start);
    while (cur <= today) { cells.push(fmtDate(cur)); cur.setDate(cur.getDate() + 1); }
    const max = Math.max(1, ...Object.values(map));
    const lvl = (w) => (w <= 0 ? 0 : Math.min(4, Math.ceil(w / max * 4)));
    let html = '';
    for (let i = 0; i < cells.length; i += 7) {
      html += '<div class="st-heat-col">' + cells.slice(i, i + 7).map((k) => {
        const w = map[k] || 0;
        const f = new Date(k + 'T00:00:00') > today;
        return '<i class="lv' + lvl(w) + '"' + (f ? ' style="visibility:hidden"' : '') +
          ' title="' + esc(k + '　' + w + ' 字') + '"></i>';
      }).join('') + '</div>';
    }
    const last30 = days.slice(-30).reduce((a, x) => a + (x.words || 0), 0);
    pane.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + Object.keys(map).length + '</b><span>写过的天数</span></div>' +
      '<div class="t-stat"><b>' + last30 + '</b><span>近 30 天字数</span></div>' +
      '<div class="t-stat"><b>' + max + '</b><span>单日最多</span></div></div>' +
      '<div class="st-heat">' + html + '</div>' +
      '<div class="t-hint">一列是一周（周日在上），颜色越深写得多。翻到最近的在最右边。</div>';
  }

  async function statsAchievements(pane, slug) {
    loading(pane, '数成就…');
    let d;
    try { d = await get('/api/stats/achievements', { slug }); }
    catch (e) { empty(pane, '读不到：' + e.message); return; }
    const items = d.items || [];
    pane.innerHTML =
      '<div class="t-form"><div class="t-field"><label>已解锁 ' + (d.done || 0) + ' / ' +
      (d.total || 0) + '（' + (d.percent || 0) + '%）</label>' +
      '<div class="st-bar"><i style="width:' + (d.percent || 0) + '%"></i></div></div></div>' +
      '<div class="t-list">' + items.map((a) => {
        const pct = Math.min(100, Math.round((a.progress || 0) / (a.at || 1) * 100));
        return '<div class="t-row static">' + ico(a.done ? 'check' : 'clock') +
          '<div class="tr-main"><div class="tr-title">' + esc(a.title) + '</div>' +
          '<div class="tr-sub">' + esc(a.hint || '') +
          (a.done ? '' : '　现在 ' + (a.progress || 0) + ' / ' + a.at) + '</div>' +
          (a.done ? '' : '<div class="st-bar" style="margin-top:var(--sp-2)"><i style="width:' +
            pct + '%"></i></div>') +
          '</div><span class="t-pill ' + (a.done ? 'ok' : 'gray') + '">' +
          (a.done ? '已得' : pct + '%') + '</span></div>';
      }).join('') + '</div>';
  }

  async function statsCost(pane, slug) {
    loading(pane, '算账…');
    let d;
    try { d = await get('/api/stats/cost', { slug, days: 30 }); }
    catch (e) { empty(pane, '读不到：' + e.message); return; }
    const items = d.items || [];
    if (!items.length) { empty(pane, '最近 30 天还没让 AI 干过活', 'cpu'); return; }
    const tin = items.reduce((a, x) => a + (x.input || 0), 0);
    const tout = items.reduce((a, x) => a + (x.output || 0), 0);
    const calls = items.reduce((a, x) => a + (x.calls || 0), 0);
    pane.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + calls + '</b><span>调用次数</span></div>' +
      '<div class="t-stat"><b>' + tin + '</b><span>输入 token</span></div>' +
      '<div class="t-stat"><b>' + tout + '</b><span>输出 token</span></div></div>' +
      '<div class="t-form"><div class="t-field"><label>折合 ' + esc(d.currency || '元') + '：' +
      money(d.totalCost) + '</label>' +
      '<div class="t-hint" style="margin:0">按「工具 → 模型」里填的单价算；没填单价的只统计 token。</div>' +
      '</div></div>' +
      '<h2 class="st-h">按模型</h2><div class="t-list">' + items.map((x) =>
        '<div class="t-row static">' + ico('cpu') +
        '<div class="tr-main"><div class="tr-title">' + esc(x.model) + '</div>' +
        '<div class="tr-sub">' + esc(x.calls + ' 次 · 入 ' + x.input + ' / 出 ' + x.output +
          (x.cacheRead ? ' · 缓存读 ' + x.cacheRead : '') +
          (x.ms ? ' · 共 ' + Math.round(x.ms / 1000) + ' 秒' : '')) + '</div></div>' +
        '<span class="t-pill ' + (x.priced ? '' : 'gray') + '">' +
        (x.priced ? money(x.cost) + ' 元' : '没填单价') + '</span></div>').join('') + '</div>';
  }

  async function statsReport(pane, slug) {
    pane.innerHTML =
      '<div class="t-seg wide" data-kind>' +
      '<button class="on" data-v="day">今天</button>' +
      '<button data-v="week">这一周</button><button data-v="month">这个月</button></div>' +
      '<div class="t-bar" style="margin-top:var(--sp-3)"><button class="t-btn pri" data-go>生成一份</button></div>' +
      '<div data-out><div class="t-hint">数字都从真实写作记录里算，不编。</div></div>';
    pane.querySelector('[data-kind]').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      hap();
      pane.querySelectorAll('[data-kind] button').forEach((x) => x.classList.toggle('on', x === b));
    });
    pane.querySelector('[data-go]').onclick = async () => {
      const on = pane.querySelector('[data-kind] button.on');
      const kind = on ? on.dataset.v : 'week';
      const out = pane.querySelector('[data-out]');
      loading(out, '写报告…');
      try {
        const d = await get('/api/stats/report', { slug, kind });
        out.innerHTML = '<div class="t-pre selectable">' + esc(d.text || '') + '</div>' +
          '<div class="t-bar"><button class="t-btn" data-copy>复制这段</button></div>';
        out.querySelector('[data-copy]').onclick = () => {
          try {
            navigator.clipboard.writeText(d.text || '').then(() => toast('复制好了'), () => toast('这台机器不给复制'));
          } catch (e) { toast('这台机器不给复制'); }
        };
      } catch (e) { out.innerHTML = '<div class="t-empty">生成不了：' + esc(e.message) + '</div>'; }
    };
    pane.querySelector('[data-go]').click();
  }

  /* ══════════════════════════════════════════════════════════
     6. 导出 / 导入
     ══════════════════════════════════════════════════════════ */
  function openExport(host) { Push.book('导出导入', exportHome); }

  function exportHome(host, slug) {
    tabShell(host, [['out', '导出'], ['in', '导入']], {
      out: (pane) => exportOut(pane, slug),
      in: (pane) => importIn(pane, slug),
    });
  }

  async function exportOut(pane, slug) {
    loading(pane, '读目录…');
    let d;
    try { d = await get('/api/book', { slug }); } catch (e) { empty(pane, '读不到：' + e.message); return; }
    const chs = d.chapters || [];
    if (!chs.length) { empty(pane, '这本书还没有章节', 'file'); return; }
    const picked = new Set(chs.map((c) => c.path));
    const sel = () => chs.filter((c) => picked.has(c.path)).map((c) => c.path).join(',');

    const doExport = (f) => {
      const use = sel();
      if (!use) { toast('先选几章'); return; }
      hap();
      const q = qs({ slug, chapters: use });
      if (f === 'txt') return download('api/export/text?' + q);
      if (f === 'md') return download('api/export/markdown?' + q);
      if (f === 'epub') return download('api/export/epub?' + q);
      if (f === 'pdf') return download('api/export/pdf?' + q);
      if (f === 'print') { window.open('api/export/print?' + q, '_blank'); return; }
      if (f === 'bundle') { download('api/export/bundle?' + qs({ slug })); return; }
    };

    const paint = () => {
      const n = picked.size;
      pane.innerHTML =
        '<div class="t-hint" style="margin:0 0 var(--sp-3)">要导哪些章：点一下切换。导出只读正文，不改任何东西。' +
        '选中 ' + n + ' / ' + chs.length + ' 章。</div>' +
        '<div class="t-list" style="max-height:270px;overflow-y:auto">' + chs.map((c, i) =>
          '<div class="t-row" data-i="' + i + '">' + ico('file') +
          '<div class="tr-main"><div class="tr-title">' + esc(c.name || c.path) + '</div>' +
          '<div class="tr-sub">' + esc((c.words || 0) + ' 字') + '</div></div>' +
          '<span class="t-pill ' + (picked.has(c.path) ? 'ok' : 'gray') + '">' +
          (picked.has(c.path) ? '选中' : '不选') + '</span></div>').join('') + '</div>' +
        '<div class="t-bar"><button class="t-btn sm" data-all>全选</button>' +
        '<button class="t-btn sm" data-none>全不选</button></div>' +
        '<div class="t-form"><div class="t-field"><label>怎么带走</label>' +
        '<div class="t-hint" style="margin:0">TXT 最通用；Markdown 一章一个文件打成压缩包；' +
        'EPUB / PDF 给阅读器和打印；「整包」连设定、伏笔、时间线一起打包。</div></div></div>' +
        '<div class="t-bar"><button class="t-btn pri" data-f="txt">TXT</button>' +
        '<button class="t-btn" data-f="md">Markdown</button>' +
        '<button class="t-btn" data-f="epub">EPUB</button></div>' +
        '<div class="t-bar"><button class="t-btn" data-f="pdf">PDF</button>' +
        '<button class="t-btn" data-f="print">打印视图</button>' +
        '<button class="t-btn" data-f="bundle">整包带走</button></div>';
      pane.querySelectorAll('[data-i]').forEach((r) => {
        r.onclick = () => {
          const p = chs[Number(r.dataset.i)].path;
          if (picked.has(p)) picked.delete(p); else picked.add(p);
          hap(); paint();
        };
      });
      pane.querySelector('[data-all]').onclick = () => { chs.forEach((c) => picked.add(c.path)); hap(); paint(); };
      pane.querySelector('[data-none]').onclick = () => { picked.clear(); hap(); paint(); };
      pane.querySelectorAll('[data-f]').forEach((b) => { b.onclick = () => doExport(b.dataset.f); });
    };
    paint();
  }

  function importIn(pane, slug) {
    pane.innerHTML =
      '<div class="t-form">' +
      '<div class="t-field"><label>从文件导入</label>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-2)">支持 .md / .txt，也可以把一堆 md 打成一个 zip 一起传。' +
      '一章一个文件最省事，文件名就是章节名。</div>' +
      '<input type="file" data-md multiple accept=".md,.txt,.zip" class="t-input" style="padding:var(--sp-2)"></div>' +
      '<div class="t-field"><label>导入角色卡</label>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-2)">SillyTavern 导出的角色卡（PNG 或 JSON），' +
      '导进来会变成世界引擎里的一个角色。</div>' +
      '<input type="file" data-card accept=".png,.json,image/png,application/json" class="t-input" style="padding:var(--sp-2)"></div>' +
      '<div class="t-field"><label>整包还原</label>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-2)">把「整包带走」出来的 zip 放回来：正文、设定、' +
      '伏笔、时间线一起回来。**会另起一本书**，绝不覆盖你现在这本。</div>' +
      '<input type="file" data-bundle accept=".zip,application/zip" class="t-input" style="padding:var(--sp-2)"></div>' +
      '</div>' +
      '<div class="t-bar"><button class="t-btn pri" data-paste>粘贴一段正文进来</button></div>' +
      '<div data-out></div>';

    const out = pane.querySelector('[data-out]');
    pane.querySelector('[data-md]').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      loading(out, '导入中，' + files.length + ' 个文件…');
      const fd = new FormData();
      fd.append('slug', slug);
      fd.append('prefix', 'manuscript');
      files.forEach((f) => fd.append('files', f, f.name));
      try {
        const d = await upload('api/import/markdown', fd);
        out.innerHTML = '<div class="t-form"><div class="t-field"><label>导进来了 ' +
          (d.imported || d.count || 0) + ' 章</label><div class="t-hint" style="margin:0">' +
          esc(d.note || '去「文件」或写作台里能看到。') + '</div></div></div>';
        toast('导进来了'); hap();
      } catch (err) { out.innerHTML = '<div class="t-empty">导入失败：' + esc(err.message) + '</div>'; }
      e.target.value = '';
    });

    pane.querySelector('[data-card]').addEventListener('change', async (e) => {
      const f = (e.target.files || [])[0];
      if (!f) return;
      loading(out, '读角色卡…');
      const fd = new FormData();
      fd.append('slug', slug);
      fd.append('file', f, f.name);
      try {
        const d = await upload('api/import/character-card', fd);
        out.innerHTML = '<div class="t-form"><div class="t-field"><label>收进来了：' +
          esc(d.name || '（没名字）') + '</label><div class="t-hint" style="margin:0">' +
          '去「工具 → 世界」能看到它的资料。</div></div></div>';
        toast('角色卡收好了'); hap();
      } catch (err) { out.innerHTML = '<div class="t-empty">读不了：' + esc(err.message) + '</div>'; }
      e.target.value = '';
    });

    pane.querySelector('[data-bundle]').addEventListener('change', async (e) => {
      const f = (e.target.files || [])[0];
      if (!f) return;
      loading(out, '还原整包…');
      const fd = new FormData();
      fd.append('file', f, f.name);
      try {
        const d = await upload('api/import/bundle', fd);
        const tables = Object.keys(d.restored || {});
        out.innerHTML = '<div class="t-form"><div class="t-field"><label>还原成《' +
          esc(d.title || '') + '》</label><div class="t-hint" style="margin:0">' +
          '正文 ' + (d.chapters || 0) + ' 章、文件 ' + (d.files || 0) + ' 个' +
          (tables.length ? ('，另外补回了：' + esc(tables.join('、'))) : '') +
          '。去书架上看这本新书，原来那本一个字没动。</div></div></div>';
        toast('整包还原好了'); hap();
      } catch (err) { out.innerHTML = '<div class="t-empty">还原失败：' + esc(err.message) + '</div>'; }
      e.target.value = '';
    });

    pane.querySelector('[data-paste]').onclick = async () => {
      const name = await ask('这一章叫什么', '', { placeholder: '例：第007章-旧账' });
      if (!name) return;
      const text = await ask('把正文贴进来', '', { placeholder: '粘贴正文…', multiline: true, ok: '导入' });
      if (text == null) return;
      if (!text.trim()) { toast('里面是空的'); return; }
      try {
        const d = await post('/api/import/text', { slug, name, text });
        toast('收进来了，' + (d.words || 0) + ' 字'); hap();
        out.innerHTML = '<div class="t-hint">已经放进 ' + esc(d.path || name) + '。</div>';
      } catch (err) { toast('导不进来：' + err.message); }
    };
  }

  /* ══════════════════════════════════════════════════════════
     7. 听书升级：音色 / 引擎 / 语速 / 从哪一章开始听
     （真正播放还是阅读器那一套，这里只负责挑和试，不另开一个播放器）
     ══════════════════════════════════════════════════════════ */
  function openListen(host) { Push.book('听书', listenHome); }

  /* 试听用的那一个 <audio>：现在收在 VoiceTry 里（全 App 只有这一个，
     切音色/离开面板都会把它停掉）。这里只留一个转调，别在写作台里再养第二只。
     第 22 轮抽出 VoiceTry 的原因：设置页的音色也要能试听，照抄一份就是"两套实现"。 */
  function stopTry() { if (window.VoiceTry) VoiceTry.stop(); }

  /* 语速：**界面上给出倍数**（0.8x/1.0x/1.2x/1.5x），值还是后端认的 `-20%/+0%/+25%/+50%`。
     原来只写「慢 / 正常 / 快 / 更快」，用户不知道"更快"到底快多少。 */
  const RATES = [['-20%', '0.8x', '慢一点'], ['+0%', '1.0x', '正常'],
                 ['+25%', '1.2x', '快一点'], ['+50%', '1.5x', '快很多']];

  async function listenHome(host, slug) {
    loading(host, '看音色…');
    let d, cache = null;
    try { d = await get('/api/tts/voices'); } catch (e) { empty(host, '读不到：' + e.message); return; }
    try { cache = await get('/api/tts/cache'); } catch (e) {}
    const voices = d.voices || [];
    const engines = d.engines || [];
    const curVoice = Prefs.get('voice');
    const curEng = Prefs.get('ttsEngine') || d.engine || 'edge';
    const curRate = Prefs.get('rate');
    const follow = Prefs.get('ttsFollow') !== false;
    /* 同一个东西只有一种叫法：引擎名一律取后端 label 里括号前的那一段（edge-tts / CosyVoice），
       音色行下面的小字也用这个名字，不再出现「edge 引擎」这种另一个写法。 */
    const engName = {};
    engines.forEach((e) => { engName[e.key] = String(e.label || e.key).split('（')[0].trim(); });
    const engOf = (k) => engName[k] || k || 'edge-tts';
    const badEngs = engines.filter((e) => !e.available);

    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">选好音色、引擎和语速，点下面「开始听」就进阅读器朗读。' +
      '按句分段合成，第一段一两秒就响，不用等整章。点音色左边的喇叭可以先听一耳朵。</div>' +
      '<div class="t-form">' +
      '<div class="t-field"><label>引擎</label><div class="t-seg wide" data-engine>' +
      (engines.length ? engines.map((e) => {
        const nm = String(e.label || e.key).split('（')[0].trim();
        return '<button data-v="' + esc(e.key) + '" class="' + (e.key === curEng ? 'on' : '') + '"' +
          (e.available ? '' : ' disabled data-na="1" aria-disabled="true"') + '>' + esc(nm) + '</button>';
      }).join('') : '<button data-v="' + esc(curEng) + '" class="on">' + esc(engOf(curEng)) + '</button>') +
      '</div>' + (badEngs.length ? '<div class="t-hint">' + badEngs.map((e) =>
        esc(engName[e.key] || e.key) + ' 现在用不了：' + esc(e.reason || '没配好') +
        '（选的是它时才会用到，平时不影响听书）').join('；') + '</div>' : '') +
      '</div>' +
      '<div class="t-field"><label>语速</label><div class="t-seg wide" data-rate>' +
      RATES.map(([v, x, w]) =>
        '<button data-v="' + v + '" class="' + (v === curRate ? 'on' : '') + '" title="' + esc(w) + '">' +
        x + '</button>').join('') +
      '</div><div class="t-hint">' + RATES.map(([, x, w]) => x + ' ' + w).join(' ／ ') + '</div></div>' +
      '<div class="t-field"><label>页面跟着朗读走</label><div class="t-seg wide" data-follow>' +
      '<button data-v="1" class="' + (follow ? 'on' : '') + '">开</button>' +
      '<button data-v="0" class="' + (follow ? '' : 'on') + '">关</button>' +
      '</div><div class="t-hint">开：读到哪翻到哪。关：屏幕不动，只出声。</div></div>' +
      '</div>' +
      '<h2 class="st-h">音色 · ' + voices.length + ' 个</h2>' +
      '<div class="t-list">' + (voices.length ? voices.map((v, i) =>
        '<div class="t-row' + (v.id === curVoice ? ' on' : '') + '" data-vi="' + i + '">' +
        '<button class="tr-act" data-try="' + i + '" aria-label="试听">' + window.iconHtml('sound') + '</button>' +
        '<div class="tr-main"><div class="tr-title">' + esc(v.name || v.id) + '</div>' +
        '<div class="tr-sub">' + esc([engOf(v.engine), v.id].filter(Boolean).join(' · ')) +
        '</div></div>' +
        '<span class="t-pill ' + (v.id === curVoice ? 'ok' : 'gray') + '">' +
        (v.id === curVoice ? '正在用' : '用这个') + '</span></div>').join('')
        : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">服务器上还没配音色</div></div></div>') +
      '</div>' +
      (cache ? '<div class="t-hint">已经缓存了 ' + (cache.files || 0) + ' 段音频，占 ' +
        esc(U().bytes(cache.bytes)) + '。听过的段下次不用再合成。</div>' : '') +
      /* 主操作吸底：以前它在滚动内容的最后一行，被底部导航挡掉，用户根本看不见「开始听」。 */
      '<div class="t-foot">' +
      '<button class="t-btn pri" data-start>开始听（从这本书开头）</button>' +
      '<button class="t-btn" data-pick>挑一章</button>' +
      '</div>';
    host.classList.add('has-foot');

    const seg = (sel, apply) => {
      host.querySelector(sel).addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        if (b.disabled || b.dataset.na) { toast('这个引擎现在用不了'); return; }
        host.querySelectorAll(sel + ' button').forEach((x) => x.classList.toggle('on', x === b));
        apply(b.dataset.v); hap();
      });
    };
    seg('[data-engine]', (v) => { stopTry(); Prefs.set('ttsEngine', v); });
    seg('[data-rate]', (v) => { stopTry(); Prefs.set('rate', v); });
    seg('[data-follow]', (v) => Prefs.set('ttsFollow', v === '1'));

    /* 点喇叭 = 试听这一把声音；点整行 = 用它。
       两个动作分开，试听不会顺手把当前音色换掉（那正是"点错了"的来源）。 */
    const tryBtn = (r, i) => {
      const v = voices[i];
      const b = r.querySelector('[data-try]');
      VoiceTry.play({
        voice: v.id,
        engine: Prefs.get('ttsEngine') || curEng,
        rate: Prefs.get('rate') || '+0%',
        el: b,
        busyHTML: '<i class="tr-spin"></i>',
        idleHTML: window.iconHtml('sound'),
        onDone: (msg) => { if (msg) toast(msg); },
      });
      hap();
    };
    host.querySelectorAll('[data-vi]').forEach((r) => {
      const i = Number(r.dataset.vi);
      r.querySelector('[data-try]').onclick = (e) => { e.stopPropagation(); tryBtn(r, i); };
      r.onclick = () => {
        const v = voices[i];
        stopTry();
        Prefs.set('voice', v.id);
        hap();
        host.querySelectorAll('[data-vi]').forEach((x) => {
          const on = x === r;
          x.classList.toggle('on', on);
          const pill = x.querySelector('.t-pill');
          pill.className = 't-pill ' + (on ? 'ok' : 'gray');
          pill.textContent = on ? '正在用' : '用这个';
        });
        toast('换成 ' + (v.name || v.id));
      };
    });
    host.querySelector('[data-start]').onclick = () => { hap(); startListen(slug, ''); };
    host.querySelector('[data-pick]').onclick = () => {
      hap();
      push('挑一章开始听', (h2) => chapterPicker(h2, slug, (ch) => {
        startListen(slug, ch.path);
      }, { hint: '从哪一章开始念' }));
    };
  }

  /* 进阅读器开始朗读 —— 播放只有 reader.js 那一套，这里不重写 */
  async function startListen(slug, path) {
    if (!(window.Shelf && Shelf.openBook)) { toast('阅读器还没准备好'); return; }
    try {
      await Shelf.openBook(slug, path ? { slug, path } : { slug });
    } catch (e) { toast('打不开：' + e.message); return; }
    setTimeout(() => {
      try { if (window.Reader && Reader.toggleTts) Reader.toggleTts(); }
      catch (e) { toast('开始不了朗读：' + e.message); }
    }, 460);
  }

  /* ══════════════════════════════════════════════════════════
     8. 术语与一致：术语表 / 一致性扫描 / 全书替换
     ══════════════════════════════════════════════════════════ */
  function openTerm(host) { Push.book('术语', termHome); }

  async function termHome(host, slug) {
    let items = [];
    host.innerHTML =
      '<div class="t-bar"><button class="t-btn pri" data-add>加一条术语</button>' +
      '<button class="t-btn" data-check>一致性检查</button></div>' +
      '<div class="t-bar"><button class="t-btn" data-replace>全书替换…</button></div>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">术语表管人名、地名、门派这些专有名词。' +
      '「一致性检查」会挑出同一个东西的别的叫法和疑似写错的字。</div>' +
      '<input class="t-input" data-q placeholder="搜术语 / 别名" style="margin-bottom:var(--sp-3)">' +
      '<div data-list></div><div data-results></div>';

    const q = host.querySelector('[data-q]');
    const listBox = host.querySelector('[data-list]');
    const out = host.querySelector('[data-results]');

    const paint = () => {
      const n = q.value.trim().toLowerCase();
      const list = n ? items.filter((t) => t.name.toLowerCase().indexOf(n) >= 0
        || (t.aliases || []).some((a) => a.toLowerCase().indexOf(n) >= 0)) : items;
      listBox.innerHTML = list.length
        ? '<div class="t-list">' + list.map((t, i) =>
          '<div class="t-row" data-i="' + i + '">' + ico('text') +
          '<div class="tr-main"><div class="tr-title">' + esc(t.name) + '</div>' +
          '<div class="tr-sub">' + esc([(t.aliases || []).join('、'), t.kind || '',
            t.note || ''].filter(Boolean).join(' · ') || '（没别名）') + '</div></div>' +
          '<button class="t-btn sm dim" data-rm="' + t.id + '">删</button></div>').join('') + '</div>'
        : '<div class="t-empty">' + (items.length ? '没搜到' : '还没有术语，先加一条') + '</div>';
      listBox.querySelectorAll('[data-i]').forEach((r) => {
        r.onclick = (e) => { if (e.target.closest('[data-rm]')) return; termEdit(list[Number(r.dataset.i)]); };
      });
      listBox.querySelectorAll('[data-rm]').forEach((b) => {
        b.onclick = async (e) => {
          e.stopPropagation();
          const t = items.find((x) => String(x.id) === String(b.dataset.rm));
          if (!(await confirmBox('删掉「' + ((t && t.name) || '这条') + '」？'))) return;
          try { await del('/api/term', { slug, id: b.dataset.rm }); toast('删了'); hap(); await reload(); }
          catch (err) { toast('删不掉：' + err.message); }
        };
      });
    };

    const reload = async () => {
      const d = await get('/api/term', { slug });
      items = d.items || [];
      paint();
    };

    const termEdit = async (t) => {
      const name = await ask('术语（正确的写法）', t ? t.name : '', { placeholder: '例：主角' });
      if (!name) return;
      const alias = await ask('别名（顿号或逗号分开，可空）',
        t ? (t.aliases || []).join('、') : '', { placeholder: '例：小诺、诺哥' });
      if (alias == null) return;
      const kind = await ask('它是什么（可空）', t ? (t.kind || '') : '', { placeholder: '人 / 地 / 门派 / 物品…' });
      const aliases = alias.split(/[、,，;；\/]+/).map((x) => x.trim()).filter(Boolean);
      try {
        await post('/api/term', { slug, id: t ? t.id : undefined, name, aliases, kind: kind || '' });
        toast('存好了'); hap(); out.innerHTML = ''; await reload();
      } catch (e) { toast('存不了：' + e.message); }
    };

    q.addEventListener('input', paint);
    host.querySelector('[data-add]').onclick = () => termEdit(null);
    host.querySelector('[data-check]').onclick = () => termCheck(out, slug);
    host.querySelector('[data-replace]').onclick = async () => {
      const find = await ask('要替换什么', '', { placeholder: '要改掉的写法' });
      if (!find) return;
      const to = await ask('换成什么', '', { placeholder: '正确的写法' });
      if (to == null) return;
      replaceFlow(out, slug, find, to);
    };

    try { await reload(); }
    catch (e) { empty(host, '读不到术语表：' + e.message); }
  }

  async function termCheck(out, slug) {
    loading(out, '对一遍全稿…');
    let d;
    try { d = await post('/api/term/check', { slug }); }
    catch (e) { out.innerHTML = '<div class="t-empty">查不了：' + esc(e.message) + '</div>'; return; }
    const items = d.items || [];
    if (!items.length) { out.innerHTML = '<div class="t-hint">全稿一致，没挑出问题。</div>'; return; }
    out.innerHTML = '<h2 class="st-h">挑出 ' + items.length + ' 处</h2><div class="t-list">' +
      items.map((it, i) => '<div class="t-row static">' + ico('link') +
        '<div class="tr-main"><div class="tr-title">' + esc(it.name || '') + '　' +
        '<span style="color:var(--danger)">' + esc(it.variant || '') + '</span></div>' +
        '<div class="tr-sub wrap">' + esc(it.hint || '') + '</div></div>' +
        '<button class="t-btn sm" data-i="' + i + '">改过来</button></div>').join('') + '</div>';
    out.querySelectorAll('[data-i]').forEach((b) => {
      b.onclick = () => {
        const it = items[Number(b.dataset.i)];
        if (!it.variant) return;
        replaceFlow(out, slug, it.variant, it.term, '只看这一章：' + (it.name || ''));
      };
    });
  }

  async function replaceFlow(slot, slug, find, to, extra) {
    loading(slot, '先看看会改到哪儿…');
    let d;
    try { d = await post('/api/replace', { slug, find, replace: to }); }
    catch (e) { slot.innerHTML = '<div class="t-empty">查不了：' + esc(e.message) + '</div>'; return; }
    if (!d.total) {
      slot.innerHTML = '<div class="t-hint">全稿里没有「' + esc(find) + '」。</div>';
      return;
    }
    slot.innerHTML = '<h2 class="st-h">会改 ' + d.total + ' 处，分布在 ' + d.files.length + ' 章</h2>' +
      (extra ? '<div class="t-hint" style="margin:0 0 var(--sp-2)">' + esc(extra) + '</div>' : '') +
      '<div class="t-list">' + d.files.slice(0, 20).map((f) =>
        '<div class="t-row static">' + ico('file') +
        '<div class="tr-main"><div class="tr-title">' + esc(f.name) + ' · ' + f.count + ' 处</div>' +
        '<div class="tr-sub wrap">' + esc(f.preview || '') + '</div></div></div>').join('') + '</div>' +
      (d.files.length > 20 ? '<div class="t-hint">还有 ' + (d.files.length - 20) + ' 章没列出来。</div>' : '') +
      '<div class="t-bar"><button class="t-btn pri" data-yes>确认替换</button>' +
      '<button class="t-btn" data-no>算了</button></div>';
    slot.querySelector('[data-yes]').onclick = async () => {
      try {
        const r = await post('/api/replace', { slug, find, replace: to, apply: true });
        toast('换了 ' + r.replaced + ' 处'); hap();
        slot.innerHTML = '<div class="t-hint">改完了，改的是原始正文文件（可在「改动」里看到记录）。</div>';
      } catch (e) { toast('换不了：' + e.message); }
    };
    slot.querySelector('[data-no]').onclick = () => { slot.innerHTML = ''; };
  }

  /* ══════════════════════════════════════════════════════════
     9. 素材库：灵感碎片、资料、图片链接
     ══════════════════════════════════════════════════════════ */
  const MATERIAL_KINDS = [['note', '记录'], ['idea', '灵感'], ['doc', '资料'],
                          ['image', '图片'], ['link', '链接']];
  const KIND_OF = {}; MATERIAL_KINDS.forEach(([k, l]) => { KIND_OF[k] = l; });

  function openMaterial(host) { Push.book('素材', materialHome); }

  /* 素材列表：**只拿摘要**（?preview=1），正文点进去再看。
     踩过的坑：以前列表接口把每条素材的正文整段吐出来、列表也整段铺进 DOM ——
     真实那本书 11 条素材 = 16.8 万字全在列表里，跑 e2e 时量出来"一个面板 16.7 万字"，
     手机上滚动发涩、想找一条素材得往下划半天。现在列表 1.7 千字、正文点开才取。 */
  async function materialHome(host, slug) {
    let items = [], kind = '';
    /* 多选：sel=null 表示平时状态；是 Set 时进入"多选"，点一行是勾选而不是打开。
       素材一多（真实那本书 11 条，还会长），一条条点进去删太费劲。 */
    let sel = null;
    const visible = () => (kind ? items.filter((x) => x.kind === kind) : items);
    const rowHtml = (m, i) => {
      const tags = (m.tags || []).slice(0, 5);
      const more = Math.max(0, (m.tags || []).length - tags.length);
      const on = sel && sel.has(m.id);
      return '<div class="t-row m-row' + (on ? ' on' : '') + '" data-open="' + i + '">' +
        (sel
          ? '<span class="m-check' + (on ? ' on' : '') + '">' +
            (on ? window.iconHtml('check') : '') + '</span>'
          : ico('bookmark')) +
        '<div class="tr-main">' +
          '<div class="tr-title">' + esc(m.title) + '</div>' +
          /* 这一行固定是「分类 · 多久以前 · 多少字」，永远完整。
             以前它跟标签挤在同一行里被截掉，于是有的条目有"13 小时前 · 20765 字"、
             有的没有 —— 其实都有，只是被截了。 */
          '<div class="m-meta">' + esc([KIND_OF[m.kind] || m.kind, ago(m.updated_at),
            (m.bodyLen ? Number(m.bodyLen).toLocaleString('en-US') + ' 字' : '')]
            .filter(Boolean).join(' · ')) + '</div>' +
          (tags.length ? '<div class="m-tags">' + tags.map((t) =>
            '<i>' + esc(t) + '</i>').join('') +
            (more ? '<i class="more">+' + more + '</i>' : '') + '</div>' : '') +
          ((m.body || '').trim() ? '<div class="m-prev">' + esc(m.body) +
            (m.truncated ? '…' : '') + '</div>' : '') +
        '</div>' +
        (sel ? '' : '<span class="tr-go">' + window.iconHtml('chevron') + '</span>') +
        '</div>';
    };
    const paint = () => {
      const list = visible();
      const picked = sel ? sel.size : 0;
      host.innerHTML =
        (sel
          ? '<div class="t-bar"><button class="t-btn" data-all>' +
            (picked >= list.length && list.length ? '全不选' : '全选') + '</button>' +
            '<button class="t-btn dan" data-del-sel' + (picked ? '' : ' disabled') + '>删除选中' +
            (picked ? '（' + picked + '）' : '') + '</button>' +
            '<button class="t-btn pri" data-done>完成</button></div>'
          : '<div class="t-bar"><button class="t-btn" data-sel>多选</button>' +
            '<button class="t-btn pri" data-add>加一条素材</button></div>') +
        '<div class="t-seg wide" data-kind>' +
        [['', '全部']].concat(MATERIAL_KINDS).map(([k, l]) =>
          '<button data-v="' + k + '" class="' + (k === kind ? 'on' : '') + '">' + l + '</button>').join('') +
        '</div>' +
        '<div class="t-hint" style="margin:var(--sp-3) 0 var(--sp-3)">' +
        (sel ? '点条目勾选，勾完按「删除选中」。'
             : '灵感、查到的资料、图床链接都可以先扔这儿，写的时候回来翻。点一条看全文。') + '</div>' +
        (list.length ? '<div class="t-list">' + list.map(rowHtml).join('') + '</div>'
          : '<div class="t-empty">' + (items.length ? '这一类还没有' : '素材库是空的') + '</div>');

      const addBtn = host.querySelector('[data-add]');
      if (addBtn) addBtn.onclick = async () => {
        const title = await ask('这条素材叫什么', '', { placeholder: '一句话标题' });
        if (!title) return;
        const kindPick = await ask('它是哪一类（' + MATERIAL_KINDS.map(([k, l]) => k + '=' + l).join('，') + '）',
          'note', { placeholder: 'note' });
        if (kindPick == null) return;
        const body = await ask('内容（可空）', '', { placeholder: '原文、链接、备注…', multiline: true });
        const tags = await ask('标签（逗号分开，可空）', '', { placeholder: '法器,伏笔' });
        try {
          await post('/api/material', { slug, title, kind: (kindPick || 'note').trim(),
            body: body || '', tags: (tags || '').split(/[,，\s]+/).filter(Boolean) });
          toast('收好了'); hap(); await reload();
        } catch (e) { toast('存不了：' + e.message); }
      };
      const selBtn = host.querySelector('[data-sel]');
      if (selBtn) selBtn.onclick = () => { sel = new Set(); hap(); paint(); };
      const doneBtn = host.querySelector('[data-done]');
      if (doneBtn) doneBtn.onclick = () => { sel = null; hap(); paint(); };
      const allBtn = host.querySelector('[data-all]');
      if (allBtn) allBtn.onclick = () => {
        if (sel.size >= list.length && list.length) sel.clear();
        else list.forEach((m) => sel.add(m.id));
        hap(); paint();
      };
      const delSel = host.querySelector('[data-del-sel]');
      if (delSel) delSel.onclick = async () => {
        if (!sel.size) return;
        if (!(await confirmBox('删掉选中的 ' + sel.size + ' 条素材？删了就找不回来了。', true))) return;
        try {
          const r = await del('/api/material', { slug, ids: Array.from(sel).join(',') });
          toast('删了 ' + ((r && r.count) || sel.size) + ' 条'); hap();
          sel = null;
          await reload();
        } catch (e) { toast('删不掉：' + e.message); }
      };
      host.querySelector('[data-kind]').addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        kind = b.dataset.v; hap(); paint();
      });
      host.querySelectorAll('[data-open]').forEach((row) => {
        row.onclick = () => {
          const m = list[Number(row.dataset.open)];
          hap();
          if (sel) {
            if (sel.has(m.id)) sel.delete(m.id); else sel.add(m.id);
            paint();
            return;
          }
          push('素材 · ' + m.title, (h) => materialOne(h, slug, m.id));
        };
      });
    };
    const reload = async () => {
      const d = await get('/api/material', { slug, preview: 1 });
      items = d.items || [];
      if (sel) {                    // 删完/刷新后，勾选里只留还存在的
        const alive = new Set(items.map((m) => m.id));
        Array.from(sel).forEach((id) => { if (!alive.has(id)) sel.delete(id); });
      }
      paint();
    };
    try { await reload(); } catch (e) { empty(host, '读不到素材库：' + e.message); }
  }

  /* 单条素材：全文 + 改标题/标签 + 改正文（要改才拉，平时不占内存）+ 删（二次确认） */
  async function materialOne(host, slug, id) {
    loading(host, '取素材…');
    let it = null;
    try { it = (await get('/api/material/item', { slug, id })).item; }
    catch (e) { empty(host, '取不到这条素材：' + e.message); return; }
    const paint = () => {
      host.innerHTML =
        '<div class="t-hint" style="margin:0 0 var(--sp-2)">' +
          esc([KIND_OF[it.kind] || it.kind, (it.tags || []).join('、'), ago(it.updated_at),
               (it.body || '').length + ' 字'].filter(Boolean).join(' · ')) + '</div>' +
        '<div class="t-bar"><button class="t-btn" data-edit>改标题 / 标签</button>' +
        '<button class="t-btn" data-body>改正文</button>' +
        '<button class="t-btn dan" data-del>删</button></div>' +
        ((it.body || '').trim()
          ? '<div class="t-pre" style="margin-top:var(--sp-3)">' + esc(it.body) + '</div>'
          : '<div class="t-empty">这条只有标题，没有正文</div>');
      host.querySelector('[data-edit]').onclick = async () => {
        const title = await ask('改标题', it.title);
        if (!title) return;
        const kindPick = await ask('改分类（' + MATERIAL_KINDS.map(([k, l]) => k + '=' + l).join('，') + '）',
          it.kind || 'note');
        if (kindPick == null) return;
        const tags = await ask('改标签（逗号分开）', (it.tags || []).join(','));
        if (tags == null) return;
        try {
          await post('/api/material', { slug, id: it.id, title, kind: (kindPick || 'note').trim(),
            body: it.body || '', tags: tags.split(/[,，\s]+/).filter(Boolean) });
          toast('改好了'); hap();
          const d = await get('/api/material/item', { slug, id: it.id });
          it = d.item; paint();
        } catch (e) { toast('改不了：' + e.message); }
      };
      host.querySelector('[data-body]').onclick = async () => {
        const body = await ask('改正文', it.body || '', { multiline: true });
        if (body == null) return;
        try {
          await post('/api/material', { slug, id: it.id, title: it.title, kind: it.kind,
            body, tags: it.tags || [] });
          toast('改好了'); hap();
          const d = await get('/api/material/item', { slug, id: it.id });
          it = d.item; paint();
        } catch (e) { toast('改不了：' + e.message); }
      };
      host.querySelector('[data-del]').onclick = async () => {
        if (!(await confirmBox('删掉「' + it.title + '」？删了就找不回来了。', true))) return;
        try { await del('/api/material', { slug, id: it.id }); toast('删了'); U().back(); }
        catch (e) { toast('删不掉：' + e.message); }
      };
    };
    paint();
  }

  /* ══════════════════════════════════════════════════════════
     10. 数据与日志：备份 / 审计 / 日志 / 通知 / 自检
     ══════════════════════════════════════════════════════════ */
  /* ══════════════════════════════════════════════════════════
     参考书架：把"值得学的写法"存下来，写的时候能挑一句带进提示词
     ══════════════════════════════════════════════════════════ */
  /* 参考书架里那张图 / 那个文件的地址。App 里页面是 file://、拿不到 cookie，
     所以必须走 API.media()（换成带口令的绝对地址），跟封面同一套办法。 */
  function refFileUrl(slug, id) {
    const p = 'api/refs/file?slug=' + encodeURIComponent(slug) + '&id=' + encodeURIComponent(id);
    return window.API && window.API.media ? window.API.media(p) : p;
  }

  /* 看大图：整屏黑底、点一下就关。手机上可以双指放大（image 天然支持）。 */
  function bigImage(src, title) {
    const box = document.createElement('div');
    box.className = 't-bigpic';
    box.innerHTML = '<img src="' + esc(src) + '" alt="' + esc(title || '') + '">' +
                    '<div class="t-bigpic-cap">' + esc(title || '') + '</div>';
    box.onclick = () => box.remove();
    document.body.appendChild(box);
  }

  function openRefs(host) { Push.book('参考书架', refsHome); }

  async function refsHome(host, slug, q) {
    loading(host, '翻书架…');
    let d;
    try { d = await get('/api/refs', { slug, q: q || '' }); }
    catch (e) { empty(host, '读不到：' + e.message); return; }
    const items = d.items || [];
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">参考书架：摘抄、心得、整篇范文都放这儿。' +
      '写正文时在写作台勾上即可，它会作为「参考写法」进入提示词。只学手法，不抄句子。<br>' +
      '图片与文件都收：发一张人物参考图，在说明里写清想要的效果。写作时这段说明一起进提示词。' +
      '<b>说明：图本身模型看不到</b>，它看到的是你写的说明文字。</div>' +
      '<input class="t-input" data-q placeholder="搜标题 / 正文 / 出处" value="' + esc(q || '') + '">' +
      '<div class="t-bar" style="margin:var(--sp-3) 0"><button class="t-btn pri" data-new>放一条进来</button>' +
      '<button class="t-btn" data-pick>收图片 / 文件</button>' +
      '<input type="file" data-file hidden multiple accept="image/*,.md,.txt,.json,.csv,.yml,.yaml">' +
      ((d.tags || []).length ? (d.tags || []).map((t) =>
        '<button class="t-pill gray" data-tag="' + esc(t) + '">' + esc(t) + '</button>').join('') : '') +
      '</div>' +
      (items.length
        ? '<div class="t-list">' + items.map((it, i) => '<div class="t-row' +
            (it.kind === 'image' ? ' m-row' : '') + '" data-open="' + i + '">' +
            (it.kind === 'image' && it.hasFile
              ? '<img class="t-thumb" data-zoom="' + i + '" alt="' + esc(it.title) + '" src="' +
                esc(refFileUrl(slug, it.id)) + '">'
              : ico(it.kind === 'file' ? 'file' : 'note')) +
            '<div class="tr-main"><div class="tr-title">' + esc(it.title) + '</div>' +
            '<div class="tr-sub wrap">' + esc(it.preview || '（空）') + '<br>' +
            esc([it.kind === 'image' ? '参考图' : (it.kind === 'file' ? '参考文件' : ''),
                 it.source, (it.tags || []).join('、'), it.words + ' 字'].filter(Boolean).join(' · ')) +
            '</div></div><button class="t-btn sm dim" data-del="' + i + '">删</button></div>').join('') + '</div>'
        : '<div class="t-empty">书架是空的。看到好的写法就摘一句进来 —— 写长篇时这是最省事的自我提升。<br>' +
          '想发参考图就点上面的「收图片 / 文件」。</div>');
    const box = host.querySelector('[data-q]');
    let timer = null;
    box.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(() => refsHome(host, slug, box.value.trim()), 350);
    });
    host.querySelector('[data-new]').onclick = () => { hap(); push('放一条进来', (h) => refForm(h, slug, null)); };
    const pick = host.querySelector('[data-pick]');
    const fileBox = host.querySelector('[data-file]');
    pick.onclick = () => { hap(); fileBox.click(); };
    fileBox.onchange = async () => {
      const files = Array.from(fileBox.files || []);
      fileBox.value = '';
      if (!files.length) return;
      const fd = new FormData();
      fd.append('slug', slug);
      files.forEach((f) => fd.append('files', f, f.name));
      const t = toast('正在传 ' + files.length + ' 个…', 0);
      try {
        const d2 = await upload('api/refs/upload', fd);
        if (t) t.close();
        toast('收进来 ' + (d2.count || files.length) + ' 个 · 点开写说明');
        hap(); refsHome(host, slug, q);
      } catch (e) { if (t) t.close(); toast('传不上去：' + e.message); }
    };
    host.querySelectorAll('[data-zoom]').forEach((im) => {
      im.onclick = (e) => {
        e.stopPropagation();
        hap();
        const it = items[Number(im.dataset.zoom)];
        bigImage(refFileUrl(slug, it.id), it.title);
      };
    });
    host.querySelectorAll('[data-tag]').forEach((b) => {
      b.onclick = () => { hap(); refsHome(host, slug, b.dataset.tag); };
    });
    host.querySelectorAll('[data-open]').forEach((row) => {
      row.onclick = (e) => {
        if (e.target.closest('[data-del]')) return;
        hap();
        push('改：' + items[Number(row.dataset.open)].title,
             (h) => refForm(h, slug, items[Number(row.dataset.open)]));
      };
    });
    host.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const it = items[Number(b.dataset.del)];
        if (!(await confirmBox('删掉「' + it.title + '」？', true))) return;
        try { await del('/api/refs/item', { slug, id: it.id }); toast('删了'); hap(); refsHome(host, slug, q); }
        catch (err) { toast('删不掉：' + err.message); }
      };
    });
  }

  async function refForm(host, slug, item) {
    let full = item;
    if (item && item.id) {
      loading(host, '打开…');
      try { full = await get('/api/refs/item', { slug, id: item.id }); }
      catch (e) { empty(host, '读不到：' + e.message); return; }
    }
    const it = full || { title: '', source: '', kind: 'excerpt', tags: [], text: '' };
    const isImg = it.kind === 'image' && it.hasFile;
    host.innerHTML =
      '<div class="t-form">' +
      (it.hasFile
        ? '<div class="t-field"><label>' + (isImg ? '这张图' : '这个文件') + '</label>' +
          (isImg
            ? '<img class="t-pic" data-big src="' + esc(refFileUrl(slug, it.id)) + '" alt="' +
              esc(it.title || '参考图') + '">'
            : '<div class="t-hint" style="margin:0">文件：<b>' + esc(it.file || '') + '</b></div>') +
          '<div class="t-hint">点图看大图（手机上可以双指放大）。想换一张就删了这条重新传。</div></div>'
        : '') +
      '<div class="t-field"><label>起个名字</label><input class="t-input" data-title value="' +
      esc(it.title || '') + '" placeholder="例：打斗怎么写 / 第三章的对白"></div>' +
      '<div class="t-field"><label>出处</label><input class="t-input" data-source value="' +
      esc(it.source || '') + '" placeholder="哪本书 / 哪个网址 / 自己记的"></div>' +
      '<div class="t-field"><label>标签</label><input class="t-input" data-tags value="' +
      esc((it.tags || []).join('，')) + '" placeholder="用逗号分开：打斗，节奏"></div>' +
      '<div class="t-field"><label>' + (it.hasFile ? '说明（这段会进提示词）' : '正文') + '</label>' +
      '<textarea class="t-area" data-text style="min-height:' + (it.hasFile ? '120' : '200') + 'px" ' +
      'placeholder="' + (it.hasFile
        ? '写清楚这张图想表达什么：例「她说话前总先抿一下嘴，眼神有点倔」'
        : '把那段让你拍大腿的写法抄进来') + '">' + esc(it.text || '') + '</textarea>' +
      '<div class="t-hint">' + (it.hasFile
        ? '图本身模型看不到 —— 它读到的是「你写在这里的这段话」加上文件名。所以<b>这段说明越具体越有用</b>。'
        : '摘抄用于学手法：写作时只作为「参考写法」进入提示词。会写明不要照抄句子。') + '</div></div>' +
      '</div>' +
      '<div class="t-bar"><button class="t-btn pri" data-save>' + (it.id ? '存下改动' : '放进书架') + '</button>' +
      '</div>';
    const big = host.querySelector('[data-big]');
    if (big) big.onclick = () => { hap(); bigImage(big.src, it.title || '参考图'); };
    host.querySelector('[data-save]').onclick = async () => {
      const body = { slug, title: host.querySelector('[data-title]').value.trim(),
                     source: host.querySelector('[data-source]').value.trim(),
                     tags: host.querySelector('[data-tags]').value,
                     text: host.querySelector('[data-text]').value,
                     kind: it.kind || 'excerpt' };
      if (!body.title) { toast('先起个名字'); return; }
      if (it.id) body.id = it.id;
      try {
        await post('/api/refs/item', body);
        toast('收好了'); hap();
        U().back();
      } catch (e) { toast('放不进去：' + e.message); }
    };
  }

  /* 写作台里挑参考：勾几条，写的时候一起喂进去 */
  async function refPicker(host, slug, chosen, after) {
    let d;
    try { d = await get('/api/refs', { slug }); }
    catch (e) { toast('读不到书架：' + e.message); return; }
    const items = d.items || [];
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">勾上的会作为「参考写法」进这次的提示词（最多 4 条）。</div>' +
      (items.length
        ? '<div class="t-list">' + items.map((it) => '<div class="t-row' +
            (it.kind === 'image' ? ' m-row' : '') + '" data-id="' + it.id + '">' +
            (it.kind === 'image' && it.hasFile
              ? '<img class="t-thumb" alt="" src="' + esc(refFileUrl(slug, it.id)) + '">'
              : ico(it.kind === 'file' ? 'file' : 'note')) +
            '<div class="tr-main"><div class="tr-title">' + esc(it.title) + '</div>' +
            '<div class="tr-sub wrap">' + esc(it.preview || '') + '</div></div>' +
            '<span class="t-pill ' + (chosen.indexOf(it.id) > -1 ? 'ok' : 'gray') + '" data-tick="' + it.id + '">' +
            (chosen.indexOf(it.id) > -1 ? '已选' : '选它') + '</span></div>').join('') + '</div>'
        : '<div class="t-empty">书架还是空的，先去「参考书架」放几条。</div>') +
      '<div class="t-bar" style="margin-top:var(--sp-3)"><button class="t-btn pri" data-ok>好了</button></div>';
    host.querySelectorAll('[data-tick]').forEach((b) => {
      b.onclick = () => {
        hap();
        const id = Number(b.dataset.tick);
        const at = chosen.indexOf(id);
        if (at > -1) chosen.splice(at, 1);
        else if (chosen.length >= 4) { toast('最多勾 4 条'); return; }
        else chosen.push(id);
        refPicker(host, slug, chosen, after);
      };
    });
    const ok = host.querySelector('[data-ok]');
    if (ok) ok.onclick = () => { hap(); U().back(); if (after) after(); };
  }

  /* 数据与日志这一屏是**整包**的（备份整包、日志整机），不跟着某本书走；
     但切换入口照样给（全站同一个组件），在任何一屏都能看到现在在写哪本、随手就换。 */
  function openLogs(host) { Push.book('数据与日志', (h) => logsHome(h), { global: true }); }

  function logsHome(host) {
    tabShell(host, [['backup', '备份'], ['audit', '改动'], ['logs', '日志'],
                    ['notify', '通知'], ['doctor', '自检']], {
      backup: (pane, repaint) => backupPane(pane, repaint),
      audit: (pane) => auditPane(pane),
      logs: (pane) => logsPane(pane),
      notify: (pane) => notifyPane(pane),
      doctor: (pane) => doctorPane(pane),
    });
  }

  async function backupPane(pane, repaint) {
    loading(pane, '看备份…');
    let d;
    try { d = await get('/api/backup/list'); } catch (e) { empty(pane, '读不到：' + e.message); return; }
    const items = d.items || [];
    const auto = d.auto || {};
    pane.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">备份是整包的：书稿文件 + 一份数据库快照，' +
      '放在服务器上，一共 ' + esc(U().bytes(d.totalSize || 0)) + '。</div>' +
      '<div class="t-bar"><button class="t-btn pri" data-new>现在打一份备份</button></div>' +
      '<div class="t-form">' +
      '<div class="t-field"><label>自动备份</label><div class="t-seg wide" data-auto>' +
      '<button data-v="1" class="' + (auto.enabled ? 'on' : '') + '">开</button>' +
      '<button data-v="0" class="' + (auto.enabled ? '' : 'on') + '">关</button></div>' +
      '<div class="t-hint">每 ' + (auto.everyHours || 24) + ' 小时打一份，留最近 ' +
      (auto.keep || 14) + ' 份，旧的自动清掉。</div></div></div>' +
      (items.length ? '<div class="t-list">' + items.map((b, i) =>
        '<div class="t-row" data-i="' + i + '">' + ico('shield') +
        '<div class="tr-main"><div class="tr-title">' + esc(b.note || b.name) + '</div>' +
        '<div class="tr-sub">' + esc([ago(b.createdAt), U().bytes(b.size),
          b.books ? (b.books + ' 本书') : '', b.withDb ? '含数据库' : '只书稿'].filter(Boolean).join(' · ')) +
        '</div></div><span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('') + '</div>'
        : '<div class="t-empty">还没有备份</div>');
    pane.querySelector('[data-new]').onclick = async () => {
      const note = await ask('这份备份叫什么（可空）', '', { placeholder: '例：改大结局之前' });
      if (note == null) return;
      loading(pane, '打包中，书多的话要几秒…');
      try { await post('/api/backup/create', { note: note || '手动备份' }); toast('备份好了'); hap(); }
      catch (e) { toast('备份失败：' + e.message); }
      repaint();
    };
    pane.querySelector('[data-auto]').addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      try {
        await post('/api/backup/auto', { enabled: b.dataset.v === '1' });
        toast('记下了'); hap(); repaint();
      } catch (err) { toast('改不了：' + err.message); }
    });
    pane.querySelectorAll('[data-i]').forEach((r) => {
      r.onclick = () => {
        const b = items[Number(r.dataset.i)];
        hap();
        push('备份 · ' + (b.note || b.name), (h2) => backupDetail(h2, b));
      };
    });
  }

  function backupDetail(host, b) {
    host.innerHTML =
      '<div class="t-form">' +
      '<div class="t-field"><label>这一份里有什么</label>' +
      '<div class="t-hint" style="margin:0">' + esc([ago(b.createdAt), U().bytes(b.size),
        b.withDb ? '含数据库（设定、伏笔、时间线）' : '只有书稿文件',
        b.books ? (b.books + ' 本书') : ''].filter(Boolean).join(' · ')) + '</div></div>' +
      '<div class="t-field"><label>恢复会怎样</label>' +
      '<div class="t-hint" style="margin:0">恢复前会先自动打一份「恢复前快照」，' +
      '现在的书稿挪进 data/trash/，绝不直接删。</div></div>' +
      '</div>' +
      '<div class="t-bar"><button class="t-btn" data-dl>下载到本机</button></div>' +
      '<div class="t-bar"><button class="t-btn" data-restore>只恢复书稿</button>' +
      '<button class="t-btn dan" data-restore-all>连数据库一起恢复</button></div>' +
      '<div class="t-bar"><button class="t-btn dan" data-del>删掉这份备份</button></div>' +
      '<div data-out></div>';
    host.querySelector('[data-dl]').onclick = () => {
      download('api/backup/download?' + qs({ name: b.name }));
    };
    const restore = async (withDb) => {
      const ok = await confirmBox('恢复这一份？' +
        (withDb ? '设定、伏笔、时间线也会回到那时候的状态。' : '只换书稿文件，设定数据不动。') +
        '恢复前会先自动打一份快照，能退回来。', true);
      if (!ok) return;
      const out = host.querySelector('[data-out]');
      loading(out, '恢复中…');
      try {
        await post('/api/backup/restore', { name: b.name, confirm: true, withDb });
        out.innerHTML = '<div class="t-hint">恢复好了。App 里建议下拉刷新一下书架。</div>';
        toast('恢复完成'); hap();
      } catch (e) { out.innerHTML = '<div class="t-empty">恢复失败：' + esc(e.message) + '</div>'; }
    };
    host.querySelector('[data-restore]').onclick = () => restore(false);
    host.querySelector('[data-restore-all]').onclick = () => restore(true);
    host.querySelector('[data-del]').onclick = async () => {
      if (!(await confirmBox('删掉这份备份？删了就找不回来了。', true))) return;
      try { await del('/api/backup/item', { name: b.name }); toast('删了'); hap(); U().back(); }
      catch (e) { toast('删不掉：' + e.message); }
    };
  }

  const ACTION_CN = {
    'backup.create': '打了备份', 'backup.auto': '自动备份', 'backup.restore': '恢复了备份',
    replace: '全文替换', write: 'AI 写入', import: '导入',
  };

  async function auditPane(pane) {
    loading(pane, '读记录…');
    let d;
    try { d = await get('/api/audit', { limit: 150 }); } catch (e) { empty(pane, '读不到：' + e.message); return; }
    const items = d.items || [];
    pane.innerHTML = '<div class="t-hint" style="margin:0 0 var(--sp-3)">谁什么时候动了什么，都记在这儿。' +
      '改坏了想找原因，先来这儿看。</div>' +
      (items.length ? '<div class="t-list">' + items.map((a) =>
        '<div class="t-row static">' + ico('history') +
        '<div class="tr-main"><div class="tr-title">' + esc(ACTION_CN[a.action] || a.action) +
        (a.slug ? '　' + esc(a.slug) : '') + '</div>' +
        '<div class="tr-sub">' + esc([ago(a.at), a.actor === 'system' ? '系统' : '你',
          JSON.stringify(a.detail || {}) === '{}' ? '' : JSON.stringify(a.detail)].filter(Boolean).join(' · ')) +
        '</div></div></div>').join('') + '</div>'
        : '<div class="t-empty">还没有记录</div>');
  }

  async function logsPane(pane) {
    loading(pane, '看日志…');
    let d;
    try { d = await get('/api/app/logs/status'); } catch (e) { empty(pane, '读不到：' + e.message); return; }
    const files = d.files || [];
    pane.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (d.fileCount || 0) + '</b><span>日志文件</span></div>' +
      '<div class="t-stat"><b>' + esc(U().bytes(d.totalBytes || 0)) + '</b><span>总大小</span></div>' +
      '<div class="t-stat"><b>' + (d.latestMtimeMs ? ago(d.latestMtimeMs) : '—') + '</b><span>最近写入</span></div>' +
      '</div>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">日志在服务器上 ' + esc(d.directory || '') +
      '。出问题时把它下载下来能给 AI 看。</div>' +
      (files.length ? '<div class="t-list">' + files.slice().reverse().map((f) =>
        '<div class="t-row static">' + ico('terminal') +
        '<div class="tr-main"><div class="tr-title">' + esc(f.name) + '</div>' +
        '<div class="tr-sub">' + esc(U().bytes(f.size) + ' · ' + ago(f.mtimeMs)) + '</div></div>' +
        '<button class="t-btn sm" data-dl="' + esc(f.name) + '">下载</button></div>').join('') + '</div>'
        : '<div class="t-empty">还没有日志文件</div>');
    pane.querySelectorAll('[data-dl]').forEach((b) => {
      b.onclick = () => download('api/app/logs/download?' + qs({ file: b.dataset.dl }));
    });

    /* 离线缓存：读过就存一份在本机（浏览器/App 都是这块 localStorage），断网接着看 */
    const off = window.Offline ? Offline.stats() : { books: 0, chapters: 0, chars: 0 };
    const box = document.createElement('div');
    box.innerHTML =
      '<h2 class="st-h">离线缓存</h2>' +
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + off.books + '</b><span>缓存书目</span></div>' +
      '<div class="t-stat"><b>' + off.chapters + '</b><span>缓存章节</span></div>' +
      '<div class="t-stat"><b>' + off.chars + '</b><span>字数</span></div></div>' +
      '<div class="t-hint">读过的章节会自动留一份在本机，断网也能接着看（最多 120 章，' +
      '超了丢最早读的）。清掉不影响服务器上的原稿。</div>' +
      '<div class="t-bar"><button class="t-btn dan" data-offclear>清空离线缓存</button></div>';
    pane.appendChild(box);
    box.querySelector('[data-offclear]').onclick = async () => {
      if (!(await confirmBox('清空本机的离线缓存？服务器上的书稿一个字都不会动。', true))) return;
      const st = window.Offline ? Offline.clear() : { chapters: 0 };
      toast('清掉了 ' + st.chapters + ' 章缓存'); hap();
      logsPane(pane);
    };
  }

  async function notifyPane(pane) {
    loading(pane, '看通知…');
    let d;
    try { d = await get('/api/notifications', { limit: 50 }); }
    catch (e) { empty(pane, '读不到：' + e.message); return; }
    const items = d.items || [];
    pane.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">' + (d.unread || 0) + ' 条没读过。</div>' +
      '<div class="t-bar"><button class="t-btn" data-read>全部标成已读</button></div>' +
      (items.length ? '<div class="t-list">' + items.map((n) =>
        '<div class="t-row static' + (n.read_at ? '' : '') + '">' + ico('dot') +
        '<div class="tr-main"><div class="tr-title">' + esc(n.title) + '</div>' +
        '<div class="tr-sub wrap">' + esc([n.body || '', n.slug || '', ago(n.created_at)].filter(Boolean).join(' · ')) +
        '</div></div>' + (n.read_at ? '<span class="t-pill gray">读过</span>' : '<span class="t-pill">新</span>') +
        '</div>').join('') + '</div>'
        : '<div class="t-empty">还没有通知</div>');
    pane.querySelector('[data-read]').onclick = async () => {
      try { await post('/api/notifications/read', { all: true }); toast('都标成已读了'); hap();
        notifyPane(pane); }
      catch (e) { toast('改不了：' + e.message); }
    };
  }

  async function doctorPane(pane) {
    loading(pane, '给数据做体检…');
    let d;
    try { d = await get('/api/backup/doctor'); } catch (e) { empty(pane, '查不了：' + e.message); return; }
    const issues = d.issues || [];
    pane.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (d.books || 0) + '</b><span>本书</span></div>' +
      '<div class="t-stat"><b>' + (d.count || 0) + '</b><span>问题</span></div>' +
      '<div class="t-stat"><b>' + (d.backups || 0) + '</b><span>份备份</span></div></div>' +
      (d.clean ? '<div class="t-empty">' + window.iconHtml('check') +
        '<div style="margin-top:var(--sp-3)">数据是干净的，没挑出问题</div></div>'
        : '<div class="t-list">' + issues.map((it) =>
          '<div class="t-row static warn">' + ico('shield') +
          '<div class="tr-main"><div class="tr-title">' + esc(it.kind || '问题') +
          (it.slug ? '　' + esc(it.slug) : '') + '</div>' +
          '<div class="tr-sub wrap">' + esc(it.hint || '') +
          (it.path ? '　' + esc(it.path) : '') + '</div></div></div>').join('') + '</div>') +
      (d.brokenBackups && d.brokenBackups.length
        ? '<h2 class="st-h">备份清单里有对不上的</h2><div class="t-hint">' +
          esc(d.brokenBackups.join('、')) + '</div>' : '');
  }

  /* ══════════════════════════════════════════════════════════
     11. 提示词库：AI 人设提示词（可改 / 可版本 / 可回滚 / 可对比）+ 常用片段
     改完立刻生效——拼系统提示词的地方（server/llm/prompts.build_system）读的就是这份。
     ══════════════════════════════════════════════════════════ */
  const SOURCE_CN = { book: '这本书自己的', global: '全局自定义', builtin: '内置默认' };

  function openPrompt(host) { Push.book('提示词', promptHome); }

  function promptHome(host, slug) {
    tabShell(host, [['book', '这本书'], ['global', '全局'], ['snippet', '常用片段']], {
      book: (pane) => promptList(pane, slug, 'book'),
      global: (pane) => promptList(pane, '', 'global'),
      snippet: (pane) => snippetList(pane),
    });
  }

  async function promptList(pane, slug, scope) {
    loading(pane, '读提示词…');
    let d;
    try { d = await get('/api/prompts', scope === 'book' ? { slug: slug } : {}); }
    catch (e) { empty(pane, '读不到：' + e.message); return; }
    const items = d.items || [];
    pane.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">' +
      (scope === 'book'
        ? '这里改的是这本书专用的；没改的那几个跟着全局或内置走。'
        : '全局的：所有书默认都吃这一份，单本书还能再覆盖一层。') +
      '</div>' +
      '<div class="t-list">' + items.map((it, i) =>
        '<div class="t-row" data-i="' + i + '">' + ico('spark') +
        '<div class="tr-main"><div class="tr-title">' + esc(it.name) + '</div>' +
        '<div class="tr-sub">' + esc(SOURCE_CN[it.source] || it.source) +
        (it.version ? ' · v' + it.version : '') + ' · ' + (it.body || '').length + ' 字</div></div>' +
        '<span class="t-pill ' + (it.source === 'builtin' ? 'gray' : 'ok') + '">' +
        (it.source === 'builtin' ? '默认' : '改过') + '</span>' +
        '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('') +
      '</div>';
    pane.querySelectorAll('[data-i]').forEach((r) => {
      r.onclick = () => {
        hap();
        const it = items[Number(r.dataset.i)];
        push('提示词 · ' + it.name, (h) => promptDetail(h, it, slug, scope));
      };
    });
  }

  async function promptDetail(host, item, slug, scope) {
    loading(host, '打开这一份…');
    let it = item;
    try {
      const d = await get('/api/prompts', scope === 'book' ? { slug: slug } : {});
      it = (d.items || []).find((x) => x.key === item.key) || item;
    } catch (e) {}
    const src = SOURCE_CN[it.source] || it.source;
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">' + esc(it.description || '') + '</div>' +
      '<div class="t-form"><div class="t-field"><label>这一份的正文</label>' +
      '<textarea class="t-area" id="pm-body" rows="12" spellcheck="false"></textarea>' +
      '<div class="t-hint" id="pm-hint" style="margin:0"></div></div></div>' +
      '<div class="t-bar">' +
      '<button class="t-btn pri" data-save>保存这一版</button>' +
      '<button class="t-btn" data-hist>历史（' + (it.version || 0) + '）</button>' +
      '<button class="t-btn" data-builtin>看内置原文</button>' +
      (it.source === 'builtin' ? '' : '<button class="t-btn dan" data-reset>恢复内置</button>') +
      '</div>';
    const ta = host.querySelector('#pm-body');
    ta.value = it.body || '';
    const hint = host.querySelector('#pm-hint');
    hint.textContent = '现在用的是：' + src + (it.version ? '（v' + it.version + '）' : '')
      + '。保存会记一版，改坏了能回滚。';

    host.querySelector('[data-save]').onclick = async () => {
      const body = ta.value;
      if (!body.trim()) { toast('正文不能是空的'); return; }
      const note = await ask('这一版改了什么（可留空）', '', { host });
      if (note === null) return;
      try {
        const r = await post('/api/prompts/save', { key: it.key, scope, slug: scope === 'book' ? slug : '', body, note: note || '' });
        hap(); toast('存好了（v' + r.version + '）');
        promptDetail(host, it, slug, scope);
      } catch (e) { toast('存不了：' + e.message); }
    };
    host.querySelector('[data-builtin]').onclick = () => {
      hap();
      App.sheet('<div class="t-dialog"><h3>内置原文（只读）</h3>' +
        '<div class="t-hint" style="white-space:pre-wrap;max-height:56vh;overflow:auto">' +
        esc(it.builtin || '（这一份没有内置正文）') + '</div>' +
        '<div class="t-acts"><button class="t-btn" data-close>关掉</button></div></div>');
    };
    host.querySelector('[data-hist]').onclick = () => { hap(); push('提示词 · 历史', (h) => promptHistory(h, it, slug, scope, host)); };
    const rb = host.querySelector('[data-reset]');
    if (rb) rb.onclick = async () => {
      const yes = await confirmBox('删掉这份自定义，让它回到下一层（' +
        (scope === 'book' ? '全局或内置' : '内置') + '）？历史记录会留着，随时能捞回来。', true);
      if (!yes) return;
      try {
        await del('/api/prompts/override', { key: it.key, scope, slug: scope === 'book' ? slug : '' });
        hap(); toast('已恢复'); promptDetail(host, it, slug, scope);
      } catch (e) { toast('删不了：' + e.message); }
    };
  }

  async function promptHistory(host, item, slug, scope, backHost) {
    loading(host, '读历史…');
    let d;
    try {
      d = await get('/api/prompts/versions', { key: item.key, scope, slug: scope === 'book' ? slug : '' });
    } catch (e) { empty(host, '读不到：' + e.message); return; }
    const vs = d.versions || [];
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">这份提示词改过的每一版都留在这儿（共 ' + vs.length + ' 版）。' +
      '回滚不是删历史，是拿旧的那份再存一版。</div>' +
      (vs.length ? '<div class="t-list">' + vs.map((v, i) =>
        '<div class="t-row" data-i="' + i + '">' + ico('history') +
        '<div class="tr-main"><div class="tr-title">v' + v.version + '　' + esc(v.note || '（没写备注）') + '</div>' +
        '<div class="tr-sub">' + esc(ago(v.createdAt)) + ' · ' + v.chars + ' 字</div></div>' +
        '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('') + '</div>'
        : '<div class="t-empty">还没改过，一份旧版都没有</div>') +
      (vs.length ? '<div class="t-bar"><button class="t-btn dan" data-clear>清空历史</button></div>' : '');
    host.querySelectorAll('[data-i]').forEach((r) => {
      r.onclick = () => {
        hap();
        const v = vs[Number(r.dataset.i)];
        push('v' + v.version + ' 对比', (h) => promptDiff(h, item, v, slug, scope, host));
      };
    });
    const cb = host.querySelector('[data-clear]');
    if (cb) cb.onclick = async () => {
      const yes = await confirmBox('清空这份提示词的历史版本？现在生效的那一份不动。', true);
      if (!yes) return;
      try {
        await del('/api/prompts/versions', { key: item.key, scope, slug: scope === 'book' ? slug : '' });
        hap(); toast('清空了'); promptHistory(host, item, slug, scope, backHost);
      } catch (e) { toast('清不掉：' + e.message); }
    };
  }

  async function promptDiff(host, item, ver, slug, scope, histHost) {
    loading(host, '对比…');
    let d;
    try {
      d = await get('/api/prompts/diff', { key: item.key, version: ver.version, scope, slug: scope === 'book' ? slug : '' });
    } catch (e) { empty(host, '比不了：' + e.message); return; }
    const lines = (d.diff || []).map((l) => {
      const cls = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : '';
      return '<div' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(l || ' ') + '</div>';
    }).join('');
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">v' + ver.version + '（' + esc(ver.note || '没写备注') +
      '）跟<b>现在生效的</b>比：<span style="color:var(--ok)">绿色是现在多的</span>，' +
      '<span style="color:var(--danger)">红色是现在少的</span>。</div>' +
      (lines ? '<div class="st-diff">' + lines + '</div>' : '<div class="t-empty">这一版跟现在一模一样</div>') +
      '<div class="t-bar"><button class="t-btn pri sm" data-roll>换回 v' + ver.version + ' 那一版</button></div>';
    host.querySelector('[data-roll]').onclick = async () => {
      const yes = await confirmBox('把正文换成 v' + ver.version + ' 那一版？会新增一版记录，历史不丢。', false);
      if (!yes) return;
      try {
        const r = await post('/api/prompts/rollback', { key: item.key, version: ver.version, scope, slug: scope === 'book' ? slug : '' });
        hap(); toast('回到 v' + ver.version + ' 了（新版本 v' + r.version + '）');
        promptHistory(host, item, slug, scope, histHost);
      } catch (e) { toast('回滚不了：' + e.message); }
    };
  }

  async function snippetList(pane) {
    loading(pane, '读片段…');
    let d;
    try { d = await get('/api/snippets'); } catch (e) { empty(pane, '读不到：' + e.message); return; }
    const items = d.items || [];
    pane.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">常用指令碎片：写正文、改稿时反复要用的那几句，存这儿随时取。</div>' +
      '<div class="t-bar"><button class="t-btn pri" data-new>新建片段</button></div>' +
      (items.length ? '<div class="t-list">' + items.map((it, i) =>
        '<div class="t-row" data-i="' + i + '">' + ico('note') +
        '<div class="tr-main"><div class="tr-title">' + esc(it.name) + '</div>' +
        '<div class="tr-sub wrap">' + esc((it.body || '').slice(0, 60)) +
        (it.tags ? '　#' + esc(it.tags) : '') + '</div></div>' +
        '<button class="t-btn sm dan" data-del="' + i + '">删</button></div>').join('') + '</div>'
        : '<div class="t-empty">还没有片段</div>');

    const refresh = () => snippetList(pane);

    const addOne = async (it) => {
      const name = await ask('片段叫什么', it ? it.name : '', { host: pane });
      if (name === null || !name.trim()) return;
      const body = await ask('片段内容', it ? it.body : '', { host: pane, multiline: true });
      if (body === null || !body.trim()) return;
      const tags = await ask('标记（可留空）', it ? it.tags : '', { host: pane });
      if (tags === null) return;
      try {
        await post('/api/snippets/save', { key: it ? it.key : '', name, body, tags });
        hap(); toast('存好了'); refresh();
      } catch (e) { toast('存不了：' + e.message); }
    };
    pane.querySelector('[data-new]').onclick = () => addOne(null);
    pane.querySelectorAll('[data-i]').forEach((r) => {
      r.onclick = (e) => { if (e.target.closest('[data-del]')) return; hap(); addOne(items[Number(r.dataset.i)]); };
    });
    pane.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        const it = items[Number(b.dataset.del)];
        const yes = await confirmBox('删掉片段「' + it.name + '」？', true);
        if (!yes) return;
        try { await del('/api/snippets', { key: it.key }); hap(); toast('删了'); clipaint(); }
        catch (err) { toast('删不掉：' + err.message); }
      };
    });
  }

  /* ══════════════════════════════════════════════════════════
     注册到工具宫格（宫格和分组在 tools.js 里，这里只加卡片）
     ══════════════════════════════════════════════════════════ */
  if (window.Tools && window.Tools.add) {
    window.Tools.add([
      { id: 'write', name: '写作台', sub: '生成·续写', icon: 'wand', sec: '写作', run: openWrite },
      { id: 'world', name: '世界', sub: '人物·时间线', icon: 'layers', sec: '写作', run: openWorld },
      { id: 'plot', name: '剧情', sub: '伏笔·决策', icon: 'bookmark', sec: '写作', run: openPlot },
      { id: 'lint', name: '质检', sub: 'AI 味', icon: 'check', sec: '写作', run: openLint },
      { id: 'prompt', name: '提示词', sub: '人设·片段', icon: 'spark', sec: '写作', run: openPrompt },
      { id: 'stats', name: '统计', sub: '字数·成就', icon: 'chart', sec: '写作', run: openStats },
      { id: 'export', name: '导出', sub: 'TXT·EPUB', icon: 'download', sec: '书稿', run: openExport },
      { id: 'material', name: '素材', sub: '灵感碎片', icon: 'note', sec: '书稿', run: openMaterial },
      { id: 'refs', name: '参考书架', sub: '学写法', icon: 'bookmark', sec: '书稿', run: openRefs },
      { id: 'term', name: '术语', sub: '统一叫法', icon: 'tag', sec: '书稿', run: openTerm },
      { id: 'listen', name: '听书', sub: '音色·语速', icon: 'sound', sec: '系统', run: openListen },
      { id: 'logs', name: '数据', sub: '备份·日志', icon: 'shield', sec: '系统', run: openLogs },
    ]);
  }
})();
