const { open, sleep } = require('./cdp.js');
(async () => {
  const p = await open({ port: 9451, width: 390, height: 844, settle: 1500 });
  const out = {};
  try {
    await p.nav('http://127.0.0.1:8899/'); await sleep(3500);
    await p.js(`(() => { const el=document.getElementById('login-pass'); el.value='[REDACTED-PASSWORD]';
      el.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('login-go').click(); return 1; })()`);
    await sleep(6000);
    // 进对话
    await p.js(`(async () => { const w=m=>new Promise(r=>setTimeout(r,m));
      const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='对话');
      if(b){b.click(); await w(3500);} return 1; })()`);
    await sleep(1500);
    out.顶部控件 = await p.js(`(() => JSON.stringify({
      干活方式胶囊: [...document.querySelectorAll('#chat-modes button')].map(b=>b.textContent.trim()),
      谁来做胶囊: [...document.querySelectorAll('#chat-split button')].map(b=>b.textContent.trim()+(b.classList.contains('on')?'(选中)':'')),
      分工设置按钮: !!document.getElementById('chat-goto-split'),
      按钮文字: (document.getElementById('chat-goto-split')||{}).textContent || ''
    }))()`);
    // 点"一个人"
    out.点一个人 = await p.js(`(async () => { const w=m=>new Promise(r=>setTimeout(r,m));
      const b=document.querySelector('#chat-split button[data-split="0"]'); if(!b) return '没找到';
      b.click(); await w(900);
      return [...document.querySelectorAll('#chat-split button')].map(x=>x.textContent.trim()+(x.classList.contains('on')?'(选中)':'')).join(' / ');
    })()`);
    // 点"分工设置"看跳不跳
    out.点分工设置 = await p.js(`(async () => { const w=m=>new Promise(r=>setTimeout(r,m));
      const b=document.getElementById('chat-goto-split'); if(!b) return '没找到';
      b.click(); await w(3000);
      const cur = document.querySelector('.screen.on, section.screen:not(.hidden)');
      return JSON.stringify({ 当前屏: cur ? (cur.id||cur.className) : '?',
        屏上首行: document.body.innerText.slice(0,60).replace(/\\n/g,' | ') }); })()`);
    await p.shot('/home/ubuntu/novel-app/docs/监督人-聊天分工开关.png');
  } catch (e) { out.出错 = String(e.message||e).slice(0,200); }
  finally { await p.close(); }
  console.log(JSON.stringify(out, null, 1));
})();
