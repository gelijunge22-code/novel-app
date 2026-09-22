/* ============================================================
   ui.js — 前端组件层（「前端大改」立起来的那一层）

   为什么要有这个文件：界面代码以前**每一个屏自己拼字符串**
   （`'<div class="book-card">' + …`），于是同一个"按钮"在八个屏里长出八个样子，
   "UI 不统一"就是这么攒出来的。现在的规矩：

     · 生成 DOM 只走这里（UI.h / UI.el / 下面那些构造函数）；
     · 这里产出的类名，就是 css/components.css 里定义的那一套 —— 一一对上；
     · 想加一个新控件：先往 components.css 加类，再往这里加构造函数，**不许在屏里内联样式**。

   只依赖：window.setIcon（图标在 app.js 里，只有一份）。
   ============================================================ */
(function () {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /* ── 建元素 ─────────────────────────────────────────────── */
  /** h('div', {class:'card', 'data-x':1}, [子元素 | 字符串]) —— 最小够用的 hyperscript */
  function h(tag, attrs, kids) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    add(node, kids);
    return node;
  }

  function add(node, kids) {
    if (kids == null) return node;
    (Array.isArray(kids) ? kids : [kids]).forEach((k) => {
      if (k == null || k === false || k === '') return;
      node.appendChild(typeof k === 'object' ? k : document.createTextNode(String(k)));
    });
    return node;
  }

  /** el('<div class="x">…') —— html 串转元素（带转义的字符串用 esc() 拼） */
  function el(html) {
    const box = document.createElement('div');
    box.innerHTML = String(html == null ? '' : html);
    return box.firstElementChild;
  }

  /** 一串元素 → DocumentFragment */
  function frag(kids) { return add(document.createDocumentFragment(), kids); }

  /** 图标：data-icon + 唯一那份图标实现（app.js 的 setIcon），不许各写一份 svg */
  function icon(name, cls) {
    const s = h('span', { class: cls || 'ui-ico' });
    s.dataset.icon = name;
    if (window.setIcon) window.setIcon(s, name);
    return s;
  }

  /* ── 控件 ───────────────────────────────────────────────── */
  /** 图标按钮（顶栏/工具条那种 44×44 的圆钮） */
  function iconBtn(o) {
    const b = h('button', { class: 'icon-btn' + (o.sm ? ' sm' : '') + (o.cls ? ' ' + o.cls : '') });
    b.setAttribute('aria-label', o.label || '');
    if (o.act) b.dataset.act = o.act;
    if (o.icon) b.appendChild(icon(o.icon));
    if (o.onClick) b.addEventListener('click', o.onClick);
    return b;
  }

  /** 文字按钮：变体 = primary / soft / ghost / danger（见 components.css） */
  function btn(text, o) {
    const opt = o || {};
    const b = h('button', {
      class: 'btn' + (opt.variant ? ' btn-' + opt.variant : '') + (opt.sm ? ' sm' : '') +
        (opt.block ? ' btn-block' : '') + (opt.cls ? ' ' + opt.cls : ''),
    });
    if (opt.act) b.dataset.act = opt.act;
    if (opt.icon) b.appendChild(icon(opt.icon));
    add(b, text);
    if (opt.onClick) b.addEventListener('click', opt.onClick);
    return b;
  }

  /** 小标签 */
  function badge(text, kind) {
    return h('span', { class: 'badge' + (kind ? ' ' + kind : '') }, text);
  }

  /** 细进度条：pct = 0~100（null 表示还没有数据 → 不画） */
  function meter(pct) {
    const m = h('div', { class: 'meter' });
    m.appendChild(h('i', { style: { width: (pct == null ? 0 : Math.max(0, Math.min(100, pct))) + '%' } }));
    return m;
  }

  /* ── 三态：空 / 载入 / 出错（用户看到"卡住了/东西没了"多半是因为以前没有这三态） ── */
  /**
   * state({ kind:'empty'|'loading'|'error', icon, title, desc, actions:[元素] })
   * 出错态自动带 .error（红色圆底），载入态自动转圈。
   */
  function state(o) {
    const opt = o || {};
    const kind = opt.kind || 'empty';
    const box = h('div', { class: 'ui-state' + (kind === 'error' ? ' error' : ''), 'data-state': kind });
    if (kind === 'loading') box.appendChild(h('span', { class: 'spinner' }));
    else if (opt.icon) box.appendChild(h('div', { class: 'ui-state-ico' }, icon(opt.icon)));
    if (opt.title) box.appendChild(h('div', { class: 'ui-state-t', text: opt.title }));
    if (opt.desc) box.appendChild(h('div', { class: 'ui-state-d', text: opt.desc }));
    if (opt.actions && opt.actions.length) {
      box.appendChild(h('div', { class: 'ui-state-act' }, opt.actions));
    }
    return box;
  }

  /** 骨架屏：list = 书卡那种（缩略图+两行），text = 几行字 */
  function skeleton(kind, n) {
    const box = h('div', { class: 'ui-skel' + (kind === 'list' ? ' ui-skel-list' : ''), 'data-state': 'loading' });
    const count = Math.max(1, n || (kind === 'list' ? 3 : 3));
    if (kind === 'list') {
      for (let i = 0; i < count; i++) {
        box.appendChild(h('div', { class: 'sk-card', style: { '--i': i } }, [
          h('div', { class: 'skeleton sk-thumb' }),
          h('div', { class: 'sk-body' }, [
            h('div', { class: 'skeleton sk-line w60' }),
            h('div', { class: 'skeleton sk-line w40' }),
          ]),
        ]));
      }
    } else {
      for (let i = 0; i < count; i++) {
        box.appendChild(h('div', { class: 'skeleton sk-line' + (i % 2 ? ' w40' : ' w60') }));
      }
    }
    return box;
  }

  /* ── 三态渲染：往一个容器里画「加载 / 空 / 出错」──────────────────────
     从 tools.js 提上来的：工具面板、设定页、预设页…… 本来各写各的，
     于是同一个 App 里"加载中"有三种长相、"读不到"有两句说法（此处说明"不统一"）。
     现在**只此一份**，谁要三态就 `UI.loadingIn/emptyIn/failedIn`，全站长得一模一样。
     `failedIn` 的 `again` 是**真重试**（把原来那个拉取函数再跑一遍），不是摆设按钮。 */
  function paintState(host, o) {
    if (!host) return null;
    host.innerHTML = '';
    const box = state(o);
    host.appendChild(box);
    return box;
  }
  /** 加载态：骨架 + 一句「正在读…」（打 data-state=loading，机器判据看得见） */
  function loadingIn(host, msg) {
    if (!host) return null;
    host.innerHTML = '';
    const box = h('div', { class: 'ui-loading', 'data-state': 'loading' });
    box.appendChild(skeleton('text', 3));
    box.appendChild(h('div', { class: 'ui-loading-hint', text: msg || '读取中…' }));
    host.appendChild(box);
    return box;
  }
  /** 空态：一句人话 + 说明（"没有东西"要说得出来，不能给白纸） */
  function emptyIn(host, title, desc, ico) {
    return paintState(host, { kind: 'empty', icon: ico || 'list', title, desc: desc || '' });
  }
  /** 出错态：说人话 + 「重试」。`what` 是"哪一块"（"设定"/"文件树"），`again` 重跑哪个函数 */
  function failedIn(host, what, e, again, opt) {
    const o = opt || {};
    const off = !!(e && (e.offline || e.status === 0));
    const acts = [];
    if (again) {
      const b = btn(o.retryText || '重试', { variant: 'primary', act: 'retry' });
      b.onclick = () => { haptic(); again(); };
      acts.push(b);
    }
    return paintState(host, {
      kind: 'error', icon: o.icon || 'refresh',
      title: what + (off ? '：连不上服务器' : '：读不出来'),
      desc: (off ? '看看手机是不是断网了，或者服务器在重启。'
        : ((e && e.message) ? e.message + '。' : '') + '这一块这次没取回来。')
        + '点「重试」再来一次。',
      actions: acts,
    });
  }

  /* ── 「这一轮 AI 用了什么」的账（对话页） ─────────────────────────
     。
     数据由后端给：看了什么**只从真拼出来的 system 里读**（server/llm/prompts.py 的
     digest_system），调了什么/改了哪些文件是这一轮真跑过的 —— 所以卡片上写的
     跟模型真拿到的、真做过的是同一件事，不是宣传数字。
     `label(name)` 由调用方给：chat.js 那份 TOOL_LABEL 是工具中文名的唯一出处，
     这里不另抄一份（抄了就会有一处永远不更新）。 */
  function usageCard(ctx, opt) {
    const c = ctx || {};
    const o = opt || {};
    const label = typeof o.label === 'function' ? o.label : (x) => String(x || '');
    /* 只把「它读了什么资料」算进上面那句：人设与工具清单不是资料，
       它们分别体现在「这次是谁在说话」与下面「它能用的工具」里，
       混在一起会让卡片变成流水账。 */
    const secs = (Array.isArray(c.sections) ? c.sections : [])
      .filter((x) => x && x.name && x.name !== '人设' && x.name !== '工具清单');
    const tools = c.tools || {};
    const allowed = Array.isArray(tools.allowed) ? tools.allowed : [];
    const called = Array.isArray(tools.called) ? tools.called : [];
    const files = Array.isArray(c.files) ? c.files : [];
    const has = secs.length || allowed.length || called.length || files.length;

    const head = h('button', { class: 'uc-head', type: 'button' });
    head.setAttribute('aria-expanded', o.open ? 'true' : 'false');
    head.appendChild(icon('layers', 'uc-ico'));
    head.appendChild(h('span', { class: 'uc-t', text: '这一轮 AI 用了什么' }));
    const bits = [];
    if (secs.length) bits.push('看了 ' + secs.length + ' 样');
    if (allowed.length) bits.push(allowed.length + ' 个工具可用');
    if (called.length) bits.push('调了 ' + called.length + ' 次');
    if (files.length) bits.push('改了 ' + files.length + ' 个文件');
    head.appendChild(h('span', { class: 'uc-s', text: bits.join(' · ') || '这轮只聊天，没读也没改' }));
    head.appendChild(icon('chevron', 'uc-chev'));

    const body = h('div', { class: 'uc-body' });
    const sec = (title, kids) => h('div', { class: 'uc-sec' }, [h('div', { class: 'uc-sec-t', text: title })].concat(kids));
    const item = (k, v, cls) => h('div', { class: 'uc-item' }, [
      h('span', { class: 'k', text: k }), h('span', { class: 'v' + (cls ? ' ' + cls : ''), text: v }),
    ]);

    /* ① 它看了这些 —— 每条带上"有多大"（字数），用户一眼知道喂了多少料 */
    if (secs.length) {
      body.appendChild(sec('它看了这些', secs.map((x) => item(
        x.name, (x.facts || []).join(' · ') + (x.chars ? '（' + x.chars + ' 字）' : '')))));
    }
    /* ② 它能用的工具 —— 中文名，全站同一份对照 */
    if (allowed.length) {
      body.appendChild(sec('它能用的工具', [h('div', { class: 'uc-tags' },
        allowed.map((n) => h('span', { class: 'uc-tag', text: label(n) })))]));
    }
    /* ③ 它真调了这些 —— 失败的一眼能看出来（不让用户以为 AI 干成了） */
    if (called.length) {
      body.appendChild(sec('它调了这些', called.map((t) => item(
        label(t.name), t.arg || '（没带参数）', t.ok === false ? 'uc-bad' : ''))));
    }
    /* ④ 它改了这些文件 */
    if (files.length) {
      body.appendChild(sec('它改了这些文件', files.map((f) => item('文件', f))));
    }
    if (!has) body.appendChild(h('div', { class: 'uc-empty', text: '这一轮没有读资料、也没有调工具。' }));
    body.hidden = !o.open;

    const card = h('div', { class: 'usage-card' + (o.open ? ' open' : ''), 'data-usage': '1' }, [head, body]);
    head.addEventListener('click', () => {
      const open = body.hidden;
      body.hidden = !open;
      card.classList.toggle('open', open);
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      haptic(6);
    });
    return card;
  }

  /* ── 动效 ───────────────────────────────────────────────── */
  /** 给一列刚渲染出来的东西排进场（--i 决定延迟，见 components.css 的 .ui-rise） */
  function stagger(list, cls) {
    Array.prototype.forEach.call(list || [], (el2, i) => {
      if (!el2 || !el2.classList) return;
      el2.classList.add(cls || 'ui-rise');
      el2.style.setProperty('--i', i);
    });
  }

  /** 震一下（手机上"点到了"的反馈）。不支持就静默 —— 这不是错误。 */
  function haptic(ms) {
    try { if (navigator.vibrate) navigator.vibrate(ms || 8); } catch (e) { /* 没有振动就算了 */ }
  }

  /* ── 格式化（全站一套写法：字数用千分位、百分比不带小数） ── */
  const fmt = {
    /** 12,345 */
    num(n) { return Number(n || 0).toLocaleString('en-US'); },
    /** 23.6 万字 / 8,120 字 */
    words(n) {
      const v = Number(n || 0);
      if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + ' 万字';
      return this.num(v) + ' 字';
    },
    /** 0~100 的整数 */
    pct(n) { return Math.max(0, Math.min(100, Math.round(Number(n) || 0))) + '%'; },
    /** 时间戳 → 刚刚 / 3 分钟前 / 昨天 / 9月20日 */
    when(ts) {
      const t = Number(ts || 0);
      if (!t) return '';
      const now = Date.now(), d = now - t;
      if (d < 60000) return '刚刚';
      if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
      if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
      if (d < 172800000) return '昨天';
      const dt = new Date(t);
      return (dt.getMonth() + 1) + '月' + dt.getDate() + '日';
    },
  };

  window.UI = {
    esc, h, el, frag, icon, iconBtn, btn, badge, meter,
    state, skeleton, usageCard, stagger, haptic, fmt,
    paintState, loadingIn, emptyIn, failedIn,
  };
})();
