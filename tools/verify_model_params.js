/* verify_model_params.js —— 真浏览器实测「模型右上角三个点 → 参数面板」 */
const { open, sleep } = require('./cdp.js');
const fs = require('fs');
const PW = fs.existsSync('/tmp/tk.txt') ? null : null;
(async () => {
  const p = await open({ port: 9441, width: 390, height: 844, settle: 1500 });
  const out = {};
  try {
    await p.nav('http://127.0.0.1:8899/');
    await sleep(3500);
    // 登录
    await p.js(`(() => { const el=document.getElementById('login-pass');
      el.focus(); el.value=''; el.value='[REDACTED-PASSWORD]'; el.dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('login-go').click(); return 1; })()`);
    await sleep(6000);
    // 进预设
    out.进预设 = await p.js(`(async () => { const w=m=>new Promise(r=>setTimeout(r,m));
      const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='预设');
      if(b){b.click(); await w(3000);}
      return document.body.innerText.slice(0,70).replace(/\\n/g,' | '); })()`);
    // 点"用哪个模型"
    out.打开模型列表 = await p.js(`(async () => { const w=m=>new Promise(r=>setTimeout(r,m));
      const b=document.querySelector('[data-pick="__model"]');
      if(!b) return '找不到"用哪个模型"按钮';
      b.click(); await w(2500);
      const rows=document.querySelectorAll('#pk-list li');
      const mores=document.querySelectorAll('#pk-list .pk-more');
      return JSON.stringify({ 模型行数: rows.length, 三个点个数: mores.length,
        第一行: rows[0] ? rows[0].textContent.trim().slice(0,40) : '' }); })()`);
    // 点第一个「⋯」
    out.打开参数面板 = await p.js(`(async () => { const w=m=>new Promise(r=>setTimeout(r,m));
      const m=document.querySelector('#pk-list .pk-more');
      if(!m) return '没有三个点按钮';
      m.click(); await w(2600);
      const f=(id)=>{const e=document.getElementById(id); return e? {有:true, 值:e.value||''} : {有:false};};
      return JSON.stringify({ 面板标题:(document.querySelector('.sheet-h')||{}).textContent||'(无)',
        上下文输入:f('mp-ctx'), 最大输出:f('mp-max'),
        快选胶囊: document.querySelectorAll('.mp-chip').length,
        推理单选: !!document.getElementById('mp-rs'),
        高级JSON: f('mp-json'), 保存按钮: !!document.getElementById('mp-save') }, null, 0); })()`);
    await p.shot('/home/ubuntu/novel-app/docs/监督人-模型参数面板.png');
    // 真存一次：改上下文为 256000 + 高级 JSON
    out.保存 = await p.js(`(async () => { const w=m=>new Promise(r=>setTimeout(r,m));
      const c=document.getElementById('mp-ctx'); if(c){c.value='256000';}
      const j=document.getElementById('mp-json'); if(j){j.value='{"thinking":{"type":"enabled","budget_tokens":4096}}';}
      const s=document.getElementById('mp-save'); if(!s) return '没有保存按钮';
      s.click(); await w(3500);
      return JSON.stringify({ 面板关了吗: !document.querySelector('#mp-save'), 提示: document.body.innerText.slice(0,40).replace(/\\n/g,' | ') }); })()`);
  } catch (e) { out.出错 = String(e.message || e).slice(0, 200); }
  finally { await p.close(); }
  console.log(JSON.stringify(out, null, 1));
})();
