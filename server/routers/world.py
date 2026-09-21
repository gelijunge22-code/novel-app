# -*- coding: utf-8 -*-
"""世界引擎接口：实体 / 别名 / 事实 / 关系 / 时刻 / 时间线 / 冲突。

数据与推算全部在 `server/engine/world.py` 里，这里只做「HTTP 门面」：
校验参数、按书隔离、把结果摆成前端好用的形状。
"""
from __future__ import annotations

from fastapi import APIRouter, Body, HTTPException, Request

from .. import db as dbm
from .. import args
from ..args import num
from ..engine import world as W
from ..security import current_user
from ..store import book_dir, now_ms

router = APIRouter(tags=["world"])

KINDS = ("character", "place", "faction", "item", "system", "concept", "creature")


def _slug(value) -> str:
    from .books import require_book
    return require_book(value or "")


def _audit(action: str, slug: str, **detail) -> None:
    dbm.db().execute("INSERT INTO audit(at,actor,action,slug,detail_json) VALUES(?,?,?,?,?)",
                     (now_ms(), "user", action, slug, dbm.Database.jdumps(detail)))


@router.get("/world/overview")
async def overview(request: Request, slug: str):
    current_user(request)
    s = _slug(slug)
    d = dbm.db()
    ents = W.entity_list(s)
    return {
        "slug": s,
        "kinds": KINDS,
        "counts": {
            "moments": d.scalar("SELECT COUNT(*) FROM moment WHERE slug=?", (s,)) or 0,
            "entities": len(ents),
            "facts": d.scalar("SELECT COUNT(*) FROM fact WHERE slug=?", (s,)) or 0,
            "episodes": d.scalar("SELECT COUNT(*) FROM episode WHERE slug=?", (s,)) or 0,
            "relations": d.scalar("SELECT COUNT(*) FROM entity_relation WHERE slug=?", (s,)) or 0,
        },
        "entities": ents,
        "conflicts": W.conflicts(s),
        "stateBrief": W.state_brief(s),
    }


@router.get("/world/entities")
async def entities(request: Request, slug: str, kind: str = "", q: str = "",
                   limit: int = 1000):
    """实体 + 别名 + 事实。

    第 9 遍打磨：别名的查询以前是"每个实体一条 SQL"、事实也是"每条实体一条"
    —— 一套 800 个角色的书点开「世界」要发 1600 次查询；改成一次查完。
    顺带上限（默认 1000，最多 5000）并明说 `truncated`，别让一本书把响应撑到几 MB。
    """
    current_user(request)
    s = _slug(slug)
    cap = max(1, min(5000, int(limit)))
    total_db = dbm.db().scalar("SELECT COUNT(*) FROM entity WHERE slug=?", (s,)) or 0
    out = W.entity_list(s, kind, limit=cap)
    if q.strip():
        needle = q.strip().lower()
        out = [e for e in out
               if needle in e["name"].lower() or needle in e["data_json"].lower()
               or any(needle in a.lower() for a in e["aliases"])]
    fmap = W.facts_map(s, [e["id"] for e in out])
    for e in out:
        e["facts"] = fmap.get(int(e["id"]), [])
    return {"items": out, "kinds": KINDS, "total": len(out), "inBook": total_db,
            "truncated": bool(total_db > len(out) and not q.strip())}


@router.post("/world/entity")
async def entity_save(request: Request, payload: dict = Body(...)):
    """新建或更新一个实体。data 里放结构化字段（外貌/性格/目标…），不要一整段文字。"""
    current_user(request)
    s = _slug(payload.get("slug"))
    name = args.s(payload.get("name"), name="名字").strip()
    if not name:
        raise HTTPException(400, "名字不能为空")
    kind = (args.s(payload.get("kind"), name="类型") or "character").strip()
    if kind not in KINDS:
        raise HTTPException(400, f"不认识的类型：{kind}")
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    aliases = [str(a).strip() for a in (payload.get("aliases") or []) if str(a).strip()]
    eid = W.upsert_entity(s, kind, name, data, aliases,
                          moment_id=payload.get("momentId"),
                          source_path=payload.get("sourcePath") or "")
    if payload.get("replaceAliases") is not None:
        dbm.db().execute("DELETE FROM entity_alias WHERE slug=? AND entity_id=?", (s, eid))
        for a in aliases:
            if a != name:
                # 别名表有 UNIQUE(slug,entity_id,alias)：重复登记用 OR IGNORE 表达意图，
                # 不要 try/except pass —— 那会把"表不存在/写磁盘失败"这类真错也一起吞掉。
                dbm.db().execute("INSERT OR IGNORE INTO entity_alias(slug,entity_id,alias)"
                                 " VALUES(?,?,?)", (s, eid, a))
    _audit("world.entity.save", s, entity=eid, name=name)
    row = dbm.db().one("SELECT * FROM entity WHERE id=?", (eid,))
    return {"ok": True, "id": eid, "entity": row}


@router.delete("/world/entity")
async def entity_delete(request: Request, id: int, slug: str = ""):
    current_user(request)
    s = _slug(slug)
    row = dbm.db().one("SELECT * FROM entity WHERE id=? AND slug=?", (id, s))
    if not row:
        raise HTTPException(404, "没有这个实体")
    d = dbm.db()
    with d.tx() as conn:
        conn.execute("DELETE FROM entity_relation WHERE from_id=? OR to_id=?", (id, id))
        conn.execute("DELETE FROM fact WHERE entity_id=?", (id,))
        conn.execute("DELETE FROM arc WHERE entity_id=?", (id,))
        conn.execute("DELETE FROM entity_alias WHERE entity_id=?", (id,))
        conn.execute("DELETE FROM entity WHERE id=?", (id,))
    W.invalidate_snapshots(s)
    _audit("world.entity.delete", s, name=row["name"])
    return {"ok": True, "deleted": row["name"]}


@router.post("/world/entity/merge")
async def entity_merge(request: Request, payload: dict = Body(...)):
    """把「同一个人」的两种叫法合成一条：from 的名字变成 to 的别名，事实全部转过去。"""
    current_user(request)
    s = _slug(payload.get("slug"))
    src = dbm.db().one("SELECT * FROM entity WHERE id=? AND slug=?",
                       (payload.get("fromId"), s))
    dst = dbm.db().one("SELECT * FROM entity WHERE id=? AND slug=?",
                       (payload.get("toId"), s))
    if not src or not dst:
        raise HTTPException(404, "这两个实体得都存在")
    d = dbm.db()
    with d.tx() as conn:
        conn.execute("UPDATE fact SET entity_id=? WHERE entity_id=?", (dst["id"], src["id"]))
        conn.execute("UPDATE entity_relation SET from_id=? WHERE from_id=?", (dst["id"], src["id"]))
        conn.execute("UPDATE entity_relation SET to_id=? WHERE to_id=?", (dst["id"], src["id"]))
        conn.execute("UPDATE entity_alias SET entity_id=? WHERE entity_id=?", (dst["id"], src["id"]))
        conn.execute("DELETE FROM entity WHERE id=?", (src["id"],))
    d.execute("INSERT OR IGNORE INTO entity_alias(slug,entity_id,alias) VALUES(?,?,?)",
              (s, dst["id"], src["name"]))
    W.invalidate_snapshots(s)
    _audit("world.entity.merge", s, **{"from": src["name"], "to": dst["name"]})
    return {"ok": True, "kept": dst["name"], "merged": src["name"]}


@router.get("/world/facts")
async def facts(request: Request, slug: str, entityId: int):
    current_user(request)
    s = _slug(slug)
    return {"items": W.facts_of(s, entityId)}


@router.post("/world/fact")
async def fact_add(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    eid = payload.get("entityId")
    if not eid and payload.get("entity"):
        e = W.find_entity(s, str(payload["entity"]))
        eid = e["id"] if e else None
    if not eid:
        raise HTTPException(400, "要给哪个角色记这条？")
    key = args.s(payload.get("key"), name="属性名").strip()
    if not key:
        raise HTTPException(400, "属性名不能为空")
    fid = W.add_fact(s, num(eid, name="实体号"), key, str(payload.get("value") or ""),
                     from_moment=payload.get("fromMomentId"),
                     to_moment=payload.get("toMomentId"),
                     source_path=payload.get("sourcePath") or "",
                     confidence=payload.get("confidence") or "stated",
                     note=payload.get("note") or "",
                     evidence=payload.get("evidence"))
    _audit("world.fact.add", s, entityId=eid, key=key)
    return {"ok": True, "id": fid}


@router.post("/world/fact/close")
async def fact_close(request: Request, payload: dict = Body(...)):
    """把一条事实在某时刻结束掉（"他这时候已经不是将军了"）。"""
    current_user(request)
    s = _slug(payload.get("slug"))
    fid = payload.get("id")
    row = dbm.db().one("SELECT * FROM fact WHERE id=? AND slug=?", (fid, s))
    if not row:
        raise HTTPException(404, "没有这条事实")
    dbm.db().execute("UPDATE fact SET valid_to_moment_id=?, updated_at=? WHERE id=?",
                     (payload.get("toMomentId"), now_ms(), fid))
    W.invalidate_snapshots(s, row["entity_id"])
    _audit("world.fact.close", s, entityId=row["entity_id"], key=row["key"], to=payload.get("toMomentId"))
    return {"ok": True}


@router.delete("/world/fact")
async def fact_delete(request: Request, id: int, slug: str = ""):
    current_user(request)
    s = _slug(slug)
    d = dbm.db()
    row = d.one("SELECT * FROM fact WHERE id=? AND slug=?", (id, s))
    if not row:
        raise HTTPException(404, "没有这条事实")
    d.execute("DELETE FROM fact_evidence WHERE fact_id=?", (id,))
    d.execute("DELETE FROM fact WHERE id=?", (id,))
    W.invalidate_snapshots(s, row["entity_id"])
    _audit("world.fact.delete", s, entityId=row["entity_id"], key=row["key"], value=row["value"])
    return {"ok": True}


@router.get("/world/relations")
async def relations(request: Request, slug: str, at: str = ""):
    current_user(request)
    s = _slug(slug)
    return {"items": W.relations(s, at or None)}


@router.post("/world/relation")
async def relation_add(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    try:
        out = W.add_relation(s, str(payload.get("from") or ""), str(payload.get("to") or ""),
                             str(payload.get("kind") or "认识"),
                             strength=num(payload.get("strength"), 3, lo=1, hi=10, name="关系强度"),
                             since_label=str(payload.get("since") or ""),
                             until_label=str(payload.get("until") or ""),
                             note=str(payload.get("note") or ""))
    except ValueError as e:
        raise HTTPException(400, str(e))
    _audit("world.relation.add", s, **{"from": payload.get("from"), "to": payload.get("to")})
    return out


@router.delete("/world/relation")
async def relation_delete(request: Request, id: int, slug: str = ""):
    current_user(request)
    s = _slug(slug)
    if not dbm.db().one("SELECT id FROM entity_relation WHERE id=? AND slug=?", (id, s)):
        raise HTTPException(404, "没有这条关系")
    dbm.db().execute("DELETE FROM entity_relation WHERE id=?", (id,))
    return {"ok": True}


@router.get("/world/moments")
async def moments(request: Request, slug: str):
    current_user(request)
    s = _slug(slug)
    return {"items": W.list_moments(s)}


@router.post("/world/moment")
async def moment_add(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    label = args.s(payload.get("label"), name="时刻名").strip()
    if not label:
        raise HTTPException(400, "这一刻得有个名字（比如「入城那晚」）")
    if W.moment_by_label(s, label):
        raise HTTPException(400, "已经有一个同名的时刻了")
    mid = W.add_moment(s, label, str(payload.get("timeText") or ""),
                       source_scene=str(payload.get("sourceScene") or ""),
                       note=str(payload.get("note") or ""),
                       calendar=payload.get("calendar") or {})
    W.invalidate_snapshots(s)
    _audit("world.moment.add", s, label=label)
    # 时刻上写了时间文本（"开元 1024 年 3 月"）就顺手换算成绝对序号，让它能排序
    timed = None
    if str(payload.get("timeText") or "").strip():
        timed = W.set_moment_time(s, mid, text=str(payload["timeText"]),
                                  calendar_name=str(payload.get("calendarName") or ""))
    return {"ok": True, "id": mid, "time": timed}


@router.patch("/world/moment")
async def moment_update(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    mid = payload.get("id")
    if not dbm.db().one("SELECT id FROM moment WHERE id=? AND slug=?", (mid, s)):
        raise HTTPException(404, "没有这个时刻")
    dbm.db().execute(
        "UPDATE moment SET label=?, time_text=?, note=?, calendar_json=? WHERE id=?",
        (str(payload.get("label") or ""), str(payload.get("timeText") or ""),
         str(payload.get("note") or ""),
         dbm.Database.jdumps(payload.get("calendar") or {}), mid))
    W.invalidate_snapshots(s)
    timed = None
    if str(payload.get("timeText") or "").strip():
        timed = W.set_moment_time(s, mid, text=str(payload["timeText"]),
                                  calendar_name=str(payload.get("calendarName") or ""))
    _audit("world.moment.update", s, id=mid, label=payload.get("label"))
    return {"ok": True, "time": timed}


@router.delete("/world/moment")
async def moment_delete(request: Request, id: int, slug: str = ""):
    current_user(request)
    s = _slug(slug)
    if not dbm.db().one("SELECT id FROM moment WHERE id=? AND slug=?", (id, s)):
        raise HTTPException(404, "没有这个时刻")
    d = dbm.db()
    with d.tx() as conn:
        conn.execute("UPDATE fact SET valid_from_moment_id=NULL WHERE valid_from_moment_id=?", (id,))
        conn.execute("UPDATE fact SET valid_to_moment_id=NULL WHERE valid_to_moment_id=?", (id,))
        conn.execute("UPDATE entity SET first_moment_id=NULL WHERE first_moment_id=?", (id,))
        conn.execute("UPDATE episode SET moment_id=NULL WHERE moment_id=?", (id,))
        conn.execute("DELETE FROM moment_abs WHERE slug=? AND moment_id=?", (s, id))
        conn.execute("DELETE FROM moment WHERE id=?", (id,))
    W.invalidate_snapshots(s)
    _audit("world.moment.delete", s, id=id)
    return {"ok": True}


@router.get("/world/state")
async def state(request: Request, slug: str, name: str, at: str = ""):
    """「某人在某时是什么状态」—— 倒叙、回忆、前传都靠它。"""
    current_user(request)
    s = _slug(slug)
    out = W.state_of_entity(s, name, at or None)
    if out.get("error"):
        raise HTTPException(404, str(out["error"]) + ("（" + out["hint"] + "）"
                                                     if out.get("hint") else ""))
    return out


@router.get("/world/timeline")
async def timeline(request: Request, slug: str):
    current_user(request)
    s = _slug(slug)
    return W.timeline(s)


# ── 历法 / 回溯 / 切面 / 审计（事件溯源对外的那几个口子） ─────────────────────
@router.get("/world/calendars")
async def calendars(request: Request, slug: str):
    current_user(request)
    s = _slug(slug)
    return {"items": W.calendars(s)}


@router.post("/world/calendar")
async def calendar_save(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    try:
        return W.calendar_save(s, str(payload.get("name") or ""),
                               payload.get("def") or {}, str(payload.get("note") or ""))
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.delete("/world/calendar")
async def calendar_delete(request: Request, slug: str, name: str):
    current_user(request)
    out = W.calendar_delete(_slug(slug), name)
    if not out.get("ok"):
        raise HTTPException(400, out.get("error") or "删不掉")
    return out


@router.post("/world/calendar/convert")
async def calendar_convert(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    return W.calendar_convert(
        s, str(payload.get("text") or ""), calendar_name=str(payload.get("calendar") or ""),
        year=payload.get("year"),
        month=num(payload.get("month"), 1, lo=1, hi=12, name="月份"),
        day=num(payload.get("day"), 1, lo=1, hi=31, name="日"),
        abs_day=payload.get("abs"))


@router.post("/world/moment/time")
async def moment_time(request: Request, payload: dict = Body(...)):
    current_user(request)
    s = _slug(payload.get("slug"))
    out = W.set_moment_time(s, num(payload.get("momentId"), 0, name="时刻号"),
                            text=str(payload.get("text") or ""),
                            abs_day=payload.get("abs"),
                            calendar_name=str(payload.get("calendar") or ""))
    if not out.get("ok"):
        raise HTTPException(400, out.get("error") or "定不了这个时刻")
    return out


@router.get("/world/moment/times")
async def moment_times(request: Request, slug: str):
    current_user(request)
    return W.moment_times(_slug(slug))


@router.post("/world/reorder")
async def world_reorder(request: Request, payload: dict = Body(default={})):
    current_user(request)
    s = _slug(payload.get("slug"))
    moved = W.reorder_moments_by_abs(s)
    W.rebuild_snapshots(s)
    return {"ok": True, "moved": moved}


@router.get("/world/retro")
async def world_retro(request: Request, slug: str, at: str = "", subject: str = "",
                      limit: int = 40):
    """带出处的回溯：给定时刻（和可选主体），返回那一刻的完整状态。"""
    current_user(request)
    return W.retro(_slug(slug), at or None, subject, limit=limit)


@router.get("/world/snapshots")
async def world_snapshots(request: Request, slug: str, entityId: int = 0):
    current_user(request)
    s = _slug(slug)
    return {"items": W.snapshots(s, entityId or None)}


@router.post("/world/snapshots/rebuild")
async def world_snapshots_rebuild(request: Request, payload: dict = Body(default={})):
    current_user(request)
    s = _slug(payload.get("slug"))
    return W.rebuild_snapshots(s)


@router.get("/world/audit")
async def world_audit(request: Request, slug: str = "", limit: int = 100):
    current_user(request)
    rows = W.audit_log(slug, limit=limit)
    return {"items": rows, "count": len(rows)}


@router.get("/world/conflicts")
async def world_conflicts(request: Request, slug: str):
    current_user(request)
    s = _slug(slug)
    return {"items": W.conflicts(s)}


@router.post("/world/episode")
async def episode_add(request: Request, payload: dict = Body(...)):
    """往时间线的某一刻挂一件「发生过的事」。"""
    current_user(request)
    s = _slug(payload.get("slug"))
    title = (payload.get("title") or "").strip()
    if not title:
        raise HTTPException(400, "事件得有标题")
    eid = dbm.db().execute(
        "INSERT INTO episode(slug,moment_id,title,summary,scene_path,created_at)"
        " VALUES(?,?,?,?,?,?)",
        (s, payload.get("momentId"), title, str(payload.get("summary") or ""),
         str(payload.get("scenePath") or ""), now_ms()))
    return {"ok": True, "id": eid}


@router.delete("/world/episode")
async def episode_delete(request: Request, id: int, slug: str = ""):
    current_user(request)
    s = _slug(slug)
    if not dbm.db().one("SELECT id FROM episode WHERE id=? AND slug=?", (id, s)):
        raise HTTPException(404, "没有这件事")
    dbm.db().execute("DELETE FROM episode WHERE id=?", (id,))
    return {"ok": True}


@router.get("/world/arc")
async def arc_get(request: Request, slug: str, entityId: int):
    current_user(request)
    s = _slug(slug)
    row = dbm.db().one("SELECT * FROM arc WHERE slug=? AND entity_id=?", (s, entityId))
    if not row:
        return {"arc": None}
    row["turningPoints"] = dbm.Database.jloads(row["turning_points_json"], [])
    return {"arc": row}


@router.post("/world/arc")
async def arc_save(request: Request, payload: dict = Body(...)):
    """角色成长弧线：目标 / 动机 / 变化节点。"""
    current_user(request)
    s = _slug(payload.get("slug"))
    eid = payload.get("entityId")
    if not dbm.db().one("SELECT id FROM entity WHERE id=? AND slug=?", (eid, s)):
        raise HTTPException(404, "没有这个角色")
    d = dbm.db()
    d.execute("INSERT INTO arc(slug,entity_id,goal,motive,turning_points_json,updated_at)"
              " VALUES(?,?,?,?,?,?) ON CONFLICT(slug,entity_id) DO UPDATE SET"
              " goal=excluded.goal, motive=excluded.motive,"
              " turning_points_json=excluded.turning_points_json, updated_at=excluded.updated_at",
              (s, eid, str(payload.get("goal") or ""), str(payload.get("motive") or ""),
               dbm.Database.jdumps(payload.get("turningPoints") or []), now_ms()))
    return {"ok": True}


@router.post("/world/extract")
async def extract(request: Request, payload: dict = Body(...)):
    """从已有正文里认一遍人名：把出现频次高的专有名词抓出来当候选实体。
    纯本地统计，不花模型钱；结果只是候选，要不要收进世界由人定。"""
    current_user(request)
    s = _slug(payload.get("slug"))
    import re
    from ..store import chapter_files, read_text
    known = {e["name"] for e in W.entity_list(s)}
    alias = {a["alias"]: a["entity_id"] for a in dbm.db().query(
        "SELECT alias, entity_id FROM entity_alias WHERE slug=?", (s,))}
    counts: dict[str, int] = {}
    chapters = chapter_files(s)
    for c in chapters[:80]:
        try:
            text = read_text(s, c["path"])
        except Exception:
            continue
        for m in re.finditer(r"[\u4e00-\u9fa5]{2,4}", text):
            w = m.group(0)
            if w in known or w in alias:
                continue
            counts[w] = counts.get(w, 0) + 1
    # 只留「像名字」的：出现 3 次以上，且不是常用词（用一份常见词表挡掉）
    STOP = set("自己我们你们他们这个那个什么因为所以但是然后如果虽然已经可以应该"
               "一个不是没有知道时候现在这样怎么这里那里起来出来过去回来下去"
               "眼睛心里声音身上手里脸上门口身边周围一样东西感觉事情问题办法".replace(" ", ""))
    cands = [{"name": k, "count": v} for k, v in counts.items()
             if v >= 3 and k not in STOP and not any(ch in STOP for ch in k)]
    cands.sort(key=lambda x: -x["count"])
    return {"items": cands[:60], "chapters": len(chapters)}


# ── 从设定文件里认「事实 / 关系」（监督人 2026-09-21 加）──────────────
#   为什么加：世界引擎能手动一条条加事实，但没人会去手打几十条。
#   lorebook 里的设定文件本来就是结构化的（`- **姓名**：林昭`、`- **身份**：…之子`），
#   纯本地规则就能把「事实」和「关系」认出来 → 变成候选让人一键收下。
#   实测这本书：实体 11 个、**事实 0 条、关系 0 条** —— 面板点开当然是空的。
_FACT_KEY_SKIP = {"来源", "引用", "参考", "备注", "说明", "目录", "tags", "tag",
                  "aliases", "refs", "retrieval", "governance", "status", "icon",
                  "type", "subtype", "summary", "title", "ext"}

_REL_WORDS = [
    ("父亲", "父子"), ("爸爸", "父子"), ("母亲", "母子"), ("妈妈", "母子"),
    ("之子", "父子"), ("之女", "父女"), ("儿子", "父子"), ("女儿", "父女"),
    ("师傅", "师徒"), ("师父", "师徒"), ("老师", "师徒"), ("徒弟", "师徒"), ("弟子", "师徒"),
    ("哥哥", "兄弟"), ("弟弟", "兄弟"), ("姐姐", "姐妹"), ("妹妹", "姐妹"),
    ("妻子", "夫妻"), ("丈夫", "夫妻"), ("未婚妻", "夫妻"), ("未婚夫", "夫妻"), ("爱人", "夫妻"),
    ("同伴", "同伴"), ("队友", "同伴"), ("同学", "同伴"), ("搭档", "同伴"),
]


@router.post("/world/extract-facts")
async def extract_facts(request: Request, payload: dict = Body(default={})):
    """从 `lorebook/` 的设定文件里认「事实」和「关系」的候选（纯本地规则，不花模型钱）。

    - **事实**：`- **姓名**：林昭` 这类 `<属性>：<值>` 的条目
    - **关系**：同一段里出现的「另一个已登记实体 + 关系词」（如 `X 的师傅` / `X 之子`）
    结果**只是候选**，收不收由人定；重复的不会重复报。
    """
    import re as _re
    current_user(request)
    s = _slug((payload or {}).get("slug"))
    base = book_dir(s) / "lorebook"
    if not base.is_dir():
        return {"ok": True, "facts": [], "relations": [], "hint": "这本书没有 lorebook 目录"}

    ents = W.entity_list(s)
    by_name = {str(e["name"]).strip(): e for e in ents}
    # 已有的（事实 / 关系）先去重，避免重复报
    have_fact = {(r["entity_id"], str(r["key"]).strip(), str(r["value"]).strip())
                 for r in dbm.db().query("SELECT entity_id,key,value FROM fact WHERE slug=?", (s,))}
    have_rel = {(str(r["an"]).strip(), str(r["bn"]).strip(), str(r["k"]).strip())
                for r in dbm.db().query(
                    "SELECT a.name AS an, b.name AS bn, r.kind AS k FROM entity_relation r"
                    " LEFT JOIN entity a ON a.id=r.from_id"
                    " LEFT JOIN entity b ON b.id=r.to_id WHERE r.slug=?", (s,))}

    facts_out: list[dict] = []
    rels_out: list[dict] = []
    seen_f: set = set()
    seen_r: set = set()
    files = 0

    for f in sorted(base.rglob("*.md")):
        if f.name in ("index.md", "README.md"):
            continue
        try:
            text = f.read_text("utf-8")
        except Exception:
            continue
        files += 1
        rel_path = str(f.relative_to(book_dir(s)))
        # 这个文件讲的是谁：优先 frontmatter 的 title，其次文件名
        title = f.stem
        mm = _re.search(r"^title:\s*(.+)$", text, _re.M)
        if mm:
            title = mm.group(1).strip().strip('"').strip("'")
        ent = by_name.get(title)
        if not ent:                      # 退一步：文件名里包含某个实体名
            for nm, e in by_name.items():
                if nm and (nm in title or title in nm):
                    ent = e
                    break
        body = text
        if body.startswith("---"):
            end = body.find("\n---", 3)
            if end > 0:
                body = body[end + 4:]

        # ① 事实：`- **属性**：值`（按小节归属到具体角色）
        section = ""
        for line in body.splitlines():
            ln = line.strip()
            # 小节标题（## 一、林昭（主角） → 林昭）
            if ln.startswith("#"):
                h = _re.sub(r"^#+\s*", "", ln)
                h = _re.sub(r"^[-–—•*\s]+", "", h)
                h = _re.sub(r"^[一二三四五六七八九十百0-9]+[、.．)）\s]*", "", h).strip()
                h = h.split("（")[0].split("(")[0].split("【")[0].strip()
                section = h[:16]
                continue
            if len(ln) < 6 or ("：" not in ln and ":" not in ln):
                continue
            mo = _re.match(r"^[-*+]?\s*\*\*(.+?)\*\*\s*[:：]\s*(.+)$", ln)
            if not mo:
                continue
            key = mo.group(1).strip().strip("【】[]（）()")
            val = _re.sub(r"\*\*", "", mo.group(2)).strip()
            if not key or not val or len(key) > 18 or len(val) > 300:
                continue
            if key.lower() in _FACT_KEY_SKIP or key.startswith("#"):
                continue
            if not ent:
                continue
            tag = (ent["id"], section, key, val)
            if (ent["id"], key, val) in have_fact or tag in seen_f:
                continue
            seen_f.add(tag)
            facts_out.append({"entityId": ent["id"], "entity": ent["name"],
                              "section": section,
                              "key": key, "value": val[:200],
                              "sourcePath": rel_path, "file": f.name})

        # ② 关系：这一文件里出现的「另一个实体 + 关系词」
        if ent:
            for nm, other in by_name.items():
                if not nm or other["id"] == ent["id"] or len(nm) < 2:
                    continue
                for word, kind in _REL_WORDS:
                    if (nm + "的" + word) in body or (nm + word) in body and word in ("之子", "之女"):
                        tag = (nm, ent["name"], kind)
                        if tag in have_rel or tag in seen_r or (ent["name"], nm, kind) in have_rel:
                            continue
                        seen_r.add(tag)
                        rels_out.append({"from": nm, "to": ent["name"], "kind": kind,
                                         "file": f.name, "sourcePath": rel_path})
                        break

    facts_out.sort(key=lambda x: (x["entity"], x["key"]))
    return {"ok": True, "files": files,
            "facts": facts_out[:400], "relations": rels_out[:200],
            "have": {"facts": len(have_fact), "relations": len(have_rel)}}


# ── 把设定文件夹收进世界引擎 ────────────────────────────────────────────────
KIND_BY_SUBTYPE = {
    "character": "character", "characters": "character", "人物": "character",
    "location": "place", "place": "place", "地点": "place", "map": "place",
    "faction": "faction", "organization": "faction", "势力": "faction", "组织": "faction",
    "item": "item", "prop": "item", "道具": "item",
    "system": "system", "rule": "system", "rules": "system", "体系": "system", "规则": "system",
    "creature": "creature", "monster": "creature", "魂兽": "creature",
    "event": "concept", "history": "concept", "事件": "concept",
    # 目录名兜底（很多设定文件根本没有 frontmatter）
    "world": "system", "note": "concept", "notes": "concept", "reference": "concept",
}
SKIP_DIRS = {"instruction", "agents", "manual", "upload"}


def _kind_of(sub: str, parts: tuple) -> str:
    """从 subtype / 目录名推实体类型。子类型写法五花八门（item-catalog、system-setting…），
    所以按词切开一个个认，认不出再看目录名，最后兜底 concept。"""
    import re as _re
    sub = (sub or "").lower()
    for tok in _re.split(r"[-_\s/:]+", sub):
        if tok in KIND_BY_SUBTYPE:
            return KIND_BY_SUBTYPE[tok]
    for k, v in KIND_BY_SUBTYPE.items():
        if k and k in sub:
            return v
    if len(parts) > 1:
        d = parts[0].lower()
        if d in KIND_BY_SUBTYPE:
            return KIND_BY_SUBTYPE[d]
    return "concept"


def _front_matter(text: str) -> tuple[dict, str]:
    """解析 markdown 头部的 YAML frontmatter（只认我们需要的几种写法，不引第三方库）。"""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    head, body = text[3:end], text[end + 4:]
    meta: dict = {}
    key = None
    for raw in head.splitlines():
        line = raw.rstrip()
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.lstrip().startswith("- ") and key:
            meta.setdefault(key, [])
            if isinstance(meta[key], list):
                meta[key].append(line.lstrip()[2:].strip().strip('"\''))
            continue
        if ":" in line and not line.startswith(" "):
            k, v = line.split(":", 1)
            k, v = k.strip(), v.strip()
            key = k
            if not v:
                meta[k] = []
            elif v.startswith("[") and v.endswith("]"):
                meta[k] = [x.strip().strip('"\'') for x in v[1:-1].split(",") if x.strip()]
            else:
                meta[k] = v.strip('"\'')
    return meta, body


@router.post("/world/import-lorebook")
async def import_lorebook(request: Request, payload: dict = Body(default={})):
    """把 `lorebook/` 里的设定文件收进世界引擎（一条设定 = 一个实体 + 一份素材）。

    幂等：重复点只会更新，不会重复建。index.md 这类目录说明文件自动跳过。
    """
    current_user(request)
    s = _slug((payload or {}).get("slug"))
    force = bool((payload or {}).get("force"))
    base = book_dir(s) / "lorebook"
    if not base.is_dir():
        return {"ok": True, "imported": 0, "skipped": 0, "hint": "这本书没有 lorebook 目录"}
    d = dbm.db()
    imported, skipped = 0, 0
    for f in sorted(base.rglob("*.md")):
        rel = str(f.relative_to(book_dir(s)))
        if f.name in ("index.md", "README.md"):
            skipped += 1
            continue
        try:
            text = f.read_text("utf-8")
        except Exception:
            skipped += 1
            continue
        parts = f.relative_to(base).parts
        if len(parts) > 1 and parts[0] in SKIP_DIRS:
            skipped += 1
            continue
        meta, body = _front_matter(text)
        title = str(meta.get("title") or f.stem).strip()
        if title.endswith("index"):
            skipped += 1
            continue
        sub = str(meta.get("subtype") or meta.get("type") or "")
        if sub.strip().lower() in ("note", ""):
            sub = ""
        kind = _kind_of(sub, parts)
        summary = str(meta.get("summary") or "").strip()
        if not summary:
            summary = "\n".join(x.strip() for x in body.splitlines()
                                if x.strip() and not x.startswith("#"))[:200]
        aliases = [str(a) for a in (meta.get("aliases") or []) if str(a).strip()]
        exists = d.one("SELECT * FROM material WHERE slug=? AND path=? AND kind='lore'", (s, rel))
        if exists and not force:
            skipped += 1
            continue
        # 按「来源文件」认领已有的实体：改了类型/标题也不会冒出一个新的
        old = d.one("SELECT * FROM entity WHERE slug=? AND data_json LIKE ?",
                    (s, '%"source": ' + dbm.Database.jdumps(rel) + '%'))
        data = {"summary": summary, "subtype": sub.strip(),
                "tags": meta.get("tags") or [], "source": rel}
        if old and (old["name"] != title or old["kind"] != kind):
            d.execute("DELETE FROM entity_alias WHERE entity_id=?", (old["id"],))
            d.execute("UPDATE entity SET kind=?, name=?, data_json=?, first_seen_path=?,"
                      " updated_at=? WHERE id=?",
                      (kind, title, dbm.Database.jdumps(data), rel, now_ms(), old["id"]))
            eid = old["id"]
        else:
            eid = W.upsert_entity(s, kind, title, data, aliases, source_path=rel)
        if exists:
            d.execute("UPDATE material SET title=?, body=?, updated_at=? WHERE id=?",
                      (title, body.strip(), now_ms(), exists["id"]))
        else:
            d.execute("INSERT INTO material(slug,kind,title,body,tags_json,path,created_at,"
                      "updated_at) VALUES(?,?,?,?,?,?,?,?)",
                      (s, "lore", title, body.strip(),
                       dbm.Database.jdumps(meta.get("tags") or []), rel, now_ms(), now_ms()))
        imported += 1
    _audit("world.import.lorebook", s, imported=imported, skipped=skipped)
    return {"ok": True, "slug": s, "imported": imported, "skipped": skipped,
            "entities": d.scalar("SELECT COUNT(*) FROM entity WHERE slug=?", (s,)) or 0}
