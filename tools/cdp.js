/* cdp.js — 无头 Chrome 的一小段公共脚手架（新脚本用它，别再各抄一份）。
   为什么要它：`e2e-appserver.js` / `e2e-tts.js` / 这次新写的脚本开头那 40 行（起 Chrome、
   连 DevTools、抓页面、给个 evaluate 壳子、截图）长得一模一样 —— 抄第三遍就是"两套实现并存"了。

   用法：
     const { open } = require('./cdp');
     const s = await open({ port: 9371 });
     await s.nav('file:///…/index.html');
     const v = await s.js('1+1');
     await s.shot('/path/x.png');
     s.close();
*/
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sweep } = require('./sweep_chrome');   // 收孤儿无头浏览器（3.6G 机器，跑完必须不留 1G 的 chrome）

/* 自己起的 chrome 记在这儿：进程退出（正常 / Ctrl-C / 崩）时统一收掉，
   别再把带 --user-data-dir=/tmp/… 的无头浏览器留在机器上吃内存。 */
const LIVE = new Set();
let hooksDone = false;
function installHooks() {
  if (hooksDone) return;
  hooksDone = true;
  const bye = () => { for (const c of LIVE) { try { c.kill('SIGKILL'); } catch (e) {} } };
  process.on('exit', bye);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { bye(); process.exit(130); });
}

const CHROME = process.env.CHROME_BIN
  || '/home/ubuntu/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(opts = {}) {
  const port = opts.port || 9371;
  installHooks();
  if (!opts.noSweep) { try { sweep(false); } catch (e) { /* 扫不动就算了，别挡着测试 */ } }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
  const args = ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    /* 自动播放策略：**跟真实浏览器一样**（user-gesture-required）。
       第 33 轮踩到的坑（监督人查出来的）：这里原来写的是 no-user-gesture-required
       —— 测试环境比用户环境宽松，于是"用户一点、浏览器就把 play() 拦了"这条
       **真机上必然出现**的问题，在判据里永远是绿的（听书没声音就是这么漏掉的）。
       要模拟"用户真的点了一下"，用 js(expr, {userGesture:true})。 */
    '--autoplay-policy=user-gesture-required',
    '--mute-audio', '--remote-debugging-port=' + port,
    '--window-size=' + (opts.width || 390) + ',' + (opts.height || 844),
    '--user-data-dir=' + profile].concat(opts.flags || []).concat(['about:blank']);
  const chrome = spawn(CHROME, args, { stdio: 'ignore' });
  LIVE.add(chrome);
  let targets = null;
  for (let i = 0; i < 60; i++) {
    await sleep(400);
    try {
      targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      if (targets && targets.length) break;
    } catch (e) { /* 还没起来 */ }
  }
  if (!targets) { chrome.kill(); throw new Error('chrome 起不来'); }
  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const waiting = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
    else if (m.method) events.push(m);
  };
  const send = (method, params) => new Promise((res) => {
    const i = ++id; waiting.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params: params || {} }));
  });
  await new Promise((r) => (ws.onopen = r));
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride',
    { width: opts.width || 390, height: opts.height || 844, deviceScaleFactor: 2, mobile: true });
  for (const src of (opts.shims || [])) {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: src });
  }
  /* ⚠ 探针**必须有超时**：`awaitPromise:true` 的时候，只要页面里那个 Promise
     永远不 settle（面板卡在"正在读…"、或者某一步挂在没人 resolve 的 await 上），
     `Runtime.evaluate` 就**永远不回**，整个脚本一声不吭地僵在那儿 ——
     第 29 轮就是这么白等了 4 分钟（日志停在最后一条、进程还在、CPU 0%）。
     超时后抛一个带 `.timeout=true` 的错，调用方可以判红并继续跑其它的。 */
  const js = async (expr, opts2) => {
    const to = (opts2 && opts2.timeout) || opts.jsTimeout || 20000;
    let timer = null;
    const r = await Promise.race([
      send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true,
                                 // 这一句让本次执行带上"用户手势"（跟真点一下等价）——
                                 // 听书那条判据必须在**真实自动播放策略**下走用户点击。
                                 userGesture: !!(opts2 && opts2.userGesture) }),
      new Promise((res) => { timer = setTimeout(() => res('__TIMEOUT__'), to); }),
    ]);
    if (timer) clearTimeout(timer);
    if (r === '__TIMEOUT__') {
      const e = new Error('探针超时 ' + to + 'ms：' + String(expr).replace(/\s+/g, ' ').slice(0, 90));
      e.timeout = true;
      console.log('  ⚠ ' + e.message);
      throw e;
    }
    const ex = r.result && r.result.exceptionDetails;
    /* 只印 `ex.text` 会得到一句"Uncaught"，查不出是哪一行 —— 把描述第一行也带上
       （第 19 轮夜间体检就是这么白跑了一轮，探针里一个语法错，报告里只有"Uncaught"）。 */
    if (ex) console.log('  ⚠ 探针异常: ' + String(ex.text || '') + ' :: '
      + String((ex.exception && ex.exception.description) || '').split('\n').slice(0, 3).join(' | '));
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const nav = async (url) => { await send('Page.navigate', { url }); await sleep(opts.settle || 900); };
  const shot = async (file) => {
    const d = fs.mkdirSync(path.dirname(file), { recursive: true });
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (r.result && r.result.data) fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return !!d || true;
  };
  /* 真人点一下：CDP 派发**真实鼠标事件**（mouseMoved / mousePressed / mouseReleased）。
     为什么不能用 el.click()：那是 JS 调用，浏览器**不给"用户手势"** ——
     自动播放、全屏、粘贴板这些"必须用户操作"的能力一律被拒，
     于是"用户点了听书却没声"这类问题在判据里永远看不见（监督人实测出来的坑）。
     用法：await s.clickSel('[data-a="tts"]')  → 返回点中的坐标（没找到就是 null）。 */
  const clickSel = async (sel, opts2) => {
    /* 先把它滚进可视区 —— 大设置页那种长页面里，目标按钮常常在**屏幕下面**
       （量出来 rect.top > 屏高，直接派鼠标事件就会打空、判据变成假红）。 */
    await js(`(() => { const e = document.querySelector(${JSON.stringify(sel)});
      if (e && e.scrollIntoView) e.scrollIntoView({ block: 'center', inline: 'center' }); return 1; })()`);
    await sleep(160);
    /* 选**第一个看得见**的那个（同名的按钮可能有好几个：面板里一个、菜单里一个，
       藏着那个 rect 是 0 —— 点它等于点空气，判据就变成永远绿/永远红）。 */
    const box = await js(`(() => {
      const all = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(sel)}));
      for (const e of all) {
        const cs = getComputedStyle(e);
        if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) continue;
        const r = e.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) continue;
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
                 w: Math.round(r.width), h: Math.round(r.height),
                 /* 命中测试：这一点上最上面的元素是不是它（被弹层盖住就要能看出来） */
                 hit: (function () { const t = document.elementFromPoint(r.left + r.width / 2,
                       r.top + r.height / 2); return t ? (t === e || e.contains(t)) : false; })() };
      }
      return null; })()`);
    if (!box) return null;
    const at = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
    await send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved', buttons: 0 }, at));
    await send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed', buttons: 1 }, at));
    await send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased', buttons: 0 }, at));
    if (!(opts2 && opts2.noWait)) await sleep(120);
    return box;
  };

  return { send, js, nav, shot, clickSel, close: () => {
             LIVE.delete(chrome);
             try { chrome.kill('SIGKILL'); } catch (e) {}
             try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
           }, events,
           errors: () => events.filter((m) => m.method === 'Runtime.exceptionThrown')
             .map((m) => String((m.params.exceptionDetails || {}).text || '')) };
}

module.exports = { open, sleep };
