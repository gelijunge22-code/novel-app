const { open, sleep } = require('./cdp.js');
const fs = require('fs');
const TOK = fs.readFileSync('/tmp/token.txt', 'utf8').trim();
(async () => {
  const p = await open({ port: 9434, width: 390, height: 844, settle: 1500 });
  const out = {};
  try {
    await p.js(`(() => { try { localStorage.clear(); } catch(e){} return 1; })()`);
    await p.nav('http://127.0.0.1:8899/?t=' + encodeURIComponent(TOK));
    await sleep(6000);
    out.页面 = await p.js(`(() => ({ url: location.href.slice(0, 70),
      登录页显示: document.getElementById('login') ? !document.getElementById('login').classList.contains('hidden') : null,
      提示: (document.getElementById('login-msg')||{}).textContent || '' }))()`);
    // 直接问前端：手上是哪串口令？status 说什么？
    out.前端状态 = await p.js(`(async () => {
      const o = {};
      try { o.手上口令 = String(API.sessionToken() || '').slice(0, 12) + '…'; } catch (e) { o.手上口令 = 'err:' + e.message; }
      try { const s = await API.status(); o.status = s; } catch (e) { o.status = 'err:' + (e.message || e); }
      try { const sh = await (API.shelf ? API.shelf() : Promise.reject(new Error('no API.shelf'))); o.书架 = (sh && (sh.projects||sh.items||[])).length; } catch (e) { o.书架 = 'err:' + (e.message || e); }
      return o;
    })()`);
    await p.shot('/home/ubuntu/novel-app/docs/监督人-链接调试.png');
  } catch (e) { out.出错 = String(e.message || e).slice(0, 200); }
  finally { await p.close(); }
  console.log(JSON.stringify(out, null, 1));
})();
