/* ============================================================
   store.js — 本地偏好 / 阅读进度 / 书签。全部存在浏览器本地。
   ============================================================ */
(function () {
  const K = 'nbapp.v1';

  const DEFAULTS = {
    theme: 'paper',        // paper | sepia | slate | white | green | night | auto（跟随系统深浅）
    themeColor: 'paper',   // 颜色主题单独记一份：关掉「跟随系统」/「夜间」时退回这套（）
    themePrev: 'paper',    // 进「夜间」之前是什么主题 —— 关掉夜间时退回它
    fontSize: 19,
    lineHeight: 1.9,
    fontFamily: 'serif',   // serif | sans
    paraGap: 0.9,
    margin: 26,            // 左右页边距 px
    pageMode: 'curl',      // curl(仿真) | slide(平移) | scroll(滚动) | none(无动画)
    motion: 'on',          // on | off —— 全局动效开关
    keepAwake: true,
    voice: 'zh-CN-YunxiNeural',
    ttsEngine: 'edge',     // edge | cosyvoice（服务器上有哪些由 /tts/voices 说了算）
    rate: '+0%',
    ttsFollow: true,       // 听书时页面自动跟读（可在设置里关）
    profileKey: 'writer',
    /* 出字方式：auto = 先流式、不行就整段（默认）；on = 一定要流式；off = 整段出。
       用户明确要"必须得增加流式或者非流式的设计"，所以两条路都要能用、要能选。 */
    chatStream: 'auto',
    tab: 'shelf',
  };

  let data = load();
  function load() {
    try { return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(K) || '{}')); }
    catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function save() { try { localStorage.setItem(K, JSON.stringify(data)); } catch (e) {} }

  const listeners = [];
  window.Prefs = {
    DEFAULT: DEFAULTS,
    all: () => Object.assign({}, data),
    get: (k) => data[k],
    set(k, v) { data[k] = v; save(); listeners.forEach((f) => f(k, v)); },
    patch(obj) { Object.assign(data, obj); save(); Object.keys(obj).forEach((k) => listeners.forEach((f) => f(k, obj[k]))); },
    onChange(f) { listeners.push(f); },
  };

  /* ── 阅读进度 ── */
  const PK = 'nbapp.progress.v1';
  let prog = {};
  try { prog = JSON.parse(localStorage.getItem(PK) || '{}'); } catch (e) { prog = {}; }
  window.Progress = {
    get(slug) { return prog[slug] || null; },
    set(slug, path, percent, extra) {
      prog[slug] = Object.assign({ path, percent: percent || 0, ts: Date.now() }, extra || {});
      try { localStorage.setItem(PK, JSON.stringify(prog)); } catch (e) {}
    },
    clear(slug) { delete prog[slug]; try { localStorage.setItem(PK, JSON.stringify(prog)); } catch (e) {} },
  };

  /* ── 离线缓存 ──
     读过的书目和正文留一份在本机：断网时书架、目录、读过的章节都还能打开。
     只留正文纯文本（不含封面图），最多 OFF_MAX 章，超了从最旧的丢。 */
  const OK_OFF = 'nbapp.offline.v1';
  const OFF_MAX = 120;
  let off = { books: {}, chapters: {} };
  try {
    const raw = JSON.parse(localStorage.getItem(OK_OFF) || '{}');
    if (raw && raw.books && raw.chapters) off = raw;
  } catch (e) { off = { books: {}, chapters: {} }; }

  function offSave() {
    try { localStorage.setItem(OK_OFF, JSON.stringify(off)); }
    catch (e) {
      // 存不下（配额满了）：先丢正文再存一次，书目小，留着
      try { off.chapters = {}; localStorage.setItem(OK_OFF, JSON.stringify(off)); } catch (e2) {}
    }
  }

  window.Offline = {
    putBook(slug, book) {
      if (!slug || !book) return;
      off.books[slug] = { t: Date.now(), book };
      offSave();
    },
    getBook(slug) { const r = off.books[slug]; return r ? r.book : null; },
    putChapter(slug, path, text) {
      if (!slug || !path || typeof text !== 'string') return;
      off.chapters[slug + '|' + path] = { t: Date.now(), text };
      const keys = Object.keys(off.chapters);
      if (keys.length > OFF_MAX) {
        keys.sort((a, b) => off.chapters[a].t - off.chapters[b].t);
        keys.slice(0, keys.length - OFF_MAX).forEach((k) => { delete off.chapters[k]; });
      }
      offSave();
    },
    getChapter(slug, path) {
      const r = off.chapters[slug + '|' + path];
      return r ? r.text : null;
    },
    /* 断网时拿它当书架用：缓存过的书排一份出来 */
    projects() {
      return Object.keys(off.books).map((slug) => {
        const b = off.books[slug].book || {};
        return { slug: slug, title: b.title || slug, totalWords: b.totalWords || 0,
                 hasCover: false, cached: true };
      });
    },
    stats() {
      let chars = 0;
      Object.keys(off.chapters).forEach((k) => { chars += (off.chapters[k].text || '').length; });
      return { books: Object.keys(off.books).length,
               chapters: Object.keys(off.chapters).length, chars: chars };
    },
    clear() {
      const st = this.stats();
      off = { books: {}, chapters: {} };
      try { localStorage.removeItem(OK_OFF); } catch (e) {}
      return st;
    },

    /* 改完发不出去：先攒着（baseMtimeMs 是改之前服务器上的时间，冲突判断要靠它） */
    queueWrite(slug, path, content, baseMtimeMs) {
      if (!slug || !path) return;
      const k = pendKey(slug, path);
      const old = pend[k];
      pend[k] = { slug, path, content: String(content),
                  baseMtimeMs: (old && old.baseMtimeMs) || Number(baseMtimeMs) || 0,
                  t: Date.now() };
      pendSave();
    },
    pendingWrites(slug) {
      return Object.values(pend).filter((x) => !slug || x.slug === slug)
        .sort((a, b) => a.t - b.t);
    },
    pendingCount() { return Object.keys(pend).length; },
    dropWrite(slug, path) { delete pend[pendKey(slug, path)]; pendSave(); },
  };

  /* ── 离线时改的稿子（连上网再推回服务器）──
     手机在没网的地方改了两章，不能因为「发不出去」就把人写的东西丢了：
     先原样存在本机，回到有网的地方再推；推的时候如果服务器上也改过，
     由后端判成冲突并两份都留着，用户自己挑（见 tools.js 的 Conflicts）。 */
  const WK = 'nbapp.pending.v1';
  let pend = {};
  try { pend = JSON.parse(localStorage.getItem(WK) || '{}') || {}; } catch (e) { pend = {}; }
  const pendKey = (slug, path) => slug + '|' + path;
  const pendSave = () => { try { localStorage.setItem(WK, JSON.stringify(pend)); } catch (e) {} };

  /* ── 书签 ── */
  const MK = 'nbapp.marks.v1';
  let marks = {};
  try { marks = JSON.parse(localStorage.getItem(MK) || '{}'); } catch (e) { marks = {}; }
  const saveMarks = () => { try { localStorage.setItem(MK, JSON.stringify(marks)); } catch (e) {} };
  window.Marks = {
    list(slug) { return marks[slug] || []; },
    add(slug, path, percent, text) {
      const arr = marks[slug] || (marks[slug] = []);
      arr.push({ path, percent, text: (text || '').slice(0, 60), ts: Date.now() });
      saveMarks();
    },
    remove(slug, idx) { const a = marks[slug] || []; a.splice(idx, 1); saveMarks(); },
  };
})();
