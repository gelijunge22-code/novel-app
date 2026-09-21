/* ============================================================
   e2e-states.js — 「空白 / 加载 / 出错」三态的机器判据（第 19 轮 · 偷懒自查表第 ② 项）

   为什么有这东西：用户最不能接受的一件事就是「**偷偷显示空**」——
   连不上服务器时给一片空白，他看到的不是"网络不通"，是"我的东西没了"（2.0.2 那次事故）。
   所以三态必须**看得见**，而且要能被机器判：
     · 出错态：面板里必须出现人话（连不上 / 读不到 / 失败 / 重试），不许静默空白；
     · 空态  ：数据是空的时候必须有"还没有…"这类说明，不许给一张干净的白纸；
     · 加载态：请求没回来的时候必须有转圈/骨架（.t-load / .spinner / .skel / 正在…）。

   做法：把面板真正用到的那个接口**换成假的**（抛错 / 返回空 / 永不返回），再打开面板看屏幕。
   反证（判据必须先能红）：STATES_FORCE=nopatch → 不打补丁，那三条判据必须报红
   （正常有数据的界面里当然找不到"连不上""还没有"）。

   用法：node tools/e2e-states.js
         STATES_FORCE=nopatch node tools/e2e-states.js
   产出：docs/三态实测.json（反证 → docs/三态实测-反证.json）+ docs/前端截图/r19st-*.png
   ============================================================ */
const fs = require('fs');
const path = require('path');
const { open, sleep } = require('./cdp');
const { readPassword } = require('./preflight');

const ROOT = '/home/ubuntu/novel-app';
const FORCE = process.env.STATES_FORCE || '';
const BASE = process.env.E2E_URL || 'http://127.0.0.1:8899/';
const SHOTDIR = path.join(ROOT, 'docs/前端截图');
const OUT = path.join(ROOT, FORCE ? 'docs/三态实测-反证.json' : 'docs/三态实测.json');
const ROUND = process.env.STATES_ROUND || 'r29st';   /* 截图前缀：换前缀就不会跟上一批混 */

/* 每个窗口：怎么打开、看哪个根、这一屏会打哪个接口（只把这一类请求打假） */
/* 打开某个工具面板的固定动作（宫格 → Tools.open） */
function OPEN_TOOL(id) {
  return "(async()=>{App.show('tools');await new Promise(r=>setTimeout(r,700));"
    + "Tools.open('" + id + "');await new Promise(r=>setTimeout(r,2000));return 1;})()";
}
const ONLY = process.env.STATES_ONLY || '';        // 只跑某个 surface（调试用：STATES_ONLY=world）
/* 工具面板：**每个面板都要有三态**（用户最烦"卡住了/空白一片/东西没了没人告诉我"）。
   第 28 轮把覆盖从 5 个面板扩到 13 个 —— 判据先咬，再逐面板补（先红后绿才叫判据）。
   两条**如实说明、不进表**的：
     · `sync`（同步）是纯表单（填地址/口令/点按钮），没有"读数据"这一步，三态不适用；
     · `sync` 之外**全部**工具面板都在表里了（第 29 轮把 cover 也收了进来 ——
       它读的 api/shelf 是共用的，但判据只看 #tool-body，所以打假不影响判定）。 */
const TOOL_SPECS = [
  ['files',    'api/workspace-files/tree'],
  ['notes',    'api/notes|api/margin'],
  ['memory',   'api/projects/rag/inspector'],
  ['models',   'api/config/models'],
  ['profiles', 'api/agent/profiles'],
  ['skills',   'api/agent/skills'],
  ['jobs',     'api/agent/jobs'],
  ['history',  'api/workspace-history/inbox'],
  ['backup',   'api/passport/backups'],
  ['sessions', 'api/agent/sessions'],
  ['users',    'api/admin/users'],
  /* "关于"这屏要分开骗：版本号是**单值**（没有"空"这一说），日志才有"还没有日志"。
     空态只打日志接口，出错/加载态才连版本一起打 —— 不然测的是个不存在的场景。 */
  ['about',    { error: 'api/app/version|api/app/logs', empty: 'api/app/logs',
                 loading: 'api/app/version|api/app/logs' }],
  /* 封面这屏读的是**共用的** api/shelf（hasCover 在那儿）—— 打假会连书架一起打假。
     不碍事：判据只看 #tool-body 里面，所以照样能测它自己的三态。 */
  ['cover',    'api/shelf'],
];
const TOOL_SURFACES = TOOL_SPECS.map((x) => ({ id: 'tool-' + x[0], root: '#tool-body', api: x[1], open: OPEN_TOOL(x[0]) }));

let SURFACES = [
  { id: 'shelf', root: '#screen-shelf', api: 'api/shelf|api/projects',
    open: "(async()=>{App.show('shelf');await new Promise(r=>setTimeout(r,1400));return 1;})()" },
  { id: 'preset', root: '#screen-preset', api: 'api/presets',
    open: "(async()=>{App.show('preset');await new Promise(r=>setTimeout(r,1600));return 1;})()" },
  { id: 'lore', root: '#screen-lore', api: 'api/lore|api/world/|api/entities',
    /* 设定这一屏带缓存（S.loaded），不强制刷新的话第二次进来还是上一态的画面 —— 那会假绿。
       所以每次都 Lore.refresh() 真拉一遍。 */
    /* ⚠ 这里**不许 await** Lore.refresh()：加载态那一步请求是"永远不回"的，
       await 它 = 这个探针永远不 settle = 脚本僵死（第 29 轮白等 4 分钟就是这个）。
       不 await 也能测：refresh 会先把"正在读…"画上去，我们再等一会儿看屏幕。 */
    open: "(async()=>{App.show('lore');await new Promise(r=>setTimeout(r,700));"
      + "Lore.refresh();await new Promise(r=>setTimeout(r,1800));return 1;})()" },
].concat(TOOL_SURFACES);



const ERR_RE = /连不上|读不到|失败|出错|重试|没有网络|网络/;
const EMPTY_RE = /还没有|没有一|没有正在|没有待|没有\S{1,6}过|空|先去|暂无|没有任何|第一次|还没/;
/* 加载态看得见的证据：转圈 / 骨架 / 「正在…」提示。
   注意书架用的是 .skel-card/.skel-cover/.skel-lines（`.skel` 这种精确类名匹配不到它），
   第 19 轮就是这么发现「骨架在转、判据却看不见」的。 */
const LOAD_SEL = [
  '[data-state="loading"]',            /* 三态容器自己带的标记（本轮统一：UI.state/UI.skeleton 都会打） */
  '.t-load', '.spinner', '.loading', '.t-hint', '.preset-loading',
  '.skeleton', '.ui-skel',             /* 统一后的骨架（components.css / ui.js） */
  '.skel-card', '.skel-cover', '.skel-lines',   /* 老的一批，留着防回退 */
  '.sk-card', '.sk-thumb', '.sk-line',
].join(', ');

(async () => {
  fs.mkdirSync(SHOTDIR, { recursive: true });
  const s = await open({ port: 9396, width: 390, height: 844, settle: 900 });
  const js = s.js;
  const R = [];
  if (ONLY) SURFACES = SURFACES.filter((x) => x.id.indexOf(ONLY) >= 0);
  /* 报告**每判一条就落一次盘**：这轮被通道中断杀过两次，最后那份 JSON 是整轮跑完才写的 ——
     一被杀就全没了，只能从头再跑一遍。现在随时杀掉，前面判过的都在。 */
  const reportOf = () => ({ at: new Date().toISOString(), base: BASE, force: FORCE || '(正常)',
    total: R.length, fails: R.filter((x) => !x.ok).length, items: R });
  const chk = (name, ok, detail) => {
    R.push({ name, ok: !!ok, detail: detail === undefined ? '' : detail });
    fs.writeFileSync(OUT, JSON.stringify(reportOf(), null, 1));
    console.log((ok ? '  ✓ ' : '  ✗ ') + name + '   ' + JSON.stringify(detail === undefined ? '' : detail));
  };

  await s.nav(BASE + '?states=' + Date.now());
  for (let i = 0; i < 40; i++) {
    const gone = await js("(()=>{const sp=document.getElementById('splash');return !!(sp&&(sp.classList.contains('gone')||getComputedStyle(sp).opacity==='0'));})()");
    if (gone) break; await sleep(120);
  }
  if (await js("document.getElementById('login') && !document.getElementById('login').classList.contains('hidden')")) {
    await js("(()=>{const i=document.getElementById('login-pass');i.value=" + JSON.stringify(readPassword())
      + ";i.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('login-go').click();return 1})()");
    await sleep(4200);
  }

  /* 打补丁：只骗一类接口（正则），其它照旧走真后端。
     两条路要分开骗，因为它们的"返回值形状"不一样：
       · fetch 那条（API.raw / API.shelf 之类）拿到的是 Response，前端会读 r.status / r.ok / r.text()；
         （第 19 轮踩过：以前这里直接给一个普通对象，前端读 r.text 时炸成
          「书架打不开：r.text is not a function」——于是"空态"根本没被测到，判出来的是假红。）
       · API.nb 那条拿到的是已经解析好的数据。 */
  await js(`(() => {
    /* ⚠ fetch 必须**绑定到 window** 再存起来：原生 fetch 要求 this 是 window，
       存进一个普通对象、再用 obj.fetch(...) 那样调，会直接抛
        Illegal invocation —— 于是我这边"没打假的那些请求"全变成了网络错误，
       面板全显示"连不上服务器"（第 19 轮自己踩的，查了半天）。 */
    window.__stOrig = { nb: window.API.nb, fetch: window.fetch.bind(window) };
    window.__stMode = ''; window.__stRe = null;
    const hang = () => new Promise(() => {});
    const fail = () => { const e = new Error('连不上服务器'); e.offline = true; e.status = 0; return Promise.reject(e); };
    /* ── 「空态」怎么造：**真空，但形状跟真后端一模一样** ──────────────────
       以前这里返回一个**写死的对象**（只列了 items/chapters/... 十来个键）。
       后果：预设那种读 d.profiles 的面板拿到 undefined，直接抛异常 → 屏上写
       「读不到预设：Cannot read properties of undefined (reading 'some')」，
       而空态判据又从别处的文案里匹配到了「还没有」→ **判据报绿、屏上是红的**
       （第 29 轮自己抓出来的假绿，正是用户最恨的那种"骗人的绿"）。
       现在改成：**先真发一次这个请求，拿到真形状，再把数组清空、键名保留、数字归零** ——
       形状永远跟着真后端走，面板走的是它**自己的空态分支**，不是异常分支。 */
    const emptyOf = (v, dep) => {
      const d = dep || 0;
      if (d > 8) return v;
      if (Array.isArray(v)) return [];
      if (v && typeof v === 'object') {
        const o = {};
        Object.keys(v).forEach((k) => { o[k] = emptyOf(v[k], d + 1); });
        return o;
      }
      if (typeof v === 'number') return 0;
      if (typeof v === 'boolean') return false;
      if (typeof v === 'string') return '';
      return v;
    };
    /* 真形状拿不到（后端恰好也挂了）时，退回一个**空对象**：
       宁可让面板报"形状不对"，也不要再拿一份写死的假数据去骗判据。 */
    const emptyNb = (p, o) => window.__stOrig.nb(p, o).then((d) => emptyOf(d)).catch(() => ({}));
    const emptyFetch = (u, o) => window.__stOrig.fetch(u, o).then(async (r) => {
      let body = {};
      try { body = emptyOf(JSON.parse(await r.text())); } catch (e) { body = {}; }
      return { ok: true, status: 200, statusText: 'OK', headers: r.headers, url: r.url,
        json: async () => body, text: async () => JSON.stringify(body) };
    });
    const mode = (p) => {
      if (!window.__stRe || !window.__stRe.test(String(p))) return '';
      return window.__stMode;
    };
    window.__stHit = []; window.__stAll = [];
    window.API.nb = (p, o) => {
      const m = mode(p);
      window.__stAll.push((m || '·') + ' nb ' + String(p));
      if (m) window.__stHit.push(m + ' ' + String(p));
      if (m === 'error') return fail();
      if (m === 'loading') return hang();
      if (m === 'empty') return emptyNb(p, o);
      return window.__stOrig.nb(p, o);
    };
    window.fetch = (u, o) => {
      const m = mode(u);
      window.__stAll.push((m || '·') + ' fetch ' + String(u));
      if (m) window.__stHit.push(m + ' ' + String(u));
      if (m === 'error') return fail();
      if (m === 'loading') return hang();
      if (m === 'empty') return emptyFetch(u, o);
      return window.__stOrig.fetch(u, o);
    };
    window.__stSet = (m, re) => { window.__stMode = m; window.__stRe = re ? new RegExp(re) : null; return 1; };
    return 1;
  })()`);

  const TITLE = (mode) => (mode === 'error' ? '出错态要说人话'
    : mode === 'empty' ? '空态要有说明（且不许是出错态）' : '加载态要看得见');

  for (const sf of SURFACES) {
    for (const mode of ['error', 'empty', 'loading']) {
      /* 每步先落一行「走到哪了」。没有这行，卡住的时候日志停在**上一条**，
         看起来像"上一条卡了"，其实卡的是这一条 —— 第 29 轮白查了一轮。 */
      console.log('  → ' + sf.id + ' / ' + mode);
      try {
      /* 同一个屏，三种状态要骗的接口**不一定一样**（比如"关于"这屏：
         版本号是个单值、没有"空"这一说，日志才有"还没有日志"）——
         所以允许 `api` 写成 {error, empty, loading} 分别指定。 */
      const re = (sf.api && typeof sf.api === 'object') ? sf.api[mode] : sf.api;
      if (FORCE === 'nopatch') await js("window.__stSet('', null)");
      else await js("window.__stSet(" + JSON.stringify(mode) + ", " + JSON.stringify(re) + ")");
      await js('window.__stHit = []');          /* 每步单独记：证据要能看出这一步骗了谁 */
      /* 打开这一步给足 15 秒：它内部本身就有 2~3 秒的等待 */
      await js(sf.open, { timeout: 15000 });
      await sleep(mode === 'loading' ? 400 : 900);
      const seen = await js(`(() => {
        const root = document.querySelector(${JSON.stringify(sf.root)}) || document.body;
        const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
          return r.width > 1 && r.height > 1 && cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > .1; };
        const loaders = [...document.querySelectorAll(${JSON.stringify(LOAD_SEL)})].filter(vis).length;
        /* 三态容器（全站那一个 UI.state/UI.skeleton，都带 data-state）。
           **判据必须只看容器里的字**：以前看整屏文字，于是"关于"那屏里一句静态说明
           （"...连不上会写明原因..."）把空态判成了出错态（假红）；
           反过来"面板读崩了、只写一句读不到"也能被别处的"还没有"糊过去（假绿）。 */
        const stEls = [...root.querySelectorAll('[data-state]')].filter(vis);
        const txtOf = (k) => { const e = stEls.find((x) => x.getAttribute('data-state') === k);
          return e ? ((e.innerText || '').replace(/\\s+/g, ' ').trim()) : ''; };
        return { text: (root.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 700),
                 len: (root.innerText || '').replace(/\\s+/g, '').length, loaders: loaders,
                 stateEmpty: txtOf('empty'), stateError: txtOf('error'),
                 stateLoading: stEls.filter((x) => x.getAttribute('data-state') === 'loading').length,
                 stateCount: stEls.length };
      })()`);
      /* 加载态**不许**用"屏幕上字少"当判据（空白屏也字少，那是假绿）：
         必须真看见转圈/骨架，或者出现"正在读…"这类话。 */
      /* 空态这条还要多咬一口：**它不许其实是个出错态**。
         没有这一口，"面板读崩了、写一句『读不到 X：…』"会被满屏别的文案里的「还没有」糊过去，
         判据报绿、用户看到的是红 —— 第 29 轮就是这么抓出 preset 那条假绿的。
         验完请拿 STATES_FORCE=nopatch 跑一遍：**这三条都必须报红**（判据先能红才算判据）。 */
      /* 判据（第 29 轮收紧）：
         ① 三态必须走**全站那一个容器**（UI.state/UI.skeleton，带 data-state）——
            没走 = 这屏的三态还没统一（用户说的"一个 App 里三种长相"），判红；
         ② 只看**容器里的字**：空态要有说明、且**不许是出错话**（"读不到 X"糊成空态，
            用户分不清"没东西"和"坏了"）；出错态必须是**人话**；
         ③ 加载态要有转圈/骨架/「正在读…」。
         另外拿 STATES_FORCE=nopatch 跑一遍：**这些都必须报红**（判据先能红才算判据）。 */
      const boxT = mode === 'error' ? seen.stateError : mode === 'empty' ? seen.stateEmpty : '';
      const boxed = mode === 'loading' ? seen.stateLoading > 0 : !!boxT;
      const errish = ERR_RE.test(' ' + boxT + ' ');
      const hit = !boxed ? false
        : mode === 'error' ? ERR_RE.test(' ' + boxT + ' ')
          : mode === 'empty' ? (EMPTY_RE.test(' ' + boxT + ' ') && !errish)
            : (seen.loaders > 0 || /正在|加载中|读取中|准备/.test(' ' + (seen.text || '') + ' '));
      const why = boxed ? ((mode === 'empty' && errish) ? '空态里出现了出错词 → 其实是出错态' : '')
        : '没走全站那套三态容器（data-state）—— 这一屏的三态还没统一';
      const hits = await js('(window.__stHit||[])');
      await s.shot(path.join(SHOTDIR, ROUND + '-' + sf.id + '-' + mode + '.png'));
      chk('三态 · ' + sf.id + ' · ' + TITLE(mode)
        + (mode === 'loading' ? '（转圈/骨架/正在…）' : ''), hit,
        { 文字长度: seen.len, 转圈: seen.loaders, 三态容器: seen.stateCount,
          容器里的话: boxT.slice(0, 120), 打假了: hits, 为什么: why,
          屏上一角: (seen.text || '').slice(0, 80) });
      } catch (e) {
        /* 面板卡住（探针超时）= 用户看到的是"转圈转到天荒地老"，这是**真的红**，不是脚本的问题。
           判红之后继续跑下一屏 —— 一次把所有的坑都找出来，别让一条卡死的把整轮拖没。 */
        chk('三态 · ' + sf.id + ' · ' + TITLE(mode)
          + (mode === 'loading' ? '（转圈/骨架/正在…）' : ''), false,
          { 为什么: e && e.timeout ? '面板卡住了：探针超时，这一屏根本没画出来' : String((e && e.message) || e) });
      }
    }
  }
  await js("window.__stSet('', null)");

  const bad = R.filter((x) => !x.ok);
  fs.writeFileSync(OUT, JSON.stringify(reportOf(), null, 1));
  /* 反证跑：判据必须报红才算通过（报绿说明这三条判据是空的） */
  let code;
  if (FORCE) { code = bad.length ? 0 : 1; console.log('\n反证跑：报红 ' + bad.length + ' 条 → ' + OUT); }
  else { code = bad.length ? 1 : 0; console.log('\n' + (bad.length ? '有 ' + bad.length + ' 条没过' : '全部通过（' + R.length + ' 条）') + ' → ' + OUT); }
  s.close();
  process.exit(code);
})().catch((e) => { console.error('跑挂了：', e); process.exit(2); });
