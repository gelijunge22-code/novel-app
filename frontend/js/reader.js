/* ============================================================
   reader.js — 书架（window.Shelf）+ 阅读器（window.Reader）
   纯原生 JS，无构建、无依赖、无图片；接口全部相对路径。
   ============================================================ */
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.prototype.slice.call((r || document).querySelectorAll(s));

  /* ══════════════════════ 工具 ══════════════════════ */
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const isCJK = (c) => /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/.test(c || '');

  function hashHue(str) {
    let h = 7;
    for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) % 360;
    return h;
  }
  // 第001章-未命名 → 第001章 未命名
  const prettyName = (n) => String(n || '').replace(/[-_]+/g, ' ').trim();

  function debounce(fn, ms) {
    let t = null;
    return function () {
      const a = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(() => fn.apply(self, a), ms || 160);
    };
  }

  /* ══════════════════════ Markdown → HTML ══════════════════════ */
  function inlineMd(s) {
    let t = s;
    t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, '');       // 图片丢掉
    t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');    // 链接只留文字
    t = t.replace(/`([^`]*)`/g, '$1');
    t = t.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    t = t.replace(/~~([^~\n]+)~~/g, '$1');
    t = t.replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s,.;:!?)]|$)/g, '$1<em>$2</em>');
    t = t.replace(/\\([\\`*_[\]()#+\-.!])/g, '$1');
    return t;
  }

  /* 正文 Markdown → 干净 HTML：不残留符号、不出现 JSON / [tool:...] */
  function mdToHtml(md) {
    let src = String(md || '').replace(/\r\n?/g, '\n');
    if (src.slice(0, 4) === '---\n') {                 // YAML front-matter
      const i = src.indexOf('\n---', 4);
      if (i > 0) src = src.slice(i + 4);
    }
    src = src.replace(/^\s*\[tool:[^\n]*$/gim, '');
    src = src.replace(/^\s*```[^\n]*$/gm, '\n');       // 代码围栏只去符号
    const lines = src.split('\n');
    const out = [];
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      let txt = '';
      for (let k = 0; k < buf.length; k++) {
        if (k === 0) { txt = buf[k]; continue; }
        txt += (isCJK(txt.slice(-1)) && isCJK(buf[k][0])) ? '' : ' ';
      }
      out.push('<p>' + inlineMd(esc(txt)) + '</p>');
      buf = [];
    };
    let sawText = 0;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const s = raw.trim();
      if (!s) { flush(); continue; }
      let m;
      if ((m = s.match(/^(#{1,6})\s*(.*)$/))) {          // 标题
        flush();
        const lv = clamp(m[1].length, 1, 3);
        out.push('<h' + lv + ' class="rd-h">' + inlineMd(esc(m[2] || '')) + '</h' + lv + '>');
        continue;
      }
      if (/^(?:\*\s*){3,}$/.test(s) || /^(?:-\s*){3,}$/.test(s) || /^(?:_\s*){3,}$/.test(s)) {
        flush(); out.push('<hr class="rd-hr">'); continue;
      }
      if (sawText === 0 && s.length <= 24 && /^第\s*[0-9零一二三四五六七八九十百千]+\s*章/.test(s)) {
        flush(); out.push('<h2 class="rd-h">' + inlineMd(esc(s)) + '</h2>'); continue;
      }
      if (/^\s{0,3}>/.test(raw)) {                       // 引用
        flush();
        out.push('<p class="rd-quote">' + inlineMd(esc(s.replace(/^\s{0,3}>\s?/, ''))) + '</p>');
        continue;
      }
      buf.push(s.replace(/^[-*+]\s+/, '').replace(/^\d+[.、)]\s*/, ''));
      sawText++;
    }
    flush();
    return out.join('') || '<p class="rd-quote">（本章暂无正文）</p>';
  }

  /* ══════════════════════ 抽屉/弹窗 + 手机返回键 ══════════════════════ */
  let overlayPushed = false;
  /* selfPopAt：这一次 back 是**我们自己**发的（收面板），不是用户按返回键。
     不区分的话就有这个大坑（监督人探针实测「书本菜单 → 全书搜索」面板高度 = 0）：
        closeOverlay() 的 history.back() 是异步的，popstate 要下一拍才到；
        而这两拍之间新面板已经 pushOverlay()（overlayPushed 又变 true），
        于是那一拍迟到的 popstate 把**刚开的新面板**当成"用户按了返回键"关掉了 ——
        用户看到的是"点一下闪没了 / 点了没反应"。 */
  let selfPopAt = 0;
  function curScreen() { return document.body.dataset.tab || 'shelf'; }
  function pushOverlay() {
    if (overlayPushed) return;
    overlayPushed = true;
    try { history.pushState({ nbOverlay: 1, screen: curScreen() }, '', location.hash); }
    catch (e) { overlayPushed = false; }
  }
  function closeOverlay() {
    if (!overlayPushed) return;
    overlayPushed = false;
    selfPopAt = Date.now();
    try { history.back(); } catch (e) { selfPopAt = 0; }
  }
  const _closeSheet = App.closeSheet, _closeModal = App.closeModal;
  App.closeSheet = function (cb) { _closeSheet(cb); closeOverlay(); };
  App.closeModal = function (cb) { _closeModal(cb); closeOverlay(); };
  window.addEventListener('popstate', function () {
    /* 我们自己发的那次 back（0.9 秒内到的都算）—— 面板已经收过了，什么都不用做。
       `__NB_NO_SELFPOP` 是判据的反证钩子（tools/e2e-menu.js 的 MENU_FORCE=race）：
       勾上它就等于这一版之前的写法，迟到的 popstate 会把刚开的新面板关掉。 */
    if (!window.__NB_NO_SELFPOP && selfPopAt && Date.now() - selfPopAt < 900) { selfPopAt = 0; return; }
    selfPopAt = 0;
    if (overlayPushed) { overlayPushed = false; _closeSheet(); _closeModal(); closeTocForBack(); closeQuickForBack(); }
  });
  /* 返回键收面板时**别再** closeOverlay（那会再 back 一次，退两层） */
  function closeQuickForBack() { try { closeQuick(true); } catch (e) {} }
  function closeTocForBack() { try { tocClose(true); } catch (e) {} }

  /* ══════════════════════ 书架 ══════════════════════ */
  /* 骨架屏：**全站就一份实现**（js/ui.js 的 UI.skeleton）。
     以前书架这里自己拼了一套 .skel-card，跟工具页那套长得不一样 —— 大改里删掉，
     留着就又是"两套实现"（过的那种不统一）。 */

  const Shelf = {
    projects: null, books: {}, loading: false, q: '',
    /* stale：这次刷新没连上服务器，屏上这些书是从缓存里翻出来的。
       补的：以前只在角落里飘一句 toast（几秒就没了），
       用户回头看到的就是一本本好书卡，根本不知道这数据是旧的 ——
       这跟「偷偷显示空」是同一类骗人，所以改成留在界面上的那一条 + 一个重试键。 */
    stale: '',

    onShow() {
      this.load();
      /* 书架顶上那条就是**全站一键切换**：在这儿切完，所有面板都跟着换 */
      if (window.BookCtx) {
        BookCtx.mount('shelf-book', () => this.render(), { global: true });
      }
    },

    /* 搜索：书名/标签/章节名里能对上就留下。以前书架没搜索，
       书一多只能靠肉眼顺着一排排划。 */
    matched() {
      const all = this.projects || [];
      const q = (this.q || '').trim().toLowerCase();
      if (!q) return all;
      return all.filter((p) => {
        const b = this.books[p.slug];
        const title = (b && b.title) || p.title || p.slug || '';
        if (String(title).toLowerCase().indexOf(q) >= 0) return true;
        if (String(p.slug).toLowerCase().indexOf(q) >= 0) return true;
        if (b && (b.chapters || []).some((c) => String(c.name || c.title || '')
            .toLowerCase().indexOf(q) >= 0)) return true;
        return false;
      });
    },

    toggleSearch(on) {
      const bar = $('#shelf-searchbar'), inp = $('#shelf-q');
      if (!bar) return;
      const want = (on === undefined) ? bar.classList.contains('hidden') : !!on;
      bar.classList.toggle('hidden', !want);
      if (want) setTimeout(() => { try { inp.focus(); } catch (e) {} }, 30);
      else { this.q = ''; if (inp) inp.value = ''; this.render(); }
    },
    async load(force) {
      const list = $('#shelf-list');
      /* 骨架屏，别用转圈。**空书架刷新时也要给**：
         以前只在 `projects` 还是 null 时给骨架，于是"一本书都没有 → 点刷新"这条路上
         屏幕上一点动静都没有（用户不知道它在读，还是坏了）——
         三态体检（tools/e2e-states.js 的第 ② 项）就是这么抓出来的。 */
      if (!this.projects || !this.projects.length) this.skeleton();
      if (this.loading) return;
      this.loading = true;
      this.stale = '';
      try {
        let d = null;
        try {
          d = await API.shelf();
          this.projects = (d.projects || []);
        } catch (netE) {
          // 断网：把缓存过的书当书架用，至少读过的那几本能接着看
          const cached = (window.Offline && Offline.projects()) || [];
          if (!netE.offline || !cached.length) throw netE;
          this.projects = cached;
          this.stale = '连不上服务器：现在看到的是缓存里的书';   // 留在屏上，不靠 toast
          App.toast('离线：只看得到缓存过的书');
        }
        this.render();
        const jobs = this.projects.slice();
        const worker = async () => {
          while (jobs.length) {
            const p = jobs.shift();
            try {
              const b = await API.book(p.slug, !!force);
              this.books[p.slug] = b;
              window.Offline && Offline.putBook(p.slug, b);
            } catch (e) {
              const c = window.Offline && Offline.getBook(p.slug);
              if (c) this.books[p.slug] = c;
            }
            this.render();
          }
        };
        await Promise.all([worker(), worker()]);
      } catch (e) {
        /* 出错要说人话 + 给得着手的动作。以前是把 e.message 直接糊在屏幕上，
           用户看到的就是"坏了"。 */
        this.fail(e);
      } finally { this.loading = false; }
    },

    /** 取数据时先摆骨架（比转圈更像"正在来"），空书架刷新时也给 —— 不然屏幕上一点动静都没有 */
    skeleton() {
      const list = $('#shelf-list');
      if (!list || !window.UI) return;
      const box = window.UI.h('div', { class: 'shelf-skel' }, window.UI.skeleton('list', 3));
      list.textContent = '';
      list.appendChild(box);
    },

    /** 打不开书架：说清是什么事、给一个能点的动作（不把技术错误直接甩给用户） */
    fail(e) {
      const list = $('#shelf-list');
      if (!list || !window.UI) return;
      const offline = e && (e.offline || /连接|网络|timeout|Failed/i.test(String(e.message || '')));
      const box = window.UI.state({
        kind: 'error',
        icon: 'refresh',
        title: offline ? '书架打不开：连不上服务器' : '书架打不开',
        desc: offline ? '看看手机是不是断网了，或者服务器在重启。点下面重试。'
                      : '出了点问题：' + ((e && e.message) || '未知错误'),
        actions: [window.UI.btn('重试', { variant: 'primary', act: 'shelf-reload' })],
      });
      list.textContent = '';
      list.appendChild(box);
    },

    render() {
      const list = $('#shelf-list');
      if (!this.projects || !window.UI) return;
      /* 事件**只绑一次**：绑在 #shelf-list 上做委托，render() 换的是里面的卡片、不换它自己。
         这一行是大改重写 render() 时漏掉的 —— 后果是**书卡点了没反应、整本书打不开**
         （`node tools/e2e-cover.js` 报「reader：打不开这一屏（open 返回 0）」抓出来的，
         不是猜的：探针里 `Shelf.open` 之后 body.dataset.tab 一直停在 shelf、也没有报错）。 */
      if (!list.dataset.wired) { list.dataset.wired = '1'; this.wire(list); }
      const UIx = window.UI;
      const frag = document.createDocumentFragment();

      /* 顶栏那条「数据是旧的」排在最前：连不上服务器时它是唯一说得清的东西。
         它**就是这一屏的出错态** —— 书架跟别处不一样：出错时不清空，缓存的书还看得见、
         还能点开，只在顶上写明"这是旧的、点这儿重试"。
         所以给它打上 data-state="error"：全站的三态判据认这一个标记，
         不然脚本会以为"书架出错时什么都没说"（就是这么误报的）。 */
      if (this.stale) {
        frag.appendChild(UIx.h('button', {
          class: 'shelf-stale', 'data-act': 'shelf-reload', 'data-state': 'error', 'aria-label': '重试',
        }, [UIx.h('span', { class: 'shelf-stale-dot' }),
           UIx.h('span', { text: this.stale }),
           UIx.h('b', { text: '重试' })]));
      }

      const rows = this.matched();
      if (!this.projects.length) {
        frag.appendChild(UIx.state({
          kind: 'empty', icon: 'book', title: '书架还是空的',
          desc: '点右下角的 ＋ 新建一本。写过的稿子想搬过来，可以进「工具 · 同步」。',
        }));
        list.textContent = '';
        list.appendChild(frag);
        this._painted = true;
        return;
      }
      if (!rows.length) {
        frag.appendChild(UIx.state({
          kind: 'empty', icon: 'search', title: '没找到「' + (this.q || '') + '」',
          desc: '换个词试试，或者点右上角的 × 收起搜索。',
        }));
        list.textContent = '';
        list.appendChild(frag);
        return;
      }

      const fresh = !this._painted;         // 刚进这一屏：卡片一张张浮上来
      rows.forEach((p, pi) => frag.appendChild(this.card(p, pi, fresh)));
      list.textContent = '';
      list.appendChild(frag);
      this._painted = true;
    },

    /** 一张书卡：**封面当主角**（一眼认出是哪本），书名第二眼，字数是辅助信息。 */
    card(p, pi, fresh) {
      const UIx = window.UI;
      const b = this.books[p.slug];
      const pg = Progress.get(p.slug);
      const title = (b && b.title && b.title !== b.slug) ? b.title : (p.title || p.slug);
      const first = String(title || '书').trim()[0] || '书';
      const isCur = !!(window.BookCtx && BookCtx.slug() === p.slug);

      let meta = String(p.slug || '');
      let cta = '打开';
      let pct = null;
      if (b) {
        const total = b.totalWords || 0;
        const idx = (pg && pg.path) ? b.chapters.findIndex((c) => c.path === pg.path) : -1;
        meta = UIx.fmt.words(total) + ' · 共 ' + b.chapters.length + ' 章' +
          (idx >= 0 ? ' · 读到第' + b.chapters[idx].index + '章' : '');
        if (idx >= 0 && total > 0) {
          let before = 0;
          for (let i = 0; i < idx; i++) before += b.chapters[i].words || 0;
          pct = Math.round(clamp((before + (b.chapters[idx].words || 0) * ((pg.percent || 0) / 100)) / total, 0, 1) * 100);
        }
        cta = idx >= 0 ? '继续阅读' : '开始读';
      } else if (pg) {
        meta = '读到 ' + String(pg.path || '').split('/').pop().replace(/\.md$/, '');
      } else {
        meta = '还没读过';
      }

      const spine = UIx.h('div', { class: 'book-spine', style: { '--h': hashHue(p.slug) } }, [
        UIx.h('span', { text: first }),
        p.hasCover ? UIx.h('img', {
          class: 'book-cover', alt: '', loading: 'lazy',
          src: API.media('api/cover?slug=' + encodeURIComponent(p.slug)),
          onerror: function () { this.remove(); },
        }) : null,
      ]);

      const info = UIx.h('div', { class: 'book-info' }, [
        /* 书名**独占一行、最多两行**（长书名换行，不许被「正在写」小标挤成省略号 ——
           那条：「字数你最好得放到框里，你超出来就不好看了」）。
           「正在写」小标挪到下一行的信息行里，跟字数、进度排在一起。 */
        UIx.h('div', { class: 'book-title' }, UIx.h('span', { class: 'bt-txt', text: title })),
        UIx.h('div', { class: 'book-meta' },
          isCur ? UIx.h('span', { class: 'book-cur', text: '正在写' }) : null,
          UIx.h('span', { class: 'bm-txt', text: meta })),
        UIx.h('div', { class: 'book-prog' }, [
          UIx.h('div', { class: 'book-prog-bar' }, UIx.h('i', { style: { width: (pct || 0) + '%' } })),
          UIx.h('span', { class: 'book-prog-txt', text: pct == null ? '未开始' : pct + '%' }),
          UIx.h('span', { class: 'book-cta', text: cta + ' ›' }),
        ]),
      ]);

      const card = UIx.h('article', {
        class: 'book-card' + (fresh ? ' enter' : '') + (isCur ? ' cur' : ''),
        'data-slug': p.slug,
      }, [spine, info, UIx.iconBtn({ icon: 'more', sm: true, label: '更多', cls: 'book-more' })]);
      if (fresh) card.style.animationDelay = (pi * 55) + 'ms';
      return card;
    },

    wire(list) {
      let pressTimer = null, pressedCard = null, moved = false;
      const cardAt = (t) => (t && t.closest ? t.closest('.book-card') : null);

      list.addEventListener('click', (e) => {
        const card = cardAt(e.target);
        if (!card) return;
        if (e.target.closest('.book-more')) { Shelf.menu(card.dataset.slug); return; }
        if (list.dataset.suppress === '1' || moved) { moved = false; return; }
        App.riseCard && App.riseCard(card);     // 书卡托起，和阅读页推入叠在一起
        Shelf.open(card.dataset.slug);
      });

      list.addEventListener('touchstart', (e) => {
        const card = cardAt(e.target); if (!card) return;
        moved = false; pressedCard = card;
        card.classList.add('press');
        pressTimer = setTimeout(() => {
          pressTimer = null; list.dataset.suppress = '1'; moved = true;
          card.classList.remove('press');
          Shelf.menu(card.dataset.slug);
          if (navigator.vibrate) { try { navigator.vibrate(12); } catch (er) {} }
        }, 560);
      }, { passive: true });

      list.addEventListener('touchmove', () => {
        moved = true;
        clearTimeout(pressTimer); pressTimer = null;
        if (pressedCard) pressedCard.classList.remove('press');
      }, { passive: true });

      list.addEventListener('touchend', () => {
        clearTimeout(pressTimer); pressTimer = null;
        if (pressedCard) pressedCard.classList.remove('press');
        if (moved) list.dataset.suppress = '1';
        setTimeout(() => { list.dataset.suppress = ''; moved = false; }, 90);
      });

      const rf = $('#btn-shelf-refresh');
      if (rf) rf.addEventListener('click', () => {
        this.books = {};
        this.load(true);
        App.toast('正在刷新字数…');
      });

      const nb = $('#btn-shelf-new');
      if (nb) nb.addEventListener('click', () => { App.haptic(); this.newBook(); });

      /* 顶栏搜索：收起时只留一个图标（右侧和「刷新」并排，顶栏不再左重右空） */
      const sb = $('#btn-shelf-search');
      if (sb) sb.addEventListener('click', () => {
        App.haptic();
        this.toggleSearch();
        if (!$('#shelf-searchbar').classList.contains('hidden')) setTimeout(() => {
          try { $('#shelf-q').focus(); } catch (e) {}
        }, 40);
      });
      const sbc = $('#btn-shelf-q-close');
      if (sbc) sbc.addEventListener('click', () => { App.haptic(); this.toggleSearch(false); });
      const sq = $('#shelf-q');
      if (sq) sq.addEventListener('input', () => {
        this.q = sq.value || '';
        this.render();
      });

      /* 下拉刷新：列表在最顶上时往下拽一下 */
      let sy = 0, pulling = false, ptr = null;
      const ensurePtr = () => {
        if (ptr) return ptr;
        ptr = document.createElement('div');
        ptr.className = 'ptr';
        ptr.innerHTML = '<span class="spinner"></span>';
        const sc = list.closest('.screen') || list.parentNode;
        sc.appendChild(ptr);
        return ptr;
      };
      list.addEventListener('touchstart', (e) => {
        if (list.scrollTop > 0) { pulling = false; return; }
        sy = e.touches[0].clientY; pulling = true;
      }, { passive: true });
      list.addEventListener('touchmove', (e) => {
        if (!pulling || list.scrollTop > 0) return;
        if (e.touches[0].clientY - sy > 10) ensurePtr().classList.add('on');
      }, { passive: true });
      list.addEventListener('touchend', (e) => {
        if (!pulling) return;
        pulling = false;
        const dy = (e.changedTouches && e.changedTouches[0] ? e.changedTouches[0].clientY : sy) - sy;
        if (ptr) {
          if (dy > 64) {
            this.books = {};
            this._painted = false;
            this.load(true);
            App.haptic();
          }
          setTimeout(() => ptr && ptr.classList.remove('on'), 500);
        }
      }, { passive: true });
    },

    open(slug, mode) {
      App.state.readerReturn = 'shelf';
      const pg = Progress.get(slug);
      if (mode === 'restart' || !pg || !pg.path) {
        if (mode === 'restart') Progress.clear(slug);
        Reader.pending = { slug: slug, restart: true };
      } else {
        Reader.pending = { slug: slug, path: pg.path, percent: pg.percent };
      }
      Shelf.openBook(slug, Reader.pending);
    },

    /* 先备数据、再切屏。
       原来顺序是反的：先 App.show('reader') 把空白阅读页推出来，
       再联网拉书和第一章，回来才蹦字 —— 那一下就是「闪屏」。
       现在等数据到手再切，openReader 全程同步，一帧画完，动画期间不会再有东西蹦出来。 */
    async openBook(slug, cmd) {
      const card = document.querySelector('.book-card[data-slug="' + slug + '"]');
      if (card) card.classList.add('opening');
      const done = () => { if (card) card.classList.remove('opening'); };
      try {
        await Reader.preload(slug, cmd);
      } catch (e) {
        done();
        App.toast('打不开：' + ((e && e.message) || ''));
        return;
      }
      done();
      App.show('reader');
    },

    menu(slug) {
      const b = this.books[slug];
      const pg = Progress.get(slug);
      const proj = (this.projects || []).find((p) => p.slug === slug) || {};
      const title = (b && b.title && b.title !== b.slug ? b.title : (proj.title || slug));
      const readName = pg && pg.path ? prettyName(pg.path.split('/').pop().replace(/\.md$/, '')) : '';
      const chs = (b && b.chapters.length) || 0;
      /* 一行 = 左边"干什么" + 右边"会怎样"（右栏**紧挨着**主文字成一组，不是甩到屏幕另一头）
         + 最右一个 › 提示"这行能点"。每行都要能答出"点下去会发生什么"，答不出就不该出现在菜单里。 */
      const row = (a, nm, sub, cls) =>
        '<div class="rd-toc-item' + (cls ? ' ' + cls : '') + '" data-a="' + a + '">' +
        '<span class="nm">' + nm + '</span>' +
        '<span class="wd">' + (sub || '') + '</span>' +
        '<span class="go">' + iconHtml('chevron') + '</span></div>';
      pushOverlay();
      App.sheet(
        '<div class="sheet-grip"></div>' +
        '<div class="sheet-head rd-menu-head"><div class="rd-menu-title">' + esc(title) + '</div>' +
        '<button class="icon-btn" data-close aria-label="关闭">' + iconHtml('close') + '</button></div>' +
        '<div class="rd-menu-body">' +
          '<div class="rd-toc-group">' + (b
            ? '共 ' + chs + ' 章 · ' + (b.totalWords || 0).toLocaleString('en-US') + ' 字'
            : (readName ? '读到 ' + esc(readName) : '还没开始读')) + '</div>' +
          '<div class="rd-menu-rows">' +
            row('read', '继续阅读', esc(readName || '从头开始')) +
            row('toc', '目录', chs ? '共 ' + chs + ' 章' : '一章一句话') +
            row('search', '全书搜索', '找一句话') +
            row('cover', '换封面', proj.hasCover ? '已设置' : '还没设') +
            row('rename', '改书名', '换个名字') +
            row('restart', '重新开始', '从第一章重读') +
            row('refresh', '刷新字数', '重新统计') +
          '</div>' +
          '<div class="rd-menu-rows rd-menu-danger">' +
            row('delete', '删除这本书', '删了就找不回来', 'is-danger') +
          '</div>' +
        '</div>',
        {
          onMount(p) {
            p.addEventListener('click', (e) => {
              if (e.target.closest('[data-close]')) { App.closeSheet(); return; }
              const row = e.target.closest('[data-a]');
              if (!row) return;
              const a = row.dataset.a;
              /* 要接着开面板/弹窗的一律走 closeSheet(回调) —— 不再写"关完立刻开"：
                 那种写法会让旧面板的收尾把新面板一起带走（面板高度 0 = 用户看到"点了没用"）。 */
              if (a === 'read') App.closeSheet(() => Shelf.open(slug));
              else if (a === 'restart') App.closeSheet(() =>
                App.confirm('从第一章重新开始？阅读进度会清空。', () => Shelf.open(slug, 'restart'), '重新开始'));
              else if (a === 'refresh') App.closeSheet(() => {
                Shelf.projects = null; Shelf.books = {}; Shelf.load(true); App.toast('正在刷新字数…');
              });
              else if (a === 'toc') App.closeSheet(async () => {
                Reader.pending = { slug: slug };
                await Shelf.openBook(slug, { slug: slug });
                Reader.toc();
              });
              /* 搜索**不关面板**：App.sheet 会就地换内容，面板一直立着，不会闪一下又没了 */
              else if (a === 'search') Shelf.search(slug);
              else if (a === 'cover') App.closeSheet(() => Shelf.pickCover(slug));
              else if (a === 'rename') App.closeSheet(() => Shelf.rename(slug, title));
              else if (a === 'delete') App.closeSheet(() =>
                App.confirm('真的要删掉《' + title + '》？整个作品和所有章节都会被删除，删了就找不回来了。',
                  () => Shelf.remove(slug, title), '确认删除'));
            });
          },
        });
    },

    /* ---------- 新建作品 ---------- */
    newBook() {
      App.modal(
        '<div style="font-size:var(--t-lg);font-weight:var(--w-semi);margin-bottom:var(--sp-3)">新建作品</div>' +
        '<input id="nb-title" class="input" placeholder="书名，例如：剑起示例" ' +
        'style="-webkit-user-select:text;user-select:text">' +
        '<div style="display:flex;gap:var(--sp-3);margin-top:var(--sp-4)">' +
        '<button class="btn btn-block" data-close>取消</button>' +
        '<button class="btn btn-primary btn-block" id="nb-go">创建</button></div>',
        {
          onMount(p) {
            const inp = p.querySelector('#nb-title');
            setTimeout(() => inp && inp.focus(), 120);
            p.querySelector('#nb-go').addEventListener('click', async () => {
              const t = (inp.value || '').trim();
              if (!t) { App.toast('先起个书名'); return; }
              try {
                await API.bookNew(t);
                App.closeModal();
                App.toast('已创建《' + t + '》');
                Shelf.projects = null;
                await Shelf.load(true);
              } catch (e) { App.toast('创建失败：' + e.message); }
            });
          },
        });
    },

    /* ---------- 换封面 ---------- */
    pickCover(slug) {
      const inp = document.getElementById('cover-input');
      if (!inp) return;
      inp.value = '';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0];
        if (!f) return;
        App.toast('正在上传封面…');
        try {
          await API.coverUpload(slug, f);
          App.toast('封面换好了');
          Shelf.projects = null;
          await Shelf.load(true);
        } catch (e) { App.toast('上传失败：' + e.message); }
      };
      inp.click();
    },

    /* ---------- 改书名 ---------- */
    rename(slug, oldTitle) {
      App.modal(
        '<div style="font-size:var(--t-lg);font-weight:var(--w-semi);margin-bottom:var(--sp-3)">改书名</div>' +
        '<input id="rn-title" class="input" style="-webkit-user-select:text;user-select:text">' +
        '<div style="display:flex;gap:var(--sp-3);margin-top:var(--sp-4)">' +
        '<button class="btn btn-block" data-close>取消</button>' +
        '<button class="btn btn-primary btn-block" id="rn-go">保存</button></div>',
        {
          onMount(p) {
            const inp = p.querySelector('#rn-title');
            inp.value = oldTitle || '';
            setTimeout(() => { inp.focus(); inp.select(); }, 120);
            p.querySelector('#rn-go').addEventListener('click', async () => {
              const t = (inp.value || '').trim();
              if (!t) { App.toast('书名不能空着'); return; }
              try {
                await API.bookRename(slug, t);
                App.closeModal();
                App.toast('改好了');
                Shelf.projects = null;
                await Shelf.load(true);
              } catch (e) { App.toast('改名失败：' + e.message); }
            });
          },
        });
    },

    /* ---------- 删除作品 ---------- */
    async remove(slug, title) {
      try {
        await API.bookDelete(slug);
        Progress.clear(slug);
        delete Shelf.books[slug];
        App.toast('《' + title + '》已删除');
        Shelf.projects = null;
        await Shelf.load(true);
      } catch (e) { App.toast('删除失败：' + e.message); }
    },

    /* ---------- 全书搜索 ---------- */
    search(slug) {
      pushOverlay();
      App.sheet(
        '<div class="sheet-grip"></div>' +
        /* 跟别的弹层同一个模子：标题 + 右上角 ×（以前这个面板没有头、也没有关闭键，
           "点了没反应"之外还退不出去） */
        '<div class="sheet-head"><h3>全书搜索</h3>' +
        '<button class="icon-btn" data-close aria-label="关闭">' + iconHtml('close') + '</button></div>' +
        '<div class="sheet-note">在这本书的每一章里找一句话，点结果直接跳到那一章。</div>' +
        '<div class="pk-search"><input id="bs-q" placeholder="在全书中找一句话" ' +
        'autocomplete="off" style="-webkit-user-select:text;user-select:text"></div>' +
        '<ul class="pk-list" id="bs-list"></ul>',
        {
          onMount(p) {
            const inp = p.querySelector('#bs-q');
            const list = p.querySelector('#bs-list');
            let timer = null;
            const run = async () => {
              const q = (inp.value || '').trim();
              if (!q) { list.innerHTML = '<li><span class="t" style="color:var(--ink-3)">输入关键词开始搜</span></li>'; return; }
              list.innerHTML = '<li><span class="t"><span class="spinner"></span> 搜索中…</span></li>';
              try {
                const d = await API.searchBook(slug, q);
                const hits = d.hits || [];
                list.innerHTML = hits.length ? hits.map((h) =>
                  '<li data-path="' + esc(h.path) + '"><span class="t">' +
                  esc(h.before) + '<b style="color:var(--accent)">' + esc(h.match) + '</b>' +
                  esc(h.after) + '</span><span class="s">第' + esc(h.index || '?') + '章</span></li>'
                ).join('') : '<li><span class="t" style="color:var(--ink-3)">没找到</span></li>';
              } catch (e) {
                list.innerHTML = '<li><span class="t" style="color:var(--danger)">搜索失败：' + esc(e.message) + '</span></li>';
              }
            };
            list.innerHTML = '<li><span class="t" style="color:var(--ink-3)">输入关键词开始搜</span></li>';
            inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 320); });
            list.addEventListener('click', (e) => {
              const li = e.target.closest('li[data-path]');
              if (!li) return;
              App.closeSheet();
              Reader.pending = { slug: slug, path: li.dataset.path, percent: 0 };
              App.show('reader');
            });
            setTimeout(() => inp.focus(), 160);
          },
        });
    },
  };

  /* ══════════════════════ 阅读器 ══════════════════════ */
  const R = {
    slug: null, book: null, chapter: null,
    path: null, pathNext: null, pathPrev: null,
    text: '', pages: 1, idx: 0, pct: 0, lastCost: 0,
    mode: 'paged', ready: false, cache: {}, cacheSlug: null,
    pageW: 0, pageH: 0, colW: 0, colG: 0, padX: 22,
    audio: null, ttsOn: false, ttsWant: false,
    ttsBusy: false, ttsSeg: 0, ttsCount: 0, ttsGen: 0, ttsPath: null,
    chromeTimer: null, drag: null, lastW: 0, lastH: 0, chromeVisible: true,
    els: {},
  };

  /* ---------- DOM / 排版 ---------- */
  function ensureDom() {
    if (R.ready) return;
    const page = $('#reader-page');
    if (!page) return;
    const strip = document.createElement('div');
    strip.className = 'reader-strip';
    strip.setAttribute('data-hscroll', '');   /* 正文横着分页（一页一屏），本来就是横滑容器 */
    const cols = document.createElement('div');
    cols.className = 'reader-cols';
    strip.appendChild(cols);
    page.appendChild(strip);
    R.els = {
      screen: $('#screen-reader'), stage: $('#reader-stage'), page: page, strip: strip, cols: cols,
      turn: $('#reader-turn'), head: $('#reader-head'), headTitle: $('#reader-head-title'),
      foot: $('#reader-foot'), scrub: $('#reader-scrub'),
      scrubVal: $('#reader-scrub-val'), acts: $('#reader-foot .rd-foot-acts'),
      ttsBtn: $('#reader-foot [data-act="toggle-tts"]'),
    };
    wireGestures();
    wireScrub();
    ttsPaint();
    R.ready = true;
  }

  function applyThemeClass() {
    const root = $('#screen-reader');
    if (!root) return;
    root.classList.toggle('reader-root-sans', Prefs.get('fontFamily') === 'sans');
    root.classList.toggle('reader-root-serif', Prefs.get('fontFamily') !== 'sans');
  }

  function layout() {
    ensureDom();
    const e = R.els;
    if (!e.stage || !R.text) return;
    const W = e.stage.clientWidth, H = e.stage.clientHeight;
    if (!W || !H) return;                       // 屏幕还没显示，等 onShow
    R.lastW = W; R.lastH = H; R.pageW = W; R.pageH = H;
    const mode = Prefs.get('pageMode');
    R.mode = mode === 'scroll' ? 'scroll' : 'paged';
    e.screen.classList.toggle('mode-scroll', R.mode === 'scroll');
    const padX = clamp(+Prefs.get('margin') || 22, 6, 60);
    R.padX = padX;
    // 底栏（进度 + 常用功能那两排）是在流里的，stage 的高度已经把它让出来了，
    // 所以正文不用再预留 —— 以前那 38px 是给浮在上面的进度条留的，现在没了。
    const reserve = 8;
    R.reserve = reserve;

    if (R.mode === 'scroll') {
      e.strip.style.width = ''; e.strip.style.height = '';
      e.strip.style.transform = 'none';
      e.cols.style.width = ''; e.cols.style.height = '';
      e.cols.style.columnWidth = ''; e.cols.style.webkitColumnWidth = '';
      e.cols.style.columnGap = ''; e.cols.style.webkitColumnGap = '';
      e.cols.style.padding = '20px ' + padX + 'px ' + reserve + 'px';
      R.pages = 1;
      return;
    }

    const CH = H - reserve;                               // 正文区可用高度
    const C = Math.max(80, W - padX * 2);                 // 版心宽 = 列宽
    const G = Math.max(padX + 26, Math.round(W * 0.12));  // 列间距，必须 > padX 才不串页
    R.colW = C; R.colG = G;
    e.strip.style.width = W + 'px';
    e.strip.style.height = H + 'px';
    e.cols.style.width = W + 'px';
    e.cols.style.height = CH + 'px';
    e.cols.style.padding = '22px ' + padX + 'px 10px';
    e.cols.style.columnWidth = C + 'px';
    e.cols.style.columnGap = G + 'px';
    e.cols.style.webkitColumnWidth = C + 'px';
    e.cols.style.webkitColumnGap = G + 'px';

    // 量列数：strip 归零 → 最后一个元素的右边缘所在列 = 最后一页
    e.strip.style.transition = 'none';
    e.strip.style.transform = 'translate3d(0,0,0)';
    const base = e.cols.getBoundingClientRect().left;
    let n = 1;
    const kids = e.cols.children;
    if (kids.length) {
      const right = kids[kids.length - 1].getBoundingClientRect().right;
      n = Math.max(1, Math.floor((right - base - padX - 1) / (C + G)) + 1);
      const sw = Math.max(e.cols.scrollWidth || 0, e.page.scrollWidth || 0);
      if (sw > 0) {
        const byScroll = Math.max(1, Math.round((sw - padX - C) / (C + G)) + 1);
        if (byScroll < n) n = byScroll;
      }
    }
    R.pages = clamp(n, 1, 9999);
    R.idx = clamp(R.idx, 0, R.pages - 1);
    apply(0);
  }

  function apply(anim) {
    const e = R.els;
    if (R.mode === 'scroll') { syncProgress(); return; }
    const step = R.colW + R.colG;
    if (anim) {
      e.strip.style.transition = 'transform ' + anim + 'ms cubic-bezier(.22,.7,.28,1)';
      setTimeout(() => { if (e.strip) e.strip.style.transition = 'none'; }, anim + 40);
    } else {
      e.strip.style.transition = 'none';
    }
    e.strip.style.transform = 'translate3d(' + (-R.idx * step) + 'px,0,0)';
    syncProgress();
  }

  const pctOf = (idx, pages) => ((pages || R.pages) > 1 ? Math.round((idx / ((pages || R.pages) - 1)) * 100) : 100);
  function pageOf(pct, pages) {
    const pg = pages || R.pages;
    if (pg <= 1) return 0;
    return clamp(Math.round((clamp(pct, 0, 100) / 100) * (pg - 1)), 0, pg - 1);
  }

  function syncProgress() {
    const e = R.els, ch = R.chapter;
    if (!ch) return;
    if (R.mode === 'scroll') {
      const max = Math.max(1, e.page.scrollHeight - e.page.clientHeight);
      R.pct = clamp(Math.round((e.page.scrollTop / max) * 100), 0, 100);
    } else {
      R.pct = pctOf(R.idx);
    }
    if (e.scrub && document.activeElement !== e.scrub) e.scrub.value = String(R.pct);
    if (e.scrubVal) e.scrubVal.textContent = R.pct + '%';
    if (e.ptext) e.ptext.textContent = '第 ' + (ch.index || 1) + '/' + (ch.total || 1) + ' 章';
    if (e.headTitle) e.headTitle.textContent = prettyName(ch.name || '');
    Progress.set(R.slug, R.path, R.pct);
  }

  /* ---------- 打开书 / 载入章节 ---------- */
  async function openReader(cmd) {
    ensureDom();
    cmd = cmd || {};
    const slug = cmd.slug || R.slug;
    if (!slug) { App.show('shelf'); return; }
    Reader._cacheFor(slug);
    R.slug = slug;
    App.state.slug = slug;
    /* 翻开一本书 = 那一刻起它就是全站唯一的「当前书」（）。
       这样点进阅读器之后，工具/设定/对话/统计看到的都是这一本。 */
    try { if (window.BookCtx) BookCtx.set(slug, (R.book && R.book.title) || ''); } catch (e) {}
    App.state.readerReturn = App.state.readerReturn || 'shelf';
    applyThemeClass();
    showChrome();
    if (!R.book || R.book.slug !== slug) {
      R.els.headTitle.textContent = '载入中…';
      try {
        R.book = await API.book(slug);
        window.Offline && Offline.putBook(slug, R.book);
      } catch (e) {
        const c = window.Offline && Offline.getBook(slug);
        if (!c) { App.toast('书本打不开：' + (e.message || '')); App.show('shelf'); return; }
        R.book = c;
        App.toast('离线：目录是缓存里的');
      }
    }
    App.state.book = R.book;
    /* 拿到书目之后把真书名补上（上面先占了个位，是为了让上下文立刻切过来） */
    try { if (window.BookCtx) BookCtx.set(slug, R.book.title || slug); } catch (e) {}
    const chs = R.book.chapters || [];
    let path = cmd.path;
    if (!path || !chs.some((c) => c.path === path)) path = chs.length ? chs[0].path : null;
    if (!path) { App.toast('这本书还没有章节'); App.show('shelf'); return; }
    await loadChapter(path, cmd.path ? (cmd.percent || 0) : 0);
    autoHideChrome();
  }

  async function loadChapter(path, pct) {
    ensureDom();
    const e = R.els;
    if (!path || !R.book) return false;
    const chs = R.book.chapters || [];
    const si = chs.findIndex((c) => c.path === path);
    if (si < 0) return false;
    if (R.cache[path] == null) {
      e.headTitle.textContent = '载入中…';
      try {
        const d = await API.chapter(R.slug, path);
        R.cache[path] = d.content || '';
        window.Offline && Offline.putChapter(R.slug, path, R.cache[path]);
      } catch (err) {
        const c = window.Offline && Offline.getChapter(R.slug, path);
        if (c == null) { App.toast('章节打不开：' + (err.message || '')); return false; }
        R.cache[path] = c;
        App.toast('离线：这一章是缓存过的');
      }
    }
    // 预取往后两章：翻到下一章不用等（后台悄悄拉，失败也不打扰）
    const pf = [];
    for (let k = si + 1; k <= si + 2 && k < chs.length; k++) pf.push(chs[k].path);
    if (pf.length) setTimeout(() => {
      pf.forEach((p) => {
        if (R.cache[p] != null) return;
        API.chapter(R.slug, p).then((d) => {
          R.cache[p] = d.content || '';
          window.Offline && Offline.putChapter(R.slug, p, R.cache[p]);
        }).catch(() => {});
      });
    }, 600);
    // 缓存别无限涨，只留当前附近 8 章
    const keep = chs.slice(Math.max(0, si - 3), si + 6).map((c) => c.path);
    Object.keys(R.cache).forEach((k) => { if (keep.indexOf(k) < 0) delete R.cache[k]; });
    const meta = chs[si];
    R.chapter = { path: path, name: meta.name, index: meta.index, total: chs.length, words: meta.words };
    R.path = path;
    R.pathNext = si < chs.length - 1 ? chs[si + 1].path : null;
    R.pathPrev = si > 0 ? chs[si - 1].path : null;
    R.text = R.cache[path] || '';
    App.state.chapter = Object.assign({}, R.chapter, { content: R.text });
    e.page.scrollTop = 0;

    const t0 = performance.now();
    e.cols.innerHTML = mdToHtml(R.text);
    R.idx = 0;
    R.pct = 0;
    layout();
    R.lastCost = Math.round(performance.now() - t0);
    R.idx = pageOf(pct || 0);
    apply(0);
    /* 名单先备好再标名字：标的是"这一本登记过的人/术语"，换书换名单（不会串到另一本） */
    if (termSlug !== R.slug) loadTerms(R.slug).then(() => markTerms()).catch(() => {});
    else markTerms();
    prefetch();
    return true;
  }

  /* ═══════ ④ 点一下看设定（新功能）═══════
     读正文时，书里登记过的人物/术语会**淡淡地标出来**，点一下弹出设定卡（身份、别名、已有事实）。
     为什么不自动全弹：写到第 40 章早忘了第 3 章那个配角是谁，退出去翻世界面板再回来思路就断了。
     只认**这一本**的名单（换书就换名单，另一本的同名不会串）。 */
  let termMap = null, termSlug = '';
  async function loadTerms(slug) {
    if (!slug) return null;
    if (termSlug === slug && termMap) return termMap;
    termMap = null; termSlug = slug;
    try {
      const d = await API.nb('api/world/entities?slug=' + encodeURIComponent(slug) + '&limit=800');
      const map = Object.create(null);
      (d.items || []).forEach((e) => {
        [e.name].concat(e.aliases || []).forEach((n) => {
          const k = String(n || '').trim();
          if (k.length >= 2 && !map[k]) map[k] = e;
        });
      });
      /* 术语表也算一份来源：用户在「术语」面板登记的名字，正文里也该点得出来。
         实测发现：原来只认世界实体（名字多是「原著·某某人物」这种条目名），
         结果自己登记的人名一个都标不出来 —— 功能等于死的。两份合并，世界实体优先。 */
      try {
        const t = await API.nb('api/term?slug=' + encodeURIComponent(slug));
        (t.items || []).forEach((x) => {
          const ent = { name: x.name, kind: x.kind || '', note: x.note || '',
            aliases: x.aliases || [], from: 'term' };
          [x.name].concat(x.aliases || []).forEach((n) => {
            const k = String(n || '').trim();
            if (k.length >= 2 && !map[k]) map[k] = ent;
          });
        });
      } catch (e) { /* 术语表读不到不算错，世界实体那份照样用 */ }
      termMap = map;
    } catch (e) { termMap = null; }
    return termMap;
  }
  const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function markTerms() {
    const cols = R.els && R.els.cols;
    const map = termMap;
    if (!cols || !map) return;
    const names = Object.keys(map).sort((a, b) => b.length - a.length).slice(0, 1200);
    if (!names.length) return;
    let re;
    try { re = new RegExp(names.map(escRe).join('|'), 'g'); } catch (e) { return; }
    const walker = document.createTreeWalker(cols, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      const t = node.nodeValue;
      if (!t || t.length < 2) return;
      re.lastIndex = 0;
      if (!re.test(t)) return;
      const frag = document.createDocumentFragment();
      let last = 0, m;
      re.lastIndex = 0;
      while ((m = re.exec(t)) !== null) {
        if (m.index > last) frag.appendChild(document.createTextNode(t.slice(last, m.index)));
        const sp = document.createElement('span');
        sp.className = 'rd-term';
        sp.dataset.term = m[0];
        sp.textContent = m[0];
        frag.appendChild(sp);
        last = m.index + m[0].length;
        if (m.index === re.lastIndex) re.lastIndex++;      // 空匹配兜底，别死循环
      }
      if (last < t.length) frag.appendChild(document.createTextNode(t.slice(last)));
      if (node.parentNode) node.parentNode.replaceChild(frag, node);
    });
    cols.querySelectorAll('.rd-term').forEach((el) => {
      el.addEventListener('click', (e) => { e.stopPropagation(); openTermCard(el.dataset.term); });
    });
  }
  function openTermCard(name) {
    const e = (termMap || {})[name];
    if (!e) return;
    hapNow(6);
    const KIND = { character: '角色', place: '地点', faction: '势力', item: '物品', concept: '设定',
                   event: '事件', org: '组织', other: '其它' };
    const facts = (e.facts || []).slice(0, 6);
    App.sheet('<div class="sheet-grip"></div>' +
      '<div class="sheet-head"><h3>' + esc(e.name) + '</h3>' +
      '<button class="icon-btn" data-close aria-label="关闭">' + iconHtml('close') + '</button></div>' +
      '<div class="rd-termcard">' +
        '<div class="tc-kind">' + esc(KIND[e.kind] || e.kind || '设定') + '</div>' +
        ((e.aliases || []).length ? '<div class="tc-line"><b>也叫</b>' + esc((e.aliases || []).join('、')) + '</div>' : '') +
        ((e.summary || e.note) ? '<div class="tc-line"><b>一句话</b>' + esc(e.summary || e.note) + '</div>' : '') +
        (facts.length ? '<div class="tc-line"><b>已有事实</b></div>' + facts.map((f) =>
          '<div class="tc-fact">' + esc(f.text || f.fact || '') + '</div>').join('')
          : '<div class="tc-line" style="color:var(--ink-3)">还没有登记更多设定</div>') +
        '<div class="t-bar" style="margin-top:var(--sp-3)">' +
          '<button class="t-btn" data-more>看完整设定</button>' +
          '<button class="t-btn pri" data-close2>知道了</button></div>' +
      '</div>');
    const pn = document.getElementById('sheet-panel');
    pn.querySelector('[data-close2]').onclick = () => App.closeSheet();
    const more = pn.querySelector('[data-more]');
    if (more) more.onclick = () => {
      App.closeSheet();
      if (window.Tools && Tools.open) { try { Tools.open('world'); } catch (err) {} }
    };
  }

  const prefetch = debounce(async () => {
    const chs = (R.book && R.book.chapters) || [];
    const i = chs.findIndex((c) => c.path === R.path);
    [i + 1, i - 1].forEach((k) => {
      const p = (k >= 0 && k < chs.length) ? chs[k].path : null;
      if (p && R.cache[p] == null) {
        API.chapter(R.slug, p).then((d) => {
          R.cache[p] = d.content || '';
          window.Offline && Offline.putChapter(R.slug, p, R.cache[p]);
        }).catch(() => {});
      }
    });
  }, 900);

  /* ---------- 翻页 ---------- */
  function nextPage() {
    if (R.mode === 'scroll') { scrollByScreen(1); return; }
    if (R.idx < R.pages - 1) { animateTurn(1); return; }
    if (R.pathNext) toChapter(R.pathNext, 0); else App.toast('已经是最后一章了');
  }
  function prevPage() {
    if (R.mode === 'scroll') { scrollByScreen(-1); return; }
    if (R.idx > 0) { animateTurn(-1); return; }
    if (R.pathPrev) toChapter(R.pathPrev, 100); else App.toast('已经是第一章了');
  }
  async function toChapter(path, pct) {
    const ok = await loadChapter(path, pct);
    if (ok) { autoHideChrome(); }
    return ok;
  }
  function scrollByScreen(dir) {
    const e = R.els;
    const max = Math.max(0, e.page.scrollHeight - e.page.clientHeight);
    if (dir > 0 && e.page.scrollTop >= max - 2) { nextChapterByScroll(); return; }
    if (dir < 0 && e.page.scrollTop <= 2) { if (R.pathPrev) toChapter(R.pathPrev, 100); return; }
    e.page.scrollTop = clamp(e.page.scrollTop + dir * e.page.clientHeight * 0.86, 0, max);
  }
  function nextChapterByScroll() {
    if (R.pathNext) toChapter(R.pathNext, 0); else App.toast('已经是最后一章了');
  }

  /* ---------- 翻页动画（curl 仿真 / slide 平移） ---------- */
  function cloneAt(idx) {
    const e = R.els;
    const step = R.colW + R.colG;
    const old = R.idx;
    e.strip.style.transition = 'none';
    e.strip.style.transform = 'translate3d(' + (-idx * step) + 'px,0,0)';
    const c = e.page.cloneNode(true);
    e.strip.style.transform = 'translate3d(' + (-old * step) + 'px,0,0)';
    return c;
  }

  function buildFlip(dir) {
    const e = R.els;
    const mode = Prefs.get('pageMode');
    const target = clamp(R.idx + dir, 0, R.pages - 1);

    if (mode === 'slide') {
      // 新页从侧边滑入：当前页留作底
      const face = document.createElement('div');
      face.className = 'flip-face flip-front';
      face.style.backfaceVisibility = 'visible';
      face.style.webkitBackfaceVisibility = 'visible';
      face.appendChild(cloneAt(target));
      const flip = document.createElement('div');
      flip.className = 'flip';
      flip.appendChild(face);
      flip.style.transition = 'none';
      flip.style.transform = 'translate3d(' + (dir * R.pageW) + 'px,0,0)';
      e.turn.innerHTML = '';
      e.turn.appendChild(flip);
      return {
        el: flip,
        set(p) { flip.style.transform = 'translate3d(' + (dir * R.pageW * (1 - clamp(p, 0, 1))) + 'px,0,0)'; },
        finish(to, done) {
          const p0 = clamp(R.turnP == null ? 0 : R.turnP, 0, 1);
          const dur = Math.max(140, Math.round(80 + 300 * Math.abs(to - p0)));
          flip.style.transition = 'transform ' + dur + 'ms var(--ease-out-q)';
          flip.style.transform = 'translate3d(' + (dir * R.pageW * (1 - clamp(to, 0, 1))) + 'px,0,0)';
          setTimeout(done, dur + 40);
        },
        commit() { e.turn.innerHTML = ''; R.idx = target; apply(0); },
        cancel() { e.turn.innerHTML = ''; R.idx = target - dir; apply(0); },
      };
    }

    // curl（削页式仿真翻页）：
    //   dir>0 下一页：当前页被折痕从右往左一点点「吃掉」，底下的下一页露出来
    //   dir<0 上一页：当前页往右滑走，底下的上一页从左边露出来
    // 关键：折痕要有阴影+纸边高光，否则就成硬切。
    const topIdx = R.idx;                        // 上面这层印的是当前页
    const baseIdx = target;                      // 底下这层是即将露出来的那页
    const W = R.pageW || (e.stage ? e.stage.clientWidth : 390);
    const H = R.pageH || (e.stage ? e.stage.clientHeight : 700);
    const BOW = 6;                               // 折痕的弓形幅度（px）

    const base = cloneAt(baseIdx);
    const top = document.createElement('div');
    top.className = 'peel';
    top.appendChild(cloneAt(topIdx));

    const inner = document.createElement('div');
    inner.className = 'peel-inner';
    const outer = document.createElement('div');
    outer.className = 'peel-outer';

    e.turn.innerHTML = '';
    // 底下换成目标页（top 层会盖住没被削掉的部分）
    R.idx = baseIdx;
    e.strip.style.transition = 'none';
    e.strip.style.transform = 'translate3d(' + (-baseIdx * (R.colW + R.colG)) + 'px,0,0)';
    void base;
    e.turn.appendChild(top);
    e.turn.appendChild(inner);
    e.turn.appendChild(outer);

    const clip = (f) => {
      // f = 折痕位置（px）。dir>0 保留 [0,f]；dir<0 保留 [f,W]
      const s = [];
      const N = 8;
      if (dir > 0) {
        s.push([0, 0]);
        for (let i = 0; i <= N; i++) {
          const t = i / N;
          s.push([f - BOW * Math.sin(Math.PI * t), t * H]);
        }
        s.push([0, H]);
      } else {
        s.push([W, 0]);
        for (let i = 0; i <= N; i++) {
          const t = i / N;
          s.push([f + BOW * Math.sin(Math.PI * t), t * H]);
        }
        s.push([W, H]);
      }
      const poly = 'polygon(' + s.map(function (pt) {
        return (clamp(pt[0], -80, W + 80) / W * 100).toFixed(3) + '% ' + (pt[1] / H * 100).toFixed(3) + '%';
      }).join(',') + ')';
      top.style.clipPath = poly;
      top.style.webkitClipPath = poly;
    };
    const edgeAt = (f, p) => {
      const o = Math.min(1, Math.sin(Math.PI * clamp(p, 0, 1)) * 1.25);
      // inner 只在折痕左边，宽度正好到折痕；outer 从折痕往右铺
      const inW = dir > 0 ? Math.max(0, f) : Math.max(0, W - f);
      inner.style.width = inW.toFixed(1) + 'px';
      if (dir < 0) inner.style.left = f.toFixed(1) + 'px';
      inner.style.opacity = String(o);
      outer.style.transform = 'translate3d(' + f.toFixed(1) + 'px,0,0)';
      if (dir < 0) outer.style.transform = 'translate3d(' + (f - 140).toFixed(1) + 'px,0,0) scaleX(-1)';
      outer.style.opacity = String(o);
      top.style.setProperty('--edge', String(o));
    };

    const fOf = (p) => (dir > 0 ? W * (1 - clamp(p, 0, 1)) : W * clamp(p, 0, 1));
    const setP = (p) => { const q = clamp(p, 0, 1); clip(fOf(q)); edgeAt(fOf(q), q); };
    setP(0);

    return {
      el: top,
      set: setP,
      finish(to, done) {
        const p0 = clamp(R.turnP == null ? 0 : R.turnP, 0, 1);
        const dur = Math.max(150, Math.round(90 + 330 * Math.abs(to - p0)));
        top.style.transition = 'clip-path ' + dur + 'ms var(--ease-out-q)';
        inner.style.transition = 'opacity ' + dur + 'ms linear, width ' + dur + 'ms var(--ease-out-q), left ' + dur + 'ms var(--ease-out-q)';
        outer.style.transition = 'transform ' + dur + 'ms var(--ease-out-q), opacity ' + dur + 'ms linear';
        setP(to);
        setTimeout(done, dur + 40);
      },
      commit() { e.turn.innerHTML = ''; R.idx = target; apply(0); },
      cancel() { e.turn.innerHTML = ''; R.idx = target - dir; apply(0); },
    };
  }

  let turning = false;
  function animateTurn(dir) {
    if (turning || R.mode !== 'paged') return;
    const target = R.idx + dir;
    if (target < 0 || target > R.pages - 1) return;
    const mode = Prefs.get('pageMode');
    if (mode === 'none') { R.idx = target; apply(0); autoHideChrome(); return; }
    turning = true;
    R.turnP = 0;
    if (R.els.screen) R.els.screen.classList.add('turning');
    const f = buildFlip(dir);
    f.set(0);
    void f.el.offsetWidth;                       // 强制回流，让 transition 生效
    const done = () => {
      if (!turning) return;
      turning = false;
      R.turnP = null;
      if (R.els.screen) R.els.screen.classList.remove('turning');
      f.commit();
      autoHideChrome();
    };
    f.finish(1, done);
    setTimeout(() => { if (turning) done(); }, 900);   // 兜底，别卡住
  }

  /* ---------- 手势 ---------- */
  function wireGestures() {
    const st = R.els.stage;
    if (!st) return;
    let sx = 0, sy = 0, st0 = 0, lock = 0, drag = null;

    st.addEventListener('touchstart', (ev) => {
      if (ev.touches.length !== 1) { lock = 9; return; }
      const t = ev.touches[0];
      sx = t.clientX; sy = t.clientY; st0 = Date.now(); lock = 0; drag = null;
      clearTimeout(R.chromeTimer);
    }, { passive: true });

    st.addEventListener('touchmove', (ev) => {
      if (lock === 9) return;
      const t = ev.touches[0];
      if (!t) return;
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (!lock) {
        if (Math.abs(dx) < 9 && Math.abs(dy) < 9) return;
        if (Math.abs(dx) > Math.abs(dy) * 1.15) lock = 1; else { lock = 2; return; }
        if (R.mode !== 'paged' || Prefs.get('pageMode') === 'none') { lock = 9; return; }
        const target = R.idx + (dx < 0 ? 1 : -1);
        if (target < 0 || target > R.pages - 1) { lock = 9; return; }
      }
      if (lock !== 1) return;
      if (ev.cancelable) ev.preventDefault();
      if (!drag) { drag = buildFlip(dx < 0 ? 1 : -1); turning = true; R.turnP = 0; }
      const p = Math.min(1, Math.abs(dx) / (st.clientWidth * 0.72));
      R.turnP = p;
      drag.set(p);
    }, { passive: false });

    st.addEventListener('touchend', (ev) => {
      const dt = Date.now() - st0;
      const t = ev.changedTouches && ev.changedTouches[0];
      if (lock === 1 && drag) {
        const dx = t ? t.clientX - sx : 0;
        const p = Math.min(1, Math.abs(dx) / (st.clientWidth * 0.72));
        const go = p > 0.34 || (dt < 260 && Math.abs(dx) > 26);
        const d = drag;
        drag = null;
        if (R.els.screen) R.els.screen.classList.add('turning');
        d.finish(go ? 1 : 0, () => {
          turning = false;
          R.turnP = null;
          if (R.els.screen) R.els.screen.classList.remove('turning');
          if (go) d.commit(); else d.cancel();
          autoHideChrome();
        });
        lock = 9;                                 // 吞掉紧随其后的 click
        setTimeout(() => { lock = 0; }, 320);
        return;
      }
      lock = 0;
    }, { passive: true });

    st.addEventListener('touchcancel', () => {
      if (drag) { drag.cancel(); drag = null; }
      lock = 0; turning = false; R.turnP = null;
    });

    st.addEventListener('click', (ev) => {
      if (lock === 9) return;
      if (quickOn) { closeQuick(); return; }   // 面板开着时，点正文 = 收起它（用户要的就是"顺手一看一调"）
      const r = st.getBoundingClientRect();
      const x = ev.clientX - r.left;
      if (x < r.width * 0.34) { prevPage(); autoHideChrome(); }
      else if (x > r.width * 0.66) { nextPage(); autoHideChrome(); }
      else toggleChrome();
    });
  }

  function wireScrub() {
    const s = R.els.scrub;
    if (!s) return;
    s.addEventListener('input', () => {
      if (R.els.scrubVal) R.els.scrubVal.textContent = s.value + '%';
      if (R.mode === 'scroll') {
        const max = Math.max(1, R.els.page.scrollHeight - R.els.page.clientHeight);
        R.els.page.scrollTop = (s.value / 100) * max;
        syncProgress();
      } else {
        R.idx = pageOf(+s.value);
        apply(0);
      }
    });
    s.addEventListener('change', () => {
      if (R.slug && R.path) Progress.set(R.slug, R.path, +s.value);
    });
  }

  /* ---------- 底部快捷面板（：别整屏盖住，一边调一边看得到字） ----------
     、"点开设置之后，UI 界面要统一要好看"。

     所以这一块的三条规矩：
       ① **它是唯一的**：阅读界面里不再有"右上角三个点"那套整屏弹层，
          目录 / 书签 / 笔记 / 章节改名 全部只从这儿进（老的那套整屏弹层已整段删掉）。
       ② **控件跟设置页是同一套**：App.prefsHtml() + App.wirePrefs()，
          样式直接吃 base.css 里的 .settings-group / .settings-row / .seg / .stepper，
          这里**不许**再自己写一份 padding/字号（以前 .rd-set 自己一套，看着就跟别处不像）。
       ③ **矮**：最多占屏幕 44%，默认一条控件的高度；正文在上面照常看得见、改了立刻重排。
     面板**没有蒙层**，收起有五条路：抓手下拉、点正文、右上角关闭键、底部「完成」、手机返回键。

     第 2 屏（大改）又重做了一次，因为用户看完实机截图说：
       「点击它现在弄到下面的这个设置之后，里面的东西很丑……还没有原本在右上角三个点的时候好看」、
       「上面那些排版啊、分享啊、书签啊之类的是固定着不动的，下面的东西滑动起来的感觉很怪」。
     所以改成**三段式**：固定头（抓手 + 标题 + 关闭 + 页签）/ **独立滚动体** / 固定底（「完成」）。
     ①②③ 三条老规矩不变（不整屏 / 不写第二套视觉 / 面板底用 --paper）；
     额外两条新规矩：
       ④ **固定区与滚动体谁也别压谁**（滚动体自己带走位内边距，`tools/e2e-cover.js` 会量）；
       ⑤ **目录从这个面板里搬出去**（见下面 `#rd-toc`）—— 外观回到旧版，
          那一排页签也**还原成旧版的 7 格**：排版 / 背景 / 听书 / 目录 / 书签 / 笔记 / 分享。
          「目录」这一格点下去走的是独立那块（`tocOpen()`）；「分享」还是分享这一章。 */
  let quickOn = false, quickCur = 'type';
  let quickNotes = [];                       // 笔记那页的数据（点开详情时要用）
  let quickMargins = [];                     // 批注那一段的数据（点一下要跳到那一章）
  const hapNow = (ms) => { try { App.haptic(ms || 8); } catch (e) {} };
  function quickEl() { return document.getElementById('rd-quick'); }
  /* ：面板改成"几乎霸占整屏 + **一个滚动容器装全部内容**"（抓手条 + 7 格 + 内容一起滚），
     所以"回到顶上"这件事现在由 #rd-quick-scroll 负责 —— 以前写的是 body.scrollTop = 0，
     那条路已经不再是滚动体了（再留着就是"两套实现"，顺手收干净）。 */
  function quickTop() {
    const sc = document.getElementById('rd-quick-scroll');
    if (sc) sc.scrollTop = 0;
  }

  /* 听书那页的动作按钮（播 / 停 / 准备中）——文字和图标跟着真实状态走 */
  function ttsActHtml() {
    /* 停在那儿（被打断 / 被暂停）时，这一颗要写「继续朗读」——
       用户看到的必须和真实状态一致：说"停止朗读"却一点声都没有，是最让人火大的那种界面。 */
    const paused = !!(R.ttsOn && R.audio && R.audio.paused);
    const st = R.ttsBusy ? 'busy' : (R.ttsOn ? 'on' : 'off');
    const icon = R.ttsBusy ? 'refresh' : (R.ttsOn ? (paused ? 'play' : 'pause') : 'sound');
    const label = R.ttsBusy ? '准备中…' : (R.ttsOn ? (paused ? '继续朗读' : '停止朗读') : '开始朗读');
    return '<button class="rd-act ' + st + '" data-a="tts">' + iconHtml(icon) + '<span>' + label + '</span></button>' +
      '<button class="rd-act" data-a="note">' + iconHtml('note') + '<span>记一笔</span></button>' +
      '<button class="rd-act" data-a="mark">' + iconHtml('bookmark') + '<span>加书签</span></button>' +
      /* 此前的反馈时的入口：点一下逐项亮灯，把卡在哪一环说清楚 */
      '<button class="rd-act" data-a="ttsdiag">' + iconHtml('search') + '<span>听书自检</span></button>';
  }

  function quickTab(t) {
    const el = quickEl(); if (!el) return;
    const body = document.getElementById('rd-quick-body', el);
    if (!body) return;
    t = t || 'type';
    /* 「目录」这一格：**面板让位**，开的是独立的 #rd-toc。
       （要目录独立、别"像在设置里点开了目录"；外观回到旧版，
       旧版那一排 7 格里本来就有「目录」—— 所以格子留着，但点下去走的是独立那块。） */
    if (t === 'toc') { tocOpen(); return; }
    quickCur = t;
    $$('.rd-qbtn', el).forEach((b) => {
      const on = b.dataset.q === t;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    if (t === 'mark') { body.innerHTML = marksHtml(); quickTop(); return; }
    if (t === 'note') { notesHtml(body); return; }              // 异步，自己往 body 里画
    if (t === 'share') {                                         // 旧版那一格：把这一章发出去
      body.innerHTML = '<div class="rd-hint">把这一章发给别人 · 手机上弹系统「分享」，浏览器里给你复制一份</div>'
        + '<div class="rd-quick-acts"><button class="rd-act" data-a="share">'
        + iconHtml('share') + '<span>分享这一章</span></button></div>';
      App.wirePrefs(body);
      quickTop();
      return;
    }
    if (t === 'tts') {
      /* 听书那页：**先把动作露出来**（开始朗读 / 记一笔 / 加书签），下面才是音色/语速那些细调 ——
         用户要的是"一定会用到的功能不用点开设置才看得到"。 */
      body.innerHTML = '<div class="rd-quick-acts">' + ttsActHtml() + '</div>'
        + App.prefsHtml(['voice', 'ttsEngine', 'rate', 'ttsFollow']);
    } else if (t === 'theme') {
      body.innerHTML = App.prefsHtml(['theme']);
    } else {                                                     // type = 排版
      body.innerHTML = App.prefsHtml(['fontFamily', 'fontSize', 'lineHeight', 'margin', 'pageMode']);
    }
    App.wirePrefs(body);
    quickTop();                       // 换页签 = 回到这一页的顶上（滚动体是 #rd-quick-scroll）
  }

  /* 听书状态一变，面板上那个按钮的文字/图标要跟着变（不然"点了一下没反应"） */
  function quickRefreshTts() { if (quickOn && quickCur === 'tts') quickTab('tts'); }

  function openQuick(tab) {
    /* 面板本身（）：**几乎霸占整屏**（92% 屏高）、**一个滚动容器装全部内容**
       （抓手条 + 7 格 + 内容一起滚，没有"上固定下滚动"两层）、7 格是 **3 列等宽网格 + 图标**。
        */
    /* 「目录」已经**搬出这个面板**（："只是相当于在设置里面点开了目录一样，
       并没有那种简洁的感觉"）→ 去 #rd-toc 那块独立的面板。底栏那个按钮直接走 `rd-toc`，
       这里再兜一层是为了老调用点（refreshToc / 外部的 Reader.quick('toc')）不会画空。 */
    if (tab === 'toc') { tocOpen(); return; }
    const el = quickEl(); if (!el) return;
    if (App.sheetOpen && App.sheetOpen()) App.closeSheet();      // 别让两层面板叠在一起
    if (quickOn) { quickTab(tab || quickCur); return; }
    quickOn = true;
    pushOverlay();                   // 手机返回键第一下先收面板（复用已有的 overlay 机制）
    el.classList.remove('hidden');
    el.style.transform = '';
    quickTop();                      // 每次打开都从顶上开始（不然上次滚到哪儿这次就停哪儿）
    requestAnimationFrame(() => el.classList.add('on'));
    quickTab(tab || 'type');
    showChrome();
    autoHideChrome(20000);           // 面板开着就先别自动收走顶栏底栏
  }
  function closeQuick(fromBack) {
    const el = quickEl(); if (!el || !quickOn) return;
    quickOn = false;
    el.classList.remove('on');
    el.style.transform = '';
    setTimeout(() => { if (!quickOn) el.classList.add('hidden'); }, 240);
    autoHideChrome();
    if (!fromBack) closeOverlay();   // 用户自己收的（点"收起"/点正文）→ 把历史那一格还回去
  }
  function quickToggle(t) { if (quickOn && quickCur === t) closeQuick(); else openQuick(t); }

  /* 抓手往下拉 = 收起（原生阅读器都有这个手势）。跟手位移，松手过 64px 才真收。 */
  function wireQuickDrag() {
    const el = quickEl(); if (!el) return;
    const bar = $('.rd-quick-bar', el); if (!bar) return;
    let y0 = 0, dy = 0, dragging = false;
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;      // 抓手那一条上的按钮不参与拖拽
      dragging = true; dy = 0; y0 = e.clientY;
      el.style.transition = 'none';
      try { bar.setPointerCapture(e.pointerId); } catch (x) {}
    });
    bar.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      dy = Math.max(0, e.clientY - y0);
      el.style.transform = 'translateY(' + dy + 'px)';
    });
    const up = () => {
      if (!dragging) return;
      dragging = false;
      el.style.transition = '';
      if (dy > 64) closeQuick(); else el.style.transform = '';
      dy = 0;
    };
    bar.addEventListener('pointerup', up);
    bar.addEventListener('pointercancel', up);
  }

  /* ══════════════ 目录 #rd-toc：**独立的一整块**（第 2 屏） ══════════════
     。
     所以它不再是一个页签，而是自己一块从底下升起的高面板：
       · 固定头：书名 + 「共 N 章」+ 关闭键
       · 独立滚动体：**一行一章，只有章号 + 章名**（当前章高亮），不放任何说明文字
       · 固定底：「回到当前章」「新建一章」
     长按一行仍然是"改章名 / 删除这一章"（章一级的操作跟着章走）。
     收起四条路：点蒙层、关闭键、选中一章、手机返回键。 */
  let tocOn = false;
  function tocEl() { return document.getElementById('rd-toc'); }

  /* 章节名里本来就带着「第001章」：拆成 *章号* 和 *章名* 两段，列表里只显示这两样，
     不重复、不夹说明文字。作者自己起的标题（不是这个格式）就退回"行号 + 原名"。 */
  function tocPiece(c, i) {
    const raw = String((c && c.name) || '').trim()
      || String((c && c.path) || '').split('/').pop().replace(/\.md$/, '');
    const m = raw.match(/^第\s*0*(\d+)\s*章\s*[-—_·:：]?\s*/);
    if (m) {
      const nm = raw.slice(m[0].length).replace(/[-_]+/g, ' ').trim();
      return { no: m[1].padStart(3, '0'), nm: nm || raw };
    }
    return { no: String(i + 1).padStart(3, '0'), nm: prettyName(raw) };
  }

  function tocListHtml() {
    return (R.book.chapters || []).map((c, i) => {
      const p = tocPiece(c, i);
      const cur = c.path === R.path;
      return '<button class="rd-toc-item' + (cur ? ' cur' : '') + '" data-path="' + esc(c.path) + '"'
        + (cur ? ' aria-current="true"' : '') + '>'
        + '<span class="no">' + esc(p.no) + '</span>'
        + '<span class="nm">' + esc(p.nm) + '</span></button>';
    }).join('');
  }

  /* 画目录。空的时候给一句人话（不显示一块空白 —— 空态也是要设计的那一态）。 */
  function tocPaint() {
    const el = tocEl(); if (!el) return;
    const body = document.getElementById('rd-toc-body', el);
    const sub = document.getElementById('rd-toc-sub', el);
    if (!body) return;
    const chs = (R.book && R.book.chapters) || [];
    if (sub) sub.textContent = (R.book && chs.length) ? ('共 ' + chs.length + ' 章') : '';
    if (!R.book) {
      body.innerHTML = '';
      body.appendChild(UI.state({ kind: 'empty', icon: 'list', title: '还没打开书', desc: '先回书架打开一本。' }));
      return;
    }
    if (!chs.length) {
      body.innerHTML = '';
      body.appendChild(UI.state({ kind: 'empty', icon: 'list', title: '这本书还没有章节',
        desc: '点下面「新建一章」开始写。' }));
      return;
    }
    body.innerHTML = tocListHtml();
    const cur = $('.rd-toc-item.cur', body);
    if (cur) setTimeout(() => { body.scrollTop = Math.max(0, cur.offsetTop - body.clientHeight / 2 + cur.offsetHeight / 2); }, 30);
    else body.scrollTop = 0;
  }

  function tocOpen() {
    const el = tocEl(); if (!el) return;
    /* 有别的面板立着 → 等它**真的收下去**再开目录。
       以前写成"App.closeSheet(); 紧接着往下走"，旧面板收尾那一拍会把刚开的目录一起带走
       （监督人探针实测：面板高度 0）—— 也就是此处说明"点开目录跟没点一样/闪一下"，
       然后外部那个 setTimeout 640ms 又把它开了一次 → 看着就像"在设置里点开了目录"。 */
    if (App.sheetOpen && App.sheetOpen()) { App.closeSheet(() => tocOpen()); return; }
    /* 从底栏「目录」进：设置面板让位。**用 fromBack=true 收它** —— 历史那一格留给目录，
       不然两层面板各压一格、返回键要按两下才退得出去（此前的反馈那类怪事）。 */
    if (quickOn) closeQuick(true);
    tocPaint();
    if (tocOn) return;
    tocOn = true;
    pushOverlay();
    el.classList.remove('hidden');
    requestAnimationFrame(() => el.classList.add('on'));
    showChrome();
    autoHideChrome(20000);          // 面板开着先别自动收走顶栏底栏
  }
  function tocClose(fromBack) {
    const el = tocEl(); if (!el || !tocOn) return;
    tocOn = false;
    el.classList.remove('on');
    setTimeout(() => { if (!tocOn) el.classList.add('hidden'); }, 260);
    autoHideChrome();
    if (!fromBack) closeOverlay();
  }
  function tocToggle() { if (tocOn) tocClose(); else tocOpen(); }

  function wireTocSheet() {
    const el = tocEl(); if (!el || el.dataset.wired) return;
    el.dataset.wired = '1';
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="rd-toc-close"]')) { tocClose(); return; }
      const act = e.target.closest('[data-toc]');
      if (act) {
        hapNow();
        if (act.dataset.toc === 'new') { tocClose(); setTimeout(newChapter, 180); return; }
        const cur = $('.rd-toc-item.cur', el);
        if (cur) cur.scrollIntoView({ block: 'center' });
        else App.toast('还没打开书');
        return;
      }
      const it = e.target.closest('.rd-toc-item[data-path]');
      if (!it) return;
      const p = it.dataset.path;
      tocClose();
      if (p !== R.path) toChapter(p, 0).then(showChrome); else showChrome();
    });
    wireTocLongPress(el);
    wireTocNoCallout(el);
  }

  /* 目录里长按一章 = 改名 / 删除。
     以前每行右边挂一个小「更多」按钮（删掉："右上角的三个点完全去掉……不许两套"），
     长按是手机上更自然的手势，也不会挤占章节名的宽度。 */
  function wireTocLongPress(el) {
    let timer = null, path = null, y0 = 0;
    const cancel = () => { clearTimeout(timer); timer = null; };
    el.addEventListener('pointerdown', (e) => {
      const it = e.target.closest && e.target.closest('.rd-toc-item[data-path]');
      if (!it) return;
      path = it.dataset.path; y0 = e.clientY;
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const p = path; path = null;
        if (!p) return;
        tocClose(true);                        // 只收目录这一层（历史那一格留给紧接着的章节菜单）
        setTimeout(() => chapterMenu(p), 200);
      }, 520);
    }, true);
    el.addEventListener('pointermove', (e) => {
      if (!timer) return;
      if (Math.abs(e.clientY - y0) > 10) cancel();   // 在划列表 = 不是长按
    }, true);
    el.addEventListener('pointerup', cancel, true);
    el.addEventListener('pointercancel', cancel, true);
    el.addEventListener('scroll', cancel, true);
  }
  /* 长按的系统菜单（选中文字 / 上下文菜单）在目录里要按掉，不然跟长按改名打架 */
  function wireTocNoCallout(el) {
    el.addEventListener('contextmenu', (e) => { if (e.target.closest && e.target.closest('.rd-toc-item')) e.preventDefault(); });
  }

  function quickAct(a, node) {
    if (a === 'share') { hapNow(); shareChapter(); return; }      // 旧版「分享」那一格
    if (a === 'tts') { ttsToggle(); setTimeout(quickRefreshTts, 120); setTimeout(quickRefreshTts, 700); return; }
    if (a === 'ttsdiag') { ttsSelfCheckSheet(); return; }
    if (a === 'note') { closeQuick(); noteSheet(); return; }
    if (a === 'mark') {
      Reader.addMark();
      if (node) { node.classList.add('on'); setTimeout(() => node.classList.remove('on'), 520); }
      return;
    }
  }

  function wireQuick() {
    const el = quickEl(); if (!el || el.dataset.wired) return;
    el.dataset.wired = '1';
    /* 一个委托监听器管住整块面板：面板内容是**每次切页签重画**的，
       如果我们在画完之后各自 addEventListener，重画一次就全丢了 ——
       "点了没反应 / 只闪一下"这类毛病多半就是这么来的。 */
    el.addEventListener('click', (e) => {
      const qb = e.target.closest('[data-q]');
      if (qb) { quickTab(qb.dataset.q); return; }
      if (e.target.closest('[data-act="reader-quick-close"]')) { closeQuick(); return; }
      const body = document.getElementById('rd-quick-body', el);
      if (!body || !body.contains(e.target)) return;
      const del = e.target.closest('[data-del]');
      if (del) {
        Marks.remove(R.slug, +del.dataset.del);
        App.toast('已删除书签');
        quickTab('mark');
        return;
      }
      const mk = e.target.closest('[data-mark]');
      if (mk) {
        const m = (Marks.list(R.slug) || [])[+mk.dataset.mark];
        if (m) { closeQuick(); toChapter(m.path, m.percent || 0).then(showChrome); }
        return;
      }
      const nt = e.target.closest('[data-note]');
      if (nt) { openNoteDetail(nt.dataset.note); return; }
      const a = e.target.closest('[data-a]');
      if (a) { quickAct(a.dataset.a, a); return; }
    });
    wireQuickDrag();
  }

  /* ---------- 顶栏/底栏显隐 ---------- */
  /* 顶栏/底栏一收一放，可用高度就变了（chrome-off 时它们连高度一起让出去，见 reader.css）。
     所以显隐之后必须跟着重排一次：让正文按新的可用高度重新分页、铺满整屏 ——
     只把栏变透明不重排，上下就会留一条空带（第一条）。 */
  function chromeRelayout() {
    if (!R.ready || !R.slug || !R.text) return;
    const st = R.els.stage;
    if (!st || !st.clientWidth || !st.clientHeight) return;
    if (Math.abs(st.clientHeight - R.lastH) < 2) return;   // 高度没变就不白重排
    const keep = R.pct;
    layout();
    R.idx = pageOf(keep);
    apply(0);
  }
  function showChrome() {
    if (!R.els.screen) return;
    R.els.screen.classList.remove('chrome-off');
    R.chromeVisible = true;
    chromeRelayout();
  }
  function hideChrome() {
    if (!R.els.screen) return;
    R.els.screen.classList.add('chrome-off');
    R.chromeVisible = false;
    chromeRelayout();
  }
  function toggleChrome() {
    if (!R.chromeVisible) { showChrome(); autoHideChrome(4200); } else hideChrome();
  }
  function autoHideChrome(ms) {
    clearTimeout(R.chromeTimer);
    R.chromeTimer = setTimeout(() => {
      if (turning) return autoHideChrome(1500);
      if (R.ttsOn) return autoHideChrome(4000);
      if (quickOn) return autoHideChrome(20000);   // 面板开着：顶栏/底栏先别收走
      hideChrome();
    }, ms || 3600);
  }

  /* ---------- 抽屉内容 ---------- */

  /* ---------- 章节增删改 ---------- */
  function nextChapterPath() {
    const chs = (R.book && R.book.chapters) || [];
    // 平台有两种目录格式：老版 manuscript/第001章-xx.md，新版 manuscript/001-卷/001-章/index.md
    const vol = chs.find((c) => /\/\d+-chapter\/index\.md$/.test(c.path));
    if (vol) {
      const volDir = vol.path.split('/').slice(0, -2).join('/');
      let mx = 0;
      chs.forEach((c) => {
        const m = c.path.match(/\/(\d+)-chapter\/index\.md$/);
        if (m) mx = Math.max(mx, +m[1]);
      });
      return { path: volDir + '/' + String(mx + 1).padStart(3, '0') + '-chapter/index.md', book: true };
    }
    let mx = 0;
    chs.forEach((c) => {
      const m = (c.name || '').match(/第\s*0*(\d+)\s*章/);
      if (m) mx = Math.max(mx, +m[1]);
    });
    return { path: 'manuscript/第' + String(mx + 1).padStart(3, '0') + '章-新章节.md', book: false };
  }

  function newChapter() {
    if (!R.slug) return;
    const nx = nextChapterPath();
    App.modal(
      '<div style="font-size:var(--t-lg);font-weight:var(--w-semi);margin-bottom:var(--sp-3)">新建一章</div>' +
      '<input id="nc-name" class="input" placeholder="章节名（可留空，稍后再改）" ' +
      'style="-webkit-user-select:text;user-select:text">' +
      '<div style="display:flex;gap:var(--sp-3);margin-top:var(--sp-4)">' +
      '<button class="btn btn-block" data-close>取消</button>' +
      '<button class="btn btn-primary btn-block" id="nc-go">创建并打开</button></div>',
      {
        onMount(p) {
          const inp = p.querySelector('#nc-name');
          setTimeout(() => inp.focus(), 140);
          p.querySelector('#nc-go').addEventListener('click', async () => {
            const nm = (inp.value || '').trim();
            let path = nx.path;
            if (nm) {
              path = nx.book
                ? nx.path.replace(/index\.md$/, 'index.md')
                : nx.path.replace(/-新章节\.md$/, '-' + nm.replace(/[\\/:*?"<>|]/g, '') + '.md');
            }
            const content = nm && nx.book
              ? '---\ntitle: ' + nm + '\ntype: chapter\nstatus: draft\n---\n\n'
              : '';
            try {
              await API.chapterNew(R.slug, path, content);
              App.closeModal();
              App.toast('已新建');
              R.book = await API.book(R.slug, true);
              await toChapter(path, 0);
              showChrome();
            } catch (e) { App.toast('新建失败：' + e.message); }
          });
        },
      });
  }

  function renameChapter(path, cur) {
    const book = /\/index\.md$/.test(path);
    App.modal(
      '<div style="font-size:var(--t-lg);font-weight:var(--w-semi);margin-bottom:var(--sp-3)">改章名</div>' +
      '<input id="cn-name" class="input" style="-webkit-user-select:text;user-select:text">' +
      '<div style="font-size:var(--t-sm);color:var(--ink-3);margin-top:var(--sp-2)">只改这一章的名字，顺序和正文都不动。</div>' +
      '<div style="display:flex;gap:var(--sp-3);margin-top:var(--sp-4)">' +
      '<button class="btn btn-block" data-close>取消</button>' +
      '<button class="btn btn-primary btn-block" id="cn-go">保存</button></div>',
      {
        onMount(p) {
          const inp = p.querySelector('#cn-name');
          inp.value = cur;
          setTimeout(() => { inp.focus(); inp.select(); }, 140);
          p.querySelector('#cn-go').addEventListener('click', async () => {
            const t = (inp.value || '').trim();
            if (!t) { App.toast('名字不能空着'); return; }
            try {
              if (book) {
                // 新版结构：章名写在文件头的 title 里
                const d = await API.chapter(R.slug, path);
                let txt = d.content || d.text || '';
                if (/^---\n[\s\S]*?\n---/.test(txt)) {
                  txt = txt.replace(/^---\n[\s\S]*?\n---/, (fm) =>
                    /^title:.*$/m.test(fm) ? fm.replace(/^title:.*$/m, 'title: ' + t)
                      : fm.replace(/^---\n/, '---\ntitle: ' + t + '\n'));
                } else {
                  txt = '---\ntitle: ' + t + '\ntype: chapter\nstatus: draft\n---\n\n' + txt;
                }
                await API.saveFile(R.slug, path, txt);
              } else {
                const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
                const base = path.slice(dir.length).replace(/\.md$/, '');
                const pref = (base.match(/^第\s*\d+\s*章[-—·\s]*/) || [''])[0];
                const to = dir + pref + t.replace(/[\\/:*?"<>|]/g, '') + '.md';
                if (to === path) { App.closeModal(); return; }
                await API.chapterRename(R.slug, path, to);
                if (R.path === path) R.path = to;
              }
              App.closeModal();
              App.toast('改好了');
              R.book = await API.book(R.slug, true);
              refreshToc();
            } catch (e) { App.toast('改名失败：' + e.message); }
          });
        },
      });
  }

  /* 分享这一章（阶段 23.5）：
     App 里走原生分享（Android.share → 系统「分享到」面板）；浏览器里优先系统分享 API；
     都不给用就退回「复制到剪贴板」，总之点了必须有反馈，不许没反应。 */
  async function shareChapter() {
    const ch = R.chapter;
    if (!ch) { App.toast('这一章还没打开'); return; }
    const book = (R.book && R.book.title && R.book.title !== R.book.slug) ? R.book.title : R.slug;
    const cname = prettyName(ch.name || R.path || '');
    const title = '《' + book + '》' + cname;
    const body = String(R.text || R.cache[R.path] || '').trim();
    const text = title + (body ? '\n\n' + body : '');
    if (window.Android && typeof Android.share === 'function') {
      try { Android.share(title, text); return; } catch (e) {}
    }
    if (navigator.share) {
      try { await navigator.share({ title: title, text: text }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    try {
      await navigator.clipboard.writeText(text);
      App.toast('这一章已复制，粘贴到哪儿都行');
    } catch (e) {
      App.toast('这个环境不支持分享，试试长按正文选中复制');
    }
  }

  /* 菜单行（书卡菜单 / 章菜单**共用这一处**，样式都是 .rd-menu-rows 那一套 ——
     "UI 要统一"，就是别让两个菜单各长一个样）。 */
  function menRow(a, nm, sub) {
    return '<div class="rd-toc-item" data-a="' + a + '"><span class="nm">' + nm + '</span>' +
      '<span class="wd">' + (sub || '') + '</span><span class="go">' + iconHtml('chevron') + '</span></div>';
  }

  function chapterMenu(path) {
    const ch = ((R.book && R.book.chapters) || []).find((c) => c.path === path) || {};
    const cur = prettyName(ch.name || path.split('/').pop().replace(/\.md$/, ''));
    pushOverlay();
    App.sheet(
      '<div class="sheet-grip"></div>' +
      '<div class="sheet-head"><h3>' + esc(cur) + '</h3>' +
      '<button class="icon-btn" data-close aria-label="关闭">' + iconHtml('close') + '</button></div>' +
      '<div class="rd-menu-body">' +
        '<div class="rd-menu-rows">' +
          menRow('rename', '改章名', '换个名字') +
          menRow('share', '分享这一章', '复制出去给别人') +
        '</div>' +
        '<div class="rd-menu-rows rd-menu-danger">' +
          menRow('del', '删除这一章', '删了就找不回来') +
        '</div>' +
      '</div>',
      {
        onMount(p) {
          p.addEventListener('click', (e) => {
            if (e.target.closest('[data-close]')) { App.closeSheet(); return; }
            const row = e.target.closest('[data-a]');
            if (!row) return;
            const a = row.dataset.a;
            /* 要接着弹输入框/确认框的：等面板收下去再弹（closeSheet 的回调），
               同一拍"关完立刻弹"就是书卡菜单那个"点了没反应"的同一类写法。 */
            if (a === 'rename') { App.closeSheet(() => renameChapter(path, cur)); return; }
            if (a === 'share') { App.closeSheet(() => shareChapter()); return; }
            App.closeSheet(() => App.confirm('删掉「' + cur + '」这一章？删了就找不回来了。', async () => {
              try {
                await API.chapterDelete(R.slug, path);
                App.toast('已删除');
                if (R.path === path) R.path = null;
                R.book = await API.book(R.slug, true);
                refreshToc();
              } catch (err) { App.toast('删除失败：' + err.message); }
            }, '确认删除'));
          });
        },
      });
  }
  function marksHtml() {
    const arr = Marks.list(R.slug) || [];
    if (!arr.length) return '<div class="rd-toc-empty">还没有书签<br>读到想记住的地方，点「加书签」</div>';
    return arr.map((m, i) => {
      const chs = R.book ? (R.book.chapters || []).find((c) => c.path === m.path) : null;
      return '<div class="rd-toc-mark">' +
        '<div class="tx" data-mark="' + i + '">' + esc((chs ? prettyName(chs.name) + ' · ' : '') + (m.text || '书签')) + '</div>' +
        '<span class="pc">' + (m.percent || 0) + '%</span>' +
        '<button class="del" data-del="' + i + '" aria-label="删除">' + iconHtml('trash') + '</button></div>';
    }).join('');
  }

  /* ── 笔记（存在服务器上，换设备也在；跟书签分工：书签管读到哪，笔记管想到什么）── */
  function noteQuote() {
    if (!R.path || !R.text) return '';
    const i = clamp(Math.round((R.pct / 100) * Math.max(0, R.text.length - 1)), 0, Math.max(0, R.text.length - 1));
    return R.text.slice(i, i + 40).replace(/\s+/g, '');
  }

  /* 章节改名 / 删除之后，把目录重新画一遍（面板开着就重画、收着就重新打开） */
  function refreshToc() { tocOpen(); }          // 改名 / 删除之后：把目录重新画出来给用户看结果

  async function notesHtml(body) {
    body.innerHTML = '<div class="rd-toc-empty">读笔记…</div>';
    /* 两段：**笔记**（我的想法）和**批注**（挂在某一段上的待办，不进正文一个字）。
       一条笔记都没有的时候，也不能把"批注"那段藏起来 —— 用户就是来用批注的。 */
    let d = null, mg = { items: [] };
    try { d = await API.notes(R.slug); } catch (e) { d = null; }
    try { mg = await API.nb('api/notes/margin?slug=' + encodeURIComponent(R.slug || '')); }
    catch (e) { mg = null; }
    if (d === null && mg === null) {
      body.innerHTML = '<div class="rd-toc-empty">读不到笔记（可能连不上服务器）</div>'; return;
    }
    const items = (d && d.items) || [];
    const margins = (mg && mg.items) || [];
    quickNotes = items;
    quickMargins = margins;
    const head = '<div class="rd-qsec">批注 · 给自己留的待办</div>' +
      '<button class="rd-addm" data-addmargin>' + iconHtml('plus') + '<span>给这一段加批注</span></button>';
    const mList = margins.length ? margins.map((m) =>
      '<div class="rd-toc-mark"><div class="tx" data-margin="' + m.id + '">' +
        esc((m.note || '（空）').slice(0, 40)) + '</div>' +
      '<span class="pc">' + esc(String(m.path || '').split('/').pop() || '') + '</span>' +
      '<button class="del" data-mdel="' + m.id + '" aria-label="删掉">' + iconHtml('trash') + '</button></div>').join('')
      : '<div class="rd-toc-empty">还没有批注<br>读到要改的地方，点上面「给这一段加批注」</div>';
    const noteSec = '<div class="rd-qsec">笔记 · 我想到的</div>' +
      (items.length ? items.map((n) =>
        '<div class="rd-toc-mark"><div class="tx" data-note="' + n.id + '">' +
        esc((n.text || n.quote || '（空）').slice(0, 42)) + '</div>' +
        '<span class="pc">' + esc(String(n.path || '').split('/').pop() || '') + '</span></div>').join('')
        : '<div class="rd-toc-empty">还没有笔记<br>读到有想法的地方，点下边「记一笔」</div>');
    body.innerHTML = head + mList + noteSec;
    const add = body.querySelector('[data-addmargin]');
    if (add) add.onclick = () => { hapNow(); marginSheet(); };
    body.querySelectorAll('[data-margin]').forEach((el) => {
      el.onclick = async () => {
        const m = (quickMargins || []).find((x) => String(x.id) === String(el.dataset.margin));
        if (!m) return;
        closeQuick();
        if (m.path) await toChapter(m.path, m.percent || 0);
      };
    });
    body.querySelectorAll('[data-mdel]').forEach((b) => {
      b.onclick = async (e) => {
        e.stopPropagation();
        try {
          await API.nb('api/notes/margin?slug=' + encodeURIComponent(R.slug || '') + '&id=' + b.dataset.mdel,
            { method: 'DELETE', body: {} });
          App.toast('删了'); quickTab('note');
        } catch (err) { App.toast('删不掉：' + err.message); }
      };
    });
  }

  /* 小批注的入口：**优先用你真正选中的那段字**（没选就用当前位置那 40 个字）。
     批注只存在库里，**不进正文一个字** —— 导出 txt 里永远搜不到它（这条有反证测试盯着）。 */
  function marginSheet() {
    const sel = (function () {
      try {
        const s2 = window.getSelection();
        const t = s2 && String(s2.toString() || '').replace(/\s+/g, ' ').trim();
        return t ? t.slice(0, 120) : '';
      } catch (e) { return ''; }
    })();
    const quote = sel || noteQuote();
    App.sheet('<div class="sheet-head"><h3>加一条批注</h3><button class="btn sm" data-close>关闭</button></div>' +
      '<div style="padding:0 var(--sp-4) calc(var(--safe-b) + var(--sp-4))">' +
      '<div class="t-hint" style="margin:0 0 var(--sp-2)">' + (sel ? '你选中的这一段' : '这一句（没选中）') + '</div>' +
      (quote ? '<div class="t-pre">' + esc(quote) + '</div>' : '') +
      '<textarea class="t-area" rows="4" placeholder="想改成什么？（例：这里要补一场打斗）"></textarea>' +
      '<div class="t-hint" style="margin:var(--sp-2) 0 0">批注不会写进正文，导出 txt 里不会有它。</div>' +
      '<div class="t-bar" style="margin-top:var(--sp-3)"><button class="t-btn pri" data-save>记下</button></div></div>');
    const pn = document.getElementById('sheet-panel');
    const ta = pn.querySelector('.t-area');
    setTimeout(() => ta && ta.focus(), 80);
    pn.querySelector('[data-save]').onclick = async () => {
      const text = ta.value.trim();
      if (!text) { App.toast('还没写呢'); return; }
      try {
        await API.nb('api/notes/margin', { method: 'POST', body: {
          slug: R.slug, path: R.path, percent: R.pct, quote: quote, note: text } });
        App.toast('记下了'); App.haptic && App.haptic(8);
        App.closeSheet();
      } catch (e) { App.toast('记不了：' + e.message); }
    };
  }

  /* 点开一条笔记：整屏弹层看全文（面板里只放得下一行，全文得换个地方）。
     改 / 删都在这一层；删完把面板的「笔记」页重新拉一遍。 */
  function openNoteDetail(id) {
    const n = (quickNotes || []).find((x) => String(x.id) === String(id));
    if (!n) { App.toast('这条笔记找不到了，刷新一下'); return; }
    pushOverlay();
    App.sheet('<div class="sheet-head"><h3>笔记</h3><button class="btn sm" data-close>关闭</button></div>' +
      '<div style="padding:0 var(--sp-4) var(--sp-5)">' +
      (n.quote ? '<div class="t-hint" style="margin:0 0 var(--sp-2)">当时读到</div><div class="t-pre">' + esc(n.quote) + '</div>' : '') +
      '<div class="t-hint" style="margin:var(--sp-3) 0 var(--sp-2)">我写的</div>' +
      '<div class="t-pre selectable">' + esc(n.text || '（空）') + '</div>' +
      '<div class="t-bar" style="margin-top:var(--sp-3)">' +
      (n.path ? '<button class="t-btn pri" data-go>去那一章</button>' : '') +
      '<button class="t-btn dan" data-del>删掉</button></div></div>');
    const pn = document.getElementById('sheet-panel');
    const go = pn.querySelector('[data-go]');
    if (go) go.onclick = async () => { App.closeSheet(); if (n.path) await toChapter(n.path, (n.percent || 0)); showChrome(); };
    pn.querySelector('[data-del]').onclick = async () => {
      try {
        await API.noteDelete(R.slug, n.id);
        App.closeSheet();
        App.toast('删了');
        quickRefreshNotes();
      } catch (e) { App.toast('删不了：' + e.message); }
    };
  }
  /* 笔记删完之后把那一页重新拉一遍（面板可能已经收了，收了就不管） */
  function quickRefreshNotes() {
    const el = quickEl();
    if (!quickOn || !el) return;
    const body = document.getElementById('rd-quick-body', el);
    if (body && quickCur === 'note') notesHtml(body);
  }

  function noteSheet() {
    const quote = noteQuote();
    App.sheet('<div class="sheet-head"><h3>记一笔</h3><button class="btn sm" data-close>关闭</button></div>' +
      '<div style="padding:0 var(--sp-4) calc(var(--safe-b) + var(--sp-4))">' +
      (quote ? '<div class="t-hint" style="margin:0 0 var(--sp-2)">这一句</div><div class="t-pre">' + esc(quote) + '</div>' : '') +
      '<textarea class="t-area" rows="5" placeholder="想到了什么？（这一条会跟着书走，换设备也在）"></textarea>' +
      '<div class="t-bar" style="margin-top:var(--sp-3)"><button class="t-btn pri" data-save>记下</button></div></div>');
    const pn = document.getElementById('sheet-panel');
    const ta = pn.querySelector('.t-area');
    setTimeout(() => ta && ta.focus(), 80);
    pn.querySelector('[data-save]').onclick = async () => {
      const text = ta.value.trim();
      if (!text) { App.toast('还没写呢'); return; }
      try {
        await API.noteSave({ slug: R.slug, path: R.path, percent: R.pct, quote: quote, text: text });
        App.toast('记下了'); App.haptic && App.haptic(8);
        App.closeSheet();
      } catch (e) { App.toast('记不了：' + e.message); }
    };
  }


  /* ---------- 编辑本章 ---------- */
  function editChapter() {
    if (!R.path) { App.toast('先打开一章'); return; }
    showChrome();
    const root = document.createElement('div');
    root.className = 'rd-editor';
    root.innerHTML =
      '<div class="rd-editor-head"><div class="row-title">' + esc(prettyName(R.chapter.name || '')) + ' · 编辑</div>' +
      '<button class="icon-btn" data-close aria-label="关闭">' + iconHtml('close') + '</button></div>' +
      '<textarea spellcheck="false"></textarea>' +
      '<div class="rd-editor-foot"><span class="rd-editor-info"></span>' +
      '<button class="btn btn-primary" id="rd-save">保存</button></div>';
    const ta = $('textarea', root);
    const info = $('.rd-editor-info', root);
    ta.value = R.text;
    const upd = () => { info.textContent = ta.value.length + ' 字' + (ta.value !== R.text ? ' · 已修改' : ''); };
    ta.addEventListener('input', upd);
    upd();
    $('[data-close]', root).addEventListener('click', () => App.closeModal());
    $('#rd-save', root).addEventListener('click', async () => {
      const btn = $('#rd-save', root);
      if (ta.value === R.text) { App.closeModal(); return; }
      btn.textContent = '保存中…'; btn.disabled = true;
      try {
        await API.saveFile(R.slug, R.path, ta.value);
        R.cache[R.path] = ta.value;
        R.text = ta.value;
        R.els.cols.innerHTML = mdToHtml(R.text);
        layout();
        R.idx = pageOf(R.pct);
        apply(0);
        App.closeModal();
        App.toast('已保存');
      } catch (err) {
        App.toast('保存失败：' + (err.message || ''));
        btn.textContent = '保存'; btn.disabled = false;
      }
    });
    pushOverlay();
    App.modal(root, { onMount() { setTimeout(() => { try { ta.focus(); } catch (e) {} }, 80); } });
  }

  /* ---------- 听书：分段播放，一点就出声 ---------- */
  /* 老做法是把整章丢给服务端一次性生成 —— 一章 4000 字要等几十秒，
     这期间界面一动不动，用户看到的就是「点了没反应 / 没声音 / 跳走了」。
     现在按句子切成小段逐段取：第一段 1~2 秒就响，后面边播边取；
     按钮全程显示状态（准备中 / 停止），不会再出现「点了没反应」。 */
  const ttsPre = [];                       // 预取的下一段，避免段与段之间有空档

  function ttsPaint() {
    const b = R.els.ttsBtn;
    if (!b) return;
    const busy = !!R.ttsBusy;
    const label = busy ? '准备中' : (R.ttsOn ? '停止' : '听书');
    b.innerHTML = iconHtml(busy ? 'refresh' : (R.ttsOn ? 'pause' : 'sound')) +
                  '<span>' + label + '</span>';
    b.classList.toggle('tts-on', !!(R.ttsOn || busy));
    b.classList.toggle('tts-busy', busy);
    /* 底部面板「听书」那页的按钮也跟着变（别让两处显示不一致）。
       只在"真的换了状态"时重画 —— ttsPaint 每读一句都会跑一次，
       每次都重画会跟着打一串 /api/tts/voices（那个接口没有缓存）。 */
    const key = (busy ? 'b' : '') + (R.ttsOn ? 'o' : '') + (R.ttsWant ? 'w' : '');
    if (R.ttsKey !== key) { R.ttsKey = key; quickRefreshTts(); }
  }

  /* 建好那个 <audio> 元素（只建一次）+ 挂事件。**同步函数**：点击那一刻就要能调它。 */
  function ttsEnsureAudio() {
    if (!R.audio) {
      R.audio = new Audio();
      R.audio.preload = 'auto';
      R.audio.addEventListener('ended', () => {
        /* ⚠ 解锁用的那个静音片段也在**同一个** <audio> 上 —— 它播完会立刻触发 ended，
           不排除掉的话，用户点「听书」会直接从第 2 段开始（第 1 段被吃掉）。
           （实测到的：解锁后 currentTime 刚走到 0.24 秒就跳到下一段。） */
        if (/^data:audio\/wav/.test(String(R.audio.currentSrc || R.audio.src || ''))) return;
        if (!R.ttsWant) return;
        if (R.ttsSeg + 1 < R.ttsCount) { ttsPlay(R.ttsSeg + 1); return; }
        if (R.pathNext) {                                   // 这章读完 → 接着下一章
          toChapter(R.pathNext, 0).then(() => { if (R.ttsWant) ttsStart(); });
        } else { ttsStop(true); App.toast('全书读完了'); }
      });
      R.audio.addEventListener('error', () => {
        if (!R.ttsWant) return;
        const src = String(R.audio.currentSrc || R.audio.src || '');
        const err = R.audio.error || {};
        const off = !src || /^file:/.test(src);              // 地址都没拼出来 = 后端地址没拿到
        /* 以前这里只有两句笼统的 toast（"连不上服务器" / "语音加载失败"），
           不带 HTTP 码、不带 audio.error.code、不带地址 —— 此处说明"没声音"，
           我们连"卡在哪一环"都不知道。现在把能拿到的**全部**记下来，自检里直接能看。 */
        R.ttsLastError = {
          事件: 'audio error', 地址: src, 地址尾巴: src.slice(-70),
          errorCode: err.code === undefined ? null : err.code,
          errorMessage: err.message || '',
          networkState: R.audio.networkState, readyState: R.audio.readyState,
          段: R.ttsSeg, 共几段: R.ttsCount, 时间: Date.now(),
        };
        ttsStop(true);
        App.toast(off ? '连不上服务器：听书要联网（设置里可以「听书自检」看卡在哪）'
                      : ('语音加载失败：' + (err.code !== undefined ? ('code=' + err.code + ' ') : '')
                         + (err.message || '') + '（设置里可以「听书自检」看卡在哪）'));
      });
    }
    return R.audio;
  }

  /* ⚠ 用户点「听书」那一刻**必须同步**做这一下，否则第一下不出声（监督人实测的根因）：
     自动播放策略要的是"用户手势"（真实的那一下点击）。而 `ttsStart()` 里
     `await API.ttsSegments(...)` 一 await，手势凭证就过期了 —— 等段数回来再 play()，
     浏览器直接拒掉（NotAllowedError：play() can only be initiated by a user gesture）。
     修法：点击的**同一个 tick** 里先拿一个极短的静音片段 play() 一次，把这个元素"解锁"；
     之后就随便换 src、随便 await，它已经不再被拦。 */
  const SILENT_WAV = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
  function ttsUnlock() {
    /* 判据的反证钩子（tools/e2e-ttsdiag.js 的 TTSD_FORCE=nogesture）：
       勾上它就等于"点击时没做同步解锁"那一版老代码 —— 那时浏览器会把 play() 拒掉。 */
    if (window.__TTSD_NO_UNLOCK) return;
    const au = ttsEnsureAudio();
    try {
      if (au.readyState === 0 || !au.currentSrc) au.src = SILENT_WAV;
      au.muted = false;
      const pr = au.play();
      /* 记下"这一次点击真的把元素解锁了"（判据要核这一点：
         光看最后在播不够 —— 元素可能被上一次操作解锁过，看不出这次点击有没有做解锁）。 */
      R.ttsUnlockedAt = Date.now();
      if (pr && pr.catch) pr.catch(() => {});
    } catch (e) { /* 解锁失败不拦着用户，ttsStart 里那条兜底会说话 */ }
  }

  /* 「被打断 → 页面回来接着读」：AbortError 之后浏览器不会自己续播，
     而用户切回 App 看到的是"安静" —— 以为又坏了。切回来就接着读，最多再点一下「继续朗读」。 */
  function wireTtsResume() {
    if (R.ttsResumeWired) return;
    R.ttsResumeWired = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      if (!R.ttsWant || !R.ttsResume) return;
      if (R.audio && !R.audio.paused) return;
      ttsPlay(R.ttsSeg || 0);
    });
  }
  wireTtsResume();

  function ttsToggle() {
    showChrome();
    if (R.ttsOn || R.ttsBusy) { ttsStop(false); return; }
    ttsUnlock();          // ← 必须在这儿（同步、点击的同一 tick），不能挪进 async 里
    ttsStart();
  }

  async function ttsStart() {
    if (!R.path) { App.toast('先打开一章'); return; }
    ttsEnsureAudio();
    R.ttsWant = true; R.ttsOn = true; R.ttsBusy = true; R.ttsSeg = 0; R.ttsPath = R.path;
    R.ttsSeg = 0; R.ttsCount = 0;
    ttsPaint();
    showChrome();

    const gen = ++R.ttsGen;
    let meta = null, ttsErr = null;
    try {
      meta = await API.ttsSegments(R.slug, R.path, Prefs.get('voice'), Prefs.get('rate'),
        Prefs.get('ttsEngine'));
    }
    catch (e) { meta = null; ttsErr = e; }
    if (gen !== R.ttsGen || !R.ttsWant) return;             // 等的过程中被停掉了
    if (!meta || !meta.count) {
      ttsStop(false);
      /* 说清楚**到底为什么没声**（此前的反馈的时候，这一句就是唯一线索）：
         以前不管什么原因都写"这一章没有可朗读的内容" ——
         连不上服务器时用户看到的是"没内容"，其实人话是"连不上、听书要联网"。
         合成在服务器上做（edge-tts），手机自己不会发声，所以断网就是没声。 */
      if (ttsErr && (ttsErr.status === 0 || ttsErr.offline)) App.toast('连不上服务器，听书要联网（点这里重试）');
      else if (ttsErr && ttsErr.status === 401) App.toast('登录过期了，回设置重新输一次密码');
      else if (ttsErr) App.toast('听书失败了：' + ((ttsErr.message || '') + '').slice(0, 30));
      else App.toast('这一章没有可朗读的内容');
      return;
    }
    R.ttsCount = meta.count;
    R.ttsBusy = false;
    ttsPlay(0);
  }

  function ttsPlay(i) {
    if (!R.ttsWant || !R.audio) return;
    R.ttsSeg = i;
    R.ttsBusy = false;
    ttsPaint();
    R.audio.src = API.ttsSegUrl(R.slug, R.path, i, Prefs.get('voice'), Prefs.get('rate'),
      Prefs.get('ttsEngine'));
    try { R.audio.load(); } catch (e) {}
    R.ttsResume = false;                 // 这一下要真播了，先撤掉"待续播"
    const pr = R.audio.play();
    if (pr && pr.then) pr.then(() => { R.ttsResume = false; }).catch(() => {});
    if (pr && pr.catch) pr.catch((e) => {
      if (!R.ttsWant) return;
      /* 以前只处理 NotAllowedError，其它拒绝原因**全被吞掉**（用户按了没声，界面也不说话）。
         现在一律记下来 + 说人话：name/message 原样保留，自检面板里能直接读到。 */
      R.ttsLastError = {
        事件: 'play 被拒', 地址: String(R.audio.currentSrc || R.audio.src || ''),
        地址尾巴: String(R.audio.currentSrc || R.audio.src || '').slice(-70),
        name: (e && e.name) || '', message: (e && e.message) || String(e),
        段: i, 共几段: R.ttsCount, 时间: Date.now(),
      };
      const nm = (e && e.name) || '';
      if (nm === 'NotAllowedError') App.toast('系统拦了自动播放 —— 再点一下「听书」（听书自检里能看到详情）');
      else if (nm === 'AbortError' && !window.__TTSD_NO_ABORT) {
        /* `__TTSD_NO_ABORT` 是判据的反证钩子（tools/e2e-ttsdiag.js 的 TTSD_FORCE=noabort）：
           勾上它就等于"被打断时什么都不做"的老行为 —— 那条判据必须因此报红。 */
        /* 监督人抓到的原文：「The play() request was interrupted because the containing page
           was frozen.」—— 切后台 / 被系统省电冻结，正在播的那一次会被浏览器**中止**。
           这既不是"没联网"也不是"语音坏了"，是**被打断**。
           以前这里一律吞掉：用户回到 App 看到一片安静，只能再点一次（还不知道为什么）。
           现在：说人话 + 记住"是被打断的" + **页面重新可见时自动接着读**。 */
        R.ttsResume = true;
        App.toast('刚才被系统打断了（切到后台 / 省电冻结），回到这一页会自动接着读');
      } else App.toast('播放失败：' + nm + ' ' + ((e && e.message) || '') + '（设置里「听书自检」看详情）');
    });
    /* 读到哪，页面跟到哪：听书时页面一直停在原地就很怪。
       只跟「开读时那一章」，用户自己翻到别章就不管了；设置里可以关。 */
    if (Prefs.get('ttsFollow') !== false && R.path === R.ttsPath && R.pages > 1 &&
        R.ttsCount > 1 && R.mode !== 'scroll' && document.body.dataset.tab === 'reader') {
      const t = clamp(Math.round((i / (R.ttsCount - 1)) * (R.pages - 1)), 0, R.pages - 1);
      if (t !== R.idx) { R.idx = t; apply(340); }
    }
    /* 提前把下一段拉下来：等播完才去要会有明显空档 */
    if (i + 1 < R.ttsCount) {
      try {
        const n = new Audio();
        n.preload = 'auto';
        n.src = API.ttsSegUrl(R.slug, R.path, i + 1, Prefs.get('voice'), Prefs.get('rate'),
          Prefs.get('ttsEngine'));
        ttsPre.push(n);
        while (ttsPre.length > 3) ttsPre.shift();
      } catch (e) {}
    }
  }

  /* ══════════ 听书自检：把"点了听书没声"从哑巴失败变成看得见 ══════════
     此前的反馈是「App 里听书从来没有出过声音」，而界面上什么都不说。
     服务器侧那半由 `GET /api/tts/selfcheck` 给（它只回真数值）；这里补**手机侧**那半：
     音频直链能不能取到（HTTP 码 / 类型 / 字节数 / 开头四字节）、
     `new Audio()` 加载成不成（error.code / networkState / readyState / duration）、
     `play()` 是被拒还是成功（e.name + e.message 原样打出来）。
     最后给一句人话结论，指明**卡在哪一环**。

     判据：tools/e2e-ttsdiag.js —— 四种坏法（地址指错 / 音频 404 / 章节不存在 / 口令过期）
     必须报出**各不相同**的步与原因；把静默失败改回去（TTSD_FORCE=silent）判据必须红。 */
  async function ttsSelfCheck(opts) {
    const o = Object.assign({
      slug: R.slug, path: R.path, voice: Prefs.get('voice'),
      rate: Prefs.get('rate'), engine: Prefs.get('ttsEngine'),
    }, opts || {});
    const rows = [];
    let base = '', segUrl = '';
    /* 关键顺序：先**同步**解锁那个 <audio>（这一步必须在用户点击的同一个 tick 里，
       所以放在所有 await 之前）。不解锁的话，自检自己的 play() 也会被自动播放策略拒掉，
       于是把"其实没问题"误报成"播放被拒" —— 那正是用户最容易被误导的地方。 */
    try { ttsUnlock(); } catch (e) { /* 解锁失败不拦着自检，第 5 项会把真实拒绝原因打出来 */ }
    const F = window.TTSD_FAULT || '';           // 判据的坏法钩子（正常跑永远是空）
    const push = (name, ok, detail) => { rows.push({ name: name, ok: !!ok, detail: detail }); };
    /* 上次播放真的失败过？先说这件事 —— 用户是"点了没声"才来点自检的，
       这一行比什么都直接（它在历史里，不在这次量的数值里）。 */
    if (R.ttsLastError) {
      push('上次播放失败的原因（记下来的）', false, R.ttsLastError);
      R.ttsLastError = null;
    }

    /* ① 后端地址 / 口令：**空 base 在浏览器里是正常的**（同源，相对路径天然就对），
       只有 App 的 file:// 才必须是带口令的绝对地址。
       以前这里写的是 `/^file:|^$/.test(base)` —— 把空 base 也判成"坏"，
       于是用户截图里出现「✗ 后端地址 （空）」，**把真正的原因盖住了**（监督人核出来的）。
       口令单列一项：App 里没有口令 = 媒体地址过不了鉴权（听书就是哑的）。 */
    const onFile = (typeof location !== 'undefined' && location.protocol === 'file:');
    try { base = String(API.base ? API.base() : '') || ''; } catch (e) { base = ''; }
    const badBase = onFile && !base;
    const tokNow = (() => { try { return String((API.token ? API.token() : '') || ''); } catch (e) { return ''; } })();
    push('后端地址', !badBase, {
      地址: base || '（浏览器同源 —— 正常，相对路径天然就对）',
      页面: onFile ? 'App 内嵌（file://，必须绝对地址）' : '浏览器打开（http，同源）',
    });
    push('口令', !(onFile && !tokNow), {
      有没有: tokNow ? ('有（' + tokNow.slice(0, 6) + '…）')
        : (onFile ? '没有 —— App 里媒体地址靠 ?token= 过鉴权，听书会哑' : '浏览器同源走 cookie，不需要'),
    });
    if (F === 'badbase') { base = 'http://127.0.0.1:1/'; }

    /* ② 服务器自检（引擎 / 音色 / 这一章能不能读 / 第 0 段能不能合成）
       ⚠ 地址**一律走 API.abs()**，不许自己拼 —— 它知道页面是在 /novel/ 这种**子路径**下
         还是 file:// 下（file:// 还要带口令）。
         以前这里拼的是 `${base}/api/tts/selfcheck`：浏览器里 base 是空串（同源，本来完全正常），
         拼出来却是**带前导斜杠**的 `/api/tts/selfcheck` → 页面在 /novel/ 下会解析到站点根
         → 404。监督人实测：`/novel/api/tts/selfcheck` 200、`/api/tts/selfcheck` 404。
         ——**接口是好的，是自检自己把地址拼错了**，还反过来把用户带进沟里。 */
    let srv = null, srvErr = null;
    const srvQs = API.qs({ slug: o.slug, path: o.path, voice: o.voice, rate: o.rate, engine: o.engine });
    try {
      /* F=badbase 的反证要能真的打歪地址：那种情况下退回"手拼"（判据用，正常跑不走这条） */
      const srvUrl = (F === 'badbase')
        ? String(base).replace(/\/$/, '') + '/api/tts/selfcheck?' + srvQs
        : API.abs('api/tts/selfcheck?' + srvQs);
      const r = await fetch(srvUrl, { cache: 'no-store' });
      const txt = await r.text();
      try { srv = JSON.parse(txt); } catch (e) { srv = { ok: false, 结论: txt.slice(0, 200) }; }
      if (!r.ok) srvErr = { status: r.status, body: txt.slice(0, 200) };
    } catch (e) { srvErr = { status: 0, name: e && e.name, body: (e && e.message) || String(e) }; }
    const srvOk = !srvErr && srv && srv.ok !== false;
    push('服务器自检（引擎 / 这一章 / 第 0 段）', srvOk, srvErr || { 结论: (srv || {}).结论 || '',
        分项: ((srv || {}).steps || []).map((x) => (x.ok ? '✓' : '✗') + x.name) });
    if (!srvOk) {
      return { ok: false, rows: rows, url: '', why: srvErr
        ? ('服务器这一环没通：HTTP ' + srvErr.status + ' ' + String(srvErr.body || '').slice(0, 120))
        : ('服务器自检说：' + ((srv || {}).结论 || '没通过')) };
    }

    /* ③ 音频直链：HTTP 码 / 类型 / 字节数 / 开头四字节（听书的音频就是它） */
    const seg0 = API.ttsSegUrl(o.slug, o.path, 0, o.voice, o.rate, o.engine);
    segUrl = (F === 'badurl') ? seg0.replace('/seg?', '/seg-nope?') : seg0;
    if (F === 'badtoken') segUrl = segUrl.replace(/token=[^&]*/, 'token=zzz-bad');
    let audio = null;
    try {
      const r = await fetch(segUrl, { cache: 'no-store' });
      const buf = await r.arrayBuffer();
      const head = Array.from(new Uint8Array(buf.slice(0, 4)))
        .map((b) => b.toString(16).padStart(2, '0')).join(' ');
      audio = { status: r.status, type: r.headers.get('content-type') || '', bytes: buf.byteLength,
                开头四字节: head, 尾巴: segUrl.slice(-60) };
      const ok = r.ok && buf.byteLength > 0;
      push('音频直链能取到（第 0 段）', ok, audio);
      if (!ok) {
        return { ok: false, rows: rows, url: segUrl,
                 why: '取音频这一步 HTTP ' + r.status + '（' + audio.type + '，' + audio.bytes + ' 字节）'
                      + ' —— 地址尾巴：' + audio.尾巴 };
      }
    } catch (e) {
      push('音频直链能取到（第 0 段）', false, { 错误: (e && e.name) + ': ' + ((e && e.message) || e) });
      return { ok: false, rows: rows, url: segUrl,
               why: '音频取不回来（' + ((e && e.name) || '错误') + '）：' + ((e && e.message) || e) };
    }

    /* ④ new Audio() 真加载一次：error.code / networkState / readyState / duration 全打出来 */
    const au = new Audio();
    au.preload = 'auto';
    au.src = segUrl;
    const loaded = await new Promise((resolve) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      au.addEventListener('loadedmetadata', () => fin('meta'));
      au.addEventListener('canplay', () => fin('canplay'));
      au.addEventListener('error', () => fin('error'));
      setTimeout(() => fin('timeout'), 8000);
      try { au.load(); } catch (e) { fin('throw:' + e); }
    });
    const media = {
      事件: loaded, errorCode: au.error ? au.error.code : null,
      errorMessage: au.error ? (au.error.message || '') : '',
      networkState: au.networkState, readyState: au.readyState,
      duration: isFinite(au.duration) ? Math.round(au.duration * 100) / 100 : au.duration,
      地址尾巴: segUrl.slice(-60),
    };
    const mediaOk = (loaded === 'meta' || loaded === 'canplay');
    push('能当音频加载（第 0 段）', mediaOk, media);
    if (!mediaOk) {
      const code = media.errorCode === null ? '（没有 error）' : ('code=' + media.errorCode);
      return { ok: false, rows: rows, url: segUrl,
               why: '这一段加载不了：' + loaded + '，' + code + ' ' + media.errorMessage
                    + '（readyState=' + media.readyState + '，networkState=' + media.networkState + '）' };
    }

    /* ⑤ play()：成功还是被拒（被拒也要原样说出 e.name + e.message） */
    let playRes;
    try {
      await au.play();
      playRes = { ok: true, name: '', message: '' };
    } catch (e) {
      playRes = { ok: false, name: (e && e.name) || '', message: (e && e.message) || String(e) };
    }
    push('真的播一下（play）', playRes.ok, playRes);
    try { au.pause(); au.removeAttribute('src'); au.load(); } catch (e) {}
    if (!playRes.ok) {
      return { ok: false, rows: rows, url: segUrl,
               why: '播放被拒：' + playRes.name + ' ' + playRes.message +
                    (playRes.name === 'NotAllowedError' ? '（要用户先点一下页面才允许出声）' : '') };
    }
    return { ok: true, rows: rows, url: segUrl, why: '从地址到出声这一整条路都通了' };
  }

  function ttsSelfHtml(rep) {
    const line = (r) => '<div class="tsd-row ' + (r.ok ? 'ok' : 'bad') + '">' +
      '<b>' + (r.ok ? '✓' : '✗') + '</b><span>' + esc(r.name) + '</span>' +
      '<code>' + esc(JSON.stringify(r.detail)) + '</code></div>';
    return (rep.rows || []).map(line).join('') +
      '<div class="tsd-why ' + (rep.ok ? 'ok' : 'bad') + '">' +
      (rep.ok ? '结论：' : '卡在哪儿：') + esc(rep.why || '') + '</div>' +
      (rep.url ? '<div class="tsd-url">音频地址：' + esc(rep.url) + '</div>' : '');
  }

  async function ttsSelfCheckSheet(opts) {
    if (App.sheetOpen && App.sheetOpen()) App.closeSheet();
    App.sheet('<div class="tsd">' +
      '<div class="tsd-head"><h3>听书自检</h3><button class="ico" data-close aria-label="关闭">×</button></div>' +
      '<div class="tsd-body" id="tsd-body"><div class="tsd-run">正在逐项检查…</div></div></div>');
    const body = document.getElementById('tsd-body');
    let rep;
    /* 走**对外的那个口子**（Reader.selfCheckReport）—— 界面上点的和判据调的是同一个函数，
       判据要模拟"静默失败"时覆盖它一处就够，不会出现"界面这条路测的是另一套"。 */
    const run = (typeof Reader !== 'undefined' && Reader.selfCheckReport) ? Reader.selfCheckReport : ttsSelfCheck;
    try { rep = await run(opts); }
    catch (e) { rep = { ok: false, rows: [], why: '自检自己出错了：' + ((e && e.message) || e) }; }
    if (body) body.innerHTML = ttsSelfHtml(rep);
    return rep;
  }

  function ttsStop(loud) {
    R.ttsWant = false; R.ttsOn = false; R.ttsBusy = false;
    R.ttsGen = (R.ttsGen || 0) + 1;                          // 作废还在路上的生成
    if (R.audio) { try { R.audio.pause(); R.audio.removeAttribute('src'); R.audio.load(); } catch (e) {} }
    ttsPre.length = 0;
    ttsPaint();
    if (loud) App.toast('已停止听书');
  }

  /* 打开章节/换音色后，把按钮重新画成当前状态（以前图标和文字从来不跟着变，
     用户根本看不出到底开没开 —— 就是「喇叭 UI 变到别的地方」那件事） */
  

  /* ══════════════════════ 导出 ══════════════════════ */
  const Reader = {
    pending: null,
    state: R,
    isOpen() { return document.body.dataset.tab === 'reader'; },
    quick: (t) => openQuick(t || 'type'),
    /* ⚠ 这两个必须**把 fromBack 透传下去**：App.show() 从阅读器换到别的屏时会调
       `Reader.quickClose(true)`（意思是"我要走了，别去做收尾动作"），
       可这里写成 `() => closeQuick()` 就把 true 吞了 → 当成"用户自己关的" →
       走 closeOverlay() → history.back() → 弹回阅读器那一格 → **App.show 白切一场**,
       屏上还是阅读器（截图判据抓到的：App.show('settings') 之后
       body.dataset.tab 又变回 reader，拍出来的"大设置"就是一张阅读器）。
       参数是接口的一部分，别吞。 */
    quickClose: (fromBack) => closeQuick(fromBack),
    quickOn: () => quickOn,
    /* 目录：独立的一整块（不是设置面板里的页签） */
    toc: () => tocOpen(),
    tocClose: (fromBack) => tocClose(fromBack),
    tocOn: () => tocOn,
    tocToggle: () => tocToggle(),

    /* 只负责把书和第一章拿到手，不碰屏幕。
       缓存按「书」隔离：章节路径各书长得一模一样（manuscript/001-volume/001-xxx.md），
       缓存只按 path 存的话，先看 A 书再看 B 书会读到 A 书的正文。 */
    _cacheFor(slug) {
      if (R.cacheSlug !== slug) { R.cache = {}; R.cacheSlug = slug; }
    },

    async preload(slug, cmd) {
      cmd = cmd || {};
      Reader._cacheFor(slug);
      if (!R.book || R.book.slug !== slug) {
        try {
          R.book = await API.book(slug);
          window.Offline && Offline.putBook(slug, R.book);
        } catch (e) {
          const c = window.Offline && Offline.getBook(slug);
          if (!c) throw e;
          R.book = c;
          App.toast('离线：目录是缓存里的');
        }
      }
      const chs = R.book.chapters || [];
      let path = cmd.path;
      if (!path || !chs.some((c) => c.path === path)) path = chs.length ? chs[0].path : null;
      if (!path) throw new Error('这本书还没有章节');
      if (R.cache[path] == null) {
        try {
          const d = await API.chapter(slug, path);
          R.cache[path] = d.content || '';
          window.Offline && Offline.putChapter(slug, path, R.cache[path]);
        } catch (e) {
          const c = window.Offline && Offline.getChapter(slug, path);
          if (c == null) throw e;
          R.cache[path] = c;
          App.toast('离线：这一章是缓存过的');
        }
      }
      return path;
    },

    onShow(opts) {
      wireQuick();
      wireTocSheet();
      ensureDom();
      const cmd = Reader.pending; Reader.pending = null;
      if (cmd) { Reader._cacheFor(cmd.slug || R.slug); openReader(cmd); return; }
      if (!R.slug || !R.text) {
        API.shelf().then((d) => {
          const p = (d.projects || [])[0];
          if (p) { Reader.pending = { slug: p.slug }; openReader({ slug: p.slug }); }
          else App.show('shelf');
        }).catch(() => App.show('shelf'));
        return;
      }
      applyThemeClass();
      R.idx = pageOf(R.pct);
      layout();
      R.idx = pageOf(R.pct);
      apply(0);
    },

    /* 字号/行距/边距/主题变化后重新分页（app.js 会调用） */
    relayout() {
      if (!R.ready || !R.slug || !R.text) return;
      if (!R.els.stage || !R.els.stage.clientWidth) return;
      const keep = R.pct;
      layout();
      R.idx = pageOf(keep);
      apply(0);
    },

    /* 全站这些入口（目录 / 书签 / 笔记 / 设置）现在一律开**底部那块矮面板**的对应页：
       要的「不要点开就盖住整屏、不要第二个入口」。 */
    toc() { tocOpen(); },
    bookmarks() { openQuick('mark'); },
    notes() { openQuick('note'); },
    addNote: noteSheet,
    settings() { openQuick('theme'); },
    quickToggle,

    /* 底栏那一排「一定会用到」的（用户要的：不用点开设置就能用） */
    nextChapter() {
      if (R.pathNext) { toChapter(R.pathNext, 0); return; }
      App.toast(R.book ? '已经是最后一章了' : '先打开一章');
    },
    prevChapter() {
      if (R.pathPrev) { toChapter(R.pathPrev, 100); return; }
      App.toast(R.book ? '已经是第一章了' : '先打开一章');
    },
    /* 底栏的字号快捷：不用进设置直接加大/减小，四角都会重排 */
    fontStep(d) {
      const v = clamp(Math.round((+Prefs.get('fontSize') || 19) + d), 14, 30);
      if (v === +Prefs.get('fontSize')) { App.toast(d > 0 ? '已经最大了' : '已经最小了'); return; }
      Prefs.set('fontSize', v);
      App.toast('字号 ' + v);
    },

    /* 书签：当前页 */
    addMark() {
      if (!R.path) return;
      const i = clamp(Math.round((R.pct / 100) * Math.max(0, R.text.length - 1)), 0, Math.max(0, R.text.length - 1));
      Marks.add(R.slug, R.path, R.pct, R.text.slice(i, i + 46).replace(/\s+/g, ''));
      App.toast('已加书签');
    },

    /* 编辑本章 */
    editChapter: editChapter,
    /* 听书 */
    toggleTts: ttsToggle,
    /* 听书自检：界面上点（返回 report），也给判据直接调 */
    selfCheck: ttsSelfCheckSheet,
    /* 听书现在的真实状态（判据要核"**真的在走**"：paused=false 且 currentTime 涨了）——
       光看接口回 200 不够：监督人实测过"音频拉回来了、paused 还是 true"的情况。 */
    ttsState: () => (R.audio ? {
      paused: R.audio.paused, currentTime: R.audio.currentTime,
      readyState: R.audio.readyState, networkState: R.audio.networkState,
      errorCode: R.audio.error ? R.audio.error.code : null,
      src: String(R.audio.currentSrc || R.audio.src || '').slice(-70),
      段: R.ttsSeg, 共几段: R.ttsCount, 在听: !!R.ttsOn,
      被打断过: !!R.ttsResume, 解锁于: R.ttsUnlockedAt || 0,
    } : null),
    /* 判据用：直接跑"没有点击解锁那一趟"的内部路径（复现老代码的行为） */
    startRaw: ttsStart,
    selfCheckReport: ttsSelfCheck,
    stopTts: () => ttsStop(true),

    /* 供其它模块跳章 */
    goChapter(path, pct) { return toChapter(path, pct || 0); },
    next() { nextPage(); },
    prev() { prevPage(); },
  };

  /* ══════════════════════ 全局事件 ══════════════════════ */
  window.addEventListener('resize', debounce(() => {
    if (!R.ready || !R.slug) return;
    const st = R.els.stage;
    if (!st || !st.clientWidth) return;
    const w = st.clientWidth, h = st.clientHeight;
    if (w === R.lastW && Math.abs(h - R.lastH) < 56) return;
    const keep = R.pct;
    layout();
    R.idx = pageOf(keep);
    apply(0);
  }, 220));

  window.addEventListener('orientationchange', () => setTimeout(() => Reader.relayout(), 280));

  function bootReader() {
    const p = $('#reader-page');
    if (!p) return;
    p.addEventListener('scroll', debounce(() => {
      if (R.mode !== 'scroll' || !R.slug) return;
      syncProgress();
      const max = Math.max(0, p.scrollHeight - p.clientHeight);
      if (max > 0 && p.scrollTop >= max - 4 && R.pathNext) nextChapterByScroll();
    }, 120), { passive: true });
    // 沉浸态下点顶栏/底栏空白也能唤出菜单
    ['#reader-head', '#reader-foot'].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        if (!R.chromeVisible) showChrome();
      });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootReader);
  else bootReader();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && R.slug && R.path) Progress.set(R.slug, R.path, R.pct);
  });
  window.addEventListener('pagehide', () => { if (R.slug && R.path) Progress.set(R.slug, R.path, R.pct); });

  Prefs.onChange((k) => {
    if (k === 'voice' || k === 'rate' || k === 'ttsEngine') {
      if (R.ttsOn) { ttsStop(false); setTimeout(() => { if (R.slug && R.path) ttsStart(); }, 80); }
      return;
    }
    if (k === 'ttsFollow') return;
    if (k === 'keepAwake' || k === 'profileKey' || k === 'chatSession' || k === 'tab') return;
    if (k === 'fontFamily') applyThemeClass();
    Reader.relayout();
  });

  window.Shelf = Shelf;
  window.Reader = Reader;
})();
