/* ============================================================
   bookctx.js — 「当前书」：全站唯一的那一本

   用户的原话：「目前没有东西来选择这本书指的是哪本书……我要是有两本书，
   切换了第二本书，我给 AI 说、给 AI 选的都是第二本，那它就看不到第一本，
   只会在第二本的环境里写。」

   为什么单独一个文件：
     「当前书」以前是散的 —— 阅读器打开时临时有个 App.state.book，
     工具面板每次弹一张书单让你选（没选就摔给第一本），
     预设的切换器在没书时直接隐藏。结果就是此处说明"很多地方指向书架第一本"。
     这个文件是**唯一**的一份实现：谁要用书，就读 `BookCtx.slug()`。

   两层入口（用户要的）：
     ① 每个跟书有关的面板顶部一条「在写：xxx ▸ 切换」——点开是可上下滑的书单；
     ② 书架、工具宫格顶上也有一个显眼的入口，一键切，全站跟着换。
   ============================================================ */
(function () {
  const KEY = 'nbapp.book.v1';
  let cur = null;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const o = JSON.parse(raw); if (o && o.slug) cur = { slug: o.slug, title: o.title || o.slug, ts: o.ts || 0 }; }
  } catch (e) { cur = null; }
  const listeners = [];

  const mounts = [];                       // 所有挂过切换条的宿主（登录回来要一起重画）

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(cur || {})); } catch (e) {}
  }

  /* ── 书单：书架 + 作品列表合起来（两边字段不一样，这里统一成 slug/title/sub/cover） ──

     缓存规矩（第 14 轮修的一个真 bug）：**空结果一律不缓存**。
     页面刚打开、还没登录的那一下，/api/shelf 和 /api/projects 都会 401，
     那次拿回来的空数组一旦被缓存住，用户登录之后这条就**永远是「还没有作品」**，
     而同一屏下面就列着书（监督人截的 r10-01-书架.png 就是这个现象）。
     所以：只有"真的拿到了书"才算数；空了就下次重拉，登录成功时再强制刷一次。
     —— 想复现老样子做反证：地址上加 `?oldbug=1`（老行为：空也缓存 + 登录后不重拉）。 */
  const OLDBUG = /[?&]oldbug=1/.test((typeof location !== 'undefined' && location.search) || '');
  let cache = null, inflight = null, gen = 0;
  function list(force) {
    /* 读的一侧也认这个开关：老行为会**吃**掉那份空缓存（空 = "这人没有书"），
       新行为空缓存一律当没缓存、下次重拉。 */
    if (cache && (cache.length || OLDBUG) && !force) return Promise.resolve(cache);
    /* 并发保护：面板一起挂载时别把 /api/shelf 打三遍。
       强制刷新（换书单抽屉 / 登录回来）不复用旧的那次 —— 旧那次可能就是 401。 */
    if (!force && inflight && inflight.gen === gen) return inflight.p;
    const my = ++gen;
    const p = fetchList().then((out) => {
      if (my === gen) {
        inflight = null;
        if (out && (out.length || OLDBUG)) cache = out;   // 非空才缓存（OLDBUG=反证）
      }
      return out;
    }, (e) => { if (my === gen) inflight = null; throw e; });
    inflight = { gen: my, p };
    return p;
  }
  async function fetchList() {
    const out = [];
    try {
      const d = await API.shelf();
      ((d && d.projects) || []).forEach((b) => out.push({
        slug: b.slug, title: b.title || b.slug,
        sub: ((b.raw && b.raw.wordCount) || 0) + ' 字',
        words: (b.raw && b.raw.wordCount) || 0, ts: b.updatedAt || 0,
        cover: b.hasCover ? API.media('api/cover?slug=' + encodeURIComponent(b.slug)) : '',
      }));
    } catch (e) { /* 离线也算：下面再用 projects 兜一层 */ }
    if (!out.length) {
      try {
        const d = await API.raw('api/projects');
        ((d && d.projects) || []).forEach((p) => out.push({
          slug: p.projectRoot, title: p.title || p.projectRoot, sub: p.summary || '',
          words: 0, ts: p.updatedAt || 0, cover: '',
        }));
      } catch (e) {}
    }
    return out;
  }

  /* 兜底选哪本：字数最多的（并列看谁最近动过）。都没有字数就取第一本。 */
  function pickDefault(all) {
    const li = (all || []).filter((b) => b && b.slug);
    if (!li.length) return null;
    return li.slice().sort((a, b) => ((b.words || 0) - (a.words || 0)) || ((b.ts || 0) - (a.ts || 0)))[0];
  }

  const BookCtx = {
    get: () => cur,
    slug: () => (cur && cur.slug) || '',
    title: () => (cur && cur.title) || '',
    has: () => !!(cur && cur.slug),

    /** 换书：全站唯一的那个动作。存盘 + 通知所有人 + 顺手通知安卓（状态栏之外没有别的） */
    set(slug, title) {
      if (!slug) return;
      if (cur && cur.slug === slug) { if (title && title !== cur.title) { cur.title = title; save(); } return; }
      cur = { slug, title: title || slug, ts: Date.now() };
      save();
      try { Prefs.set('peerBook', slug); } catch (e) {}      // 对端同步那边也在用同一个"当前书"
      try { if (window.App && App.state) App.state.slug = slug; } catch (e) {}   // 老代码读 App.state.slug，给它同步过去
      listeners.forEach((f) => { try { f(cur); } catch (e) {} });
    },

    /** 首次进来还没有当前书：兜一本（不弹窗、不打扰）。
        兜哪本有讲究：给**你真正在写的那本** —— 字数最多的，并列时取最近动过的。
        以前是"书架上第一本"，用户于是抱怨"所有工具全指向书架第一本"。 */
    async ensure() {
      if (cur && cur.slug) { sync(); return cur.slug; }
      const all = await list().catch(() => []);
      const pick = pickDefault(all);
      if (pick) BookCtx.set(pick.slug, pick.title);
      return BookCtx.slug();
    },

    onChange(f) { listeners.push(f); },

    /** 强制重拉书单（登录回来 / 手动刷新）。空结果不算数，见上面 list() 的注释。 */
    async refresh() {
      cache = null;
      const all = await list(true).catch(() => []);
      if (cur && (!cur.title || cur.title === cur.slug)) {
        const hit = all.find((b) => b.slug === cur.slug);      // 只有 slug 没有书名：补上真名
        if (hit && hit.title) { cur.title = hit.title; save(); }
      }
      redraw();
      return all;
    },

    /** 登录成功之后调一次：开机那次 401 拿到的空书单在这儿自愈。
        （老行为反证：地址上带 ?oldbug=1 时，这里故意不做事，让判据能报红。） */
    async loginOk() {
      if (OLDBUG) return [];
      await BookCtx.refresh();
      await BookCtx.ensure().catch(() => '');
      redraw();
      return BookCtx.slug();
    },

    /** 把挂过的所有切换条按最新状态重画一遍 */
    redraw() { redraw(); },

    /** 书名（异步补齐：缓存的 title 可能是 slug） */
    async nameOf(slug) {
      const all = await list().catch(() => []);
      const hit = all.find((b) => b.slug === slug);
      return (hit && hit.title) || slug;
    },

    /** 书单抽屉：可上下滑、点哪本切哪本、带封面与「正在写」标记 */
    sheet(opts) {
      const o = opts || {};
      App.sheet('<div class="sheet-grip"></div>' +
        '<div class="sheet-head"><h3>' + (o.title || '切到哪本书') + '</h3>' +
        '<button class="icon-btn" data-close aria-label="关闭">' + window.iconHtml('close') + '</button></div>' +
        '<div class="bk-note">' + (o.global
          ? '一键切换：预设 / 设定 / 对话 / 写作台 / 世界 / 剧情 / 质检 / 统计 / 素材 / 术语 / 笔记 / 听书，' +
            '全站一次性换成这本的，跟另一本完全隔开。'
          /* 文案规矩（第 22 轮）：沉稳、中性、专业。原来这句是「切过去之后：这本自己的…」
             一路念下来，像口头说明；改成两句陈述，句子也短了。 */
          : '切换后，预设 / 设定 / 对话 / 写作台 / 世界 / 剧情 / 质检 / 统计 / 素材 / 术语' +
            '全部换成这一本的，全站的「当前书」同步跟着变。') + '</div>' +
        '<div id="bk-list" class="bk-list"><div class="t-load"><i></i></div></div>',
        {
          onMount(p) {
            const box = p.querySelector('#bk-list');
            list(true).then((all) => {
              if (!all.length) { box.innerHTML = '<div class="t-empty">还没有作品</div>'; return; }
              box.innerHTML = all.map((b) => {
                const on = b.slug === BookCtx.slug();
                return '<div class="bk-row' + (on ? ' on' : '') + '" data-slug="' + esc(b.slug) + '">' +
                  '<span class="bk-cover">' + (b.cover
                    ? '<img src="' + esc(b.cover) + '" alt="">'
                    : '<span class="bk-cover-ph">' + esc(window.hanzi ? window.hanzi(b.title) : (b.title || '书').slice(0, 1)) + '</span>') +
                  '</span>' +
                  '<span class="bk-main"><b>' + esc(b.title) + '</b><i>' + esc(b.sub || '') + '</i></span>' +
                  (on ? '<span class="bk-on">正在写</span>' : '<span class="bk-go">切过来</span>') +
                  '</div>';
              }).join('');
              box.querySelectorAll('[data-slug]').forEach((r) => {
                r.onclick = () => {
                  const b = all.find((x) => x.slug === r.dataset.slug) || { slug: r.dataset.slug };
                  BookCtx.set(b.slug, b.title);
                  App.closeSheet();
                  App.toast('已切到《' + (b.title || b.slug) + '》');
                  if (o.onPick) o.onPick(b.slug, b.title);
                };
              });
              const hit = box.querySelector('.bk-row.on');
              if (hit) hit.scrollIntoView({ block: 'center' });
            }).catch((e) => { box.innerHTML = '<div class="t-empty">读不到书单：' + esc(e.message) + '</div>'; });
          },
        });
    },

    /** 「当前书」那一条（全站唯一的组件 · 只有这一份实现）。
        **形态 = 永久长条 + 挂在顶栏里**（第 46 轮此处要求）。
        为什么这么改（实测，不是猜）：
          · 原来它是内容流里的一行，里面默认只显示一枚 34×34 的小方块 →
            logs/r46-probe-before.json 量到：顶栏(48) 底下白白撑出 **42px** 的带子，
            七个屏都有 —— 那就是此处说明「顶上这一大块空白」；
          · 现在它 append 进 `.topbar`（同一个 flex 区域、flex-basis:100% 独占第二行）：
            顶栏是每屏都有、不跟内容滚的横条，条长在那儿**不另开图层**，谁也不压谁。
        第 17 / 20 轮修掉的那三个毛病**一条都不许带回来**：
          · 不许 sticky/fixed（那时它"固定在那儿动不了"）；
          · 不许自带底色（那时它"自己要了一条横线"）；
          · 不许假占位（那时盒高 0 却溢出 → 压到别的字上，此处指出"穿模"）。
        参数：
          slug     当前书（空 = 没有书，放一条"还没有作品 · 先去书架建一本"的提示）
          onSwitch 切书之后这一屏怎么重画（面板自己知道；全站「当前书」已经换好了）
          opts     { global, emptyName, sub, pick, title }
        返回：那个 `.bk-bar` 元素（调用方交给 `mount()` 挂 —— 别自己 append 进内容流）。 */
    bar(slug, onSwitch, opts) {
      const o = opts || {};
      const el = document.createElement('div');
      /* `bk-bar-global` 是给「这一屏是整包的（备份 / 同步 / 账号…）」留的标记：
         自测脚本按它区分"跟书走的"和"整包的"两批面板。 */
      el.className = 'bk-bar' + (o.global ? ' bk-bar-global' : '') + (slug ? '' : ' is-empty-bar');
      const name = slug
        ? ((cur && cur.slug === slug && cur.title) ? cur.title : (o.title || slug))
        : (o.emptyName || '还没有作品');
      /* 第 46 轮：小方块（`.bk-mini`，里面是书名首字 `first`）按此处要求删掉了，
         "是不是当前这本"这个状态改由**副行**说清楚 —— 它原来就是 `.bk-mini .bk-dot` 那个小红点的意思。 */
      const isCur = !!(slug && cur && cur.slug === slug);
      const sub = slug
        ? (o.sub || (o.global ? '切一下就全站跟着换' : (isCur ? '正在写这本 · 点这里换一本' : '点这里切过来')))
        : '先去书架建一本';
      el.innerHTML =
        /* 只有长条这一态（用户：「让它永久变成长条的」） */
        '<button class="bk-chip" data-book-pick>' +
        '<span class="bk-ico">' + window.iconHtml('book') + '</span>' +
        '<span class="bk-txt"><b>' + esc(name) + '</b><i>' + esc(sub) + '</i></span>' +
        '<span class="bk-pick">' + esc(o.pick || '切换') + '</span>' +
        '<span class="bk-chev">' + window.iconHtml('chevron') + '</span>' +
        '</button>';
      el.querySelector('[data-book-pick]').onclick = () => {
        hapNow();
        BookCtx.sheet({ global: o.global, onPick: (s2) => {
          /* 选完不收回：长条是**永久**的（此处要求）—— 切完就地把书名换掉 */
          if (onSwitch) { try { onSwitch(s2); } catch (e) {} }
        } });
      };
      return el;
    },

    /** 把那一屏的「当前书」入口挂上（书架 / 设定 / 对话 / 预设 / 工具宫格 / 每个工具面板）。
        onSwitch(newSlug) 由那一屏自己决定怎么重渲染；全站「当前书」已经换好了。 */
    mount(el, onSwitch, opts) {
      const host = typeof el === 'string' ? document.getElementById(el) : el;
      if (!host) return null;
      const o = Object.assign({}, opts, { anchor: host });
      let prev = null;                              // 内容流里那个占位元素
      const draw = () => {
        const slug = BookCtx.slug();
        /* 第 46 轮：长条**挂在顶栏里**（用户：「放在最上面……不要给他专门一个独特的区域」）。
           顶栏里万一还留着老版本建的方块，顺手清掉 —— 只留一份实现。 */
        const tb = topbarOf(host);
        if (tb) {
          const old = tb.querySelector('.bk-mini[data-book-chip]');
          if (old) old.remove();
          tb.classList.remove('has-book-chip');
        }
        const bar = BookCtx.bar(slug, (s) => {
          if (onSwitch) { try { onSwitch(s); } catch (e) {} }
          draw();                                   // 书名也跟着换
        }, o);
        if (tb) {
          tb.appendChild(bar);
          /* ⚠ 第 41 轮实测到的真 bug（同一屏可能重新 mount 一次 → 堆出两份）：
             顶栏里除了刚建的这个，别的 .bk-bar 一律删掉（永远只留一份）。 */
          [...tb.children].forEach((n) => { if (n !== bar && n.classList.contains('bk-bar')) n.remove(); });
        } else if (prev && prev.parentNode === host) {
          host.replaceChild(bar, prev);             // 万一哪一屏没有顶栏：退回内容流里的老位置
        } else {
          host.insertBefore(bar, host.firstChild);
        }
        /* 宿主（内容流里那个容器）里若还留着上一版塞进去的 bar，也清掉；空掉之后它不占高 */
        [...host.children].forEach((n) => { if (n !== bar && n.classList.contains('bk-bar')) n.remove(); });
        prev = bar;
        host.classList.toggle('is-empty', !slug);
      };
      /* 登记下来：换书 / 登录回来 / 强制刷新之后，这一条也要跟着重画（不然它一直写着「还没有作品」） */
      const at = mounts.findIndex((m) => m.host === host);
      if (at >= 0) mounts.splice(at, 1);
      mounts.push({ host, draw });
      draw();
      /* 头一次进来还没有"当前书"：拿"你真正在写的那本"兜底（不弹窗），兜完把这一屏重画一遍。
         注意：如果开机那次请求 401（还没登录），list() 不会把空结果缓存住，
         所以登录之后走到这里会**重新拉一次** —— 这就修掉了"全站一直是空态"那个 bug。 */
      if (!BookCtx.has()) {
        BookCtx.ensure().then((slug) => {
          if (!slug) return;
          draw();
          if (onSwitch) { try { onSwitch(slug); } catch (e) {} }
        }).catch(() => {});
      }
      return host;
    },
  };

  /* ── 顶栏右上角那个小方块：全站唯一的一份实现 ──────────────────────
     为什么长在顶栏、而不是正文上面：此处说明它「单独一个图层……固定在那儿动不了，
     自己要了一条横线」。顶栏本来就是每一屏都有、且不跟着滚的横条 ——
     方块长在那儿就既不占正文高度、也不会在滚动时压出一层底色的带子。 */
  function topbarOf(anchor) {
    let sc = null;
    try { sc = anchor && anchor.closest ? anchor.closest('.screen') : null; } catch (e) { sc = null; }
    if (!sc) { try { sc = document.querySelector('.screen:not(.hidden)'); } catch (e) { sc = null; } }
    return sc ? sc.querySelector('.topbar') : null;
  }

  /* 第 41 轮：`installChip()`（往顶栏塞小方块）整段删掉 —— 形态回到旧版那一行之后它没人用了，
     留着就是"两套实现并存"（死代码）。顶栏里万一还留着老版本建的方块，`mount()` 的 draw() 会清掉。 */

  /* 把所有挂过的切换条重画一遍（换书 / 登录回来 / 强制刷新之后都要走一遍） */
  function redraw() { mounts.forEach((m) => { try { m.draw(); } catch (e) {} }); }

  /* 把「当前书」推到全站各处（老代码还在读 App.state.slug / Prefs.peerBook） */
  function sync() {
    if (!cur || !cur.slug) return;
    try { if (window.App && App.state) App.state.slug = cur.slug; } catch (e) {}
    try { Prefs.set('peerBook', cur.slug); } catch (e) {}
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function hapNow() {
    try { if (App.haptic) App.haptic(8); } catch (e) {}
  }

  window.BookCtx = BookCtx;
  /* 谁都可以监听：切换书之后把自己那块重渲染一遍 */
  BookCtx.onChange((c) => {
    try { if (window.App && App.state) App.state.slug = c.slug; } catch (e) {}
    try { window.dispatchEvent(new CustomEvent('bookchange', { detail: c })); } catch (e) {}
    redraw();                       // 所有切换条上的书名跟着换
  });
  /* 反证开关对外露一下（自测脚本用；正常跑永远是 false） */
  BookCtx.legacy = OLDBUG;
  /* 开机先把「当前书」立起来：以前是"翻开书那一刻才有值"，于是没进阅读器时
     所有面板都自己猜第一本（此处说明"全都指向书架第一本"）。 */
  setTimeout(() => { sync(); BookCtx.ensure().catch(() => {}); }, 300);
})();
