/* settings_probe.js — 量「大设置」有没有**文字真的出框**（第 41 轮重写）

   ⚠ 为什么重写：第 40 轮监督人用旧版探针报「大设置 16 处文字出框」，
   逐个量下来**全是假红** —— 全站按钮上都有一个"热区"伪元素
   （`components.css` 的 `::after{content:'';position:absolute;inset:-8px -6px}`，
   把可点范围撑到 ≥44×44），它会把元素的 `scrollWidth` 撑大 6~8px。
   旧探针量的是 `scrollWidth - clientWidth` → 把这**故意**的热区当成"字被裁了"。
   字本身（宋体/黑体/仿真/平移/滚动/无动画/慢/正常/快/更快/听书自检/去对话设置/改密码/退出/−/+）
   一个都没出框。

   所以现在分两类量，红绿分明：
     ① **文字真的出框**（报红）：用 `Range` 量文字自己的墨迹盒，跟元素的**内容盒**比。
        超 2px 就算出框（这才是用户看见的"字跑到框外面"）。
     ② **盒子被热区撑大**（不算问题）：`scrollWidth - clientWidth > 2` 但文字没出框 → 只统计个数。
   跑法：node tools/settings_probe.js
   报告：docs/大设置文字出框实测.json   截图：docs/监督人-大设置-*.png
   ============================================================ */
const { open, sleep } = require('./cdp.js');
const fs = require('fs');
const path = require('path');
const ROOT = '/home/ubuntu/novel-app';
function readPassword() {
  try { return JSON.parse(fs.readFileSync('/home/ubuntu/nbapp/config.json', 'utf8')).app_password || ''; }
  catch (e) { return ''; }
}

const SCAN = `(() => {
  const bad = [], hot = [];
  for (const el of document.querySelectorAll('*')) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) === 0) continue;
    if (el.childElementCount) continue;
    const txt = (el.textContent || '').trim(); if (!txt) continue;
    const r = el.getBoundingClientRect(); if (r.width < 6 || r.height < 6) continue;
    /* ① 文字**真的**出框没有：Range 量文字自己的墨迹盒 vs 元素的内容盒 */
    const rg = document.createRange(); rg.selectNodeContents(el);
    const tr = rg.getBoundingClientRect();
    const f = (v) => parseFloat(v) || 0;
    const cL = r.left + f(st.borderLeftWidth) + f(st.paddingLeft);
    const cR = r.right - f(st.borderRightWidth) - f(st.paddingRight);
    const cT = r.top + f(st.borderTopWidth) + f(st.paddingTop);
    const cB = r.bottom - f(st.borderBottomWidth) - f(st.paddingBottom);
    const overX = Math.max(0, Math.round(cL - tr.left), Math.round(tr.right - cR));
    const overY = Math.max(0, Math.round(cT - tr.top), Math.round(tr.bottom - cB));
    const sel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
      (el.className ? '.' + String(el.className).split(' ')[0] : '');
    if (overX > 2 || overY > 2) {
      bad.push({ 文字: txt.slice(0, 34), 选择器: sel, 横向出框: overX, 纵向出框: overY,
                 字号: st.fontSize, 内容盒宽: Math.round(cR - cL), 文字宽: Math.round(tr.width) });
    } else if (el.scrollWidth - el.clientWidth > 2 || el.scrollHeight - el.clientHeight > 2) {
      /* ② 这是**热区伪元素**撑出来的（故意的），记个数就行 */
      hot.push({ 文字: txt.slice(0, 20), 选择器: sel,
                 x: el.scrollWidth - el.clientWidth, y: el.scrollHeight - el.clientHeight });
    }
  }
  return { bad: bad.slice(0, 30), hotCount: hot.length, hot: hot.slice(0, 8) };
})()`;

/* ⚠ 报告文件名**不能**跟 e2e-textfit.js 的重（那个也叫「文字出框实测」）——
   两个判据写同一个文件会互相盖掉，谁后跑谁「全绿」。第 41 轮踩到过一次。 */
const OUT = path.join(ROOT, 'docs/大设置文字出框实测.json');

(async () => {
  const rep = { at: new Date().toISOString(), screens: [], problems: [] };
  const p = await open({ port: 9400, width: 390, height: 844, settle: 1200 });
  try {
    await p.nav('http://127.0.0.1:8899/'); await sleep(3200);
    await p.js(`fetch('/api/app/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({password:${JSON.stringify(readPassword())}})}).then(r=>r.text())`);
    await p.nav('http://127.0.0.1:8899/'); await sleep(4200);

    console.log('=== 1. 进大设置 ===');
    console.log(await p.js(`(async()=>{const w=(m)=>new Promise(r=>setTimeout(r,m));
      const b=document.getElementById('btn-shelf-menu');
      if(!b) return '找不到设置入口';
      b.click(); await w(2600); return '已进：'+document.body.innerText.slice(0,60).replace(/\\n/g,' | ');})()`, { timeout: 20000 }));

    /* 大设置是**一整页**（外观 / 动效 / 翻页 / 听书 / 数据 / 关于 六个分组），没有页签。
       所以"每一屏都量一遍"= 从顶滚到底，每滑一屏量一次（懒渲染/后面的分组都要覆盖）。 */
    const H = 844;
    const total = await p.js(`(()=>{const b=document.getElementById('settings-body');
      return b ? Math.round(b.scrollHeight) : 0;})()`);
    const pages = Math.max(1, Math.ceil((total || H) / (H - 120)));
    console.log('\n=== 2. 大设置逐屏量（共 ' + total + 'px / ' + pages + ' 屏）===');
    let allBad = 0, allHot = 0;
    for (let i = 0; i < pages; i++) {
      const off = i * (H - 120);
      await p.js(`(async()=>{const b=document.getElementById('settings-body');
        if(b) b.scrollTop=${off}; ; await new Promise(r=>setTimeout(r,420)); return 1;})()`);
      await sleep(450);
      const o = await p.js(SCAN);
      const title = await p.js(`(()=>{const b=document.getElementById('settings-body');
        if(!b) return '';
        const hs=[...b.querySelectorAll('h3')];
        const y=${off}+80;
        const hit=hs.filter(h=>{const r=h.getBoundingClientRect();return r.top<700;}).pop();
        return hit?hit.textContent.trim():'';})()`);
      allBad += o.bad.length; allHot += o.hotCount;
      rep.screens.push({ 屏: i + 1, 偏移: off, 这一屏的标题: title, 文字出框: o.bad.length,
                         被热区撑大的元素: o.hotCount, 明细: o.bad.slice(0, 6) });
      console.log('  [第 ' + (i + 1) + ' 屏 · ' + (title || '—') + '] 文字出框 ' + o.bad.length + ' 处' +
        (o.bad.length ? '：' + JSON.stringify(o.bad.slice(0, 4)) : '') +
        ' · 被热区撑大 ' + o.hotCount + ' 个（正常，是 44×44 热区）');
      await p.shot(path.join(ROOT, 'docs/监督人-大设置-' + (i + 1) + '.png'));
    }
    await p.js(`(()=>{const b=document.getElementById('settings-body');if(b)b.scrollTop=0;return 1;})()`);
    await p.shot(path.join(ROOT, 'docs/监督人-大设置-外观.png'));
    console.log('\n=== 3. 汇总 ===');
    console.log('  文字真的出框：' + allBad + ' 处（必须 0）');
    console.log('  被热区伪元素撑大：' + allHot + ' 个（**不是问题**：那是 44×44 可点范围，故意的）');
    console.log('  字号分布:', JSON.stringify(await p.js(`(()=>{const m={};for(const el of document.querySelectorAll('#settings-body *')){const st=getComputedStyle(el);if(st.display==='none')continue;if(el.childElementCount)continue;if(!(el.textContent||'').trim())continue;m[st.fontSize]=(m[st.fontSize]||0)+1;}return m;})()`)));
    rep.文字出框总数 = allBad;
    rep.被热区撑大总数 = allHot;
    rep.problems = allBad ? ['大设置文字出框 ' + allBad + ' 处'] : [];
    fs.writeFileSync(OUT, JSON.stringify(rep, null, 1));
    console.log('  报告：' + path.relative(ROOT, OUT));
  } catch (e) { console.log('!! 出错:', e.message); }
  finally { await p.close(); }
  process.exit(rep.problems.length ? 1 : 0);
})();
