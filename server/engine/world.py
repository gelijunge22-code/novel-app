# -*- coding: utf-8 -*-
"""世界引擎：用**真事件溯源**管设定，长篇不漂移。

核心思想（代码全部自己写）：
* 世界不是一堆静态设定，而是**时间轴上的一串事实**；
* 每条事实带 `valid_from / valid_to`（可为空 = 一直有效）；
* 想知道"某人在第 30 章时是什么状态"，就把那个时刻之前的全部事实筛一遍取最新 ——
  **倒叙、回忆、前传都天然正确**，不会出现"十年前的国库里有去年的银子"。

这一版把它做成了**真事件溯源**（不是"能查"而已）：

1. **切面（snapshot）**：`world_snapshot` 把"某时刻的完整状态"存下来，查询时先找最近的切面，
   只把窗口内新增的事实叠加进去 —— 不用从头重放。`compute_state()` 会回报本次实际处理了
   几条事实（`replayed`）和用了哪个切面，测试里拿它当证据（见 tools/test_engine.py）。
2. **自定义历法**：`moment_abs` 上是绝对序号（第几天），由 `engine/calendar.py` 按用户定义的
   纪元/月长/闰年规则算出来。架空历、公元前（负年份）都能排进同一条时间线。
3. **审计留痕**：每次变更进 `audit` 表，记谁/何时/为什么/改前改后（`_audit()`）。
4. **区间冲突**：同一实体同一属性，两个**区间相交**却值不同 → `conflicts()` 报出来（含区间）。
5. **带出处的回溯**：`retro()` 给某一时刻的**完整状态**，每条事实标明来自哪个场景/章（path）
   和哪一行原文（fact_evidence）。

事实的"状态栈"放在切面里（hist），所以"某个值在窗口内结束了、要退回上一个值"这种情况
也能只算窗口内的东西，不用全量重放。
"""
from __future__ import annotations

from .. import db as dbm
from ..store import now_ms

# 事件溯源的两个旋钮：状态栈攒够这么多条事实就切一刀；两个切面之间至少隔这么多个时刻
SNAPSHOT_MIN_FACTS = 20
SNAPSHOT_GAP = 3


# ── 时刻 ────────────────────────────────────────────────────────────────────
def list_moments(slug: str) -> list[dict]:
    return dbm.db().query(
        "SELECT m.*, (SELECT COUNT(*) FROM episode e WHERE e.moment_id=m.id) AS episodes"
        " FROM moment m WHERE m.slug=? ORDER BY m.order_no", (slug,))


def add_moment(slug: str, label: str, time_text: str = "", *, source_scene: str = "",
               note: str = "", calendar: dict | None = None) -> int:
    d = dbm.db()
    order = (d.scalar("SELECT MAX(order_no) FROM moment WHERE slug=?", (slug,)) or 0) + 1
    return d.execute(
        "INSERT INTO moment(slug,order_no,label,time_text,calendar_json,source_scene,note)"
        " VALUES(?,?,?,?,?,?,?)",
        (slug, order, label, time_text, d.jdumps(calendar or {}), source_scene, note))


def moment_by_label(slug: str, label: str) -> dict | None:
    return dbm.db().one("SELECT * FROM moment WHERE slug=? AND label=?", (slug, label))


# ── 历法（自定义历法 / 公元前 / 架空历） ────────────────────────────────────
def calendars(slug: str) -> list[dict]:
    """这本书定义过的历法（公历永远都在，不用建）。"""
    from . import calendar as cal
    rows = dbm.db().query("SELECT * FROM calendar WHERE slug=? ORDER BY name", (slug,))
    out = [{"id": 0, "name": cal.DEFAULT_NAME, "builtin": True, "note": "（内置）",
            "def": cal.GREGORIAN, "desc": cal.describe(cal.GREGORIAN)}]
    for r in rows:
        defn = dbm.db().jloads(r["def_json"], {})
        out.append({"id": r["id"], "name": r["name"], "builtin": False,
                    "note": r["note"], "def": defn, "desc": cal.describe(defn)})
    return out


def calendar_get(slug: str, name: str = "") -> dict:
    from . import calendar as cal
    name = (name or "").strip()
    if not name or name == cal.DEFAULT_NAME:
        return dict(cal.GREGORIAN)
    row = dbm.db().one("SELECT * FROM calendar WHERE slug=? AND name=?", (slug, name))
    if not row:
        raise ValueError(f"这本书里没有叫「{name}」的历法")
    return dbm.db().jloads(row["def_json"], {})


def calendar_save(slug: str, name: str, defn: dict, note: str = "") -> dict:
    from . import calendar as cal
    name = (name or "").strip()
    if not name:
        raise ValueError("历法得有个名字")
    if name == cal.DEFAULT_NAME:
        raise ValueError("「公历」是内置的，改不了；换个名字建你自己的历法")
    defn = cal.normalize({**(defn or {}), "name": name})
    d = dbm.db()
    d.execute("INSERT INTO calendar(slug,name,def_json,note,created_at,updated_at)"
              " VALUES(?,?,?,?,?,?) ON CONFLICT(slug,name) DO UPDATE SET"
              " def_json=excluded.def_json, note=excluded.note, updated_at=excluded.updated_at",
              (slug, name, d.jdumps(defn), note, now_ms(), now_ms()))
    _audit("world.calendar.save", slug, name=name, months=defn.get("months"),
           leap=defn.get("leap_rule"))
    invalidate_snapshots(slug)
    return {"ok": True, "name": name, "desc": cal.describe(defn)}


def calendar_delete(slug: str, name: str) -> dict:
    d = dbm.db()
    used = d.scalar("SELECT COUNT(*) FROM moment_abs ma JOIN calendar c ON c.id=ma.calendar_id"
                    " WHERE c.slug=? AND c.name=?", (slug, name)) or 0
    if used:
        return {"ok": False, "error": f"还有 {used} 个时刻在用这套历法，先改掉它们的时刻"}
    d.execute("DELETE FROM calendar WHERE slug=? AND name=?", (slug, name))
    _audit("world.calendar.delete", slug, name=name)
    return {"ok": True}


def calendar_convert(slug: str, text: str = "", *, calendar_name: str = "",
                     year: int | None = None, month: int = 1, day: int = 1,
                     abs_day: int | None = None) -> dict:
    """时间文本 ↔ 绝对序号。给界面上的"历法换算"用。"""
    from . import calendar as cal
    defn = calendar_get(slug, calendar_name)
    if abs_day is not None:
        got = cal.from_abs(defn, int(abs_day))
        got["date_text"] = cal.format_abs(defn, int(abs_day))
        return {"ok": True, "direction": "abs→日期", "calendar": defn.get("name"), **got}
    if year is not None:
        z = cal.to_abs(defn, int(year), int(month or 1), int(day or 1))
        return {"ok": True, "direction": "日期→abs", "calendar": defn.get("name"),
                "abs": z, "date_text": cal.format_abs(defn, z)}
    parsed = cal.parse(text or "", defn)
    if not parsed:
        return {"ok": False, "error": "看不懂这个时间：写成「开元 1024 年 3 月 15 日」这样"}
    parsed["date_text"] = cal.format_abs(defn, parsed["abs"])
    return {"ok": True, "direction": "文本→abs", "calendar": defn.get("name"), **parsed}


def set_moment_time(slug: str, moment_id: int, *, text: str = "", abs_day: int | None = None,
                    calendar_name: str = "") -> dict:
    """给时刻定时间：写"开元 1024 年 3 月"，或直接给绝对序号。定完自动按时间重排。"""
    from . import calendar as cal
    d = dbm.db()
    m = d.one("SELECT * FROM moment WHERE slug=? AND id=?", (slug, moment_id))
    if not m:
        return {"ok": False, "error": "没这个时刻"}
    defn = calendar_get(slug, calendar_name)
    cid = None
    if calendar_name and calendar_name != cal.DEFAULT_NAME:
        row = d.one("SELECT id FROM calendar WHERE slug=? AND name=?", (slug, calendar_name))
        cid = row["id"] if row else None
    date_text = ""
    if abs_day is None:
        parsed = cal.parse(text or "", defn)
        if not parsed:
            return {"ok": False, "error": "看不懂这个时间：写成「开元 1024 年 3 月 15 日」这样"}
        abs_day = parsed["abs"]
        date_text = cal.format_abs(defn, abs_day)
    else:
        abs_day = int(abs_day)
        date_text = cal.format_abs(defn, abs_day)
    before = dict(d.one("SELECT * FROM moment_abs WHERE slug=? AND moment_id=?", (slug, moment_id)) or {})
    d.execute("INSERT INTO moment_abs(slug,moment_id,abs_day,calendar_id,time_text,updated_at)"
              " VALUES(?,?,?,?,?,?) ON CONFLICT(slug,moment_id) DO UPDATE SET"
              " abs_day=excluded.abs_day, calendar_id=excluded.calendar_id,"
              " time_text=excluded.time_text, updated_at=excluded.updated_at",
              (slug, moment_id, int(abs_day), cid, text or date_text, now_ms()))
    d.execute("UPDATE moment SET time_text=?, calendar_json=? WHERE id=?",
              (text or date_text, d.jdumps({"calendar": calendar_name or cal.DEFAULT_NAME,
                                            "abs": int(abs_day), "date": date_text}), moment_id))
    _audit("world.moment.time", slug, moment=m["label"], before=before.get("abs_day"),
           after=int(abs_day), date=date_text, calendar=calendar_name or cal.DEFAULT_NAME)
    invalidate_snapshots(slug)
    moved = reorder_moments_by_abs(slug)
    return {"ok": True, "momentId": moment_id, "label": m["label"], "abs": int(abs_day),
            "dateText": date_text, "reordered": moved}


def moment_times(slug: str) -> dict:
    """时刻 → 时间信息（没有历法的时刻也列出来，标"未定时间"）。"""
    d = dbm.db()
    rows = d.query(
        "SELECT m.id, m.order_no, m.label, m.time_text, ma.abs_day, ma.time_text AS my_text,"
        " c.name AS calendar FROM moment m"
        " LEFT JOIN moment_abs ma ON ma.slug=m.slug AND ma.moment_id=m.id"
        " LEFT JOIN calendar c ON c.id=ma.calendar_id"
        " WHERE m.slug=? ORDER BY m.order_no", (slug,))
    for r in rows:
        r["dated"] = r["abs_day"] is not None
    return {"moments": rows,
            "dated": sum(1 for r in rows if r["dated"]), "total": len(rows)}


def reorder_moments_by_abs(slug: str) -> int:
    """按绝对序号重排时刻顺序（没定时间的排在后面，保持原相对次序）。"""
    d = dbm.db()
    rows = d.query("SELECT m.id, m.order_no, ma.abs_day FROM moment m"
                   " LEFT JOIN moment_abs ma ON ma.slug=m.slug AND ma.moment_id=m.id"
                   " WHERE m.slug=? ORDER BY m.order_no", (slug,))
    dated = sorted([r for r in rows if r["abs_day"] is not None],
                   key=lambda r: (r["abs_day"], r["order_no"]))
    undated = [r for r in rows if r["abs_day"] is None]
    final = dated + undated
    need = [r for i, r in enumerate(final, start=1) if r["order_no"] != i]
    if not need:
        return 0
    # 先把要动的挪到负数区（同样是唯一值），再落到正数位 —— 直接互换会撞 UNIQUE(slug,order_no)
    for r in need:
        d.execute("UPDATE moment SET order_no=? WHERE id=?", (-r["order_no"] - 1, r["id"]))
    for i, r in enumerate(final, start=1):
        if r["order_no"] != i:
            d.execute("UPDATE moment SET order_no=? WHERE id=?", (i, r["id"]))
    return len(need)


def resolve_time(slug: str, text: str) -> dict:
    """把一句时间文本落到时刻上（能找到就用，找不到就按历法只算出绝对序号）。"""
    from . import calendar as cal
    d = dbm.db()
    hit = d.one("SELECT m.*, ma.abs_day FROM moment m"
                " LEFT JOIN moment_abs ma ON ma.slug=m.slug AND ma.moment_id=m.id"
                " WHERE m.slug=? AND (m.label=? OR m.time_text=? OR ma.time_text=?)",
                (slug, text, text, text))
    if hit:
        return {"momentId": hit["id"], "label": hit["label"], "abs": hit["abs_day"]}
    name = ""
    row = d.one("SELECT name FROM calendar WHERE slug=?", (slug,))
    if row and row["name"] in (text or ""):
        name = row["name"]
    parsed = cal.parse(text or "", calendar_get(slug, name))
    return {"momentId": None, "abs": (parsed or {}).get("abs"),
            "dateText": cal.format_abs(calendar_get(slug, name), parsed["abs"]) if parsed else ""}


def audit_log(slug: str = "", *, limit: int = 100) -> list[dict]:
    """审计留痕：谁 / 何时 / 为什么（action + detail）/ 改前改后。"""
    d = dbm.db()
    if slug:
        rows = d.query("SELECT * FROM audit WHERE slug=? ORDER BY id DESC LIMIT ?", (slug, limit))
    else:
        rows = d.query("SELECT * FROM audit ORDER BY id DESC LIMIT ?", (limit,))
    for r in rows:
        r["detail"] = d.jloads(r["detail_json"], {})
    return rows


def _audit(action: str, slug: str, *, actor: str = "user", path: str = "", **detail) -> None:
    d = dbm.db()
    d.execute("INSERT INTO audit(at,actor,action,slug,path,detail_json) VALUES(?,?,?,?,?,?)",
              (now_ms(), actor, action, slug, path, d.jdumps(detail)))


# ── 实体与别名 ──────────────────────────────────────────────────────────────
def upsert_entity(slug: str, kind: str, name: str, data: dict | None = None,
                  aliases: list[str] | None = None, *, moment_id: int | None = None,
                  source_path: str = "") -> int:
    d = dbm.db()
    row = d.one("SELECT * FROM entity WHERE slug=? AND kind=? AND name=?", (slug, kind, name))
    if row:
        merged = {**d.jloads(row["data_json"], {}), **(data or {})}
        d.execute("UPDATE entity SET data_json=?, updated_at=? WHERE id=?",
                  (d.jdumps(merged), now_ms(), row["id"]))
        eid = row["id"]
    else:
        eid = d.execute(
            "INSERT INTO entity(slug,kind,name,data_json,first_moment_id,first_seen_path,updated_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (slug, kind, name, d.jdumps(data or {}), moment_id, source_path, now_ms()))
    for a in (aliases or []):
        if a and a != name:
            try:
                d.execute("INSERT INTO entity_alias(slug,entity_id,alias) VALUES(?,?,?)",
                          (slug, eid, a))
            except Exception:
                # 别名撞了唯一键（同一个称呼挂两次）就跳过，别的别名继续写。
                pass
    return eid


def find_entity(slug: str, name: str) -> dict | None:
    """按名字或别名找人（别名是长篇最容易崩的地方）。"""
    d = dbm.db()
    row = d.one("SELECT * FROM entity WHERE slug=? AND name=?", (slug, name))
    if row:
        return row
    hit = d.one("SELECT e.* FROM entity_alias a JOIN entity e ON e.id=a.entity_id"
                " WHERE a.slug=? AND a.alias=?", (slug, name))
    if hit:
        return hit
    # 再退一步：包含关系（"主角" 命中 "主角（少年期）"）
    return d.one("SELECT * FROM entity WHERE slug=? AND name LIKE ? ORDER BY LENGTH(name) LIMIT 1",
                 (slug, f"%{name}%"))


def _aliases_map(d, entity_ids: list[int]) -> dict[int, list[str]]:
    """一次把一批实体的别名查完（打磨：以前是"每个实体查一次"的 N+1）。"""
    out: dict[int, list[str]] = {}
    ids = [int(i) for i in entity_ids if i]
    for i in range(0, len(ids), 400):                 # 别把 SQL 撑爆（SQLite 变量上限 999）
        chunk = ids[i:i + 400]
        ph = ",".join("?" * len(chunk))
        for r in d.query(f"SELECT entity_id, alias FROM entity_alias WHERE entity_id IN ({ph})"
                         " ORDER BY entity_id, alias", tuple(chunk)):
            out.setdefault(int(r["entity_id"]), []).append(r["alias"])
    return out


def entity_list(slug: str, kind: str = "", limit: int | None = None) -> list[dict]:
    """一个本的全部实体（含别名）。别名是一条 SQL 查完的，不是每个实体查一次。"""
    d = dbm.db()
    q = "SELECT * FROM entity WHERE slug=?"
    p: list = [slug]
    if kind:
        q += " AND kind=?"
        p.append(kind)
    q += " ORDER BY kind, name"
    if limit:
        q += " LIMIT ?"
        p.append(int(limit))
    out = d.query(q, p)
    amap = _aliases_map(d, [e["id"] for e in out])
    for e in out:
        e["data"] = d.jloads(e["data_json"], {})
        e["aliases"] = amap.get(int(e["id"]), [])
    return out


def facts_map(slug: str, entity_ids: list[int]) -> dict[int, list[dict]]:
    """一批实体的事实，一次查完（同上，治 N+1）。"""
    d = dbm.db()
    out: dict[int, list[dict]] = {}
    ids = [int(i) for i in entity_ids if i]
    for i in range(0, len(ids), 400):
        chunk = ids[i:i + 400]
        ph = ",".join("?" * len(chunk))
        for r in d.query(
                f"SELECT * FROM fact WHERE slug=? AND entity_id IN ({ph})"
                " ORDER BY entity_id, key, valid_from_moment_id IS NULL, valid_from_moment_id",
                tuple([slug] + chunk)):
            out.setdefault(int(r["entity_id"]), []).append(r)
    return out


# ── 事实 ────────────────────────────────────────────────────────────────────
def add_fact(slug: str, entity_id: int, key: str, value: str, *,
             from_moment: int | None = None, to_moment: int | None = None,
             source_path: str = "", confidence: str = "stated", note: str = "",
             evidence: list[dict] | None = None) -> int:
    d = dbm.db()
    fid = d.execute(
        "INSERT INTO fact(slug,entity_id,key,value,valid_from_moment_id,valid_to_moment_id,"
        "source_path,confidence,note,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (slug, entity_id, key, str(value), from_moment, to_moment, source_path,
         confidence, note, now_ms()))
    for e in (evidence or []):
        d.execute("INSERT INTO fact_evidence(fact_id,path,line,quote) VALUES(?,?,?,?)",
                  (fid, e.get("path") or "", int(e.get("line") or 0), e.get("quote") or ""))
    # 新事实一进来，这个实体在它之后算过的切面就作废（不然会拿旧切面糊弄新事实）
    invalidate_snapshots(slug, entity_id, from_order=min(
        [x for x in [from_moment and _order_of(slug, from_moment)] if x] or [0]) or None)
    return fid


def facts_of(slug: str, entity_id: int) -> list[dict]:
    return dbm.db().query(
        "SELECT * FROM fact WHERE slug=? AND entity_id=? ORDER BY key, valid_from_moment_id"
        " IS NULL, valid_from_moment_id", (slug, entity_id))


def _order_of(slug: str, moment_id) -> int | None:
    """时刻 id → order_no（None 表示"一直没有时间"，不是 0）。"""
    if not moment_id:
        return None
    return dbm.db().scalar("SELECT order_no FROM moment WHERE id=?", (moment_id,))


def _cutoff_of(slug: str, at) -> int | None:
    """把"时刻"参数统一成 order_no：int 直接用；字符串按时刻名找；空 = 最新的时刻。"""
    if isinstance(at, int) and not isinstance(at, bool):
        return at
    if isinstance(at, str) and at.strip():
        txt = at.strip()
        if txt.lstrip("-").isdigit():
            return int(txt)
        m = moment_by_label(slug, txt)
        if m:
            return m["order_no"]
        # 也认绝对序号对应的历法日期（"开元 1024 年 3 月"）
        hit = resolve_time(slug, txt)
        if hit and hit.get("momentId"):
            return _order_of(slug, hit["momentId"])
        return None
    d = dbm.db()
    v = d.scalar("SELECT MAX(order_no) FROM moment WHERE slug=?", (slug,))
    return int(v) if v is not None else None


def compute_state(slug: str, entity_id: int, cutoff: int | None = None, *,
                  use_snapshot: bool = True, force_snapshot: bool = False) -> dict:
    """算出某实体在 cutoff 时刻的状态。**这是事件溯源的核心函数。**

    做法（不是"每次从头重放"）：
      · 先找 `cutoff_order <= cutoff` 的最近切面；
      · 切面里存着那次算好的状态（state_json）和每个属性的**状态栈**（hist_json）；
      · 只把切面之后新增的事实叠加进状态栈（`replayed` 就是这次真正处理了几条）；
      · 状态栈里带着每条事实的出处（来源场景/章 + 原文行），所以回溯天然带出处。
    """
    d = dbm.db()
    base = None
    if use_snapshot:
        if cutoff is None:
            base = d.one("SELECT * FROM world_snapshot WHERE slug=? AND entity_id=?"
                         " ORDER BY cutoff_order DESC LIMIT 1", (slug, entity_id))
        else:
            base = d.one("SELECT * FROM world_snapshot WHERE slug=? AND entity_id=?"
                         " AND cutoff_order<=? ORDER BY cutoff_order DESC LIMIT 1",
                         (slug, entity_id, cutoff))
    hist: dict = {k: list(v) for k, v in (d.jloads(base["hist_json"], {}) if base else {}).items()}
    applied: set = set(d.jloads(base["fact_ids_json"], []) if base else [])

    rows = d.query(
        "SELECT f.*, mf.order_no AS fm, mt.order_no AS tm FROM fact f"
        " LEFT JOIN moment mf ON mf.id=f.valid_from_moment_id"
        " LEFT JOIN moment mt ON mt.id=f.valid_to_moment_id"
        " WHERE f.slug=? AND f.entity_id=?"
        " ORDER BY (mf.order_no IS NULL) DESC, mf.order_no, f.id", (slug, entity_id))
    ev_by_fact: dict[int, list] = {}
    new_rows = [r for r in rows
                if r["id"] not in applied
                and (r["fm"] is None or cutoff is None or r["fm"] <= cutoff)]
    if new_rows:
        ids = [r["id"] for r in new_rows]
        for chunk_start in range(0, len(ids), 400):
            chunk = ids[chunk_start:chunk_start + 400]
            q = ("SELECT * FROM fact_evidence WHERE fact_id IN (" + ",".join("?" * len(chunk)) + ")")
            for e in d.query(q, tuple(chunk)):
                ev_by_fact.setdefault(e["fact_id"], []).append(
                    {"path": e["path"], "line": e["line"], "quote": e["quote"]})
        for r in new_rows:
            hist.setdefault(r["key"], []).append({
                "fact_id": r["id"], "value": r["value"], "from": r["fm"], "to": r["tm"],
                "source": r["source_path"], "confidence": r["confidence"], "note": r["note"],
                "evidence": ev_by_fact.get(r["id"], [])})
            applied.add(r["id"])

    state: dict = {}
    for key, entries in hist.items():
        pick = None
        for e in entries:
            if e["from"] is not None and cutoff is not None and e["from"] > cutoff:
                continue
            if e["to"] is not None and cutoff is not None and e["to"] <= cutoff:
                continue
            pick = e                      # 最后一条还活着的就是当前值
        if pick:
            state[key] = pick

    snapshot = {"used": bool(base), "id": base["id"] if base else None,
                "cutoff": base["cutoff_order"] if base else None}
    out = {"state": state, "hist": hist, "snapshot": snapshot,
           "replayed": len(new_rows), "factsTotal": len(rows),
           "applied": len(applied)}

    # 值得切一刀就切：状态栈攒够了，或者离上一个切面已经隔了一段
    if (use_snapshot and cutoff is not None
            and (force_snapshot or (len(applied) >= SNAPSHOT_MIN_FACTS
                                    and (base is None or cutoff - base["cutoff_order"] >= SNAPSHOT_GAP)))):
        _save_snapshot(slug, entity_id, cutoff, state, hist, applied, base)
    return out


def _save_snapshot(slug: str, entity_id: int, cutoff: int, state: dict, hist: dict,
                   applied: set, base: dict | None) -> int:
    d = dbm.db()
    d.execute(
        "INSERT INTO world_snapshot(slug,entity_id,cutoff_order,state_json,hist_json,"
        "fact_ids_json,base_id,fact_count,created_at) VALUES(?,?,?,?,?,?,?,?,?)"
        " ON CONFLICT(slug,entity_id,cutoff_order) DO UPDATE SET state_json=excluded.state_json,"
        " hist_json=excluded.hist_json, fact_ids_json=excluded.fact_ids_json,"
        " fact_count=excluded.fact_count, created_at=excluded.created_at",
        (slug, entity_id, cutoff, d.jdumps(_state_plain(state)), d.jdumps(hist),
         d.jdumps(sorted(applied)), base["id"] if base else None, len(applied), now_ms()))
    return cutoff


def _state_plain(state: dict) -> dict:
    """切面里存纯值（给"只想看当时什么样"的调用方用，省得再剥一层）。"""
    return {k: v["value"] for k, v in state.items()}


def invalidate_snapshots(slug: str, entity_id: int | None = None, *, from_order: int | None = None) -> int:
    """事实/时间一变，切面就得作废 —— 别拿旧切面糊弄新事实。"""
    d = dbm.db()
    q = "DELETE FROM world_snapshot WHERE slug=?"
    args: list = [slug]
    if entity_id is not None:
        q += " AND entity_id=?"; args.append(entity_id)
    if from_order is not None:
        q += " AND cutoff_order>=?"; args.append(from_order)
    return d.execute(q, tuple(args))


def rebuild_snapshots(slug: str, *, step: int = SNAPSHOT_GAP) -> dict:
    """从头重算并重建全部切面（改了时刻顺序、批量导入之后调它）。"""
    invalidate_snapshots(slug)
    d = dbm.db()
    ents = d.query("SELECT id FROM entity WHERE slug=?", (slug,))
    orders = [r["order_no"] for r in d.query(
        "SELECT order_no FROM moment WHERE slug=? ORDER BY order_no", (slug,))]
    made = 0
    for e in ents:
        rows = d.query("SELECT valid_from_moment_id FROM fact WHERE slug=? AND entity_id=?",
                       (slug, e["id"]))
        cuts = {_order_of(slug, r["valid_from_moment_id"]) for r in rows}
        cuts = [c for c in cuts if c is not None]
        if not cuts:
            continue
        # 不用每个时刻都切一刀（那只会在库里堆垃圾）：按住 step 间隔留，外加最后一个时刻。
        # 大书里 step 的意义就是"最多往回退 step 个时刻，剩下的靠增量叠加"。
        lo = min(cuts)
        keep = {c for c in cuts if (c - lo) % max(1, step) == 0}
        keep.add(max(cuts))
        for o in orders:
            if lo <= o and (o - lo) % max(1, step) == 0:
                keep.add(o)
        for c in sorted(keep):
            compute_state(slug, e["id"], c, force_snapshot=True)
            made += 1
    return {"ok": True, "snapshots": made,
            "rows": d.scalar("SELECT COUNT(*) FROM world_snapshot WHERE slug=?", (slug,)) or 0}


def snapshots(slug: str, entity_id: int | None = None) -> list[dict]:
    d = dbm.db()
    if entity_id:
        rows = d.query("SELECT s.*, e.name AS entity FROM world_snapshot s JOIN entity e ON e.id=s.entity_id"
                       " WHERE s.slug=? AND s.entity_id=? ORDER BY s.cutoff_order", (slug, entity_id))
    else:
        rows = d.query("SELECT s.*, e.name AS entity FROM world_snapshot s JOIN entity e ON e.id=s.entity_id"
                       " WHERE s.slug=? ORDER BY e.name, s.cutoff_order", (slug,))
    for r in rows:
        r["keys"] = len(d.jloads(r["state_json"], {}))
        r.pop("hist_json", None)
        r.pop("fact_ids_json", None)
    return rows


def state_of_entity(slug: str, name: str, at: str | int | None = None) -> dict:
    """某个实体在**某一时刻**的状态（没给时刻 = 最新状态）。"""
    from ..store import safe_slug
    if not safe_slug(slug):
        return {"error": "作品标识不合法"}
    ent = find_entity(slug, name)
    if not ent:
        return {"error": f"没找到「{name}」这个实体", "hint": "先用世界引擎建一个，或换个叫法"}
    cutoff = _cutoff_of(slug, at)
    if isinstance(at, str) and at.strip() and cutoff is None:
        return {"error": f"没有「{at}」这个时刻"}
    calc = compute_state(slug, ent["id"], cutoff)
    return {"entity": {"id": ent["id"], "kind": ent["kind"], "name": ent["name"],
                       "data": dbm.db().jloads(ent["data_json"], {}),
                       "aliases": [r["alias"] for r in dbm.db().query(
                           "SELECT alias FROM entity_alias WHERE entity_id=?", (ent["id"],))]},
            "at": at, "cutoff": cutoff,
            "state": _state_plain(calc["state"]),
            "facts": [dict(e) for entries in calc["hist"].values() for e in entries],
            "provenance": calc["state"],
            "snapshot": calc["snapshot"], "replayed": calc["replayed"],
            "factsTotal": calc["factsTotal"]}


def retro(slug: str, at=None, subject: str = "", *, limit: int = 40) -> dict:
    """**带出处的回溯**：给定时刻（和可选主体），返回完整状态快照。

    每条事实都带：哪个场景/章（source）、哪一行原文（evidence）、
    以及"从哪个时刻开始有效"（from 的时刻名 + 绝对日期）。
    """
    d = dbm.db()
    cutoff = _cutoff_of(slug, at)
    if isinstance(at, str) and at.strip() and cutoff is None:
        return {"error": f"没有「{at}」这个时刻", "hint": "先在时间线上建这个时刻，或用章节序号"}
    marks = {m["order_no"]: m for m in list_moments(slug)}
    if subject:
        ents = [e for e in [find_entity(slug, subject)] if e]
        if not ents:
            return {"error": f"没找到「{subject}」这个实体"}
    else:
        ents = d.query("SELECT * FROM entity WHERE slug=? ORDER BY kind,name LIMIT ?", (slug, limit))
    out_ents = []
    amap = _aliases_map(d, [e["id"] for e in ents])
    for e in ents:
        calc = compute_state(slug, e["id"], cutoff)
        items = []
        for key, rec in sorted(calc["state"].items()):
            fm = marks.get(rec["from"]) if rec["from"] is not None else None
            items.append({
                "key": key, "value": rec["value"],
                "since": rec["from"], "sinceLabel": (fm or {}).get("label", "") if fm else "一开始就有",
                "sinceDate": (fm or {}).get("date_text", "") if fm else "",
                "until": rec["to"],
                "source": rec["source"], "confidence": rec["confidence"],
                "evidence": rec["evidence"][:3]})
        out_ents.append({"name": e["name"], "kind": e["kind"],
                         "aliases": amap.get(int(e["id"]), []),
                         "facts": items, "replayed": calc["replayed"]})
    return {"slug": slug, "at": at, "cutoff": cutoff,
            "cutoffLabel": (marks.get(cutoff) or {}).get("label", "") if cutoff is not None else "",
            "entities": out_ents, "entityCount": len(out_ents),
            "note": "state 是那一刻的完整状态；每条都标了它是从哪个场景/章、哪一行来的"}


# ── 关系网 ──────────────────────────────────────────────────────────────────
def relations(slug: str, at: str | int | None = None) -> list[dict]:
    cutoff = None
    if isinstance(at, int):
        cutoff = at
    elif isinstance(at, str) and at.strip():
        m = moment_by_label(slug, at.strip())
        cutoff = m["order_no"] if m else None
    rows = dbm.db().query(
        "SELECT r.*, a.name AS from_name, b.name AS to_name FROM entity_relation r"
        " JOIN entity a ON a.id=r.from_id JOIN entity b ON b.id=r.to_id"
        " WHERE r.slug=? ORDER BY a.name, b.name", (slug,))
    out = []
    for r in rows:
        fm = _order_of(slug, r["since_moment_id"])
        tm = _order_of(slug, r["until_moment_id"])
        if cutoff is not None:
            if fm is not None and fm > cutoff:
                continue
            if tm is not None and tm <= cutoff:
                continue
        out.append({**r, "since": fm, "until": tm})
    return out


def add_relation(slug: str, from_name: str, to_name: str, kind: str, *,
                 strength: int = 3, since_label: str = "", until_label: str = "",
                 note: str = "") -> dict:
    a = find_entity(slug, from_name)
    b = find_entity(slug, to_name)
    if not a or not b:
        raise ValueError("两个角色都得先在世界引擎里存在")
    sid = moment_by_label(slug, since_label)["id"] if since_label and moment_by_label(slug, since_label) else None
    uid = moment_by_label(slug, until_label)["id"] if until_label and moment_by_label(slug, until_label) else None
    rid = dbm.db().execute(
        "INSERT INTO entity_relation(slug,from_id,to_id,kind,strength,since_moment_id,"
        "until_moment_id,note,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        (slug, a["id"], b["id"], kind, int(strength), sid, uid, note, now_ms()))
    return {"ok": True, "id": rid}


# ── 时间线视图数据 ──────────────────────────────────────────────────────────
def timeline(slug: str) -> dict:
    d = dbm.db()
    moments = list_moments(slug)
    eps = d.query("SELECT * FROM episode WHERE slug=? ORDER BY moment_id, id", (slug,))
    by_moment: dict[int, list] = {}
    for e in eps:
        by_moment.setdefault(e["moment_id"] or 0, []).append(e)
    for m in moments:
        m["episodes"] = by_moment.get(m["id"], [])
    ents = d.query("SELECT id,name,kind FROM entity WHERE slug=?", (slug,))
    rels = relations(slug)
    return {"moments": moments, "entities": ents, "relations": rels,
            "span": {"first": moments[0]["label"] if moments else "",
                     "last": moments[-1]["label"] if moments else "",
                     "count": len(moments)}}


# ── 冲突检查 ────────────────────────────────────────────────────────────────
def conflicts(slug: str) -> list[dict]:
    """状态冲突检测：同一实体、同一属性，**两个有效区间相交**却给了不同的值 → 报警。

    和旧版（只看"都没结束的事实"）的区别：现在连"第 3~7 章说是黑的、第 5~9 章说是红的"
    这种**部分重叠**也抓得到，并且给出重叠区间和两条事实各自的出处 —— 作者才好判断该改哪一条。
    """
    d = dbm.db()
    marks = {m["order_no"]: m for m in list_moments(slug)}
    out = []
    for e in d.query("SELECT id,name FROM entity WHERE slug=?", (slug,)):
        by_key: dict[str, list] = {}
        for f in facts_of(slug, e["id"]):
            fm = _order_of(slug, f["valid_from_moment_id"])
            tm = _order_of(slug, f["valid_to_moment_id"])
            if tm is not None and fm is not None and tm <= fm:
                tm = fm + 1                      # 空区间/写反了，也当一点算，别静默吞掉
            by_key.setdefault(f["key"], []).append({
                "id": f["id"], "value": f["value"], "from": fm, "to": tm,
                "source": f["source_path"], "confidence": f["confidence"]})
        for key, arr in by_key.items():
            for i in range(len(arr)):
                for j in range(i + 1, len(arr)):
                    a, b = arr[i], arr[j]
                    lo = max(a["from"] if a["from"] is not None else -10 ** 9,
                             b["from"] if b["from"] is not None else -10 ** 9)
                    hi = min(a["to"] if a["to"] is not None else 10 ** 9,
                             b["to"] if b["to"] is not None else 10 ** 9)
                    if lo >= hi:
                        continue
                    if a["value"] == b["value"]:
                        continue
                    out.append({
                        "entity": e["name"], "key": key,
                        "values": [a["value"], b["value"]],
                        "overlap": [lo, hi],
                        "overlapText": _span_text(marks, lo, hi),
                        "facts": [{"id": a["id"], "value": a["value"], "from": a["from"],
                                   "to": a["to"], "source": a["source"]},
                                  {"id": b["id"], "value": b["value"], "from": b["from"],
                                   "to": b["to"], "source": b["source"]}],
                        "hint": f"「{e['name']}」的「{key}」在{_span_text(marks, lo, hi)}同时有两个值："
                                f"「{a['value']}」和「{b['value']}」，改掉一条或改掉时间"})
    return out


def _span_text(marks: dict, lo: int, hi: int) -> str:
    left = marks.get(lo)
    right = marks.get(hi)
    a = (left or {}).get("label") or "开头"
    if hi >= 10 ** 9:
        return f"{a}之后"
    b = (right or {}).get("label") or "现在"
    return f"{a}~{b}"


def state_brief(slug: str, limit: int = 12) -> str:
    """给 AI 用的一小段世界状态摘要。"""
    d = dbm.db()
    ents = d.query("SELECT id,kind,name FROM entity WHERE slug=? LIMIT ?", (slug, limit))
    lines = []
    for e in ents:
        st = state_of_entity(slug, e["name"])
        kv = "；".join(f"{k}={v}" for k, v in list((st.get("state") or {}).items())[:4])
        lines.append(f"- {e['name']}（{e['kind']}）" + (f"：{kv}" if kv else ""))
    return "\n".join(lines)
