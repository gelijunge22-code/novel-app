/* ============================================================
   e2e-studio.js — 新面板（写作台/世界/剧情/质检/统计/导出/听书/术语/素材/数据）走查：
   真浏览器 390×844 打开每一件、逐个页签点过去、截图，并检查：
     · 控制台报错 / 页面异常 / 失败请求
     · 每个面板都能返回（顶部返回键在）
     · 页面不横向溢出（390 宽的手机上不许出滚动条）
     · 深浅主题各截一张
   用法：node tools/e2e-studio.js
   ============================================================ */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const ROOT = '/home/ubuntu/novel-app';
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8899/';
const OUTJSON = path.join(ROOT, 'docs/前端走查-新面板.json');
const SHOTDIR = path.join(ROOT, 'docs/前端截图');
const { shelfShield, pickCardExpr, shieldOnly } = require('./preflight');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PANELS = ['write', 'world', 'plot', 'lint', 'prompt', 'stats', 'export', 'listen', 'term',
  'material', 'logs', 'notes', 'sync', 'models'];

function readPassword() {
  try {
    const cfg = JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8'));
    return cfg.app_password || cfg.password || '';
  } catch (e) { return ''; }
}

(async () => {
  fs.mkdirSync(SHOTDIR, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-studio-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--hide-scrollbars', '--remote-debugging-port=9335', '--window-size=390,844',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try { targets = await (await fetch('http://127.0.0.1:9335/json/list')).json(); if (targets && targets.length) break; } catch (e) {}
  }
  if (!targets) { console.error('chrome 起不来'); process.exit(1); }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const waiting = new Map();
  const consoleErrors = []; const exceptions = []; const netFails = []; const apiCalls = {};
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      consoleErrors.push({ level: m.params.type, text: (m.params.args || []).map((a) => a.value || a.description || a.type).join(' ').slice(0, 300) });
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      exceptions.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 400));
    } else if (m.method === 'Network.responseReceived') {
      const r = m.params.response; const u = r.url.replace(BASE.replace(/\/$/, ''), '');
      if (u.startsWith('/api') || u.startsWith('/nb/api')) {
        const key = u.split('?')[0] + ' [' + m.params.type + ']';
        apiCalls[key] = (apiCalls[key] || 0) + 1;
        if (r.status >= 400) netFails.push({ status: r.status, url: u.slice(0, 200) });
      }
    }
  };
  const send = (method, params) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });

  const js = async (expr, wait) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (wait) await sleep(wait);
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const kit = require('./shotkit')({ send, dir: SHOTDIR, round: 'r10' });
  const shot = (name) => kit.shoot(name);
  const log = [];
  const step = async (name, expr, wait) => {
    const before = netFails.length, ce = consoleErrors.length, ex = exceptions.length;
    const r = expr ? await js(expr, wait === undefined ? 1500 : wait) : null;
    await shot(name);
    const row = { step: name, result: r, newFails: netFails.slice(before),
      newConsole: consoleErrors.slice(ce), newExceptions: exceptions.slice(ex) };
    log.push(row);
    const bad = row.newFails.length + row.newConsole.length + row.newExceptions.length;
    console.log('  ·', name, r && r.__err ? ('JS错误 ' + r.__err) : '', bad ? ('⚠ 问题 ' + bad) : '');
    return r;
  };
  const overflow = () => js("(()=>{const d=document.documentElement;const b=document.getElementById('tool-body')||document.body;return {doc:d.scrollWidth, win:innerWidth, body:b.scrollWidth, bodyW:b.clientWidth};})()");

  await send('Page.navigate', { url: BASE + '?studio=' + Date.now() });
  await sleep(5000);
  if (await js("!document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword()) + ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4000);
    console.log('  · 登录 ok');
  }
  await js("document.querySelector('#tabbar [data-tab=\"tools\"]').click()", 1500);

  const overflowIssues = [];
  for (const t of PANELS) {
    const opened = await js("(()=>{const e=document.querySelector('#tools-body [data-id=\"" + t + "\"]');if(!e)return 'missing';e.click();return 1})()", 2600);
    if (opened === 'missing') { log.push({ step: 'open-' + t, result: 'missing' }); console.log('  · 缺少卡片', t); continue; }
    const tab = await js("document.body.dataset.tab");
    /* 返回入口：工具面板用的是左上的 **← 返回**（`data-act="tool-back"`），
       不是右上角的 ×。原来这里叫 hasX，其实压根没验过 ×（只验了返回箭头）——
       报告里写着一个没验的事，比不验还坏，所以改名叫 hasBackEntry，并把到底是哪种也记下来。
       为什么工具面板不摆 ×：← 和 × 是同一个动作（离开这一屏），两个都摆 = 拥挤；
       抽屉/弹层（sheet / modal）那边本来就有 ×（`data-close`），那是它们该有的样式。 */
    const hasBack = await js("!!document.querySelector('#screen-tool [data-act=\"tool-back\"]')");
    const closeKind = await js("(() => { const s = document.getElementById('screen-tool'); if (!s) return '';"
      + " const x = s.querySelector('[data-act=\"close\"]'); if (x) return '×';"
      + " return s.querySelector('[data-act=\"tool-back\"]') ? '←' : ''; })()");
    const hasBackEntry = !!closeKind;
    const ov = await overflow();
    if (ov && ov.body > ov.bodyW + 1) overflowIssues.push({ tool: t, ...ov });
    await shot('st-' + t);
    log.push({ step: 'open-' + t, tab, hasBack, closeKind, hasBackEntry, overflow: ov, result: 1 });
    console.log('  · 开面板', t, 'tab=' + tab, 'overflow=' + (ov ? ov.body + '/' + ov.bodyW : '?'));
    // 逐个页签点过去（每件工具最多 5 个页签）
    const tabs = await js("Array.from(document.querySelectorAll('#tool-body [data-tabs] button')).map(b=>b.getAttribute('data-tab'))") || [];
    for (const k of tabs) {
      await step('st-' + t + '-' + k, "(()=>{const b=document.querySelector('#tool-body [data-tabs] button[data-tab=\"" + k + "\"]');if(!b)return 'no';b.click();return 1})()", 2200);
      const o2 = await overflow();
      if (o2 && o2.body > o2.bodyW + 1) overflowIssues.push({ tool: t, tab: k, ...o2 });
    }
    await js("(()=>{const b=document.querySelector('#screen-tool [data-act=\"tool-back\"]');if(b)b.click();return 1})()", 900);
  }

  // 深浅主题各来一张（用统计面板当样板）
  await js("document.querySelector('#tabbar [data-tab=\"tools\"]').click()", 800);
  await js("document.querySelector('#tools-body [data-id=\"stats\"]').click()", 2500);
  for (const th of ['paper', 'sepia', 'slate', 'night']) {
    await js("Prefs.set('theme', '" + th + "');1", 700);
    await shot('theme-' + th + '-stats');
    log.push({ step: 'theme-' + th, result: 'ok' });
    console.log('  · 主题', th);
  }
  /* 「跟随系统」：真的去改系统的深浅色偏好，看主题自己跟不跟 */
  const themeChecks = {};
  for (const [scheme, want] of [['dark', 'night'], ['light', 'paper']]) {
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await js("Prefs.set('theme','auto');1", 700);
    const got = await js('document.documentElement.dataset.theme');
    themeChecks['系统' + (scheme === 'dark' ? '深色' : '浅色') + '→主题'] = got;
    await shot('theme-auto-' + scheme + '-stats');
    console.log('  · 跟随系统（' + scheme + '）→ 实际主题', got, got === want ? 'OK' : '⚠ 期望 ' + want);
  }
  await send('Emulation.setEmulatedMedia', { features: [] });
  await js("Prefs.set('theme','paper');1", 400);

  /* 提示词面板：走一遍真流程 —— 改一版 → 历史 → 对比 → 恢复内置 → 清空历史。
     走完必须把自测改动清干净（用户的提示词库不能被自测污染）。 */
  await js("document.querySelector('#tabbar [data-tab=\"tools\"]').click()", 800);
  await js("(()=>{const e=document.querySelector('#tools-body [data-id=\"prompt\"]');if(e)e.click();return 1})()", 2600);
  await step('st-prompt-detail', "(()=>{const rows=document.querySelectorAll('#tool-body .t-row');if(!rows[1])return 'no-row';rows[1].click();return 1})()", 1600);
  await step('st-prompt-saved', "(()=>{const ta=document.querySelector('#pm-body');if(!ta)return 'no-area';" +
    "ta.value=ta.value+'\\n【自测】这一行是走查加的，跑完会删掉。';ta.dispatchEvent(new Event('input',{bubbles:true}));" +
    "document.querySelector('#tool-body [data-save]').click();return 1})()", 900);
  const promptSaved = await js("(()=>{const w=document.querySelector('#tool-body .t-dialog .t-area,#tool-body .t-dialog .t-input');" +
    "if(!w)return 'no-dialog';w.value='走查自测';const y=document.querySelector('#tool-body .t-dialog [data-yes]');if(!y)return 'no-yes';y.click();return 1})()", 2000);
  console.log('  · 提示词保存对话框：', promptSaved);
  /* 再改一版，这样「对比」里才真的有增删可看（只有一版时对比是空的，那是正确行为） */
  await js("(()=>{const back=document.querySelector('#screen-tool [data-act=\"tool-back\"]');if(back)back.click();return 1})()", 1200);
  await js("(()=>{const rows=document.querySelectorAll('#tool-body .t-row');if(!rows[1])return 'no-row';rows[1].click();return 1})()", 1600);
  await js("(()=>{const ta=document.querySelector('#pm-body');if(!ta)return 'no-area';" +
    "ta.value=ta.value+'\\n【自测·第二版】这句是为了让对比有内容。';" +
    "document.querySelector('#tool-body [data-save]').click();return 1})()", 900);
  await js("(()=>{const w=document.querySelector('#tool-body .t-dialog .t-input');if(!w)return 'no-dialog';" +
    "w.value='走查自测第二版';document.querySelector('#tool-body .t-dialog [data-yes]').click();return 1})()", 2000);
  const promptHist = await step('st-prompt-hist', "(()=>{const b=document.querySelector('#tool-body [data-hist]');if(!b)return 'no-hist';b.click();return 1})()", 1800);
  await step('st-prompt-diff', "(()=>{const rs=document.querySelectorAll('#tool-body .t-row');const r=rs[1]||rs[0];if(!r)return 'no-version';r.click();return 1})()", 1800);
  const promptDiffLines = await js("document.querySelectorAll('#tool-body .st-diff > div').length");
  console.log('  · 对比里的差异行：', promptDiffLines);
  const promptCleaned = await js("(async()=>{" +
    "const j=async(p,o)=>{const r=await fetch(p,Object.assign({credentials:'include'},o||{}));return r.ok};" +
    "const SLUG=" + JSON.stringify(process.env.E2E_SLUG || 'example-book') + ";" +
    "for (const sc of [['book',SLUG],['global','']]) {" +
    "  for (const k of ['leader.default','writer','inline.editor','researcher','world.engine']) {" +
    "    await j('api/prompts/override?key='+encodeURIComponent(k)+'&scope='+sc[0]+" +
    "            (sc[1]?('&slug='+encodeURIComponent(sc[1])):''),{method:'DELETE'});" +
    "    await j('api/prompts/versions?key='+encodeURIComponent(k)+'&scope='+sc[0]+" +
    "            (sc[1]?('&slug='+encodeURIComponent(sc[1])):''),{method:'DELETE'}); }}" +
    "const one=async(u)=>{const r=await fetch(u,{credentials:'include'});const d=await r.json();" +
    "  return (d.items||[]).filter(i=>i.source!=='builtin').map(i=>i.key+':'+i.source)};" +
    "const a=await one('api/prompts');const b=await one('api/prompts?slug='+encodeURIComponent(SLUG));" +
    "return {global:a, book:b};})()");
  console.log('  · 提示词自测清理后仍未恢复内置的：', JSON.stringify(promptCleaned));
  await js("(()=>{const b=document.querySelector('#screen-tool [data-act=\"tool-back\"]');if(b)b.click();return 1})()", 900);

  /* 这一轮新加的东西：批量 / 流水线 / 模型组 / 冲突选择框 —— 都真点开看一眼。
     （模型组与批量是真的建/真的跑，逻辑在各自的自测脚本里；这里只看界面能不能用、报不报错。） */
  const newPanels = {};
  await js("document.querySelector('#tabbar [data-tab=\"tools\"]').click()", 800);
  await js("(()=>{const e=document.querySelector('#tools-body [data-id=\"write\"]');if(e)e.click();return 1})()", 2600);
  await step('st-batch', "(()=>{const b=document.querySelector('#tool-body [data-batch]');if(!b)return 'no-batch';b.click();return 1})()", 2200);
  newPanels.batchRows = await js("document.querySelectorAll('#tool-body [data-ch]').length");
  newPanels.batchModes = await js("document.querySelectorAll('#tool-body [data-modes] button').length");
  await step('st-batch-selected', "(()=>{const b=document.querySelector('#tool-body [data-all]');if(!b)return 'no-all';b.click();return 1})()", 1200);
  await js("(()=>{const b=document.querySelector('#screen-tool [data-act=\"tool-back\"]');if(b)b.click();return 1})()", 1200);
  await step('st-pipeline', "(()=>{const b=document.querySelector('#tool-body [data-pipe]');if(!b)return 'no-pipe';b.click();return 1})()", 2600);
  newPanels.pipelineRows = await js("document.querySelectorAll('#tool-body [data-i]').length");
  /* 打开一条流水线的「改步骤」：加一步 -> 上移 -> 删掉（改完不保存，不动全局配置） */
  await step('st-pipeline-edit', "(()=>{const r=document.querySelector('#tool-body [data-i]');if(!r)return 'no-row';" +
    "r.click();const e=document.querySelector('#tool-body [data-edit]');if(!e)return 'no-edit';e.click();return 1})()", 1800);
  newPanels.steps = await js("document.querySelectorAll('#tool-body [data-s]').length");
  await step('st-pipeline-addstep', "(()=>{const b=document.querySelector('#tool-body [data-add]');if(!b)return 'no-add';" +
    "b.click();return 1})()", 1000);
  await step('st-pipeline-stepmenu', "(()=>{const r=document.querySelector('#sheet-panel [data-k]');if(!r)return 'no-kind';" +
    "r.click();return 1})()", 1000);
  await js("(()=>{const b=document.querySelector('#screen-tool [data-act=\"tool-back\"]');if(b)b.click();return 1})()", 1200);
  await step('st-purposes', "(()=>{const b=document.querySelector('#tool-body [data-purposes]');if(!b)return 'no-purpose';" +
    "b.click();return 1})()", 1200);
  newPanels.purposeRows = await js("document.querySelectorAll('#sheet-panel .t-row').length");
  await js("App.closeSheet();1", 700);
  await js("(()=>{const b=document.querySelector('#screen-tool [data-act=\"tool-back\"]');if(b)b.click();return 1})()", 900);

  /* 模型组：面板里那个区块在不在（增删改查在 verify_model_sets.py 里真跑过） */
  await js("document.querySelector('#tabbar [data-tab=\"tools\"]').click()", 700);
  await js("(()=>{const e=document.querySelector('#tools-body [data-id=\"models\"]');if(e)e.click();return 1})()", 2600);
  await step('st-modelsets', "1", 1200);
  newPanels.modelSetBtn = await js("!!document.querySelector('#tool-body [data-msnew]')");
  /* 真走一遍：建组 → 给「写正文」挑一个模型 → 保存 → 启用 → 停用 → 删掉（跑完不留垃圾） */
  const MSNAME = '走查自测组-' + Date.now().toString().slice(-5);
  await js("(()=>{const b=document.querySelector('#tool-body [data-msnew]');if(b)b.click();return 1})()", 900);
  await js("(()=>{const i=document.querySelector('#tool-body .t-dialog input');if(!i)return 'no-input';" +
    "i.value=" + JSON.stringify(MSNAME) + ";document.querySelector('#tool-body .t-dialog [data-yes]').click();return 1})()", 2200);
  newPanels.setEditRows = await js("document.querySelectorAll('#tool-body [data-p]').length");
  await step('st-modelset-pick', "(()=>{const r=document.querySelector('#tool-body [data-p=\"writer\"]');if(!r)return 'no-row';" +
    "r.click();return 1})()", 1600);
  newPanels.pickModelRows = await js("document.querySelectorAll('#sheet-panel [data-k]').length");
  await js("(()=>{const r=document.querySelector('#sheet-panel [data-k]');if(!r)return 'no-k';r.click();return 1})()", 1400);
  await step('st-modelset-picked', "(()=>{const b=document.querySelector('#tool-body [data-save]');if(!b)return 'no-save';b.click();return 1})()", 1800);
  await js("(async()=>{const r=await fetch('api/model-sets',{credentials:'include'});const d=await r.json();" +
    "window.__ms=d;return 1})()", 900);
  newPanels.setSaved = await js("(window.__ms.sets||[]).some(x=>x.name===" + JSON.stringify(MSNAME) + ")");
  newPanels.setWriter = await js("((window.__ms.sets||[]).find(x=>x.name===" + JSON.stringify(MSNAME) + ")||{}).keys");
  await js("(()=>{const b=document.querySelector('#tool-body [data-act]');if(b)b.click();return 1})()", 1600);
  await js("(async()=>{const r=await fetch('api/model-sets',{credentials:'include'});window.__ms2=await r.json();return 1})()", 900);
  newPanels.setActivated = await js("window.__ms2.active===" + JSON.stringify(MSNAME));
  await js("(()=>{const b=document.querySelector('#tool-body [data-act]');if(b)b.click();return 1})()", 1600);
  await js("(()=>{const b=document.querySelector('#tool-body [data-del]');if(!b)return 'no-del';b.click();return 1})()", 900);
  await js("(()=>{const y=document.querySelector('#tool-body .t-dialog [data-yes]');if(!y)return 'no-yes';y.click();return 1})()", 1800);
  await js("(async()=>{const r=await fetch('api/model-sets',{credentials:'include'});window.__ms3=await r.json();return 1})()", 900);
  newPanels.setCleaned = await js("!(window.__ms3.sets||[]).some(x=>x.name===" + JSON.stringify(MSNAME) + ") && !window.__ms3.active");
  console.log('  · 模型组走查：', JSON.stringify({ saved: newPanels.setSaved, writer: newPanels.setWriter,
    activated: newPanels.setActivated, cleaned: newPanels.setCleaned }));
  await js("(()=>{const b=document.querySelector('#screen-tool [data-act=\"tool-back\"]');if(b)b.click();return 1})()", 900);

  /* 同步面板 + 冲突选择框（真冲突由 verify_sync.py 造并处理，这里验界面） */
  await js("document.querySelector('#tabbar [data-tab=\"tools\"]').click()", 700);
  await js("(()=>{const e=document.querySelector('#tools-body [data-id=\"sync\"]');if(e)e.click();return 1})()", 2400);
  await step('st-sync', "1", 1400);
  newPanels.syncPushBtn = await js("!!document.querySelector('#tool-body [data-push]')");
  await step('st-sync-conflict-sheet', "window.Tools.Conflicts.ask({id:0,localText:'手机这版：他在雪里站了很久。'," +
    "serverText:'服务器这版：他在雪里站着，没说话。'});1", 1200);
  newPanels.conflictButtons = await js("document.querySelectorAll('#sheet-panel [data-my],#sheet-panel [data-sv],#sheet-panel [data-merge]').length");
  await js("App.closeSheet();1", 600);
  await js("(()=>{const b=document.querySelector('#screen-tool [data-act=\"tool-back\"]');if(b)b.click();return 1})()", 900);

  /* 阅读器里的「记一笔」：打开笔记页签看一眼 */
  await js("document.querySelector('#tabbar [data-tab=\"shelf\"]').click()", 600);
  await shieldOnly('e2e-studio.js', BASE);      // 书架护栏：并发跑出来的红是假红
  await js(pickCardExpr('#shelf-list .book-card, #shelf-list [data-slug]'), 2600);
  await js("(()=>{if(window.Reader&&Reader.menu)Reader.menu();return 1})()", 1400);
  await step('st-reader-note-tab', "(()=>{const b=document.querySelector('#sheet-panel [data-t=\"note\"]');if(!b)return 'no-tab';b.click();return 1})()", 1600);
  await step('st-reader-note-sheet', "(()=>{const b=document.querySelector('#sheet-panel [data-a=\"note\"]');if(!b)return 'no-btn';b.click();return 1})()", 1200);
  newPanels.noteSheetArea = await js("!!document.querySelector('#sheet-panel .t-area')");
  await js("App.closeSheet();1", 600);
  console.log('  · 新面板小结', JSON.stringify(newPanels));

  // 设置页：主题一组够不够、改密码入口在不在、新主题下书架什么样
  await js("document.querySelector('#tabbar [data-tab=\"shelf\"]').click()", 700);
  for (const th of ['sepia', 'slate']) {
    await js("Prefs.set('theme','" + th + "');1", 600);
    await shot('theme-' + th + '-shelf');
    log.push({ step: 'theme-' + th + '-shelf', result: 'ok' });
  }
  await js("Prefs.set('theme','paper');1", 400);
  await step('settings', "App.show('settings');1", 1400);
  // 「主题」那一组 7 个选项：必须排得整齐（≤2 行、每行宽度一致），
  // 第 6 轮巡检亲眼看出来过"挤成三行、第三行只剩『夜间』孤零零靠右"。
  // 光看"横向没溢出"是查不出这种失衡的 —— 所以这里量几何。
  const segRows = await js(`(() => {
    const out = [];
    document.querySelectorAll('#screen-settings .seg.grid, .settings-body .seg.grid').forEach((seg) => {
      const bs = [...seg.querySelectorAll('button')];
      if (!bs.length) return;
      const rows = {};
      bs.forEach((b) => { const r = b.getBoundingClientRect();
        const key = Math.round(r.top / 4) * 4;
        (rows[key] = rows[key] || []).push(Math.round(r.width)); });
      out.push({ count: bs.length, rowCount: Object.keys(rows).length,
        rows: Object.values(rows).map((w) => ({ n: w.length, min: Math.min(...w), max: Math.max(...w) })),
        label: (seg.previousElementSibling && seg.previousElementSibling.className === 'k')
          ? seg.previousElementSibling.textContent : '' });
    });
    return JSON.stringify(out);
  })()`);
  let segGroups = [];
  try { segGroups = JSON.parse(segRows || '[]'); } catch (e) { segGroups = []; }
  const segBad = segGroups.filter((g) => g.rowCount > 2 ||
    g.rows.some((r) => r.max - r.min > 30) ||
    (g.count > 4 && g.rows.some((r) => r.n === 1)));
  const segGridForReport = segGroups;                // 存进报告，便于复查
  if (!segGroups.length) console.log('  ！ 设置页没找到 .seg.grid（选择器过时了？）');
  segBad.forEach((g) => console.log('  [seg] 排列不齐：', JSON.stringify(g)));
  await step('settings-改密码弹窗', "(()=>{const b=document.getElementById('do-pass');if(!b)return 'no';b.click();return 1})()", 900);
  await js("App.closeModal();document.querySelector('#tabbar [data-tab=\"shelf\"]').click();1", 500);

  const report = { url: BASE, at: new Date().toISOString(), consoleErrors, exceptions, netFails,
    overflowIssues, apiCalls, themeChecks, segGrid: segGridForReport,
    promptPanel: { saved: promptSaved, hist: promptHist, diffLines: promptDiffLines,
      cleanedLeft: promptCleaned, cleanedOk: promptCleaned && !promptCleaned.global.length && !promptCleaned.book.length },
    newPanels: newPanels, steps: log };
  fs.writeFileSync(OUTJSON, JSON.stringify(report, null, 2));
  console.log('\n控制台报错', consoleErrors.length, '条；页面异常', exceptions.length, '条；失败请求', netFails.length, '条；横向溢出', overflowIssues.length, '处');
  consoleErrors.slice(0, 20).forEach((e) => console.log('  [console]', e.text.slice(0, 200)));
  exceptions.slice(0, 20).forEach((e) => console.log('  [exception]', e.slice(0, 200)));
  netFails.slice(0, 20).forEach((e) => console.log('  [net]', e.status, e.url));
  overflowIssues.slice(0, 10).forEach((e) => console.log('  [overflow]', e.tool, e.tab || '', e.body, '>', e.bodyW));
  console.log('API 命中：', Object.keys(apiCalls).length, '个端点');
  console.log('报告：', OUTJSON);
  ws.close(); chrome.kill(); process.exit(0);
})();
