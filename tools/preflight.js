/* ============================================================
   preflight.js — 界面走查开跑前的护栏（第 9 遍打磨加）

   为什么要有它：**并发跑两个会改书架的脚本，界面走查的结果不可信**。
   第 9 遍打磨真踩过：`perf_test.py` 和 `e2e-new.js` 一起跑，
   perf 往书架上塞了一本 201 章的自测书，走查脚本取的是"书架第一张卡"，
   于是质检/声音那几步全变成红色 —— 13/28 全是**假红**，单独重跑立刻 28/28。

   这件事的坏处不只是浪费时间：假红会让人去改没坏的东西，假绿会放过真 bug。
   所以现在开跑前先看一眼书架：
     · 架上有自测书 → 拒绝开跑，说清是哪几本、谁可能在并发；
     · 选书卡时**跳过自测书**（万一用户真的留了一本，也别让走查点进去）。

   用法：
     const { shelfShield, pickCardExpr } = require('./preflight');
     await shelfShield({ api, script: 'e2e-new.js' });     // 不合格直接 process.exit(2)
     await js(pickCardExpr());
   ============================================================ */
const SCRATCH = /^(zz-|zzperf|界面实测|走查|e2e|性能自测|书名带空格|魔鬼|tmp-|test-|切书自测|当前书自测)/i;

function isScratch(title, slug) {
  return SCRATCH.test(String(title || '')) || SCRATCH.test(String(slug || ''));
}

/** 查书架；发现自测书就打印人话并退出（exit 2），别让一次假红浪费半小时排查。 */
async function shelfShield({ api, script, allow = process.env.E2E_ALLOW_SCRATCH === '1' }) {
  const r = await api('GET', '/api/shelf');
  if (!r || r.status !== 200) {
    console.error(`[preflight] 书架读不到（HTTP ${r && r.status}）—— 后端起来了吗？`);
    process.exit(2);
  }
  const books = ((r.json || {}).projects) || [];
  const culprits = books.filter((b) => isScratch(b.title, b.slug));
  console.log(`[preflight] 书架上有 ${books.length} 本书，其中自测书 ${culprits.length} 本` +
    (culprits.length ? `：${culprits.map((b) => b.slug).join(', ')}` : ''));
  if (culprits.length && !allow) {
    console.error(
      `\n[preflight] 拒绝开跑：${script} 的界面走查要一架干净的书架。\n` +
      '  多半是有另一个脚本正在并发跑（perf_test / verify_* / 另一个 e2e），\n' +
      '  或者上一轮没清干净。并发跑出来的红是**假红**，别拿它当结论。\n' +
      '  先等它跑完 / 把自测书删掉；确实要让走查跳过它们：E2E_ALLOW_SCRATCH=1 node ' + script + '\n');
    process.exit(2);
  }
  return { books, culprits };
}

/** 取书卡的选择器：优先"不是自测书"的那张，全都不是就取第一张。 */
function pickCardExpr(sel = '#shelf-list .book-card, #shelf-list [data-slug]') {
  return `(() => {
    const bad = ${SCRATCH.toString()};
    const cards = [...document.querySelectorAll(${JSON.stringify(sel)})];
    if (!cards.length) return 'no-book';
    const titleOf = (c) => ((c.querySelector && c.querySelector('.book-title')) || {}).textContent || '';
    const ok = cards.find((c) => !bad.test(titleOf(c)) && !bad.test(c.dataset.slug || ''));
    const c = ok || cards[0];
    if (bad.test(titleOf(c)) || bad.test(c.dataset.slug || '')) return 'scratch-only';
    c.click();
    return 'ok:' + (c.dataset.slug || titleOf(c));
  })()`;
}

/** 给"自己没写 api() 的走查脚本"用：登录一次，返回一个带 cookie 的 api(method, path, body)。 */
function readPassword() {
  try {
    const cfg = JSON.parse(require('fs').readFileSync('/home/ubuntu/nbapp/config.json', 'utf8'));
    return cfg.app_password || cfg.password || '';
  } catch (e) { return ''; }
}

function makeApi(base = process.env.E2E_URL || 'http://127.0.0.1:8899/') {
  let cookie = '';
  const b = base.replace(/\/$/, '');
  return async function api(method, path, body) {
    const r = await fetch(b + path, {
      method,
      headers: Object.assign({ 'content-type': 'application/json' }, cookie ? { cookie } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) cookie = sc.map((c) => c.split(';')[0]).join('; ');
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (e) {}
    return { status: r.status, json, text };
  };
}

/** 一步到位：建好 api 并跑护栏（给没有登录逻辑的脚本用）。 */
async function shieldOnly(script, base) {
  const api = makeApi(base);
  const r = await api('POST', '/api/app/login', { password: readPassword() });
  if (r.status !== 200) {                    // 登录都不成，后面拿到的 401 全是噪音
    console.error(`[preflight] 登录失败（HTTP ${r.status}）—— 口令读不到还是后端没起？`);
    process.exit(2);
  }
  return shelfShield({ api, script });
}

module.exports = { shelfShield, pickCardExpr, isScratch, SCRATCH, makeApi, shieldOnly, readPassword };
