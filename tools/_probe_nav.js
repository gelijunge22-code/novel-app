const { open, sleep } = require('./cdp.js');
(async () => {
  const p = await open({ port: 9432, width: 390, height: 844, settle: 1500 });
  try {
    for (const url of ['http://<你的服务器地址>/novel/', 'http://127.0.0.1:8899/']) {
      try {
        await p.nav(url);
        await sleep(4000);
        const info = await p.js(`(() => ({ url: location.href, title: document.title,
          bodyLen: (document.body ? document.body.innerText.length : -1),
          hasLogin: !!document.getElementById('login'),
          head: (document.body ? document.body.innerText : '').slice(0, 70).replace(/\\n/g,' | ') }))()`);
        console.log(url, '→', JSON.stringify(info));
      } catch (e) { console.log(url, '→ 出错:', String(e.message || e).slice(0, 160)); }
    }
  } finally { await p.close(); }
})();
