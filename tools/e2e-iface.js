/* ============================================================
   e2e-iface.js — 「后端做了、用户却点不到」的接口清单（第 19 轮）

   为什么要"跑一遍"而不是只搜字符串：
     `iface_account.py` 那种粗匹配会骗自己 —— 前端里出现一个词（比如 'polish'）就算"用了"，
     可它可能只是某个下拉框的取值，接口压根没被调过。反过来，前端拼地址
     （`API.abs('/write/' + kind)`）又会被漏掉。
     所以这里**真开浏览器、真走一遍全站**（复用 tools/surfaces.js 的那份清单），
     从 CDP 的网络事件里**如实记下每一步真的请求了哪些接口**，再和路由表对账。

   产出：docs/接口实跑核查.json
        · hit      = 这次走查真的打过的接口（有证据：请求 URL）
        · unhit    = 这次没打到的（可能是：只有 App 壳在用 / 老客户端专用 / 要点的更深 / 真没有入口）
        · staticMissing = 静态也搜不到、跑也没跑到的 —— **真候选**，要逐条给结论
   用法：node tools/e2e-iface.js
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { open, sleep } = require('./cdp');
const { SCREENS, OVERLAYS, toolSurfaces } = require('./surfaces');

const ROOT = '/home/ubuntu/novel-app';
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8899/';
const OUT = path.join(ROOT, 'docs/接口实跑核查.json');
let password = '';
try { password = JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
catch (e) {}

/* 路由表：从 server/routers 里读（唯一出处，别另抄一份） */
function routeTable() {
  const out = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'server/routers'))) {
    if (!f.endsWith('.py')) continue;
    const src = fs.readFileSync(path.join(ROOT, 'server/routers', f), 'utf8');
    const re = /@router\.(get|post|put|delete|patch)\("([^"]+)"/g;
    let m;
    while ((m = re.exec(src))) out.push({ method: m[1].toUpperCase(), path: '/api' + m[2], router: f });
  }
  const uniq = {};
  out.forEach((r) => { uniq[r.method + ' ' + r.path] = r; });
  return Object.values(uniq);
}

/* 请求 URL → 路由形状：去掉查询串、/nb/api 归一到 /api、数字/长 id 段换成 {x} */
function normalize(u) {
  let s = u.replace(/^https?:\/\/[^/]+/, '');
  s = s.split('?')[0];
  s = s.replace(/^\/nb\/api\//, '/api/');
  s = s.split('/').map((seg) => (/^\d+$/.test(seg) ? '{x}' : seg)).join('/');
  return s;
}
function sameShape(a, b) {
  const A = a.split('/'), B = b.split('/');
  if (A.length !== B.length) return false;
  for (let i = 0; i < A.length; i++) {
    const x = A[i], y = B[i];
    if (x.startsWith('{') || y.startsWith('{')) continue;
    if (x !== y) return false;
  }
  return true;
}

(async () => {
  const routes = routeTable();
  const s = await open({ port: 9394, width: 390, height: 844, settle: 900 });
  const js = s.js;
  const rep = { at: new Date().toISOString(), base: BASE, routes: routes.length, hits: [], unhit: [], staticMissing: [] };
  await s.nav(BASE + '?iface=' + Date.now());
  for (let i = 0; i < 40; i++) {
    const gone = await js("(()=>{const sp=document.getElementById('splash');return !!(sp&&(sp.classList.contains('gone')||getComputedStyle(sp).opacity==='0'));})()");
    if (gone) break; await sleep(120);
  }
  if (await js("document.getElementById('login') && !document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(password)
      + ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4200);
  }
  const ids = await js("(()=>{try{return (window.Tools.TOOLS||[]).map(t=>t.id);}catch(e){return [];}})()");
  global.__TOOLIDS__ = (ids || []).map((x) => ({ id: x }));

  const list = SCREENS.concat(OVERLAYS).concat(toolSurfaces());
  console.log('  走查 %d 个屏/面板/工具…', list.length);
  for (const sf of list) {
    try {
      await js("(async()=>{try{return await (" + sf.open + ");}catch(e){return -1;}})()");
      await sleep(Math.min(sf.settle || 900, 1500));
      if (sf.close) { await js("(async()=>{try{return await (" + sf.close + ");}catch(e){return 0;}})()"); await sleep(250); }
    } catch (e) { console.log('    ! ' + sf.id + ' 打不开：' + String(e && e.message).slice(0, 60)); }
  }

  /* 深一层：**页签里 / 列表行内**的入口，光"打开面板"是打不到的 ——
     （第 19 轮接口核查里 `POST /plot/thread`、`POST /config/models/test` 就是这种：
      面板开了、请求没发）。这里真点一下，但不造数据、不改稿子：
      剧情线页签只**看**（GET），模型「测一下」只发一句"连通正常"（1~2 秒）。 */
  const DEEP = [
    { id: 'deep-plot-threads', code: "(async()=>{App.show('tools');await new Promise(r=>setTimeout(r,600));"
      + "Tools.open('plot');await new Promise(r=>setTimeout(r,1800));"
      + "const b=[...document.querySelectorAll('#tool-body [data-tabs] button')].find(x=>x.textContent.indexOf('剧情线')>=0);"
      + "if(b) b.click();await new Promise(r=>setTimeout(r,1500));return 1;})()" },
    { id: 'deep-model-test', code: "(async()=>{Tools.open('models');await new Promise(r=>setTimeout(r,2400));"
      + "const b=document.getElementById('mdl-testdef');if(b){b.click();await new Promise(r=>setTimeout(r,6000));}return 1;})()" },
  ];
  for (const d of DEEP) {
    try { await js(d.code); console.log('    深点一下：' + d.id); }
    catch (e) { console.log('    ! ' + d.id + ' 点不动：' + String(e && e.message).slice(0, 60)); }
  }

  /* 从网络事件里把真打过的接口捞出来 */
  const called = {};
  s.events.forEach((m) => {
    if (m.method !== 'Network.requestWillBeSent') return;
    const u = (m.params && m.params.request && m.params.request.url) || '';
    if (!/\/api\//.test(u)) return;
    const n = normalize(u);
    called[n] = (called[n] || 0) + 1;
  });
  const calledList = Object.keys(called);
  routes.forEach((r) => {
    const hit = calledList.some((u) => sameShape(u, r.path));
    if (hit) rep.hits.push(r);
    else rep.unhit.push(r);
  });
  /* 静态也搜不到的，才算"真候选"（拿上一轮的静态核查报告对账） */
  try {
    const st = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/接口未露面核查.json'), 'utf8'));
    const staticSet = {};
    (st.missing || []).forEach((x) => { staticSet[x.method + ' ' + x.path] = true; });
    rep.staticMissing = rep.unhit.filter((r) => staticSet[r.method + ' ' + r.path]);
  } catch (e) { rep.staticMissing = []; }
  rep.calledShapes = calledList.sort();
  rep.summary = { routes: routes.length, hit: rep.hits.length, unhit: rep.unhit.length,
                  staticMissing: rep.staticMissing.length };
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 1));
  console.log('  路由 %d：这次真打到 %d，没打到 %d（其中静态也搜不到的"真候选" %d）',
    rep.summary.routes, rep.summary.hit, rep.summary.unhit, rep.summary.staticMissing);
  rep.staticMissing.forEach((r) => console.log('    ? ' + r.method + ' ' + r.path));
  console.log('  报告：docs/接口实跑核查.json');
  await s.close();
  process.exit(0);
})();
