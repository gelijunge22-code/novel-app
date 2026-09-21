/* ============================================================
   e2e-pl.js — 第 19 轮：把两条「后端有接口、界面上找不到入口」的接口接上并实测
     （第 19 轮做接口核查时查出来的真候选：300 条路由里只有这 2 条真该接）

   PL1 剧情线 —— POST /api/plot/thread + DELETE /api/plot/thread
       后端 /plot/overview 早就把 threads 一并返回（连 counts.threads 都算好了），
       可剧情面板 4 个页签一条都不显示 → 数据白算，用户也没地方建。
       现在加第 5 个页签「剧情线」：能看、能加、能删、点开看它挂了哪些场景。

   PL1c~e【第 31 轮】—— 这一栏的作用改成**大纲**之后，从界面上验三件事：
       每行标着「谁定的」/「改」是两栏表单/改完算「你定的」且后端 origin=user。
       反证：PL_FORCE=noedit（抹掉「改」按钮）→ 这三条必须报红。

   PL2 模型连通自检 —— POST /api/config/models/test
       用户最想知道的一件事就是"现在这个模型到底通不通"。
       以前只能发一条消息碰运气；现在模型面板有「测一下」：真发一句话出去，回了就说通了 + 几秒，
       没通就把原因（密钥不对 / 地址不通 / 模型名不对）写出来。

   跑法：node tools/e2e-pl.js
         PL_FORCE=notab node tools/e2e-pl.js     # 反证：把「剧情线」页签的 data-tab 改坏 → 界面那几条必须报红
         PL_FORCE=nokey node tools/e2e-pl.js     # 反证：抹掉「测一下」的 data-tm → 「发出去的 key 对不对」必须报红
         PL_DEADTEST=1 node tools/e2e-pl.js      # 判据自己的单测：塞一条空点名 → 必须报红 exit=1
         PL_FORCE=noclean node tools/e2e-pl.js   # 反证：故意不删临时书 → 「清理」那条必须红（跑完手工收拾）
   产出：docs/接口接入实测.json（反证 → docs/接口接入实测-反证-<force>.json）
         docs/前端截图/pl-*.png（反证 → docs/截图判据反证/）
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { open, sleep } = require('./cdp');

const ROOT = '/home/ubuntu/novel-app';
const FORCE = process.env.PL_FORCE || '';
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8899/';
const SHOT = path.join(ROOT, FORCE ? 'docs/截图判据反证' : 'docs/前端截图');
const OUT = path.join(ROOT, FORCE ? ('docs/接口接入实测-反证-' + FORCE + '.json') : 'docs/接口接入实测.json');
let password = '';
try { password = JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
catch (e) { }

const R = [];
function chk(name, ok, detail) {
  R.push({ name, ok: !!ok, detail: detail === undefined ? '' : detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail !== undefined ? '   ' + JSON.stringify(detail) : ''));
}
/* 反证模式下，被点名的判据必须报红 —— 跑完在这里汇总"这条有没有真变红" */
/* ⚠ 点名册要跟判据的**真名字**对得上。第 31 轮实测：notab 里原来写的是 /界面：加一条/ 和 /界面：删掉/，
   而真名字是「PL1 界面：点「加一条剧情线」…」「PL1 界面：点「删」…」—— 差一个「点」「「」」，
   于是**这两条反证一直是空的**（匹配不上任何判据，脚本却照样绿）。现在按真名字写，
   并且下面加了"空点名"检查：点名册里哪条一条都没匹配上，直接判红。 */
const FORCE_MUST_FAIL = FORCE === 'notab' ? [/界面：点「剧情线」/, /界面：点「加一条剧情线」/, /界面：点「删」/]
  : FORCE === 'nokey' ? [/PL2 界面：点「测一下」/]
  /* noedit：抹掉「改」按钮 —— 这一栏现在是**大纲**，用户能不能改它、改完算不算「你定的」，
     必须因此报红（不然那几条判据是空的） */
  : FORCE === 'noedit' ? [/PL1c /, /PL1d /, /PL1e /]
  /* noclean：故意留着临时书 → 「清理：两本临时书删干净了」必须红（这条以前读错键，永远绿） */
  : FORCE === 'noclean' ? [/清理：两本临时书删干净了/] : [];
/* 判据自己的单测：PL_DEADTEST=1 时**故意**往点名册里塞一条匹配不上任何判据的写法，
   上面那个"空点名"检查必须因此报红（不然那条检查本身也是空的）。
   跑法：PL_FORCE=noedit PL_DEADTEST=1 node tools/e2e-pl.js   → 必须 exit=1 且点名 dead 1 条 */
if (process.env.PL_DEADTEST) FORCE_MUST_FAIL.push(/这条判据根本不存在/);

(async () => {
  fs.mkdirSync(SHOT, { recursive: true });
  const s = await open({ port: 9393, width: 390, height: 844, settle: 900 });
  const js = s.js;
  const stamp = Date.now().toString().slice(-6);
  const BOOK = '测试·接口接入-' + stamp;
  const OTHER = '测试·接口对照-' + stamp;
  const T1 = '主线·唐三复仇-' + stamp;          // 后端建的
  const T2 = '支线·小舞身世-' + stamp;          // 界面上建的

  await s.nav(BASE + '?pl=' + Date.now());
  for (let i = 0; i < 40; i++) {
    const g = await js("(()=>{const sp=document.getElementById('splash');return !!(sp&&(sp.classList.contains('gone')||getComputedStyle(sp).opacity==='0'));})()");
    if (g) break; await sleep(120);
  }
  if (await js("document.getElementById('login') && !document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(password)
      + ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4200);
  }
  const api = (p, o) => js("(async()=>{try{const r=await API.nb(" + JSON.stringify(p) + ", " + JSON.stringify(o || null)
    + "); return r;}catch(e){return {__err:String(e && e.message || e)};}})()");

  const b1 = await api('api/projects', { method: 'POST', body: { title: BOOK, summary: '接口接入实测，用完就删' } });
  const b2 = await api('api/projects', { method: 'POST', body: { title: OTHER, summary: '隔离对照，用完就删' } });
  const S1 = b1 && b1.slug, S2 = b2 && b2.slug;
  chk('建两本临时书', !!S1 && !!S2, { S1, S2 });
  if (!S1 || !S2) { s.close(); fs.writeFileSync(OUT, JSON.stringify({ items: R }, null, 1)); process.exit(1); }
  const CH = ['manuscript/第001章-起点.md', 'manuscript/第002章-中段.md'];
  for (let i = 0; i < 2; i++) {
    await api('api/chapter/new', { method: 'POST', body: { slug: S1, path: CH[i], content: '# 第' + (i + 1) + '章\n\n唐三点起灯。\n' } });
    await api('api/chapter/new', { method: 'POST', body: { slug: S2, path: CH[i], content: '# 第' + (i + 1) + '章\n\n别人写的另一本。\n' } });
  }

  /* ═══════════ PL1 剧情线 · 后端 ═══════════ */
  const ov0 = await api('api/plot/overview?slug=' + encodeURIComponent(S1));
  const c0 = (ov0 && ov0.counts && ov0.counts.threads) || 0;
  chk('PL1 后端：新书一开始没有剧情线', c0 === 0 && !(ov0.threads || []).some((t) => t.name === T1), c0);

  const mk = await api('api/plot/thread', { method: 'POST', body: { slug: S1, name: T1, kind: 'main', status: 'open', scenes: [CH[1]] } });
  chk('PL1 后端：POST /plot/thread 建得了', !!(mk && mk.id), mk && (mk.id || mk.__err));
  const ov1 = await api('api/plot/overview?slug=' + encodeURIComponent(S1));
  const t1 = (ov1.threads || []).find((t) => t.name === T1) || {};
  chk('PL1 后端：/plot/overview 里真回来了（counts.threads 也跟着 +1）',
    t1.name === T1 && ((ov1.counts || {}).threads === c0 + 1), { threads: (ov1.threads || []).length, counts: (ov1.counts || {}).threads });
  chk('PL1 后端：建的时候挂的场景存住了', (t1.scenes || []).length === 1 && t1.scenes[0] === CH[1], t1.scenes);

  const dup = await api('api/plot/thread', { method: 'POST', body: { slug: S1, name: T1 } });
  chk('PL1 后端：同名再建一条会被拦住（不许两条重名）', !!dup.__err, dup.__err || dup);

  const ov2 = await api('api/plot/overview?slug=' + encodeURIComponent(S2));
  chk('PL1 后端【按书隔离】：另一本书里没有这条剧情线',
    !(ov2.threads || []).some((t) => t.name === T1), (ov2.threads || []).map((t) => t.name));

  /* ═══════════ PL1 界面：工具 → 剧情 → 剧情线 ═══════════ */
  await js("(async()=>{ BookCtx.set(" + JSON.stringify(S1) + "," + JSON.stringify(BOOK) + "); return 1; })()");
  await sleep(400);
  await js("(async()=>{App.show('tools');await new Promise(r=>setTimeout(r,600)); Tools.open('plot');"
    + " await new Promise(r=>setTimeout(r,1800)); return 1;})()");
  await sleep(600);
  const tabs = await js("(()=>[...document.querySelectorAll('#tool-body [data-tabs] button')].map(b=>b.textContent.trim()))()");
  chk('PL1 界面：剧情面板里多了「剧情线」这个页签',
    Array.isArray(tabs) && tabs.some((x) => x.indexOf('剧情线') >= 0), tabs);

  if (FORCE === 'notab') {
    /* 反证：把页签的 data-tab 改坏（点的是同一颗按钮，走的是错的页签名 → 会回落到承载树）。
       这一轮「点剧情线出剧情线列表」必须报红，报绿就说明那条判据是空的。 */
    await js("(()=>{const b=[...document.querySelectorAll('#tool-body [data-tabs] button')].find(x=>x.textContent.indexOf('剧情线')>=0);"
      + "if(b) b.dataset.tab='threadsX'; return 1})()");
    console.log('  ⚠ 反证模式 PL_FORCE=notab：已把「剧情线」的 data-tab 改坏（界面判据必须报红）');
    await sleep(200);
  }

  const tapThreads = "(async()=>{const b=[...document.querySelectorAll('#tool-body [data-tabs] button')].find(x=>x.textContent.indexOf('剧情线')>=0);"
    + " if(!b) return '没页签'; b.click(); await new Promise(r=>setTimeout(r,1200)); return 1;})()";
  await js(tapThreads);
  await sleep(300);
  const uiTh = await js("(()=>{const pane=document.querySelector('#tool-body [data-pane]'); if(!pane) return {miss:1};"
    + "return {titles:[...pane.querySelectorAll('.t-row .tr-title')].map(x=>x.textContent.trim()),"
    + " text:pane.textContent.slice(0,120), has:pane.textContent.indexOf(" + JSON.stringify(T1) + ")>=0};})()");
  await s.shot(path.join(SHOT, 'pl-01-剧情线页签.png'));
  chk('PL1 界面：点「剧情线」→ 面板里出现后端里那条（真读后端，不是写死的空表）',
    uiTh && uiTh.has === true, uiTh && { titles: uiTh.titles });

  /* 界面上加一条 */
  const uiAdd = await js("(async()=>{const pane=document.querySelector('#tool-body [data-pane]');"
    + " const btn=pane && pane.querySelector('[data-newth]'); if(!btn) return '没加号按钮'; btn.click();"
    + " await new Promise(r=>setTimeout(r,500));"
    + " const d=document.querySelector('.t-dialog'); if(!d) return '没弹输入框';"
    + " const i=d.querySelector('.t-input'); i.value=" + JSON.stringify(T2) + "; i.dispatchEvent(new Event('input',{bubbles:true}));"
    + " d.querySelector('[data-yes]').click();"
    + " await new Promise(r=>setTimeout(r,2000));"
    + " const p2=document.querySelector('#tool-body [data-pane]');"
    + " return {has:p2.textContent.indexOf(" + JSON.stringify(T2) + ")>=0, titles:[...p2.querySelectorAll('.t-row .tr-title')].map(x=>x.textContent.trim())};})()");
  await s.shot(path.join(SHOT, 'pl-02-界面加一条.png'));
  chk('PL1 界面：点「加一条剧情线」→ 填名字 → 列表里真多一条', uiAdd && uiAdd.has === true, uiAdd);

  /* ── PL1c~e：这一栏现在是**大纲**（第 31 轮用户点名改的作用）─────────────
     看三件事：① 每行标着「谁定的」② 「改」是个两栏表单（叫什么 / 这条线怎么走）
     ③ 改完那一行算「你定的」，后端真存成 origin=user。 */
  if (FORCE === 'noedit') {
    /* 反证：把「改」按钮的 data-editth 抹掉（模拟"这一栏只能看不能改"）→ PL1c/d/e 必须报红 */
    await js("(()=>{document.querySelectorAll('#tool-body [data-pane] [data-editth]').forEach(b=>{"
      + "b.removeAttribute('data-editth');}); return 1})()");
    console.log('  ⚠ 反证模式 PL_FORCE=noedit：已把「改」按钮的 data-editth 抹掉');
    await sleep(200);
  }
  const uiBadge = await js("(()=>{const rows=[...document.querySelectorAll('#tool-body [data-pane] .t-row')];"
    + " const row=rows.find(r=>r.textContent.indexOf(" + JSON.stringify(T2) + ")>=0); if(!row) return {miss:1};"
    + " const pane=document.querySelector('#tool-body [data-pane]');"
    + " return {badge:((row.querySelector('.t-pill')||{}).textContent||'').trim(),"
    + " hasEdit:!!row.querySelector('[data-editth]'),"
    + " hint:(pane.querySelector('.t-hint')||{}).textContent||''};})()");
  /* ⚠ 取不到那一行时（比如反证模式下这一页根本没渲染出来）返回的是 {miss:1} ——
     直接 .indexOf 会**把判据脚本自己弄崩**（第 31 轮实测：PL_FORCE=notab 跑挂在这儿）。
     判据脚本塌了跟"判据报红"不是一回事：崩了后面所有条都不跑，看起来像"没这条判据"。 */
  chk('PL1c 界面：每一行都标着「谁定的」（你定的 / AI 补的），说明自己是当大纲用的',
    !!uiBadge && !!uiBadge.badge && uiBadge.badge.indexOf('你定的') >= 0 && uiBadge.hasEdit === true
      && !!uiBadge.hint && uiBadge.hint.indexOf('大纲') >= 0 && uiBadge.hint.indexOf('你为准') >= 0,
    uiBadge);

  const NEWSUM = '改过的走向·' + stamp;
  const uiEdit = await js("(async()=>{const rows=[...document.querySelectorAll('#tool-body [data-pane] .t-row')];"
    + " const row=rows.find(r=>r.textContent.indexOf(" + JSON.stringify(T2) + ")>=0); if(!row) return '没那一行';"
    + " const b=row.querySelector('[data-editth]'); if(!b) return '没改按钮'; b.click();"
    + " await new Promise(r=>setTimeout(r,600));"
    + " const d=document.querySelector('.t-dialog'); if(!d) return '没弹表单';"
    + " const n=d.querySelectorAll('.t-input'), a=d.querySelectorAll('.t-area');"
    + " if(!n.length||!a.length) return {bad:'字段不对 input=' + n.length + ' area=' + a.length};"
    + " a[0].value=" + JSON.stringify(NEWSUM) + "; a[0].dispatchEvent(new Event('input',{bubbles:true}));"
    + " d.querySelector('[data-yes]').click();"
    + " await new Promise(r=>setTimeout(r,2400));"
    + " const p2=document.querySelector('#tool-body [data-pane]');"
    + " const row2=[...p2.querySelectorAll('.t-row')].find(r=>r.textContent.indexOf(" + JSON.stringify(T2) + ")>=0);"
    + " return {fields:{input:n.length,area:a.length},"
    + " hasNew:p2.textContent.indexOf(" + JSON.stringify(NEWSUM) + ")>=0,"
    + " badge:row2 ? ((row2.querySelector('.t-pill')||{}).textContent||'').trim() : ''};})()");
  await s.shot(path.join(SHOT, 'pl-04-大纲-改一条.png'));
  chk('PL1d 界面：点「改」→ 两栏（叫什么 / 这条线怎么走）→ 存下来 → 列表里是新写的',
    !!uiEdit && uiEdit.hasNew === true && uiEdit.fields && uiEdit.fields.area >= 1
      && !!uiEdit.badge && uiEdit.badge.indexOf('你定的') >= 0, uiEdit);

  const ov4 = await api('api/plot/overview?slug=' + encodeURIComponent(S1));
  const rowB = (ov4.threads || []).find((t) => t.name === T2) || {};
  chk('PL1e 后端：界面上改过的那条，库里真记成「你定的」（origin=user）+ 存的是新写的',
    rowB.origin === 'user' && String(rowB.summary || '').indexOf(NEWSUM) >= 0,
    { origin: rowB.origin, summary: String(rowB.summary || '').slice(0, 60) });

  /* 界面上删掉它 */
  const uiDel = await js("(async()=>{const rows=[...document.querySelectorAll('#tool-body [data-pane] .t-row')];"
    + " const row=rows.find(r=>r.textContent.indexOf(" + JSON.stringify(T2) + ")>=0); if(!row) return '没那一行';"
    + " const b=row.querySelector('[data-rmth]'); if(!b) return '没删按钮'; b.click();"
    + " await new Promise(r=>setTimeout(r,500));"
    + " const d=document.querySelector('.t-dialog'); if(!d) return '没确认框';"
    + " d.querySelector('[data-yes]').click();"
    + " await new Promise(r=>setTimeout(r,2000));"
    + " const p2=document.querySelector('#tool-body [data-pane]');"
    + " return {has:p2.textContent.indexOf(" + JSON.stringify(T2) + ")>=0};})()");
  chk('PL1 界面：点「删」→ 确认 → 列表里没了', uiDel && uiDel.has === false, uiDel);
  const ov3 = await api('api/plot/overview?slug=' + encodeURIComponent(S1));
  chk('PL1 后端：界面上删掉的，后端也真删了（不是只从屏幕上抹掉）',
    !(ov3.threads || []).some((t) => t.name === T2), (ov3.threads || []).map((t) => t.name));

  /* 换本书：界面上也要跟着隔离 */
  await js("(async()=>{ BookCtx.set(" + JSON.stringify(S2) + "," + JSON.stringify(OTHER) + "); return 1; })()");
  await sleep(500);
  await js("(async()=>{ Tools.open('plot'); await new Promise(r=>setTimeout(r,1800)); return 1;})()");
  await js(tapThreads);
  await sleep(400);
  const uiIso = await js("(()=>{const pane=document.querySelector('#tool-body [data-pane]'); if(!pane) return {miss:1};"
    + "return {hasOther:pane.textContent.indexOf(" + JSON.stringify(T1) + ")>=0};})()");
  await s.shot(path.join(SHOT, 'pl-03-换书隔离.png'));
  chk('PL1 界面【按书隔离】：换到另一本，看不到上一本的剧情线', uiIso && uiIso.hasOther === false, uiIso);

  /* ═══════════ PL2 模型连通自检 ═══════════ */
  const tDef = await api('api/config/models/test', { method: 'POST', body: {} });
  chk('PL2 后端：不传模型 → 测的是"现在用的那个"，真发出一句话并回来了',
    !!(tDef && tDef.ok === true && String(tDef.reply || '').trim().length > 0),
    tDef && { ok: tDef.ok, ms: tDef.ms, reply: tDef.reply, error: tDef.error });

  const lib = await api('api/config/models/library');
  const anyModel = ((lib && lib.models) || [])[0] || {};
  const key0 = anyModel.source ? (anyModel.source + '/' + anyModel.id) : '';
  const tOne = key0 ? await api('api/config/models/test', { method: 'POST', body: { modelKey: key0 } }) : null;
  chk('PL2 后端：指定模型测 —— 回了就写"通"，没回就写清楚原因（不许静默失败）',
    !!(tOne && (tOne.ok === true || (tOne.ok === false && String(tOne.error || '').trim().length > 0))),
    tOne && { key: key0, ok: tOne.ok, ms: tOne.ms, error: String(tOne.error || '').slice(0, 80) });

  const tBad = await api('api/config/models/test', { method: 'POST', body: { modelKey: '没有这家供应商/没有这个模型' } });
  chk('PL2 后端：乱填一个模型名 → 报"连不上 + 原因"，不会假装成功',
    !!(tBad && tBad.ok === false && String(tBad.error || '').trim().length > 0), tBad);

  await js("(async()=>{ App.show('tools'); await new Promise(r=>setTimeout(r,600)); Tools.open('models');"
    + " await new Promise(r=>setTimeout(r,2600)); return 1;})()");
  await sleep(700);
  const hasBtn = await js("(()=>({def: !!document.getElementById('mdl-testdef'), rows: document.querySelectorAll('[data-tm]').length}))()");
  chk('PL2 界面：模型面板上有「测一下现在用的模型」+ 每个模型一行一个「测一下」',
    !!(hasBtn && hasBtn.def && hasBtn.rows > 3), hasBtn);

  const defRun = await js("(async()=>{const b=document.getElementById('mdl-testdef'); b.click();"
    + " await new Promise(r=>setTimeout(r,6000));"
    + " const box=document.getElementById('mdl-testres'); const t=(box?box.textContent:'').trim();"
    + " return {txt:t.slice(0,140), btn:b.textContent.trim(), ok:/通了/.test(t)};})()");
  await s.shot(path.join(SHOT, 'pl-04-模型测一下.png'));
  chk('PL2 界面：点「测一下现在用的模型」→ 面板里写出结果（通了/连不上 + 原因）',
    !!(defRun && /通了|连不上|还没选模型/.test(defRun.txt) && defRun.ok === true), defRun);

  if (FORCE === 'nokey') {
    /* 反证：抹掉「测一下」按钮上的 data-tm（模型 key）→ 发出去的就是空 key，
       "发出去的 key 跟这一行对不对得上"这条判据必须报红。 */
    await js("(()=>{document.querySelectorAll('[data-tm]').forEach(b=>{b.setAttribute('data-tm','');}); return 1})()");
    console.log('  ⚠ 反证模式 PL_FORCE=nokey：已把每个模型行的 data-tm 清空（判据必须报红）');
    await sleep(200);
  }

  const rowRun = await js("(async()=>{const b=document.querySelector('[data-tm]'); if(!b) return {miss:1};"
    + " const key=b.getAttribute('data-tm');"
    + " window.__plcalls=[]; const orig=window.API.nb;"
    + " window.API.nb=(p,o)=>{ if(String(p).indexOf('/models/test')>=0) window.__plcalls.push(((o||{}).body||{}).modelKey||''); return orig(p,o); };"
    + " b.click(); await new Promise(r=>setTimeout(r,7000)); window.API.nb=orig;"
    + " const box=document.getElementById('mdl-testres');"
    + " return {key:key, calls:window.__plcalls, btn:b.textContent.trim(), txt:(box?box.textContent:'').trim().slice(0,120)};})()");
  await s.shot(path.join(SHOT, 'pl-05-测指定模型.png'));
  /* 判据要独立于"按钮上的那个属性"：把模型库的 key 集合（后端给的真值）拿来比 ——
     只写"发出去的 === 属性上写的"是自证（属性被清空时两边一起变空，永远绿）。 */
  const libKeys = ((lib && lib.models) || []).map((m) => m.source + '/' + m.id);
  /* 只留这一条，而且是**独立真值源**判的：发出去的 key 必须①跟这一行写的一致、②在模型库里真实存在。
     （单独一条"发出去的 === 按钮属性上写的"是**自证** —— 属性被清空时两边一起变空，永远绿，
       反证跑证实过：那种判据 UICHK 式的假绿。所以不写它。） */
  chk('PL2 界面：点「测一下」发出去的就是这一行的模型（库里真有这个 key）',
    !!(rowRun && Array.isArray(rowRun.calls) && rowRun.calls.length === 1
       && rowRun.calls[0] && rowRun.calls[0] === rowRun.key && libKeys.indexOf(rowRun.calls[0]) >= 0),
    rowRun && { key: rowRun.key, sent: rowRun.calls, inLib: rowRun.calls && libKeys.indexOf(rowRun.calls[0]) >= 0 });

  /* 收尾：删临时书（只删这两本，用户的书一个字不动） */
  if (FORCE === 'noclean') {
    console.log('  ⚠ 反证模式 PL_FORCE=noclean：故意不删临时书 → 「清理」那条必须报红');
  } else {
    for (const sl of [S1, S2]) {
      const d = await api('api/book/delete', { method: 'POST', body: { slug: sl } });
      if (d && d.__err) console.log('  清理 ' + sl + ' 失败：' + d.__err);
    }
  }
  /* ⚠ 第 31 轮查出来的**假绿**：`/api/shelf` 返回的键是 `projects`，这里原来读的是 `left.items`
     —— 永远是 undefined，`.some()` 落在空数组上，于是"删干净了"**永远绿**，
     连"两本临时书还挂在你书架上"都看不出来（实测真留了 4 本）。改成读 `projects`。 */
  const left = await api('api/shelf');
  const rows = (left && (left.projects || left.items)) || [];
  chk('清理：两本临时书删干净了（用户那本还在）',
    !rows.some((x) => x.slug === S1 || x.slug === S2), rows.map((x) => x.slug));

  /* 反证汇总：被点名的判据必须真变红 */
  const bad = R.filter((x) => !x.ok);
  if (FORCE) {
    const hit = R.filter((x) => FORCE_MUST_FAIL.some((re) => re.test(x.name)));
    const red = hit.filter((x) => !x.ok);
    /* 空点名：点名册里某条一条判据都没匹配上（名字写错了 / 判据被删了）——
       那等于"这条反证根本不存在"，必须报红，不能混过去。 */
    const dead = FORCE_MUST_FAIL.filter((re) => !R.some((x) => re.test(x.name))).map(String);
    console.log('\n  ⚠ 反证校验：被点名的 ' + hit.length + ' 条里，' + red.length + ' 条报红'
      + (dead.length ? '；空点名 ' + dead.length + ' 条：' + JSON.stringify(dead) : ''));
    chk('反证：点名册每一条都匹配到了判据、且匹配上的都报红了（没有空点名）',
      dead.length === 0 && hit.length > 0 && red.length > 0,
      { hit: hit.map((x) => x.name), red: red.map((x) => x.name), dead });
  }

  const bad2 = R.filter((x) => !x.ok);
  const rep = { at: new Date().toISOString(), base: BASE, round: 'pl', force: FORCE || '(正常)',
    total: R.length, fails: bad2.length, items: R };
  fs.writeFileSync(OUT, JSON.stringify(rep, null, 1));
  /* 退出码：正常跑 = 全过才算过；反证跑 = "被点名的判据报红了"才算过（报绿就是空判据） */
  let code;
  if (FORCE) {
    const named = R.filter((x) => FORCE_MUST_FAIL.some((re) => re.test(x.name)));
    const dead = FORCE_MUST_FAIL.filter((re) => !R.some((x) => re.test(x.name)));
    code = (dead.length === 0 && named.length > 0 && named.some((x) => !x.ok)) ? 0 : 1;
    console.log('\n反证跑：被点名 ' + named.length + ' 条，报红 ' + named.filter((x) => !x.ok).length + ' 条 → ' + OUT);
  } else {
    code = bad2.length ? 1 : 0;
    console.log('\n' + (bad2.length ? '有 ' + bad2.length + ' 条没过' : '全部通过（' + R.length + ' 条）') + ' → ' + OUT);
  }
  s.close();
  process.exit(code);
})().catch((e) => { console.error('跑挂了：', e); process.exit(2); });
