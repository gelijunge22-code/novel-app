const { open, sleep } = require('./cdp.js');
(async () => {
  const p = await open({ port: 9501, width: 390, height: 844, settle: 1500 });
  const out = {};
  try {
    await p.nav('http://127.0.0.1:8899/'); await sleep(3200);
    await p.js(`(() => { const el=document.getElementById('login-pass'); el.value='[REDACTED-PASSWORD]';
      el.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('login-go').click(); return 1; })()`);
    await sleep(6000);
    // 打开设置
    await p.js(`(async () => { const w=m=>new Promise(r=>setTimeout(r,m));
      const b=[...document.querySelectorAll('button, [data-act], .tab, .nav-item')].find(x=>/设置/.test(x.textContent||''));
      if(b){ b.click(); await w(2500); } return 1; })()`);
    await sleep(1200);
    out.口令行 = await p.js(`(() => { const s=document.getElementById('pw-slot');
      return JSON.stringify({ 找到口令行: !!s, 显示内容: s? s.textContent.trim() : '(无)',
        有复制按钮: !!document.getElementById('do-pw-copy'),
        有换一个按钮: !!document.getElementById('do-pw-new'),
        有说明文字: /控制台|口令.txt/.test(document.body.innerText) }); })()`);
    await p.shot('/home/ubuntu/novel-app/docs/监督人-关于页显示口令.png');
  } catch (e) { out.出错 = String(e.message||e).slice(0,200); }
  finally { await p.close(); }
  console.log(JSON.stringify(out, null, 1));
})();
