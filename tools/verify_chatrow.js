const { open, sleep } = require('./cdp.js');
(async () => {
  const p = await open({ port: 9471, width: 390, height: 844, settle: 1500 });
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

    out.A_穿模检查 = await p.js(`(() => {
      const vw = document.documentElement.clientWidth;
      const bad = [];
      document.querySelectorAll('#chat-modes, #chat-split, #chat-goto-split, .mode-row, .cd-line, .mode-hint').forEach((e) => {
        const r = e.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        if (r.right > vw + 1 || r.left < -1) bad.push((e.id||e.className)+' 左'+Math.round(r.left)+' 右'+Math.round(r.right));
      });
      return JSON.stringify({
        屏宽: vw,
        页面横向溢出: document.documentElement.scrollWidth > vw ? ('是 +' + (document.documentElement.scrollWidth - vw) + 'px') : '否',
        越界元素: bad.length ? bad : '无',
        谁来做这一行: !!document.getElementById('chat-split'),
        分工设置按钮右边缘: Math.round((document.getElementById('chat-goto-split')||{getBoundingClientRect:()=>({right:-1})}).getBoundingClientRect().right)
      }); })()`);

    out.B_点三个点 = await p.js(`(async () => { const w=m=>new Promise(r=>setTimeout(r,m));
      const b=document.querySelector('.pk[data-k="model"]') || [...document.querySelectorAll('button')].find(x=>/模型/.test(x.textContent));
      if(!b) return '找不到模型按钮';
      b.click(); await w(3000);
      const m=document.querySelector('.md-more'); if(!m) return '选模型里没有三个点';
      m.click(); await w(2800);
      return JSON.stringify({ 面板标题:(document.querySelector('.sheet-h')||{}).textContent||'(没打开)',
        上下文:(document.getElementById('mp-ctx')||{}).value||'',
        快选胶囊: document.querySelectorAll('.mp-chip').length,
        高级JSON: !!document.getElementById('mp-json') }); })()`);
    await p.shot('/home/ubuntu/novel-app/docs/监督人-选模型参数面板.png');
  } catch (e) { out.出错 = String(e.message||e).slice(0,200); }
  finally { await p.close(); }
  console.log(JSON.stringify(out, null, 1));
})();
