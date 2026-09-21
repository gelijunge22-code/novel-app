/* ============================================================
   e2e-storyline.js — 「故事线」工具 = 大纲（第 36 轮）

   用户原话（一字不改）：
     「我是想把**故事线**这个技能**在不改名字的情况下，把它的用处改成大纲**，
       它是用来放大纲的，所以**点击这个故事线之后，它里面的前端和后端都要重做**，
       **就相当于删除了，把这个功能换成大纲**」

   所以这一轮判据要盯死三件事：
     ① 点「故事线」出来的是**大纲**（能加、能改、能删、看得见"谁定的"）——
        不是原来那份"一章一句话"；
     ② **一份实现两个入口**：「故事线」和「剧情」工具的「剧情线」页签用的是同一块
        （js/outline.js）。studio.js 里那套一模一样的旧 markup 必须**没有了**；
     ③ 原来那份「章节速览」**没丢**（只收进折叠区），点开还能改一句话、还能点进那一章。

   判据（甲~己，每条都能报红）：
     甲 点工具卡「故事线」→ 屏幕上是大纲（有「加一条」/筛选/统计），旧列表默认不占屏
     乙 加一条 → 列表里出现、蓝徽标写着「你定的」、**后端库里真有这条**（真读接口核对）
     丙 改一条 → 界面和后端**都是新版**（旧版一个字不许留）
     丁 章节速览：折叠区点开 → 行数 = 章节数；改一句话 → 存住（GET /api/storyline 里 mine=true）
     戊 手机友好：热区 ≥44 / 大纲正文**不许被切**（scrollWidth ≤ clientWidth）/ 页面不横滚 / 面板不是 0 高
     己 两个入口一份实现：studio.js 里那段重复 markup 已消失 + 「剧情」页签也是 .ol-* 那套

   跑法：
     node tools/e2e-storyline.js                       # 正常，全绿
     STORY_FORCE=old      node tools/e2e-storyline.js  # 反证：故事线指回旧的"一章一句话" → 甲 红
     STORY_FORCE=nobadge  node tools/e2e-storyline.js  # 反证：不显示"谁定的" → 乙 红
     STORY_FORCE=nosave   node tools/e2e-storyline.js  # 反证：保存不落库 → 乙/丙 红
     STORY_FORCE=dblimpl  node tools/e2e-storyline.js  # 反证：伪造"两套并存"给静态检查看 → 己 红
   产出：docs/故事线实测.json（反证写 -反证-<FORCE>.json）
   数据：只在**自己建的临时书**上动，跑完连书带章节删干净（并在报告里核对"真没了"）。
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { open, sleep } = require('./cdp');
const { readPassword, shieldOnly } = require('./preflight');

const ROOT = '/home/ubuntu/novel-app';
const FORCE = process.env.STORY_FORCE || '';
const OUT = path.join(ROOT, 'docs', FORCE ? ('故事线实测-反证-' + FORCE + '.json') : '故事线实测.json');
const PW = readPassword();
const STAMP = String(Date.now()).slice(-6);
const SCRATCH = 'zz-故事线自测-' + STAMP;
const NAME = '复仇主线（判据造）';
const V1 = '开局先活下来：雪夜之后躲进村子';
const V2 = '改过的大纲：先离开村子，再去州城找线索';

(async () => {
  await shieldOnly('e2e-storyline.js');
  const s = await open({ port: 9394, width: 390, height: 844, settle: 1200 });
  const fails = [];
  const steps = [];
  const step = (name, ok, info) => {
    steps.push({ name, ok: !!ok, info: info === undefined ? null : info });
    if (ok) console.log('  ✓ ' + name);
    else { console.log('  ✗ ' + name + '  ' + JSON.stringify(info === undefined ? null : info).slice(0, 300)); fails.push(name); }
  };
  const api = (url, opts) => s.js(`(async () => {
    try { const r = await fetch(${JSON.stringify(url)}, ${JSON.stringify(opts || {})});
      return { status: r.status, body: await r.text() }; }
    catch (e) { return { status: 0, body: String(e && e.message || e) }; } })()`);
  const jpost = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body) });

  let slug = '', cleanup = '';
  try {
    await s.nav('http://127.0.0.1:8899/'); await sleep(2600);
    await s.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:${JSON.stringify(PW)}})}).then(r=>r.text())`);
    await s.nav('http://127.0.0.1:8899/'); await sleep(3800);

    /* ── 临时书（判据自己用，跑完删干净） ── */
    const cb = await jpost('/api/book', { title: SCRATCH });
    slug = (JSON.parse(cb.body || '{}') || {}).slug || '';
    if (!slug) throw new Error('临时书建不起来：HTTP ' + cb.status + ' ' + String(cb.body).slice(0, 120));
    console.log('  临时书：' + slug);
    await jpost('/api/chapter/new', { slug, path: 'manuscript/第001章-雪夜.md', content: '# 第001章 雪夜\n\n他在雪里捡到一枚断刃。\n' });
    await jpost('/api/chapter/new', { slug, path: 'manuscript/第002章-进城.md', content: '# 第002章 进城\n\n城门被拦了下来。\n' });
    await s.js(`(() => { if (window.BookCtx) BookCtx.set(${JSON.stringify(slug)}, ${JSON.stringify(SCRATCH)}); return 1; })()`);

    /* ── 反证钩子（都在测试侧；产品代码只有一个 __NB_STORY_FORCE=nobadge） ── */
    if (FORCE === 'old') {
      await s.js(`(() => { const t = Tools.TOOLS.find((x) => x.id === 'story');
        t.run = (h) => { h.innerHTML = '<div class="t-hint">一章一句话（旧）</div><div class="t-list"><div class="t-row static"><div class="tr-main"><div class="tr-title">第001章</div></div></div></div>'; };
        return 1; })()`);
    }
    if (FORCE === 'nobadge') await s.js("(() => { window.__NB_STORY_FORCE = 'nobadge'; return 1; })()");
    if (FORCE === 'nosave') {
      await s.js(`(() => { const raw = API.nb;
        API.nb = function (p, o) { if (String(p).indexOf('/api/plot/thread') >= 0) return Promise.resolve({}); return raw.apply(this, arguments); };
        return 1; })()`);
    }

    /* ══════ 甲：点「故事线」出来的是大纲 ══════ */
    await s.js("(() => { App.show('tools'); return 1; })()"); await sleep(1200);
    const cardInfo = await s.js(`(() => {
      const c = document.querySelector('.tool-card[data-id="story"]');
      return c ? { name: (c.querySelector('.tc-name')||{}).textContent, sub: (c.querySelector('.tc-sub')||{}).textContent } : null; })()`);
    step('甲1 工具宫格里那个工具还叫「故事线」（名字一个字不许改），说明文字是大纲的说法',
      cardInfo && cardInfo.name === '故事线' && /大纲/.test(cardInfo.sub || ''), cardInfo);
    await s.js(`(() => { const c = document.querySelector('.tool-card[data-id="story"]'); if (c) c.click(); return 1; })()`);
    await sleep(2200);
    const A = await s.js(`(() => {
      const body = document.getElementById('tool-body') || document.createElement('div');
      const acc = body.querySelector('details.acc');
      return {
        title: (document.getElementById('tool-title') || {}).textContent || '',
        add: !!body.querySelector('[data-olnew]'),
        chips: body.querySelectorAll('[data-olfilter]').length,
        rows: body.querySelectorAll('.ol-row').length,
        stat: !!body.querySelector('.ol-stat'),
        oldVisible: !!(acc && acc.open && acc.querySelector('.al-list')),
        accClosed: !!acc && !acc.open,
        tip: (body.querySelector('.t-hint') || {}).textContent || '',
      }; })()`);
    step('甲2 点开后是**大纲**：有「加一条」+ 筛选 + 统计',
      A.add && A.chips === 3 && A.stat, A);
    step('甲3 标题是「故事线」，且旧的那份"一章一句话"默认不占屏（收进折叠区）',
      A.title.indexOf('故事线') >= 0 && A.oldVisible === false && A.accClosed, A);
    step('甲4 页面把"你改的以你为准、AI 不覆盖"写在明面上',
      /以你为准|不会自己覆盖|不许覆盖/.test(A.tip), A.tip.slice(0, 60));

    /* ══════ 乙：加一条（界面 → 后端真落库） ══════ */
    await s.js("(() => { const b = document.querySelector('[data-olnew]'); if (b) b.click(); return 1; })()"); await sleep(900);
    const formOk = await s.js(`(() => { const d = document.querySelector('.t-dialog');
      const ins = d ? d.querySelectorAll('.t-input,.t-area') : [];
      return { dlg: !!d, n: ins.length }; })()`);
    step('乙1 「加一条」弹出的是全站同一个表单（App.form，两个字段）', formOk.dlg && formOk.n === 2, formOk);
    await s.js(`(() => { const d = document.querySelector('.t-dialog');
      if (!d) return 0;
      const b = d.querySelectorAll('.t-input,.t-area'); if (b.length < 2) return 0;
      b[0].value = ${JSON.stringify(NAME)};
      b[1].value = ${JSON.stringify(V1)};
      d.querySelector('[data-yes]').click(); return 1; })()`);
    await sleep(1800);
    const B = await s.js(`(() => {
      const body = document.getElementById('tool-body') || document.createElement('div');
      const row = [...body.querySelectorAll('.ol-row')].find((r) => (r.querySelector('.tr-title')||{}).textContent.indexOf(${JSON.stringify(NAME)}) >= 0);
      return { rows: body.querySelectorAll('.ol-row').length,
               found: !!row,
               badge: row ? (row.querySelector('.t-pill')||{}).textContent : '',
               sum: row ? (row.querySelector('.ol-sum')||{}).textContent : '',
               mineCount: (body.querySelector('.ol-stat')||{}).textContent || '' }; })()`);
    step('乙2 加完立刻出现在列表里，徽标写着「你定的」', B.found && /你定的/.test(B.badge), B);
    step('乙3 这条线写了什么，在列表上换行显示（不截断）', B.sum.indexOf('开局先活下来') >= 0, B);
    const ov1 = await api('/api/plot/overview?slug=' + encodeURIComponent(slug));
    const th1 = (JSON.parse(ov1.body || '{}').threads || []).filter((t) => t.name === NAME);
    step('乙4 **后端库里真有这条**（不是你只改了界面）',
      th1.length === 1 && th1[0].summary === V1 && th1[0].origin === 'user', th1);

    /* ══════ 丙：改一条（用户改的以用户为准） ══════ */
    await s.js(`(() => { const b = [...document.querySelectorAll('[data-oledit]')]
      .find((x) => x.closest('.ol-row').textContent.indexOf(${JSON.stringify(NAME)}) >= 0); if (b) b.click(); return 1; })()`);
    await sleep(900);
    const pre = await s.js(`(() => { const d = document.querySelector('.t-dialog');
      const b = d ? d.querySelectorAll('.t-input,.t-area') : [];
      return { v0: b[0] ? b[0].value : '', v1: b[1] ? b[1].value : '' }; })()`);
    step('丙1 「改」弹出来的是**现有内容**（不是空表单）', pre.v0 === NAME && pre.v1 === V1, pre);
    await s.js(`(() => { const d = document.querySelector('.t-dialog');
      if (!d) return 0;
      const b = d.querySelectorAll('.t-input,.t-area'); if (b.length < 2) return 0;
      b[1].value = ${JSON.stringify(V2)};
      d.querySelector('[data-yes]').click(); return 1; })()`);
    await sleep(1800);
    const C = await s.js(`(() => { const body = document.getElementById('tool-body') || document.createElement('div');
      const row = [...body.querySelectorAll('.ol-row')].find((r) => r.textContent.indexOf(${JSON.stringify(NAME)}) >= 0);
      return { sum: row ? (row.querySelector('.ol-sum')||{}).textContent : '', rows: body.querySelectorAll('.ol-row').length }; })()`);
    step('丙2 改完界面显示的是新版（旧版不出现在这一行）',
      C.sum.indexOf('先离开村子') >= 0 && C.sum.indexOf('躲进村子') < 0, C);
    const ov2 = await api('/api/plot/overview?slug=' + encodeURIComponent(slug));
    const th2 = (JSON.parse(ov2.body || '{}').threads || []).filter((t) => t.name === NAME);
    step('丙3 后端也是新版，而且这条**算用户定的**（AI 不许覆盖）',
      th2.length === 1 && th2[0].summary === V2 && th2[0].origin === 'user', th2);

    /* ══════ 丁：章节速览没丢（收在折叠区里） ══════ */
    const sl0 = await api('/api/storyline?slug=' + encodeURIComponent(slug));
    const nch = (((JSON.parse(sl0.body || '{}').items) || []).length);
    await s.js("(() => { const acc = document.querySelector('#tool-body details.acc'); if (acc) { acc.open = true; acc.dispatchEvent(new Event('toggle')); } return 1; })()");
    await sleep(1800);
    const D = await s.js(`(() => { const acc = document.querySelector('#tool-body details.acc');
      if (!acc) return { rows: 0, hasEdit: 0, accOpen: false, bodyGap: false };
      return { rows: acc.querySelectorAll('.al-row').length,
               hasEdit: acc.querySelectorAll('[data-edit]').length,
               accOpen: acc.open,
               bodyGap: !!acc.querySelector('.acc-body').textContent.trim() }; })()`);
    step('丁1 折叠区点开后，一行一章（行数 = 章节数），每行都能改"一句话"',
      D.accOpen && nch > 0 && D.rows === nch && D.hasEdit === nch, { 行数: D.rows, 章节数: nch, 可改: D.hasEdit });
    const clickEdit = await s.js(`(() => { const b = document.querySelector('#tool-body details.acc [data-edit]'); if (!b) return 0; b.click(); return 1; })()`);
    step('丁2 每行那句话点得开（弹的是全站同一个输入弹层）', clickEdit === 1, clickEdit);
    await sleep(700);
    await s.js(`(() => { const d = document.querySelector('.t-dialog');
      if (!d) return 0; const b = d.querySelector('.t-input,.t-area'); if (!b) return 0;
      b.value = '雪夜捡到断刃'; d.querySelector('[data-yes]').click(); return 1; })()`);
    await sleep(1600);
    const sl = await api('/api/storyline?slug=' + encodeURIComponent(slug));
    const it = ((JSON.parse(sl.body || '{}').items) || [])[0] || {};
    step('丁3 一句话存得住（GET /api/storyline 里是"我写的"，不是自动摘要）',
      String(it.summary || '') === '雪夜捡到断刃' && it.mine === true, it);

    /* ══════ 戊：手机上好用（热区 / 不被切 / 不横滚） ══════ */
    const E = await s.js(`(() => {
      const body = document.getElementById('tool-body') || document.createElement('div');
      const hot = [];
      body.querySelectorAll('button, summary, [data-olnew], [data-oledit], [data-olfilter]').forEach((el) => {
        const r = el.getBoundingClientRect();
        let w = r.width, h = r.height;
        try { const ps = getComputedStyle(el, '::after');
          if (ps && ps.position === 'absolute' && ps.content && ps.content !== 'none') {
            const px = (v) => (v && v.endsWith('px') ? parseFloat(v) : 0);
            if (px(ps.left) < 0) w += -px(ps.left); if (px(ps.right) < 0) w += -px(ps.right);
            if (px(ps.top) < 0) h += -px(ps.top);  if (px(ps.bottom) < 0) h += -px(ps.bottom);
          } } catch (e) {}
        if (w < 44 || h < 44) hot.push({ c: el.className, w: Math.round(w), h: Math.round(h), t: (el.textContent||'').slice(0,10) });
      });
      const cut = [];
      body.querySelectorAll('.ol-sum,.tr-title,.tr-sub,.acc-n').forEach((el) => {
        if (!el.offsetParent) return;
        if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
          cut.push({ c: el.className, sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight, t: (el.textContent || '').slice(0, 16) });
        }
      });
      return { hot, cut,
        over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        h: Math.round(body.getBoundingClientRect().height) }; })()`);
    step('戊1 这一页上的东西热区都 ≥44×44', E.hot.length === 0, E.hot);
    step('戊2 大纲正文与标题**一个字都没被切**（横向纵向都不许 scroll > client）', E.cut.length === 0, E.cut);
    step('戊3 页面不横滚，面板高度不是 0', E.over <= 1 && E.h > 200, { over: E.over, h: E.h });

    /* ══════ 己：一份实现两个入口 ══════ */
    const studioSrc = (() => { try { return fs.readFileSync(path.join(ROOT, 'frontend/js/studio.js'), 'utf8'); } catch (e) { return ''; } })();
    const oldMark = ['data-newth', 'data-editth', 'data-rmth'];
    let srcNow = studioSrc;
    /* 反证：伪造一份"两套并存"的源码喂给同一条静态判据 —— 它必须报红 */
    if (FORCE === 'dblimpl') srcNow += "\n<div data-newth>加一条</div><div data-editth>改</div>\n";
    const left = oldMark.filter((m) => srcNow.indexOf(m) >= 0);
    step('己1 studio.js 里**旧那套重复 markup 已经没有了**（只剩一份实现）',
      left.length === 0 && /Outline\.mount/.test(srcNow), { 残留: left, 用了共用实现: /Outline\.mount/.test(srcNow) });
    await s.js("(() => { Tools.open('plot'); return 1; })()"); await sleep(2500);
    await s.js(`(() => { const b = [...document.querySelectorAll('#tool-body [data-tabs] button')]
      .find((x) => x.dataset.tab === 'threads'); if (b) b.click(); return 1; })()`);
    await sleep(2000);
    const F = await s.js(`(() => { const body = document.getElementById('tool-body') || document.createElement('div');
      return { add: !!body.querySelector('[data-olnew]'),
               chips: body.querySelectorAll('[data-olfilter]').length,
               olRows: body.querySelectorAll('.ol-row').length,
               tip: !!(body.querySelector('.t-hint') || {}).textContent }; })()`);
    /* 认的是"这一块是大纲那套实现"（加一条 + 三档筛选都在），不拿"有没条目"当判据 ——
       否则"没条目"这种正常情况会被算成红（假红比漏报更坏）。 */
    step('己2 「剧情」工具的「剧情线」页签出来的是**同一块大纲**（.ol-* 那套）',
      F.add && F.chips === 3 && F.tip, F);

    /* ── 收尾：把临时书连同章节删干净，并核对"真没了" ── */
    await s.js(`(() => { if (window.BookCtx) BookCtx.set('', ''); return 1; })()`);
    const db = await jpost('/api/book/delete', { slug: slug });
    const shelf = await api('/api/shelf');
    const still = ((JSON.parse(shelf.body || '{}').projects) || []).some((b) => b.slug === slug);
    const onDisk = fs.existsSync(path.join(ROOT, 'data/books', slug));
    cleanup = (!still && !onDisk) ? '已删净' : ('没删干净！书架还在=' + still + ' 盘上还在=' + onDisk);
    step('收尾 临时书连章节一起删干净（书架 + 磁盘都核对过）',
      !still && !onDisk && db.status === 200, { http: db.status, still, onDisk });
  } catch (e) {
    fails.push('脚本自己出错：' + (e && e.message));
    console.log('  ✗ 脚本自己出错：' + (e && e.message));
  } finally {
    /* 兜底清理：中途炸了也要把临时书删掉。
       （不这么做的话，一次崩溃会留下一本自测书 → 下一次跑被 preflight 挡住 = **假红**，
         第 36 轮第一次跑反证就踩了这个。） */
    try {
      if (slug) {
        const again = await jpost('/api/book/delete', { slug: slug });
        const left = fs.existsSync(path.join(ROOT, 'data/books', slug));
        if (left) { cleanup = '兜底清理失败：盘上还在 ' + slug; fails.push(cleanup); }
        else if (!cleanup) cleanup = '已删净（兜底清理，HTTP ' + again.status + '）';
      }
    } catch (e2) { console.log('  ⚠ 兜底清理没跑成：' + (e2 && e2.message)); }
  }

  const errs = s.errors();
  if (errs.length) { fails.push('页面里有 JS 报错 ' + errs.length + ' 条：' + errs.slice(0, 3).join(' | ')); }
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), force: FORCE || '（正常）',
    book: slug, cleanup, steps, bad: fails, errors: errs }, null, 1));
  console.log('\n' + (fails.length ? ('报了 ' + fails.length + ' 条红 ❌ ' + fails.join('；')) : '全过 ✅'));
  console.log('→ ' + path.relative(ROOT, OUT));
  s.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
