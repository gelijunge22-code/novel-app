const { open, sleep } = require('./cdp.js');
(async () => {
  const p = await open({ port: 9491, width: 390, height: 844, settle: 1500 });
  const out = {};
  try {
    await p.nav('http://127.0.0.1:8899/'); await sleep(3500);
    await p.js(`(() => { const el=document.getElementById('login-pass'); el.value='[REDACTED-PASSWORD]';
      el.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('login-go').click(); return 1; })()`);
    await sleep(6000);
    await p.js(`(async () => { const w=m=>new Promise(r=>setTimeout(r,m));
      const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='对话');
      if(b){b.click(); await w(3500);} return 1; })()`);
    await sleep(1500);

    // 展开抽屉（谁来做那一行在里面）
    await p.js(`(async () => { const w=m=>new Promise(r=>setTimeout(r,m));
      const h=document.querySelector('.cd-head'); if(h){h.click(); await w(1200);} return 1; })()`);
    await sleep(900);

    out.A_初始 = await p.js(`(() => JSON.stringify({
      分工: (document.querySelector('#chat-split [data-split="1"]')||{}).className||'',
      一个人: (document.querySelector('#chat-split [data-split="0"]')||{}).className||''
    }))()`);

    // 点「一个人」
    out.B_点一个人 = await p.js(`(async () => { const w=m=>new Promise(r=>setTimeout(r,m));
      const b=document.querySelector('#chat-split [data-split="0"]'); if(!b) return '没找到';
      b.click(); await w(900);
      const saved = JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>/chat/.test(k))||'{}')||'{}');
      return JSON.stringify({
        分工: (document.querySelector('#chat-split [data-split="1"]')||{}).className.includes('on'),
        一个人: (document.querySelector('#chat-split [data-split="0"]')||{}).className.includes('on'),
        存下了: saved.divided
      }); })()`);

    // 点联网胶囊
    out.C_联网胶囊 = await p.js(`(async () => { const w=m=>new Promise(r=>setTimeout(r,m));
      const b=document.getElementById('chat-net'); if(!b) return '没找到胶囊';
      const before = b.classList.contains('on');
      b.click(); await w(2200);
      const mid = b.classList.contains('on');
      b.click(); await w(2200);       // 再点回来（别给用户留下"开着"的状态）
      return JSON.stringify({ 点前开着: before, 点后开着: mid, 再点回: b.classList.contains('on'),
        文字: b.textContent.trim(), 可点: !b.disabled }); })()`);
    await p.shot('/home/ubuntu/novel-app/docs/监督人-联网胶囊与谁来做.png');
  } catch (e) { out.出错 = String(e.message||e).slice(0,200); }
  finally { await p.close(); }
  console.log(JSON.stringify(out, null, 1));
})();
