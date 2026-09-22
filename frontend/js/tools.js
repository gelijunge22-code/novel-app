/* ============================================================
   tools.js — 「工具」区：原网页（小说软件本体）的能力，一件一屏搬进 App。

   这里的原则：
   1. 每一项都对着平台的**真实接口**写，不凭空造。路径以 nb/api/... 开头，
      走 server.py 的 /nb 透传（它已经替我们处理了登录、项目未打开自愈、SSE 流）。
   2. 平台没有的接口不做界面。做之前先探过真实返回结构（tools/probe_shapes.py）。
   3. 界面只用 tools.css 里的通用件，不各自造轮子。

   返回：顶部返回键在层级里往上退一级，退到底回书架。
   ============================================================ */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const nb = (p, o) => window.API.nb(p, o);
  const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const toast = (m) => { try { App.toast(m); } catch (e) {} };
  const hap = () => { try { App.haptic(8); } catch (e) {} };
  const ico = (n) => '<span class="tr-ico">' + window.iconHtml(n) + '</span>';
  const bytes = (n) => {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  };
  /* 平台的时间戳两种形态都有：毫秒数字，和 ISO 字符串。
     以前只认前者，ISO 的会算成 NaN 显示「Invalid Date」。 */
  const ts = (t) => {
    if (t == null || t === '') return 0;
    if (typeof t === 'number') return t;
    const n = Number(t);
    if (!isNaN(n)) return n;
    const p = Date.parse(String(t));
    return isNaN(p) ? 0 : p;
  };
  const ago = (t) => {
    t = ts(t);
    if (!t) return '';
    const d = (Date.now() - Number(t)) / 1000;
    if (d < 60) return '刚刚';
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
    if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
    if (d < 2592000) return Math.floor(d / 86400) + ' 天前';
    return new Date(ts(t)).toLocaleDateString('zh-CN');
  };

  /* ── 弹一个输入框（改名字、建文件都用它）──
     实现搬到 app.js 的 `App.ask` 了（聊天那边的"常用指令"也要用同一个框，
     不许两边各写一份）。这里保留同名函数，工具面板里的调用一行都不用改。 */
  const ask = (title, value, opts = {}) => window.App.ask(title, value, opts);

  const confirmBox = (title, danger) => new Promise((res) => {
    const wrap = document.createElement('div');
    wrap.className = 't-dialog';
    wrap.innerHTML = '<h3>' + esc(title) + '</h3>' +
      '<div class="t-acts"><button class="t-btn" data-no>取消</button>' +
      '<button class="t-btn ' + (danger ? 'dan' : 'pri') + '" data-yes>确定</button></div>';
    $('[data-no]', wrap).onclick = () => { wrap.remove(); res(false); };
    $('[data-yes]', wrap).onclick = () => { wrap.remove(); res(true); };
    (document.getElementById('tool-body') || document.body).appendChild(wrap);
  });

  /* ── 详情页的层级栈：返回键一级一级往上退 ── */
  const stack = [];
  function push(title, render) {
    stack.push({ title, render });
    App.show('tool', { hashExtra: '?t=' + stack.length });
  }
  function paint() {
    const top = stack[stack.length - 1];
    const body = document.getElementById('tool-body');
    const t = document.getElementById('tool-title');
    if (t) t.textContent = top ? top.title : '工具';
    if (!body) return;
    body.innerHTML = '';
    /* 吸底主操作条是面板自己挂的（听书的「开始听」）；换屏时必须摘掉，
       否则会跟着跑到别的面板上面去。 */
    body.classList.remove('has-foot');
    body.scrollTop = 0;
    if (top) {
      try { top.render(body); } catch (e) {
        body.innerHTML = errHtml('这一屏画不出来', e, ((e && e.message) ? e.message + '。' : '') +
          '退出去再进来试试；一直这样就去「工具 · 版本与日志」看一眼日志。');
      }
    }
  }
  /* ── 三态：跟全站同一套（reader/书架/预设 都用这个） ────────────────────
     统一。以前这里是 `.t-load` / `.t-empty` 两套自己的写法，
     而且**出错也走"空"** —— 用户看到一句灰字"读不到：xxx"，既分不清是"没东西"
     还是"出错了"，也没有「重试」，只能自己退出去再进来。
     现在：
       loading(host,msg)  → 骨架 + 「正在读…」（带 data-state，判据看得见）
       empty(host,msg,ic) → 空态：一句人话 + 说明
       failed(host,what,e,again) → 出错态：说人话 + 一个「重试」（真的重新拉一次）
     `loading/empty` 两个老名字留着（别处调得到）。 */
  /* ── 内联串里要画"空/出错"时用它 ────────────────────────────────────
     面板里大部分地方是拼 HTML 串的（`list.innerHTML = '…'`），没法直接 append 元素。
     那就把**全站那一个 UI.state** 转成 HTML —— 实现还是只有一份，
     外貌（圆角/字号/间距/图标/data-state 标记）全站一致。
     以前这里是散在 20 处的 `'<div class="t-empty">…'`：同一个"空"，字大小、间距、
     有没有说明、有没有图标各写各的 —— 此处说明"不统一"就是这么攒出来的。 */
  const asHtml = (node) => (node && node.outerHTML) ? node.outerHTML
    : '<div class="t-empty">' + esc('（界面组件没起来，退出重进一次）') + '</div>';
  const emptyHtml = (title, desc, ico2) =>
    asHtml(window.UI && UI.state ? UI.state({ kind: 'empty', icon: ico2 || 'list', title: title, desc: desc || '' }) : null);
  const errHtml = (what, e, desc2) => asHtml(window.UI && UI.state ? UI.state({
    kind: 'error', icon: 'refresh', title: what + '读不出来',
    desc: desc2 || (((e && e.message) ? e.message + '。' : '') + '退出去再进来试试。'),
  }) : null);

  /* ：**实现搬去了 UI 一份**（`UI.paintState/loadingIn/emptyIn/failedIn`），
     这里只留三个薄壳给面板里 30 多处老调用点用 —— 全站只此一份实现，
     换皮/两组实现并存是明令禁止的。`failed` 的 `again` 是**真重试**（重跑那个拉取函数）。 */
  const loading = (host, msg) => (window.UI && UI.loadingIn ? UI.loadingIn(host, msg) : null);
  const empty = (host, msg, icon, desc) => (window.UI && UI.emptyIn ? UI.emptyIn(host, msg, desc, icon) : null);
  const failed = (host, what, e, again) =>
    (window.UI && UI.failedIn ? UI.failedIn(host, what, e, again) : null);

  /* ── 作品列表（各工具选书用） ── */
  let _projects = null;
  /* 服务器口令只在这一次会话里记着（换书重渲染时不该把刚打的抹掉），不落盘 */
  let _peerPass = '';
  async function projects(force) {
    if (_projects && !force) return _projects;
    const d = await nb('api/projects');
    _projects = (d && d.projects) || [];
    return _projects;
  }
  const bookName = (slug) => {
    const p = (_projects || []).find((x) => x.projectRoot === slug);
    return (p && p.title) || slug;
  };

  /* ── 当前书：跟书有关的面板，顶上都要有那一条统一切换（） ──
     谁要书就读 BookCtx —— 全站唯一的一份「现在在写哪本」，
     不再每个面板自己弹书单、也不再"没选就摔给第一本"。 */
  const curSlug = () => (window.BookCtx ? BookCtx.slug() : '');
  const mountBook = (host, render, titleOf, opts) => {
    const slug = curSlug();
    host.innerHTML = '';
    if (!slug) { empty(host, '还没有作品 · 先去书架建一本', 'book'); return; }
    /* 那个「当前书」入口长在这一屏的**顶栏**上（不是正文里占一行）：
       所以要把内容宿主当成锚点传进去，它才知道"这一屏"是哪一个。 */
    host.appendChild(window.BookCtx.bar(slug, (s) => {
      const t = typeof titleOf === 'function' ? titleOf(s) : titleOf;
      const top = stack[stack.length - 1];
      if (top) top.title = t;
      const el = document.getElementById('tool-title');
      if (el) el.textContent = t;
      mountBook(host, render, titleOf, opts);         // 就地重渲染 → 内容立刻换成新书那套
    }, Object.assign({}, opts, { anchor: host })));
    const inner = document.createElement('div');
    host.appendChild(inner);
    try { render(inner, slug); } catch (e) { inner.innerHTML = errHtml('这一块画不出来', e); }
  };
  /** pushBook：面板标题 + 顶部切书条 + 内容是"当前书"的。
      没书时先让用户选一本（选完就成为"当前书"，全站跟着走）。 */
  function pushBook(titleOf, render, opts) {
    push(typeof titleOf === 'function' ? titleOf(curSlug()) : titleOf, (h) => {
      if (curSlug()) { mountBook(h, render, titleOf, opts); return; }
      loading(h, '读取作品…');
      /* 还没立起「当前书」：先兜一本（跟其它面板同一个来源），兜不到才让人挑 */
      const p = window.BookCtx ? BookCtx.ensure().catch(() => '') : Promise.resolve('');
      p.then((s) => {
        if (s) { BookCtx.set(s, bookName(s)); mountBook(h, render, titleOf, opts); return; }
        pickProject(h, (slug) => {
          window.BookCtx.set(slug, bookName(slug));
          mountBook(h, render, titleOf, opts);
        });
      });
    });
  }

  /* 选书：给了 slug 直接用，没给就弹一张书单 */
  function pickProject(host, cb) {
    loading(host, '读取作品…');
    projects().then((ps) => {
      if (!ps.length) { empty(host, '还没有作品', 'book'); return; }
      if (ps.length === 1) { cb(ps[0].projectRoot); return; }
      host.innerHTML = '<div class="t-list">' + ps.map((p) =>
        '<div class="t-row" data-slug="' + esc(p.projectRoot) + '">' + ico('book') +
        '<div class="tr-main"><div class="tr-title">' + esc(p.title || p.projectRoot) + '</div>' +
        '<div class="tr-sub">' + esc(p.summary || p.projectRoot) + '</div></div>' +
        '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('') + '</div>';
      $$('[data-slug]', host).forEach((r) => {
        r.onclick = () => { hap(); cb(r.dataset.slug); };
      });
    }).catch((e) => failed(host, '作品列表', e));
  }

  /* ══════════════════════════════════════════════════════════
     1. 文件：作品的每一个文件都能看、能改、能删
     ══════════════════════════════════════════════════════════ */
  function openFiles(host) { pushBook('文件', (h, slug) => fileBrowse(h, slug, ''), {}); }

  async function fileBrowse(host, slug, dir) {
    loading(host, '读文件树…');
    let d;
    try { d = await nb('api/workspace-files/tree?' + qs({ projectRoot: slug })); }
    catch (e) { failed(host, '文件树', e, () => fileBrowse(host, slug, dir)); return; }
    const nodes = d.nodes || [];
    paintBrowse(host, slug, dir, nodes);
  }

  function paintBrowse(host, slug, dir, nodes) {
    /* 进到子目录时，返回键先退一层目录（而不是直接弹回宫格）——
       以前这里是原地重绘、没有层级，按返回会一口气跳回宫格，中间那层就丢了。 */
    const topEntry = stack[stack.length - 1];
    if (topEntry) {
      topEntry.onBack = dir
        ? () => { paintBrowse(host, slug, dir.replace(/[^/]+\/$/, ''), nodes); return true; }
        : null;
    }
    /* 树是扁平的（98 个节点一口气给全），靠 path 前缀切出当前这一层 */
    const kids = [];
    const seenDir = {};
    nodes.forEach((n) => {
      const p = n.path;
      if (!p.startsWith(dir)) return;
      const rest = p.slice(dir.length);
      if (!rest) return;
      const seg = rest.split('/')[0];
      if (rest.indexOf('/') >= 0) {
        if (!seenDir[seg]) {
          seenDir[seg] = true;
          kids.push({ dir: true, name: seg, path: dir + seg + '/', words: n.words, icon: 'folder' });
        }
      } else {
        kids.push({ dir: false, name: seg, path: p, node: n });
      }
    });
    kids.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh'));

    const crumbs = ['<button data-crumb="">根目录</button>'];
    let acc = '';
    dir.split('/').filter(Boolean).forEach((s) => {
      acc += s + '/';
      crumbs.push('<span class="sep">/</span><button data-crumb="' + esc(acc) + '">' + esc(s) + '</button>');
    });

    const names = kids.map((k) => (k.dir ? k.name + '/' : k.name)).join('\n');
    host.innerHTML =
      '<div class="fb-crumb">' + crumbs.join('') + '</div>' +
      '<div class="t-bar">' +
      '<button class="t-btn sm" data-newf>新建文件</button>' +
      '<button class="t-btn sm" data-newd>新建文件夹</button>' +
      '<button class="t-btn sm" data-up>传文件</button>' +
      '<button class="t-btn sm" data-names>全路径</button>' +
      '</div>' +
      (kids.length
        ? '<div class="t-list">' + kids.map((k, i) =>
          '<div class="t-row" data-i="' + i + '">' +
          '<span class="tr-ico">' + window.iconHtml(k.dir ? 'folder' : ((k.node && k.node.icon) || 'file')) + '</span>' +
          '<div class="tr-main"><div class="tr-title">' + esc(k.name) + (k.dir ? '/' : '') + '</div>' +
          '<div class="tr-sub">' + (k.dir ? '文件夹'
            : bytes(k.node && k.node.size) + (k.node && k.node.words ? ' · ' + k.node.words + ' 字' : '') +
              (k.node && k.node.mtimeMs ? ' · ' + ago(k.node.mtimeMs) : '')) + '</div></div>' +
          (k.dir ? '<span class="tr-go">' + window.iconHtml('chevron') + '</span>' : '') +
          '</div>').join('') + '</div>'
        : emptyHtml('这个文件夹是空的', '换个文件夹看看，或者点上面的按钮传一个进来。', 'folder'));

    $$('[data-crumb]', host).forEach((b) => { b.onclick = () => { hap(); paintBrowse(host, slug, b.dataset.crumb, nodes); }; });
    $$('.t-row', host).forEach((r) => {
      const k = kids[Number(r.dataset.i)];
      r.onclick = () => {
        hap();
        if (k.dir) paintBrowse(host, slug, k.path, nodes);
        else openFileEditor(host, slug, k.path, nodes);
      };
    });
    $('[data-names]', host).onclick = () => ask('这层的全部路径', names, { multiline: true, host });
    $('[data-newf]', host).onclick = async () => {
      const v = await ask('新建文件（相对路径）', dir, { host, placeholder: dir + '新文件.md' });
      if (!v) return;
      try { await nb('api/workspace-files/create-file', { method: 'POST', body: { projectRoot: slug, path: v } }); toast('建好了'); hap(); fileBrowse(host, slug, dir); }
      catch (e) { toast('建不了：' + e.message); }
    };
    $('[data-newd]', host).onclick = async () => {
      const v = await ask('新建文件夹（相对路径）', dir, { host });
      if (!v) return;
      try { await nb('api/workspace-files/create-directory', { method: 'POST', body: { projectRoot: slug, path: v } }); toast('建好了'); hap(); fileBrowse(host, slug, dir); }
      catch (e) { toast('建不了：' + e.message); }
    };
    $('[data-up]', host).onclick = () => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        const fd = new FormData();
        fd.append('file', f);
        fd.append('projectRoot', slug);
        fd.append('path', dir + f.name);
        loading(host, '上传中…');
        try {
          const r = await fetch(window.API.abs('nb/api/workspace-files/upload-file'), { method: 'POST', body: fd, credentials: 'include' });
          if (!r.ok) throw new Error((await r.text()).slice(0, 120));
          toast('传好了'); hap(); fileBrowse(host, slug, dir);
        } catch (e) { toast('传不上去：' + e.message); fileBrowse(host, slug, dir); }
      };
      inp.click();
    };
  }

  async function openFileEditor(host, slug, path, nodes) {
    loading(host, '打开 ' + path.split('/').pop() + '…');
    let d, raw = null;
    try {
      d = await nb('api/workspace-files/read?' + qs({ projectRoot: slug, path }));
    } catch (e) {
      try {
        const r = await fetch(window.API.abs('nb/api/workspace-files/download?' + qs({ projectRoot: slug, path })), { credentials: 'include' });
        if (!r.ok) throw new Error('读不了这个文件');
        raw = URL.createObjectURL(await r.blob());
      } catch (e2) { failed(host, '这个文件', e, () => fileBrowse(host, slug, path.split('/').slice(0, -1).join('/'))); return; }
    }
    const back = () => fileBrowse(host, slug, path.split('/').slice(0, -1).join('/') + (path.indexOf('/') >= 0 ? '/' : ''));
    if (raw) {
      host.innerHTML = '<div class="t-hint" style="margin:0 0 var(--sp-3)">这是二进制文件（图片之类），改不了，可以下载或删掉。</div>' +
        '<div class="t-bar"><button class="t-btn" data-dl>下载</button>' +
        '<button class="t-btn dan" data-del>删除</button>' +
        '<button class="t-btn" data-back>返回</button></div>';
      $('[data-dl]', host).onclick = () => { const a = document.createElement('a'); a.href = raw; a.download = path.split('/').pop(); a.click(); };
      $('[data-back]', host).onclick = () => { hap(); back(); };
      $('[data-del]', host).onclick = async () => {
        if (!(await confirmBox('删掉 ' + path + '？', true))) return;
        try { await nb('api/workspace-files/delete?' + qs({ projectRoot: slug, path }), { method: 'DELETE', body: { projectRoot: slug, path } }); toast('删了'); hap(); back(); }
        catch (e) { toast('删不掉：' + e.message); }
      };
      return;
    }
    const editable = d.editable !== false;
    const size = (d.content || '').length;
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-2)">' + esc(path) + ' · ' + size + ' 字' +
      (d.mtimeMs ? ' · ' + ago(d.mtimeMs) : '') + (editable ? '' : ' · 只读') + '</div>' +
      (editable ? '<textarea class="t-area mono" spellcheck="false" style="min-height:46vh">' + esc(d.content || '') + '</textarea>'
        : '<div class="t-pre">' + esc(d.content || '') + '</div>') +
      '<div class="t-bar" style="margin-top:var(--sp-3)">' +
      (editable ? '<button class="t-btn pri" data-tsave>保存</button>' : '') +
      '<button class="t-btn" data-rename>改名</button>' +
      '<button class="t-btn" data-download>下载</button>' +
      '<button class="t-btn dan" data-del>删除</button>' +
      '<button class="t-btn" data-back>返回</button>' +
      '</div>';

    const ta = $('.t-area', host);
    if (ta && editable) {
      ta.addEventListener('input', () => {
        const b = $('[data-tsave]', host);
        if (b) { b.textContent = '保存 ●'; b.classList.add('pri'); }
      });
    }
    if (editable) {
      $('[data-tsave]', host).onclick = async () => {
        const btn = $('[data-tsave]', host);
        btn.disabled = true; btn.textContent = '保存中…';
        try {
          // 带着「我打开时它长这样」去存：别处改过就 409，先问人，不许闷头覆盖
          await nb('api/workspace-files/write?' + qs({ projectRoot: slug, path }), {
            method: 'PUT',
            body: { projectRoot: slug, path, content: ta.value, baseContent: d.content },
          });
          toast('存好了'); hap(); btn.textContent = '已保存'; btn.classList.remove('pri');
          setTimeout(() => { btn.disabled = false; }, 500);
        } catch (e) {
          btn.disabled = false; btn.textContent = '保存';
          if (e.offline) {
            window.Offline && Offline.queueWrite(slug, path, ta.value, 0);
            toast('现在没网，先存在本机了；有网会自动推回去');
            return;
          }
          if (e.status === 409) {
            const yes = await confirmBox('这个文件在别处被改过了。载入服务器那版（我这版会丢）？', true);
            if (yes) {
              const fresh = await nb('api/workspace-files/read?' + qs({ projectRoot: slug, path }));
              d.content = fresh.content;
              ta.value = fresh.content || '';
              toast('载入了服务器那版');
            } else {
              toast('那先别存：把你这版复制出去，再载入新的合一下');
            }
            return;
          }
          toast('存不了：' + e.message);
        }
      };
    }
    $('[data-back]', host).onclick = () => { hap(); back(); };
    $('[data-download]', host).onclick = () => {
      const a = document.createElement('a');
      a.href = 'nb/api/workspace-files/download?' + qs({ projectRoot: slug, path });
      a.download = path.split('/').pop();
      a.click();
    };
    $('[data-rename]', host).onclick = async () => {
      const v = await ask('改名叫什么（相对路径）', path, { host });
      if (!v || v === path) return;
      try { await nb('api/workspace-files/rename', { method: 'PATCH', body: { projectRoot: slug, from: path, to: v } }); toast('改好了'); hap(); back(); }
      catch (e) { toast('改不了：' + e.message); }
    };
    $('[data-del]', host).onclick = async () => {
      if (!(await confirmBox('删掉 ' + path + '？', true))) return;
      try { await nb('api/workspace-files/delete?' + qs({ projectRoot: slug, path }), { method: 'DELETE', body: { projectRoot: slug, path } }); toast('删了'); hap(); back(); }
      catch (e) { toast('删不掉：' + e.message); }
    };
  }

  /* ══════════════════════════════════════════════════════════
     2. 封面
     ══════════════════════════════════════════════════════════ */
  function openCover(host) { pushBook('封面', (h, slug) => coverView(h, slug), {}); }

  /* 封面这一屏。**先问再取图**：以前不管有没有封面都直接 <img src=...>，
     没有封面的书（比如新建的）会让浏览器打一条 404 —— 用户看不见，但那是响当当的错误。
     现在先问一遍 projects 有没有封面，没有就画空态，不发那个请求。 */
  async function coverView(host, slug) {
    const url = 'nb/api/projects/cover?' + qs({ projectRoot: slug });
    loading(host, '看封面…');
    let has = false, canDel = false;
    try {
      const d = await API.shelf();                      // /api/shelf 才带 hasCover 这个字段
      const p = (d.projects || []).find((x) => x.slug === slug);
      has = !!(p && p.hasCover);
      canDel = has;
    } catch (e) { failed(host, '封面', e, () => coverView(host, slug)); return; }
    host.innerHTML =
      '<div class="cv-wrap"><div class="cv-box" id="cv-box">' +
      (has
        ? '<img src="' + url + '&_=' + Date.now() + '" alt="">'
        /* 空态带上 data-state：全站三态判据只认这个标记 —— 不然脚本会说
           "封面这屏没有空态"，而用户明明看到了一句「还没有封面」（）。 */
        : '<div class="cv-none" data-state="empty"><div class="cv-none-t">还没有封面</div>'
          + '<div class="cv-none-d">选一张竖版图（3:4 左右最像书），书架上也跟着变。</div></div>') +
      '</div><div class="cv-side">' +
      '<button class="t-btn pri" data-pick>选一张图</button>' +
      (canDel ? '<button class="t-btn dan" data-del>删掉封面</button>' : '') +
      '<div class="t-hint">建议竖版，比例 3:4 左右最像书。上传后书架和合集页都会跟着变。</div>' +
      '</div></div>' +
      '<div class="t-hint">' + esc(bookName(slug)) + '</div>';
    $('[data-pick]', host).onclick = () => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        try { await window.API.coverUpload(slug, f); toast('封面换好了'); hap(); coverView(host, slug); }
        catch (e) { toast('换不了：' + e.message); }
      };
      inp.click();
    };
    const del = $('[data-del]', host);
    if (del) del.onclick = async () => {
      if (!(await confirmBox('删掉这本书的封面？', true))) return;
      try { await nb('api/projects/cover?' + qs({ projectRoot: slug }), { method: 'DELETE' }); toast('删了'); hap(); coverView(host, slug); }
      catch (e) { toast('删不掉：' + e.message); }
    };
  }

  /* ══════════════════════════════════════════════════════════
     3. 记忆（RAG）：AI 记住了什么
     ══════════════════════════════════════════════════════════ */
  function openMemory(host) { pushBook('记忆', (h, slug) => memoryView(h, slug), {}); }

  async function memoryView(host, slug) {
    loading(host, '读记忆库…');
    let ins;
    try { ins = await nb('api/projects/rag/inspector?' + qs({ projectRoot: slug, limit: 200 })); }
    catch (e) { failed(host, '记忆库', e, () => memoryView(host, slug)); return; }
    const subs = ins.subjects || [];
    const emb = ins.embedding || {};
    const idx = ins.index || {};
    host.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + (subs.length || 0) + '</b><span>记忆主体</span></div>' +
      '<div class="t-stat"><b>' + (idx.vectorCount != null ? idx.vectorCount : '—') + '</b><span>向量条目</span></div>' +
      '<div class="t-stat"><b>' + (emb.enabled ? '开' : '关') + '</b><span>语义检索</span></div>' +
      '</div>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">记忆是 AI 自己攒的「这本书已经发生过什么」。改了正文之后让它重建一次，AI 就不会记岔。</div>' +
      '<div class="t-field" style="background:var(--card);border:1px solid var(--line-2);border-radius:var(--radius);padding:var(--sp-3) var(--sp-3);margin-bottom:var(--sp-3)">' +
      '<input class="t-input" id="mem-q" type="search" placeholder="问它一句，比如「主角叫什么」"></div>' +
      '<div class="t-bar">' +
      '<button class="t-btn pri" data-search>找一找</button>' +
      '<button class="t-btn" data-rebuild>重建记忆</button>' +
      '<button class="t-btn" data-debug>体检</button>' +
      '</div>' +
      '<div id="mem-hit"></div>' +
      '<div id="mem-list"></div>' +
      '<div id="mem-out"></div>';

    const list = $('#mem-list', host);
    if (!subs.length) {
      list.innerHTML = emptyHtml('还没有记忆主体', '写到一定量、AI 跑过一轮之后就会自动攒出来。', 'database');
    } else {
      list.innerHTML = '<div class="t-list">' + subs.map((s, i) =>
        '<div class="t-row" data-i="' + i + '">' + ico('database') +
        '<div class="tr-main"><div class="tr-title">' + esc(((s.metadata && s.metadata.name) || s.subjectId || (s.subjectPath || '').replace('simulation/subjects/', '')) ) + '</div>' +
        '<div class="tr-sub">' + esc([((s.metadata && s.metadata.kind) || ''), s.memoryCount != null ? s.memoryCount + ' 条记忆' : '', s.eventCount != null ? s.eventCount + ' 个事件' : ''].filter(Boolean).join(' · ')) + '</div></div>' +
        '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('') + '</div>';
      $$('.t-row', list).forEach((r) => {
        r.onclick = () => {
          hap();
          const s = subs[Number(r.dataset.i)];
          memorySubject(host, slug, s.subjectPath || s.path, (s.metadata && s.metadata.name) || s.subjectId || '');
        };
      });
    }
    // 平台的记忆搜索是**按主体**的（subjectPath + query），没有全书一次搜。
    // 这里有多个主体就依次搜、合并；一个主体都没有就直说，别让用户对着空框发呆。
    $('[data-search]', host).onclick = async () => {
      const q = ($('#mem-q', host).value || '').trim();
      const hit = $('#mem-hit', host);
      if (!q) { hit.innerHTML = ''; return; }
      if (!subs.length) {
        hit.innerHTML = emptyHtml('这本书还没有记忆主体', '先让 AI 写几轮，或点下面的「重建记忆」；有主体之后就能搜了。', 'database');
        return;
      }
      hit.innerHTML = '<div class="t-load"><i></i></div>';
      const found = [];
      for (const s of subs) {
        const sp = s.subjectPath || s.path;
        if (!sp) continue;
        try {
          const r = await nb('api/projects/rag/search?' + qs({ projectRoot: slug }),
            { method: 'POST', body: { subjectPath: sp, query: q, limit: 8 } });
          ((r && r.candidates) || []).forEach((c) => found.push(Object.assign({ _sp: sp }, c)));
        } catch (e) { /* 单个主体搜不动不影响其它的 */ }
      }
      found.sort((a, b) => (a.rank || 99) - (b.rank || 99));
      hit.innerHTML = found.length
        ? '<h2 style="font:600 var(--t-md)/1 var(--ui-font);color:var(--ink-3);margin:var(--sp-3) var(--sp-1) var(--sp-2)">找到 ' + found.length + ' 条</h2><div class="t-list">' +
          found.map((x) => '<div class="t-row static">' + ico('search') +
            '<div class="tr-main"><div class="tr-title" style="white-space:normal;font-weight:var(--w-normal);font-size:var(--t-base);line-height:1.55">' +
            esc(x.text || '') + '</div>' +
            '<div class="tr-sub">' + esc([x._sp.replace('simulation/subjects/', ''), x.topic || '', x.source || '', x.rank ? '第 ' + x.rank + ' 名' : ''].filter(Boolean).join(' · ')) + '</div></div></div>').join('') + '</div>'
        : emptyHtml('没找到相关的记忆', '换个词试试，或者清空搜索框看全部。', 'database');
    };
    const mq = $('#mem-q', host);
    if (mq) mq.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('[data-search]', host).click(); });
    $('[data-rebuild]', host).onclick = async () => {
      if (!(await confirmBox('让 AI 重新读一遍正文、重建全部记忆？跑完之前别关页面。'))) return;
      loading(host, '重建中…（可能要一两分钟）');
      try { const r = await nb('api/projects/rag/rebuild?' + qs({ projectRoot: slug }), { method: 'POST', body: {} }); toast('重建完了'); hap(); memoryView(host, slug); }
      catch (e) { toast('重建失败：' + e.message); memoryView(host, slug); }
    };
    $('[data-debug]', host).onclick = async () => {
      const out = $('#mem-out', host);
      out.innerHTML = '<div class="t-load"><i></i></div>';
      try {
        const r = await nb('api/projects/rag/debug?' + qs({ projectRoot: slug }), { method: 'POST', body: {} });
        out.innerHTML = '<div class="t-pre">' + esc(JSON.stringify(r, null, 2).slice(0, 4000)) + '</div>';
      } catch (e) { out.innerHTML = errHtml('体检没跑成', e); }
    };
  }

  async function memorySubject(host, slug, subjectPath, title) {
    loading(host, '读这个主体的记忆…');
    let d;
    try { d = await nb('api/projects/rag/subject?' + qs({ projectRoot: slug, subjectPath })); }
    catch (e) { failed(host, '这个主体的记忆', e, () => memorySubject(host, slug, subjectPath, title)); return; }
    const mem = d.memories || [];
    const ev = d.events || [];
    const H = (t, n) => '<h2 style="font:600 var(--t-md)/1 var(--ui-font);color:var(--ink-3);margin:var(--sp-4) var(--sp-1) var(--sp-2)">' + t + ' ' + n + '</h2>';

    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-1)">' + esc(title || subjectPath) + '</div>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-3);opacity:.7">' + esc(subjectPath) + '</div>' +

      H('记得的事', mem.length) +
      '<div class="t-list">' + (mem.length ? mem.map((m, i) =>
        '<div class="t-row static">' + ico('database') +
        '<div class="tr-main"><div class="tr-title">' + esc(m.topic || '') + '</div>' +
        '<div class="tr-sub wrap" style="color:var(--ink-2)">' + esc(m.view || '') + '</div>' +
        ((m.aliases && m.aliases.length) ? '<div class="tr-sub">也叫 ' + esc(m.aliases.join('、')) + '</div>' : '') +
        '</div><button class="t-btn sm dan" data-delmem="' + i + '">忘掉</button></div>').join('')
        : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">这个主体还没有记忆条目</div></div></div>') + '</div>' +

      H('发生过的事', ev.length) +
      '<div class="t-list">' + (ev.length ? ev.map((e2) =>
        '<div class="t-row static">' + ico('clock') +
        '<div class="tr-main"><div class="tr-title" style="white-space:normal;font-weight:var(--w-normal);font-size:var(--t-base);line-height:1.55">' +
        esc(e2.text || '') + '</div>' +
        '<div class="tr-sub">' + esc([e2.tick || '', e2.time || ''].filter(Boolean).join(' · ')) + '</div></div></div>').join('')
        : '<div class="t-row static"><div class="tr-main"><div class="tr-sub">还没有事件</div></div></div>') + '</div>' +

      '<div class="t-hint" style="margin-top:var(--sp-4)">「忘掉」只删 AI 的这条记忆，正文一个字都不动。删错了就重建一次记忆。</div>';

    $$('[data-delmem]', host).forEach((b) => {
      b.onclick = async () => {
        const m = mem[Number(b.dataset.delmem)];
        if (!(await confirmBox('让 AI 忘掉「' + (m.topic || '') + '」这件事？'))) return;
        try {
          await nb('api/projects/rag/memories?' + qs({ projectRoot: slug }),
            { method: 'DELETE', body: { subjectPath, topic: m.topic } });
          toast('忘掉了'); hap(); memorySubject(host, slug, subjectPath, title);
        } catch (e) { toast('删不了：' + e.message); }
      };
    });
  }

  /* ══════════════════════════════════════════════════════════
     4. 模型 / 供应商
     ══════════════════════════════════════════════════════════ */
  function openModels(host) { pushBook('模型与供应商', (h) => modelsView(h), { global: true }); }

  async function modelsView(host) {
    loading(host, '读模型库…');
    let lib, tpl, snap;
    try {
      lib = await nb('api/config/models/library');
      tpl = await nb('api/config/models/provider-templates');
    } catch (e) { failed(host, '模型清单', e, () => modelsView(host)); return; }
    const models = (lib && lib.models) || [];
    const templates = (tpl && tpl.templates) || [];
    let provs = {};
    try { const p = await projects(); snap = await nb('api/config/snapshot?' + qs({ projectRoot: p[0] && p[0].projectRoot })); provs = (snap && snap.effective && snap.effective.models && snap.effective.models.providers) || {}; } catch (e) {}
    const provList = Object.entries(provs);

    host.innerHTML =
      '<div class="t-stats">' +
      '<div class="t-stat"><b>' + models.length + '</b><span>可选模型</span></div>' +
      '<div class="t-stat"><b>' + provList.length + '</b><span>已配供应商</span></div>' +
      '<div class="t-stat"><b>' + templates.length + '</b><span>可加供应商</span></div>' +
      '</div>' +
      '<h2 style="font:600 var(--t-md)/1 var(--ui-font);color:var(--ink-3);margin:0 var(--sp-1) var(--sp-2)">连得上吗</h2>' +
      '<div class="t-bar"><button class="t-btn pri" id="mdl-testdef">测一下现在用的模型</button></div>' +
      '<div id="mdl-testres" class="t-hint" style="margin:calc(-1 * var(--sp-2)) 0 var(--sp-4)">发一句话出去，看模型回不回得来。' +
      '连不上会写明原因（密钥不对 / 地址不通 / 模型名写错），不用猜。</div>' +
      '<h2 style="font:600 var(--t-md)/1 var(--ui-font);color:var(--ink-3);margin:0 var(--sp-1) var(--sp-2)">已配好的供应商</h2>' +
      (provList.length
        ? '<div class="t-list">' + provList.map(([k, v]) =>
          '<div class="t-row static">' + ico('cpu') + '<div class="tr-main"><div class="tr-title">' + esc(v.name || k) + '</div>' +
          '<div class="tr-sub">' + esc(k + ' · ' + (v.modelApi || '') + (v.enabled === false ? ' · 已停用' : '')) + '</div></div>' +
          '<span class="t-pill ' + (v.enabled === false ? 'gray' : 'ok') + '">' + (v.enabled === false ? '停用' : '在用') + '</span></div>').join('') + '</div>'
        : emptyHtml('还没有配供应商', '去「设置 · 模型渠道」加一个；加好之后这儿会列出来，也能挨个测连通。', 'cpu')) +
      '<h2 style="font:600 var(--t-md)/1 var(--ui-font);color:var(--ink-3);margin:var(--sp-4) var(--sp-1) var(--sp-2)">模型库</h2>' +
      '<div class="t-field" style="background:var(--card);border:1px solid var(--line-2);border-radius:var(--radius);padding:var(--sp-3) var(--sp-3);margin-bottom:var(--sp-3)">' +
      '<input class="t-input" id="mdl-q" type="search" placeholder="搜模型名，比如 gemini / deepseek"></div>' +
      '<div id="mdl-list"></div>' +
      '<h2 style="font:600 var(--t-md)/1 var(--ui-font);color:var(--ink-3);margin:var(--sp-5) var(--sp-1) var(--sp-2)">模型组（按用途分）</h2>' +
      '<div id="ms-box"></div>';

    const draw = (kw) => {
      const list = $('#mdl-list', host);
      const hit = models.filter((m) => !kw || (m.name + ' ' + m.id).toLowerCase().indexOf(kw.toLowerCase()) >= 0);
      const top = hit.slice(0, 60);
      list.innerHTML = top.length
        ? '<div class="t-list">' + top.map((m) =>
          '<div class="t-row static">' + ico('cpu') + '<div class="tr-main"><div class="tr-title">' + esc(m.name || m.id) + '</div>' +
          '<div class="tr-sub">' + esc([m.source, m.contextWindowTokens ? Math.round(m.contextWindowTokens / 1000) + 'K 上下文' : '', m.reasoning ? '会思考' : ''].filter(Boolean).join(' · ')) + '</div></div>' +
          (m.reasoning ? '<span class="t-pill">思考</span>' : '') +
          '<button class="t-btn sm dim" data-tm="' + esc(m.source + '/' + m.id) + '">测一下</button></div>').join('') + '</div>' +
          (hit.length > 60 ? '<div class="t-hint" style="text-align:center">还有 ' + (hit.length - 60) + ' 个，再输几个字缩小范围</div>' : '')
        /* 分两种"空"：**库里本来就没有** ≠ **搜索没搜到** —— 一句话说错，用户会以为是自己打错了字。 */
        : (models.length
          ? emptyHtml('没找到这个模型', '换个词试试，比如 gemini / deepseek / claude。', 'cpu')
          : emptyHtml('模型库还是空的', '先去「设置 · 模型渠道」把渠道配好；配好之后这儿会列出能用的模型。', 'cpu'));
    };
    draw('');
    $('#mdl-q', host).addEventListener('input', (e) => draw(e.target.value.trim()));
    bindTests(host);
    const defBtn = $('#mdl-testdef', host);
    if (defBtn) defBtn.onclick = async () => {
      await runTest(defBtn, '', $('#mdl-testres', host));
    };
    renderSets(host);
  }

  /* 连通自检（· 接上本来"有接口、界面没入口"的 POST /api/config/models/test）
     为什么要它：用户最想知道的一件事就是"现在这个模型到底通不通"。
     以前只能靠"发一条消息试试"，失败了也看不出是网络、密钥还是模型名的锅。 */
  function bindTests(host) {
    $$('[data-tm]', host).forEach((b) => {
      if (b.__bound) return;
      b.__bound = 1;
      b.onclick = async (ev) => {
        ev.stopPropagation();
        const key = b.getAttribute('data-tm') || '';
        /* 这一行没读到模型 id 就**别发**：后端在 key 为空时会回落到「现在用的那个」，
           那用户以为测的是这一行、其实测的是默认模型 —— 假绿。宁可说一句人话。 */
        if (!key) { toast('这一行没读到模型 id，退出去重进再试'); return; }
        await runTest(b, key, $('#mdl-testres', document));
      };
    });
  }

  function testLine(ok, key, ms, text) {
    return '<div class="t-row static">' + ico(ok ? 'check' : 'close') +
      '<div class="tr-main"><div class="tr-title">' + esc(ok ? ('通了 · ' + (ms / 1000).toFixed(1) + ' 秒') : '连不上') + '</div>' +
      '<div class="tr-sub wrap">' + esc(text) + '</div></div>' +
      '<span class="t-pill ' + (ok ? 'ok' : 'warn') + '">' + esc(key ? String(key).split('/').pop().slice(0, 16) : '现在用的') + '</span></div>';
  }

  async function runTest(btn, key, resBox) {
    if (btn && btn.disabled) return;
    if (btn) { btn.disabled = true; btn.textContent = '测…'; }
    if (resBox) resBox.innerHTML = '<div class="t-load"><i></i><div class="t-hint" style="margin-top:var(--sp-2)">发一句话出去，等它回…</div></div>';
    let r = null, err = '';
    try { r = await nb('api/config/models/test', { method: 'POST', body: { modelKey: key || '' } }); }
    catch (e) { err = e.message || String(e); }
    const ok = !!(r && r.ok);
    const ms = (r && r.ms) || 0;
    if (btn) {
      btn.disabled = false;
      btn.textContent = ok ? '通了' : '重测';
      btn.className = 't-btn sm ' + (ok ? 'dim' : 'dan');
    }
    if (ok) hap();
    const why = ok ? ('它回：' + ((r.reply || '').trim() || '（空）'))
      : (err || (r && r.error) || '不知道原因');
    const hint = !ok && /还没选模型/.test(why)
      ? '还没选模型：在下面模型库点「测一下」试一个，或者在预设里挑一个当默认。' : why;
    if (resBox) resBox.innerHTML = testLine(ok, key, ms, hint);
    toast(ok ? ('通了 · ' + (ms / 1000).toFixed(1) + ' 秒') : ('连不上：' + hint.slice(0, 40)));
    return ok;
  }

  /* ── 模型组：按用途指定模型（规划用大模型、润色用快模型）── */
  const PURPOSE_NAME = { planner: '规划', writer: '写正文', polish: '润色改写', fast: '杂活' };

  async function renderSets(host) {
    const box = $('#ms-box', host || document);
    if (!box) return;
    box.innerHTML = '<div class="t-load"><i></i><div class="t-hint" style="margin-top:var(--sp-3)">读模型组…</div></div>';
    let d;
    try { d = await window.API.modelSets(); }
    catch (e) { box.innerHTML = errHtml('模型组', e); return; }
    const sets = (d && d.sets) || [];
    const active = (d && d.active) || '';
    box.innerHTML =
      '<div class="t-bar"><button class="t-btn pri" data-msnew>新建模型组</button>' +
      (active ? '<button class="t-btn" data-msoff>停用「' + esc(active) + '」</button>' : '') + '</div>' +
      '<div class="t-hint" style="margin:calc(-1 * var(--sp-1)) 0 var(--sp-3)">启用了哪个组，写作/润色/规划就按它指定的模型走；' +
      '没启用时跟以前一样（预设里挑的那个）。</div>' +
      (sets.length
        ? '<div class="t-list">' + sets.map((x, i) => {
          const keys = x.keys || {};
          const sub = Object.keys(PURPOSE_NAME).filter((k) => keys[k])
            .map((k) => PURPOSE_NAME[k] + ' → ' + keys[k].split('/').pop()).join(' · ') || '还是空的';
          return '<div class="t-row" data-set="' + i + '">' + ico('cpu') +
            '<div class="tr-main"><div class="tr-title">' + esc(x.name) + '</div>' +
            '<div class="tr-sub wrap">' + esc(sub) + '</div></div>' +
            (x.name === active ? '<span class="t-pill ok">在用</span>' : '<span class="tr-go">' + window.iconHtml('chevron') + '</span>') +
            '</div>';
        }).join('') + '</div>'
        : emptyHtml('还没有模型组', '建一个即可按用途分配模型，例如规划用大模型、润色用便宜的。', 'sliders'));

    $$('[data-set]', box).forEach((r) => {
      r.onclick = () => { hap(); const x = sets[Number(r.dataset.set)]; push('模型组 · ' + x.name, (h) => modelSetEdit(h, x)); };
    });
    const nbBtn = $('[data-msnew]', box);
    if (nbBtn) nbBtn.onclick = async () => {
      const name = await ask('模型组叫什么', '', { placeholder: '例：省钱的组合', host: host });
      if (!name) return;
      push('模型组 · ' + name, (h) => modelSetEdit(h, { name: name, keys: {} }));
    };
    const offBtn = $('[data-msoff]', box);
    if (offBtn) offBtn.onclick = async () => {
      try { await window.API.modelSetActivate(''); toast('停用了，回到预设里挑的模型'); hap(); renderSets(host); }
      catch (e) { toast('停不了：' + e.message); }
    };
  }

  async function modelSetEdit(host, set) {
    const members = Object.assign({}, set.keys || {});
    const draft = { note: set.note || '' };
    let lib = [];
    try { const d = await nb('api/models'); lib = (d && d.models) || []; } catch (e) {}
    const paintSet = () => {
      host.innerHTML =
        '<div class="t-hint" style="margin:0 0 var(--sp-3)">给每个用途挑一个模型。挑完点保存；想让这套生效，' +
        '点「启用这个组」——启用后它会盖过预设里挑的模型。</div>' +
        '<div class="t-list">' + Object.keys(PURPOSE_NAME).map((k) =>
          '<div class="t-row" data-p="' + k + '">' + ico('cpu') +
          '<div class="tr-main"><div class="tr-title">' + PURPOSE_NAME[k] + '</div>' +
          '<div class="tr-sub">' + esc(members[k] || '点一下挑一个模型') + '</div></div>' +
          (members[k] ? '<span class="t-pill gray">' + esc(String(members[k]).split('/').pop().slice(0, 14)) + '</span>'
                      : '<span class="tr-go">' + window.iconHtml('chevron') + '</span>') + '</div>').join('') + '</div>' +
        '<div class="t-bar" style="margin-top:var(--sp-4)"><button class="t-btn pri" data-save>保存</button>' +
        '<button class="t-btn" data-act>' + (set.name === (window.__activeSet || '') ? '正在用' : '启用这个组') + '</button></div>' +
        (set.id ? '<div class="t-bar"><button class="t-btn dan" data-del>删掉这个组</button></div>' : '');
      $$('[data-p]', host).forEach((r) => {
        r.onclick = async () => {
          hap();
          const cur = members[r.dataset.p] || '';
          const picked = await pickModel('给「' + PURPOSE_NAME[r.dataset.p] + '」挑模型', cur, lib);
          if (picked === null) return;
          if (picked === '') delete members[r.dataset.p]; else members[r.dataset.p] = picked;
          paintSet();
        };
      });
      $('[data-save]', host).onclick = async () => {
        try {
          const r = await window.API.modelSetSave(set.name, members, draft.note);
          set.id = (r && r.detail && r.detail.id) || set.id || 1; set.keys = Object.assign({}, members);
          toast('存好了'); hap(); paintSet();
        } catch (e) { toast('存不了：' + e.message); }
      };
      $('[data-act]', host).onclick = async () => {
        try {
          const d = await window.API.modelSets();
          window.__activeSet = (d && d.active) || '';
          if (window.__activeSet === set.name) { await window.API.modelSetActivate(''); toast('停用了'); }
          else { await window.API.modelSetActivate(set.name); toast('启用了：' + set.name); }
          hap(); paintSet();
        } catch (e) { toast('启用不了：' + e.message); }
      };
      const del = $('[data-del]', host);
      if (del) del.onclick = async () => {
        if (!(await confirmBox('删掉模型组「' + set.name + '」？', true))) return;
        try { await window.API.modelSetDelete(set.name); toast('删了'); back(); }
        catch (e) { toast('删不了：' + e.message); }
      };
    };
    try { const d = await window.API.modelSets(); window.__activeSet = (d && d.active) || ''; } catch (e) {}
    paintSet();
  }

  /* 挑模型：从真实模型库里选（key 就是「组名/模型id」，模型组存的就是它） */
  function pickModel(title, current, lib) {
    return new Promise((res) => {
      let done = false;
      const finish = (v) => { if (done) return; done = true; res(v); };
      App.sheet('<div class="sheet-head"><h3>' + esc(title) + '</h3><button class="btn sm" data-close>关闭</button></div>' +
        '<div class="t-field" style="margin:0 var(--sp-4) var(--sp-3);background:var(--card)">' +
        '<input class="t-input" id="pm-q" type="search" placeholder="搜模型名，比如 gemini / deepseek"></div>' +
        '<div class="pk-list"><div class="t-list" id="pm-list"></div></div>');
      const panel = document.getElementById('sheet-panel');
      panel.addEventListener('click', (e) => {
        if (e.target.closest('[data-close]')) finish(null);
      });
      const list = $('#pm-list', panel);
      const drawPm = (kw) => {
        const hit = lib.filter((m) => !kw || (m.name + ' ' + m.key).toLowerCase().indexOf(kw.toLowerCase()) >= 0).slice(0, 80);
        list.innerHTML = (current ? '<div class="t-row" data-k="" data-clear="1">' + ico('close') +
          '<div class="tr-main"><div class="tr-title">不指定</div><div class="tr-sub">这个用途跟着下一层走</div></div></div>' : '') +
          (hit.length ? hit.map((m) => '<div class="t-row" data-k="' + esc(m.key) + '">' + ico('cpu') +
            '<div class="tr-main"><div class="tr-title">' + esc(m.name || m.key) + '</div>' +
            '<div class="tr-sub">' + esc([m.provider, m.key].filter(Boolean).join(' · ')) + '</div></div>' +
            (m.key === current ? '<span class="t-pill ok">当前</span>' : '') + '</div>').join('')
            : emptyHtml('没找到', '换个词试试。', 'cpu'));
        $$('[data-k]', list).forEach((r) => {
          r.onclick = () => { hap(); App.closeSheet(); finish(r.dataset.clear ? '' : r.dataset.k); };
        });
      };
      drawPm('');
      $('#pm-q', panel).addEventListener('input', (e) => drawPm(e.target.value.trim()));
    });
  }

  /* ── 后台任务：盯着跑，进度和每一步的结果都摊开 ── */
  function watchJob(jid, onTick, onDone) {
    let stop = false;
    App.keepAlive && App.keepAlive(true);
    const tick = async () => {
      if (stop) return;
      let d = null, err = null;
      try { d = await window.API.jobDetail(jid); } catch (e) { err = e; }
      if (err) { stop = true; App.keepAlive && App.keepAlive(false); onDone && onDone(null, err); return; }
      onTick && onTick(d);
      if (d && ['done', 'failed', 'canceled'].indexOf(d.status) >= 0) {
        stop = true; App.keepAlive && App.keepAlive(false); onDone && onDone(d); return;
      }
      // 暂停时不用那么勤地问（省电），继续跑起来再回到 1.5 秒一问
      setTimeout(tick, d && d.status === 'paused' ? 4000 : 1500);
    };
    tick();
    return () => { stop = true; App.keepAlive && App.keepAlive(false); };
  }

  /* 把一条后台任务的进度画在一块区域里（流水线、批量都用它）。
     按钮自己就能用：暂停 / 继续 / 停 / 刷新，都在这里接好，省得每个面板各接一遍。 */
  function paintJob(box, d, opts) {
    opts = opts || {};
    const st = (d && d.status) || 'running';
    const name = { running: '正在跑', paused: '暂停中', done: '跑完了', failed: '有地方出错了',
                   canceled: '停了' }[st] || st;
    const steps = (d && d.steps) || [];
    const jid = (d && d.jobId) || opts.jobId || '';
    box.innerHTML =
      '<h2 class="st-h">' + esc((d && d.title) || '后台任务') + '</h2>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-2)">' + esc(name) + ' · ' + (d ? d.progress : 0) + '%</div>' +
      '<div class="t-bar"><button class="t-btn" data-refresh>刷新</button>' +
      (st === 'running' ? '<button class="t-btn" data-pause>暂停</button>' : '') +
      (st === 'paused' ? '<button class="t-btn" data-resume>继续</button>' : '') +
      (st === 'running' || st === 'paused' ? '<button class="t-btn dan" data-stop>停</button>' : '') + '</div>' +
      (steps.length ? '<div class="t-list">' + steps.map((x) => {
        const bad = !!x.error;
        const sub = bad ? x.error
          : [x.kind, x.words ? x.words + ' 字' : '', x.issues != null ? '命中 ' + x.issues : '',
             x.score != null ? '成绩 ' + x.score : '', x.applied ? '已记进「改动」' : '',
             x.outlineId ? '细纲待确认' : ''].filter(Boolean).join(' · ');
        return '<div class="t-row static">' + ico(bad ? 'close' : 'check') +
          '<div class="tr-main"><div class="tr-title">' + esc(stepName(x.kind)) + ' · ' + esc(String(x.path || '').split('/').pop()) + '</div>' +
          '<div class="tr-sub wrap">' + esc(sub) + '</div></div></div>';
      }).join('') + '</div>' : '') +
      ((d && d.error) ? '<div class="t-hint" style="color:var(--danger)">' + esc(d.error) + '</div>' : '');
    const call = (act, word) => async () => {
      try {
        await nb('api/agent/jobs/' + jid + '/' + act, { method: 'POST', body: {} });
        toast(word); hap();
      } catch (e) { toast(word + '不了：' + e.message); }
      await repaint();
    };
    const repaint = async () => {
      if (opts.onTick) { opts.onTick(); return; }
      try { paintJob(box, await window.API.jobDetail(jid), opts); } catch (e) {}
    };
    const wire = (sel, fn) => { const b = $(sel, box); if (b) b.onclick = fn; };
    wire('[data-refresh]', repaint);
    wire('[data-pause]', call('pause', '暂停了'));
    wire('[data-resume]', call('resume', '接着跑'));
    wire('[data-stop]', async () => {
      try { await nb('api/agent/jobs/' + jid + '/cancel', { method: 'POST', body: {} }); toast('停了'); }
      catch (e) { toast('停不了：' + e.message); }
      await repaint();
    });
    return box;
  }
  const stepName = (k) => ({ outline: '写细纲', write: '写正文', continue: '续写', polish: '润色',
                             summary: '写摘要', lint: '质检' }[k] || k || '一步');

  /* ── 同步冲突：两边都改过，让用户挑一版 ── */
  function conflictAsk(info) {
    return new Promise((res) => {
      const local = info.localText != null ? info.localText : (info.content || '');
      const server = info.serverText || '';
      const pick = (v) => { App.closeSheet(); res(v); };
      const block = (t) => '<div class="t-pre selectable" style="max-height:34vh;overflow:auto">' + esc(t || '（空）') + '</div>';
      App.sheet(
        '<div class="sheet-head"><h3>这一章两边都改过</h3><button class="btn sm" data-close>关闭</button></div>' +
        '<div style="padding:0 var(--sp-4) calc(var(--safe-b) + var(--sp-4))">' +
        '<div class="t-hint" style="margin:0 0 var(--sp-3)">两份都留着，没动你的稿子。挑一版，' +
        '挑完仍然能从「改动 → 历史」里找回另一版。</div>' +
        '<h2 class="st-h">我这版（' + local.length + ' 字）</h2>' + block(local) +
        '<h2 class="st-h">服务器那版（' + server.length + ' 字）</h2>' + block(server) +
        '<div class="t-bar" style="margin-top:var(--sp-4)"><button class="t-btn pri" data-my>用我的这版</button>' +
        '<button class="t-btn" data-sv>用服务器那版</button></div>' +
        '<div class="t-bar"><button class="t-btn" data-merge>我自己合并一版</button></div></div>');
      const panel = document.getElementById('sheet-panel');
      panel.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) res(null); });
      $('[data-my]', panel).onclick = () => pick('local');
      $('[data-sv]', panel).onclick = () => pick('server');
      $('[data-merge]', panel).onclick = async () => {
        const text = await ask('合并后的正文（服务器那版已经填好，改了再存）', server,
                               { multiline: true, host: panel });
        if (text === null) return;
        App.sheet('<div class="sheet-head"><h3>这一章两边都改过</h3><button class="btn sm" data-close>关闭</button></div>' +
          '<div style="padding:0 var(--sp-4) var(--sp-5)"><div class="t-hint">这份合并稿会被存进去。</div>' +
          block(text) + '<div class="t-bar" style="margin-top:var(--sp-3)"><button class="t-btn pri" data-ok>就存这份</button></div></div>');
        const p2 = document.getElementById('sheet-panel');
        p2.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) res(null); });
        $('[data-ok]', p2).onclick = () => pick({ merged: text });
      };
    });
  }

  /* 把冲突处理的结果落到服务器上 */
  async function conflictResolve(info, choice) {
    if (!info || !info.id) return null;
    const body = { id: info.id };
    if (choice && choice.merged != null) { body.choice = 'merged'; body.text = choice.merged; }
    else body.choice = choice;
    return window.API.syncResolve(body);
  }

  /* ══════════════════════════════════════════════════════════
     5. 档案（预设人格）
     ══════════════════════════════════════════════════════════ */
  function openProfiles(host) { pushBook('Agent 档案', (h) => profilesView(h), { global: true }); }

  async function profilesView(host) {
    loading(host, '读档案…');
    let cat, bs;
    try { cat = await nb('api/agent/profiles/catalog'); }
    catch (e) { failed(host, 'Agent 档案', e, () => profilesView(host)); return; }
    try { bs = await nb('api/agent/profiles/build-status'); } catch (e) {}
    const list = Array.isArray(cat) ? cat : (cat.profiles || []);
    const state = {};
    ((bs && bs.profiles) || []).forEach((p) => { state[p.profileKey] = p; });
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">档案决定这个岗位由谁来做：写作、剧情、设定各有独立的人格与权限。</div>' +
      '<div class="t-bar"><button class="t-btn" data-compile>重新编译全部</button></div>' +
      (list.length ? '' : emptyHtml('还没有可用的档案',
        '内置档案本该是有的；一个都没有，就点上面「重新编译全部」。', 'briefcase')) +
      '<div class="t-list">' + list.map((p, i) => {
        const st = state[p.profileKey] || {};
        const bad = st.loadStatus && st.loadStatus !== 'loaded';
        return '<div class="t-row" data-i="' + i + '">' + ico('briefcase') +
          '<div class="tr-main"><div class="tr-title">' + esc(p.name || p.profileKey) + '</div>' +
          '<div class="tr-sub wrap">' + esc(p.description || p.fileName || '') + '</div></div>' +
          '<span class="t-pill ' + (bad ? 'warn' : 'gray') + '">' + esc(p.source === 'install' ? '内置' : (p.source || '')) + '</span></div>';
      }).join('') + '</div>';
    $$('[data-i]', host).forEach((r) => {
      r.onclick = () => { hap(); profileDetail(host, list[Number(r.dataset.i)]); };
    });
    $('[data-compile]', host).onclick = async () => {
      loading(host, '编译中…');
      try { await nb('api/agent/profiles/compile-all', { method: 'POST', body: {} }); toast('编译完了'); hap(); profilesView(host); }
      catch (e) { toast('编译失败：' + e.message); profilesView(host); }
    };
  }

  async function profileDetail(host, p) {
    loading(host, '读源码…');
    /* 这个接口要的是 fileName，不是 profileKey —— 传错会 400。 */
    let r = null, err = '';
    try { r = await nb('api/agent/profiles/source', { method: 'POST', body: { fileName: p.fileName } }); }
    catch (e) { err = e.message; }
    if (!r) { failed(host, '这个档案的源码', { message: err }, () => profilesView(host)); return; }
    const tools = r.toolKeys || [];
    const c = r.catalogItem || {};
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-1)">' + esc(p.name || p.profileKey) + ' · ' + esc(p.fileName || '') + '</div>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">' + esc(c.description || p.description || '') + '</div>' +
      (tools.length ? '<h2 style="font:600 var(--t-md)/1 var(--ui-font);color:var(--ink-3);margin:0 var(--sp-1) var(--sp-2)">它会用到的工具 ' + tools.length + '</h2>' +
        '<div class="t-chips">' + tools.map((t) => '<span class="t-pill gray">' + esc(t) + '</span>').join('') + '</div>' : '') +
      '<h2 style="font:600 var(--t-md)/1 var(--ui-font);color:var(--ink-3);margin:var(--sp-4) var(--sp-1) var(--sp-2)">源码</h2>' +
      '<div class="t-pre">' + esc((r.source || '').slice(0, 8000)) + '</div>';
  }

  /* ══════════════════════════════════════════════════════════
     6. 技能
     ══════════════════════════════════════════════════════════ */
  function openSkills(host) { pushBook('技能', (h) => skillsView(h), { global: true }); }

  async function skillsView(host) {
    loading(host, '读技能…');
    let list;
    try { list = await nb('api/agent/skills'); }
    catch (e) { failed(host, '技能清单', e, () => skillsView(host)); return; }
    list = Array.isArray(list) ? list : (list.skills || []);
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">技能是 AI 干活的说明书：写正文、查设定、读文件，都靠它。</div>' +
      (list.length ? '' : emptyHtml('还没有技能',
        '技能是 AI 干活的说明书，装好之后这儿会列出来。', 'spark')) +
      '<div class="t-list">' + list.map((s) => {
        const p = s.path || (s.skillPath || '');
        return '<div class="t-row' + (p ? '' : ' static') + '"' + (p ? ' data-p="' + esc(p) + '"' : '') + '>' +
          ico('spark') + '<div class="tr-main"><div class="tr-title">' + esc(s.name || p) + '</div>' +
          '<div class="tr-sub wrap">' + esc(s.description || '') + '</div></div></div>';
      }).join('') + '</div>';
    $$('[data-p]', host).forEach((r) => {
      r.onclick = async () => {
        hap();
        try {
          const d = await nb('api/workspace-files/read?' + qs({ workspaceKind: 'user-assets', path: r.dataset.p }));
          App.sheet('<div class="sheet-head"><h3>' + esc(r.dataset.p.split('/').pop()) + '</h3><button class="btn sm" data-close>关闭</button></div>' +
            '<div style="padding:var(--sp-4)"><div class="t-pre" style="max-height:56vh">' + esc((d.content || '').slice(0, 8000)) + '</div></div>', { tall: true });
        } catch (e) { toast('读不到：' + e.message); }
      };
    });
  }

  /* ══════════════════════════════════════════════════════════
     7. 任务（后台跑着的活）
     ══════════════════════════════════════════════════════════ */
  function openJobs(host) { pushBook('后台任务', (h) => jobsView(h), { global: true }); }

  async function jobsView(host) {
    loading(host, '读任务…');
    let d;
    try { d = await nb('api/agent/jobs'); }
    catch (e) { failed(host, '后台任务', e, () => jobsView(host)); return; }
    const jobs = (d && d.jobs) || [];
    host.innerHTML =
      '<div class="t-bar"><button class="t-btn" data-clear>清掉已完成</button><button class="t-btn" data-refresh>刷新</button></div>' +
      (jobs.length
        ? '<div class="t-list">' + jobs.map((j, i) =>
          '<div class="t-row static">' + ico(j.status === 'running' ? 'clock' : (j.status === 'failed' ? 'close' : 'check')) +
          '<div class="tr-main"><div class="tr-title">' + esc(j.title || j.kind || j.jobId) + '</div>' +
          '<div class="tr-sub">' + esc([j.status, j.progress != null ? j.progress + '%' : '', j.updatedAt ? ago(j.updatedAt) : ''].filter(Boolean).join(' · ')) + '</div></div>' +
          (j.status === 'running' ? '<button class="t-btn sm dan" data-cancel="' + esc(j.jobId) + '">停</button>' : '') + '</div>').join('') + '</div>'
        : emptyHtml('没有正在跑的任务',
          'AI 干重活（编译、重建记忆）的时候这儿会有动静。', 'clock'));
    $$('[data-cancel]', host).forEach((b) => {
      b.onclick = async () => {
        try { await nb('api/agent/jobs/' + b.dataset.cancel + '/cancel', { method: 'POST', body: {} }); toast('停了'); hap(); jobsView(host); }
        catch (e) { toast('停不了：' + e.message); }
      };
    });
    $('[data-clear]', host).onclick = async () => {
      try { await nb('api/agent/jobs/clear-finished', { method: 'POST', body: {} }); toast('清完了'); jobsView(host); }
      catch (e) { toast('清不了：' + e.message); }
    };
    $('[data-refresh]', host).onclick = () => jobsView(host);
  }

  /* ══════════════════════════════════════════════════════════
     8. 改动（AI 改过的文件，能收能退）
     ══════════════════════════════════════════════════════════ */
  function openHistory(host) { pushBook('改动', (h, slug) => historyView(h, slug), {}); }

  async function historyView(host, slug) {
    loading(host, '读改动…');
    let d;
    try { d = await nb('api/workspace-history/inbox?' + qs({ projectRoot: slug })); }
    catch (e) { failed(host, '改动列表', e, () => historyView(host, slug)); return; }
    const groups = (d && d.groups) || [];
    host.innerHTML =
      (groups.length ? '' : emptyHtml('没有待处理的改动',
        'AI 动过文件之后会在这儿列出来，同意或退回都由你定。', 'save')) +
      '<div class="t-list">' + groups.map((g, i) => {
        const n = (g.entries || []).length;
        return '<div class="t-row" data-i="' + i + '">' + ico('history') +
          '<div class="tr-main"><div class="tr-title">' + esc(g.path) + '</div>' +
          '<div class="tr-sub">' + n + ' 处改动 · ' + esc((g.entries && g.entries[0] && g.entries[0].actorKind) || '') + '</div></div>' +
          '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>';
      }).join('') + '</div>' +
      (groups.length ? '<div class="t-bar"><button class="t-btn pri" data-all>全部接受</button></div>' : '');
    $$('[data-i]', host).forEach((r) => {
      r.onclick = () => { hap(); diffView(host, slug, groups[Number(r.dataset.i)]); };
    });
    const all = $('[data-all]', host);
    if (all) all.onclick = async () => {
      if (!(await confirmBox('把 ' + groups.length + ' 个文件的改动全部接受？'))) return;
      try { await nb('api/workspace-history/accept-all', { method: 'POST', body: { projectRoot: slug } }); toast('全收了'); hap(); historyView(host, slug); }
      catch (e) { toast('收不了：' + e.message); }
    };
  }

  async function diffView(host, slug, g) {
    loading(host, '读差异…');
    let d = null;
    try { d = await nb('api/workspace-history/diff?' + qs({ projectRoot: slug, path: g.path })); } catch (e) {}
    const raw = d ? (d.diff || d.patch || d.text || JSON.stringify(d, null, 2)) : '(读不到差异内容)';
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">' + esc(g.path) + '</div>' +
      '<div class="t-pre">' + esc(String(raw).slice(0, 8000)) + '</div>' +
      '<div class="t-list">' + (g.entries || []).map((en) =>
        '<div class="t-row static">' + ico('dot') + '<div class="tr-main"><div class="tr-title">#' + esc(en.id) + ' · ' + esc(en.actorKind || '') + '</div>' +
        '<div class="tr-sub">' + esc(ago(en.occurredAt)) + '</div></div></div>').join('') + '</div>' +
      '<div class="t-bar">' +
      '<button class="t-btn pri" data-acc>接受</button>' +
      '<button class="t-btn dan" data-rev>退回</button>' +
      '</div>';
    $('[data-acc]', host).onclick = async () => {
      try { await nb('api/workspace-history/accept', { method: 'POST', body: { projectRoot: slug, path: g.path, revision: g.revision } }); toast('收了'); hap(); historyView(host, slug); }
      catch (e) { toast('收不了：' + e.message); }
    };
    $('[data-rev]', host).onclick = async () => {
      if (!(await confirmBox('把这个文件退回改动之前？', true))) return;
      try { await nb('api/workspace-history/revert', { method: 'POST', body: { projectRoot: slug, path: g.path, revision: g.revision } }); toast('退了'); hap(); historyView(host, slug); }
      catch (e) { toast('退不了：' + e.message); }
    };
  }

  /* ══════════════════════════════════════════════════════════
     8.5 笔记：读书时想到什么就记下来（可带摘录），跟书签分工
     ══════════════════════════════════════════════════════════ */
  function openNotes(host) {
    pushBook('笔记', (h, slug) => notesView(h, slug), {});
  }

  async function notesView(host, slug, q) {
    if (q === undefined) q = '';
    loading(host, '读笔记…');
    let d;
    try { d = await window.API.notes(slug, q); }
    catch (e) { failed(host, '笔记', e, () => notesView(host, slug, q)); return; }
    const items = (d && d.items) || [];
    host.innerHTML =
      '<div class="t-bar"><button class="t-btn pri" data-new>写一条</button>' +
      '<button class="t-btn" data-reload>刷新</button></div>' +
      '<div class="t-field" style="background:var(--card);border:1px solid var(--line-2);' +
      'border-radius:var(--radius);padding:12px 12px;margin-bottom:12px">' +
      '<input class="t-input" data-q type="search" placeholder="搜笔记（正文、摘录、章节名都行）" value="' + esc(q) + '"></div>' +
      '<div class="t-hint" style="margin:calc(-1 * var(--sp-1)) 0 var(--sp-3)">共 ' + ((d && d.total) || 0) + ' 条' +
      (q ? '（搜「' + esc(q) + '」）' : '') + '。笔记跟着书走，换设备也在。</div>' +
      (items.length
        ? '<div class="t-list">' + items.map((n, i) =>
          '<div class="t-row" data-i="' + i + '">' + ico('note') +
          '<div class="tr-main"><div class="tr-title">' + esc((n.text || '').slice(0, 40) || '（只有摘录）') + '</div>' +
          '<div class="tr-sub wrap">' + esc([String(n.path || '').split('/').pop(), n.quote ? '「' + n.quote.slice(0, 24) + '」' : '', ago(n.createdAt)].filter(Boolean).join(' · ')) + '</div></div>' +
          '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('') + '</div>'
        : (q ? emptyHtml('没搜到笔记', '换个词试试，或者清空搜索框看全部。', 'note')
          : emptyHtml('还没有笔记', '看正文时选中一段就能存一条，点「写一条」也行。', 'note'))) +
      '<div data-item></div>';

    const itemBox = $('[data-item]', host);
    $$('[data-i]', host).forEach((r) => {
      r.onclick = () => { hap(); noteDetail(itemBox, slug, items[Number(r.dataset.i)]); };
    });
    $('[data-new]', host).onclick = async () => {
      const text = await ask('记一笔', '', { multiline: true, placeholder: '想到了什么？', host: host });
      if (text === null) return;
      try { await window.API.noteSave({ slug: slug, text: text }); toast('记下了'); hap(); notesView(host, slug, q); }
      catch (e) { toast('记不了：' + e.message); }
    };
    $('[data-reload]', host).onclick = () => notesView(host, slug, q);
    let timer = null;
    $('[data-q]', host).addEventListener('input', (e) => {
      clearTimeout(timer);
      const v = e.target.value.trim();
      timer = setTimeout(() => notesView(host, slug, v), 320);
    });
  }

  function noteDetail(box, slug, n) {
    box.innerHTML =
      '<div class="t-list" style="margin-top:var(--sp-4)">' +
      '<div class="t-row static"><div class="tr-main"><div class="tr-title">这一条</div>' +
      '<div class="tr-sub wrap">' + esc([String(n.path || '').split('/').pop() || '没挂具体章节', ago(n.createdAt)].filter(Boolean).join(' · ')) + '</div></div></div></div>' +
      (n.quote ? '<h2 class="st-h">摘录</h2><div class="t-pre">' + esc(n.quote) + '</div>' : '') +
      '<h2 class="st-h">我写的</h2><div class="t-pre selectable">' + esc(n.text || '（空）') + '</div>' +
      '<div class="t-bar"><button class="t-btn" data-edit>改</button>' +
      '<button class="t-btn dan" data-del>删掉</button></div>';
    $('[data-edit]', box).onclick = async () => {
      const t = await ask('改这条笔记', n.text || '', { multiline: true, host: box });
      if (t === null) return;
      try { await window.API.noteSave({ slug: slug, id: n.id, text: t }); toast('改好了'); hap(); box.innerHTML = ''; App.show('tool'); }
      catch (e) { toast('改不了：' + e.message); }
    };
    $('[data-del]', box).onclick = async () => {
      if (!(await confirmBox('删掉这条笔记？（会先在数据目录里留一份）', true))) return;
      try { await window.API.noteDelete(slug, n.id); toast('删了'); hap(); box.innerHTML = ''; App.show('tool'); }
      catch (e) { toast('删不了：' + e.message); }
    };
  }

  /* ══════════════════════════════════════════════════════════
     8.6 同步：离线攒下的改动推回来 + 两边都改过的挑一版
     ══════════════════════════════════════════════════════════ */
  function openSync(host) { pushBook('同步', (h) => syncView(h), { global: true }); }

  /* ── 跟服务器对账（GOAL C2）──────────────────────────────────────────────
     位置很要紧：App 把整份后端装在手机里，所以"跟服务器同步"是**手机上的后端**去跟服务器说话，
     前端只需要点一个按钮。口令只在这条请求里传一次，**不写进任何文件**（只记地址，方便下次少打几个字）。 */
  function wirePeer(host) {
    const box = $('[data-peer]', host);
    if (!box) return;
    const baseEl = $('[data-peer-base]', host);
    const passEl = $('[data-peer-pass]', host);
    const bookEl = $('[data-peer-book]', host);
    const tipEl = $('[data-peer-tip]', host);
    baseEl.value = Prefs.get('peerBase') || '';
    /* 边打边记：换了书面板会重渲染，不记的话刚打进去的地址会被抹掉（真踩过） */
    baseEl.oninput = () => Prefs.set('peerBase', baseEl.value.trim());
    passEl.value = _peerPass;
    passEl.oninput = () => { _peerPass = passEl.value; };
    const say = (t, kind) => { tipEl.textContent = t; tipEl.style.color = kind === 'bad' ? 'var(--danger)' : 'var(--ink-3)'; };
    const run = async (direction) => {
      const base = (baseEl.value || '').trim();
      if (!base) { say('先把服务器地址填上（比如 192.168.1.9:8899）', 'bad'); hap(); return; }
      Prefs.set('peerBase', base);
      say('正在跟服务器对账…');
      try {
        const d = await window.API.peerSync({
          slug: bookEl.value, base, password: passEl.value || '', direction });
        const pull = d.pull || {}, push = d.push || {};
        const bits = [];
        if (pull.pulled) bits.push('拉下 ' + pull.pulled + ' 章');
        if (push.pushed) bits.push('推上 ' + push.pushed + ' 章');
        if (pull.conflicts) bits.push(pull.conflicts + ' 条冲突（拉）');
        if (push.conflicts) bits.push(push.conflicts + ' 条冲突（推）');
        say(bits.length ? '好了：' + bits.join('，') : '没有要换的东西，两边一样',
            d.conflicts ? 'bad' : '');
        hap();
        syncView(host);
      } catch (e) {
        say('同步不了：' + (e.message || e), 'bad');
      }
    };
    $('[data-peer-pull]', host).onclick = () => run('pull');
    $('[data-peer-push]', host).onclick = () => run('push');
    $('[data-peer-both]', host).onclick = () => run('both');
  }


  /* 「手机上还没有这本书」也能同步：问一句书名/书号 → 本机后端照服务器那本建一本再拉。
     这条是**新手机第一次用**的正路（本地下拉框里当然没有它），所以必须走这个入口。 */
  async function pullNew(host) {
    const name = await ask('从服务器拉一本新的', '', { ok: '拉下来', placeholder: '书名，或服务器上的书号' });
    if (!name || !name.trim()) { syncView(host); return; }
    const baseEl = $('[data-peer-base]', host);
    const tipEl = $('[data-peer-tip]', host);
    const say = (t, bad) => { if (tipEl) { tipEl.textContent = t; tipEl.style.color = bad ? 'var(--danger)' : 'var(--ink-3)'; } };
    if (!baseEl || !(baseEl.value || '').trim()) { say('先把服务器地址填上（比如 192.168.1.9:8899）', 1); hap(); return; }
    say('正在从服务器找这本书…');
    try {
      const d = await window.API.peerSync({
        slug: name.trim(), base: baseEl.value.trim(),
        password: ($('[data-peer-pass]', host) || {}).value || '', direction: 'pull' });
      Prefs.set('peerBook', d.slug);
      const pl = d.pull || {};
      /* 提示用 toast（面板马上会重渲染，写在提示行里会被"上次同步：…"覆盖掉，
         用户就看不到"到底拉下来没有"） */
      toast('把《' + name.trim() + '》拉到本机了' + ((pl.pulled || 0) ? '：' + pl.pulled + ' 章' : ''));
      hap(); syncView(host);
    } catch (e) {
      say('同步不了：' + (e.message || e), 1);
    }
  }

  async function syncView(host) {
    loading(host, '看同步状态…');
    let st = { openConflicts: 0 }, items = [];
    let pending = window.Offline ? Offline.pendingWrites() : [];
    try {
      const d = await window.API.syncConflicts('');
      items = (d && d.items) || [];
      st = { openConflicts: (d && d.total) || 0 };
    } catch (e) { failed(host, '离线冲突', e, () => syncView(host)); return; }
    /* 书目下拉：跟服务器对账是**按书**来的 */
    let books = [];
    try { books = await projects(true); } catch (e) { books = []; }
    const curBook = Prefs.get('peerBook') || (books[0] && books[0].projectRoot) || '';
    let peer = { last_time: 0, last_result: '' };
    if (curBook) { try { peer = await window.API.peerState(curBook); } catch (e) {} }
    const peerWhen = peer.last_time
      ? new Date(peer.last_time).toLocaleString('zh-CN', { hour12: false }).slice(5, 16) : '';
    host.innerHTML =
      '<h2 class="st-h">跟服务器对账</h2>' +
      '<div class="t-field" data-peer>' +
        '<input class="t-input" data-peer-base type="text" placeholder="服务器地址，例如 192.168.1.9:8899">' +
        '<input class="t-input" data-peer-pass type="password" placeholder="服务器登录口令（只在这一次请求里用，不存）">' +
        '<select class="t-input" data-peer-book>' + (books.length
          ? books.map((b) => '<option value="' + esc(b.projectRoot) + '"' +
              (b.projectRoot === curBook ? ' selected' : '') + '>' + esc(b.title) + '</option>').join('')
          : '<option value="">（书架上还没有书）</option>') +
          '<option value="__new__">＋ 从服务器拉一本新的…</option></select>' +
        '<div class="t-bar"><button class="t-btn pri" data-peer-both>双向对一次</button>' +
        '<button class="t-btn" data-peer-pull>只拉下来</button>' +
        '<button class="t-btn" data-peer-push>只推上去</button></div>' +
        '<div class="t-hint" data-peer-tip style="margin-top:var(--sp-2)">' +
          (peerWhen ? '上次同步：' + esc(peerWhen) + ' · ' + esc(peer.last_result || '') : '还没同步过') +
        '</div>' +
      '</div>' +
      '<h2 class="st-h">本机攒下的改动</h2>' +
      '<div class="t-stats"><div class="t-stat"><b>' + st.openConflicts + '</b><span>两边都改过</span></div>' +
      '<div class="t-stat"><b>' + pending.length + '</b><span>本机待推</span></div></div>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">手机上没网时改的稿子先存在本机，' +
      '有网了点「推回去」。推的时候如果服务器上也改过，这里会列出来让你挑——' +
      '<b>两份都留着，不会替你选</b>。</div>' +
      '<div class="t-bar"><button class="t-btn pri" data-push>把本机攒的推回去</button>' +
      '<button class="t-btn" data-refresh>刷新</button></div>' +
      (items.length
        ? '<h2 class="st-h">等处理的冲突</h2><div class="t-list">' + items.map((c, i) =>
          '<div class="t-row" data-c="' + i + '">' + ico('history') +
          '<div class="tr-main"><div class="tr-title">' + esc(String(c.path || '').split('/').pop()) + '</div>' +
          '<div class="tr-sub">' + esc([c.slug, ago(c.createdAt), (c.localChars || 0) + ' 字 vs ' + (c.serverChars || 0) + ' 字'].filter(Boolean).join(' · ')) + '</div></div>' +
          '<span class="t-pill warn">待挑</span></div>').join('') + '</div>'
        : emptyHtml('没有待处理的冲突', '一切都同步好了。', 'check'));
    $$('[data-c]', host).forEach((r) => {
      r.onclick = async () => {
        hap();
        const c = items[Number(r.dataset.c)];
        let full = c;
        try { full = await window.API.syncConflict(c.id); } catch (e) {}
        const info = { id: full.id, localText: full.localText, serverText: full.serverText };
        const choice = await window.Tools.Conflicts.ask(info);
        if (choice === null) return;
        try {
          await window.Tools.Conflicts.resolve(info, choice);
          toast('选好了'); hap(); syncView(host);
        } catch (e) { toast('存不了：' + e.message); }
      };
    });
    $('[data-refresh]', host).onclick = () => { hap(); syncView(host); };
    const bookSel = $('[data-peer-book]', host);
    if (bookSel) bookSel.onchange = () => {
      hap();
      if (bookSel.value === '__new__') { pullNew(host); return; }
      Prefs.set('peerBook', bookSel.value); syncView(host);
    };
    wirePeer(host);
    $('[data-push]', host).onclick = async () => {
      const r = await pushPending();
      if (!r.total) { toast('本机没有攒下的改动'); return; }
      toast('推上去 ' + r.ok + ' 条' + (r.conflicts ? '，' + r.conflicts + ' 条要你挑一版' : ''));
      hap(); syncView(host);
    };
  }

  /* 把本机攒下的改动推回服务器（联网时自动调一次，同步面板的按钮也调它）。
     冲突的**不推**：让后端留下两份，用户自己去同步面板挑。 */
  async function pushPending() {
    const list = window.Offline ? Offline.pendingWrites() : [];
    const byBook = {};
    list.forEach((x) => { (byBook[x.slug] = byBook[x.slug] || []).push(x); });
    let conflicts = 0, ok = 0, failed = 0;
    for (const slug of Object.keys(byBook)) {
      try {
        const d = await window.API.syncPush(slug, byBook[slug].map((x) => ({
          path: x.path, content: x.content, baseMtimeMs: x.baseMtimeMs })));
        (d.results || []).forEach((r) => {
          if (r.status === 'conflict') conflicts++;
          else if (r.status === 'ok' || r.status === 'unchanged') {
            ok++; window.Offline.dropWrite(slug, r.path);
          } else failed++;
        });
      } catch (e) { failed++; }
    }
    return { ok: ok, conflicts: conflicts, failed: failed, total: list.length };
  }

  /* ══════════════════════════════════════════════════════════
     9. 备份
     ══════════════════════════════════════════════════════════ */
  function openBackup(host) { pushBook('备份', (h) => backupView(h), { global: true }); }

  async function backupView(host) {
    loading(host, '读备份…');
    let st, keys = null, list = null, keysErr = null, listErr = null;
    /* 主状态读不到就是真出错（以前三处都吞掉 → 面板会装成"还没关联"，那是假象） */
    try { st = await nb('api/passport/status'); }
    catch (e) { failed(host, '备份状态', e, () => backupView(host)); return; }
    /* 这两处以前也是**吞掉错误**：读不到密钥就说"还没有"、读不到备份就整段不显示 ——
       用户看到的是"我没有备份"，真相是"没读到"。分开：读不到就说出错 + 重试。 */
    try { keys = await nb('api/passport/backup-keys'); } catch (e) { keysErr = e; }
    try { list = await nb('api/passport/backups'); } catch (e) { listErr = e; }
    const ks = (keys && keys.keys) || [];
    const items = (list && (list.backups || list.items)) || [];
    host.innerHTML =
      '<div class="t-list">' +
      '<div class="t-row static">' + ico('link') + '<div class="tr-main"><div class="tr-title">云端账号</div>' +
      '<div class="tr-sub">' + (st.linked ? '已关联' : '还没关联') + '</div></div>' +
      '<span class="t-pill ' + (st.linked ? 'ok' : 'gray') + '">' + (st.linked ? '已连' : '未连') + '</span></div>' +
      '<div class="t-row static">' + ico('key') + '<div class="tr-main"><div class="tr-title">备份密钥</div>' +
      '<div class="tr-sub">' + (keysErr ? '读不到' : (ks.length ? ks.length + ' 把' : '还没有')) + '</div></div>' +
      '<span class="t-pill ' + (keysErr ? 'warn' : (ks.length ? 'ok' : 'gray')) + '">' +
      (keysErr ? '没读到' : (ks.length ? '就绪' : '待定')) + '</span></div>' +
      '</div>' +
      (st.linked ? '' : '<div class="t-hint" style="margin:0 0 var(--sp-3)">备份要先把这本小说软件的账号关联上（在电脑端的设置里做一次就行）。没关联之前，这儿的按钮会提示你去关联。</div>') +
      '<h2 style="font:600 var(--t-md)/1 var(--ui-font);color:var(--ink-3);margin:var(--sp-3) var(--sp-1) var(--sp-2)">历史备份</h2>' +
      '<div id="bk-hist"></div>' +
      '<div class="t-bar"><button class="t-btn pri" data-new>立刻备份一次</button></div>';
    /* 历史备份这一段三种状态都要说人话：读不到（含重试）/ 还没有 / 有 */
    const hist = $('#bk-hist', host);
    if (listErr) failed(hist, '备份记录', listErr, () => backupView(host));
    else if (!items.length) empty(hist, '还没有备份', 'shield', '点下面「立刻备份一次」，第一份就有了。备份放在云端账号里，换设备也能取回。');
    else {
      hist.innerHTML = '<div class="t-list">' + items.map((b, i) => '<div class="t-row static">' + ico('shield') +
        '<div class="tr-main"><div class="tr-title">' + esc(b.name || b.id || ('备份 ' + (i + 1))) + '</div>' +
        '<div class="tr-sub">' + esc([b.createdAt ? ago(b.createdAt) : '', b.size ? bytes(b.size) : ''].filter(Boolean).join(' · ')) + '</div></div></div>').join('') + '</div>';
    }
    $('[data-new]', host).onclick = async () => {
      loading(host, '备份中…');
      try { await nb('api/passport/backups', { method: 'POST', body: {} }); toast('备份好了'); hap(); backupView(host); }
      catch (e) { toast('备份不了：' + e.message); backupView(host); }
    };
  }

  /* ══════════════════════════════════════════════════════════
     10. 会话（跟 AI 的历史对话）
     ══════════════════════════════════════════════════════════ */
  function openSessions(host) { pushBook('全部会话', (h) => sessionsView(h), { global: true }); }

  let _sessQ = '';       // 会话检索词（进详情再回来还记得）

  async function sessionsView(host) {
    loading(host, '读会话…');
    let d;
    try { d = await nb('api/agent/sessions?' + qs({ scope: 'all', limit: 60, q: _sessQ })); }
    catch (e) { failed(host, '会话列表', e, () => sessionsView(host)); return; }
    const items = (d && d.items) || [];
    host.innerHTML =
      '<div class="t-bar" style="margin-bottom:var(--sp-3)"><button class="t-btn" data-traces>看运行痕迹</button>' +
      '<button class="t-btn" data-refresh>刷新</button></div>' +
      '<div class="t-field" style="background:var(--card);border:1px solid var(--line-2);border-radius:var(--radius);padding:var(--sp-3) var(--sp-3);margin-bottom:var(--sp-3)">' +
      '<input class="t-input" id="sess-q" type="search" placeholder="搜会话：说过的话、标题都行" value="' + esc(_sessQ) + '"></div>' +
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">' +
      (_sessQ
        ? '搜「' + esc(_sessQ) + '」找到 ' + items.length + ' 个会话。清空搜索框就回到全部。'
        : '一共 ' + ((d && d.total) || items.length) + ' 个会话。点进去看它当时干了什么。') +
      '</div>' +
      (items.length
        ? '<div class="t-list">' + items.map((s, i) =>
          '<div class="t-row" data-i="' + i + '">' + ico('chat') +
          '<div class="tr-main"><div class="tr-title">' + esc(s.title || ('会话 ' + s.sessionId)) + '</div>' +
          '<div class="tr-sub' + (s.hit ? ' wrap' : '') + '">' + esc(s.hit ||
            [s.profileKey, s.currentProjectRoot ? bookName(s.currentProjectRoot) : '', s.status,
             ago(s.updatedAt)].filter(Boolean).join(' · ')) + '</div></div>' +
          '<span class="tr-go">' + window.iconHtml('chevron') + '</span></div>').join('') + '</div>'
        : emptyHtml('没搜到', '换个词试试，或者清空搜索框看全部会话。', 'chat'));
    $$('[data-i]', host).forEach((r) => {
      r.onclick = () => { hap(); sessionDetail(host, items[Number(r.dataset.i)]); };
    });
    const qi = $('#sess-q', host);
    if (qi) {
      let timer = null;
      const run = () => {
        _sessQ = qi.value.trim();
        const spot = document.getElementById('tool-body');
        if (spot) spot.scrollTop = 0;
        sessionsView(host);
      };
      qi.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 320); });
      qi.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(timer); run(); } });
    }
    const tb = $('[data-traces]', host);
    if (tb) tb.onclick = () => { hap(); tracesView(host); };
    const rb = $('[data-refresh]', host);
    if (rb) rb.onclick = () => sessionsView(host);
  }

  /* 运行痕迹：AI 每一步干了什么、花了多久。排错时看。 */
  async function tracesView(host) {
    loading(host, '读痕迹…');
    let d;
    try { d = await nb('api/agent/traces/recent?' + qs({ limit: 80 })); }
    catch (e) { failed(host, '运行痕迹', e, () => tracesView(host)); return; }
    const items = (d && (d.items || d.traces || d.entries)) || [];
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">最近 ' + items.length + ' 条。每一步 AI 用了哪个模型、多久、成没成。</div>' +
      (items.length
        ? '<div class="t-list">' + items.map((t) => {
          const kind = (t.correlation && t.correlation.kind) || 'turn';
          const bad = t.stopReason && t.stopReason !== 'end_turn' && t.stopReason !== 'stop';
          const ms = t.durationMs != null ? (t.durationMs >= 1000 ? (t.durationMs / 1000).toFixed(1) + 's' : Math.round(t.durationMs) + 'ms') : '';
          const ttft = t.ttftMs != null ? '首个字 ' + Math.round(t.ttftMs) + 'ms' : '';
          const tok = t.totalTokens != null ? t.totalTokens.toLocaleString() + ' token' : '';
          const kb = t.bytes != null ? (t.bytes / 1024).toFixed(0) + 'KB' : '';
          return '<div class="t-row static">' + ico(bad ? 'close' : 'check') +
            '<div class="tr-main"><div class="tr-title">' + esc((t.provider || '') + ' / ' + (t.model || '')) + '</div>' +
            '<div class="tr-sub wrap">' + esc([kind, ms, ttft, tok, kb, t.ts ? ago(t.ts) : ''].filter(Boolean).join(' · ')) + '</div></div></div>';
        }).join('') + '</div>'
        : emptyHtml('还没有运行痕迹', 'AI 每跑一轮都会在这儿留一条。', 'clock'));
  }

  async function sessionDetail(host, s) {
    loading(host, '读会话…');
    /* bookName() 靠作品表把 slug 翻成书名，这里先把表预热，否则会退化成显示 slug */
    try { await projects(); } catch (e) {}
    let d = null;
    try { d = await nb('api/agent/sessions/' + s.sessionId); } catch (e) {}
    /* 平台没有「把消息列出来」的接口：正文走 SSE 事件流（读不完，不能用在静态页），
       这里能拿到的是一份恢复快照。所以只报状态，正文引导回对话页看。 */
    const sm = (d && d.summary) || {};
    const rows = [
      ['身份', sm.profileKey || s.profileKey || ''],
      ['标题', sm.title || s.title || ''],
      ['状态', sm.status || s.status || ''],
      ['最后动静', ago(sm.updatedAt || s.updatedAt)],
      ['绑定的书', (sm.currentProjectRoot || s.currentProjectRoot) ? bookName(sm.currentProjectRoot || s.currentProjectRoot) : ''],
      ['已归档', s.archived ? '是' : ''],
    ].filter((x) => x[1]);
    host.innerHTML =
      '<div class="t-list">' + rows.map(([k, v]) =>
        '<div class="t-row static"><div class="tr-main"><div class="tr-sub">' + esc(k) + '</div>' +
        '<div class="tr-title" style="font-weight:var(--w-normal)">' + esc(v) + '</div></div></div>').join('') + '</div>' +
      '<div class="t-hint" style="margin:var(--sp-4) 0 var(--sp-3)">对话内容是一条实时流，手机上没法整屏回放。想看当时说了什么，直接点下面回到对话页继续（上下文都在）。</div>' +
      '<div class="t-bar"><button class="t-btn pri" data-open>回到对话页</button></div>';
    $('[data-open]', host).onclick = () => {
      stack.length = 0;
      App.show('chat');
      if (window.Chat && Chat.openSession) { try { Chat.openSession(s.sessionId); } catch (e) {} }
    };
  }

  /* ══════════════════════════════════════════════════════════
     11. 用户
     ══════════════════════════════════════════════════════════ */
  function openUsers(host) { pushBook('账号', (h) => usersView(h), { global: true }); }

  async function usersView(host) {
    loading(host, '读账号…');
    let list, me;
    try { list = await nb('api/admin/users'); }
    catch (e) { failed(host, '账号列表', e, () => usersView(host)); return; }
    try { me = await nb('api/auth/me'); } catch (e) {}
    list = Array.isArray(list) ? list : (list.users || []);
    host.innerHTML =
      '<div class="t-hint" style="margin:0 0 var(--sp-3)">现在登录的是 ' + esc((me && me.user && me.user.username) || '?') + '。</div>' +
      (list.length ? '' : emptyHtml('还没有别的账号', '这台机器上目前就你一个。', 'users')) +
      '<div class="t-list">' + list.map((u) =>
        '<div class="t-row static">' + ico('users') + '<div class="tr-main"><div class="tr-title">' + esc(u.displayName || u.username) + '</div>' +
        '<div class="tr-sub">' + esc([u.username, u.role, u.lastSeenAt ? '最近 ' + ago(u.lastSeenAt) : ''].filter(Boolean).join(' · ')) + '</div></div>' +
        '<span class="t-pill ' + (u.status === 'active' ? 'ok' : 'gray') + '">' + esc(u.status || '') + '</span></div>').join('') + '</div>';
  }

  /* ══════════════════════════════════════════════════════════
     12. 关于：版本 / 日志
     ══════════════════════════════════════════════════════════ */
  function openAbout(host) { pushBook('版本与日志', (h) => aboutView(h), { global: true }); }

  async function aboutView(host) {
    loading(host, '读版本…');
    let v, lg;
    try { v = await nb('api/app/version'); }
    catch (e) { failed(host, '版本信息', e, () => aboutView(host)); return; }
    let lgErr = null;
    try { lg = await nb('api/app/logs/status'); } catch (e) { lgErr = e; lg = {}; }
    const files = (lg && lg.files) || [];
    host.innerHTML =
      '<div class="t-list">' +
      '<div class="t-row static">' + ico('terminal') + '<div class="tr-main"><div class="tr-title">小说软件版本</div>' +
      '<div class="tr-sub wrap">' + esc(v.versionLabel || '读不到') + '</div></div></div>' +
      '<div class="t-row static">' + ico('file') + '<div class="tr-main"><div class="tr-title">日志</div>' +
      '<div class="tr-sub">' + (lgErr ? '读不到' : ((lg.fileCount || 0) + ' 个文件 · ' + bytes(lg.totalBytes))) +
      '</div></div></div>' +
      '</div>' +
      (v.githubUrl ? '<div class="t-hint" style="margin:0 0 var(--sp-3)">' + esc(v.githubUrl) + '</div>' : '') +
      '<div id="ab-logs"></div>' +
      '<div class="t-hint">App 外壳版本见「设置」。日志是排错用的，平时不用看。</div>';
    /* 日志这一段的三种状态：读不到（带重试）/ 还没有日志 / 有日志 */
    const lgBox = $('#ab-logs', host);
    if (lgErr) failed(lgBox, '日志清单', lgErr, () => aboutView(host));
    else if (!files.length) empty(lgBox, '还没有日志文件', 'file', '程序跑起来、有报错的时候才会写日志。平时是空的，正常。');
    else {
      lgBox.innerHTML = '<div class="t-list">' + files.map((f) => '<div class="t-row static">' + ico('file') +
        '<div class="tr-main"><div class="tr-title">' + esc(f.name) + '</div>' +
        '<div class="tr-sub">' + bytes(f.size) + ' · ' + esc(ago(f.mtimeMs)) + '</div></div>' +
        '<button class="t-btn sm" data-dl="' + esc(f.name) + '">下载</button></div>').join('') + '</div>';
    }
    $$('[data-dl]', host).forEach((b) => {
      b.onclick = () => {
        const a = document.createElement('a');
        a.href = 'nb/api/app/logs/download?' + qs({ file: b.dataset.dl });
        a.download = b.dataset.dl;
        a.click();
      };
    });
  }

  /* ══════════════════════════════════════════════════════════
     宫格
     ══════════════════════════════════════════════════════════ */
  /* 卡片带 sec（分组名），谁往 TOOLS 里加卡片就归到哪一组。
     studio.js 那一批面板也走这里注册（Tools.add），不另外维护第二份宫格。 */
  const TOOLS = [
    { id: 'files', name: '文件', sub: '全部文件', icon: 'folder', sec: '书稿', run: openFiles },
    { id: 'cover', name: '封面', sub: '换封面', icon: 'image', sec: '书稿', run: openCover },
    { id: 'notes', name: '笔记', sub: '想法摘录', icon: 'note', sec: '书稿', run: openNotes },
    { id: 'memory', name: '记忆', sub: 'AI 记得啥', icon: 'database', sec: 'AI', run: openMemory },
    { id: 'models', name: '模型', sub: '供应商', icon: 'cpu', sec: 'AI', run: openModels },
    { id: 'profiles', name: '档案', sub: '谁在干活', icon: 'briefcase', sec: 'AI', run: openProfiles },
    { id: 'skills', name: '技能', sub: 'AI 会啥', icon: 'spark', sec: 'AI', run: openSkills },
    { id: 'jobs', name: '任务', sub: '后台在跑', icon: 'clock', sec: 'AI', run: openJobs },
    { id: 'history', name: '改动', sub: '改了什么', icon: 'history', sec: '系统', run: openHistory },
    { id: 'backup', name: '备份', sub: '存档', icon: 'shield', sec: '系统', run: openBackup },
    { id: 'sync', name: '同步', sub: '离线冲突', icon: 'refresh', sec: '系统', run: openSync },
    { id: 'sessions', name: '会话', sub: '对话记录', icon: 'chat', sec: 'AI', run: openSessions },
    { id: 'users', name: '账号', sub: '用户', icon: 'users', sec: '系统', run: openUsers },
    { id: 'about', name: '关于', sub: '版本日志', icon: 'terminal', sec: '系统', run: openAbout },
  ];
  const SECTIONS = ['书稿', '写作', 'AI', '系统'];

  function renderGrid() {
    const body = document.getElementById('tools-body');
    if (!body) return;
    /* 回到宫格 = 回到工具区最底层：**把层级栈清空**。
       不清的话会留着一个"幽灵上一层"——用户从宫格点进新工具，再按返回，
       会落到**上一次那个工具**里（此前的反馈就是这个）。
       走底部页签离开工具区、再回来，也会经过这里，所以那条路一起修好了。 */
    stack.length = 0;
    /* 宫格顶上那条也是**全站一键切换**：在工具里也能一眼看到"在写哪本"、随手换。
       换完不重画宫格（宫格本身与书无关），但下面那批面板下次进来就是新书了。 */
    if (window.BookCtx) {
      BookCtx.mount('tools-book', null, { global: true });
    }
    const groups = SECTIONS.map((n) => [n, TOOLS.filter((t) => t.sec === n)]);
    groups.push(['其它', TOOLS.filter((t) => SECTIONS.indexOf(t.sec) < 0)]);
    body.innerHTML = groups.filter(([, list]) => list.length).map(([n, list]) =>
      '<div class="tools-sec"><h2>' + n + '</h2><div class="tools-grid">' +
      list.map(card).join('') + '</div></div>').join('');
    $$('.tool-card', body).forEach((c) => {
      c.onclick = () => { hap(); openTool(c.dataset.id); };
    });
  }
  /* 进一个工具：**先把层级栈清空**，再进。
     这是**唯一**的入口（宫格点击、Tools.open、别处调用都走它）——
     以前宫格那条路直接 t.run()，栈是脏的，返回键就会退到别的工具里去。 */
  function openTool(id) {
    const t = TOOLS.find((x) => x.id === id);
    stack.length = 0;
    if (!t) return false;
    t.run(document.getElementById('tool-body'));
    return true;
  }

  const card = (t) => '<div class="tool-card" data-id="' + t.id + '">' +
    '<span class="tc-ico">' + window.iconHtml(t.icon) + '</span>' +
    '<span class="tc-name">' + t.name + '</span>' +
    '<span class="tc-sub">' + t.sub + '</span></div>';

  /* 返回上一级：先问顶层要不要自己消化（文件浏览器用它退一层目录），
     再退层级栈，退到底回宫格。总之一次只退一层。 */
  function back() {
    hap();
    const top = stack[stack.length - 1];
    if (top && typeof top.onBack === 'function' && top.onBack() === true) return;
    if (stack.length > 1) { stack.pop(); paint(); return; }
    stack.length = 0;
    App.show('tools');
  }

  /* ── 对外 ──
     ui 那一包是给 studio.js 那批新面板复用的：栈、loading、空态、问框、选书、
     时间格式化，全都只有这一份实现（以前冒出过第二套，见 base.css 里的水波纹批注）。 */
  window.Tools = {
    TOOLS,
    ui: { push, pushBook, paint, loading, empty, ask, confirmBox, projects, pickProject, curSlug, mountBook,
          ago, ts, bytes, back, bookName, paintJob, stepName },
    /* 冲突：写作台、文件编辑器、同步面板都走这一份实现 */
    Conflicts: { ask: conflictAsk, resolve: conflictResolve },
    Jobs: { watch: watchJob },
    /* 联网后自动把离线攒的改动推回去（App 里监听 online 调它） */
    pushPending: pushPending,
    /* 加/替换宫格卡片（studio.js 启动时调一次） */
    add(cards) {
      (cards || []).forEach((c) => {
        const i = TOOLS.findIndex((x) => x.id === c.id);
        if (i >= 0) TOOLS[i] = c; else TOOLS.push(c);
      });
      if (document.body.dataset.tab === 'tools') renderGrid();
    },
    onShow() {
      const cur = document.body.dataset.tab;
      if (cur === 'tools') renderGrid();
      else if (cur === 'tool') paint();
    },
    back,
    open: openTool,
  };
})();
