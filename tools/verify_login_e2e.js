/* verify_login_e2e.js —— 真浏览器实测：① 输密码登录 ② 免登录链接 */
const { open, sleep } = require('./cdp.js');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:8899/';

(async () => {
  const PW = '[REDACTED-PASSWORD]';
  const p = await open({ port: 9433, width: 390, height: 844, settle: 1500 });
  const out = {};
  try {
    // ── A. 密码登录 ──
    await p.js(`(() => { try { localStorage.clear(); } catch(e){} return 1; })()`).catch(()=>{});
    await p.nav(BASE);
    await sleep(4500);
    out.A1_打开首页 = await p.js(`(() => {
      const lg = document.getElementById('login'), el = document.getElementById('login-pass');
      return { 显示登录页: lg ? !lg.classList.contains('hidden') : null,
               提示: (document.getElementById('login-msg')||{}).textContent || '',
               autocomplete: el ? el.getAttribute('autocomplete') : '?' };
    })()`);
    await p.js(`(() => {
      const el = document.getElementById('login-pass');
      el.focus(); el.value = ''; el.value = ${JSON.stringify(PW)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('login-go').click(); return true;
    })()`);
    await sleep(7000);
    out.A2_点进入后 = await p.js(`(() => {
      const lg = document.getElementById('login');
      return { 还在登录页: lg ? !lg.classList.contains('hidden') : null,
               提示: (document.getElementById('login-msg')||{}).textContent || '',
               书架卡片数: document.querySelectorAll('#shelf-list > *').length,
               屏幕首行: document.body.innerText.slice(0, 80).replace(/\\n/g, ' | ') };
    })()`);
    await p.shot('/home/ubuntu/novel-app/docs/监督人-登录实测-A密码.png');

    // ── B. 免登录链接 ──
    const tok = fs.readFileSync('/tmp/token.txt', 'utf8').trim();
    await p.js(`(() => { try { localStorage.clear(); } catch(e){} return 1; })()`);
    await p.nav(BASE + '?t=' + encodeURIComponent(tok));
    await sleep(6500);
    out.B_免登录链接 = await p.js(`(() => {
      const lg = document.getElementById('login');
      return { 还在登录页: lg ? !lg.classList.contains('hidden') : null,
               书架卡片数: document.querySelectorAll('#shelf-list > *').length,
               屏幕首行: document.body.innerText.slice(0, 80).replace(/\\n/g, ' | ') };
    })()`);
    await p.shot('/home/ubuntu/novel-app/docs/监督人-登录实测-B链接.png');
  } catch (e) { out.出错 = String(e.message || e).slice(0, 200); }
  finally { await p.close(); }
  console.log(JSON.stringify(out, null, 1));
})();
