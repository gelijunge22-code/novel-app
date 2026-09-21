/* ============================================================
   e2e-new.js — 第 10 轮新加的四块东西，在**真界面**上点一遍：
     ① 质检 · 声音   （人物声音档案：谁和谁一个腔）
     ② 质检 · 体检   （角色一致性：年龄/外貌/代词/像笔误的名字）
     ③ 统计 · 节奏   （张力与情绪曲线 + 走势毛病）
     ④ 工具 · 参考书架（放一条 → 列表 → 打开 → 挑进写作台）
   外加：390 宽不横向溢出、每个面板有返回入口、深浅两套主题都不跳色、控制台 0 报错、
        截图逐张不同（同一 md5 直接判失败 —— shotkit 管）。
   跑法：node tools/e2e-new.js
   产出：docs/新面板界面实测.json + docs/前端截图/r10-*.png
   ============================================================ */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const makeKit = require('./shotkit');
const { shelfShield } = require('./preflight');

const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const ROOT = '/home/ubuntu/novel-app';
const BASE = 'http://127.0.0.1:8899/';
const OUT = path.join(ROOT, 'docs/新面板界面实测.json');
const SHOT = path.join(ROOT, 'docs/前端截图');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let COOKIE = '';

async function api(method, p, body) {
  const r = await fetch(BASE.replace(/\/$/, '') + p, {
    method, headers: Object.assign({ 'content-type': 'application/json' },
      COOKIE ? { cookie: COOKIE } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  if (sc.length) COOKIE = sc.map((c) => c.split(';')[0]).join('; ');
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch (e) {}
  return { status: r.status, json: j, text: t };
}
function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });
  const TITLE = '界面实测-' + Date.now().toString().slice(-6);
  await api('POST', '/api/app/login', { password: readPassword() });
  await shelfShield({ api, script: 'e2e-new.js' });       // 架上有自测书 → 拒绝开跑
  const born = await api('POST', '/api/projects', { title: TITLE, summary: '自动化测试用书（跑完自删）', kind: 'novel' });
  const SLUG = born.json && (born.json.projectRoot || born.json.slug);
  if (!SLUG) { console.error('建测试书失败', born.status, born.text.slice(0, 200)); process.exit(1); }
  await api('POST', '/api/import/text', { slug: SLUG, name: '001-第001章-雪',
    text: '那年林诺十七岁，黑发。\n\n“走。”沈岩说。\n“等等。”林诺说。\n', prefix: 'manuscript' });
  await api('POST', '/api/import/text', { slug: SLUG, name: '002-第002章-吵',
    text: '林诺很生气，他觉得委屈，他恨透了这间屋子。\n\n林诺说：“我早说过，你别信他。”\n',
    prefix: 'manuscript' });
  await api('POST', '/api/import/text', { slug: SLUG, name: '003-第003章-动手',
    text: '刀突然劈下来，沈岩猛地扑上去，撞开窗户。\n\n“跑！”沈岩吼道。\n林诺拼命地跑，摔在雪里。\n',
    prefix: 'manuscript' });
  for (const n of ['林诺', '沈岩', '老周']) {
    await api('POST', '/api/world/entity', { slug: SLUG, kind: 'character', name: n });
  }
  await api('POST', '/api/voice/profile', { slug: SLUG, name: '沈岩', voice: {
    tone: '冷硬，能说两个字不说三个字', sentence: '短促', catchphrases: ['没用'],
    banned: ['亲爱的'], addresses: { 林诺: '小子' }, emotion: 2, samples: ['墙不会救你。'] } });
  await api('POST', '/api/refs/item', { slug: SLUG, title: '打斗怎么写（范例）',
    source: '某武侠小说第 3 章', tags: '打斗,节奏',
    text: '刀光一闪，他没有退。风从左侧压过来，他侧身，刀背贴着小臂滑过去，鞋底在碎石上碾出一声轻响。'.repeat(6) });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-new-'));
  spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=9344', '--window-size=390,844',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try { targets = await (await fetch('http://127.0.0.1:9344/json/list')).json(); if (targets && targets.length) break; } catch (e) {}
  }
  if (!targets) { console.error('chrome 起不来'); process.exit(1); }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const waiting = new Map(); const consoleErrors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 160));
    }
    // 页面自己抛的未捕获异常也要算（这是真 bug，不是脚本的锅）
    if (m.method === 'Runtime.exceptionThrown') {
      const d = (m.params || {}).exceptionDetails || {};
      consoleErrors.push('uncaught: ' + String((d.exception && d.exception.description) || d.text || '').slice(0, 160));
    }
  };
  const send = (m, p) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const evalErrors = [];
  const js = async (expr, wait) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (wait) await sleep(wait);
    if (r.result && r.result.exceptionDetails) {
      const ed = r.result.exceptionDetails;
      evalErrors.push('eval: ' + String((ed.exception && ed.exception.description) || ed.text || '').slice(0, 200));
    }
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const kit = makeKit({ send, dir: SHOT, round: 'r10' });
  const check = (name, ok, why, shot) => {
    results.push({ name, ok: !!ok, why: String(why || ''), shot: shot || '' });
    console.log((ok ? '  ✓ ' : '  ✗ ') + name + (ok ? '' : '   —— ' + String(why || '').slice(0, 240)));
  };
  /* 面板量体：横向溢出 / 有没有返回入口 / 有没有字跟底同色 */
  const MEASURE = `(() => {
    const scr = document.querySelector('.screen:not(.hidden)');
    const b = document.querySelector('[data-act="tool-back"], .topbar-back, .bar-back');
    const rb = b ? b.getBoundingClientRect() : null;
    const body = document.getElementById('tool-body') || scr;
    return JSON.stringify({
      screen: scr ? scr.id : '', overflowX: body ? body.scrollWidth : 0, vw: window.innerWidth,
      rows: body ? body.querySelectorAll('.t-row').length : 0,
      text: body ? (body.innerText || '').slice(0, 200) : '',
      hasBack: !!b, backTop: rb ? Math.round(rb.top) : -1,
      empty: body ? !!body.querySelector('.t-empty') : false
    });
  })()`;

  await send('Page.navigate', { url: BASE + '?new=' + Date.now() });
  await sleep(5000);
  if (await js("!document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword()) +
      ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4500);
  }
  /* 进工具面板：卡片 → （书多时）选书 → 等真的进去。
     踩过的坑：选书列表是异步渲染的，早一步点就落空，后面所有断言就都在"选书页"上跑，
     看着一片红其实什么都没验。这里用书名做哨兵，确认离了选书页再往下走。 */
  const SENTINEL = '自动化测试用书';
  const inPicker = async () => {
    const t = await js(`(() => { const b = document.getElementById('tool-body'); return b ? (b.innerText || '').slice(0, 80) : ''; })()`);
    return new RegExp(SENTINEL).test(t || '');
  };
  const openTool = async (tid) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      await js("App.show('tools'); 1", 900);
      if (await inPicker()) {
        await js(`(() => { const r = [...document.querySelectorAll('#tool-body [data-slug]')]
          .find(x => x.dataset.slug === ${JSON.stringify(SLUG)}) || document.querySelector('#tool-body [data-slug]');
          if (r) r.click(); return 1; })()`, 2200);
      } else {
        await js(`(() => { const c = document.querySelector('#tools-body .tool-card[data-id="${tid}"]'); if (c) c.click(); return 1; })()`, 1800);
        if (await inPicker()) {
          await js(`(() => { const r = [...document.querySelectorAll('#tool-body [data-slug]')]
            .find(x => x.dataset.slug === ${JSON.stringify(SLUG)}) || document.querySelector('#tool-body [data-slug]');
            if (r) r.click(); return 1; })()`, 2200);
        }
      }
      await sleep(700);
      if (!(await inPicker())) {
        const t = await js(`(() => { const b = document.getElementById('tool-body'); return b ? (b.innerText || '').slice(0, 40) : ''; })()`);
        if (t) return true;
      }
    }
    return false;
  };
  const back = async () => {
    await js("(() => { const b = document.querySelector('#tool-top [data-act=\"tool-back\"], [data-act=\"tool-back\"]'); b && b.click(); return 1; })()", 900);
    await sleep(300);
  };
  const tab = async (label, wait) => {
    await js(`(() => { const t = [...document.querySelectorAll('#tool-body .t-seg button[data-tab]')]
      .find(x => x.textContent.trim() === ${JSON.stringify(label)}); t && t.click(); return 1; })()`, wait || 2200);
  };

  /* ─────────── ① 质检 · 声音 ─────────── */
  await openTool('lint');
  await tab('声音', 2400);
  const v1 = JSON.parse(await js(MEASURE) || '{}');
  check('① 质检里有「声音」页签，点得进（面板上真的是一本书的声音报告）',
    /声音分/.test(v1.text || '') && v1.rows > 0 && !/自动化测试用书/.test(v1.text || ''),
    JSON.stringify({ rows: v1.rows, text: (v1.text || '').slice(0, 80) }));
  check('① 声音面板在 390 宽不横向溢出', (v1.overflowX || 0) <= 391, v1.overflowX + 'px');
  const s1 = await kit.shoot('01-质检-声音');

  /* ①b 给第一个人建档案（真填真存） */
  const opened = await js(`(() => {
    const b = [...document.querySelectorAll('#tool-body [data-open]')][0];
    if (!b) return 0; b.click(); return 1;
  })()`, 1800);
  const f1 = JSON.parse(await js(MEASURE) || '{}');
  check('① 点「建/改档案」进得去表单（有腔调等字段）',
    opened === 1 && /腔调/.test(f1.text || ''), JSON.stringify({ opened, text: (f1.text || '').slice(0, 100) }));
  const s2 = await kit.shoot('02-声音档案-表单');
  await js(`(() => {
    const el = [...document.querySelectorAll('#tool-body [data-f]')].find(x => x.dataset.f === 'tone');
    if (el) { el.value = '话少，冷'; el.dispatchEvent(new Event('input', { bubbles: true })); }
    const cp = [...document.querySelectorAll('#tool-body [data-f]')].find(x => x.dataset.f === 'catchphrases');
    if (cp) { cp.value = '嗯'; cp.dispatchEvent(new Event('input', { bubbles: true })); }
    return 1;
  })()`);
  await js("(() => { const b = document.querySelector('#tool-body [data-save]'); b && b.click(); return 1; })()", 2500);
  const saved = await js(`(() => { const t = (document.getElementById('tool-body') || {}).innerText || ''; return t.slice(0, 300); })()`);
  check('① 填完存得下（回到声音面板，且这个人现在有档案）',
    /有档案/.test(saved || '') || /声音分/.test(saved || ''), (saved || '').slice(0, 100));
  const s3 = await kit.shoot('03-声音-存下之后');

  /* ─────────── ② 质检 · 体检 ─────────── */
  await tab('体检', 2600);
  const c1 = JSON.parse(await js(MEASURE) || '{}');
  const hasBody = /一致性|年龄|外貌|代词|没挑出/.test(c1.text || '');
  check('② 体检页签点得进，并且给出结论（挑出问题或明说没挑出）', hasBody,
    (c1.text || '').slice(0, 120));
  check('② 体检面板 390 宽不横向溢出', (c1.overflowX || 0) <= 391, c1.overflowX + 'px');
  const s4 = await kit.shoot('04-质检-体检');

  /* ─────────── ③ 统计 · 节奏 ─────────── */
  await back();
  await openTool('stats');
  await tab('节奏', 2600);
  const pac = await js(`(() => {
    const svg = document.querySelector('#tool-body svg polyline');
    return JSON.stringify({ lines: svg ? document.querySelectorAll('#tool-body svg polyline').length : 0,
                            rows: document.querySelectorAll('#tool-body .t-row').length,
                            text: (document.getElementById('tool-body').innerText || '').slice(0, 200) });
  })()`);
  const pj = JSON.parse(pac || '{}');
  check('③ 节奏页签点得进，画出了曲线（两条折线）', pj.lines >= 2, JSON.stringify({ lines: pj.lines }));
  check('③ 每章都有一行数字（张力/情绪/对白/句长）', pj.rows >= 3 && /张力/.test(pj.text || ''),
    JSON.stringify({ rows: pj.rows }));
  const s5 = await kit.shoot('05-统计-节奏');
  const p2 = JSON.parse(await js(MEASURE) || '{}');
  check('③ 节奏面板 390 宽不横向溢出', (p2.overflowX || 0) <= 391, p2.overflowX + 'px');

  /* ─────────── ④ 工具 · 参考书架 ─────────── */
  await back();
  await openTool('refs');
  const r1 = JSON.parse(await js(MEASURE) || '{}');
  check('④ 参考书架进得去，且有「放一条进来」的新增入口',
    /参考书架/.test(r1.text || '') && r1.rows >= 1 && /放一条进来/.test(r1.text || ''),
    JSON.stringify({ rows: r1.rows, text: (r1.text || '').slice(0, 90) }));
  const s6 = await kit.shoot('06-参考书架-列表');
  await js(`(() => { const b = [...document.querySelectorAll('#tool-body button')].find(x => x.textContent.trim() === '放一条进来'); b && b.click(); return 1; })()`, 1600);
  const f2 = JSON.parse(await js(MEASURE) || '{}');
  check('④ 新增表单进得去（有起名/出处/标签/正文四个字段）',
    /起个名字/.test(f2.text || '') && /出处/.test(f2.text || '') && /标签/.test(f2.text || ''),
    (f2.text || '').slice(0, 120));
  await js(`(() => {
    const set = (sel, v) => { const el = document.querySelector('#tool-body ' + sel); if (el) { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); } };
    set('[data-title]', '界面实测摘抄');
    set('[data-source]', 'e2e');
    set('[data-tags]', '对白,节奏');
    set('[data-text]', '短句让人显得冷。他说话越短，读者越觉得他心里有东西。'.repeat(4));
    return 1;
  })()`);
  const s7 = await kit.shoot('07-参考书架-新增填好');
  await js("(() => { const b = document.querySelector('#tool-body [data-save]'); b && b.click(); return 1; })()", 2500);
  const after = JSON.parse(await js(MEASURE) || '{}');
  check('④ 存下之后列表里真的有这条（不是存了没反应）',
    /界面实测摘抄/.test(after.text || ''), (after.text || '').slice(0, 120));
  const s8 = await kit.shoot('08-参考书架-存下之后');
  await js(`(() => { const r = [...document.querySelectorAll('#tool-body .t-row')].find(x => /界面实测摘抄/.test(x.innerText)); r && r.click(); return 1; })()`, 1800);
  const openedRef = await js(`(() => {
    const ta = document.querySelector('#tool-body [data-text]');
    const box = document.getElementById('tool-body');
    return JSON.stringify({ hasForm: !!ta, len: ta ? ta.value.length : 0,
      hasText: ta ? /短句让人显得冷/.test(ta.value) : false,
      text: (box.innerText || '').slice(0, 90) });
  })()`);
  const orj = JSON.parse(openedRef || '{}');
  check('④ 点开能看到**全文**（不是列表里那段摘要）', orj.hasForm && orj.hasText && orj.len > 80,
    openedRef);
  const s9 = await kit.shoot('09-参考书架-打开一条');
  /* 删掉刚建的那条（别给用户的书架留测试垃圾） */
  const toList = async () => {
    for (let i = 0; i < 3; i++) {
      const t = await js(`(() => { const b = document.getElementById('tool-body'); return b ? (b.innerText || '').slice(0, 60) : ''; })()`);
      if (/放一条进来/.test(t || '')) return true;
      await back();
    }
    return false;
  };
  const atList = await toList();
  const deleted = await js(`(async () => {
    const rows = [...document.querySelectorAll('#tool-body .t-row')];
    const row = rows.find(x => /界面实测摘抄/.test(x.innerText));
    if (!row) return 'no-row';
    const btn = row.querySelector('[data-del]'); if (!btn) return 'no-btn';
    btn.click(); return 'clicked';
  })()`, 1200);
  const box = await js(`(() => { const d = document.querySelector('.t-dialog, .t-sheet, [class*=\"dialog\"]'); return d ? (d.innerText || '').slice(0, 80) : ''; })()`);
  if (box) await js("(() => { const b = [...document.querySelectorAll('.t-dialog button')].find(x => /删|确定|是/.test(x.textContent)); b && b.click(); return 1; })()", 1600);
  const afterDel = JSON.parse(await js(MEASURE) || '{}');
  check('④ 删除有二次确认（不是点一下就没了）', /删/.test(box || ''), JSON.stringify({ atList, click: deleted, box }));
  check('④ 删掉之后列表里没有了', !/界面实测摘抄/.test(afterDel.text || ''), (afterDel.text || '').slice(0, 90));
  const s10 = await kit.shoot('10-参考书架-删掉之后');

  /* ─────────── ⑤ 工具 · 素材：列表只铺摘要，点开才取全文 ───────────
     真踩过的坑：素材列表以前把每条正文整段铺进 DOM —— 真实那本书 11 条 = 16.8 万字，
     走查量出"一个面板 16.7 万字"，手机上滚动发涩、想找一条得划半天。 */
  await api('POST', '/api/material', { slug: SLUG, title: '界面实测长素材', kind: 'note',
    tags: ['实测'], body: '这一条故意写得很长。'.repeat(4000) });
  await back();
  await openTool('material');
  const mRaw = await js(`(() => { const b = document.getElementById('tool-body');
    return JSON.stringify({ len: (b.innerText || '').length, rows: b.querySelectorAll('.t-row').length,
      hasGo: !!b.querySelector('.tr-go'), text: (b.innerText || '').slice(0, 120) }); })()`);
  const mj = JSON.parse(mRaw || '{}');
  check('⑤ 素材列表只铺摘要（四万字的素材不再整段进 DOM）',
    mj.len > 0 && mj.len < 4000 && (mj.text || '').length > 0,
    JSON.stringify({ 列表字数: mj.len, rows: mj.rows }));
  check('⑤ 列表每条都能点开（右侧有进入箭头，不是死行）', mj.rows >= 1 && mj.hasGo,
    JSON.stringify({ rows: mj.rows, hasGo: mj.hasGo }));
  const s11b = await kit.shoot('11-素材-列表');
  await js(`(() => { const r = [...document.querySelectorAll('#tool-body .t-row')].find(x => /界面实测长素材/.test(x.innerText)); r && r.click(); return 1; })()`, 2200);
  const dRaw = await js(`(() => { const b = document.getElementById('tool-body'); const pre = b.querySelector('.t-pre');
    return JSON.stringify({ hasPre: !!pre, full: pre ? pre.innerText.length : 0,
      hasEdit: /改正文/.test(b.innerText || ''), hasDel: /删/.test(b.innerText || ''),
      text: (b.innerText || '').slice(0, 80) }); })()`);
  const dj = JSON.parse(dRaw || '{}');
  check('⑤ 点开一条真取到全文（四万字都在，不是摘要）', dj.hasPre && dj.full > 20000,
    JSON.stringify({ 全文长度: dj.full, hasPre: dj.hasPre }));
  check('⑤ 详情页有「改正文」和「删」两个入口', dj.hasEdit && dj.hasDel, dRaw);
  const s12 = await kit.shoot('12-素材-详情');
  await js("(() => { const b = [...document.querySelectorAll('#tool-body button')].find(x => x.textContent.trim() === '删'); b && b.click(); return 1; })()", 1300);
  const cbox = await js(`(() => { const d = document.querySelector('.t-dialog'); return d ? (d.innerText || '').slice(0, 80) : ''; })()`);
  check('⑤ 删素材有二次确认（不是点一下就没了）', /删掉/.test(cbox || ''), JSON.stringify(cbox));
  await js("(() => { const b = [...document.querySelectorAll('.t-dialog button')].find(x => /确定/.test(x.textContent)); b && b.click(); return 1; })()", 2200);
  const afterM = await js(`(() => { const b = document.getElementById('tool-body'); return (b.innerText || '').slice(0, 90); })()`);
  check('⑤ 删完回到列表，那条不在了（返回时列表是重取的）', !/界面实测长素材/.test(afterM || ''), afterM);
  const s13 = await kit.shoot('13-素材-删掉之后');

  /* ─────────── ⑥ 深色主题：不跳色、不溢出（挑一个行数最多的面板查） ─────────── */
  await back();
  await openTool('stats');
  await tab('节奏', 2600);
  await js("Prefs.set('theme','night'); 1", 1000);
  // 先等这一屏"落地"：要么出行、要么出明确的空态。
  // （以前切完主题立刻量，量到的常常还是「算一遍节奏…」那半屏，于是 rows=0 → 假红。
  //   判据不能因为"还没来得及加载"就判失败。）
  let settled = false;
  for (let i = 0; i < 20 && !settled; i++) {
    settled = await js(`(() => { const b = document.getElementById('tool-body');
      return !!(b && (b.querySelector('.t-row') || b.querySelector('.t-empty'))); })()`);
    if (!settled) await new Promise((r) => setTimeout(r, 300));
  }
  const night = await js(`(() => {
    const body = document.getElementById('tool-body');
    const rows = [...body.querySelectorAll('.t-row .tr-title, .t-row .tr-sub')].slice(0, 60);
    const empty = body.querySelector('.t-empty');
    if (empty) rows.push(empty);                       // 空态也是"用户要读的字"，一起量
    const bg = getComputedStyle(document.body).backgroundColor;
    const bad = rows.filter((el) => {
      const cs = getComputedStyle(el);
      return cs.color === cs.backgroundColor || (cs.color === bg && !el.closest('.t-pill'));
    }).length;
    return JSON.stringify({ rows: rows.length, empty: !!empty, bad, overflowX: body.scrollWidth,
                            text: (body.innerText || '').slice(0, 60) });
  })()`);
  const nj = JSON.parse(night || '{}');
  check('⑥ 深色主题下没有「字和底同色」（读不出来的情况；空态也算可读的字）',
    nj.bad === 0 && nj.rows > 0, night);
  check('⑥ 深色主题下也不横向溢出', (nj.overflowX || 0) <= 391, nj.overflowX + 'px');
  const s11 = await kit.shoot('11-统计-节奏-深色');
  await js("Prefs.set('theme','paper'); 1", 700);

  /* ─────────── ⑦ 每个面板都有返回入口 + 控制台干净 ─────────── */
  const backs = [];
  for (const [tid, nm] of [['refs', '参考书架'], ['lint', '质检'], ['stats', '统计'], ['world', '世界']]) {
    await back(); await back();
    await openTool(tid);
    const m = JSON.parse(await js(MEASURE) || '{}');
    backs.push({ nm, hasBack: m.hasBack, screen: m.screen });
  }
  check('⑦ 四个新页面板都有返回入口（不是只能靠安卓返回键）',
    backs.every((b) => b.hasBack), JSON.stringify(backs));
  check('⑦ 页面 0 报错、0 未捕获异常', consoleErrors.length === 0, JSON.stringify(consoleErrors.slice(0, 3)));
  check('⑦b 走查脚本自己的 eval 也没抛异常（抛了说明选择器过时）',
    evalErrors.length === 0, JSON.stringify(evalErrors.slice(0, 3)));

  const rep = kit.report();
  check('⑧ 这次拍到的每张图都不同（没有重复证据）', rep.dupes.length === 0, JSON.stringify(rep.dupes.slice(0, 3)));

  /* 收尾：测试书进回收站 */
  const gone = await api('DELETE', '/api/projects/item?projectRoot=' + encodeURIComponent(SLUG));
  check('⑨ 测试书进回收站（不留垃圾，不碰用户的书）', gone.status === 200, gone.status + ' ' + gone.text.slice(0, 80));

  const passed = results.filter((r) => r.ok).length;
  fs.writeFileSync(OUT, JSON.stringify({
    at: new Date().toISOString(), base: BASE, scratchBook: TITLE, total: results.length,
    passed, failed: results.length - passed, shots: rep.shots, dupes: rep.dupes,
    consoleErrors, items: results }, null, 1), 'utf8');
  console.log('\n=== 新面板界面实测：' + passed + '/' + results.length + ' ===');
  console.log('报告：docs/新面板界面实测.json');
  try { ws.close(); } catch (e) {}
  try { require('child_process').execSync('pkill -f "remote-debugging-port=9344" || true'); } catch (e) {}
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
