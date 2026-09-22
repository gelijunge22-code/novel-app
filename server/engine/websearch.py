# -*- coding: utf-8 -*-
"""联网搜索：写同人 / 需要借鉴时，AI 能自己上网找样本。


  「增加一个技能或者机制，就是所有 AI 是可以开启联网搜索功能的，在写同人或者需要借鉴的时候，
    可以主动上网搜索……我不太清楚是需要给他固定的网页，还是让他自己找，
    但是让他自己找的话，他可能找不到太好的文本样品，所以需要好好地想一想」

## 怎么想出来的（取舍都写在这儿，改的人先读这一段）

**① 只用真连得上的源**（2026-09-21 在这台机器上逐个实测）：

| 源 | 结果 | 用途 |
|---|---|---|
| `cn.bing.com/search` | ✓ 200 | 通用网页搜索 |
| `zh.moegirl.org.cn` 的 MediaWiki API | ✓ 200（结构化 JSON，最干净） | 同人/ACG 设定样本 |
| `wiki.biligame.com`（B 站 wiki） | ✓ 200（跟随后跳转） | 同人设定样本 |
| `zh.wikipedia.org` | ✗ 连不上 | —— |
| `html.duckduckgo.com` / `api.duckduckgo.com` | ✗ 连不上 | —— |
| `baike.baidu.com` | ✗ 403 | —— |
| `www.baidu.com/s` | ✗ 302 反爬 | —— |
| `bangumi.tv` | ✗ 超时 | —— |

所以**不是"让它自己满世界找"**（那正是用户担心的："找不到太好的文本样品"），
而是**两条腿**：一条通用搜索（必应）负责"找得到"，一条高质量站点（萌娘百科 / B 站 wiki）
负责"文本够好"。用户还可以在设置里**自己加站点**（`web.sources`），加什么站都行。

**② 质量门槛**（判据里能报红）：搜索结果**只保留白名单域名**；打分 =
站点权重×2 + 查询词命中数 + 摘要长度分；取前 N；**被丢掉的也记下来**（`skipped`，
让用户看得见"我为什么没用那条"）。抓正文同样只抓白名单站，除非用户明确放开"允许任意站点"。

**③ 开关默认关**：没开的时候**一个请求都不发**（判据用本地计数服务器验证 `hits==0`）——
"绝不偷偷联网"是硬要求。

**④ 判据用的钩子**（生产不设）：`WEB_ENGINES_JSON` 把两个引擎指到本地假站点（做 hermetic 测试）、
`AI_WEB_FORCE=ignore-switch` 装作没看见开关（反证必须报红）。
"""
from __future__ import annotations

import asyncio
import html as htmlmod
import json
import os
import re
import time
from urllib.parse import quote

import httpx

from .. import db as dbm

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")
TIMEOUT = httpx.Timeout(12.0, connect=6.0)

# ── 白名单：能当"文本样本"的来源（权重越高越可信）────────────────────────────
CONTENT_HOSTS = [
    {"host": "zh.moegirl.org.cn", "name": "萌娘百科", "weight": 5},
    {"host": "wiki.biligame.com", "name": "B 站 wiki", "weight": 4},
]

ENGINES = [
    # 可信站**自己的**全文搜索（HTML 版）。为什么不用 MediaWiki 的 api.php：
    # 2026-09-21 实测它回 `{"error":{"code":"action-notallowed"}}` —— 匿名调用被挡了
    # （当时只看 HTTP 200 就当成能用，**没看正文**，白改一版）。HTML 全文搜索这条路是通的。
    {"id": "moegirl", "name": "萌娘百科", "kind": "mwsearch",
     "url": "https://zh.moegirl.org.cn/index.php?search={q}&fulltext=1"},
]

# 通用搜索：**只当线索**。它的结果大多数不在白名单里（实测 `site:` 还被必应忽略），
# 所以命中的条目只用来"顺便告诉用户有这么个网页"，**不进可信结果**。
DISCOVERY = [
    {"id": "bing", "name": "必应", "kind": "bing",
     "url": "https://cn.bing.com/search?q={q}"},
]

MENGNIANG = "https://zh.moegirl.org.cn"     # 默认站点（搜索结果拼绝对地址时的兜底）
MAX_RESULTS = 5
MAX_FETCH_CHARS = 4000


def _setting(key: str, default: str = "") -> str:
    """读一条设置。

    `setting.value_json` 是 **JSON 编过一层**的（接口那条路用 `d.jdumps` 写进去，
    字符串会带引号、数组会带转义），所以这里必须**解一层**再按需要还原成字符串。
    就栽在这儿：判据自己写设置时是直接塞裸 JSON，接口那条路塞的是转义过的，
    于是"用户自己加的站点"判据全绿、**真从界面加就失灵**（读出来是空数组）。
    """
    try:
        raw = dbm.db().scalar("SELECT value_json FROM setting WHERE key=?", (key,))
    except Exception:
        return default
    if raw is None or not str(raw).strip():
        return default
    v = dbm.db().jloads(raw, None)
    if v is None:
        return default
    if isinstance(v, str):
        return v
    return json.dumps(v, ensure_ascii=False)


def enabled() -> bool:
    """联网搜索开着没有（设置里 `web.enabled`，默认**关**）。"""
    if os.environ.get("AI_WEB_FORCE") == "ignore-switch":
        return True                      # 判据反证：装作没看见开关
    return _setting("web.enabled", "0") in ("1", "true", "on", "True")


def open_any() -> bool:
    """"允许任意站点"（默认关）。关了 = 只吃白名单，防捞到垃圾文本。"""
    if os.environ.get("AI_WEB_FORCE") == "no-gate":
        return True                      # 判据反证：把门槛拆了
    return _setting("web.open_any", "0") in ("1", "true", "on", "True")


def user_sources() -> list[dict]:
    """用户自己加的站点（设置里 `web.sources`，JSON 数组）。****：加进来的算白名单尾部。"""
    raw = _setting("web.sources", "[]")
    try:
        arr = json.loads(raw) if raw else []
    except Exception:
        return []
    out = []
    for x in arr if isinstance(arr, list) else []:
        if isinstance(x, dict) and x.get("host"):
            out.append({"host": str(x["host"]).lower(), "name": str(x.get("name") or x["host"]),
                        "weight": int(x.get("weight") or 3), "mine": True,
                        "search": str(x.get("search") or "")})
    return out


def hosts() -> list[dict]:
    return CONTENT_HOSTS + user_sources()


def host_of(url: str) -> str:
    """URL 的域名。**要去掉端口** —— 判据里把引擎指到 `127.0.0.1:35155` 时，
    带端口的字符串跟白名单里的 `127.0.0.1` 比不相等，用户自己加的站点就会**看着加了却不生效**
    （实测踩到：工具老老实实说"不在名单里"，其实是这一行没去端口）。"""
    m = re.match(r"https?://([^/]+)", url or "")
    host = (m.group(1) if m else "").lower()
    return host.split("@")[-1].split(":")[0]


def origin_of(url: str) -> str:
    """URL 的站点前缀（`https://host`），拼站内相对链接用。"""
    m = re.match(r"(https?://[^/]+)", url or "")
    return m.group(1).lower() if m else ""


def weight_of(url: str) -> int:
    h = host_of(url)
    for c in hosts():
        if h == c["host"] or h.endswith("." + c["host"]):
            return int(c["weight"])
    return 0


def _user_engines() -> list[dict]:
    """用户自己加的站点如果写了搜索模板（`search`），就把它也当一个可信搜索源。

    这样"固定网页 vs 自己找"两边都占：**默认给两个真能用的可信站**，
    用户想加自己的同人站/百科，只要在设置里填个搜索地址模板就行。
    """
    out = []
    for c in user_sources():
        tpl = c.get("search") or ""
        if "{q}" in tpl:
            out.append({"id": "user:" + c["host"], "name": c["name"], "kind": "mwsearch",
                        "url": tpl})
    return out


def _engines() -> list[dict]:
    """实测用的钩子：把引擎指到本地假站点（hermetic 判据）——生产永远不设这个环境变量。"""
    raw = os.environ.get("WEB_ENGINES_JSON")
    if not raw:
        return ENGINES + _user_engines()
    try:
        arr = json.loads(raw)
    except Exception:
        return ENGINES + _user_engines()
    # 环境变量替换的是**内置引擎**；用户自己加的站是配置，永远跟着走
    # （原来这里一并盖掉，导致"用户加的站"在判据里测不到）
    return (arr if isinstance(arr, list) else ENGINES) + _user_engines()


def strip_html(s: str) -> str:
    """把一段 HTML 压成纯文本（搜索摘要/正文都要用）。"""
    s = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", s or "")
    s = re.sub(r"(?is)<br\s*/?>|</p>|</div>|</li>", "\n", s)
    s = re.sub(r"(?s)<[^>]+>", "", s)
    s = htmlmod.unescape(s)
    s = re.sub(r"[ \t\u00a0]+", " ", s)
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def _score(q: str, title: str, snippet: str, url: str) -> int:
    w = weight_of(url)
    hit = sum(1 for ch in set(q or "") if ch.strip() and ch in (title or "") + (snippet or ""))
    return w * 2 + min(hit, 8) + min(len(snippet or "") // 40, 5)


def _parse_bing(body: str) -> list[dict]:
    out = []
    for m in re.finditer(r'(?is)<li class="b_algo".*?</li>', body or ""):
        blk = m.group(0)
        a = re.search(r'(?is)<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', blk)
        if not a:
            continue
        url, title = a.group(1), strip_html(a.group(2))
        sn = re.search(r'(?is)<p[^>]*>(.*?)</p>', blk)
        out.append({"title": title, "url": url, "snippet": strip_html(sn.group(1)) if sn else "",
                    "engine": "必应"})
    return out


def _parse_mwsearch(body: str, base: str = "", eng_name: str = "萌娘百科") -> list[dict]:
    """解析 MediaWiki 的**搜索页 HTML**（`<li class="mw-search-result">…`）。

    每条里拿两样：条目标题（`<a ... title="…">`）和摘要（li 的纯文本）。
    站内相对路径（`/wiki`）按 **`base`（这个引擎自己的站点）** 补成绝对地址 ——
    这样 web_fetch 才抓得到。**`base` 必须传引擎自己的域名**：用户加了自己的站，
    结果链接却被拼成 `zh.moegirl.org.cn`（白名单里那一条对，点开却跑到别的站去了）。
    """
    out = []
    for m in re.finditer(r'(?is)<li[^>]*class="[^"]*mw-search-result[^"]*".*?</li>', body or ""):
        blk = m.group(0)
        a = re.search(r'(?is)<a[^>]+href="(/[^"#?]+)"[^>]*title="([^"]*)"', blk) \
            or re.search(r'(?is)<a[^>]+title="([^"]*)"[^>]+href="(/[^"#?]+)"', blk)
        if not a:
            continue
        href, title = (a.group(1), a.group(2)) if a.group(1).startswith("/") else (a.group(2), a.group(1))
        snip = strip_html(re.sub(r'(?is)<a[^>]*>.*?</a>', " ", blk)).replace(title, " ")
        out.append({"title": strip_html(title), "url": (base or MENGNIANG) + href,
                    "snippet": re.sub(r"\s+", " ", snip).strip()[:400],
                    "engine": eng_name})
    return out


def _parse_mediawiki(blob: str, base: str = "", eng_name: str = "萌娘百科") -> list[dict]:
    try:
        obj = json.loads(blob or "{}")
    except Exception:
        return []
    hits = ((obj.get("query") or {}).get("search") or [])
    out = []
    for h in hits:
        t = str(h.get("title") or "")
        out.append({"title": t, "url": (base or MENGNIANG) + "/" + quote(t.replace(" ", "_")),
                    "snippet": strip_html(str(h.get("snippet") or "")), "engine": eng_name})
    return out


async def _one_engine(cli: httpx.AsyncClient, eng: dict, q: str) -> tuple[list[dict], str]:
    url = eng["url"].replace("{q}", quote(q))
    try:
        r = await cli.get(url, headers={"user-agent": UA, "accept-language": "zh-CN,zh;q=0.9"})
        if r.status_code >= 400:
            return [], "%s 返回 %d" % (eng["name"], r.status_code)
        kind = eng.get("kind")
        base = eng.get("base") or origin_of(eng.get("url") or "")
        if os.environ.get("AI_WEB_FORCE") == "hardcode-moegirl":
            base = MENGNIANG          # 反证：模拟"相对链接一律拼成萌娘百科"那个 bug
        name = eng.get("name") or "网页"
        if kind == "mwsearch":
            return _parse_mwsearch(r.text, base, name), ""
        if kind == "mediawiki":
            return _parse_mediawiki(r.text, base, name), ""
        return _parse_bing(r.text), ""
    except Exception as e:
        return [], "%s 连不上（%s）" % (eng["name"], type(e).__name__)


async def search(q: str, n: int = MAX_RESULTS) -> dict:
    """搜一次。**没开开关就直接回原因、一个请求都不发。**"""
    q = (q or "").strip()
    if not q:
        return {"ok": False, "error": "缺少 q（要搜什么）"}
    if not enabled():
        return {"ok": False, "enabled": False,
                "error": "联网搜索没开（设置里打开「联网搜索」我才能上网）"}
    results: list[dict] = []
    errs: list[str] = []
    leads: list[dict] = []
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as cli:
            pack = await asyncio.gather(*[_one_engine(cli, e, q) for e in _engines()])
            for rs, err in pack:
                results += rs
                if err:
                    errs.append(err)
            # 线索引擎（通用搜索）：**只用来告诉用户"还有这些网页"**，不进可信结果
            if not os.environ.get("WEB_NO_DISCOVERY"):
                dpack = await asyncio.gather(*[_one_engine(cli, e, q) for e in DISCOVERY])
                for rs, err in dpack:
                    leads += rs
                    if err and len(errs) < 4:
                        errs.append(err)
    except Exception as e:
        return {"ok": False, "enabled": True, "error": "联网出错：%s" % str(e)[:120]}

    keep, skipped = [], []
    for r in results:
        if weight_of(r["url"]) or open_any():
            r["source"] = host_of(r["url"])
            r["score"] = _score(q, r["title"], r["snippet"], r["url"])
            keep.append(r)
        else:
            skipped.append({"title": r["title"][:60], "host": host_of(r["url"]),
                            "why": "不在可信站点名单里（怕捞到垃圾文本）"})
    keep.sort(key=lambda x: -x["score"])
    keep = keep[:max(1, int(n))]
    # 线索里**去掉已经在可信结果里的**，并且标明"没采信"
    seen = {x["url"] for x in keep}
    for x in leads:
        if x["url"] in seen:
            continue
        x["host"] = host_of(x["url"])
        x.setdefault("source", x["host"])
        x["trusted"] = bool(weight_of(x["url"]))
    leads = [x for x in leads if not x.get("trusted")][:5]
    note = ("可信站点：%s（可在设置里自己加站点，填个搜索地址模板就行）"
            % "、".join(c["name"] for c in hosts()[:4])) if not open_any() \
        else "现在放开了「任意站点」，结果可能良莠不齐"
    if not keep and leads:
        note += "；这些只是线索（没采信）：来源不在可信名单里"
    return {"ok": bool(keep), "enabled": True, "query": q, "count": len(keep),
            "results": keep, "dropped": skipped[:8], "leads": leads, "note": note,
            "engines": [e["name"] for e in _engines()],
            "errors": errs,
            "error": "" if keep else ("可信站点里没搜到。" +
                                      ("；".join(errs) if errs else ""))}


async def fetch(url: str, q: str = "") -> dict:
    """抓一条网页正文（压成纯文本、截断 `MAX_FETCH_CHARS` 字）—— **只抓可信站点**。

    为什么也吃白名单：`web_search` 只把可信站点的条目给了模型，模型再顺手抓一条
    不可信站点的正文，等于从后门把垃圾文本捞进上下文。所以这里**同一道门槛**；
    真要看别的站，由用户打开「允许任意站点」（`open_any`）显式同意。
    """
    url = (url or "").strip()
    if not url:
        return {"ok": False, "error": "缺少 url（要抓哪一页）"}
    if not enabled():
        return {"ok": False, "enabled": False,
                "error": "联网搜索没开（设置里打开「联网搜索」我才能上网）"}
    if not re.match(r"^https?://", url):
        return {"ok": False, "error": "url 要带 http:// 或 https://"}
    if not weight_of(url) and not open_any():
        return {"ok": False, "host": host_of(url),
                "error": "这个来源不在可信站点名单里（怕捞到垃圾文本）；"
                         "确实要抓，就在设置里打开「允许任意站点」或把它加进名单"}
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True) as cli:
            r = await cli.get(url, headers={"user-agent": UA,
                                            "accept-language": "zh-CN,zh;q=0.9"})
        if r.status_code >= 400:
            return {"ok": False, "url": url, "error": "这一页打不开（返回 %d）" % r.status_code}
        txt = strip_html(r.text)
    except Exception as e:
        return {"ok": False, "url": url, "error": "抓取出错：%s" % str(e)[:120]}
    if not txt:
        return {"ok": False, "url": url, "source": host_of(url),
                "error": "这一页抓下来是空的（可能要登录，或正文是脚本渲染的）"}
    truncated = len(txt) > MAX_FETCH_CHARS
    return {"ok": True, "url": url, "source": host_of(url), "chars": len(txt),
            "excerpt": txt[:MAX_FETCH_CHARS], "truncated": truncated,
            "query": q or ""}


def catalogue() -> dict:
    """给设置界面看的"现在是什么状态、有哪些来源"（`GET /config/web`）。

    这里**只读**，不下任何网络请求 —— 设置页一打开就联网是用户明确不要的
    （"绝不偷偷联网"）。引擎名字只用来展示，真搜的时候才去连。
    """
    return {
        "enabled": enabled(),
        "openAny": open_any(),
        "engines": [{"id": e["id"], "name": e["name"]} for e in _engines()],
        "discovery": [{"id": e["id"], "name": e["name"]} for e in DISCOVERY],
        # `search` 只有"我自己加的站"才有（搜索地址模板）——界面要能原样编辑/回写，
        # 少回一个字段，用户改一次名字就把模板弄丢了。
        "hosts": [{"host": c["host"], "name": c["name"], "weight": int(c["weight"]),
                   "mine": bool(c.get("mine")), "search": str(c.get("search") or "")}
                  for c in hosts()],
        "maxResults": MAX_RESULTS,
        "maxFetchChars": MAX_FETCH_CHARS,
    }
