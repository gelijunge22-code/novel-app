/* ============================================================
   websearch.js — 「联网搜索」这一块界面（大设置页 / AI 对话设置共用同一份）

   
     「增加一个技能或者机制，就是**所有 AI 是可以开启联网搜索功能的**，
       在写同人或者需要借鉴的时候，可以主动上网搜索……
       **我不太清楚是需要给他固定的网页，还是让他自己找**，
       但是让他自己找的话，他**可能找不到太好的文本样品**」

   所以界面上要能看清三件事（每一件后端都有对应接口，见 server/engine/websearch.py）：
     ① 开 / 关 —— 关着的时候**一个请求都不发**（判据用本地假站点数请求数验证）；
     ② 现在**只信哪几个站**（名单看得见、能加能删）—— 这就是"固定网页"和"自己找"之间的第三条路：
        先用一份信得过的名单兜住质量，用户想加自己的站就加；
     ③ **当场试一试** —— 输一个词真搜一次，把"搜到的是什么"直接摆给用户看，
        不用他先相信我们的说法（interface 里不许出现"应该能搜到"这种话）。

   这一块只有一份实现：大设置页和 AI 对话的「模型与渠道」都调 `WebCfg`。
   ============================================================ */
(function () {
  const API = window.API;
  const esc = (s) => window.UI.esc(s);
  const $ = (s, r) => (r || document).querySelector(s);

  let CACHE = null;          // 上一次读到的状态（catalogue）

  async function load(force) {
    if (CACHE && !force) return CACHE;
    CACHE = await API.webConfig();
    return CACHE;
  }
  function invalidate() { CACHE = null; }

  /** 一棵"开关行"（全站只有 .switch 这一种二元开关形态）。 */
  function swRow(key, label, sub, on) {
    return '<div class="settings-row"><span class="k">' + esc(label) + '<small>' + esc(sub) +
      '</small></span><button class="switch' + (on ? ' on' : '') + '" data-webset="' + key +
      '" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" aria-label="' + esc(label) +
      '" title="' + esc(label) + '"><i></i></button></div>';
  }

  /** 联网设置这一整块（h3 + 分组）。`opts.test` 传 false 就去掉"试一试"那一行。 */
  function groupHtml(d, opts) {
    const o = opts || {};
    const on = !!(d && d.enabled);
    const hosts = (d && d.hosts) || [];
    const engines = ((d && d.engines) || []).map((e) => e.name).join('、');
    const rows = hosts.map((h) =>
      '<div class="settings-row"><span class="k">' + esc(h.name) +
      '<small>' + esc(h.host) + (h.mine ? ' · 我自己加的' : ' · 自带') +
      (h.search ? ' · 能搜' : '') + '</small></span>' +
      (h.mine ? '<button class="btn sm btn-danger" data-webdel="' + esc(h.host) + '">移除</button>' : '') +
      '</div>').join('');
    return '<h3>联网搜索</h3><div class="settings-group" id="' + (o.id || 'webcfg') + '">' +
      swRow('enabled', '允许上网', '需要查资料、写同人时，我可以自己上网找样本。关着的时候不会联网', on) +
      (on ? swRow('openAny', '也读名单外的网页',
        '默认只读下面这些站点，免得捞回没用的文本', !!(d && d.openAny)) : '') +
      (on ? rows : '') +
      (on ? '<div class="settings-row"><span class="k">名单外的站</span>' +
        '<button class="btn sm" data-webadd="1">加一个站点</button></div>' : '') +
      /* 「搜一句」这一行**关着也留着**：用户点下去会看到"这一次没有联网" ——
         这比"关掉之后整行消失"有用（看得见开关是干什么的），判据也才有得量。 */
      (o.test !== false ? '<div class="settings-row stack">' +
        '<span class="k">搜一句试试<small>现在能搜：' + esc(engines || '还没有可用的站点') +
        '</small></span><div class="web-try">' +
        '<input class="input" id="web-try-q" placeholder="比如：某个世界的 能力体系 设定" ' +
        'aria-label="要搜的关键词"><button class="btn sm" data-webtry="1">搜一句</button></div>' +
        '<div id="web-try-out" class="web-try-out"></div></div>' : '') +
      '</div>';
  }

  /** 把「加一个站点」的小表单画成一张卡（放在弹层里用）。 */
  function addFormHtml() {
    return '<div class="sheet-note" style="margin:0 var(--sp-4) var(--sp-3)">' +
      '填一个域名，我就把它当成信得过的来源。想让我**在这个站里搜**，' +
      '再填一行搜索地址（带 <code>{q}</code> 的那一行）—— ' +
      '不填也行，那样只会读你直接给我的链接。</div>' +
      '<div class="settings-group">' +
      '<div class="settings-row"><span class="k">名字</span>' +
      '<input class="input" id="ws-name" placeholder="随便起，比如 我的同人站"></div>' +
      '<div class="settings-row"><span class="k">域名</span>' +
      '<input class="input" id="ws-host" placeholder="example.com"></div>' +
      '<div class="settings-row"><span class="k">搜索地址<small>可选</small></span>' +
      '<input class="input" id="ws-search" placeholder="https://…/search?q={q}"></div>' +
      '</div><div id="ws-out" class="sheet-note" style="margin:var(--sp-3) var(--sp-4)"></div>';
  }

  /** 保存整张名单（后端接的是**整份**数组，所以每次都把现有的原样带回去）。 */
  async function saveHosts(list, done) {
    try {
      const r = await API.webSave({ sources: list });
      invalidate();
      if (r && r.enabled !== undefined) CACHE = r;
      done && done(null, r);
    } catch (e) { done && done(e); }
  }

  function mineOf(d) {
    return ((d && d.hosts) || []).filter((h) => h.mine)
      .map((h) => ({ name: h.name, host: h.host, weight: h.weight, search: h.search || '' }));
  }

  /** 「加一个站点」的弹层。`done` 在保存成功后回调（调用方负责重画）。 */
  function addSheet(d, done) {
    App.sheet('<div class="sheet-head"><h3>加一个站点</h3>' +
      '<button class="btn sm" data-close>关闭</button></div>' + addFormHtml(),
    {
      onMount(p) {
        const go = p.querySelector('#ws-name');
        setTimeout(() => go && go.focus(), 60);
        p.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => App.closeSheet()));
        p.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
        function save() {
          const out = p.querySelector('#ws-out');
          const name = (p.querySelector('#ws-name').value || '').trim();
          const host = (p.querySelector('#ws-host').value || '').trim().toLowerCase()
            .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
          const search = (p.querySelector('#ws-search').value || '').trim();
          if (!host) { out.textContent = '先填域名'; return; }
          if (search && search.indexOf('{q}') < 0) {
            out.textContent = '搜索地址里要有 {q} 那一截（它是我换成关键词的地方）';
            return;
          }
          const list = mineOf(d).filter((x) => x.host !== host);
          list.push({ name: name || host, host: host, weight: 4, search: search });
          out.textContent = '正在保存…';
          saveHosts(list, (e) => {
            if (e) { out.textContent = '没存上：' + e.message; return; }
            App.closeSheet();
            App.toast('加好了：' + (name || host));
            done && done();
          });
        }
        p.querySelector('#ws-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
        p.querySelector('#ws-host').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
        p.querySelector('#ws-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
        /* 保存按钮就是弹层底部那一颗（沿用全站 sheet 的动作区样式） */
        const acts = document.createElement('div');
        acts.className = 'sheet-acts';
        acts.innerHTML = '<button class="btn sm btn-primary" id="ws-save">加进去</button>';
        p.appendChild(acts);
        p.querySelector('#ws-save').addEventListener('click', save);
      },
    });
  }

  /** 画"试一试"的结果（搜到 → 列条目；没搜到 → 说人话 + 原因）。 */
  function paintTry(out, r) {
    if (!out) return;
    if (!r) { out.innerHTML = ''; return; }
    if (!r.enabled) {
      out.innerHTML = '<div class="web-try-none">还没打开「允许上网」，所以这一次没有联网。</div>';
      return;
    }
    if (!r.ok) {
      out.innerHTML = '<div class="web-try-none">' + esc(r.error || '没搜到') +
        ((r.engineErrors || []).length ? '<small>' + esc(r.engineErrors.join('；')) + '</small>' : '') +
        '</div>';
      return;
    }
    const one = (x) => '<li><a href="#" data-webtrylink="' + esc(x.url) + '">' + esc(x.title) +
      '</a><small>' + esc(x.source || '') + ' · ' + esc((x.snippet || '').slice(0, 60)) + '</small></li>';
    out.innerHTML = '<div class="web-try-note">搜到 ' + r.results.length + ' 条（' +
      esc((r.engines || []).join('、')) + '）；' + esc(r.note || '') + '</div>' +
      '<ul class="web-try-list">' + r.results.map(one).join('') + '</ul>' +
      ((r.dropped || []).length ? '<div class="web-try-note">没用这几条：' +
        esc(r.dropped.map((x) => x.host + '（' + x.why + '）').join('；')) + '</div>' : '');
  }

  async function trySearch(root) {
    const q = (($('#web-try-q', root) || {}).value || '').trim();
    const out = $('#web-try-out', root);
    if (!q) { if (out) out.innerHTML = '<div class="web-try-none">先写一个关键词</div>'; return; }
    const btn = $('[data-webtry]', root);
    if (btn) { btn.disabled = true; btn.textContent = '搜…'; }
    if (out) out.innerHTML = '<div class="web-try-none">正在搜…</div>';
    let r = null;
    try { r = await API.webTest({ q: q }); }
    catch (e) { r = { enabled: true, ok: false, error: '搜不了：' + e.message }; }
    paintTry(out, r);
    if (btn) { btn.disabled = false; btn.textContent = '搜一句'; }
  }

  /** 绑定这一块的所有交互。`redraw` 由调用方给（重画它自己那一屏）。 */
  function wire(root, ctx) {
    const c = ctx || {};
    const box = $('#webcfg', root) || root;
    box.querySelectorAll('[data-webset]').forEach((b) => b.addEventListener('click', async () => {
      const key = b.dataset.webset;
      const on = !b.classList.contains('on');
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      const body = key === 'enabled' ? { enabled: on } : { openAny: on };
      try {
        const r = await API.webSave(body);
        invalidate();
        if (r && r.enabled !== undefined) CACHE = r;
      } catch (e) { App.toast('没存上：' + e.message); }
      c.redraw ? c.redraw() : null;      // 开关会带出/收起下面几行，重画一遍
    }));
    box.querySelectorAll('[data-webdel]').forEach((b) => b.addEventListener('click', () => {
      const host = b.dataset.webdel;
      App.confirm('把 ' + host + ' 从名单里去掉？', async () => {
        await saveHosts(mineOf(c.data || CACHE).filter((x) => x.host !== host));
        App.toast('去掉了');
        c.redraw && c.redraw();
      }, '去掉');
    }));
    const add = box.querySelector('[data-webadd]');
    if (add) add.addEventListener('click', () => addSheet(c.data || CACHE, () => c.redraw && c.redraw()));
    box.querySelectorAll('[data-webtry]').forEach((b) => b.addEventListener('click', () => trySearch(root)));
    const qi = $('#web-try-q', root);
    if (qi) qi.addEventListener('keydown', (e) => { if (e.key === 'Enter') trySearch(root); });
    box.querySelectorAll('[data-webtrylink]').forEach((a) => a.addEventListener('click', (e) => {
      e.preventDefault();
      const url = a.dataset.webtrylink;
      if (window.App && App.toast) App.toast(url);
    }));
  }

  window.WebCfg = { load, invalidate, groupHtml, wire, addSheet, paintTry, mineOf, saveHosts };
})();
