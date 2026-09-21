/* ============================================================
   preset.js — 「预设」页
   小说软件里管写作人设 / 文风 / 尺度 / 模型参数的那套东西，
   就是酒馆里的「预设」。这里把它整页搬进 App。
   数据全部来自 /api/presets，字段名和可选项都由平台自己给，不写死。
   ============================================================ */
(function () {
  const q = (s, r) => (r || document).querySelector(s);
  const CHEV = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" '
    + 'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* 置顶规则单独一张卡——它优先级最高，是 AI 的总开关 */
  const TOP_PATH = 'customTopSystemPrompt';
  const EFFORT = [['', '跟随默认'], ['off', '关'], ['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '很高'], ['max', '拉满']];

  const S = { data: null, key: null, draft: null, dirty: false, busy: false, loaded: false,
              scope: 'global', slug: '', hasOwn: false };

  const prof = () => (S.data.profiles || []).find((p) => p.profileKey === S.key) || {};
  const vals = () => S.draft[S.key].values;
  const mdl = () => S.draft[S.key].model;

  function mark(dirty) {
    S.dirty = dirty;
    const bar = q('#preset-save');
    if (bar) bar.classList.add('show');           // 常驻，别让用户找保存键
    const btn = q('#preset-save [data-save]');
    if (btn) btn.disabled = !dirty;
    const msg = q('#preset-save .msg');
    if (msg) msg.textContent = dirty ? '有改动，还没保存' : '和平台一致';
    const top = q('#preset-save-top');
    if (top) top.classList.toggle('has-dot', !!dirty);
  }

  /* ---------------- 渲染 ---------------- */

  function ctrl(f) {
    const v = vals()[f.path];
    const ph = esc(f.placeholder || '');
    if (f.component === 'radio' || f.component === 'select') {
      const opts = f.options || [];
      if (opts.length > 4) return picker(f);
      /* 标签长的选项（后端发来的「短（2000 字上下）」这种）横排时会被挤成 2~3 行 ——
         用户点名的毛病「跟随系统被挤成两行」是同一类。长标签改成竖排一行一个，左对齐。 */
      const longLabel = opts.some((o) => String(o.label || '').replace(/\s+/g, '').length > 5);
      return '<div class="pradio' + (longLabel ? ' pradio-list' : '') + '" data-radio="' + esc(f.path) + '">' + opts.map((o) =>
        '<button type="button" data-v="' + esc(o.value) + '"'
        + (String(v) === String(o.value) ? ' class="on"' : '') + '>'
        + esc(o.label) + (o.description ? '<small>' + esc(o.description) + '</small>' : '')
        + '</button>').join('') + '</div>';
    }
    if (f.component === 'resource-preset') return picker(f);
    if (f.component === 'textarea') {
      return '<textarea class="ptextarea" data-in="' + esc(f.path) + '" rows="' + (f.rows || 6)
        + '" placeholder="' + ph + '">' + esc(v == null ? '' : v) + '</textarea>';
    }
    const isNum = f.component === 'number';
    if (isNum) {
      return '<input class="pinput" type="number" inputmode="decimal" '
        + 'data-in="' + esc(f.path) + '" value="' + esc(v == null ? '' : v) + '" placeholder="' + ph + '">';
    }
    // 自由文本一律用「会自己长高的多行框」：
    // 单行 input 放长文（比如 200 多字的写作要求）会横向滚出去，很丑。
    return '<textarea class="ptextarea pgrow" rows="1" data-in="' + esc(f.path)
      + '" placeholder="' + ph + '">' + esc(v == null ? '' : v) + '</textarea>';
  }

  /* 多行框自增高：CSS field-sizing 优先，老 WebView 用脚本兜底 */
  function grow(el) {
    if (!el || !el.classList.contains('pgrow')) return;
    el.style.height = 'auto';
    el.style.height = Math.max(44, Math.min(el.scrollHeight, window.innerHeight * 0.42)) + 'px';
  }
  document.addEventListener('input', (e) => grow(e.target), true);
  

  function picker(f) {
    const v = vals()[f.path];
    const hit = (f.options || []).find((o) => o.value === v);
    const empty = v === '' || v == null;
    const sub = empty ? '点一下从预设库里挑一个' : String(v).split('/').pop();
    return '<button type="button" class="ppick' + (empty ? ' empty' : '') + '" data-pick="' + esc(f.path) + '">'
      + '<span class="txt"><b>' + esc(hit ? hit.label : (empty ? '未指定 · 用平台默认' : v)) + '</b>'
      + '<span>' + esc(sub) + '</span></span><span class="chev">' + CHEV + '</span></button>';
  }

  function fieldHtml(f) {
    const tags = f.component === 'resource-preset' ? '<span class="tag">预设库</span>'
      : (f.component === 'textarea' ? '<span class="tag">长文本</span>' : '');
    return '<div class="pfield"><div class="pfield-lb">' + esc(f.label) + tags + '</div>'
      + (f.description ? '<p class="pfield-ds">' + esc(f.description) + '</p>' : '')
      + '<div class="pfield-ct">' + ctrl(f) + '</div></div>';
  }

  function modelCard() {
    const m = mdl();
    const hit = (S.data.models || []).find((x) => x.key === m.modelKey);
    const row = (k, c) => '<div class="pfield"><div class="pfield-lb">' + k + '</div><div class="pfield-ct">' + c + '</div></div>';
    return '<div class="pcard"><div class="pcard-hd"><h3>模型与手感</h3><span class="hint">改完点右下角保存</span></div>'
      + '<div class="pcard-bd">'
      + row('用哪个模型', '<button type="button" class="ppick' + (m.modelKey ? '' : ' empty') + '" data-pick="__model">'
        + '<span class="txt"><b>' + esc(hit ? hit.label : (m.modelKey || '跟随平台默认')) + '</b>'
        + '<span>' + esc(m.modelKey || '点一下挑一个模型') + '</span></span><span class="chev">' + CHEV + '</span></button>')
      + row('温度 <span class="hint">越高越发散，留空=默认</span>',
        '<input class="pinput" inputmode="decimal" data-model="temperature" value="'
        + esc(m.temperature == null ? '' : m.temperature) + '" placeholder="默认（留空）">')
      + row('TopK <span class="hint">候选范围，留空=默认</span>',
        '<input class="pinput" inputmode="numeric" data-model="topK" value="'
        + esc(m.topK == null ? '' : m.topK) + '" placeholder="默认（留空）">')
      + row('思考强度', '<button type="button" class="ppick" data-pick="__effort">'
        + '<span class="txt"><b>' + esc((EFFORT.find((e) => e[0] === (m.reasoningEffort || '')) || EFFORT[0])[1]) + '</b>'
        + '<span>' + esc(m.reasoningEffort || '跟随平台默认设置') + '</span></span>'
        + '<span class="chev">' + CHEV + '</span></button>')
      + row('流式输出', '<div class="pradio" data-stream>'
        + '<button type="button" data-v="1"' + (m.stream === false ? '' : ' class="on"') + '>边想边出字</button>'
        + '<button type="button" data-v="0"' + (m.stream === false ? ' class="on"' : '') + '>一次性出完</button></div>')
      + '</div></div>';
  }

  function render() {
    const host = q('#preset-body');
    if (!host) return;
    const p = prof();
    const fields = p.fields || [];
    const top = fields.filter((f) => f.path === TOP_PATH);
    const rest = fields.filter((f) => f.path !== TOP_PATH);

    host.innerHTML =
      '<div class="preset-seg">' + (S.data.profiles || []).map((x) =>
        '<button type="button" data-key="' + esc(x.profileKey) + '"'
        + (x.profileKey === S.key ? ' class="on"' : '') + '>' + esc(x.name) + '</button>').join('')
      + '</div>'
      + modelCard()
      + (top.length ? '<div class="pcard"><div class="pcard-hd"><h3>置顶规则</h3>'
        + '<span class="hint">优先级最高，每章都会喂给 AI</span></div><div class="pcard-bd">'
        + top.map(fieldHtml).join('') + '</div></div>' : '')
      + (rest.length ? '<div class="pcard"><div class="pcard-hd"><h3>写作设定</h3>'
        + '<span class="hint">' + rest.length + ' 项</span></div><div class="pcard-bd">'
        + rest.map(fieldHtml).join('') + '</div></div>' : '')
      + '<p class="pfield-ds" style="padding:2px var(--sp-2) var(--sp-2)">改动只影响这个身份以后新写的稿子，已有的章节不会被动。</p>';

    const body = q('#preset-body');
    if (body) body.scrollTop = 0;
    mark(false);
  }

  /* ---------------- 交互 ---------------- */

  function onInput(e) {
    const t = e.target;
    if (t.dataset.in) {
      vals()[t.dataset.in] = t.value;
      mark(true);                     // 必须走 mark：它负责把「保存」按钮解禁
    } else if (t.dataset.model) {
      const raw = t.value.trim();
      mdl()[t.dataset.model] = raw === '' ? null : (isNaN(Number(raw)) ? raw : Number(raw));
      mark(true);
    }
  }

  function onClick(e) {
    const seg = e.target.closest('[data-key]');
    if (seg) { S.key = seg.dataset.key; render(); return; }

    const rb = e.target.closest('.pradio[data-radio] button');
    if (rb) {
      const grp = rb.closest('[data-radio]');
      vals()[grp.dataset.radio] = rb.dataset.v;
      grp.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === rb));
      mark(true); App.haptic && App.haptic(); return;
    }
    const eb = e.target.closest('[data-effort] button');
    if (eb) {
      mdl().reasoningEffort = eb.dataset.v || null;
      eb.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === eb));
      mark(true); App.haptic && App.haptic(); return;
    }
    const sb = e.target.closest('[data-stream] button');
    if (sb) {
      mdl().stream = sb.dataset.v === '1';
      sb.parentNode.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === sb));
      mark(true); App.haptic && App.haptic(); return;
    }
    const pk = e.target.closest('[data-pick]');
    if (pk) {
      const path = pk.dataset.pick;
      if (path === '__model') openModelPick();
      else if (path === '__effort') openEffortPick();
      else openPick(prof().fields.find((f) => f.path === path));
      return;
    }
  }

  /* 选择抽屉：预设库 / 模型，都带搜索 */
  function openList(title, items, cur, onPick, previewPath) {
    const html =
      '<div class="sheet-grip"></div>'
      + '<div class="pk-search"><input id="pk-q" placeholder="搜索" autocomplete="off"></div>'
      + (previewPath ? '<div style="padding:var(--sp-3) var(--sp-4) 0"><button type="button" class="btn sm" id="pk-view">看当前这条写了什么</button></div>' : '')
      + '<div class="pk-preview hidden" id="pk-prev"></div>'
      + '<ul class="pk-list" id="pk-list"></ul>';
    App.sheet(html, {
      onMount(panel) {
        const list = q('#pk-list', panel);
        const input = q('#pk-q', panel);
        const draw = (kw) => {
          const k = (kw || '').trim().toLowerCase();
          const hit = items.filter((it) => !k || (it.label || '').toLowerCase().includes(k)
            || String(it.value).toLowerCase().includes(k));
          list.innerHTML = hit.slice(0, 400).map((it) =>
            '<li data-v="' + esc(it.value) + '"' + (it.value === cur ? ' class="on"' : '') + '>'
            + '<span class="t">' + esc(it.label) + '</span>'
            + (it.value === cur ? '<span class="s">当前</span>' : '') + '</li>').join('')
            || '<li><span class="t muted">没找到</span></li>';
        };
        draw('');
        input.addEventListener('input', () => draw(input.value));
        list.addEventListener('click', (e) => {
          const li = e.target.closest('li[data-v]');
          if (!li) return;
          onPick(li.dataset.v);
          App.closeSheet();
          App.haptic && App.haptic();
        });
        const vw = q('#pk-view', panel);
        if (vw) vw.addEventListener('click', async () => {
          const box = q('#pk-prev', panel);
          if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
          box.classList.remove('hidden');
          box.innerHTML = '<span class="spinner"></span> 读取中…';
          try {
            const r = await API.presetResource(S.key, previewPath, cur, S.scope, S.slug);
            box.textContent = r.content || '(这条是空的)';
          } catch (err) { box.textContent = '读不出来：' + err.message; }
        });
      },
    });
  }

  function openPick(f) {
    if (!f) return;
    openList(f.label, (f.options || []).map((o) => ({ value: o.value, label: o.label })),
      vals()[f.path], (v) => {
        vals()[f.path] = v;
        render();
        mark(true);
      }, f.path);
  }

  function openModelPick() {
    const list = (S.data.models || []).map((m) => ({ value: m.key, label: m.label || m.key }));
    openList('挑模型', list, mdl().modelKey, (v) => {
      mdl().modelKey = v;
      render();
      mark(true);
    });
  }

  function openEffortPick() {
    openList('思考强度', EFFORT.map(([v, lb]) => ({ value: v, label: lb })),
      mdl().reasoningEffort || '', (v) => {
        mdl().reasoningEffort = v || null;
        render();
        mark(true);
      });
  }

  /* ---------------- 保存 ---------------- */

  async function save() {
    if (S.busy || !S.dirty) return;
    S.busy = true;
    const bar = q('#preset-save');
    const btn = q('#preset-save .btn');
    const msg = q('#preset-save .msg');
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    try {
      await API.presetSave(S.key, { ...vals() }, { ...mdl() }, S.scope, S.slug);
      if (msg) msg.textContent = '已保存';
      mark(false);
      S.data = null; S.draft = null;   // 下次进来重新拉，确保和平台一致
      App.toast('预设已保存');
      App.haptic && App.haptic();
    } catch (e) {
      if (msg) msg.textContent = '保存失败';
      App.toast('保存失败：' + e.message);
    } finally {
      S.busy = false;
      if (btn) { btn.disabled = !S.dirty; btn.textContent = '保存'; }
    }
  }

  /* 离开这一页时如果还有没存的，问一句 */
  function guardLeave() {
    if (!S.dirty) { App.show('shelf'); return; }
    App.confirm('预设还没保存，现在走就丢了。', () => { mark(false); App.show('shelf'); }, '丢掉离开');
  }

  /* ---------------- 作用域（这本书 / 所有书默认） ---------------- */

  function bookTitle() {
    if (window.BookCtx && BookCtx.slug() === S.slug && BookCtx.title()) return BookCtx.title();
    const b = (window.App && App.state && App.state.book) || null;
    if (b && b.slug === S.slug && b.title && b.title !== b.slug) return b.title;
    const list = (window.Shelf && Shelf.projects) || [];
    const p = list.find((x) => (x.slug || x.projectRoot) === S.slug);
    return (p && (p.title || p.name)) || (window.BookCtx && BookCtx.title()) || S.slug;
  }

  /* 面板顶上那条切书：切过去 = 从"所有书默认"换成"这本自带的"，并立刻重读 */
  function switchBookTo() {
    const go = () => {
      const slug = (window.BookCtx && BookCtx.slug()) || '';
      mark(false);
      S.slug = slug; S.scope = 'project'; S.data = null; S.draft = null; S.key = null;
      window.Preset.open('project', slug);
    };
    if (S.dirty) App.confirm('这边还没保存，切过去就丢了。', go, '丢掉切换');
    else go();
  }

  function renderScope() {
    const el = q('#preset-scope');
    if (!el) return;
    /* 以前没书时这里直接隐藏 → 用户看不到任何切书入口（监督人核实过 preset.js:311）。
       现在「当前书」是全局的，总有值；真没有也留一个提示，不再静默隐藏。 */
    if (!S.slug) {
      el.hidden = false;
      el.innerHTML = '<p class="pseg-hint">还没有作品 · 先去书架建一本</p>';
      return;
    }
    el.hidden = false;
    const on = S.scope === 'project';
    el.innerHTML = '<div class="pseg">'
      + '<button type="button" data-scope="project" class="' + (on ? 'on' : '') + '">这本书</button>'
      + '<button type="button" data-scope="global" class="' + (on ? '' : 'on') + '">所有书默认</button>'
      + '</div><p class="pseg-hint">'
      + (on
        ? '只对《' + esc(bookTitle()) + '》生效' + (S.hasOwn
            ? ' · 它已经有自己的一份设定了 <button type="button" class="plink" data-reset>取消它的独立设定</button>'
            : ' · 还没有自己的一份，保存后就有了')
        : '所有<b>还没单独设过</b>的书都跟着这套走，不影响已经单独设过的')
      + '</p>';
  }

  /* 取消这本书的独立设定，让它重新跟着「所有书默认」走 */
  function resetProject() {
    App.confirm('《' + bookTitle() + '》会重新跟着「所有书默认」走，这本书单独改过的设定会丢掉。',
      async () => {
        try {
          await API.presetReset('project', S.slug);
          App.toast('已恢复为所有书默认');
          S.data = null; S.draft = null; S.dirty = false;
          window.Preset.open('project', S.slug);
        } catch (e) { App.toast('恢复失败：' + (e.message || '')); }
      }, '恢复默认');
  }

  function switchScope(next) {
    if (next === S.scope) return;
    if (S.dirty) {
      App.confirm('这边还没保存，切过去就丢了。', () => {
        mark(false); S.data = null; S.draft = null; S.scope = next;
        window.Preset.open(S.scope, S.slug);
      }, '丢掉切换');
      return;
    }
    S.data = null; S.draft = null; S.scope = next;
    window.Preset.open(S.scope, S.slug);
  }

  /* ---------------- 对外 ---------------- */

  window.Preset = {
    /* App.show() 切到这一页时会调 onShow */
    onShow() { return window.Preset.open(); },
    async open(scope, slug) {
      const host = q('#preset-body');
      if (!host) return;
      /* 顶上那条切书（用户点名的三个面板之一）。没书时先兜一本，让入口始终在。 */
      if (window.BookCtx) {
        if (!BookCtx.has()) { try { await BookCtx.ensure(); } catch (e) {} }
        BookCtx.mount('preset-book', () => switchBookTo());
      }
      // 默认就是全站唯一的「当前书」
      const wantSlug = (slug === undefined)
        ? ((window.BookCtx && BookCtx.slug()) || (App.state && App.state.slug) || '')
        : (slug || '');
      const wantScope = scope || (wantSlug ? 'project' : 'global');
      if (wantSlug !== S.slug || wantScope !== S.scope) {
        S.slug = wantSlug; S.scope = wantScope; S.data = null; S.draft = null;
      }
      renderScope();
      if (S.data && S.draft && S.key) { render(); return; }   // 没改过就直接用缓存的
      loadInto(host);
    },
  };

  /* 真拉一次预设并画出来。**单独抽出来是为了「重试」能重跑同一段** ——
     出错态那个按钮按下去必须真的再来一次，不是摆着好看。
     三态跟全站一套（第 29 轮统一）：UI.loadingIn / UI.failedIn / UI.emptyIn。
     以前这里是 `.preset-loading` 一行字 + 出错时一句裸文案「读不到预设：…」——
     用户分不清"没东西"和"坏了"，也没有重试；而且**形状不对时会走进抛异常那条路**，
     屏上是错的、判据却当成空态报了绿（第 29 轮自己抓到的假绿）。 */
  function loadInto(host) {
    UI.loadingIn(host, '正在读预设…');
    return API.presets(S.scope, S.slug).then((d) => {
      const list = Array.isArray(d && d.profiles) ? d.profiles : [];
      S.data = d;
      S.hasOwn = !!(d && d.hasOwn);
      renderScope();
      if (!list.length) {
        /* 真·空态：一个身份都没有。说清"这是什么、怎么才会出现"，别给白纸。 */
        S.key = null; S.draft = {};
        return UI.emptyIn(host, S.slug ? '这本书还没有预设' : '还没有全站预设',
          '预设是喂给 AI 的"写作规矩"（人设、口吻、禁写词）。填完保存，之后新写的稿子才会用上。',
          'sliders');
      }
      if (!S.key || !list.some((p) => p.profileKey === S.key)) S.key = (list[0] || {}).profileKey;
      S.draft = {};
      list.forEach((p) => {
        S.draft[p.profileKey] = {
          values: JSON.parse(JSON.stringify(p.values || {})),
          model: JSON.parse(JSON.stringify(p.model || {})),
        };
      });
      render();
      return undefined;
    }).catch((e) => {
      /* 出错态：说人话 + 「重试」（重跑本次这一段）。连不上和"读不出来"分开说。 */
      UI.failedIn(host, '预设', e, () => loadInto(host));
      return undefined;
    });
  }

  /* 事件绑定（只绑一次） */
  let bound = false;
  function bind() {
    if (bound) return;
    bound = true;
    const body = q('#preset-body');
    if (body) {
      body.addEventListener('input', onInput);
      body.addEventListener('change', onInput);
      body.addEventListener('click', onClick);
    }
    const sc = q('#preset-scope');
    if (sc) sc.addEventListener('click', (e) => {
      if (e.target.closest('[data-reset]')) {
        App.haptic && App.haptic();
        resetProject();
        return;
      }
      const b = e.target.closest('[data-scope]');
      if (!b) return;
      App.haptic && App.haptic();
      switchScope(b.dataset.scope);
    });
    const sv = q('#preset-save [data-save]');
    if (sv) sv.addEventListener('click', save);
    const st2 = q('#preset-save-top');
    if (st2) st2.addEventListener('click', save);
    const bk = q('#preset-back');
    if (bk) bk.addEventListener('click', guardLeave);
  }
  document.addEventListener('DOMContentLoaded', bind);
  if (document.readyState !== 'loading') bind();
})();
