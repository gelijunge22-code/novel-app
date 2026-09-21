/* ============================================================
   appearance.js — 自定义大背景图（第 43 轮）

   用户原话（一字不改）：
     「整个大背景要弄成可以自己上传图片的，现在这样太丑了」
     「我说的大背景是这整个前端」

   这一份是**唯一**的实现：上传 / 更换 / 移除 / 铺法 / 用在哪一档，全在这儿。
   界面长在大设置 →「背景」那一组（js/app.js 的 prefsHtml 只放一个挂载点）。

   为什么这么做（逐条，写给以后改的人）：
   1. **服务端存文件、不存 base64**：图进 SQLite 会让库膨胀几十倍（备份/同步都拖慢）。
      接口见 server/routers/appearance.py。
   2. **地址一律走 API.media()**：App 里是 file:// 来源，媒体地址必须换成带口令的绝对地址；
      浏览器里 media() 原样返回相对路径（`api/…`，不带前导斜杠）——
      带上前导斜杠会解析到站点根，在 /novel/ 这种子路径下就是 404（第 43 轮踩过）。
      ⚠ 别在这儿自己拼 URL。
   3. **图铺在"屏幕自己身上"**（跟第 35 轮的纸纹同一处，见 css/decor.css），
      不是 body 上一张固定层 —— 阅读器（#screen-reader）**保持干净**：
      正文要读，底纹跟字打架最不划算。理由写进 docs/自审清单.md 第 43 轮那一节。
   4. **上面那层"纱"（--paper-veil）是给对比度兜底的**：用户传的可能是全黑图，
      正文直接压上去就成了黑底黑字。纱用这套主题的纸色，所以**没传图时看不出任何变化**。
   ============================================================ */
(function () {
  if (!window.API) return;
  const st = {
    loaded: false, ok: false, err: '',
    global: { has: false, mode: 'cover', at: 0 },
    book: { has: false, mode: 'cover', at: 0 },
    scope: 'global',                 // 界面上"看的是哪一档"（不是生效档；首次加载会跟生效档对齐）
    pxKey: '', px: null,              // 采样过的图（换图才重量）
    touched: false,                  // 用户点过页签没有（点过就不再自动改他选的档）
    busy: false,
  };
  const root = document.documentElement;
  const slugNow = () => (window.BookCtx && BookCtx.slug ? (BookCtx.slug() || '') : '');

  /* 生效档：这本书传过就用这本书的，否则落到"所有书默认"（跟全站"这本书 / 所有书"一个口径） */
  function eff() {
    return st.book.has ? Object.assign({ scope: 'book' }, st.book)
                       : Object.assign({ scope: 'global' }, st.global);
  }

  /* ── 地址必须先在 JS 里变成**绝对地址**（第 44 轮实测踩到的真坑）───────────
     用户原话：「切换整个前端的背景图是无用的」。
     `--userbg` 是**内联**声明在 `html` 上的，却**在 css/decor.css 里被 background-image 引用**；
     按 CSS 规范，相对地址是对着**"引用它的那张样式表"**解析的 —— 浏览器实测把
     `api/appearance/bg/file?…` 解析成了 `http://<host>/css/api/appearance/bg/file?…`
     （`/css/…` → **404**；`/api/…` → 401 = 接口本身在）。
     于是接口 200、CSS 里 7 层都在、**屏幕上却一张像素都没有** —— 用户看到的就是"传了跟没传一样"。
     一律 `new URL(u, document.baseURI)` 转成绝对地址：谁来解析都一样。 */
  const absUrl = (u) => {
    try { return new URL(String(u), document.baseURI).href; } catch (e) { return String(u); }
  };

  /* ── 纱的浓淡：由"用户那张图有多亮"决定（有图才用）────────────────────────
     为什么要有纱：图是用户自己的，可能是全黑、可能是亮白。正文墨色（--ink / --ink-2）是固定的，
     底一变，字就可能压不住。所以：
       · 亮图 → 纱薄（图看得见；底仍然够亮，墨色照样够对比）
       · 暗图 → 纱厚（不然整屏发黑，字直接没了；也保住"这是一张纸"的观感）
     厚度怎么算（**可复核，不是拍脑袋**）：把图缩到 24×24 读回像素，按亮度排序取
     第 10 / 90 百分位当"暗角/亮角"两个代表（不看单个像素 —— 一个黑点不该把整张图的纱拉满），
     从 0.04 往上试，取第一条能让**两个代表**同时满足"墨色 ≥4.5:1、次要墨色 ≥3:1"的值；
     再跟"越暗越厚"的美观下限取大的。读不到像素（跨源被拦）就退回保守值：图照样看得见。 */
  const lumOf = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const contrastOf = (a, b) => { const x = Math.max(a, b), y = Math.min(a, b); return (x + 0.05) / (y + 0.05); };
  const rgbOf = (v, dflt) => {
    const m = String(v || '').match(/(\d+)\D+(\d+)\D+(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : dflt;
  };
  const cssVar = (name) => getComputedStyle(root).getPropertyValue(name).trim();

  /** 采样一张图（返回一堆 RGB），失败返回 null（调用方退保守值）。 */
  async function samplePixels(url) {
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const bmp = await createImageBitmap(blob);
    const n = 24;
    const cv = document.createElement('canvas'); cv.width = n; cv.height = n;
    const cx = cv.getContext('2d');
    cx.drawImage(bmp, 0, 0, n, n);
    const d = cx.getImageData(0, 0, n, n).data;
    const px = [];
    for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
    return px;
  }

  /** 该用多厚的纱。读不到像素时返回保守值（仍然看得见图）。 */
  function veilAlpha(px) {
    const paper = rgbOf(cssVar('--paper'), [243, 234, 217]);
    const dark = lumOf(paper) < 0.2;                  // 夜间：纸本身就是暗的
    const lo = dark ? 0.55 : 0.18, hi = dark ? 0.86 : 0.66;   // 这一套主题的纱的上下限
    if (!px || !px.length) return dark ? 0.72 : 0.34;          // 读不到：保守，但图还看得见
    /* ★ 第 45 轮：**三个层级的墨色都要算**（原来只算 ink / ink-2）。
       实测教训：13px 的次要小字用的是 `--ink-3`（#756753），比 ink-2 淡一档，
       按 ink-2 算出来的纱在纯黑图上只有 **1.97:1**（判据 tools/check_userbg.py 报红 4 屏）。
       门槛对着"这号字真实会用在哪一档"：ink ≥4.5:1（正文）、ink-2 / ink-3 ≥3.4:1
       （小字下限是 3.0，留 0.4 的余量给像素取色的误差，别卡在临界线上来回红绿）。 */
    const ink = rgbOf(cssVar('--ink'), [58, 48, 32]);
    const ink2 = rgbOf(cssVar('--ink-2'), [107, 92, 71]);
    const ink3 = rgbOf(cssVar('--ink-3'), [117, 103, 83]);
    const sorted = px.slice().sort((a, b) => lumOf(a) - lumOf(b));
    const pick = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
    const reps = [pick(0.10), pick(0.90)];
    const mean = px.reduce((t, c) => t + lumOf(c), 0) / px.length;
    /* 要让墨色压得住，纱至少得多厚 */
    let need = 0.9;
    for (let a = 0.04; a <= 0.9; a += 0.02) {
      const ok = reps.every((s) => {
        const c = [0, 1, 2].map((i) => a * paper[i] + (1 - a) * s[i]);
        const lc = lumOf(c);
        return contrastOf(lc, lumOf(ink)) >= 4.5
            && contrastOf(lc, lumOf(ink2)) >= 3.4
            && contrastOf(lc, lumOf(ink3)) >= 3.4;
      });
      if (ok) { need = a; break; }
    }
    /* 美观下限：越暗的图，纱越厚（不然整屏发黑、像夜间模式） */
    const base = (dark ? 0.62 : 0.46) - 0.30 * mean;
    /* ★ 第 45 轮修：`need`（"字压得住"那条硬要求）**不许**再被美观上限 hi 砍掉。
       实测（tools/check_userbg.py，纯黑图那一批）：以前被 0.66 砍到 0.66，
       结果 13px 次要小字压在纱上只有 **1.97:1**（基线没铺图时 4.55:1）——
       用户说的"看不清"就是这么来的。美观只在"字压得住"的前提下才有资格说话。
       硬顶 0.92：全黑图最多也就是把图压到几乎只剩一点点影子，字必须清楚。 */
    return Math.max(lo, Math.min(0.92, Math.max(need, Math.min(hi, base))));
  }

  /** 把当前生效的图铺到七屏上（阅读器不铺）。 */
  function apply() {
    const e = eff();
    if (!e.has) {
      root.style.removeProperty('--userbg');
      root.style.removeProperty('--userbg-veil');
      root.classList.remove('ubg-cover', 'ubg-tile', 'ubg-center');
      st.imgKey = '';
      return;
    }
    const url = absUrl(API.media('api/appearance/bg/file?' + API.qs({
      scope: e.scope, slug: e.scope === 'book' ? slugNow() : '',
      /* 换图之后文件名会变，这一串只是再保险一层（有的 WebView 缓存很倔） */
      v: e.updatedAt || e.at || 0,
    })));
    /* 地址里可能出现引号/空格（文件名、口令），包一层 url("…") 并转义 */
    root.style.setProperty('--userbg', 'url("' + String(url).replace(/"/g, '%22') + '")');
    /* 纱：正好是这套主题的纸色（见 tokens.css 的 --paper）。它画在上面、图在下面。
       `window.__UBG_NOVEIL = 1` 是**自测用的反证开关**：把纱关掉 → 全黑图上正文就该看不清，
       `tools/e2e-userbg.js` 的丙2 必须因此报红（判据自己要先能红，绿了才算数）。 */
    if (!window.__UBG_NOVEIL) {
      const px = st.px && st.px.key === url ? st.px.px : null;
      const a = veilAlpha(px);
      const p = rgbOf(cssVar('--paper'), [243, 234, 217]);
      root.style.setProperty('--userbg-veil',
        'linear-gradient(rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + a.toFixed(2) + '),'
        + 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + a.toFixed(2) + '))');
      /* 采样是异步的：先按保守值画出来，量完再按这张图调一次（用户不会看到闪一下白）。 */
      if (st.pxKey !== url) {
        st.pxKey = url;
        samplePixels(url).then((p2) => {
          st.px = { key: url, px: p2 };
          if (eff().has && st.pxKey === url) apply();
        }).catch(() => { st.px = { key: url, px: null }; });
      }
    } else {
      root.style.removeProperty('--userbg-veil');
    }
    root.classList.remove('ubg-cover', 'ubg-tile', 'ubg-center');
    root.classList.add('ubg-' + (e.mode || 'cover'));
  }

  async function load(force) {
    if (st.busy && !force) return st;
    st.busy = true;
    try {
      const d = await API.nb('api/appearance/bg?' + API.qs({ slug: slugNow() }));
      st.global = d.global || st.global;
      st.book = d.book || st.book;
      /* 头一次进来：界面上盯着的档 = **真正生效的那一档**（这本书传过就是这本书，
         否则是"所有书默认"）—— 不然用户会以为自己传的图丢了。之后用户点过页签就不再动他。 */
      if (!st.touched) st.scope = (d.book && d.book.has) ? 'book' : 'global';
      st.err = ''; st.ok = true;
    } catch (e) {
      st.err = e && e.message ? e.message : String(e);
      st.ok = false;
    } finally {
      st.busy = false; st.loaded = true;
    }
    apply();
    return st;
  }

  /** 界面上现在盯着哪一档（默认盯着"生效的那一档"，用户点了页签才变）。 */
  const view = () => (st.scope === 'book' ? st.book : st.global);

  function pickFile(cb) {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.id = 'ubg-file';        // 给自测（CDP 塞文件）用的固定 id
    inp.accept = 'image/jpeg,image/png,image/webp,image/gif';
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.addEventListener('change', () => {
      const f = inp.files && inp.files[0];
      inp.remove();
      if (f) cb(f);
    });
    inp.click();
  }

  async function upload(file) {
    const scope = st.scope;
    if (scope === 'book' && !slugNow()) { App.toast('先在书架选一本书'); return; }
    if (file.size > 8 * 1024 * 1024) { App.toast('图太大（超过 8MB），先压一压再传'); return; }
    const fd = new FormData();
    fd.append('file', file);
    fd.append('scope', scope);
    fd.append('slug', scope === 'book' ? slugNow() : '');
    fd.append('mode', view().mode || 'cover');
    App.toast('正在上传…');
    try {
      /* 走 API.abs()：跨源/带口令这件事只有它知道（前端自己拼地址踩过 404 的坑） */
      const r = await fetch(API.abs('api/appearance/bg'), {
        method: 'POST', body: fd, credentials: 'include',
        headers: API.token() ? { 'x-token': API.token() } : {},
      });
      const txt = await r.text();
      let d = null; try { d = txt ? JSON.parse(txt) : null; } catch (e) { d = null; }
      if (!r.ok) throw new Error((d && (d.detail || d.message)) || ('上传失败（HTTP ' + r.status + '）'));
      App.toast('换好了');
      await load(true);
      rerender();
    } catch (e) {
      App.toast('传不上去：' + (e && e.message ? e.message : e));
    }
  }

  async function remove() {
    const scope = st.scope;
    try {
      await API.nb('api/appearance/bg?' + API.qs({
        scope, slug: scope === 'book' ? slugNow() : '' }), { method: 'DELETE' });
      App.toast(scope === 'book' ? '这本书还原成默认底' : '还原成默认底');
      await load(true);
      rerender();
    } catch (e) { App.toast('移除失败：' + (e && e.message ? e.message : e)); }
  }

  async function setMode(mode) {
    const scope = st.scope;
    if (!view().has) { App.toast('先传一张图再挑铺法'); return; }
    try {
      await API.nb('api/appearance/bg/mode', { method: 'POST', body: { scope, slug: scope === 'book' ? slugNow() : '', mode } });
      await load(true);
      rerender();
    } catch (e) { App.toast('改不了：' + (e && e.message ? e.message : e)); }
  }

  /* 设置页每次重画都调它（上传完要立刻看到新图、状态字立刻变） */
  function rerender() {
    if (!window.Settings) return;
    if (document.body.dataset.tab !== 'settings') return;   // 人不在设置页就别白画
    try { Settings.onShow(); } catch (e) {}
  }

  const MODE_LABEL = { cover: '铺满', tile: '平铺', center: '居中' };

  /** 大设置「背景」那一组。**只吐 HTML**，事件在 wire() 里绑。 */
  function settingsHtml() {
    const e = eff();
    const v = view();
    const seg = (key, items, cur) => '<div class="seg" data-ubg="' + key + '">' + items.map(([x, l]) =>
      '<button data-v="' + x + '" class="' + (String(cur) === x ? 'on ' : '') + (key === 'scope' ? 'wide' : '') + '">' + l + '</button>').join('') + '</div>';
    const where = e.scope === 'book' ? '这本书自己的' : '所有书默认的';
    const state = !e.has ? '<span class="ubg-none">现在用的是默认纸纹</span>'
      : '<span class="ubg-on">正在用' + where + '一张图（' + (MODE_LABEL[e.mode] || '铺满') + '）</span>';
    return '<h3>背景</h3><div class="settings-group">'
      + '<div class="settings-row stack"><span class="k">自定义背景图<small>用自己的图换掉默认纸纹 · 正文页保持干净</small></span>'
      + '<div class="ubg-prev' + (v.has ? ' has' : '') + '" id="ubg-prev"></div>'
      + '<div class="ubg-state">' + state + (st.err ? '<span class="ubg-err">（读不到：' + st.err + '）</span>' : '') + '</div>'
      + '<div class="ubg-acts">'
      + '<button class="btn sm" id="ubg-up">' + (v.has ? '换一张' : '上传图片') + '</button>'
      + (v.has ? '<button class="btn sm btn-ghost" id="ubg-del">移除</button>' : '')
      + '</div></div>'
      + '<div class="settings-row"><span class="k">铺法</span>' + seg('mode', [['cover', '铺满'], ['tile', '平铺'], ['center', '居中']], v.mode) + '</div>'
      + '<div class="settings-row"><span class="k">用在哪儿<small>跟"所有书默认 / 这本书"一个口径</small></span>' + seg('scope', [['global', '所有书默认'], ['book', '这本书']], st.scope) + '</div>'
      + '</div>';
  }

  /** 绑定这一组的交互。`root` 是设置页的容器。 */
  function wire(host) {
    if (!host || !host.querySelector) return;
    const prev = host.querySelector('#ubg-prev');
    if (prev && view().has) {
      const v = view();
      prev.style.backgroundImage = 'url("' + absUrl(API.media('api/appearance/bg/file?' + API.qs({
        scope: st.scope, slug: st.scope === 'book' ? slugNow() : '', v: v.updatedAt || v.at || 0,
      }))).replace(/"/g, '%22') + '")';
    }
    const up = host.querySelector('#ubg-up');
    if (up) up.addEventListener('click', () => pickFile(upload));
    const del = host.querySelector('#ubg-del');
    if (del) del.addEventListener('click', remove);
    host.querySelectorAll('[data-ubg]').forEach((s) => {
      s.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]'); if (!b) return;
        if (s.dataset.ubg === 'scope') { st.scope = b.dataset.v; st.touched = true; rerender(); return; }
        setMode(b.dataset.v);
      });
    });
  }

  window.Appearance = {
    load, apply, settingsHtml, wire,
    state: () => st,
    /* 给自测脚本用：当前铺在屏上的到底是什么（不猜，直接读 DOM 上真挂着的值） */
    debug: () => ({ has: eff().has, scope: eff().scope, mode: eff().mode,
                    url: root.style.getPropertyValue('--userbg'),
                    veil: root.style.getPropertyValue('--userbg-veil'),
                    cls: root.className.split(/\s+/).filter((x) => x.startsWith('ubg-')) }),
  };

  /* 换书 / 登录回来之后重读一遍：单本的图跟书走 */
  if (window.BookCtx && BookCtx.onChange) BookCtx.onChange(() => { load(true); });
})();
