# -*- coding: utf-8 -*-
"""对端同步：**手机上的后端**去跟服务器（同一套后端的另一个实例）对账。

为什么要有这一层（GOAL C2 剩下的那半）：
  App 把整份后端装在手机里，断网时一切照常、数据在手机上。
  于是"跟服务器同步"不能指望前端去调服务器 —— 前端眼里只有一个本机后端。
  正确的位置是**本机后端作为客户端**去跟服务器说话，协议就是服务器本来就有的
  `/api/sync/changes`、`/api/sync/chapter`、`/api/sync/push`（那套已经过了 18 条冲突实测）。

三条规矩（和服务器端一致，也写在 docs/设计方案.md）：
  1. **两边都改过 → 不替用户选**：两份正文都留进 `sync_conflict`，等用户在「同步」面板里挑。
  2. **本地没动过的，直接接受服务器那版**（mtime 一致 = 没人在手机上改过）。
  3. **推之前先看服务器有没有变**：变了就报冲突，不硬盖。
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request

from . import db as dbm
from .store import mtime_ms, now_ms, read_text, write_text

TIMEOUT = 25
MAX_TEXT = 400_000          # 和服务器端同一个上限


class PeerError(Exception):
    """对端（服务器）不可用：地址不通、口令不对、返回看不懂。"""


def _req(base: str, method: str, path: str, *, cookie: str = "", body=None,
         timeout: int = TIMEOUT):
    url = base.rstrip("/") + path
    data = None
    headers = {"accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["content-type"] = "application/json"
    if cookie:
        headers["cookie"] = cookie
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            sc = r.headers.get_all("set-cookie") or []
            cookie_new = "; ".join(c.split(";")[0] for c in sc) or cookie
            return r.status, (json.loads(raw) if raw.strip() else None), cookie_new
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = {"detail": raw[:200]}
        return e.code, parsed, cookie
    except Exception as e:                       # 连不上：地址错 / 服务器没起 / 没网
        raise PeerError(f"连不上 {base}：{e}") from e


def login(base: str, password: str) -> str:
    """用口令换一个会话（口令只在这一步用，不落盘）。"""
    st, body, cookie = _req(base, "POST", "/api/app/login", body={"password": password})
    if st != 200 or not cookie:
        raise PeerError(f"服务器不认这个口令（HTTP {st}）")
    return cookie


def state(slug: str) -> dict:
    row = dbm.db().one("SELECT * FROM peer_state WHERE slug=?", (slug,))
    return dict(row) if row else {"slug": slug, "base_url": "", "last_time": 0,
                                 "last_sync": 0, "last_result": ""}


def _save_state(slug: str, base: str, last_time: int, result: str) -> None:
    dbm.db().execute(
        "INSERT INTO peer_state(slug,base_url,last_time,last_sync,last_result) VALUES(?,?,?,?,?) "
        "ON CONFLICT(slug) DO UPDATE SET base_url=excluded.base_url, last_time=excluded.last_time, "
        "last_sync=excluded.last_sync, last_result=excluded.last_result",
        (slug, base, int(last_time or 0), now_ms(), result))


def base_of(slug: str, path: str) -> int:
    """这条文件"上次同步时服务器那版"的 mtime（0 = 没同步过）。"""
    row = dbm.db().one("SELECT server_mtime FROM peer_file WHERE slug=? AND path=?", (slug, path))
    return int(row["server_mtime"]) if row else 0


def _set_base(slug: str, path: str, server_mtime: int) -> None:
    dbm.db().execute(
        "INSERT INTO peer_file(slug,path,server_mtime,at) VALUES(?,?,?,?) "
        "ON CONFLICT(slug,path) DO UPDATE SET server_mtime=excluded.server_mtime, at=excluded.at",
        (slug, path, int(server_mtime or 0), now_ms()))


LOG_KEEP = 5000            # 每本书最多留这么多条同步流水（够翻很久了，也别让它无限长）


def _log(slug: str, base: str, direction: str, path: str, status: str, detail: str = "") -> None:
    d = dbm.db()
    d.execute(
        "INSERT INTO peer_log(slug,base_url,direction,path,status,detail,at) VALUES(?,?,?,?,?,?,?)",
        (slug, base, direction, path, status, detail[:400], now_ms()))
    # 同步是"每次对账每章一行"，长书天天同步能把这张表撑成几十万行 —— 留最近 LOG_KEEP 条就好
    n = int(d.scalar("SELECT COUNT(*) FROM peer_log WHERE slug=?", (slug,)) or 0)
    if n > LOG_KEEP:
        d.execute("DELETE FROM peer_log WHERE slug=? AND id <= (SELECT id FROM peer_log"
                  " WHERE slug=? ORDER BY id DESC LIMIT 1 OFFSET ?)",
                  (slug, slug, LOG_KEEP))     # 留着最新的 LOG_KEEP 条，再往前的砍掉


def _conflict(slug: str, path: str, *, base_mtime: int, local_text: str,
              server_text: str, server_mtime: int) -> int:
    """记一条「两边都改过」的冲突。

    **同一条 path 已经有待处理的冲突就复用那一条** —— 否则用户每点一次「对一次账」，
    列表里就多一条一模一样的冲突（真踩过：第一次同步两边不同 → 冲突 1；再点一次 → 冲突 2，
    两份正文一个字都没变，用户得挑两遍）。
    """
    row = dbm.db().one(
        "SELECT id FROM sync_conflict WHERE slug=? AND path=? AND status='open' "
        "ORDER BY id DESC LIMIT 1", (slug, path))
    try:
        l_mt = int(mtime_ms(slug, path))
    except (FileNotFoundError, OSError):
        l_mt = 0                      # 本地还没这一章（纯服务器那边新加的）
    if row:
        # 复用这一条 —— 但**内容要跟着最新一轮刷新**（踩过的坑：只复用不刷新时，
        # 用户在 ⑤/⑥ 里看到的是第一轮的服务器正文；再挑「用服务器那版」，推回去的
        # 是那份**过时正文**，服务器当场又判冲突（`pushed: 0`），成了挑不完的死循环）。
        sets = ["base_mtime=?", "local_mtime=?"]
        args: list = [int(base_mtime or 0), l_mt]
        if local_text:
            sets.append("local_text=?")
            args.append(local_text[:MAX_TEXT])
        if server_text:
            # 正文和 mtime 必须成对更新，否则"这版服务器正文"配着别的 mtime 推回去还是冲突
            sets += ["server_text=?", "server_mtime=?"]
            args += [server_text[:MAX_TEXT], int(server_mtime or 0)]
        args.append(int(row["id"]))
        dbm.db().execute("UPDATE sync_conflict SET " + ", ".join(sets) + " WHERE id=?", tuple(args))
        return int(row["id"])
    return dbm.db().execute(
        "INSERT INTO sync_conflict(slug,path,base_mtime,local_mtime,server_mtime,"
        "local_text,server_text,status,created_at) VALUES(?,?,?,?,?,?,?,'open',?)",
        (slug, path, int(base_mtime or 0), l_mt, int(server_mtime or 0),
         (local_text or "")[:MAX_TEXT], (server_text or "")[:MAX_TEXT], now_ms()))


def ensure_local_book(slug: str, base: str, cookie: str) -> dict:
    """手机上还没有这本书时，照服务器的书名在本地建一本（"首次进 App 同步已有书"）。

    返回 `{"created": bool, "slug": 本地 slug}`：正常情况下两边同名同 slug；
    万一本地已经有同名书（比如用户手动建过），就沿用本地那本，不硬覆盖。
    """
    from .store import create_book, exists

    if exists(slug):
        return {"created": False, "slug": slug}
    code, bk, cookie = _req(base, "GET", f"/api/book?slug={urllib.parse.quote(slug)}", cookie=cookie)
    # 用户手上多半只有**书名**（新手机第一次用，哪知道书号）→ 服务器上按书号找不到时，
    # 去服务器书架里按名字再找一遍。找到就照它建，找不到才报错。
    if code != 200 or not bk:
        real = _find_by_title(base, slug, cookie)
        if real:
            code, bk, cookie = _req(base, "GET",
                                    f"/api/book?slug={urllib.parse.quote(real)}", cookie=cookie)
    if code != 200 or not bk:
        raise PeerError(f"服务器上没有叫「{slug}」的书（HTTP {code}）—— 书名或书号核对一下")
    out = create_book(bk.get("title") or slug, bk.get("summary") or "", bk.get("kind") or "novel")
    made = out["slug"]
    _log(made, base, "pull", "", "ok", f"本地没有，照服务器建了一本：{bk.get('title')}")
    return {"created": True, "slug": made}


def ensure_remote_book(slug: str, base: str, cookie: str) -> dict:
    """服务器上还没有这本书时，照**手机这版**在服务器上建一本（推到服务器之前必须先有它）。

    为什么非做不可：`/api/sync/push` 那条路第一步就是 `require_book(slug)` —— 服务器上没这本书
    直接 404。用户心里的模型是"我在手机上写的书，推上去"，不是"服务器上得先有这本书"。
    （拉的方向早就有 `ensure_local_book` 了，推的方向一直缺这一半。）
    """
    row = dbm.db().one("SELECT title,summary,kind FROM book WHERE slug=?", (slug,))
    title = (row or {}).get("title") or slug
    code, body, cookie = _req(base, "POST", "/api/projects",
                              cookie=cookie, body={"title": title,
                                                   "summary": (row or {}).get("summary") or "",
                                                   "kind": (row or {}).get("kind") or "novel"})
    if code != 200 or not body:
        raise PeerError(f"在服务器上建这本书失败（HTTP {code}：{str((body or {}).get('detail'))[:60]}）")
    made = str(body.get("slug") or body.get("projectRoot") or "")
    if made and made != slug:
        # 服务器上已经有一本同名书（书号被占了）→ 两边书号对不上，硬同步会把两本书搅在一起
        raise PeerError(f"服务器上已经有一本叫「{title}」的书（书号 {made}），"
                        f"跟手机上这本（{slug}）不同 —— 先把服务器那本改名或删掉再推")
    _log(slug, base, "push", "", "ok", f"服务器上没有，照手机这版建了一本：{title}")
    return {"created": True, "slug": made or slug}


def _find_by_title(base: str, wanted: str, cookie: str) -> str:
    """在服务器的书架里按书名找一本书，返回书号（找不到给空串）。"""
    code, body, _ = _req(base, "GET", "/api/projects", cookie=cookie)
    if code != 200 or not isinstance(body, dict):
        return ""
    want = (wanted or "").strip()
    for it in (body.get("projects") or []):
        slug = str(it.get("projectRoot") or it.get("slug") or "")
        title = str(it.get("title") or "").strip()
        if slug and (title == want or slug == want or title.lower() == want.lower()):
            return slug
    return ""


def pull(slug: str, base: str, cookie: str, *, limit: int = 200) -> dict:
    """把服务器上变了的章节拉下来（只拉变的；本地改过的报冲突，不硬盖）。"""
    from .routers.books import ensure_book_row    # 注意：books 在 routers 里，不在 server 根
    from .store import book_dir

    st = state(slug)
    since = int(st.get("last_time") or 0)
    st_code, ch, cookie = _req(base, "GET",
                               f"/api/sync/changes?slug={urllib.parse.quote(slug)}&since={since}",
                               cookie=cookie)
    if st_code == 404:
        raise PeerError(f"服务器上没有叫「{slug}」的书 —— 书名或书号核对一下")
    if st_code == 401:
        raise PeerError("服务器不认这个口令（大小写/空格核对一下）")
    if st_code != 200:
        raise PeerError(f"问服务器「变了哪些章」失败（HTTP {st_code}）")
    server_time = int((ch or {}).get("serverTime") or now_ms())
    changed = (ch or {}).get("changed") or []
    all_paths = [str(p) for p in ((ch or {}).get("all") or [])]

    got, conflicts, skipped, same = 0, 0, 0, 0
    failed: list[dict] = []                      # 没取到的章 + 原因，别只给个数
    handled: list[dict] = []
    for row in changed[:limit]:
        handled.append(row)
        p = str(row.get("path"))
        local = book_dir(slug) / p
        s_mtime = int(row.get("mtime_ms") or 0)
        known = base_of(slug, p)                     # 上次同步时服务器那版
        l_mtime = int(mtime_ms(slug, p)) if local.exists() else 0
        local_dirty = bool(local.exists()) and (known == 0 or l_mtime != known)
        server_moved = bool(known) and s_mtime != known
        if local_dirty and server_moved:
            # 两边都改过 → **两份都留**，等用户在「同步」里挑，绝不硬盖。
            c_code, body, cookie = _req(
                base, "GET",
                f"/api/sync/chapter?slug={urllib.parse.quote(slug)}&path={urllib.parse.quote(p)}",
                cookie=cookie)
            if c_code == 200 and body and not body.get("unchanged"):
                conf_id = _conflict(slug, p, base_mtime=known, local_text=read_text(slug, p),
                                    server_text=body.get("content") or "",
                                    server_mtime=int(body.get("mtimeMs") or s_mtime))
                _log(slug, base, "pull", p, "conflict", f"冲突 #{conf_id}")
                conflicts += 1
                continue
        # 本地没动过（或者压根没有）→ 直接拿服务器那版。
        # `since` 传的是**本地这份的 mtime**，但**只在"这条以前同步过"时才传**：
        #   * known 有值 → 本地这份就是上次从服务器拿的，服务器那边没变就该回 unchanged；
        #   * known == 0 且本地有文件 → 这条从来没同步过（例：本地新建书时自带的空白章），
        #     拿本地 mtime 当 since 等于告诉服务器"我这版更新"，它就会回 unchanged，
        #     于是**首次同步会静默丢掉服务器那版**。所以这里一律 since=0 取全文再比。
        since_arg = int(l_mtime) if known else 0
        c_code, body, cookie = _req(
            base, "GET",
            f"/api/sync/chapter?slug={urllib.parse.quote(slug)}&path={urllib.parse.quote(p)}"
            f"&since={since_arg}",
            cookie=cookie)
        if c_code != 200 or not body:
            _log(slug, base, "pull", p, "error", f"HTTP {c_code}")
            failed.append({"path": p, "http": int(c_code), "mtime": s_mtime})
            skipped += 1
            continue
        if body.get("unchanged"):
            _set_base(slug, p, s_mtime)
            _log(slug, base, "pull", p, "unchanged")
            same += 1
            continue
        server_text = body.get("content") or ""
        if known == 0 and local.exists() and read_text(slug, p) == server_text:
            # 首次同步 + 两边一模一样（本地自带的那一版碰巧相同）→ 不算"拉了"，记上基准就行
            _set_base(slug, p, int(body.get("mtimeMs") or s_mtime))
            _log(slug, base, "pull", p, "unchanged", "首次同步，两边一样")
            same += 1
            continue
        if known == 0 and local.exists() and read_text(slug, p) != server_text:
            # 首次同步但两边内容不同 → 不敢替你选，两份都留（和"两边都改过"一个待遇）
            conf_id = _conflict(slug, p, base_mtime=0, local_text=read_text(slug, p),
                                server_text=server_text,
                                server_mtime=int(body.get("mtimeMs") or s_mtime))
            _log(slug, base, "pull", p, "conflict", f"首次同步两边不同 → 冲突 #{conf_id}")
            conflicts += 1
            continue
        write_text(slug, p, server_text, origin="peer", note="从服务器拉下来的")
        _set_base(slug, p, int(body.get("mtimeMs") or s_mtime))
        got += 1
        _log(slug, base, "pull", p, "ok", f"{len(body.get('content') or '')} 字")

    for r in dbm.db().query("SELECT path FROM chapter WHERE slug=?", (slug,)):
        if r["path"] not in all_paths:
            all_paths.append(r["path"])
    ensure_book_row(slug)

    # ── 「下次从哪儿接着拉」这件事很要紧（这里踩过一个会**静默丢章**的坑）────────────
    # 老写法：不管这次处理了多少，`last_time` 一律推成服务器的 serverTime。
    # 但一次只处理 changed[:limit] 条 —— 超过上限的那些章 mtime 比 serverTime 小，
    # 下一次 `mtime_ms > since` 再也筛不到它们：**永远拉不下来，而且只字不提**。
    # 正确做法：把"没处理到的"和"处理失败的"里**最早的那个 mtime 各减一毫秒**当下次起点，
    # 这样它们下次一定还在 changed 里；只有全都处理干净了才推进到 serverTime。
    rest = changed[len(handled):]
    tail = [int(r.get("mtime_ms") or 0) for r in rest] \
        + [int(f.get("mtime") or server_time) for f in failed]
    if tail:
        next_since = max(since, min(tail) - 1)
        more = len(rest)
    else:
        next_since, more = server_time, 0
    _save_state(slug, base, next_since,
                f"拉下 {got} 章" + (f"，{conflicts} 条冲突" if conflicts else "")
                + (f"，{skipped} 章没取到" if skipped else "")
                + (f"，还有 {more} 章没拉完（再点一次接着拉）" if more else ""))
    return {"slug": slug, "base": base, "serverTime": server_time, "since": since,
            "changed": len(changed), "pulled": got, "unchanged": same, "conflicts": conflicts,
            "errors": skipped, "failed": failed, "serverHas": len(all_paths),
            "more": more, "nextSince": next_since}


def push(slug: str, base: str, cookie: str, paths: list[str] | None = None,
         base_by_path: dict | None = None) -> dict:
    """把手机上的改动推给服务器（带冲突判断：服务器也改了就说冲突，不硬盖）。

    `base_by_path` 是「这一条按哪个版本为基准推」（path → mtime）。冲突挑完之后要再推一次时，
    基准得是**当初看到的那版服务器正文的 mtime**，不然服务器会觉得"你又没改我这版"，
    再判一次冲突 —— 那就成了死循环，用户挑完也推不上去。
    """
    if paths is None:
        rows = list(dbm.db().query("SELECT path FROM chapter WHERE slug=?", (slug,)))
        paths = [r["path"] for r in rows]
    st = state(slug)
    since = int(st.get("last_time") or 0)
    if not paths:
        return {"slug": slug, "base": base, "pushed": 0, "conflicts": 0, "unchanged": 0,
                "results": [], "batches": 0, "more": 0}
    # 服务器一个请求最多收 50 条 → **分批推**。老写法只推前 50 条，第 51 章起就再也没人推它，
    # 界面上还显示"推上 50 章"，用户以为推完了。
    BATCH = 50
    MAX_BATCH = 20                      # 一次最多 1000 条，剩下的下次（界面会说明）
    total_batches = (len(paths) + BATCH - 1) // BATCH
    use = paths[:BATCH * MAX_BATCH]
    # 「这一章从来没同步过」的章，推之前得先问一句服务器（见下）。但**别一章一个请求**：
    # 先拿一次服务器书目（`/api/sync/changes?since=0` 只给路径和 mtime、不带正文），
    # 服务器上**压根没有**的章（换机后第一次把整本书推上去，全是这种）直接推，0 次预检。
    fresh = [p for p in use if (int((base_by_path or {}).get(p) or 0) or base_of(slug, p)) == 0]
    server_has: set[str] = set()
    if fresh:
        c_code, c_body, cookie = _req(
            base, "GET", f"/api/sync/changes?slug={urllib.parse.quote(slug)}&since=0",
            cookie=cookie)
        if c_code == 200:
            server_has = {str(x) for x in ((c_body or {}).get("all") or [])}
    preflight = 0
    created_remote = False               # 404 时只建一次，别每个批次都想建
    results_all: list[dict] = []
    body: dict = {}                      # 一批都没发出去（每一条都被预检拦下）时也别 UnboundLocal
    for i in range(0, len(use), BATCH):
        chunk = use[i:i + BATCH]
        items = []
        for p in chunk:
            # 基准 = **这条文件**上次同步时服务器那版的 mtime（不是服务器时钟！）
            base_mt = int((base_by_path or {}).get(p) or 0) or base_of(slug, p)
            local_text = read_text(slug, p)
            if base_mt == 0 and p in server_has:
                # 这一章**从来没同步过，可服务器上有一份同名的**。不能拿 base=0 直接推：
                # 服务端把 base=0 当成"没有基准"，判据 `not force and base and cur and abs(cur-base)>2`
                # 直接短路，于是**服务器上那版会被静默盖掉**（换机 / 两边各建过同名书时必现）。
                # 所以问一句服务器这一章长什么样，比完再决定：一样就只记基准，
                # 不一样就报冲突（两份都留）。
                preflight += 1
                c_code, c_body, cookie = _req(
                    base, "GET",
                    f"/api/sync/chapter?slug={urllib.parse.quote(slug)}"
                    f"&path={urllib.parse.quote(p)}&since=0", cookie=cookie)
                srv_text = (c_body or {}).get("content")
                srv_mt = int((c_body or {}).get("mtimeMs") or 0)
                if c_code == 200 and srv_text is not None:
                    if srv_text == local_text:
                        _set_base(slug, p, srv_mt)
                        _log(slug, base, "push", p, "unchanged", "没同步过，两边一样 → 只记基准")
                        continue
                    cid = _conflict(slug, p, base_mtime=0, local_text=local_text,
                                    server_text=srv_text, server_mtime=srv_mt)
                    _log(slug, base, "push", p, "conflict", f"没同步过且两边不同 → 冲突 #{cid}")
                    results_all.append({"path": p, "status": "conflict", "conflictId": cid,
                                        "serverMtimeMs": srv_mt, "serverText": srv_text})
                    continue
            items.append({"path": p, "content": local_text,
                          "baseMtimeMs": base_mt, "force": False})
        if not items:
            continue
        code, body, cookie = _req(base, "POST", "/api/sync/push",
                                  cookie=cookie, body={"slug": slug, "items": items})
        if code == 404 and not created_remote:
            # 服务器上还没有这本书 → 照手机这版建一本再推（用户点的是"推上去"，不是"先建书"）
            ensure_remote_book(slug, base, cookie)
            created_remote = True
            code, body, cookie = _req(base, "POST", "/api/sync/push",
                                      cookie=cookie, body={"slug": slug, "items": items})
        if code != 200:
            raise PeerError(f"往服务器推失败（HTTP {code}："
                            + str((body or {}).get("detail"))[:80] + "）")
        results_all.extend((body or {}).get("results") or [])
    more = len(paths) - len(use)
    server_time = int((body or {}).get("serverTime") or now_ms())
    ok = conf = unch = 0
    # 只遍历 results_all：它已经把每一批的 results 收进来了（预检拦下的也塞进去了），
    # 再叠一次 body["results"] 会把每条**数两遍**（F3/F4 两条引擎单测当场抓到这个）。
    for r in results_all:
        s = r.get("status")
        p = r.get("path") or ""
        if s == "ok":
            ok += 1
            _set_base(slug, p, int(r.get("mtimeMs") or 0))
            _log(slug, base, "push", p, "ok")
        elif s == "unchanged":
            unch += 1
            if r.get("mtimeMs") is not None:
                _set_base(slug, p, int(r.get("mtimeMs") or 0))   # 服务器说"你这版就是我这版"，记基准
            _log(slug, base, "push", p, "unchanged")
        elif s == "conflict":
            conf += 1
            cid = _conflict(slug, p, base_mtime=base_of(slug, p), local_text=read_text(slug, p),
                            server_text=r.get("serverText") or r.get("content") or "",
                            server_mtime=int(r.get("serverMtimeMs") or 0))
            _log(slug, base, "push", p, "conflict", f"冲突 #{cid}")
        else:
            _log(slug, base, "push", p, "error", str(s)[:80])
    _save_state(slug, base, server_time,
                f"推上 {ok} 章" + (f"，{conf} 条冲突" if conf else "")
                + (f"，还有 {more} 章等下次推" if more else ""))
    return {"slug": slug, "base": base, "pushed": ok, "conflicts": conf, "unchanged": unch,
            "results": results_all, "batches": min(total_batches, MAX_BATCH), "more": more,
            "preflight": preflight}


def open_conflicts(slug: str) -> list[dict]:
    rows = dbm.db().query(
        "SELECT id,path,status,base_mtime,local_mtime,server_mtime,created_at,"
        "length(local_text) AS lc, length(server_text) AS sc "
        "FROM sync_conflict WHERE slug=? AND status='open' ORDER BY created_at DESC", (slug,))
    return [dict(r) for r in rows]
