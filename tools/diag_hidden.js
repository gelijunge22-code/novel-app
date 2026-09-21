/* 一次性诊断：为什么夜间体检里 preset 的"流式输出"量到 y=721、截图那儿却没有字。
   只为查清"量到的坐标 ≠ 画出来的位置"这件事，查完就可以删。 */
const { open, sleep } = require('./cdp');
const { readPassword } = require('./preflight');
const SERVER = 'http://127.0.0.1:8899/';
const SHIM = `(() => {
  const BASE = ${JSON.stringify(SERVER)};
  let tok = '';
  const call = (method, p, body) => {
    try { const x = new XMLHttpRequest();
      x.open(method || 'GET', BASE + String(p || '').replace(/^\\//, ''), false);
      x.setRequestHeader('Accept', 'application/json');
      if (tok) x.setRequestHeader('X-Token', tok);
      if (body) { x.setRequestHeader('Content-Type', 'application/json'); x.send(body); } else x.send();
      const t = x.responseText || ''; try { const j = JSON.parse(t); if (j && j.token) tok = j.token; } catch (e) {}
      return JSON.stringify({ status: x.status, body: t, error: '' });
    } catch (e) { return JSON.stringify({ status: 0, body: '', error: '连不上服务器：' + e }); }
  };
  window.NBApp = { request: (m, p, b) => call(m, p, b), base: () => BASE, token: () => tok, ready: () => true, localReady: () => false, ping: () => '{"ok":true}' };
  window.Android = { getPlatform: () => 'android', getVersion: () => '2.0.4', getVersionCode: () => 24,
    localStatus: () => JSON.stringify({ mode: 'server', local: false, server: BASE, why: '' }),
    retry: () => {}, retryLocal: () => {}, downloadApk: () => {}, keepAlive: () => {}, setThemePaper: () => {},
    setStatusBar: () => {}, vibrate: () => {}, keepAwake: () => {}, openSettings: () => {}, share: () => {}, exitApp: () => {}, serverCheck: () => '{"ok":true}' };
})();`;
(async () => {
  const s = await open({ port: 9394, shims: [SHIM] });
  const js = (e) => s.js(e);
  await s.nav('file:///home/ubuntu/novel-app/apk/assets/www/index.html');
  await sleep(1500);
  await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword()) +
    ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
  await sleep(2500);
  await js("(async()=>{App.show('preset');await new Promise(r=>setTimeout(r,2000));return 1})()");
  await sleep(1200);
  const info = await js(`(() => {
    const list = [...document.querySelectorAll('#screen-preset .pfield-lb')].filter((x) => (x.textContent||'').includes('流式输出'));
    const el = list[0];
    if (!el) return { err: '没找到这个标签' };
    const r = el.getBoundingClientRect();
    const cx = r.left + 30, cy = r.top + r.height / 2;
    const at = document.elementsFromPoint(cx, cy).slice(0, 4).map((n) => n.tagName.toLowerCase()
      + (n.id ? '#' + n.id : '') + (typeof n.className === 'string' && n.className ? '.' + n.className.trim().split(/\s+/).join('.') : '')
      + '[' + (n.textContent || '').trim().slice(0, 10) + ']');
    return { 同名的元素个数: list.length,
      第0个的矩形: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
      第0个的HTML: el.outerHTML.slice(0, 160),
      中心点上的元素: at,
      这个元素自己的文字: (el.textContent || '').trim().slice(0, 20),
      第0个的样式: (() => { const c = getComputedStyle(el);
        return { color: c.color, fs: c.fontSize, pad: c.padding, disp: c.display, justify: c.justifyContent }; })() };
  })()`);
  console.log(JSON.stringify(info, null, 1));
  await s.shot('/tmp/diag_preset.png');
  s.close();
})();
