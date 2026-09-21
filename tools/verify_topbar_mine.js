/* 监督人独立验：书架顶栏有没有修好（不信它自报） */
const { open, sleep } = require('./cdp.js');
(async () => {
  const p = await open({ port: 9412, width: 390, height: 844, settle: 1200 });
  try {
    await p.nav('http://127.0.0.1:8899/'); await sleep(4200);
    // 进书架
    await p.js(`(async()=>{const w=m=>new Promise(r=>setTimeout(r,m));
      const c=document.querySelector('#shelf-list .book-card'); if(c){c.click(); await w(3000);}
      const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='书架');
      if(b){b.click(); await w(1800);} return 1;})()`, { timeout: 25000 });
    await sleep(1500);
    console.log(await p.js(`(() => {
      const q=(s)=>document.querySelector(s);
      const box=(e)=>{ if(!e) return null; const r=e.getBoundingClientRect();
        return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height),
                cy:Math.round(r.y+r.height/2)}; };
      const tb=q('.topbar'), t=q('.topbar-title'), bk=q('.bk-bar')||q('.topbar > .bk-bar');
      const A=box(t), B=box(bk), T=box(tb);
      const ov=(a,b)=>{ if(!a||!b) return null;
        const w=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x);
        const h=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
        return (w>0&&h>0)? Math.round(w*h):0; };
      // 顶栏底边 → 下一个内容元素
      let gap=null, first=null;
      if(T){ const els=[...document.querySelectorAll('#view-shelf *,#shelf-list *,.bk-bar-host *,.shelf-main *')]
        .filter(e=>{const r=e.getBoundingClientRect(); return r.height>6 && r.width>40 && r.y>=T.y+T.h-2;});
        els.sort((a,b)=>a.getBoundingClientRect().y-b.getBoundingClientRect().y);
        if(els[0]){ first=els[0].getBoundingClientRect(); gap=Math.round(first.y-(T.y+T.h)); } }
      return JSON.stringify({
        顶栏: T, 标题: A, 切书条: B,
        标题中心y: A?A.cy:null,
        顶栏第一行中心y: T?Math.round(T.y+ (T.h? Math.min(T.h, 56)/2:0)):null,
        标题与切书条重叠面积px2: ov(A,B),
        标题与顶栏底边距离: (A&&T)? Math.round(T.y+T.h-(A.y+A.h)):null,
        顶栏底边到内容间距: gap,
        第一行图标: [...document.querySelectorAll('.topbar button,.topbar a')].map(e=>e.textContent.trim()).filter(Boolean).slice(0,5),
        标题文字: t?t.textContent.trim():'(没有标题元素)'
      },null,1); })()`, { timeout: 20000 }));
    await p.shot('/home/ubuntu/novel-app/docs/监督人-书架顶栏-复验.png');
  } catch (e) { console.log('!! ', e.message); }
  finally { await p.close(); }
})();
