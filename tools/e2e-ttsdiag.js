/* ============================================================
   e2e-ttsdiag.js — 「听书自检」的实机判据（用户今天最生气的一条）

   用户原话：「App 里听书**从来没有出过声音**」。
   监督人实测：服务器侧全通（合成成功 / 接口 200 / 公网反代也通）→
   **问题在 App 端，而且失败是静默的**（play() 只处理 NotAllowedError、
   error 事件只有两句笼统 toast、readyState/error.code 没人看）。

   这一条判据管的就是"**哑巴失败有没有变成看得见**"：
     甲 正常时：自检逐项通过，且每项都摆出**真数值**（HTTP 码 / 类型 / 字节数 / error.code…）
     乙 地址指错（连不上）→ 报"服务器这一环没通"，带 HTTP/连接错误
     丙 音频地址坏（404）→ 报"取音频这一步 HTTP 404"，带地址尾巴
     丁 章节不存在（404）→ 报"这一章读不到"，带 404 与原因
     戊 口令过期（401）→ 报 401（不是"没内容"这种误导说法）
     己 四种坏法**各自报红、且原因两两不同**（不许都说一句"失败"糊过去）

   跑法：
     node tools/e2e-ttsdiag.js                          # 正常
     TTSD_FORCE=silent node tools/e2e-ttsdiag.js        # 反证：把静默失败改回去 → 乙~戊 必须红
     TTSD_FORCE=nochain node tools/e2e-ttsdiag.js       # 反证：自检不报"卡在哪一步" → 丁/己 必须红
     TTSD_FORCE=noabort node tools/e2e-ttsdiag.js       # 反证：被冻结打断时静默（老行为）→ 辛 必须红
     TTSD_FORCE=nogesture node tools/e2e-ttsdiag.js     # 反证：去掉点击同步解锁 → 庚 必须红

   庚 / 甲2 都是**真人点击**（CDP Input.dispatchMouseEvent，见 tools/cdp.js 的 clickSel）——
   `el.click()` 是 JS 调用，浏览器不给用户手势，自动播放被拦这类问题就永远测不出来。
   产出：docs/听书自检实测.json（反证写 -反证-<FORCE>.json）
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { open, sleep } = require('./cdp');
const { readPassword } = require('./preflight');

const ROOT = '/home/ubuntu/novel-app';
const FORCE = process.env.TTSD_FORCE || '';
const OUT = path.join(ROOT, 'docs', FORCE ? ('听书自检实测-反证-' + FORCE + '.json')
  : '听书自检实测.json');

(async () => {
  const s = await open({ port: 9391 });
  const fails = [];
  const steps = [];
  const bad = (m) => { fails.push(m); console.log('  ✗ ' + m); };
  const good = (m) => console.log('  ✓ ' + m);

  await s.nav('file://' + ROOT + '/apk/assets/www/index.html');
  await sleep(1500);
  await s.js("(()=>{const i=document.getElementById('login-pass');i.value=" +
    JSON.stringify(readPassword()) +
    ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
  await sleep(1600);
  const sp = await s.js(`(async () => { for (let i = 0; i < 90; i++) {
      const e = document.getElementById('splash');
      if (!e || e.classList.contains('gone') || getComputedStyle(e).display === 'none') return true;
      await new Promise((r) => setTimeout(r, 100)); } return false; })()`, 45000);
  if (!sp) { console.error('启动页没退场 —— 停'); process.exit(1); }

  /* 打开用户那本书的第一章（这是听书的真实入口） */
  const opened = await s.js(`(async () => {
    const list = await API.shelf();
    const books = (list && list.projects) || [];
    /* 挑用户自己的书（判据自己建的临时书都叫 zz-…，别拿它当被测对象） */
    const mine = books.filter((x) => !/^zz-/.test(x.slug || ''));
    const b = mine[0] || books[0]; if (!b) return { err: '书架上没有书' };
    const book = await API.book(b.slug);
    const chs = (book && book.chapters) || [];
    const first = ((chs[0] || {}).path) || '';
    if (!first) return { err: '这本书里没有正文' };
    /* 走用户真走的路：书架点进这本书 → 阅读器里打开第一章 */
    Shelf.open(b.slug);
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 200));
      if (document.body.dataset.tab === 'reader') break; }
    if (Reader.goChapter) await Reader.goChapter(first, 0);
    await new Promise((r) => setTimeout(r, 600));
    return { slug: b.slug, path: first, tab: document.body.dataset.tab }; })()`, 60000);
  if (!opened || opened.err) { console.error('打不开章节：' + JSON.stringify(opened)); process.exit(1); }
  console.log('  这本书：' + opened.slug + ' / ' + opened.path);

  /* 反证钩子：把"静默失败"改回去（只回一句"失败"，不给步、不给码）。
     覆盖的是**对外的那个口子**，界面按钮走的也是它 —— 所以界面那条路也跟着红。 */
  if (FORCE === 'nogesture') {
    /* 反证：把"点击时同步解锁"关掉（= 老代码）→ 庚 必须红（第一下出不了声）。
       钩子必须在**第一次点听书之前**装上，否则前面几项已经把元素解锁了，反证就失效
       （第一版就栽在这儿：甲 那趟自检顺手解锁了元素，庚 于是照样绿）。 */
    await s.js(`(() => { window.__TTSD_NO_UNLOCK = true; return 1; })()`);
  }
  if (FORCE === 'silent') {
    await s.js(`(() => { window.__tsdOrig = Reader.selfCheckReport;
      Reader.selfCheckReport = async () => ({ ok: false, rows: [], why: '失败' }); return 1; })()`);
  }
  if (FORCE === 'noabort') {
    /* 反证：把"被冻结打断要说人话 + 回前台自动续播"这半关掉（= 老行为）→ 辛 必须红 */
    await s.js(`(() => { window.__TTSD_NO_ABORT = true; return 1; })()`);
  }
  if (FORCE === 'nochain') {
    await s.js(`(() => { window.__tsdOrig = Reader.selfCheckReport;
      Reader.selfCheckReport = async (o) => { const r = await window.__tsdOrig(o);
        return r && r.ok ? r : { ok: false, rows: [], why: '失败' }; }; return 1; })()`);
  }

  /* 跑一次自检：优先点界面上的按钮（用户真走的路），拿到 report 再核 */
  const runDiag = async (fault) => s.js(`(async () => {
    window.TTSD_FAULT = ${JSON.stringify(fault || '')};
    const rep = await Reader.selfCheckReport({ slug: ${JSON.stringify(opened.slug)},
                                              path: ${JSON.stringify(opened.path)} });
    window.TTSD_FAULT = '';
    return rep; })()`, { timeout: 60000, userGesture: true });

  /* ── 甲：正常时逐项过，且每项都有真数值 ── */
  const a = await runDiag('');
  const rowsTxt = JSON.stringify((a && a.rows) || []);
  /* 逐项核"有没有真数值"：服务器那项要给出段数与字节数；音频那项要给出 HTTP 码与字节数；
     加载那项要给出 readyState/duration —— 不给数值的"通过"等于没量，照样报红。 */
  const rowOf = (k) => ((a && a.rows) || []).filter((r) => String(r.name).indexOf(k) >= 0)[0] || {};
  const srvRow = rowOf('服务器自检').detail || {};
  const audRow = rowOf('音频直链').detail || {};
  const medRow = rowOf('加载').detail || {};
  const okA = !!(a && a.ok && (a.rows || []).length >= 4
    && /段/.test(String(srvRow.结论 || '')) && /字节/.test(String(srvRow.结论 || ''))
    && Number(audRow.status) === 200 && Number(audRow.bytes) > 0 && !!audRow.开头四字节
    && (medRow.readyState !== undefined) && (medRow.duration !== undefined)
    && /互通|通了/.test(String((a || {}).why || '')));
  steps.push({ step: '甲 正常时：自检逐项过，且每项摆出真数值（HTTP 码 / 字节数 / readyState…）',
               expect: 'ok=true、至少 4 项、明细里有真数字', res: a, ok: okA });
  if (okA) good('甲 正常时逐项过（' + (a.rows || []).length + ' 项）');
  else bad('甲 正常时自检就不对：' + JSON.stringify(a).slice(0, 400));

  /* 界面那半：那个按钮真能点出来（用户走的就是这条路） */
  /* ⚠ 这里必须用**真人点击**（CDP 派发鼠标事件），不能用 el.click()：
     那是 JS 调用，浏览器不给"用户手势" —— 自动播放、全屏这类能力一律被拒，
     "点了听书却没声"这种问题在判据里就永远看不见（监督人实测出来的坑）。 */
  await s.js(`(async () => { App.show('settings');
    for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 150));
      if (document.getElementById('do-ttsdiag')) break; } return 1; })()`, { timeout: 40000 });
  const clicked = await s.clickSel('#do-ttsdiag');
  const ui = await s.js(`(async () => {
    if (!document.getElementById('do-ttsdiag')) return { has: false };
    for (let i = 0; i < 80; i++) { await new Promise((r) => setTimeout(r, 200));
      const body = document.getElementById('tsd-body');
      if (body && body.querySelector('.tsd-why')) break; }
    const body = document.getElementById('tsd-body');
    return { has: true, 点中了: ${JSON.stringify(!!clicked)},
             rows: body ? body.querySelectorAll('.tsd-row').length : 0,
             why: body && body.querySelector('.tsd-why') ? body.querySelector('.tsd-why').textContent : '' }; })()`, { timeout: 60000 });
  const okUI = !!(ui && ui.has && ui.rows >= 4 && ui.why);
  steps.push({ step: '甲2 界面上点「听书自检」（大设置 · 听书）→ 面板逐项亮灯 + 一句结论',
               expect: '按钮在、点完面板里有 ≥4 行 + 结论', res: ui, ok: okUI });
  if (okUI) good('甲2 界面入口在（' + ui.rows + ' 行，结论：' + String(ui.why).slice(0, 40) + '）');
  else bad('甲2 界面自检入口不对：' + JSON.stringify(ui).slice(0, 300));
  await s.js(`(async()=>{App.closeSheet(); return 1;})()`);
  await sleep(400);

  /* ── 乙~戊：四种坏法，各自必须报出**具体是哪一步、什么码** ── */
  const cases = [
    ['乙', 'badbase', /服务器|连不上|Failed|fetch|TypeError|ECONN/i, '地址指错 → 报"服务器这一环没通"'],
    ['丙', 'badurl', /HTTP (404|50\d)|取音频/, '音频地址坏 → 报"取音频 HTTP 404"'],
    ['丁', 'nochapter', /读不到|404|没有这一章/, '章节不存在 → 报"这一章读不到 404"'],
    ['戊', 'badtoken', /401|口令|登录/, '口令过期 → 报 401（不是"没内容"）'],
  ];
  const seen = [];
  for (const [tag, fault, re, desc] of cases) {
    /* "章节不存在"这条不能靠 patch：直接把 path 换成一个不存在的 */
    const rep = (fault === 'nochapter')
      ? await s.js(`(async () => await Reader.selfCheckReport({ slug: ${JSON.stringify(opened.slug)},
            path: 'manuscript/zz-不存在的一章.md' }))()`, { timeout: 60000, userGesture: true })
      : await runDiag(fault);
    const txt = JSON.stringify(rep);
    const ok = !!(rep && rep.ok === false && re.test(txt));
    seen.push({ tag, fault, why: (rep || {}).why || '', rows: ((rep || {}).rows || []).length });
    steps.push({ step: tag + ' ' + desc, expect: 'ok=false 且原因里说得清是哪一步 / 什么码',
                 res: rep, ok });
    if (ok) good(tag + ' 报出来了：' + String((rep || {}).why).slice(0, 60));
    else bad(tag + ' 没报清原因：' + txt.slice(0, 300));
  }

  /* 甲2 把屏幕切到了「设置」，庚 要的是**阅读器**那一屏 —— 先按用户的路回去打开这一章：
     不然点下去的听书按钮拿不到当前章（R.path 空），量出来的就是"没声"，白报一条红。 */
  await s.js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await Reader.stopTts(); await wait(300);
    Shelf.open(${JSON.stringify(opened.slug)});
    for (let i = 0; i < 60; i++) { await wait(200);
      if (document.body.dataset.tab === 'reader') break; }
    if (Reader.goChapter) await Reader.goChapter(${JSON.stringify(opened.path)}, 0);
    await wait(700);
    return 1; })()`, { timeout: 60000 });
  await sleep(400);
  /* ── 庚：**真的在走**（这一条才是"App 里有没有声音"的判据）──────────────
     监督人实测的根因：点击后 `await ttsSegments()` 一 await，用户手势就过期，
     浏览器按自动播放策略拒掉 play() → 音频拉回来了、`paused` 还是 true。
     所以：在**真实的自动播放策略**（cdp.js 默认 user-gesture-required）下走用户点击，
     然后核 `paused === false` 且 `currentTime` 在 1.5 秒里涨了 ≥1 秒。 */
  /* 先把面板开到「听书」页（开面板本身不需要手势），再**真人点**那颗「开始朗读」 */
  await s.js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (Reader.quickToggle) Reader.quickToggle('tts');
    for (let i = 0; i < 20; i++) { await wait(200);
      if (document.querySelector('[data-a="tts"]')) break; }
    return 1; })()`, { timeout: 40000 });
  /* 点之前先记一笔"上一次解锁是几点" —— 点完再看它有没有**变大**，
     就能证明"这一下点击真的同步解锁了"。⚠ 不能在点击之后取 Date.now() 来比：
     那样时间戳永远比点击晚，判据会假红（第 37 轮第一版就是这么栽的）。 */
  const preUnlock = await s.js(`(() => { const st = Reader.ttsState() || {};
    return { 解锁于: st.解锁于 || 0, 在听: !!st.在听 }; })()`);
  const ttsClick = await s.clickSel('[data-a="tts"]');
  const g = await s.js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(1500);
    const t1 = Reader.ttsState() || {};
    await wait(1600);
    const t2 = Reader.ttsState() || {};
    return { 开始时: t1, '1.6秒后': t2, 点前解锁于: ${preUnlock.解锁于}, 真鼠标点中了: ${JSON.stringify(!!ttsClick)},
             当前章: (Reader.state && Reader.state.path) || '', 屏: document.body.dataset.tab,
             最近出错: (Reader.state && Reader.state.ttsLastError) || null,
             涨了: Math.round(((t2.currentTime || 0) - (t1.currentTime || 0)) * 100) / 100,
             /* 两个条件都要：① 这一下点击**真的做了同步解锁**（元素在点击的同一 tick 里被解锁）
                ② 声音**真的在走**。少一个都会漏掉真问题：
                · 只有②：元素可能被上一次操作解锁过，看不出这次点击有没有解锁；
                · 只有①：解锁了但地址是坏的 / 被 ended 吃掉，照样听不见。 */
             这一下解锁了: (t1.解锁于 || 0) > ${preUnlock.解锁于},
             在走: (t2.paused === false) && ((t2.currentTime || 0) - (t1.currentTime || 0)) >= 1.0 };
  })()`, { timeout: 60000, userGesture: true });
  const okG = !!(g && g.在走 && g.这一下解锁了);
  steps.push({ step: '庚 真实自动播放策略下，点一下「听书」**真的出声**（paused=false 且 currentTime 在走）',
               expect: '1.6 秒里 currentTime 涨 ≥1 秒 + 这一下点击的同步解锁真的发生了', res: g, ok: okG });
  if (okG) good('庚 真的在走（涨了 ' + g.涨了 + ' 秒，且这一下点击做了同步解锁）');
  else bad('庚 没真的在走：' + JSON.stringify(g).slice(0, 400));

  /* ── 辛：**"页面被冻结"把播放打断时，不许静默**（监督人抠出来的那条 AbortError）──────
     用户贴的自检原文：
       {"事件":"play 被拒","name":"AbortError",
        "message":"The play() request was interrupted because the containing page was frozen."}
     这是**切后台 / 被系统省电冻结**把正在播的那一次中止了 —— 既不是"没联网"也不是"语音坏了"。
     老代码一律吞掉 → 用户切回来只看到一片安静，只能乱点。
     要求：① 说人话（不是"失败"两个字）；② 记住"是被打断的"；③ **回到前台自动接着读**。
     怎么用机器验：把 play() 注成"以 AbortError 被拒"（浏览器原文照抄），再派一次
     visibilitychange 模拟"用户切回来"，最后量**声音有没有真的接着走**。 */
  const xin = await s.js(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const R = Reader.state;
    if (!R.audio) return { err: '没有音频元素（庚 没跑起来？）' };
    const toasts = []; const ot = App.toast;
    App.toast = (m, ms) => { try { toasts.push(String(m)); } catch (e) {} return ot(m, ms); };
    try {
      await Reader.stopTts(); await wait(400);
      R.ttsWant = true;
      const au = R.audio; const realPlay = au.play.bind(au);
      /* 注入：下一次播放"像页面被冻结那样"被打断 */
      au.play = () => Promise.reject(Object.assign(new Error(
        'The play() request was interrupted because the containing page was frozen.'),
        { name: 'AbortError' }));
      Reader.toggleTts();                       // = 用户点了「开始朗读」
      for (let i = 0; i < 30; i++) { await wait(150); if (toasts.length) break; }
      const 被打断过 = !!Reader.ttsState().被打断过;
      const 说了话 = toasts.some((m) => /打断|接着读|续播/.test(m));
      au.play = realPlay;                       // 恢复真播放
      document.dispatchEvent(new Event('visibilitychange'));   // 用户切回这一页
      await wait(1500);
      const t1 = Reader.ttsState() || {};
      await wait(1600);
      const t2 = Reader.ttsState() || {};
      App.toast = ot;
      return { 被打断过, 说了话, 提示: toasts.slice(-2),
               涨了: Math.round(((t2.currentTime || 0) - (t1.currentTime || 0)) * 100) / 100,
               接着读了: (t1.paused === false) && ((t2.currentTime || 0) - (t1.currentTime || 0)) >= 1.0 };
    } finally { App.toast = ot; }
  })()`, { timeout: 60000 });
  const okX = !!(xin && xin.被打断过 && xin.说了话 && xin.接着读了);
  steps.push({ step: '辛 被"页面冻结"打断时：说人话 + 记住被打断 + **回前台自动接着读**',
               expect: '被打断过=true、提示里有人话、回前台后 paused=false 且 currentTime 涨 ≥1 秒', res: xin, ok: okX });
  if (okX) good('辛 被打断后说了人话并自动续播（提示：' + String((xin.提示 || [])[0] || '').slice(0, 30) + '）');
  else bad('辛 被打断后没兜住：' + JSON.stringify(xin).slice(0, 400));

  /* ── 己：四种坏法的原因两两不同（不许"失败"一句糊过去） ── */
  const whys = seen.map((x) => String(x.why).trim());
  const uniq = new Set(whys.filter(Boolean));
  const okF = uniq.size >= 4 && whys.every((w) => w.length >= 6);
  steps.push({ step: '己 四种坏法各自报红、且原因两两不同（不是一句"失败"）',
               expect: '四个 why 互不相同且都不是空/太短', res: seen, ok: okF });
  if (okF) good('己 四种原因互不相同');
  else bad('己 四种坏法分不出来：' + JSON.stringify(seen).slice(0, 300));

  const doc = { at: new Date().toISOString().replace('T', ' ').slice(0, 19),
                force: FORCE || '（正常）', book: opened.slug, chapter: opened.path,
                steps, fails };
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 1));
  console.log((fails.length ? '\n有红 ❌' : '\n全过 ✅') + ' → ' + path.basename(OUT));
  await s.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('跑挂了：', e); process.exit(2); });
