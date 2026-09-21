const { open, sleep } = require('./cdp.js');
(async () => {
  const p = await open({ port: 9461, width: 390, height: 844, settle: 1500 });
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

    // A. 聊天顶部：分工开关 + 快捷按钮
    out.A_顶部 = await p.js(`(() => JSON.stringify({
      方式: [...document.querySelectorAll('#chat-modes button')].map(b=>b.textContent.trim()),
      谁来做: [...document.querySelectorAll('#chat-split button')].map(b=>b.textContent.trim()+(b.classList.contains('on')?'*':'')),
      分工设置按钮: !!document.getElementById('chat-goto-split')
    }))()`);

    // B. 打开「选模型」看每行有没有「⋯」
    out.B_选模型 = await p.js(`(async () => { const w=m=>new Promise(r=>setTimeout(r,m));
      /* 点顶部那个"模型"按钮打开选模型弹层 */
      const b=document.querySelector('.pk[data-k="model"]') || [...document.querySelectorAll('button')].find(x=>/模型/.test(x.textContent));
      if(!b) return '找不到打开模型的按钮';
      b.click(); await w(3000);
      const items=document.querySelectorAll('.picker-item');
      const mores=document.querySelectorAll('.md-more');
      return JSON.stringify({ 标题:(document.querySelector('.sheet-head h3')||{}).textContent||'',
        行数: items.length, 三个点: mores.length,
        第一行: items[0]? items[0].textContent.trim().slice(0,46):'' }); })()`);

    // C. 点第一个「⋯」→ 面板
    out.C_参数面板 = await p.js(`(async () => { const w=m=>new Promise(r=>setTimeout(r,m));
      const m=document.querySelector('.md-more'); if(!m) return '没有三个点';
      m.click(); await w(2600);
      return JSON.stringify({ 面板标题:(document.querySelector('.sheet-h')||{}).textContent||'(无)',
        上下文:(document.getElementById('mp-ctx')||{}).value||'',
        快选胶囊: document.querySelectorAll('.mp-chip').length,
        高级JSON: !!document.getElementById('mp-json'),
        保存按钮: !!document.getElementById('mp-save') }); })()`);
    await p.shot('/home/ubuntu/novel-app/docs/监督人-选模型三个点.png');
  } catch (e) { out.出错 = String(e.message||e).slice(0,200); }
  finally { await p.close(); }
  console.log(JSON.stringify(out, null, 1));
})();
