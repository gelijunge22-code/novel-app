/* ============================================================
   outline.js — 「大纲」面板（第 36 轮）

   为什么会有这个文件
   ------------------
   此处要求
     「我是想把**故事线**这个技能**在不改名字的情况下，把它的用处改成大纲**，
       它是用来放大纲的，所以点击这个故事线之后，它里面的前端和后端都要重做，
       就相当于删除了，把这个功能换成大纲」
     「剧情线可以继续叫这个名字，但它的作用需要改成『大纲』的作用」——
       **防忘 / 防 OOC / 防跑偏**，AI 和用户都能改，**用户改的以用户为准**。

   于是「大纲」这一块现在长这样：**一份实现（就是这个文件）· 两个入口**
     · 工具宫格 →「故事线」（名字一个字没改，点开就是大纲）
     · 「剧情」工具 →「剧情线」页签（名字也留着，内容换成同一块大纲）
   为什么抽成一份：以前每个入口各写一套，**两套并存**正是此处要求"UI 不统一"的来源；
   而且两处各改各的，早晚会有一处忘了改。

   数据全都走真接口（一个字节都不假造）：
     · GET    /api/plot/overview?slug=   → threads（每条带 origin：谁定的）
     · POST   /api/plot/thread           → 加一条 / 改一条（走过的就是"你定的"）
     · DELETE /api/plot/thread?slug&id   → 删一条
   「AI 不许覆盖用户改过的条目」那条规矩在后端 + 工具层（tools/check_outline.py 有判据），
   这里做的是：**把"谁定的"摆在明面上**，让用户一眼看见自己的改动生效了。
   ============================================================ */
(function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const qs = (o) => Object.entries(o || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const get = (p, q) => window.API.nb(p + (q ? '?' + qs(q) : ''));
  const post = (p, b) => window.API.nb(p, { method: 'POST', body: b || {} });
  const del = (p, q) => window.API.nb(p + (q ? '?' + qs(q) : ''), { method: 'DELETE' });
  const ico = (n) => '<span class="tr-ico">' + window.iconHtml(n) + '</span>';
  const toast = (m) => { try { App.toast(m); } catch (e) {} };
  const hap = () => { try { App.haptic(6); } catch (e) {} };
  const uid = (n) => 'ol-' + String(n == null ? '' : n);

  const KIND = { main: '主线', sub: '支线', romance: '感情线', mystery: '悬念线' };
  const ST = { open: '进行中', done: '已收', paused: '搁着' };
  /* 「谁定的」——后端每条 thread 都带 origin，缺省当用户定的（老数据都是用户建的） */
  const mineOf = (t) => ((t && t.origin) || 'user') === 'user';

  /* 反证钩子（只有判据用）：`window.__NB_STORY_FORCE`
       'nobadge' → 假装没有"谁定的"这个徽标（用户就看不见自己的改动生效了）
       'nostat'  → 假装没有统计行
     产品逻辑本身不依赖它，勾上它只是把界面退回到"没做这一版"的样子。 */
  const F = () => window.__NB_STORY_FORCE || '';

  const S = { slug: null, ov: null, err: null, filter: 'all', open: null, host: null, wired: false };

  /* ── 每本书各自记着"我筛到哪一档"（切书回来还是那一档；不串书） ── */
  const fkey = (slug) => 'outline.filter.' + (slug || '');

  function stateEl(o) {
    if (window.UI && UI.state) return UI.state(o);
    const d = document.createElement('div');
    d.className = 't-empty';
    d.textContent = o.title || '';
    return d;
  }

  function counts(ths) {
    const mine = ths.filter(mineOf).length;
    return { all: ths.length, mine: mine, ai: ths.length - mine };
  }

  function summaryLine(t) {
    return [KIND[t.kind] || t.kind || '主线', ST[t.status] || t.status || '进行中']
      .filter(Boolean).join(' · ');
  }

  function rowHtml(t) {
    const mine = mineOf(t);
    return '<div class="t-row ol-row" data-th="' + esc(t.id) + '">' + ico('bookmark') +
      '<div class="tr-main">' +
        '<div class="tr-title">' + esc(t.name || '（还没写名字）') +
          (F() === 'nobadge' ? '' : ' <span class="t-pill ' + (mine ? 'ok' : 'gray') + '">' +
            (mine ? '你定的' : 'AI 补的') + '</span>') +
        '</div>' +
        '<div class="tr-sub">' + esc(summaryLine(t)) + '</div>' +
        /* 大纲正文**换行显示，不许截断**（用户：「手机上很多字儿都看不到」） */
        (t.summary ? '<div class="ol-sum">' + esc(t.summary) + '</div>' : '') +
      '</div>' +
      '<div class="ol-acts">' +
        '<button class="t-btn sm ol-act" data-oledit="' + esc(t.id) + '" aria-label="改这条大纲">改</button>' +
        '<button class="t-btn sm dim ol-act" data-olrm="' + esc(t.id) + '" aria-label="删这条大纲">删</button>' +
      '</div>' +
      '</div>' +
      /* 点开才看到的"这条线挂在哪"（默认不占地方） */
      '<div class="ol-scenes" data-olout="' + esc(t.id) + '" hidden></div>';
  }

  function render() {
    const host = S.host; if (!host) return;
    if (S.err) {
      const again = document.createElement('button');
      again.className = 'btn sm';
      again.textContent = '重试';
      again.onclick = () => reload();
      host.innerHTML = '';
      host.appendChild(stateEl({
        kind: 'error', icon: 'refresh',
        title: S.err.title || '大纲读不到', desc: S.err.desc || '点「重试」再来一次。',
        actions: [again],
      }));
      return;
    }
    if (!S.ov) { host.innerHTML = ''; host.appendChild(stateEl({ kind: 'loading', title: '正在读大纲…' })); return; }
    const ths = S.ov.threads || [];
    const c = counts(ths);
    const shown = ths.filter((t) => S.filter === 'all' || (S.filter === 'mine' ? mineOf(t) : !mineOf(t)));
    host.innerHTML =
      '<div class="t-hint">大纲管三件事：<b>别忘</b>（写长了替 AI 记着前面的设定）、' +
        '<b>别写偏</b>（这本书要往哪走、什么调子）、<b>别写走样</b>（人物该是什么样）。' +
        '<b>你改过的条目以你为准，AI 不会自己覆盖。</b></div>' +
      (F() === 'nostat' ? '' :
        '<div class="ol-stat">共 <b>' + c.all + '</b> 条 · 你定的 <b>' + c.mine +
        '</b> 条 · AI 补的 <b>' + c.ai + '</b> 条</div>') +
      '<div class="t-chips ol-chips">' +
        [['all', '全部', c.all], ['mine', '你定的', c.mine], ['ai', 'AI 补的', c.ai]].map(([k, label, n]) =>
          '<button class="t-pill' + (S.filter === k ? ' on' : ' gray') + '" data-olfilter="' + k + '">' +
          label + ' <b>' + n + '</b></button>').join('') +
      '</div>' +
      '<div class="t-bar"><button class="t-btn pri ol-add" data-olnew>加一条</button></div>' +
      (shown.length
        ? '<div class="t-list ol-list">' + shown.map(rowHtml).join('') + '</div>'
        : '<div class="t-empty">' +
            (S.filter === 'mine' ? '你还没定过条目 —— 下面「加一条」写的都算你定的。'
              : S.filter === 'ai' ? '还没有 AI 补的条目。'
                : '还没有大纲 —— 点上面「加一条」，写清这本书要往哪走，' +
                  '比如「主线：主角被逐出宗门 → 一路打回山门」') + '</div>');
    wire();
  }

  function wire() {
    const host = S.host; if (!host) return;
    const ths = (S.ov && S.ov.threads) || [];
    const add = host.querySelector('[data-olnew]');
    if (add) add.onclick = async () => { hap(); if (await editOne(null)) reload(); };
    host.querySelectorAll('[data-olfilter]').forEach((b) => {
      b.onclick = () => {
        hap();
        S.filter = b.dataset.olfilter;
        try { localStorage.setItem(fkey(S.slug), S.filter); } catch (e) {}
        render();
      };
    });
    host.querySelectorAll('[data-oledit]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        hap();
        const t = ths.find((x) => String(x.id) === String(b.dataset.oledit));
        if (t && (await editOne(t))) reload();
      };
    });
    host.querySelectorAll('[data-olrm]').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        App.confirm('删掉这条大纲？（正文一个字不动）', async () => {
          try { await del('/api/plot/thread', { slug: S.slug, id: b.dataset.olrm }); toast('删了'); hap(); }
          catch (err) { toast('删不掉：' + err.message); return; }
          reload();
        });
      };
    });
    /* 点一行 = 看这条线挂在哪。**不换页、不弹窗**（手机上多一层就多一次返回） */
    host.querySelectorAll('[data-th]').forEach((r) => {
      r.onclick = () => {
        const out = host.querySelector('[data-olout="' + r.dataset.th + '"]');
        if (!out) return;
        hap();
        const show = out.hidden;
        host.querySelectorAll('[data-olout]').forEach((o) => { o.hidden = true; });
        if (!show) return;
        const t = ths.find((x) => String(x.id) === String(r.dataset.th)) || {};
        const sc = t.scenes || [];
        out.innerHTML = '<div class="t-hint">「' + esc(t.name || '') + '」挂在这些场景上</div>' +
          (sc.length
            ? sc.map((sp) => '<div class="ol-scene">' + ico('layers') +
                '<span>' + esc(sp) + '</span></div>').join('')
            : '<div class="t-empty">这条线还没挂场景（在「剧情」工具的「场景」页签里挂）</div>');
        out.hidden = false;
      };
    });
  }

  /* 加一条 / 改一条 —— 全站同一个表单（App.form），不另拼一套 markup */
  async function editOne(t) {
    const r = await App.form({
      title: t ? '改这条大纲' : '新加一条大纲',
      ok: '存下来',
      fields: [
        { key: 'name', label: '叫什么', value: t ? (t.name || '') : '',
          placeholder: '比如：主角复仇线' },
        { key: 'summary', label: '这条线怎么走', value: t ? (t.summary || '') : '',
          multiline: true, rows: 4,
          placeholder: '比如：被逐出师门 → 拜入新宗门 → 决赛对上旧敌' },
      ],
    });
    if (!r) return null;
    const name = (r.name || '').trim();
    if (!name) { toast('得给它起个名字'); return null; }
    const body = {
      slug: S.slug, name: name, kind: (t && t.kind) || 'main',
      status: (t && t.status) || 'open', summary: (r.summary || '').trim(),
    };
    if (t) body.id = t.id;
    try {
      await post('/api/plot/thread', body);
      toast(t ? '改好了（这条算你定的）' : '加好了（这条算你定的）');
    } catch (e) { toast('存不下：' + e.message); return null; }
    return name;
  }

  async function reload() {
    if (!S.slug) return;
    S.err = null;
    S.ov = null;
    render();
    try {
      S.ov = await get('/api/plot/overview', { slug: S.slug });
    } catch (e) {
      const off = !!(e && (e.offline || e.status === 0));
      S.err = {
        title: off ? '大纲读不到：连不上服务器' : '大纲读不到',
        desc: (off ? '看看手机是不是断网了，或者服务器在重启。'
          : (e && e.message ? e.message + '。' : '')) + '点「重试」再来一次。',
      };
      S.ov = null;
    }
    render();
  }

  window.Outline = {
    /* host：往哪儿画；slug：哪本书；opts.title：可选的节标题（不传就不画） */
    mount(host, slug, opts) {
      S.host = host;
      S.slug = slug;
      S.filter = (function () { try { return localStorage.getItem(fkey(slug)) || 'all'; } catch (e) { return 'all'; } })();
      if (opts && opts.title) {
        const h = document.createElement('h3');
        h.className = 'ol-head';
        h.textContent = opts.title;
        host.innerHTML = '';
        host.appendChild(h);
      }
      return reload();
    },
    reload,
    quit() { S.host = null; S.ov = null; S.err = null; },
    state: S,
    /* 判据用：现在呈现出来的是大纲（而不是别的东西） */
    isOutline: (host) => !!(host && host.querySelector('[data-olnew]')),
  };
})();
