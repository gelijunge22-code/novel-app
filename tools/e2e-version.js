/* ============================================================
   e2e-version.js — App 桥（版本提示 / App 内更新 / 分享）真浏览器走查。
      · C3 版本：已经是新版（App 版本 == 服务器版本）→ **绝不能**提示更新；
                 真的旧了 → 必须提示，点「下载更新」要调原生下载（C4）；
      · 23.5 分享：阅读器菜单点分享 → 要调原生的 Android.share（不是干瞪眼）。
   做法：在网页里把 window.Android 换成假的（模拟 App 外壳里那个桥），
        改它的版本号 / 记录它被调了什么，再走真实的界面。

   用法：node tools/e2e-version.js
   ============================================================ */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const ROOT = '/home/ubuntu/novel-app';
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8899/';
const OUTJSON = path.join(ROOT, 'docs/前端走查-App桥.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readPassword() {
  try {
    const cfg = JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8'));
    return cfg.app_password || cfg.password || '';
  } catch (e) { return ''; }
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ver-'));
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--hide-scrollbars', '--remote-debugging-port=9337', '--window-size=390,844',
    '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try { targets = await (await fetch('http://127.0.0.1:9337/json/list')).json(); if (targets && targets.length) break; } catch (e) {}
  }
  if (!targets) { console.error('chrome 起不来'); process.exit(1); }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const waiting = new Map();
  const consoleErrors = []; const exceptions = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' ').slice(0, 200));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      exceptions.push(String((d.exception && (d.exception.description || d.exception.value)) || d.text).slice(0, 300));
    }
  };
  const send = (method, params) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  const js = async (expr, wait) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (wait) await sleep(wait);
    return r.result && r.result.result ? r.result.result.value : null;
  };
  /* 截图走公共件：md5 去重 + 本该相同的不再写第二份文件。
     名字照旧（ver-0X-…），但每张必须**真的拍到"安卓安装包"那一行**（见 read()）。 */
  const kit = require('./shotkit')({ send, dir: path.join(ROOT, 'docs/前端截图'), round: 'r13' });
  const shot = (name, opts) => kit.shoot(name, opts);

  await send('Page.navigate', { url: BASE + '?ver=' + Date.now() });
  await sleep(5500);
  if (await js("!document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword()) + ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()", 4500);
  }
  const serverVer = await js("fetch('api/apk/version',{credentials:'include'}).then(r=>r.json())");
  console.log('  服务器上的安装包：', JSON.stringify(serverVer));

  /* 假装自己是 App：把 window.Android 装成壳里的那个桥 */
  const stub = (code, name) => js("(()=>{window.__dl=[];window.Android={" +
    "getPlatform:()=>'android',getVersion:()=>" + JSON.stringify(name) + "," +
    "getVersionCode:()=>" + code + "," +
    "getServerUrl:()=>location.origin+'/',openSettings:()=>{window.__opened=1}," +
    "downloadApk:(u,n)=>{window.__dl.push([u,n])},keepAwake:()=>{}," +
    "setStatusBar:()=>{},toast:()=>{},share:(t,x)=>{window.__shared=[t,x]}};return 1})()", 300);

  /* 拍之前先滚到「安卓安装包」那一行 —— 以前不滚，三张"版本三状态"拍到的
     全是设置页顶部（三张 md5 一模一样），等于没证据。 */
  /* 判"拍到了"要用**视口**坐标，不能用滚动容器坐标。
     第 9 遍打磨踩过的坑：老代码拿 `.settings-body` 的 rect 当参照物，
     结果"行在容器里可见"通过了断言，但那一行其实在屏幕外 —— 三张"版本三状态"
     拍到的都是设置页顶部，等于没证据。现在改成 scrollIntoView + 视口判定。 */
  const scrollToApk = async () => {
    for (let i = 0; i < 4; i++) {
      const ok = await js(`(() => {
        const slot = document.getElementById('apk-slot');
        const row = slot && slot.closest('.settings-row');
        if (!row) return 0;
        const r = row.getBoundingClientRect();
        const vh = window.innerHeight || 844;
        if (r.top >= 0 && r.bottom <= vh && r.height > 0) return 1;      // 已经在视口里，别乱滚
        row.scrollIntoView({ block: 'center' });
        return 2;
      })()`, 450);
      if (ok === 1) return 1;
    }
    return 0;
  };
  const read = async () => {
    await js("document.querySelector('#tabbar [data-tab=\"shelf\"]').click()", 600);
    await js("App.show('settings')", 1800);
    await scrollToApk();
    return js("(()=>{const slot=document.getElementById('apk-slot');" +
      "const row=slot&&slot.closest('.settings-row');" +
      "const rr=row?row.getBoundingClientRect():null;" +
      "const vh=window.innerHeight||844;" +
      "return {key:row?row.querySelector('.k').textContent:null,slot:slot?slot.textContent.trim():null," +
      "/* 真的在视口里：上沿不进负区、下沿不越底、高度不为 0 */" +
      "onScreen: !!(rr&&rr.height>0&&rr.top>=0&&rr.bottom<=vh)," +
      "rowTop:rr?Math.round(rr.top):null,rowBottom:rr?Math.round(rr.bottom):null,vh," +
      "buttons:Array.from(document.querySelectorAll('#settings-body button')).map(b=>b.textContent)};" +
      "})()");
  };

  const out = {};

  /* ① 跟服务器同版本（最新）→ 不许提示更新 */
  await stub(serverVer.versionCode, serverVer.versionName);
  out['①已是最新'] = await read();
  await shot('ver-01-已是最新');
  console.log('  · 最新版本时：', JSON.stringify(out['①已是最新']));

  /* ② 旧版本 → 必须提示，点「下载更新」要调原生下载 */
  await stub(Math.max(1, serverVer.versionCode - 1), '1.0');
  out['②旧版本'] = await read();
  await shot('ver-02-提示更新');
  const clicked = await js("(()=>{const b=document.getElementById('do-apk');if(!b)return 'no-btn';b.click();return 1})()", 700);
  out['②点下载更新'] = { clicked: clicked, calls: await js('window.__dl') };
  console.log('  · 旧版本时：', JSON.stringify(out['②旧版本']), '点击后原生调用：', JSON.stringify(out['②点下载更新']));

  /* ③ 编号一样、名字不一样（最容易误报的组合）→ 也不许提示 */
  await stub(serverVer.versionCode, '9.9-名字对不上');
  out['③编号相同名字不同'] = await read();
  await shot('ver-03-编号同名字异');
  console.log('  · 编号相同名字不同：', JSON.stringify(out['③编号相同名字不同']));

  const vs = [out['①已是最新'], out['②旧版本'], out['③编号相同名字不同']];
  const onScreen = vs.every((x) => x && x.onScreen);
  console.log((onScreen ? '  ✓ ' : '  ✗ ') + '三张版本截图都真的拍到了「安卓安装包」那一行（视口内，带 top/bottom 证据）');

  /* ④ 分享：阅读器菜单里的分享要调原生 Android.share（带上书名+本章正文） */
  await stub(serverVer.versionCode, serverVer.versionName);
  await js("document.querySelector('#tabbar [data-tab=\"shelf\"]').click()", 700);
  // 挑一本**有正文**的书来试分享：别的自动化脚本可能正在书架上留测试书（只有几十字），
  // 所以先指名打开那本真书；找不到再退回收的第一张卡。
  await js("(()=>{const want='example-book';" +
    "const all=[...document.querySelectorAll('#shelf-list [data-slug]')];" +
    "const c=all.find(x=>x.dataset.slug===want)||all[0]||document.querySelector('#shelf-list .shelf-card');" +
    "if(c)c.click();return 1})()", 3500);
  await js("(()=>{const b=document.querySelector('[data-act=\"reader-menu\"]');if(b)b.click();return 1})()", 1600);
  const shareBtn = await js("(()=>{const b=document.querySelector('#sheet-panel [data-a=\"share\"]');if(!b)return 'no-btn';b.click();return 1})()", 900);
  out['④分享'] = { 按钮: shareBtn, 原生收到: await js("(()=>{const s=window.__shared||[];return {title:s[0]||'',chars:(s[1]||'').length}})()") };
  // 分享这一步的画面就是"阅读器菜单开着"——和 reader 那轮拍过的是同一屏，
  // 所以标 same：只记"跟谁一样"，不再往目录里塞第二份一模一样的图。
  await shot('ver-04-分享', { expect: 'same', as: 'reader-菜单' });
  console.log('  · 分享：', JSON.stringify(out['④分享']));

  const shotRep = kit.report();
  const checks = {
    '三张版本截图都真的拍到了「安卓安装包」那一行（视口内）': onScreen,
    '三张版本截图互不相同（不是同一张摆三遍）':
      shotRep.dupes.filter((d) => d.name !== 'ver-04-分享').length === 0,
    '最新时不提示更新': out['①已是最新'].key === '安卓安装包' && !/有新版本/.test(out['①已是最新'].key || ''),
    '最新时按钮仍是「下载 / 更新」': /下载 \/ 更新/.test(out['①已是最新'].slot || ''),
    '旧版本会提示有新版本': out['②旧版本'].key === '有新版本',
    '旧版本时按钮变成「下载更新」': /下载更新/.test(JSON.stringify(out['②旧版本'].buttons || [])),
    '点下载更新会调原生（App 内下载更新）':
      out['②点下载更新'].clicked === 1 && (out['②点下载更新'].calls || []).length === 1,
    '编号相同但名字不同也不误报': out['③编号相同名字不同'].key === '安卓安装包',
    '分享会调原生 Android.share（带着书名与本章正文）': out['④分享'].按钮 === 1 &&
      /《.+》/.test(out['④分享'].原生收到.title) && out['④分享'].原生收到.chars > 0,
  };
  const allOk = Object.values(checks).every(Boolean);
  fs.writeFileSync(OUTJSON, JSON.stringify({
    url: BASE, at: new Date().toISOString(), serverVer, out, checks,
    shots: shotRep.shots, shotDupes: shotRep.dupes,
    consoleErrors, exceptions, verdict: allOk ? '通过' : '有问题',
  }, null, 2));
  console.log('\n判定：', JSON.stringify(checks, null, 1));
  console.log('控制台报错', consoleErrors.length, '条；页面异常', exceptions.length, '条');
  console.log(allOk ? '✅ 版本提示：通过' : '❌ 版本提示：有问题');
  console.log('报告：', OUTJSON);
  ws.close(); chrome.kill();
  process.exit(allOk ? 0 : 1);
})();
