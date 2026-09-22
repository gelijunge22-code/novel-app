/* ============================================================
   api.js — 跟服务器的全部通信都从这里走。
   所有地址都是相对路径（页面可能挂在 / 也可能挂在 /nbapp/ 这类前缀下）。
   ============================================================ */
(function () {
  /* 后端会 emit 的全部事件种类（见 server/events.py 的 emit 调用处）。
     加新事件时这里和 chat.js 的 handleEvent 要一起加，别只改后端。 */
  const SSE_KINDS = ['connected', 'snapshot_required', 'session_state_changed', 'session_entry',
    'message_start', 'message_update', 'agent_end', 'tool_execution_start', 'tool_execution_end',
    'orchestra_run_start', 'orchestra_step_start', 'orchestra_step_end', 'orchestra_run_end',
    'turn_context'];

  /* ── 传输层：一份前端，两种跑法 ─────────────────────────────────────────
     App 里：window.NBApp 是安卓的 JS 桥（@JavascriptInterface）。接口**进程内直接调**，
             不过网卡、不开端口、不需要服务器 —— 飞行模式照用，开屏也不再等服务器。
     浏览器里：什么都没有，照旧 fetch —— 网页版一行不受影响。
     媒体（听书音频 / 封面 / 导出下载）必须走字节流，App 里回落到本机 127.0.0.1，
     并把口令带在 URL 上（跨源拿不到 cookie）。见 API.media()。           */
  const NBApp = (typeof window !== 'undefined' && window.NBApp
    && typeof window.NBApp.request === 'function') ? window.NBApp : null;
  /* 桥能不能干活，问 Java（NBApp.ready）。
     ⚠️ 以前这里问的是 localReady() —— 那是"手机里那份 Python 起没起"。
     现在后端默认在服务器上（用户拍板，见 docs/决策记录 D13），Python 根本不启动，
     再按 localReady 判就会以为桥没用 → 掉头去发跨源 fetch → file:// 下必撞墙。
     桥的另一头现在**可以是服务器**（Java 代发 HTTP，没有跨源问题）。 */
  const bridgeUsable = () => {
    if (!NBApp) return false;
    try {
      if (typeof NBApp.ready === 'function') return !!NBApp.ready();
      return typeof NBApp.localReady !== 'function' || NBApp.localReady();
    } catch (e) { return false; }
  };
  /* 调安卓桥。**第三个参数是要传过去的实参** —— 以前这里写死了"不传参"，
     所以 callBridge('saveToken', t) 会把空值存进去（差点让"记住登录"白做）。
     语义保持不变：桥没有/抛错/返回空 → 用 fallback。 */
  const callBridge = (name, fallback, arg) => {
    try {
      if (!(window.NBApp && typeof window.NBApp[name] === 'function')) return fallback;
      const v = (arg === undefined) ? window.NBApp[name]() : window.NBApp[name](arg);
      return v || fallback;
    } catch (e) { return fallback; }
  };
  /* 后端前缀/口令**每次用的时候现问**，不在加载那一刻定死。
     原因：本机 Python 后端要几秒才起来，而界面是**立刻**放出来的（不再黄屏等待）。
     以前是解析时读一次 —— 那一瞬间还是空的，于是所有绝对地址都退化成 file://…，全军覆没。 */
  /* 服务器地址兜底：**只在 file://（App 内嵌壳）下用**。
     正常情况是桥给的（Java 那份 DEFAULT_SERVER，唯一出处）；
     这一份是"万一桥没装上 / 桥坏了"时的备用轮胎 —— 前端自己也能直连服务器把界面撑起来
     （跨源那条路已经通了：服务器给了 CORS，口令走 URL/头）。
     浏览器里（http 来源）**一律不兜底**：相对路径天然就是对的，写死地址反而会指错机器。
     ⚠️ 这个值必须跟 apk/.../MainActivity.java 的 DEFAULT_SERVER 一致，
        tools/verify_apk.sh 有一条断言盯着它俩。 */
  /* 没有兜底地址了：开源版**不许写死任何人的服务器** —— 写死的那台，
     所有 clone 下来的人都会往作者的机器上打。
     App 第一次打开要自己在登录页点「服务器设置」填地址；浏览器里本来就不需要它
     （http 来源下相对路径天然是对的）。 */
  const FALLBACK_BASE = '';
  const baseOf = () => callBridge('base', '') || FALLBACK_BASE;
  /* ── 会话口令 ────────────────────────────────────────────────────────────
     两条来源，取到哪条算哪条：
       ① 安卓桥给的（Java 拿着 httponly cookie，从 Set-Cookie 里抠出来的）；
       ② 登录时服务器在返回体里给的那一份（存在本机）。
     为什么要 ②：App 的界面是 file:// 来源、服务器是 http:// 来源 —— 两个不同的源，
     跨源请求带不上 cookie。**字节流**（封面 / 听书音频 / 导出下载 / APK）和 EventSource
     只能把口令挂在 URL 上（服务器认 ?token=，见 server/security.py 的 token_from）。
     顺带也是兜底：万一安卓桥这条道断了，前端自己也能直连服务器把界面撑起来。 */
  /* 前端版本戳：**每次改前端都改它**。
     为什么要有：App 的界面是打进安装包里的，出了"改了没生效"的问题时，
     得有一个一眼能看出"现在跑的是哪一份前端"的东西，不然只能靠猜。 */
  const FE_STAMP = 'FE-2026-09-22-c';
  const REQLOG = [];            // 最近几次请求的耗时（自检面板要看）
  const noteReq = (path, ms, ok) => {
    try {
      REQLOG.push({ p: String(path).slice(0, 60), ms: Math.round(ms), ok: !!ok });
      if (REQLOG.length > 30) REQLOG.shift();
    } catch (e) {}
  };
  window.__feStamp = () => FE_STAMP;
  window.__reqlog = () => REQLOG.slice();
  const SESS_KEY = 'nbapp.sess.v1';
  let MEM_TOKEN = '';            // localStorage 写不进去时（有些 WebView 对 file:// 禁写）放内存里
  const sessToken = () => {
    try { return localStorage.getItem(SESS_KEY) || MEM_TOKEN; } catch (e) { return MEM_TOKEN; }
  };
  const setSessToken = (t) => {
    MEM_TOKEN = t || '';
    try { if (t) localStorage.setItem(SESS_KEY, t); else localStorage.removeItem(SESS_KEY); } catch (e) {}
    /* **同时存到 App 的盘上**：界面是 file:// 打开的，安卓不保证这种页面的
       localStorage 跨重启保留 —— 以前 App 每次重开都要重新输密码就是这个原因。
       桥在就存一份；不在（浏览器里）无所谓。 */
    try { if (t) callBridge('saveToken', t); } catch (e) {}
  };
  const tokenOf = () => callBridge('token', '') || sessToken();

  /* 页面自己是从哪儿加载的：
       file://  → 相对路径会被解析成 file:///…（考古现场：真机上"对话流不出来 / 封面不显示 /
                  上传报错 / 版本检查永远失败"全是这一条），必须走本机 127.0.0.1 的绝对地址；
       http(s)://→ 同源，相对路径天然就对，一行都不用改。
     修完之后 App 无论从 assets 还是从本机服务加载，这一层都自动对上。 */
  const ON_FILE = (typeof location !== 'undefined' && location.protocol === 'file:');

  /* 把接口路径变成"能直接塞进 <img>/<audio>/下载"的地址 */
  const media = (path) => {
    const p = String(path || '');
    const base = baseOf();
    if (!base) return p;                             // 浏览器里：相对路径照旧
    const u = base.replace(/\/$/, '') + '/' + p.replace(/^\//, '');
    const tok = tokenOf();
    if (!tok) return u;
    return u + (u.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(tok);
  };

  /* 给"必须让浏览器自己去发"的请求用（EventSource / FormData 上传 / 流式下载）：
     这些没法走 JS 桥（桥是同步返回字符串的），所以得有一个**发得出去的**地址。
     同源时原样返回，file:// 下换成带口令的绝对地址。 */
  const abs = (path) => {
    const p = String(path || '');
    if (!ON_FILE) return p;     // 同源（页面本身就是 http/https 打开的）：相对路径天然就对
    return media(p);            // file://（App 内嵌前端）：必须换成带口令的绝对地址
  };

  /* 桥那条路：拿 Java 返回的 JSON 信封，照 fetch 的语义抛错（401 一样弹登录） */
  const bridgeCall = (method, path, bodyObj) => {
    const raw = NBApp.request(method, path, bodyObj ? JSON.stringify(bodyObj) : '');
    let env = null;
    try { env = JSON.parse(raw); } catch (e) { env = null; }
    if (!env) {
      const err = new Error('本机后端返回看不懂的东西');
      err.status = 0; throw err;
    }
    if (!env.status) {
      const err = new Error(env.error || '本机后端没起来');
      err.status = 0; err.offline = true; throw err;
    }
    let data = null;
    try { data = env.body ? JSON.parse(env.body) : null; } catch (e) { data = env.body; }
    if (env.status === 401) { App.needLogin(); throw new Error('未登录'); }
    if (env.status >= 400) {
      const msg = (data && (data.detail || data.message)) || ('请求失败 ' + env.status);
      const err = new Error(typeof msg === 'string' ? msg : '请求失败 ' + env.status);
      err.status = env.status; err.data = data;
      throw err;
    }
    return data;
  };

  /* ── 后端就绪握手 ──────────────────────────────────────────────────────
     App 那边把"走本机（离线全功能）还是走服务器"定下来之后会敲 window.__backendReady。
     前端 boot 先等它一下，再决定怎么渲染、要不要提示"现在在服务器模式"。
     浏览器里没人敲 —— 等一个很短的超时直接过，行为跟以前一模一样。 */
  let BACKEND = null;
  const backendWaiters = [];
  window.__backendReady = (info) => {
    BACKEND = info || { mode: 'shell' };
    if (BACKEND.base) window.__nbMediaBase = BACKEND.base;
    backendWaiters.splice(0).forEach((f) => { try { f(BACKEND); } catch (e) {} });
    return true;
  };
  const backend = () => BACKEND;
  const waitBackend = (ms) => new Promise((resolve) => {
    if (BACKEND) { resolve(BACKEND); return; }
    const t = setTimeout(() => resolve(BACKEND || { mode: 'web' }), ms || 3500);
    backendWaiters.push((v) => { clearTimeout(t); resolve(v); });
  });

  const rawJ = async (path, opts = {}) => {
    const __t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    // 桥优先：只有 JSON 走桥；FormData 上传、流式生成还是走 HTTP（桥是同步返回字符串的）
    /* ══════════════════════════════════════════════════════════════════
       **JSON 请求一律不走桥** —— 用户报的"卡顿/延迟"真凶就在这一行。

       桥是**同步**调用：JS 调 Java，要**停下来等** Java 把 HTTP 发完再回话。
       公网上一个来回几百毫秒，界面就跟着卡几百毫秒 —— 每次请求都卡一下。
       老版 App 用的是 fetch（异步、不挡界面），所以当年丝滑；改成"内嵌前端"之后，
       为了绕开 file:// 的跨源限制才把请求塞进桥，代价就是这个卡顿。

       现在 WebView 已经开了跨源（setAllowUniversalAccessFromFileURLs(true)），
       服务器也给了 CORS，所以直接 fetch 就行 —— 异步、不挡界面。
       桥只留给"必须同步拿值"的小事：版本号、震动、下载、存口令。
       ══════════════════════════════════════════════════════════════════ */
    const USE_SYNC_BRIDGE = false;
    if (USE_SYNC_BRIDGE && bridgeUsable() && !opts.formData && !opts.stream) {
      try {
        return bridgeCall((opts.method || 'GET').toUpperCase(), path, opts.body || null);
      } catch (bridgeErr) {
        /* status===0 = 桥这条路根本没跑起来（Python 还在启动 / 崩了 / 桥没装上）。
           这时候别把界面直接扔进"连不上"——只要本机服务地址已经知道，就先试一次 HTTP；
           两条路都不行才往外抛。真机上"点进去一片黄、什么都没有"就是少了这一步。 */
        if (!(bridgeErr && bridgeErr.status === 0 && baseOf())) throw bridgeErr;
      }
    }
    /* 后端地址还不知道（App 里启动那几秒，或者本机/服务器都没起来）：
       直接给一句人话，**不要**往 file:///…/api/… 上打一发注定失败的请求 ——
       那样网络面板里会留下一串打不出去的地址，排错时特别误导人。 */
    if (ON_FILE && !baseOf()) {
      const err = new Error('App 还在启动后端的服务，稍等一下');
      err.offline = true; err.status = 0;
      throw err;
    }
    let r;
    try {
      const tk = tokenOf();
      const hdr = {};
      if (opts.body) hdr['content-type'] = 'application/json';
      if (tk) hdr['x-token'] = tk;          // 跨源时 cookie 带不上，口令走这个头
      r = await fetch(abs(path), {
        credentials: 'include',
        headers: hdr,
        ...opts,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
    } catch (netErr) {
      // fetch 直接抛 = 压根没连上（断网 / 服务器没起来），跟 401 是两回事
      const err = new Error('连不上服务器');
      err.offline = true;
      throw err;
    }
    if (r.status === 401) { App.needLogin(); throw new Error('未登录'); }
    const txt = await r.text();
    let data = null;
    try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
    if (!r.ok) {
      const msg = (data && (data.detail || data.message)) || ('请求失败 ' + r.status);
      const err = new Error(typeof msg === 'string' ? msg : '请求失败 ' + r.status);
      err.status = r.status; err.data = data;
      try { noteReq(path, (performance.now() - __t0), false); } catch (e2) {}
      throw err;
    }
    try { noteReq(path, (performance.now() - __t0), true); } catch (e2) {}
    return data;
  };

  /* ── 同一时刻的重复请求合并 ────────────────────────────────────
     用户报"App 有些说不上来的延迟"。实测：启动一路下来
     `api/shelf` / `api/projects` / `agent/sessions` **各被请求 3 次** ——
     在服务器本机看不出（5 毫秒），但手机走公网每个来回都是几百毫秒，
     多出来的 6~8 次就是好几秒。

     规矩：
       · 只有 GET 合并；POST/PUT/DELETE 一律直发，绝不省
       · 同一个地址**正在路上**时，第二个调用直接等第一个的结果（不再发一次）
       · GET 再给 1.2 秒的极短缓存：连着切页/重复渲染不重复打
       · **任何写操作之后立刻清空缓存**，所以不会看到旧数据
       · 流式(SSE)、上传(FormData) 不碰
  */
  const INFLIGHT = new Map();
  const GETCACHE = new Map();
  const GET_TTL = 1200;
  const clearReadCache = () => GETCACHE.clear();
  const j = (path, opts = {}) => {
    const method = String(opts.method || 'GET').toUpperCase();
    if (method !== 'GET' || opts.stream || opts.formData) {
      return rawJ(path, opts).then((v) => { clearReadCache(); return v; });   // 写过 → 旧读作废
    }
    const key = String(path);
    const hit = GETCACHE.get(key);
    if (hit && (Date.now() - hit.at) < GET_TTL) return Promise.resolve(hit.val);
    const fly = INFLIGHT.get(key);
    if (fly) return fly;                    // ← 关键：不再发第二个请求
    const pr = rawJ(path, opts).then((v) => {
      GETCACHE.set(key, { at: Date.now(), val: v });
      return v;
    }).finally(() => { INFLIGHT.delete(key); });
    INFLIGHT.set(key, pr);
    return pr;
  };

  const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');

  window.API = {
    raw: j,
    media,                       // 媒体地址（App 里自动指向本机 127.0.0.1 并带口令）
    abs,                         // 给 EventSource / 上传 / 流式下载用的"发得出去的地址"
    bridged: !!NBApp,            // 前端在 App 里（走桥）还是浏览器里（走 HTTP）
    backend, waitBackend,        // 后端定下来了吗（本机离线 / 服务器 / 浏览器）
    base: baseOf,                // 当前后端前缀（App 里是本机 127.0.0.1 或服务器地址）
    /* 口令与查询串拼法也放出来（第 33 轮）：听书自检要**自己发一次 fetch**去量
       HTTP 码 / Content-Type / 字节数 / 开头四字节 —— 走 j() 那条路拿不到这些。 */
    token: tokenOf,
    qs: qs,

    /* 登录 / 基本信息 */
    info: () => j('api/app/info'),
    status: () => j('api/app/status'),
    login: async (password) => {
      const d = await j('api/app/login', { method: 'POST', body: { password } });
      if (d && d.token) setSessToken(d.token);
      return d;
    },
    /* 手机端（App 自带后端）用启动时那次握手拿到的本地口令自动登录，用户不用输密码 */
    loginToken: async (token) => {
      const d = await j('api/app/login', { method: 'POST', body: { token } });
      if (d && d.token) setSessToken(d.token);
      return d;
    },
    logout: async () => {
      const d = await j('api/app/logout', { method: 'POST', body: {} });
      setSessToken('');
      return d;
    },
    sessionToken: sessToken,        // 排错/测试用：现在手上是哪一串口令
    /* 直接采用一串已有的口令（免登录链接 / 从别处带过来）——
       以前没有这个出口，所以地址上带 ?t=<会话口令> 在网页端完全没用。 */
    useToken: (t) => { setSessToken(t || ''); return sessToken(); },

    /* 书架 / 正文 */
    shelf: () => j('api/shelf'),
    book: (slug, refresh) => j('api/book?' + qs({ slug, refresh: refresh ? 1 : 0 })),
    chapter: (slug, path) => j('api/chapter?' + qs({ slug, path })),
    saveFile: (slug, path, content, expectedMtimeMs) =>
      j('api/chapter', { method: 'PUT', body: { slug, path, content, expectedMtimeMs } }),

    /* 设定 */
    loreTree: (slug) => j('api/lore/tree?' + qs({ slug })),
    loreSearch: (slug, q) => j('api/lore/search?' + qs({ slug, q })),

    /* 听书 */
    voices: () => j('api/tts/voices'),
    ttsUrl: (slug, path, voice, rate) => media('api/tts?' + qs({ slug, path, voice, rate })),
    /* 分段朗读：先要「有几段」的目录（很轻），再一段一段取音频。
       整章一次性生成要好几十秒才出声，分段后第一段 1~2 秒就能播。 */
    ttsSegments: (slug, path, voice, rate, engine) =>
      j('api/tts/segments?' + qs({ slug, path, voice, rate, engine })),
    /* 听书自检：服务器侧那几项的真数值（引擎 / 这一章几段 / 第 0 段多少字节） */
    ttsSelfcheck: (slug, path, voice, rate, engine) =>
      j('api/tts/selfcheck?' + qs({ slug, path, voice, rate, engine })),
    ttsSegUrl: (slug, path, i, voice, rate, engine) =>
      media('api/tts/seg?' + qs({ slug, path, i, voice, rate, engine })),
    /* 试听：合成很短一句（服务器有缓存，第二下点立刻响）。
       设置页与写作台都用它 —— 地址只在这里拼一次（以前 writing 台自己拼了一份）。 */
    previewTtsUrl: (voice, engine, rate, text) =>
      media('api/tts/preview?' + qs({ voice, engine, rate, text })),

    /* 可选模型（本服务从小说软件配置里读出来的渠道模型，渠道 排第一） */
    appModels: (q) => j('api/models' + (q ? '?' + qs({ q }) : '')),

    /* 预设（类酒馆：写作人设 / 文风 / 尺度 / 模型参数） */
    presets: (scope, slug) => j('api/presets?' + qs({ scope: scope || 'global', slug: slug || '' })),
    presetSave: (profileKey, values, model, scope, slug) =>
      j('api/presets/save', { method: 'POST', body: { profileKey, values, model, scope, slug } }),
    presetReset: (scope, slug) => j('api/presets/reset', { method: 'POST', body: { scope, slug } }),
    presetResource: (profileKey, path, key, scope, slug) =>
      j('api/presets/resource?' + qs({ profileKey, path, key, scope: scope || 'global', slug: slug || '' })),

    /* 模型组（按用途指定模型：规划用大模型、润色用快模型） */
    modelSets: () => j('api/model-sets'),
    modelSetSave: (name, members, note) =>
      j('api/model-sets/save', { method: 'POST', body: { name, members, note } }),
    modelSetDelete: (name) => j('api/model-sets?' + qs({ name }), { method: 'DELETE' }),
    modelSetActivate: (name) => j('api/model-sets/activate', { method: 'POST', body: { name } }),

    /* 笔记（跟书签分工：书签管读到哪，笔记管想到了什么） */
    notes: (slug, q) => j('api/notes?' + qs({ slug, q })),
    noteSave: (body) => j('api/note', { method: 'POST', body }),
    noteDelete: (slug, id) => j('api/note?' + qs({ slug, id }), { method: 'DELETE' }),

    /* 同步与冲突（离线改的稿子推回来，两边都改过就让人挑） */
    syncPush: (slug, items) => j('api/sync/push', { method: 'POST', body: { slug, items } }),
    /* 跟服务器对账（GOAL C2）：口令只在这一次请求里传，不落盘 */
    peerState: (slug) => j('api/peer/state?' + qs({ slug })),
    peerSync: (o) => j('api/peer/sync', { method: 'POST', body: o }),
    peerConflicts: (slug) => j('api/peer/conflicts?' + qs({ slug })),
    peerConflict: (id) => j('api/peer/conflict?' + qs({ id })),
    peerResolve: (o) => j('api/peer/resolve', { method: 'POST', body: o }),
    syncConflicts: (slug) => j('api/sync/conflicts' + (slug ? '?' + qs({ slug }) : '')),
    syncConflict: (id) => j('api/sync/conflict?' + qs({ id })),
    syncResolve: (body) => j('api/sync/resolve', { method: 'POST', body }),
    syncState: (slug) => j('api/sync/state' + (slug ? '?' + qs({ slug }) : '')),

    /* 流水线与批量（后台任务，进度去 agent/jobs 看） */
    workflows: (slug) => j('api/workflows' + (slug ? '?' + qs({ slug }) : '')),
    workflowSave: (body) => j('api/workflows/save', { method: 'POST', body }),
    workflowDelete: (id, slug) => j('api/workflows?' + qs({ id, slug: slug || '' }), { method: 'DELETE' }),
    workflowRun: (body) => j('api/workflows/run', { method: 'POST', body }),
    writeBatch: (body) => j('api/write/batch', { method: 'POST', body }),
    jobDetail: (jid) => j('api/agent/jobs/' + encodeURIComponent(jid)),

    /* 作品 / 章节管理 */
    bookNew: (title) => j('api/book', { method: 'POST', body: { title } }),
    bookRename: (slug, title) => j('api/book/rename', { method: 'POST', body: { slug, title } }),
    bookDelete: (slug) => j('api/book/delete', { method: 'POST', body: { slug } }),
    chapterNew: (slug, path, content) =>
      j('api/chapter/new', { method: 'POST', body: { slug, path, content } }),
    chapterDelete: (slug, path) => j('api/chapter/delete', { method: 'POST', body: { slug, path } }),
    chapterRename: (slug, from, to) =>
      j('api/chapter/rename', { method: 'POST', body: { slug, from, to } }),
    coverUpload: (slug, file) => {
      const fd = new FormData();
      fd.append('file', file);
      return fetch(abs('api/cover?slug=' + encodeURIComponent(slug)), {
        method: 'POST', body: fd, credentials: 'same-origin',
      }).then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t.slice(0, 120))))));
    },
    searchBook: (slug, q) => j('api/search?' + qs({ slug, q })),

    /* AI 改动收件箱 */
    inbox: (slug) => j('api/inbox?' + qs({ slug })),
    inboxAccept: (slug, path, revision) =>
      j('api/inbox/accept', { method: 'POST', body: { slug, path, revision } }),
    inboxRevert: (slug, path, revision) =>
      j('api/inbox/revert', { method: 'POST', body: { slug, path, revision } }),

    /* ── 小说软件原生接口（透传） ── */
    nb: (path, opts) => {
      const p = 'nb/' + String(path).replace(/^\/+/, '');
      if (!opts) return j(p);
      return j(p, opts);
    },

    /* AI 会话 */
    sessions: (slug) => window.API.nb('api/agent/sessions?' + qs({
      scope: slug ? 'project' : 'all', projectRoot: slug, limit: 50,
    })),
    chatProfiles: () => window.API.nb('api/agent/profiles/catalog'),
    models: () => window.API.nb('api/config/models/library'),
    /* 连通自检：真发一句话出去看回不回得来（见 server/routers/config_models.py 的 model_test） */
    modelTest: (modelKey) => window.API.nb('api/config/models/test', { method: 'POST', body: { modelKey: modelKey || '' } }),
    /* 保存**单个模型**的参数（模型列表右上角「⋯」那个面板）：
       上下文上限 / 单次最大输出 / 是不是推理模型 / 高级参数(JSON)。 */
    modelSave: (body) => window.API.nb('api/config/models/model', { method: 'POST', body: body || {} }),
    newSession: (profileKey, slug) => window.API.nb('api/agent/sessions', {
      method: 'POST', body: { profileKey, currentProjectRoot: slug },
    }),
    snapshot: (id) => window.API.nb('api/agent/sessions/' + id),
    /* invoke 的 mode 决定走哪条路：
       '' —— 单 Agent + 工具（普通问答）；
       discuss/plan/execute —— 多 Agent 编排（主创/取上下文/查证/写手/挑刺分工）。 */
    /* stream：true=必须流式 / false=整段出 / 不传=自动（先流式，渠道不给正文就整段回退）。
       两条路**同一份解析**（都在服务端 providers.stream_chat），不是两套实现。 */
    invoke: (id, text, mode, stream, divided) => window.API.nb('api/agent/sessions/' + id + '/invocations', {
      method: 'POST',
      body: Object.assign({ mode: mode || 'prompt', clientMessageId: uuid(), message: { text } },
        (stream === true || stream === false) ? { stream: stream } : {},
        /* 谁来做：true=多 Agent 分工（默认） / false=一个人干完。
           用户要求三种干活方式（讨论/计划/执行）**都能**切这两种。 */
        (divided === true || divided === false) ? { divided: divided } : {}),
    }),
    /* 带 slug：预设里主创的「干活方式」是**这本书**的默认干活方式（后端只增不减多加一个
       defaultMode 字段，没配置就是空串，前端自己回落）。 */
    /* ⚠ 第 41 轮实测修掉的一个真 bug：这里原来把 `'api/agent/orchestra'` 直接接上了 `qs(...)`，
       **漏了那个 `?`** → 拼出来是 `/api/agent/orchestra**slug=**xxx` → 后端 404。
       后果：预设里「干活方式」那三种模式的说明文案**从来没取到过**（一直静默回落），
       正是用户说的"像没用/儿戏"。全站别处都是 `'?' + qs(...)`，这里对齐。 */
    orchestra: (slug) => window.API.nb('api/agent/orchestra?' + qs({ slug: slug || '' })),
    /* 第 27 轮「AI 对话的专门设置」：渠道自己加 / 模型自己拉 / 默认+备用+按书（后端只增不减） */
    modelsProviders: () => window.API.nb('api/config/models/providers'),
    modelsPull: (body) => window.API.nb('api/config/models/pull', { method: 'POST', body }),
    modelsDefault: (modelKey) => window.API.nb('api/config/models/default', { method: 'POST', body: { modelKey } }),
    modelsFallback: (modelKey) => window.API.nb('api/config/models/fallback', { method: 'POST', body: { modelKey } }),
    modelsBook: (slug, modelKey) => window.API.nb('api/config/models/book', { method: 'POST', body: { slug, modelKey } }),
    providerTemplates: () => window.API.nb('api/config/models/provider-templates'),
    providerSave: (body) => window.API.nb('api/config/models/provider', { method: 'POST', body }),
    providerDelete: (id) => window.API.nb('api/config/models/provider?id=' + id, { method: 'DELETE' }),
    modelTest: (modelKey) => window.API.nb('api/config/models/test', { method: 'POST', body: { modelKey: modelKey || '' } }),
    /* 第 31 轮「联网搜索」：所有 AI 都能开（默认关，关着时一个请求都不发） */
    /* 当前登录口令：只给已登录的人看。前端放在「设置 → 关于 → 下载 App」旁边 ——
       用户下完 App 要输口令，就在同一个地方能看见，不用去翻控制台或找文件。 */
    /* 自己在网页里更新（后端+前端一起）。见 server/routers/update.py */
    updateCheck: () => window.API.nb('api/update/check'),
    updateApply: () => window.API.nb('api/update/apply', { method: 'POST', body: {} }),
    appPassword: () => window.API.nb('api/app/password'),
    rotatePassword: () => window.API.nb('api/app/password/rotate', { method: 'POST', body: {} }),
    webConfig: () => window.API.nb('api/config/web'),
    webSave: (body) => window.API.nb('api/config/web', { method: 'POST', body }),
    webTest: (body) => window.API.nb('api/config/web/test', { method: 'POST', body }),
    runs: (id) => window.API.nb('api/agent/sessions/' + id + '/runs'),
    abort: (id) => window.API.nb('api/agent/sessions/' + id + '/abort', { method: 'POST', body: {} }),
    command: (id, body) => window.API.nb('api/agent/sessions/' + id + '/commands', { method: 'POST', body }),

    /* AI 会话的实时事件流（SSE）。返回 EventSource，用完记得 .close() */
    /* after：从哪一条事件之后开始推。**默认 0 = 全量重放**（中途断线补课用）；
       刚读完快照的调用方应该把 `after` 传成快照里的 `lastEventSeq`，
       否则上一轮跑完的 message_start 会被重放一遍、界面上多出几个永远不填字的空气泡
       （第 42 轮实测的坑，见 tools/e2e-chatmsg.js 的丙）。 */
    stream(id, { onEvent, onError, after } = {}) {
      const a = (typeof after === 'number' && after >= 0) ? after : 0;
      const es = new EventSource(abs('nb/api/agent/sessions/' + id + '/events?after=' + a));
      es.onmessage = (m) => { try { onEvent && onEvent(JSON.parse(m.data), m); } catch (e) {} };
      /* 浏览器只把「命名事件」派发给同名的监听器 —— onmessage 收不到带 event: 的包。
         所以下面这份名单必须跟后端 emit 的种类**一字不差**：少一个，那一类事件就在前端静默消失。
         真踩过：名单里漏了 message_start 与 orchestra_*，结果
         ① 多 Agent 的角色徽章实时那一屏永远不出现（只有刷新读快照才看得到，看着像"没做"）；
         ② 「第 2/4 棒 · 挑刺 正在干活」这种进度也推不到界面。
         名单与后端的一致性由 tools/verify_sse_contract.py 守着（少一个直接判失败）。 */
      const KINDS = SSE_KINDS;
      KINDS.forEach((k) => {
        es.addEventListener(k, (m) => { try { onEvent && onEvent(JSON.parse(m.data), m); } catch (e) {} });
      });
      es.onerror = (e) => { onError && onError(e); };
      return es;
    },
  };

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
  window.uuid = uuid;
})();
