/* ============================================================
   lore.js — 「设定」面板（window.Lore）
   浏览 lorebook 文件树 / 防抖搜索 / 打开-编辑-保存（带冲突保护）。
   接口：API.loreTree · API.loreSearch · API.chapter · API.saveFile
   ============================================================ */
(function () {
  'use strict';

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const DEBOUNCE_MS = 260;
  const GROUP_LABEL = {
    character: '角色', event: '事件与年表', faction: '势力与地理', item: '道具与装备',
    location: '地点', system: '规则体系', world: '世界总纲', note: '笔记',
    instruction: '写作指令', manuscript: '正文', agents: '智能体', other: '其它',
  };
  const GROUP_ORDER = ['world', 'system', 'character', 'faction', 'location', 'item', 'event', 'note', 'instruction', 'manuscript', 'agents', 'other'];

  const S = {
    slug: null, files: [], q: '', hits: null, busy: false,
    closed: {}, wired: false, timer: null, loaded: false,
    open: null, dirty: false, mtime: 0, name: '', line: 0, saving: false,
  };

  /* ═══════════════ 小工具 ═══════════════ */
  /* 这一屏对的是哪本书 —— 读全站唯一的那个「当前书」（bookctx.js），
     不再"没值就摔给书架第一本"（那正是用户说的"全都指向书架第一本"）。 */
  function slugOf() {
    if (window.BookCtx && BookCtx.has()) return BookCtx.slug();
    if (App.state.slug) return App.state.slug;
    return null;
  }
  async function curSlug() {
    const s = slugOf();
    if (s) return s;
    try { return await window.BookCtx.ensure() || null; } catch (e) { return null; }
  }
  const baseName = (p) => String(p || '').split('/').pop().replace(/\.md$/i, '');
  const dirName = (p) => { const a = String(p || '').split('/'); a.pop(); return a.join('/'); };
  const leaf = (d) => String(d || '').split('/').filter(Boolean).pop() || '';
  function groupLabel(dir) {
    const l = leaf(dir);
    if (GROUP_LABEL[l]) return GROUP_LABEL[l];
    return l || '设定';
  }
  function groupRank(dir) {
    const i = GROUP_ORDER.indexOf(leaf(dir));
    return i < 0 ? GROUP_ORDER.length : i;
  }
  function fileLabel(name, dir) {
    if (/^index$/i.test(name)) return '索引 · ' + groupLabel(dir);
    return name;
  }
  function highlight(text, q) {
    const t = esc(text);
    if (!q) return t;
    const k = esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!k) return t;
    return t.replace(new RegExp(k, 'gi'), (m) => '<mark>' + m + '</mark>');
  }

  /* ═══════════════ 列表 ═══════════════ */
  async function load(force) {
    const body = $('#lore-body');
    if (!body) return;
    const slug = await curSlug();
    /* 三态统一（第 29 轮）：跟书架/工具面板/阅读器**同一套 UI.state** ——
       以前是三个各写各的 .picker-empty 字符串，出错那句里连"重试"都没有，
       用户只能退出去再进来。 */
    const put = (o) => {
      body.innerHTML = '';
      body.appendChild((window.UI && UI.state) ? UI.state(o) : (() => {
        const d = document.createElement('div');
        d.className = 'picker-empty';
        d.textContent = o.title || '';
        return d;
      })());
    };
    if (!slug) {
      put({ kind: 'empty', icon: 'book', title: '还没选中要写哪本', desc: '先去书架挑一本，再回来设它的人设与世界。' });
      return;
    }
    const changed = slug !== S.slug;
    S.slug = slug;
    if (S.loaded && !force && !changed) return;
    put({ kind: 'loading', title: '正在读设定…' });
    try {
      const d = await API.loreTree(slug);
      S.files = (d && d.files) || [];
      S.loaded = true;
    } catch (e) {
      const off = !!(e && (e.offline || e.status === 0));
      const again = document.createElement('button');
      again.className = 'btn sm';
      again.textContent = '重试';
      again.onclick = () => { S.loaded = false; load(true).catch(function () {}); };
      put({
        kind: 'error', icon: 'refresh',
        title: off ? '设定读不到：连不上服务器' : '设定读不到',
        desc: (off ? '看看手机是不是断网了，或者服务器在重启。' : (e && e.message ? e.message + '。' : ''))
          + '点「重试」再来一次。',
        actions: [again],
      });
      return;
    }
    render();
  }

  function render() {
    if (S.q) renderHits(); else renderTree();
  }

  function renderTree() {
    const body = $('#lore-body');
    if (!body) return;
    if (!S.files.length) {
      body.innerHTML = '';
      body.appendChild((window.UI && UI.state)
        ? UI.state({ kind: 'empty', icon: 'layers', title: '这本书还没有设定文件',
            desc: '人设、世界观、术语都放这儿。写之前先立规矩，后面 AI 才不会写飘。' })
        : (() => { const d = document.createElement('div'); d.className = 'picker-empty';
                   d.textContent = '这本书还没有设定文件。'; return d; })());
      return;
    }
    const groups = {};
    S.files.forEach((f) => {
      const dir = dirName(f.path);
      (groups[dir] = groups[dir] || []).push(f);
    });
    const dirs = Object.keys(groups).sort((a, b) => groupRank(a) - groupRank(b) || a.localeCompare(b));
    body.innerHTML = dirs.map((dir) => {
      const list = groups[dir].sort((a, b) => (/^index$/i.test(a.name) ? -1 : /^index$/i.test(b.name) ? 1 : String(a.path).localeCompare(String(b.path))));
      const closed = S.closed[dir] ? ' closed' : '';
      return '<div class="lore-group' + closed + '" data-dir="' + esc(dir) + '">' +
        '<div class="lore-gh" data-head="1">' + iconHtml('chevron') +
        '<span class="grow">' + esc(groupLabel(dir)) + '</span>' +
        '<span class="cnt">' + list.length + '</span></div>' +
        list.map((f) => '<div class="lore-item" data-path="' + esc(f.path) + '">' +
          '<div class="nm"><b>' + esc(fileLabel(f.name, dir)) + '</b><span>' + esc(f.path) + '</span></div>' +
          '<span class="go">' + iconHtml('chevron') + '</span></div>').join('') +
        '</div>';
    }).join('');

    $$('.lore-gh', body).forEach((h) => h.addEventListener('click', () => {
      const g = h.parentNode, dir = g.dataset.dir;
      S.closed[dir] = !S.closed[dir];
      g.classList.toggle('closed', !!S.closed[dir]);
    }));
    $$('.lore-item', body).forEach((it) => it.addEventListener('click', () => openFile(it.dataset.path)));
  }

  function renderHits() {
    const body = $('#lore-body');
    if (!body) return;
    if (S.busy) { body.innerHTML = '<div class="picker-empty"><span class="spinner"></span></div>'; return; }
    const hits = S.hits || [];
    if (!hits.length) {
      body.innerHTML = '<div class="picker-empty">「' + esc(S.q) + '」没搜到，换个词试试。</div>';
      return;
    }
    body.innerHTML = '<div class="sheet-note" style="padding:var(--sp-3) var(--sp-4) 2px">找到 ' + hits.length + ' 处</div>' +
      hits.map((h) => '<div class="hit" data-path="' + esc(h.path) + '" data-line="' + (h.line || 0) + '">' +
        '<div class="hp">' + esc(h.path) + '</div>' +
        '<div class="ht"><span class="ln">' + (h.line || 0) + '</span>' + highlight(h.text, S.q) + '</div></div>').join('');
    $$('.hit', body).forEach((el) => el.addEventListener('click', () => openFile(el.dataset.path, Number(el.dataset.line) || 0)));
  }

  /* ═══════════════ 搜索（防抖） ═══════════════ */
  let seq = 0;
  async function searchNow(q) {
    S.q = q;
    if (!q) { S.hits = null; S.busy = false; render(); return; }
    const mine = ++seq;
    S.busy = true; S.hits = null;
    render();
    const slug = S.slug || (await curSlug());
    try {
      const d = await API.loreSearch(slug, q);
      if (mine !== seq) return;
      S.hits = (d && d.hits) || [];
    } catch (e) {
      if (mine !== seq) return;
      S.hits = [];
      App.toast('搜索失败：' + e.message);
    }
    S.busy = false;
    if (mine === seq) render();
  }

  function wireSearch() {
    const inp = $('#lore-q');
    if (!inp) return;
    inp.addEventListener('input', () => {
      clearTimeout(S.timer);
      const v = inp.value.trim();
      S.timer = setTimeout(() => searchNow(v), DEBOUNCE_MS);
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(S.timer); searchNow(inp.value.trim()); inp.blur(); }
    });
  }

  function toggleSearch() {
    const bar = $('#lore-searchbar'), inp = $('#lore-q');
    if (!bar) return;
    const show = bar.classList.contains('hidden');
    bar.classList.toggle('hidden', !show);
    if (show) { setTimeout(() => inp && inp.focus(), 60); return; }
    if (inp) inp.value = '';
    searchNow('');
  }

  /* ═══════════════ 编辑器 ═══════════════ */
  async function openFile(path, line) {
    if (!path) return;
    const slug = S.slug || (await curSlug());
    App.toast('打开 ' + baseName(path));
    let d = null;
    try { d = await API.chapter(slug, path); }
    catch (e) { App.toast('打不开：' + e.message); return; }
    S.open = { path: path, content: String((d && d.content) || ''), name: (d && d.name) || baseName(path) };
    S.mtime = (d && (d.mtimeMs || d.mtime)) || 0;
    S.line = line || 0;
    S.dirty = false;
    showEditor();
  }

  function closeEditor(force) {
    const ed = $('#lore-editor');
    if (!ed) return;
    if (S.dirty && !force) {
      App.confirm('这处改动还没保存，确定丢掉？', () => closeEditor(true), '丢掉');
      return;
    }
    ed.remove();
    S.open = null; S.dirty = false; S.line = 0;
    load(true).catch(() => {});
  }

  function countChars(t) {
    const s = String(t || '');
    return { all: s.length, cn: (s.replace(/\s/g, '') || '').length };
  }

  function updateFoot() {
    const ed = $('#lore-editor');
    if (!ed) return;
    const ta = $('#ed-area', ed);
    const c = countChars(ta.value);
    const dirty = $('#ed-dirty', ed);
    if (dirty) {
      dirty.textContent = S.dirty ? '未保存' : '已保存';
      dirty.className = 'dirty' + (S.dirty ? '' : ' muted');
    }
    const stat = $('#ed-stat', ed);
    if (stat) stat.textContent = c.cn + ' 字（含空白 ' + c.all + '）';
  }

  function showEditor() {
    const host = $('#screen-lore');
    if (!host || !S.open) return;
    const old = $('#lore-editor');
    if (old) old.remove();
    const sub = S.open.path;
    const ed = document.createElement('div');
    ed.className = 'lore-editor';
    ed.id = 'lore-editor';
    ed.innerHTML =
      '<div class="ed-head">' +
        '<button class="icon-btn" data-close-ed aria-label="返回">' + iconHtml('back') + '</button>' +
        '<div class="ed-title">' + esc(S.open.name) + '<span class="sub">' + esc(sub) + '</span></div>' +
        '<button class="btn sm btn-primary" data-save>保存</button>' +
      '</div>' +
      '<textarea id="ed-area" class="ed-area" spellcheck="false"></textarea>' +
      '<div class="ed-foot">' +
        '<span id="ed-stat"></span><span class="grow"></span>' +
        '<span id="ed-dirty" class="dirty muted">已保存</span>' +
        '<button class="btn sm" data-ai>让 AI 改这段</button>' +
      '</div>';
    host.appendChild(ed);

    const ta = $('#ed-area', ed);
    ta.value = S.open.content;

    ta.addEventListener('input', () => { S.dirty = ta.value !== S.open.content; updateFoot(); });
    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); save(); }
    });
    $('[data-close-ed]', ed).addEventListener('click', () => closeEditor());
    $('[data-save]', ed).addEventListener('click', () => save());
    $('[data-ai]', ed).addEventListener('click', () => sendToChat(ta));

    updateFoot();
    if (S.line > 0) jumpToLine(ta, S.line);
    else { ta.focus(); try { ta.setSelectionRange(0, 0); } catch (e) {} }
  }

  function jumpToLine(ta, line) {
    const lines = ta.value.split('\n');
    const n = Math.max(1, Math.min(line, lines.length));
    let off = 0;
    for (let i = 0; i < n - 1; i++) off += lines[i].length + 1;
    ta.focus();
    try { ta.setSelectionRange(off, off + lines[n - 1].length); } catch (e) {}
    const lh = 16 * 1.85;
    ta.scrollTop = Math.max(0, (n - 1) * lh - ta.clientHeight / 3);
  }

  function sendToChat(ta) {
    const sel = ta.value.slice(ta.selectionStart || 0, ta.selectionEnd || 0).trim();
    const body = (sel || ta.value).slice(0, 1200);
    const text = '【改设定】文件：' + S.open.path + '\n\n' +
      (sel ? '要改的这段：\n' : '要改这个文件。\n\n现在的内容（节选）：\n') + body +
      '\n\n要改的地方：\n1. \n\n只动这个设定文件，改完告诉我改了什么。';
    if (window.Chat && Chat.draft) Chat.draft(text);
    App.show('chat');
    App.toast('已填进对话输入框，改完再发');
  }

  async function save(force) {
    if (!S.open || S.saving) return;
    const ed = $('#lore-editor');
    const ta = ed && $('#ed-area', ed);
    if (!ta) return;
    const content = ta.value;
    if (!force && content === S.open.content) { App.toast('没有改动'); return; }
    S.saving = true;
    const btn = ed.querySelector('[data-save]');
    if (btn) { btn.disabled = true; btn.textContent = '保存中'; }
    try {
      const slug = S.slug || (await curSlug());
      const r = force
        ? await API.saveFile(slug, S.open.path, content)                 /* 不带 mtime = 强制覆盖 */
        : await API.saveFile(slug, S.open.path, content, S.mtime || undefined);
      const mt = (r && (r.mtimeMs || r.mtime)) || 0;
      if (mt) S.mtime = mt;
      S.open.content = content;
      S.dirty = false;
      updateFoot();
      App.toast('已保存 · ' + countChars(content).cn + ' 字');
    } catch (e) {
      const conflict = e.status === 409 || e.status === 412 ||
        /mtime|modified|change|conflict|冲突|已(被)?改动/i.test(String(e.message || ''));
      if (conflict) {
        App.confirm('这个文件在别处被改过了，仍要用当前内容覆盖吗？', () => save(true), '覆盖保存');
      } else {
        App.toast('保存失败：' + e.message);
      }
    }
    S.saving = false;
    if (btn) { btn.disabled = false; btn.textContent = '保存'; }
  }

  /* ═══════════════ 导出 ═══════════════ */
  window.Lore = {
    onShow() {
      if (!S.wired) { S.wired = true; wireSearch(); }
      /* 顶上那条切书：切完立刻重读新书的设定（用户要求"切完立刻生效"） */
      if (window.BookCtx) {
        BookCtx.mount('lore-book', () => { S.loaded = false; S.slug = null; load(true).catch(() => {}); });
      }
      load(false).catch(() => {});
    },
    /* 顶栏搜索按钮：展开/收起搜索条（同时清空上一次的搜索） */
    toggleSearch: () => toggleSearch(),
    search(q) { const inp = $('#lore-q'); if (inp) inp.value = String(q || ''); return searchNow(String(q || '').trim()); },
    open(path, line) { return openFile(path, line); },
    refresh() { S.loaded = false; return load(true); },
    state: S,
  };
})();
