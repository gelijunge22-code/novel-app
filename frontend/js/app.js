/* ============================================================
   app.js — 外壳：图标、路由、登录、通用抽屉/弹窗/提示、设置页
   ============================================================ */
(function () {

  /* ── 图标（内联 SVG，线性风格，不用 emoji） ── */
  const ICONS = {
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
    layers: '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
    chat: '<path d="M21 11.5a8.5 8.5 0 0 1-9.1 8.5L4 21l1.4-4.4A8.5 8.5 0 1 1 21 11.5z"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
    back: '<path d="M15 18l-6-6 6-6"/>',
    more: '<circle class="fill" cx="5" cy="12" r="1.6"/><circle class="fill" cx="12" cy="12" r="1.6"/><circle class="fill" cx="19" cy="12" r="1.6"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle class="fill" cx="3.6" cy="6" r="1.2"/><circle class="fill" cx="3.6" cy="12" r="1.2"/><circle class="fill" cx="3.6" cy="18" r="1.2"/>',
    sound: '<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    send: '<path d="M20 12l-16-8 6 8-6 8 16-8z"/>',
    settings: '<circle cx="12" cy="12" r="3.2"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.3a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.7 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    text: '<path d="M4 7V5h16v2"/><path d="M12 5v14"/><path d="M9 19h6"/>',
    bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    play: '<path d="M7 4l12 8-12 8V4z"/>',
    pause: '<path d="M8 5v14M16 5v14"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M17.7 6.3l-2.8 2.8M9.1 14.9l-2.8 2.8"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 15h10l1-15"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
    chevron: '<path d="M9 6l6 6-6 6"/>',
    sliders: '<path d="M4 21v-6M4 11V3M12 21v-9M12 8V3M20 21v-4M20 13V3"/><path d="M1.5 15h5M9.5 11h5M17.5 17h5"/>',
    wand: '<path d="M15 4V2M15 10V8M12.5 6.5h-2M19.5 6.5h-2M4 20l9-9M13 6l1 1"/>',
    refreshCw: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.8"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.8"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.8"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.8"/>',
    folder: '<path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2.4"/><circle cx="8.6" cy="9.4" r="1.6"/><path d="M4 17l4.6-4.6a1.6 1.6 0 0 1 2.3 0L20 21"/>',
    database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    cpu: '<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3"/>',
    briefcase: '<rect x="3" y="7.5" width="18" height="13" rx="2.2"/><path d="M9 7.5V5.5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/><path d="M3 12.5h18"/>',
    users: '<circle cx="9" cy="8" r="3.4"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 5.2a3.4 3.4 0 0 1 0 5.6M18 20a6.6 6.6 0 0 0-1.8-4.5"/>',
    terminal: '<rect x="2.5" y="4" width="19" height="16" rx="2.4"/><path d="M7 9.5l3 2.5-3 2.5M13 15h4"/>',
    history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1"/><path d="M3.2 4.5V9h4.5"/><path d="M12 7.5V12l3.2 2"/>',
    shield: '<path d="M12 3l7.5 3v6c0 4.6-3.1 8.2-7.5 9.6C7.6 20.2 4.5 16.6 4.5 12V6z"/>',
    key: '<circle cx="8" cy="14" r="4"/><path d="M11 11l8-8M17 5l2 2M14.5 7.5l2 2"/>',
    upload: '<path d="M12 20V7"/><path d="M7 12l5-5 5 5"/><path d="M4 4h16"/>',
    download: '<path d="M12 4v13"/><path d="M7 12l5 5 5-5"/><path d="M4 20h16"/>',
    copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.2"/><path d="M15.5 8.5v-3a2 2 0 0 0-2-2h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
    link: '<path d="M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 1 0-5.7-5.7L11.5 6"/><path d="M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 1 0 5.7 5.7l1.5-1.5"/>',
    dot: '<circle class="fill" cx="12" cy="12" r="3.2"/>',
    warm: '<path d="M12 3s5.5 5.4 5.5 9.5A5.5 5.5 0 0 1 12 18a5.5 5.5 0 0 1-5.5-5.5C6.5 8.4 12 3 12 3z"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    note: '<path d="M5 3.5h11l3 3V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1z"/><path d="M8 9h7M8 13h7M8 17h4"/>',
    tag: '<path d="M20.5 13.5 13 21 3 11V3h8l9.5 9.5a1.4 1.4 0 0 1 0 1z"/><circle cx="7.5" cy="7.5" r="1.4"/>',
    share: '<path d="M12 15.5V4"/><path d="M8 8l4-4 4 4"/><path d="M5 14v5.5a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5V14"/>',
  };
  const iconHtml = (n) => '<svg viewBox="0 0 24 24" aria-hidden="true">' + (ICONS[n] || '') + '</svg>';
  window.iconHtml = iconHtml;
  /** 只换掉按钮里的 <svg>，保留文字（底部导航「书架/预设/设定/对话」就是靠这个留住标签的） */
  const setIcon = (el, n) => {
    if (!el) return;
    const old = el.querySelector('svg');
    if (old) old.outerHTML = iconHtml(n);
    else el.insertAdjacentHTML('afterbegin', iconHtml(n));
  };
  window.setIcon = setIcon;

  /* ── 状态 ── */
  const state = {
    slug: null, book: null, chapter: null,
    readerReturn: 'shelf',
  };
  window.App = { state };

  /* ── 提示 / 抽屉 / 弹窗 ── */
  let toastTimer = null;
  App.toast = (msg, ms) => {
    const el = document.getElementById('toast');
    el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.add('hidden'), ms || 1900);
  };

  /* ── 后台保活：有长任务（AI 正在写、批量在跑）时告诉原生「先别把我收掉」 ──
     WebView 切到后台会被系统回收，表现就是「切出去一会儿回来，任务没了」。
     Android 端收到这个信号会起一个前台服务把进程保住，任务结束再撤掉。 */
  let keepAliveN = 0;
  App.keepAlive = (on) => {
    keepAliveN = Math.max(0, keepAliveN + (on ? 1 : -1));
    if (window.Android && Android.keepAlive) {
      try { Android.keepAlive(keepAliveN > 0); } catch (e) {}
    }
  };
  App.keepAlive.busy = () => keepAliveN > 0;

  /* 一有网就把离线攒下的改动推回去；有冲突会留通知，去「工具 → 同步」挑 */
  window.addEventListener('online', () => {
    if (!(window.Offline && Offline.pendingCount() > 0)) return;
    if (!(window.Tools && Tools.pushPending)) return;
    Tools.pushPending().then((r) => {
      if (r.ok) App.toast('离线时改的 ' + r.ok + ' 章已同步回去');
      if (r.conflicts) App.toast(r.conflicts + ' 章两边都改过，去「同步」挑一版');
    }).catch(() => {});
  });

  /* 有没有一层弹层正开着？（阅读器要开底部面板时先问一下，别两层面板叠在一起） */
  App.sheetOpen = () => {
    const s = document.getElementById('sheet');
    return !!s && !s.classList.contains('hidden');
  };

  App.sheet = (content, opts = {}) => {
    const s = document.getElementById('sheet'), p = document.getElementById('sheet-panel');
    if (!s || !p) return;
    /* 已经开着 → **就地换内容**，不重播升起动画、也**绝不"先关再开"**。
       用户实测过的坑（监督人探针 menu_probe2）：「书本菜单 → 全书搜索」点完面板高度 = 0（等于隐形），
       看着就是"点了一下闪没了"。根因是调用方写的 App.closeSheet(); App.sheet(...) 连写：
       旧面板的收尾（history.back() 引发的 popstate）在下一拍才到，把刚开的新面板一起关掉了。
       调用方现在只要直接 App.sheet(...)，换面板这件事由这里一处负责。 */
    const replacing = !s.classList.contains('hidden') && s.classList.contains('sheet-open');
    p.innerHTML = '';
    if (typeof content === 'string') p.innerHTML = content; else p.appendChild(content);
    if (!s.dataset.wired) {
      s.dataset.wired = '1';
      const mask = document.createElement('div'); mask.className = 'sheet-mask';
      mask.addEventListener('click', () => App.closeSheet()); s.insertBefore(mask, p);
      p.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) App.closeSheet(); });
      wireSheetDrag(p);
    }
    s.classList.remove('hidden');
    p.style.transform = '';
    p.style.transition = '';
    if (replacing) { opts.onMount && opts.onMount(p); return; }
    void p.offsetHeight;
    s.classList.add('sheet-open');            // 触发 CSS 过渡（从底部升起）
    opts.onMount && opts.onMount(p);
  };

  /* cb：等面板真的收下去了再干下一件事（要接着开弹窗/切屏的调用方用这个，
     别再自己定时器等动画 —— 那种写法就是上面那个"新面板被带走"的坑）。 */
  App.closeSheet = (cb) => {
    const s = document.getElementById('sheet'), p = document.getElementById('sheet-panel');
    if (!s || s.classList.contains('hidden')) { cb && cb(); return; }
    s.classList.remove('sheet-open');
    p.style.transition = '';                  // 回到 CSS 过渡，从当前位置顺势滑下去
    p.style.transform = 'translateY(101%)';
    setTimeout(() => {
      if (!s.classList.contains('sheet-open')) {   // 期间又被打开了，别误关
        s.classList.add('hidden');
        p.style.transform = '';
      }
      cb && cb();
    }, 210);
  };

  /* 抽屉可以按住往下拽关掉（原生 App 的标准手势） */
  function wireSheetDrag(p) {
    let y0 = 0, dy = 0, on = false;
    const canStart = (e) => {
      if (e.target.closest('.sheet-grip, .sheet-head, .ptbl-head')) return true;
      const sc = e.target.closest('.rd-tabbody, .pk-list, .pk-preview, .preset-body, .lore-body');
      return !sc || sc.scrollTop <= 0;
    };
    p.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1 || !canStart(e)) { on = false; return; }
      y0 = e.touches[0].clientY; dy = 0; on = true; p.style.transition = 'none';
    }, { passive: true });
    p.addEventListener('touchmove', (e) => {
      if (!on) return;
      dy = e.touches[0].clientY - y0;
      if (dy < 0) dy *= 0.28;                 // 往上拉给阻尼
      p.style.transform = 'translateY(' + dy + 'px)';
    }, { passive: true });
    const end = () => {
      if (!on) return;
      on = false;
      const h = p.offsetHeight || 1;
      if (dy > 96 || dy > h * 0.28) { p.style.transition = ''; App.closeSheet(); return; }
      p.style.transition = ''; p.style.transform = ''; dy = 0;
    };
    p.addEventListener('touchend', end, { passive: true });
    p.addEventListener('touchcancel', end, { passive: true });
  }

  App.modal = (content, opts = {}) => {
    const m = document.getElementById('modal'), p = document.getElementById('modal-panel');
    p.innerHTML = '';
    if (typeof content === 'string') p.innerHTML = content; else p.appendChild(content);
    m.classList.remove('hidden');
    if (!m.dataset.wired) {
      m.dataset.wired = '1';
      m.addEventListener('click', (e) => { if (e.target === m) App.closeModal(); });
      p.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) App.closeModal(); });
    }
    void p.offsetHeight;
    m.classList.add('modal-open');
    opts.onMount && opts.onMount(p);
  };

  App.closeModal = () => {
    const m = document.getElementById('modal');
    if (!m || m.classList.contains('hidden')) return;
    m.classList.remove('modal-open');
    setTimeout(() => { if (!m.classList.contains('modal-open')) m.classList.add('hidden'); }, 180);
  };
  App.confirm = (text, onYes, yesLabel) => {
    App.modal(`<div style="font-size:var(--t-lg);line-height:1.7">${text}</div>
      <div style="display:flex;gap:var(--sp-3);margin-top:var(--sp-5)">
        <button class="btn btn-block" data-close>取消</button>
        <button class="btn btn-primary btn-block" id="cf-yes">${yesLabel || '好'}</button>
      </div>`, {
      onMount(p) { p.querySelector('#cf-yes').addEventListener('click', () => { App.closeModal(); onYes(); }); },
    });
  };

  /* ── 全站唯一的「弹个输入框」（改名字 / 加一条常用指令 / 改一句话都用它）──
     以前这份实现藏在 tools.js 里（工具面板自己一份），聊天那边要用就没得用。
     现在放这儿当唯一的实现：**默认走弹窗**；给了 opts.host 就贴在那个面板里（工具面板在手边上，
     弹窗会把手感打断）。返回 Promise：确认是字符串，取消是 null。 */
  /* ── 表单弹层：一张 `.t-dialog` 里放 N 个字段 ────────────────────────────
     `App.form({title, fields:[{key,label,multiline,rows,value,placeholder}], ok})`
     → 确定回 `{key: 值}`，取消回 `null`。
     为什么要有它：**只留一处实现**。以前"要填好几样东西"的弹层各自拼一套 markup，
     于是圆角/间距/按钮排布各写各的 —— 用户点名的"UI 不统一"就是这么攒出来的。
     `App.ask`（单字段）现在是它的一个薄包装，两者行为完全一样（老调用方一个都不用改）。 */
  App.form = (opts) => new Promise((res) => {
    /* 转义：app.js 里以前没有这个小工具（老的单字段弹层压根没插过变量），
       而这个表单要往标签里插文字 —— 少了它，带 < > 的标签会把弹层插坏。 */
    const esc = (v) => String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const fields = (opts && opts.fields) || [];
    const many = fields.length > 1;
    const wrap = document.createElement('div');
    wrap.className = 't-dialog' + (many ? ' t-form' : '');
    wrap.innerHTML = '<h3>' + ((opts && opts.title) || '') + '</h3>' + fields.map((f) => {
      const tag = f.multiline ? 'textarea' : 'input';
      const body = '<' + tag + ' class="' + (f.multiline ? 't-area' : 't-input') + '"' +
        (f.multiline ? ' rows="' + (f.rows || 4) + '"' : ' type="text"') + '></' + tag + '>';
      return many
        ? '<label class="t-field"><span class="t-lab">' + esc(f.label || '') + '</span>' + body + '</label>'
        : body;
    }).join('') + '<div class="t-acts"><button class="t-btn" data-no>取消</button>' +
      '<button class="t-btn pri" data-yes>' + ((opts && opts.ok) || '确定') + '</button></div>';
    const boxes = Array.prototype.slice.call(wrap.querySelectorAll('.t-input,.t-area'));
    fields.forEach((f, k) => {
      const b = boxes[k];
      if (!b) return;
      b.value = f.value == null ? '' : f.value;
      if (f.placeholder) b.placeholder = f.placeholder;
    });
    let settled = false;
    const read = () => {
      const out = {};
      fields.forEach((f, k) => { out[f.key || ('f' + k)] = boxes[k] ? boxes[k].value : ''; });
      return out;
    };
    const done = (v) => {
      if (settled) return;
      settled = true;
      wrap.remove();
      if (!(opts && opts.host)) App.closeModal();
      res(v);
    };
    wrap.querySelector('[data-no]').onclick = () => done(null);
    wrap.querySelector('[data-yes]').onclick = () => done(read());
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') done(null);
      /* 回车=确定，但**只在单行输入框里**（多行框里回车是换行，抢了就没法分段写） */
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') {
        e.preventDefault(); done(read());
      }
    });
    if (opts && opts.host) opts.host.appendChild(wrap);
    else App.modal(wrap);
    setTimeout(() => { try { boxes[0].focus(); } catch (e) {} }, 60);
  });

  /* 单字段弹层（老接口，行为不变）：内部就是 App.form 的一个字段 */
  App.ask = (title, value, opts = {}) => App.form({
    title: title, ok: opts.ok, host: opts.host,
    fields: [{ key: 'v', value: value, multiline: !!opts.multiline, rows: 6,
               placeholder: opts.placeholder }],
  }).then((r) => (r ? r.v : null));

  /* ── 触感反馈：优先走原生（Android.vibrate），没有就退回 Web ── */
  let lastHaptic = 0;
  App.haptic = (ms) => {
    const now = Date.now();
    if (now - lastHaptic < 40) return;   // 防连击时震成一片
    lastHaptic = now;
    const d = ms || 8;
    try {
      if (window.Android && Android.vibrate) { Android.vibrate(d); return; }
    } catch (e) {}
    if (navigator.vibrate) { try { navigator.vibrate(d); } catch (e) {} }
  };
  // 只有「明确是按钮」的东西才震，列表滑动不震（否则滑一下书架震一片，很吵）
  document.addEventListener('pointerdown', (e) => {
    const t = e.target.closest && e.target.closest('button, .tab, .icon-btn, .seg button, .stepper button');
    if (t && !t.disabled) App.haptic();
  }, { passive: true });

  /* ── 按压波纹：只出现在手指点住的那个元素里 ──
     用户的规矩：点一个球，就只该这个球有反应，球外面不能跟着动。
     所以波纹是「以指尖为中心、且被这个元素自己的边框裁掉」的一小圈，
     半径也做了封顶 —— 大卡片上也只在指尖起一圈，不会糊成一大块。 */
  const RIPPLE_SEL = 'button,.btn,.tab,.icon-btn,.fab,.tool-card,.book-card,.t-row,' +
    '.rd-act,.rd-fb,.rd-nav,.rd-qbtn,.rd-toc-item,.rd-toc-add,.chip,.pill,.pk,.ppick,.plink,' +
    '.pseg button,.seg button,.stepper button,.quick button,.pradio button,.preset-seg button';
  document.addEventListener('pointerdown', (e) => {
    if (document.documentElement.classList.contains('motion-off')) return;
    const el = e.target && e.target.closest ? e.target.closest(RIPPLE_SEL) : null;
    if (!el || el.disabled) return;
    const r = el.getBoundingClientRect();
    if (r.width < 10 || r.height < 10 || r.width > 1200) return;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return;

    const rad = Math.max(26, Math.min(Math.hypot(r.width, r.height) * 0.42, 64));
    const x = e.clientX - r.left, y = e.clientY - r.top;

    /* 元素本身没定位 / 没裁剪就临时补上，动画一结束就还原 ——
       不动 CSS 类，免得跟别处的圆角、溢出规则打架 */
    const fixPos = cs.position === 'static';
    const fixOv = cs.overflow === 'visible';
    if (fixPos) el.style.position = 'relative';
    if (fixOv) el.style.overflow = 'hidden';

    const s = document.createElement('span');
    s.className = 'ripple';
    s.style.cssText = 'width:' + (rad * 2) + 'px;height:' + (rad * 2) +
                      'px;left:' + x + 'px;top:' + y + 'px';
    el.appendChild(s);

    let cleaned = false;
    const done = () => {
      if (cleaned) return;
      cleaned = true;
      if (s.parentNode) s.parentNode.removeChild(s);
      if (fixPos) el.style.position = '';
      if (fixOv) el.style.overflow = '';
    };
    s.addEventListener('animationend', done);
    setTimeout(done, 900);           // 兜底：动画没跑（后台/隐藏标签页）也要收干净
  }, { passive: true });

  /* ── 屏幕切换 ── */
  const SCREENS = ['shelf', 'reader', 'chat', 'lore', 'preset', 'settings', 'tools', 'tool'];
  /* 屏幕名 → 底部导航哪一项该亮（没写的就是"保持上一个"，比如设置页是从书架进去的） */
  const TAB_OF = { shelf: 'shelf', chat: 'chat', lore: 'lore', preset: 'preset',
                   tools: 'tools', tool: 'tools' };
  let lastTab = 'shelf';
  // 层级：书架是根，对话/设定/设置是一层，阅读器是在书架或对话之上再开一层
  const DEPTH = { shelf: 0, preset: 1, lore: 1, chat: 1, settings: 1, tools: 1, tool: 2, reader: 2 };
  const TABORDER = ['shelf', 'preset', 'lore', 'chat', 'tools'];

  /* 点书卡那一刻只做一件事：把卡片的位置记下来。
     真正的「展开」由下面 switchScreen 里那一次变换完成。
     之前这里是「飞卡幽灵 + 整屏横移推入」两层动画各演各的，再加上阅读页要等联网
     回来才蹦字，三层叠在一起 —— 就是用户说的「闪屏 / 这儿冲突那儿冲突」。 */
  App.bookRect = null;
  App.riseCard = (el) => {
    if (!el) return;
    const a = el.getBoundingClientRect();
    App.bookRect = (a.width && a.height)
      ? { l: a.left, t: a.top, w: a.width, h: a.height } : null;
  };
  const E_OUT = 'cubic-bezier(.22,.61,.36,1)';
  const E_OUT_Q = 'cubic-bezier(.16,1,.3,1)';
  const E_IN = 'cubic-bezier(.4,0,1,1)';

  /* 当前该显示哪一屏 / 把它露出来。转场收尾与切屏兜底都用这一对，
     免得"藏错了元素"或"谁都没露出来"（整屏空白就是这么来的）。 */
  const curName = () => document.body.dataset.tab || '';
  App.revealCurrent = () => {
    const n = curName(); if (!n) return;
    SCREENS.forEach((s) => {
      const el = document.getElementById('screen-' + s);
      if (!el) return;
      if (s === n) {
        if (el.classList.contains('hidden')) el.classList.remove('hidden');
      } else if (el.classList.contains('animating') || el.classList.contains('animating-out')) {
        el.classList.add('hidden');                 // 转场中途的旧屏：该收就收，别留在上面
        el.classList.remove('animating', 'animating-out');
        el.style.willChange = '';
      }
    });
  };

  /* 转场：层级变化走 push/pop（整屏推入 + 旧页后退变暗），同级走淡入缩放 */
  App.switchScreen = (inEl, outEl, prev, name, opts) => {
    if (!inEl) return;
    inEl.classList.remove('hidden');
    let aIn, aOut;
    /* 关键：上一次的转场动画必须 cancel 掉。
       原来用的是 fill:'both'/'forwards' 但从不 cancel —— 填充值会一直挂在元素上
       （书架被钉在 opacity:0、阅读页被钉在缩放态），下次切回来新旧动画打架，
       那一下「闪」就是这么来的。 */
    const killPrev = () => {
      try { inEl.getAnimations({ subtree: false }).forEach((a) => a.cancel()); } catch (e) {}
      try { outEl.getAnimations({ subtree: false }).forEach((a) => a.cancel()); } catch (e) {}
    };
    const finish = () => {
      try { if (aIn) aIn.cancel(); } catch (e) {}
      try { if (aOut) aOut.cancel(); } catch (e) {}
      inEl.classList.remove('animating');
      inEl.style.boxShadow = '';
      inEl.style.transformOrigin = '';
      inEl.style.willChange = '';
      if (outEl) {
        /* **藏元素前先看"它还是不是当前屏"** —— 这条是拿真机证据换来的：
           转场是异步的（等 aIn/aOut 的 finished），用户在动画没演完时又切了一次屏的话，
           **旧的那次收尾会晚到**，它照着**自己闭包里的旧 outEl** 去 hidden ——
           而那个元素说不定已经是**现在正该显示的那一屏**了 → 整屏空白。
           第 30 轮无头实测就是这个：`App.show('shelf')` 之后 `body.dataset.tab` 明明是 shelf，
           `#screen-shelf` 却带着 `hidden`，截出来的图墨迹 0.000（只剩一层底色）。
           收拾动画随便收，**藏元素必须看"当前屏是谁"**。 */
        if (outEl.id !== 'screen-' + curName()) outEl.classList.add('hidden');
        outEl.classList.remove('animating-out');
        outEl.style.willChange = '';
      }
      App.revealCurrent();
    };
    if (opts.animate === false || !outEl || !prev || prev === name) {
      finish();
      return;
    }
    const dd = (DEPTH[name] || 0) - (DEPTH[prev] || 0);
    // 同级 = 两边都是底部 Tab（书架/预设/设定/对话）之间的切换
    const isTab = TABORDER.indexOf(name) >= 0 && TABORDER.indexOf(prev) >= 0;
    // 开书 / 合书 = 从卡片「长出来」再缩回卡片去。
    // 只有两层：整页缩放淡入 + 书架后退淡出。没有横移、没有飞卡幽灵、没有阴影，
    // 全都是 GPU 合成的 transform/opacity —— 手机上不会掉帧，也不会闪。
    const isOpenBook = (name === 'reader' && prev === 'shelf');
    const isCloseBook = (prev === 'reader' && name === 'shelf');
    inEl.classList.add('animating');
    outEl.classList.add('animating-out');
    killPrev();                       // 先把残留的旧动画清掉，再开新的
    try {
      if (isOpenBook || isCloseBook) {
        // 从卡片的位置算一个「源」变换：起点/终点都在卡片那儿，
        // 缩放地板压到 .62，不然会像从针眼里钻出来。
        const r = App.bookRect;
        let tf = 'scale(.88)';
        if (r && r.w > 0) {
          const vw = innerWidth || 390, vh = innerHeight || 844;
          const s = Math.max(r.w / vw, (r.h / vh) * 0.72, 0.62);
          const cx = (r.l + r.w / 2) - vw / 2;
          const cy = (r.t + r.h / 2) - vh / 2;
          tf = 'translate(' + cx.toFixed(1) + 'px,' + cy.toFixed(1) + 'px) scale(' + s.toFixed(3) + ')';
        }
        inEl.style.transformOrigin = '50% 50%';
        inEl.style.willChange = 'transform, opacity';
        outEl.style.willChange = 'transform, opacity';
        if (isOpenBook) {
          aIn = inEl.animate(
            [{ transform: tf, opacity: 0 }, { transform: 'none', opacity: 1 }],
            { duration: 400, easing: E_OUT_Q, fill: 'both' });
          aOut = outEl.animate(
            [{ transform: 'none', opacity: 1 }, { transform: 'scale(1.035)', opacity: 0 }],
            { duration: 290, easing: E_OUT, fill: 'forwards' });
        } else {
          aIn = inEl.animate(
            [{ transform: 'scale(1.035)', opacity: 0 }, { transform: 'none', opacity: 1 }],
            { duration: 320, easing: E_OUT, fill: 'both' });
          aOut = outEl.animate(
            [{ transform: 'none', opacity: 1 }, { transform: tf, opacity: 0 }],
            { duration: 340, easing: E_OUT_Q, fill: 'forwards' });
        }
      } else if (isTab) {
        aIn = inEl.animate(
          [{ opacity: 0, transform: 'scale(.986)' }, { opacity: 1, transform: 'none' }],
          { duration: 200, easing: E_OUT, fill: 'both' });
        aOut = outEl.animate(
          [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.992)' }],
          { duration: 150, easing: E_IN, fill: 'forwards' });
      } else {
        const sign = dd >= 0 ? 1 : -1;
        inEl.style.boxShadow = '0 0 26px rgba(28,20,12,.22)';
        aIn = inEl.animate(
          [{ transform: 'translateX(' + (sign * 100) + '%)' }, { transform: 'none' }],
          { duration: 320, easing: E_OUT_Q, fill: 'both' });
        aOut = outEl.animate(
          [{ transform: 'none', opacity: 1 }, { transform: 'translateX(' + (-sign * 26) + '%)', opacity: .68 }],
          { duration: 320, easing: E_OUT_Q, fill: 'forwards' });
      }
    } catch (e) { finish(); return; }
    let left = 2;
    const tick = () => { if (--left <= 0) finish(); };
    aIn.finished.then(tick, tick);
    aOut.finished.then(tick, tick);
  };

  App.show = (name, opts = {}) => {
    if (!SCREENS.includes(name)) name = 'shelf';
    const prev = document.body.dataset.tab;
    document.body.dataset.tab = name;
    const inEl = document.getElementById('screen-' + name);
    const outEl = (prev && prev !== name) ? document.getElementById('screen-' + prev) : null;
    // 其余屏幕直接藏掉（可能有余留）
    SCREENS.forEach((s) => {
      if (s === name || s === prev) return;
      const el = document.getElementById('screen-' + s);
      if (el) el.classList.add('hidden');
    });
    App.switchScreen(inEl, outEl, prev, name, opts);
    /* 兜底对账：转场是异步的（上面 finish 要等动画 finished），万一"旧收尾晚到"把当前屏藏了，
       这里再过一遍 —— **手机上这一条挡住的就是"切屏切出一片空白"**。 */
    setTimeout(() => App.revealCurrent(), 700);
    setTimeout(() => App.revealCurrent(), 1500);   // 慢机器上收尾会更晚，再对一次账
    const tb = document.getElementById('tabbar');
    if (tb) {
      /* 高亮哪个入口：屏幕名不一定等于页签名。
         * tool（工具里的子面板，如写作台/质检/世界）→ 高亮「工具」
         * settings（从书架右上角进的）→ 保留上一次的高亮，不要变成"全都不亮"
         踩过的坑：进工具子面板时没有一项高亮，用户不知道自己在哪。 */
      if (TAB_OF[name]) lastTab = TAB_OF[name];
      tb.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === lastTab));
      tb.classList.toggle('hidden', name === 'reader');
    }
    if (opts.push !== false) {
      const h = '#/' + name + (opts.hashExtra || '');
      if (location.hash !== h) {
        try { history.pushState({ screen: name }, '', h); }
        catch (e) {
          /* **App 里这条一定会走到**：前端是从安装包里以 file:// 打开的，
             而 Chrome/WebView 对 file: 文档禁止 pushState（SecurityError：
             "cannot be created in a document with origin 'file:'"）。
             以前没兜住 → 异常从这里抛出去，下面的 mod.onShow() **根本不会执行** →
             换屏了但那一屏永远不渲染（用户说的"点开设置什么都没有"就是这个）。
             退回改 hash：不动历史栈，但界面一定换得过去。 */
          try { location.hash = h; } catch (e2) {}
        }
      }
    }
    /* 从阅读器换到别的屏：把那两层浮层收干净（标志位留着的话，返回键会白按一下 ——
       "点了没反应"这类毛病就是这么来的）。不碰历史栈，只收视觉与状态。 */
    if (prev === 'reader' && name !== 'reader' && window.Reader) {
      try { Reader.tocClose(true); Reader.quickClose(true); } catch (e) {}
    }
    const hooks = { shelf: window.Shelf, chat: window.Chat, lore: window.Lore, preset: window.Preset, settings: window.Settings, reader: window.Reader, tools: window.Tools, tool: window.Tools };
    const mod = hooks[name];
    if (mod && mod.onShow) mod.onShow(opts);
  };

  window.addEventListener('popstate', (e) => {
    const st = (e.state && e.state.screen) || (location.hash.replace('#/', '') || 'shelf');
    if (st === 'reader' && window.Reader && window.Reader.isOpen && window.Reader.isOpen()) { App.show('reader', { push: false }); return; }
    App.show(st.split('?')[0], { push: false });
  });

  /* ── 登录 ── */
  App.needLogin = () => {
    document.getElementById('login').classList.remove('hidden');
  };
  /* 「重试连接」按钮：只有在**连不上服务器**的时候才露出来。
     为什么要有：手机上用户没有 SSH、没有 logcat —— 后端在服务器上，连不上时
     这是他唯一能自救的地方。点了让 Java 重新探一遍服务器再重装界面。
     （2.0.2 那次事故的反面教材：连不上时退回了手机里那个**空**后端，
       用户看到的是"书没了、设定没了、设置也没了"。现在只会明说连不上。） */
  App.showRetry = (on, msg) => {
    const b = document.getElementById('login-retry');
    if (b) b.classList.toggle('hidden', !on);
    if (msg !== undefined) {
      const m = document.getElementById('login-msg');
      if (m) m.textContent = msg;
    }
  };
  App.retryConnect = () => {
    try {
      if (window.Android && Android.retry) { Android.retry(); App.toast('正在重连服务器…'); return; }
    } catch (e) {}
    location.reload();
  };
  /* boot 只准跑一次。
     原来 DOMContentLoaded 和下面那个 readyState 兜底是"两道门"，极端情况下会跑两遍 ——
     表现是事件监听装两遍（点一下响两下、返回退两层），很难查。 */
  let booted = false;

  async function boot() {
    if (booted) return;
    booted = true;
    try {
      await boot0();
    } catch (e) {
      /* 启动这一步就炸：**绝不能留一片空白**。把启动页撤掉，给一句人话 + 一个重试机会。 */
      try { console.error('boot 失败', e); } catch (e2) {}
      const sp = document.getElementById('splash');
      if (sp) { sp.classList.add('gone'); setTimeout(() => { try { sp.remove(); } catch (e2) {} }, 420); }
      const lg = document.getElementById('login');
      if (lg) lg.classList.remove('hidden');
      const msg = document.getElementById('login-msg');
      if (msg) msg.textContent = '启动出错：' + (e && e.message ? e.message : e);
    }
  }

  async function boot0() {
    /* 第一件事：把启动页退场排上（**不 await、不放后面**）——理由见 scheduleSplashDrop 的注释。 */
    scheduleSplashDrop();
    document.querySelectorAll('[data-icon]').forEach((el) => { setIcon(el, el.dataset.icon); });
    /* `data-act` 的动作**统一在 document 上收一次**（事件委托）。
       为什么改成委托：以前是"启动那一刻，给当时存在的每个 [data-act] 绑一次"——
       启动之后才插进 DOM 的元素（弹层里的动作、面板里后画出来的按钮）**永远绑不上**，
       用户点下去就是"点了只闪一下、一点用都没有"（用户报过这一类）。
       委托一次就都管住。⚠ 只在这里绑一次：元素自己不许再绑一遍，否则同一个动作会跑两次。 */
    document.addEventListener('click', (e) => {
      const el = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
      if (el) App.act(el.dataset.act, e);
    });
    const pass = document.getElementById('login-pass');
    /* 为什么聚焦就全选：输入法/浏览器的"自动填"会塞进上一次的旧密码，
       用户看着框里像空的、直接点「进入」，发出去的是旧密码 → 永远 401。
       （用户实测踩过：手机上一直进不去，服务器日志里全是 401。） */
    if (pass) {
      pass.addEventListener('focus', () => { try { pass.select(); } catch (e) {} });
      pass.addEventListener('click', () => { try { if (pass.value) pass.select(); } catch (e) {} });
    }
    const go = async () => {
      const v = pass.value.trim();
      if (!v) return;
      try {
        await API.login(v);
        document.getElementById('login').classList.add('hidden');
        /* 登录回来的这一下必须告诉「当前书」：开机那次 /api/shelf 是 401（还没登录），
           空书单不能被当成"这人没有书"—— 不然书架顶上永远写着「还没有作品」，
           而下面明明列着书（监督人截到过）。这里强制重拉一次，全站切换条跟着重画。 */
        if (window.BookCtx && BookCtx.loginOk) { try { BookCtx.loginOk().catch(() => {}); } catch (e) {} }
        start();
      } catch (e) {
        document.getElementById('login-msg').textContent = e.message || '密码不对';
        pass.value = '';
      }
    };
    document.getElementById('login-go').addEventListener('click', go);
    const rb = document.getElementById('login-retry');
    if (rb) rb.addEventListener('click', () => App.retryConnect());
    pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => App.show(t.dataset.tab)));
    applyPrefs();
    /* 等 App 那边把"走本机离线后端还是走服务器"定下来再往下走。
       浏览器里没人敲这一下，等一个很短的超时就过 —— 网页版行为不变。
       等这一下是为了：地址前缀（API.base()）在这之前还是空的，早发的请求会打空。 */
    /* 只有**在 App 里**才等：网页版没人敲这一下，等就是白等 4 秒（实测过，是真的变慢）。
       App 里这个等待是必要的 —— 地址前缀在这之前还是空的，早发的请求会打空。 */
    /* 等 App 那边把后端地址敲下来 —— **只在地址还不知道的时候等**。
       以前是"在 App 里就一定等满 4 秒"，那 4 秒里启动页一直盖在最上面：
       用户看到的就是"打开 App 先盯几秒黄底 logo"（他报的"一片黄"有一半是这个）。
       现在 App 一进来地址就是现成的（Java 在加载界面之前就把 ServerClient 配好了），
       所以这里**根本不用等**，启动页几乎立刻退场。
       等的时候也从 4000 收到 1500 —— 真等起来（JS 桥没装好那种）也别让人干等 4 秒。 */
    if (window.NBApp && window.API && API.waitBackend && !API.base()) {
      const be = await API.waitBackend(1500);
      if (be && be.mode === 'server-down') {
        /* 连不上服务器：**明说**，并且把「重试连接」摆出来。
           绝不退回本机那份空数据 —— 那是 2.0.2 让用户以为"东西全没了"的原因。 */
        App.showRetry(true, '连不上服务器' + (be.why ? '：' + String(be.why).slice(0, 50) : '')
          + '。点下面的「重试连接」。');
      } else if (be && be.mode === 'local') {
        App.toast('本机离线模式：数据在手机里，和服务器不是同一份');
      }
    }
    /* 手机端：本机后端启动时给了我们一串一次性口令（页面地址上的 ?t=…），
       用它换一个正常会话，用户就不用在手机上再输一遍密码。
       网页版地址上没有 t，这一段自然跳过。 */
    const m = location.search.match(/[?&]t=([^&#]+)/);
    if (m && Prefs.get('localLogged') !== '1') {
      try {
        await API.loginToken(decodeURIComponent(m[1]));
        Prefs.set('localLogged', '1');
        if (window.BookCtx && BookCtx.loginOk) { try { BookCtx.loginOk().catch(() => {}); } catch (e) {} }
      } catch (e) { /* 换不到就走下面的正常登录流程 */ }
    }
    try {
      const st = await API.status();
      App.showRetry(false);
      if (st.loggedIn) start();
      else App.needLogin();
    } catch (e) {
      /* 连不上服务器（断网 / 后端没起来）：别把人卡在登录页 ——
         界面本身在 App 包里，缓存过的书还能接着看。
         一个缓存都没有才显示登录页，并且把原因写在上面。 */
      const cached = window.Offline && Offline.stats().chapters > 0;
      if (e.offline && cached) {
        App.toast('离线：只看得到缓存过的书');
        start();
      } else {
        App.needLogin();
        if (e.offline) {
          const inApp = !!(window.Android && Android.retry);
          App.showRetry(true, '连不上服务器：' + (e.message || '检查网络')
            + (inApp ? '。点下面的「重试连接」，或到「设置 → 服务器设置」改地址。'
                     : '，检查一下网络。'));
        }
      }
    }
    wireShell();
    scheduleSplashDrop();          // 收尾再叫一次（幂等）：无论从哪条路走到这儿，启动页都会撤
  }

  /* ── 启动页退场（**排在所有 await 前面**）────────────────────────────────
     用户 2.0.1 报的"打开 App 一片黄"、以及监督人第 15 轮按像素抓出来的
     "四张截图全是启动页"，根因都是同一件事：`dropSplash` 原来写在 boot0 的**最后**，
     中间夹着 `await API.waitBackend(...)`。那一步只要卡住（App 那边还没把地址敲下来），
     启动页就一直盖在最上面，底下什么都有、用户什么都看不见。

     所以现在：**渲染出来就先把它排上**（见 boot0 开头那次调用），谁也别想挡住它。
     两道保险：
       · 双 rAF —— 正常路径，等一帧画完再淡出，不会闪白；
       · 1200ms 定时 —— requestAnimationFrame 在页面被切到后台时**完全不触发**
         （无头浏览器、或用户刚点开 App 又切走），那条路只剩定时兜底。
     ──────────────────────────────────────────────────────────────────── */
  let splashOff = false;
  function dropSplash() {
    if (splashOff) return;
    splashOff = true;
    const sp = document.getElementById('splash');
    if (sp) { sp.classList.add('gone'); setTimeout(() => { try { sp.remove(); } catch (e) {} }, 420); }
  }
  function scheduleSplashDrop() {
    if (splashOff) return;
    requestAnimationFrame(() => requestAnimationFrame(dropSplash));
    setTimeout(dropSplash, 1200);
  }

  /* ── 外壳细节：顶栏 hairline / 双击回顶 ── */
  function wireShell() {
    const SCROLLER = '.settings-body, .lore-body, .shelf-list, .chat-body, .preset-body, .tools-body, .tool-body';
    SCREENS.forEach((s) => {
      const el = document.getElementById('screen-' + s);
      if (!el) return;
      const bar = el.querySelector('.topbar');
      const sc = el.querySelector(SCROLLER);
      if (!bar || !sc) return;
      let raf = 0;
      sc.addEventListener('scroll', () => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          bar.classList.toggle('scrolled', sc.scrollTop > 3);
        });
      }, { passive: true });
      // 双击顶栏回到顶部（原生 App 常见手势）
      let last = 0;
      bar.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const now = Date.now();
        if (now - last < 320) { try { sc.scrollTo({ top: 0, behavior: 'smooth' }); } catch (x) { sc.scrollTop = 0; } last = 0; }
        else last = now;
      });
    });
  }

  function start() {
    const st = location.hash.replace('#/', '').split('?')[0];
    /* 自定义背景图：登录之后才知道"这本书是哪本"，所以在这一步读一次。
       读不到（还没传 / 没联网）就是默认纸纹 —— 不许因此把界面卡住。 */
    if (window.Appearance) { try { Appearance.load(); } catch (e) {} }
    App.show(SCREENS.includes(st) ? st : 'shelf', { push: false, animate: false });
  }

  /* ── 全局动作（data-act） ── */
  App.act = (name, e) => {
    /* 阅读界面里已经**没有"更多"那个整屏弹层**了：目录/书签/笔记/设置/翻页
       全部走底栏那一排 + 底部矮面板（用户点名："把右上角的三个点完全去掉，把设置弄到下面"）。
       底栏每个按钮都在这儿有明确落点 —— 点了没反应 / 只闪一下，都是从这里漏掉一条惹的。 */
    const map = {
      'reader-back': () => App.show(App.state.readerReturn || 'shelf'),
      'reader-quick': (e) => {
        /* ⚠ 这里以前读的是 `e.currentTarget` —— 但动作是在 **document 上委托**的
           （见 boot0 里那个 document.addEventListener），所以 currentTarget 永远是 document，
           `dataset.q` 永远取不到 → 一律回落成 'type'。
           用户看到的现象就是："点目录 / 点设置，出来的是同一个东西，目录根本出不来"。
           正确做法：从**真实点到的元素**往上找带 data-q 的那个按钮。 */
        const btn = e && e.target && e.target.closest ? e.target.closest('[data-q]') : null;
        const q = (btn && btn.dataset && btn.dataset.q) || 'type';
        if (window.Reader && Reader.quickToggle) Reader.quickToggle(q);
      },
      'reader-quick-close': () => window.Reader && Reader.quickClose && Reader.quickClose(),
      /* 底栏「目录」：**独立的一块**（不是设置面板里的页签）。
         用户原话："点开目录之后，只是相当于在设置里面点开了目录一样，并没有那种简洁的感觉。" */
      'rd-toc': () => window.Reader && Reader.tocToggle && Reader.tocToggle(),
      'toggle-tts': () => window.Reader && Reader.toggleTts && Reader.toggleTts(),
      'rd-prev': () => window.Reader && Reader.prevChapter && Reader.prevChapter(),
      'rd-next': () => window.Reader && Reader.nextChapter && Reader.nextChapter(),
      'rd-mark': () => window.Reader && Reader.addMark && Reader.addMark(),
      'rd-note': () => window.Reader && Reader.addNote && Reader.addNote(),
      'rd-fs-up': () => window.Reader && Reader.fontStep && Reader.fontStep(1),
      'rd-fs-down': () => window.Reader && Reader.fontStep && Reader.fontStep(-1),
      /* 书架顶上那条「连不上服务器：现在看到的是缓存里的书 · 重试」上的重试键 */
      'shelf-reload': () => {
        App.haptic && App.haptic();
        if (window.Shelf) { Shelf.books = {}; Shelf.load(true); }
      },
      'chat-back': () => App.show('shelf'),
      'chat-menu': () => window.Chat && Chat.menu && Chat.menu(),
      'lore-back': () => App.show('shelf'),
      'lore-search': () => window.Lore && Lore.toggleSearch && Lore.toggleSearch(),
      'settings-back': () => App.show('shelf'),
      'preset-back': () => App.show('shelf'),
      'tools-back': () => App.show('shelf'),
      'tool-back': () => (window.Tools && Tools.back) ? Tools.back() : App.show('tools'),
    };
    if (map[name]) map[name](e);
  };

  /* ── 偏好应用到界面 ── */
  const THEME_BAR = { paper: '#f3ead9', sepia: '#e9dcc3', slate: '#e8ebec',
    white: '#f7f6f4', green: '#d9e6d4', night: '#14120f' };
  /* 「跟随系统」：主题选 auto 时按系统的深浅色偏好走（夜里自动转夜间，白天回米黄） */
  const DARK_MQ = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  const themeOf = (t) => (t === 'auto' ? (DARK_MQ && DARK_MQ.matches ? 'night' : 'paper') : t);
  function applyPrefs() {
    const p = Prefs.all();
    const theme = themeOf(p.theme);
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themeChoice = p.theme;
    const bar = THEME_BAR[theme] || THEME_BAR.paper;
    const mt = document.querySelector('meta[name="theme-color"]');
    if (mt) mt.setAttribute('content', bar);
    // 安卓外壳：状态栏跟页面同色，浅色主题配深色图标（这是「不像网页」的关键一环）
    if (window.Android && Android.setStatusBar) {
      try { Android.setStatusBar(bar, theme !== 'night'); } catch (e) {}
    }
    // 安卓外壳：WebView / 原生底也要跟着主题走（bar 就是这套主题的页面底色）。
    // 不改的话它一直是包装时写死的米黄 —— 夜间模式下弹层弧线外侧那片"白边"就是它。
    if (window.Android && Android.setThemePaper) {
      try { Android.setThemePaper(bar); } catch (e) {}
    }
    document.documentElement.style.setProperty('--fs', p.fontSize + 'px');
    document.documentElement.style.setProperty('--lh', p.lineHeight);
    document.documentElement.style.setProperty('--para-gap', p.paraGap + 'em');
    document.documentElement.style.setProperty('--page-pad-x', p.margin + 'px');
    if (window.Android && Android.keepAwake) { try { Android.keepAwake(!!p.keepAwake); } catch (e) {} }
    document.documentElement.classList.toggle('motion-off', p.motion === 'off');
    if (window.Reader && Reader.relayout) Reader.relayout();
  }

  /* 水波纹只有一处实现，在上面（按指尖定位、半径封顶、被元素自身裁掉）。
     这里原来还藏着第二套：半径 max(w,h)*2.1 —— 小按钮 54px 也能铺出 113px 的
     一大团，点一下同时冒两个圈，正是用户说的「框了一大块区域在那儿震」。已删。 */
  Prefs.onChange(() => applyPrefs());
  if (DARK_MQ) {
    const onScheme = () => { if (Prefs.get('theme') === 'auto') applyPrefs(); };
    if (DARK_MQ.addEventListener) DARK_MQ.addEventListener('change', onScheme);
    else if (DARK_MQ.addListener) DARK_MQ.addListener(onScheme);
  }
  window.applyPrefs = applyPrefs;

  /* ── 设置面板（设置页与阅读器菜单共用） ── */
  /* `only` 传一组 key，就只渲染那几行 —— 阅读器底部的**快捷排版面板**要用同一套控件
     （不另写一份，免得"两套实现并存"）。传空 = 全渲染（设置页照旧）。 */
  /* 下拉框里显示得下的短标签：把括号里的补充说明去掉（"edge-tts（微软在线）" → "edge-tts"）。
     全名不丢 —— 放到 option 的 title / aria-label 上，鼠标悬停、读屏都还能拿到。 */
  const visibleLabel = (s) => String(s || '').replace(/[（(][^）)]*[）)]/g, '').replace(/\s+/g, ' ').trim() || String(s || '');

  App.prefsHtml = (only) => {
    const want = (k) => !only || only.indexOf(k) >= 0;
    const p = Prefs.all();
    const seg = (key, items) => `<div class="seg" data-pref="${key}">` + items.map(([v, label]) =>
      `<button data-v="${v}" class="${String(p[key]) === String(v) ? 'on' : ''}">${label}</button>`).join('') + '</div>';
    // 7 个主题排成整齐网格（一行 4 个，第二行 3 个自动均分）——别让第 7 个孤零零靠右
    /* 第三列可以给一个 title（长名字放不下的解释放这儿，按钮上只留两个字） */
    const segGrid = (key, items) => `<div class="seg grid" data-pref="${key}">` + items.map(([v, label, hint]) =>
      `<button data-v="${v}"${hint ? ` title="${hint}" aria-label="${hint}"` : ''}` +
      ` class="${String(p[key]) === String(v) ? 'on' : ''}">${label}</button>`).join('') + '</div>';
    /* 二元开关：全站**只有这一种形态**（48×28 的 .switch）。
       以前「界面动效」和「阅读时保持亮屏」用的是 .seg 里两个按钮（开 / 关），
       窄屏一挤就折成**上下堆叠的两个方块**（用户原话：「竟然是上下的一个开一个关，太丑了」）。 */
    const sw = (key, on, label) => `<button class="switch${on ? ' on' : ''}" data-switch="${key}" role="switch"`
      + ` aria-checked="${on ? 'true' : 'false'}" aria-label="${label}" title="${label}"><i></i></button>`;
    /* 主题色块：**色块本身就画着那套主题的底色**（不是只有两个字 —— 用户说"看不出米黄/暖褐长什么样"）。
       颜色值只有一份，在 tokens.css 的 .sw-* 里；tools/verify_tokens.py 会核对它跟主题块里的 --paper 一致。 */
    const swatch = (v, label) => `<button data-v="${v}" class="${String(p.theme) === v ? 'on' : ''}"`
      + ` title="${label}" aria-label="颜色主题：${label}">`
      + `<span class="sw sw-${v}" aria-hidden="true"></span><span>${label}</span></button>`;
    const step = (key, step_, min, max, unit) => `<div class="stepper" data-step="${key}" data-min="${min}" data-max="${max}" data-unit="${unit || ''}">
      <button data-d="-1">−</button><span class="v">${p[key]}${unit || ''}</span><button data-d="1">+</button></div>`;
    const row = (k, html) => want(k) ? html : '';
    const group = (title, rows) => {
      const body = rows.map(([k, h]) => row(k, h)).join('');
      return body ? '<h3>' + title + '</h3><div class="settings-group">' + body + '</div>' : '';
    };
    /* 主题按"是什么"分成三类，不再 7 个混排：
       ① 跟随系统（跟手机深色模式走）② 夜间模式（深色底）③ 颜色主题（6 个底色，规整 3×2 网格）。
       以前 7 个挤在一排 4+3，第二行右边空一块、色块还看不出颜色 —— 用户点名的"乱"。 */
    const THEMES = [['paper', '米黄'], ['sepia', '暖褐'], ['white', '纸白'],
      ['green', '护眼'], ['slate', '青灰'], ['night', '夜间']];
    return group('外观', [
      ['theme', `<div class="settings-row"><span class="k">跟随系统<small>跟手机的深色模式走</small></span>${sw('sysFollow', p.theme === 'auto', '跟随系统')}</div>
      <div class="settings-row"><span class="k">夜间模式<small>深色底 + 浅色字</small></span>${sw('night', p.theme === 'night', '夜间模式')}</div>
      <div class="settings-row stack"><span class="k">颜色主题<small>这本书的底色</small></span><div class="seg grid themes" data-pref="theme">${THEMES.map(([v, l]) => swatch(v, l)).join('')}</div></div>`],
      ['fontFamily', `<div class="settings-row"><span class="k">正文字体</span>${seg('fontFamily', [['serif', '宋体'], ['sans', '黑体']])}</div>`],
      /* 数值带单位、固定列宽、居中 —— 以前是光秃秃的 14 / 1.9 / 26，三行数字宽度不一、左右空隙乱跳 */
      ['fontSize', `<div class="settings-row"><span class="k">字号</span>${step('fontSize', 1, 14, 30, 'px')}</div>`],
      ['lineHeight', `<div class="settings-row"><span class="k">行距</span>${step('lineHeight', 0.1, 1.3, 2.6, '倍')}</div>`],
      ['margin', `<div class="settings-row"><span class="k">页边距</span>${step('margin', 2, 8, 48, 'px')}</div>`],
    ]) +
    /* 自定义背景图（第 43 轮）：用户原话「整个大背景要弄成可以自己上传图片的」。
       这一组的 HTML 由 js/appearance.js 出（它管着"哪一档 / 铺法 / 上传移除"），
       这里只放一个挂载点 —— 实现只有那一份，别在设置页里再写一套。 */
    (want('bgimg') && window.Appearance ? Appearance.settingsHtml() : '') +
    group('动效', [
      ['motion', `<div class="settings-row"><span class="k">界面动效<small>水波纹 / 入场动画</small></span>${sw('motion', p.motion === 'on', '界面动效')}</div>`],
      /* 4 个选项**就是 4 等分的网格**（一行放得下，不许换行、不许宽窄不一） */
      ['pageMode', `<div class="settings-row"><span class="k">切页动画</span>${segGrid('pageMode', [['curl', '仿真'], ['slide', '平移'], ['scroll', '滚动'], ['none', '无动画']])}</div>`],
    ]) +
    group('翻页', [
      ['keepAwake', `<div class="settings-row"><span class="k">阅读时保持亮屏</span>${sw('keepAwake', p.keepAwake !== false, '阅读时保持亮屏')}</div>`],
    ]) +
    group('听书', [
      ['voice', `<div class="settings-row"><span class="k">音色</span><select class="input" data-select="voice"></select></div>`],
      ['ttsEngine', `<div class="settings-row"><span class="k">朗读引擎</span><select class="input" data-select="ttsEngine"></select></div>`],
      ['rate', `<div class="settings-row"><span class="k">语速</span>${seg('rate', [['-20%', '慢'], ['+0%', '正常'], ['+25%', '快'], ['+50%', '更快']])}</div>`],
      ['ttsFollow', `<div class="settings-row"><span class="k">页面跟着朗读走<small>读到哪翻到哪</small></span>${sw('ttsFollow', p.ttsFollow !== false, '页面跟着朗读走')}</div>`],
      /* 用户报「App 里听书从来没有出过声音」——
         这条入口点一下就把整条路逐项量一遍（地址 → 服务器 → 音频直链 → 加载 → 播放），
         哪一环断了、什么码、为什么，都摆在眼前。不再让"没声音"变成哑巴失败。 */
      ['ttsdiag', `<div class="settings-row"><span class="k">听书没声音？<small>逐项量一遍，看卡在哪一环</small></span>`
        + `<button class="btn sm" id="do-ttsdiag">听书自检</button></div>`],
    ]) +
    /* AI 那一摊（模型 / 密钥 / 上网搜索）**不在这儿** —— 用户原话：
        「我不清楚他为什么把联网搜索放在这儿了，不应该放到 AI 对话里吗？……
          AI 对话需要弄一个专门的设置啊，就是放那种拉取 AI 之类的」。
       第 37 轮把「联网搜索」整段**搬到「对话」页的设置里**（js/chat.js 的「模型与渠道」）。
       这里只留**一行指路**：不是第二份控件，是个门（点一下就跳到那边并把它打开）——
       免得用户在大设置里翻不到、以为"这个功能根本没有按钮"。 */
    group('AI 与上网', [
      ['aiweb', `<div class="settings-row"><span class="k">模型 · 密钥 · 上网搜索<small>都在「对话」页的设置里开</small></span>`
        + `<button class="btn sm" id="goto-chat-setup">去对话设置</button></div>`],
    ]) +
    group('账号', [
      ['account', `<div class="settings-row"><span class="k">登录密码</span><button class="btn sm" id="do-pass">改密码</button></div>
        <div class="settings-row"><span class="k">退出登录</span><button class="btn sm btn-danger" id="do-logout">退出</button></div>`],
    ]);
  };

  App.wirePrefs = (root) => {
    root.querySelectorAll('.seg[data-pref]').forEach((s) => {
      s.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        const key = s.dataset.pref;
        let v = b.dataset.v;
        if (v === 'true') v = true; else if (v === 'false') v = false;
        else if (!isNaN(Number(v)) && String(Number(v)) === v && key !== 'rate') v = Number(v);
        Prefs.set(key, v);
        /* 颜色主题是"这本书用哪套底色"：记住它 —— 关掉「跟随系统」/「夜间模式」时要退回这套，
           不然关掉之后会莫名其妙回到默认米黄。 */
        if (key === 'theme') Prefs.set('themeColor', v);
        s.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      });
    });
    /* 二元开关（.switch）：全站共用一处实现 —— 外观（跟随系统 / 夜间）、动效、翻页、听书都走这儿 */
    root.querySelectorAll('[data-switch]').forEach((b) => {
      b.addEventListener('click', () => {
        const key = b.dataset.switch;
        const next = !b.classList.contains('on');
        if (key === 'motion') Prefs.set('motion', next ? 'on' : 'off');
        else if (key === 'keepAwake' || key === 'ttsFollow') Prefs.set(key, next);
        else if (key === 'sysFollow') Prefs.set('theme', next ? 'auto' : (Prefs.get('themeColor') || 'paper'));
        else if (key === 'night') {
          if (next) {
            if (Prefs.get('theme') !== 'night') Prefs.set('themePrev', Prefs.get('theme'));
            Prefs.set('theme', 'night');
          } else Prefs.set('theme', Prefs.get('themePrev') || Prefs.get('themeColor') || 'paper');
        }
        App.syncPrefsUI(root);
      });
    });
    root.querySelectorAll('.stepper[data-step]').forEach((s) => {
      const key = s.dataset.step, min = +s.dataset.min, max = +s.dataset.max, unit = s.dataset.unit || '';
      s.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        let v = Number(Prefs.get(key)) + Number(b.dataset.d) * (Number(s.dataset.step) || 1);
        v = Math.min(max, Math.max(min, +v.toFixed(2)));
        Prefs.set(key, v);
        const lbl = s.querySelector('.v');
        if (lbl) lbl.textContent = (key === 'lineHeight' ? v.toFixed(1) : v) + unit;
      });
    });
    const sel = root.querySelector('[data-select="voice"]');
    const eng = root.querySelector('[data-select="ttsEngine"]');
    if (sel || eng) {
      API.voices().then((d) => {
        (d.voices || []).forEach((v) => {
          const o = document.createElement('option');
          o.value = v.id; o.textContent = visibleLabel(v.name); o.title = v.name;
          if (v.id === Prefs.get('voice')) o.selected = true;
          sel && sel.appendChild(o);
        });
        const cur = Prefs.get('ttsEngine') || d.engine || 'edge';
        (d.engines || []).forEach((e) => {
          const o = document.createElement('option');
          o.value = e.key;
          /* 下拉框里只放**短的**引擎名（"edge-tts"），括号里的说明进 title / aria-label ——
             以前放全名，在手机上被硬截成「edge-tts（微软在:」，看着像坏掉（用户点名的）。 */
          const full = (e.label || e.key) + (e.available ? '' : '（不可用）');
          const short = visibleLabel(full);
          o.textContent = short;
          o.title = full;
          o.setAttribute('aria-label', full);
          o.disabled = !e.available;
          if (e.key === cur) o.selected = true;
          eng && eng.appendChild(o);
        });
      }).catch(() => {});
      const diag = root.querySelector('#do-ttsdiag');
      if (diag) diag.addEventListener('click', () => {
        if (window.Reader && Reader.selfCheck) Reader.selfCheck();
        else App.toast('先打开一本书再自检');
      });
      sel && sel.addEventListener('change', () => Prefs.set('voice', sel.value));
      eng && eng.addEventListener('change', () => Prefs.set('ttsEngine', eng.value));
    }
    App.syncPrefsUI(root);
  };

  /* 把界面上的开关 / 选中态 / 步进器数值按 Prefs 刷一遍。
     为什么要这一步：主题有三个入口（跟随系统、夜间、颜色主题）互相联动，
     不统一刷就会出现"选了夜间、颜色主题还亮着米黄"这种自相矛盾的状态。 */
  App.syncPrefsUI = (root) => {
    if (!root) return;
    const p = Prefs.all();
    root.querySelectorAll('[data-switch]').forEach((b) => {
      const k = b.dataset.switch;
      const on = k === 'motion' ? p.motion === 'on'
        : k === 'keepAwake' ? p.keepAwake !== false
          : k === 'ttsFollow' ? p.ttsFollow !== false
            : k === 'sysFollow' ? p.theme === 'auto' : p.theme === 'night';
      b.classList.toggle('on', !!on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    root.querySelectorAll('.seg[data-pref]').forEach((s) => {
      const k = s.dataset.pref;
      s.querySelectorAll('button[data-v]').forEach((x) => x.classList.toggle('on', String(p[k]) === x.dataset.v));
    });
    root.querySelectorAll('.stepper[data-step]').forEach((s) => {
      const k = s.dataset.step, unit = s.dataset.unit || '';
      const v = Number(p[k]);
      const lbl = s.querySelector('.v');
      if (lbl) lbl.textContent = (k === 'lineHeight' ? v.toFixed(1) : v) + unit;
    });
  };

  window.Settings = {
    onShow() {
      const body = document.getElementById('settings-body');
      body.innerHTML = App.prefsHtml();
      App.wirePrefs(body);
      /* 「背景」那一组的交互（上传 / 更换 / 移除 / 铺法 / 用在哪一档）。
         wire 只绑事件；它自己会去读服务端的当前设置。 */
      if (window.Appearance) { Appearance.wire(body); Appearance.load(); }
      /* 「主题（这本书的颜色）」就是跟书走的 → 设置页顶上也要有那个切书入口。
         用同一个组件（BookCtx），不许这儿再写一套。 */
      if (window.BookCtx) {
        BookCtx.mount(body, () => Settings.onShow(), { anchor: body });
      }
      /* 「去对话设置」那一行：跳到对话页并把「模型与渠道」那块开好
         （谁都能一眼找到"用哪个模型 / 能不能上网"，不用在大设置里翻）。 */
      const go = body.querySelector('#goto-chat-setup');
      if (go) {
        go.addEventListener('click', () => {
          App.show('chat');
          setTimeout(() => { try { window.Chat && Chat.modelsSetup && Chat.modelsSetup(); } catch (e) {} }, 420);
        });
      }
      body.querySelector('#do-logout').addEventListener('click', () => {
        API.logout().then(() => location.reload());
      });
      body.querySelector('#do-pass').addEventListener('click', () => {
        App.modal(`<div class="t-dialog">
          <h3>改登录密码</h3>
          <input class="t-input" id="pw-old" type="password" placeholder="现在的密码" autocomplete="current-password">
          <input class="t-input" id="pw-new" type="password" placeholder="新密码（至少 4 位）" autocomplete="new-password">
          <input class="t-input" id="pw-new2" type="password" placeholder="再输一遍新密码" autocomplete="new-password">
          <div class="t-acts">
            <button class="t-btn" data-close>取消</button>
            <button class="t-btn pri" id="pw-go">改</button>
          </div>
        </div>`, {
          onMount(p) {
            p.querySelector('#pw-go').addEventListener('click', async () => {
              const oldPw = p.querySelector('#pw-old').value;
              const n1 = p.querySelector('#pw-new').value;
              const n2 = p.querySelector('#pw-new2').value;
              if (n1.length < 4) { App.toast('新密码太短（至少 4 位）'); return; }
              if (n1 !== n2) { App.toast('两遍新密码不一样'); return; }
              try {
                await API.raw('api/app/change-password', {
                  method: 'POST', body: { oldPassword: oldPw, newPassword: n1 },
                });
                App.closeModal();
                App.toast('密码改了，请重新登录');
                setTimeout(() => location.reload(), 1200);
              } catch (e) { App.toast('改不了：' + e.message); }
            });
            setTimeout(() => p.querySelector('#pw-old').focus(), 80);
          },
        });
      });
      const inApp = !!(window.Android && Android.getPlatform);
      const ver = inApp ? (Android.getVersion ? Android.getVersion() : '') : '';
      const myCode = (inApp && Android.getVersionCode) ? Android.getVersionCode() : 0;
      body.insertAdjacentHTML('beforeend',
        `<h3>关于</h3><div class="settings-group">
          <div class="settings-row"><span class="k">服务地址</span><span class="muted" style="font-size:var(--t-md);word-break:break-all">${location.origin}</span></div>
          <div class="settings-row"><span class="k">版本</span><span class="muted" style="font-size:var(--t-md)">手机写作台 ${ver || '网页版'}</span></div>
          ${inApp ? '<div class="settings-row"><span class="k">服务器设置</span><button class="btn sm" id="do-server">改地址</button></div>' : ''}
          ${inApp ? '<div class="settings-row"><span class="k">服务器后端 <span class="hint" id="local-sub" style="font-size:var(--t-sm);color:var(--ink-3)">查一下…</span></span><button class="btn sm" id="do-local">重试连接</button></div>' : ''}
          <div class="settings-row"><span class="k">安卓安装包</span><span id="apk-slot"><button class="btn sm" id="do-apk">下载 / 更新</button></span></div>
        </div>`);
      const sb = body.querySelector('#do-server');
      if (sb) sb.addEventListener('click', () => { try { Android.openSettings(); } catch (e) {} });

      /* ── 后端状态 ──────────────────────────────────────────────────
         **后端唯一真身 = 服务器那一份**（用户 2026-09-20 拍板，见 docs/决策记录 D13）。
         这一行必须让用户看得见"现在连的是哪台、通不通" —— 手机上没 SSH、没 logcat，
         连不上时这一行 + 那个「重试连接」就是他唯一能自救的地方。
         （本机离线后端还在，但**默认关**，用户显式开了才会显示成"本机离线"。） */
      const ls = body.querySelector('#local-sub');
      const dl = body.querySelector('#do-local');
      if (dl) dl.addEventListener('click', () => {
        App.retryConnect();
        if (ls) ls.textContent = '正在重连…';
        setTimeout(refreshLocal, 2500);
        setTimeout(refreshLocal, 8000);
      });
      function refreshLocal() {
        let st = null;
        try { st = JSON.parse(Android.localStatus ? Android.localStatus() : '{}'); } catch (e) { st = null; }
        if (!ls) return;
        if (!st || !st.mode) { ls.textContent = '查不到'; return; }
        const addr = st.server ? String(st.server).replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
        const word = {
          local: '本机离线 · 和服务器不是同一份数据',
          server: '已连上服务器' + (addr ? ' · ' + addr : ''),
          'server-down': '连不上服务器' + (addr ? ' · ' + addr : ''),
          starting: '正在连…',
          down: '本机起不来 · 已用服务器',
        }[st.mode] || st.mode;
        ls.textContent = word + (st.why ? '（' + String(st.why).slice(0, 60) + '）' : '');
      }
      if (ls) { refreshLocal(); setTimeout(refreshLocal, 2500); }

      /* ── 下载更新 ────────────────────────────────────────────────
         在 App 里：交给原生去下（下完直接弹安装），不走浏览器 ——
         以前丢给浏览器，手机没浏览器或者被拦，点了就一点反应都没有。
         在网页里：老老实实走浏览器下载。 */
      /* ⚠️ 必须是 **api/apk**：路由挂在 /api 前缀下，写成 'apk' 会去下 /apk ——
         那是 404 页面。以前就是这么写的，表现成"点了下载/更新，一点用都没有"。 */
      const apkUrl = window.API.media ? window.API.media('api/apk') : new URL('api/apk', location.href).href;
      let apkName = '写作台-新版本.apk';
      const doApk = body.querySelector('#do-apk');
      if (doApk) doApk.addEventListener('click', () => {
        if (inApp && Android.downloadApk) {
          try { Android.downloadApk(apkUrl, apkName); return; } catch (e) {}
        }
        location.href = apkUrl;
      });

      /* 问服务器「最新安装包是哪个版本」，比自己的新就把按钮点亮 */
      (async () => {
        const slot = body.querySelector('#apk-slot');
        if (!slot) return;
        let info = null;
        try {
          /* 用 API.abs()：App 里页面可能是 file:// 的，写死相对路径会变成 file:///api/…，
             于是「有没有新版本」永远查不出来（真机上就是这么坏了好几个版本）。 */
          const r = await fetch(window.API.abs('api/apk/version'), { credentials: 'include' });
          if (r.ok) info = await r.json();
        } catch (e) {}
        if (!info || !info.available || !info.versionCode) return;
        apkName = '写作台-' + (info.versionName || info.versionCode) + '.apk';
        /* 已经是最新就别打扰。判定要「编号」和「版本名」都对不上才算新：
           App 里那个编号曾经写死过（清单都 1.2 了它还说 1.1），
           光比数字会一直误报「有新版本」，用户升到最新还被告知要更新。 */
        const newer = info.versionCode > (myCode || 0) && (!ver || info.versionName !== ver);
        if (!newer) return;
        const shown = slot.closest('.settings-row');
        if (shown) shown.querySelector('.k').textContent = '有新版本';
        slot.innerHTML =
          `<span class="muted" style="font-size:var(--t-md)">v${info.versionName || info.versionCode}` +
          (info.size ? ' · ' + Math.round(info.size / 1024) + 'KB' : '') + '</span> ' +
          '<button class="btn sm" id="do-apk">下载更新</button>';
        const b2 = slot.querySelector('#do-apk');
        if (b2) b2.addEventListener('click', () => {
          if (inApp && Android.downloadApk) {
            try { Android.downloadApk(apkUrl, apkName); return; } catch (e) {}
          }
          location.href = apkUrl;
        });
      })();
    },
  };

  /* 安卓返回键：先关抽屉/弹窗，再退到书架，最后才是「再按一次退出」 */
  window.AndroidBack = () => {
    const sheet = document.getElementById('sheet');
    if (sheet && !sheet.classList.contains('hidden')) { App.closeSheet(); return true; }
    const modal = document.getElementById('modal');
    if (modal && !modal.classList.contains('hidden')) { App.closeModal(); return true; }
    /* 阅读器底部快捷面板：返回键**第一下**先收它（不能一步退出阅读器）。
       为什么放在这里而不是靠 history：App 里页面是 file://，pushState 会抛
       SecurityError（见 App.show 里那段注释），所以返回键这一层只能由 Java 转给前端算。 */
    /* 阅读器的两层浮层：**先收目录、再收设置面板**（用户报过"退出没有退到该退的地方"）。
       顺序反了的话，从目录里按返回会先把底下没开的设置面板"收"一遍 —— 点了跟没点一样。 */
    if (window.Reader && Reader.tocOn && Reader.tocOn()) { Reader.tocClose(); return true; }
    if (window.Reader && Reader.quickOn && Reader.quickOn()) { Reader.quickClose(); return true; }
    const tab = document.body.dataset.tab || 'shelf';
    /* 工具区是「宫格 → 详情 →（文件浏览器里再进目录）」好几层，
       返回键必须一层一层退，不能一步跳回书架 —— 以前就是这么跳的。 */
    if (tab === 'tool' && window.Tools && Tools.back) { Tools.back(); return true; }
    if (tab !== 'shelf') { App.show('shelf'); return true; }
    return false;
  };

  document.getElementById('btn-shelf-menu') && document.getElementById('btn-shelf-menu').addEventListener('click', () => App.show('settings'));

  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
})();
