# -*- coding: utf-8 -*-
"""多 Agent 编排：把一句「帮我写第 N 章」拆成一条**有角色、有交接、权限不同**的流水线。

和"单 Agent + 工具"的区别（这也是这个文件存在的理由）：
1. **角色分解**：leader（规划/调度）、retriever（取上下文）、researcher（查资料）、
   writer（写正文）、critic（挑刺/质检）。每个角色有自己的档案、自己的系统提示词。
2. **有交接**：leader 出计划 → retriever 按计划把料找齐 → researcher 核实 → writer 照着写
   → critic 挑刺 → writer 按批注改 → leader 汇总。每一棒都把上一棒的产出**真的读进去**
   （`orchestra_step.handoff_text` 落库，可复查）。
3. **可见范围不同**：`scope_allows()` 强制 —— writer 只能写 `manuscript/`（正文），
   设定/世界观/预设只有 leader 能改；critic 和 retriever 一个字都不能落盘。
   被挡下来的调用会记进 `rejected_json`，不是嘴上说说。
4. **三种模式在编排层生效**：讨论只来回谈（不动文件）；计划只出计划（不写正文）；
   执行才走完整条链并落盘。

工具协议沿用 agent_runtime 的纯文本行（`[tool:名字] {json}`），不另起一套。
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
import uuid

from .. import db as dbm
from .. import events
from ..llm.prompts import build_system, digest_system, preset_values, profile_of

# 一棒最多来回几次（读文件 → 看结果 → 再读，够用了；防跑飞）
MAX_STEP_ROUNDS = 3
# 交接时上一棒的产出最多带多少字（中文长文本按字算，6000 够写一章的骨架）
HANDOFF_CHARS = 6000

# ── 角色 ────────────────────────────────────────────────────────────────────
# `scope` 是**硬权限**：
#   read  —— 只能看
#   prose —— 只能写正文（manuscript/），设定类（lorebook/、world/、preset）碰不得
#   all   —— 全书都能改（只有 leader）
ROLES: dict[str, dict] = {
    "leader": {
        "name": "主创",
        "profile": "leader.default",
        "scope": "all",
        "tools": ["list_files", "read_file", "search_book", "world_state", "promise_list",
                  "chapter_list", "lore_list", "lore_read", "memory_search", "outline_read",
                  "outline_write", "term_list", "material_list", "reference_list",
                  "reference_read", "lint_check", "consistency_check", "pacing_check",
                  "notes_read", "web_search", "web_fetch", "write_file", "report_result"],
        "sees": ["全书现状", "世界事实", "未兑现伏笔", "相关记忆", "上游交接"],
        "duty": "排计划、派活、汇总；影响面大的改动先说清楚再动。",
    },
    "retriever": {
        "name": "取上下文",
        "profile": "retriever",
        "scope": "read",
        "tools": ["list_files", "read_file", "search_book", "world_state", "promise_list",
                  "chapter_list", "lore_list", "lore_read", "memory_search", "outline_read",
                  "notes_read", "term_list", "material_list", "reference_list",
                  "reference_read"],
        "sees": ["章节索引", "文件清单", "实体与设定索引", "未兑现伏笔", "正文检索"],
        "duty": "把这一章要用的料找齐，写清出处；不改任何文件。",
    },
    "researcher": {
        "name": "查证",
        "profile": "researcher",
        "scope": "read",
        "tools": ["read_file", "search_book", "world_state", "lore_read", "memory_search",
                  "chapter_list", "term_list", "consistency_check", "lint_check",
                  "reference_list", "reference_read", "web_search", "web_fetch"],
        "sees": ["设定库", "世界事实", "正文检索", "取上下文交来的清单",
                 "联网资料（用户在设置里开了才有）"],
        "duty": "核实名字、称呼、能力、地理、时间线；书里没有就上网查，引用要写来源；"
                "核实不了就直说，不要编。",
    },
    "writer": {
        "name": "写手",
        "profile": "writer",
        "scope": "prose",
        "tools": ["read_file", "list_files", "search_book", "world_state", "outline_read",
                  "outline_write", "lore_read", "memory_search", "term_list", "material_list",
                  "reference_list", "reference_read", "lint_check", "chapter_list",
                  "web_search", "web_fetch", "write_file", "report_result"],
        "sees": ["计划", "上下文包", "查证结论", "世界事实", "相关记忆", "大纲"],
        "duty": "照计划写正文；只写这一章，不碰设定，也不顺手改别的章节。",
    },
    "critic": {
        "name": "挑刺",
        "profile": "critic",
        "scope": "read",
        "tools": ["read_file", "search_book", "world_state", "promise_list", "lore_read",
                  "outline_read", "lint_check", "consistency_check", "pacing_check",
                  "memory_search", "chapter_list"],
        "sees": ["计划", "正文草稿", "机器质检命中", "世界事实", "未兑现伏笔", "大纲"],
        "duty": "逐条挑具体毛病并给改法；不能改文件，只交批注。",
    },
}

# ── 三种模式 ────────────────────────────────────────────────────────────────
# steps 里每一项是 (角色, 这一棒干什么, 输出要求)。
MODES: dict[str, dict] = {
    "discuss": {
        "name": "讨论",
        "desc": "先谈清楚再动笔：主创出主张 → 挑刺逐条反驳 → 主创回应收敛 → 挑刺复审。不动任何文件。",
        "writes": False,
        "steps": [
            ("leader", "出主张", "说清你打算怎么写、为什么这么写、有哪些要用户拍板的地方。别写正文。"),
            ("critic", "挑刺", "针对主张逐条挑毛病：哪里会和已有设定冲突、哪里会写崩、哪里在自嗨。"),
            ("leader", "回应与收敛", "逐条回应挑刺，能改的改，不能改的说清为什么，给出一版收敛后的方案。"),
            ("critic", "复审", "看收敛后的方案还剩哪些真问题；没有就直说没有，别凑数。"),
        ],
    },
    "plan": {
        "name": "计划",
        "desc": "只出计划：主创排步骤 → 取上下文取料 → 查证核实 → 主创定稿。不写正文、不动文件。",
        "writes": False,
        "steps": [
            ("leader", "排计划", "把这件事拆成可执行步骤：写哪几章、每章要发生什么、材料从哪来。"),
            ("retriever", "取上下文", "按计划把要用的文件、设定、伏笔列出来，写明出处。"),
            ("researcher", "查证", "核实清单里的事实有没有冲突、有没有书里没写的东西。"),
            ("leader", "定稿计划", "按取料与查证结果改定计划，逐条列出「下一步做什么」，并写明要动哪个文件（给路径）。"),
        ],
    },
    "execute": {
        "name": "执行",
        "desc": "一竿子到底：计划 → 取料 → 查证 → 写初稿 → 挑刺 → 改稿 → 汇总。",
        "writes": True,
        "steps": [
            ("leader", "排计划", "把这件事拆成可执行步骤，指明要写哪个文件、大概写什么。"),
            ("retriever", "取上下文", "把要用的文件、设定、前情、伏笔列出来，写明出处。"),
            ("researcher", "查证", "核实清单里的事实；冲突的指出来，书里没写的直说。"),
            ("writer", "写初稿", "照计划写正文初稿。只写指定的那一章，不碰别的东西。"),
            ("critic", "挑刺", "读初稿，逐条挑具体毛病：位置 + 为什么 + 改成什么样。"),
            ("writer", "按批注改稿", "按挑刺逐条改；改完把完整定稿再交一次。"),
            ("leader", "汇总", "说清这次做了什么、改了哪个文件、还剩什么要用户拍板。"),
        ],
    },
}


# 全部已知工具（来自各角色工具集的并集）。模型瞎编的工具名在这里就被挡掉。
KNOWN_TOOLS: frozenset[str] = frozenset(
    t for r in ROLES.values() for t in r["tools"])


# 单人模式：每个"干活方式"一句话说清"一个人从头做到尾"是什么样
ONE_SHOT: dict[str, str] = {
    "discuss": """
【这一轮只有你一个人，你要**依次演完下面几个角色**，一步都不许跳，每步都要留下看得见的东西】

① 主创 —— 把这件事的想法讲清楚：方向是什么、为什么这么定。
② 挑刺 —— 写完立刻**站到对面**，以挑刺者的身份列出最少 3 条问题（哪句空、哪里想当然、有没有更好的做法），要具体到句子，不许说"没什么问题"。
③ 主创 —— 按上面挑出的问题收敛，给出**最终主张**（说清保留了什么、改掉了什么）。

**规矩**：不许跳步、不许只列问题不收敛、不许"接下来可以……"式地留给下一步（这一轮没有下一步）。
**这一轮不动任何文件。**""",
    "plan": """
【这一轮只有你一个人，你要**依次演完下面几个角色**，一步都不许跳】

① 主创 —— 定方向：这一章/这一段要达成什么。
② 取料 —— 列出要用的材料（设定、前文、伏笔），把关键的那几条**原样摘出来**。
③ 主创 —— 把整件事拆成能直接照着做的步骤。
④ 挑刺 —— 站到对面挑这个计划的毛病：哪里会写崩、哪里缺材料、哪里顺序不对。

**规矩**：不许跳步、不许写正文、不许动任何文件。最后交一份**能直接照做**的计划。""",
    "execute": """
【这一轮只有你一个人，你要**依次演完下面四个角色**，一步都不许跳，每一步都要留在回答里】

① 主创（三五行，别长）—— 说清这一章要写什么、写到哪、为什么这么写。
② 写手 —— **紧接着一口气写完整章正文**。不许省、不许"待续"、不许交回给我、不许写大纲代替正文。
   该露骨的地方就写透，不许用比喻含混处理，不许"一夜过去"式地跳过关键场面。
   一章就是一整章（能写多长写多长，别惜字）。
③ 挑刺 —— 正文写完，立刻**站到挑刺者的位置**，列出最少 3 条真问题：
   哪里情绪是假的、哪里跳了、哪里该写透却含糊了。要**具体到句子**，不许说"整体不错"。
④ 润色 —— 按上面挑出的问题**真改一遍**（不是复述问题），把**改好后的完整正文**给出来。
   改完的地方不许变得更含蓄。

**规矩（缺一条都算没做完）**：
 · 四个角色都要出现，①②③④ 一步不跳；
 · ③ 挑出的问题必须**真的**在 ④ 里被改掉；
 · 不许只说"已经很好"、不许只列问题不改、不许把活留给下一步（这一轮没有下一步）；
 · 交代一句你动了哪个文件，以及还剩什么要用户拍板。
**这一轮你要出文件。**""",
}


def steps_for(mode: str, slug: str = "", divided: bool = True) -> list[tuple[str, str, str, bool]]:
    """这一轮要跑的那几棒。

    `divided`：
      · True（默认）—— 多 Agent 分工：计划/取料/查证/写稿/挑刺各是一个人。
        好处是每个角色只装一件事（写手放开写、挑刺往死里挑），互相不折中。
      · False —— **一个人干完**：整轮就一棒，由主创一个人从头做到尾，快、省。
    ：讨论/计划/执行**每一种都要能选这两种**，而不是另开一个"单人模式"。"""
    _m = MODES.get(mode, MODES["execute"])
    if not divided:
        """「一个人」：**同一个人把分工那几棒的活全干了，但步骤一步不少**。

        两段：
          · 「我本来想要的效果是一个AI干的时候，他会一个人扮演着所有的角色，
             你好像把这些去掉了」—— 所以不能塌成 1 棒（原来就是塌成 1 棒，挑刺/润色全没了）。
          · 「也得像分工一样演示出来他现在在哪一步」—— 所以步骤要照跑、界面要看得见。
        为什么能这么做：模型是按 `ctx["modelKey"]` 选的（见下面 primary_key），
        每一棒用的**本来就是同一个模型** —— 所以"棒多"不等于"人变多"，
        变的只是这一步戴哪顶帽子。"""
        allsteps = list(_m["steps"])
        # 走到哪一步，就带上**那一步自己的预设**（用户在「一个人（全套）」里填的）。
        # —— 对。原来 7 步共用一份设置，
        # 等于每一步都调不了。这里按"戴哪顶帽子"取对应那一格，拼进这一步的要求里。
        _S1 = {}
        try:
            from ..llm.prompts import preset_values as _pv
            _S1 = _pv(slug) if slug else {}
        except Exception:
            _S1 = {}
        _BY_ROLE = {"leader": "soloLeader", "retriever": "soloRetriever",
                    "researcher": "soloResearcher", "writer": "soloWriter",
                    "critic": "soloCritic"}
        out = []
        for i, (role, title, demand) in enumerate(allsteps, 1):
            want = ("这一轮只有你一个人（分工模式下的那几个角色，全由你一个人演）。\n"
                    "你现在是**第 %d 步 / 共 %d 步**，这一步只做「%s」这件事。\n"
                    % (i, len(allsteps), title)
                    + ONE_SHOT.get(mode, ""))
            _extra = str(_S1.get(_BY_ROLE.get(role, ""), "") or "").strip()
            if _extra:
                want += "\n【这一步的专门要求（用户写的，照做）】\n" + _extra
            out.append((role, "第%d步·%s" % (i, title), want, role == "writer"))
        return out

    """这一轮实际要跑的那几棒：`(角色, 标题, 要求, 是不是正文那一棒)`。

    为什么要单开一个函数（）：用户把预设里"什么活派给谁"从**一个没人读的输入框**
    改成了**真选项**。选了"正文交给主创"，执行模式里写正文那一棒就**真的是主创**在跑
    （落库的 `orchestra_step.role` 就是 leader，界面上也看得出来），不再只是提示词里一句话。

    换人只允许换成**权限更大或相等**的角色（候选表在 `llm/prompts.DELEGATE_ROWS` 里）：
    把写手换成主创，主创的 scope 是 all，不会因此少掉权限；反过来才会出事，
    所以那张表里根本不提供"把只看的人派去写"的选项。
    """
    steps = list(MODES.get(mode, MODES["execute"])["steps"])  # 分工模式下用这几棒
    if os.environ.get("DELEGATE_FORCE") == "ignore":
        return [(r, t, d, r == "writer") for r, t, d in steps]
    try:
        from ..llm.prompts import delegate_role_map, preset_values
        swap = delegate_role_map(preset_values(slug) if slug else {})
    except Exception:
        swap = {}
    out = []
    for role, title, demand in steps:
        is_prose = role == "writer"
        out.append((swap.get(role, role), title, demand, is_prose))
    return out


def mode_names() -> list[dict]:
    return [{"key": k, "name": v["name"], "desc": v["desc"], "writes": v["writes"],
             "steps": [{"role": r, "name": ROLES[r]["name"], "title": t} for r, t, _ in v["steps"]]}
            for k, v in MODES.items()]


def roles_catalog() -> list[dict]:
    return [{"key": k, "name": v["name"], "profile": v["profile"], "scope": v["scope"],
             "tools": list(v["tools"]), "sees": list(v["sees"]), "duty": v["duty"]}
            for k, v in ROLES.items()]


# ── 可见范围（硬权限）───────────────────────────────────────────────────────
# **所有会改文件的工具** —— 一个都不能漏。
# 踩过的坑：闸门原来只写 `tool == "write_file"`，而工具清单里还有 `outline_write`（写大纲），
# 于是"讨论/计划模式不出文件"这条规矩对它是**失效**的（规则只挡了其中一个名字）。
# 以后再加写类工具，**必须**往这里补，别只在调用处判断。
WRITE_TOOLS = {"write_file", "outline_write"}


def scope_allows(role: str, tool: str, args: dict, target_path: str = "",
                 mode: str = "", mode_writes: bool = True) -> tuple[bool, str]:
    """这一步能不能这么干。返回 (能不能, 不能的理由)。理由要能直接给人看。

    `mode_writes=False` 是**模式级的闸**：讨论/计划这两种模式说好了"先别动手"，
    那就连主创也不许写文件 —— 不然"模式"只是换了个角色列表，等于没生效。
    """
    r = ROLES.get(role)
    if not r:
        return False, f"没有这个角色：{role}"
    if tool in WRITE_TOOLS and not mode_writes:
        nm = MODES.get(mode, {}).get("name", mode or "这一步")
        return False, f"「{nm}」模式不出文件：先把话谈清楚/把计划排好，正文与设定都不动"
    if tool in WRITE_TOOLS and r["scope"] == "read":
        return False, f"「{r['name']}」只看不改：这一步不允许写文件"
    if tool not in r["tools"]:
        return False, f"「{r['name']}」这一步没有 {tool} 权限"
    if tool not in WRITE_TOOLS:
        return True, ""
    path = str(args.get("path") or "").strip().lstrip("/")
    if r["scope"] == "prose":
        if not path.startswith("manuscript/"):
            return False, (f"「{r['name']}」只能写正文（manuscript/），"
                           f"设定与世界观只有主创能改：{path or '（没给路径）'}")
        if target_path and path != target_path:
            return False, f"「{r['name']}」这一步只写 {target_path}，不能顺手改 {path}"
    return True, ""


def create_run(sid: int, slug: str, inv: str, mode: str, goal: str,
               target_path: str = "") -> int:
    d = dbm.db()
    return int(d.execute(
        "INSERT INTO orchestra_run(slug,session_id,invocation_id,mode,goal,target_path,status,"
        "started_at) VALUES(?,?,?,?,?,?,'running',?)",
        (slug, sid, inv, mode, goal, target_path, dbm.now_ms())))


def _step_insert(run_id: int, seq: int, role: str, title: str,
                 handoff_from: str = "", handoff_text: str = "") -> int:
    d = dbm.db()
    r = ROLES[role]
    return int(d.execute(
        "INSERT INTO orchestra_step(run_id,seq,role,role_name,title,profile_key,sees_json,"
        "tools_json,handoff_from,handoff_text,started_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (run_id, seq, role, r["name"], title, r["profile"], d.jdumps(r["sees"]),
         d.jdumps(r["tools"]), handoff_from, handoff_text[:HANDOFF_CHARS], dbm.now_ms())))


def _step_finish(step_id: int, *, output: str, calls: list, rejected: list,
                 wrote: list, tokens: tuple[int, int], status: str = "done") -> None:
    d = dbm.db()
    d.execute("UPDATE orchestra_step SET output=?,calls_json=?,rejected_json=?,wrote_json=?,"
              "tokens_in=?,tokens_out=?,status=?,ended_at=? WHERE id=?",
              (output[:20000], d.jdumps(calls), d.jdumps(rejected), d.jdumps(wrote),
               int(tokens[0]), int(tokens[1]), status, dbm.now_ms(), step_id))


def finish_run(run_id: int, status: str, wrote: list[str]) -> None:
    d = dbm.db()
    d.execute("UPDATE orchestra_run SET status=?,wrote_json=?,ended_at=? WHERE id=?",
              (status, d.jdumps(wrote), dbm.now_ms(), run_id))


def run_record(sid: int, limit: int = 5) -> list[dict]:
    """给界面用的：这次到底谁干了什么活、交给下一个人什么。"""
    d = dbm.db()
    runs = d.query("SELECT * FROM orchestra_run WHERE session_id=? ORDER BY id DESC LIMIT ?",
                   (sid, limit))
    out = []
    for r in runs:
        steps = d.query("SELECT * FROM orchestra_step WHERE run_id=? ORDER BY seq", (r["id"],))
        out.append({
            "id": r["id"], "mode": r["mode"], "modeName": MODES.get(r["mode"], {}).get("name", r["mode"]),
            "goal": r["goal"], "status": r["status"], "targetPath": r["target_path"],
            "wrote": d.jloads(r["wrote_json"], []),
            "startedAt": r["started_at"], "endedAt": r["ended_at"],
            "steps": [{
                "seq": s["seq"], "role": s["role"], "roleName": s["role_name"],
                "title": s["title"], "sees": d.jloads(s["sees_json"], []),
                "tools": d.jloads(s["tools_json"], []),
                "handoffFrom": s["handoff_from"],
                "handoff": s["handoff_text"][:1200],
                "output": s["output"], "calls": d.jloads(s["calls_json"], []),
                "rejected": d.jloads(s["rejected_json"], []),
                "wrote": d.jloads(s["wrote_json"], []),
                "tokensIn": s["tokens_in"], "tokensOut": s["tokens_out"], "status": s["status"],
            } for s in steps],
        })
    return out


# ── 上下文：每个角色看到的东西不一样 ────────────────────────────────────────
def _target_path(slug: str, text: str, payload: dict) -> str:
    """这一棒要写哪个文件。用户明说了就用用户的，否则按"最大章节号 +1"猜一个。"""
    p = str((payload or {}).get("path") or "").strip().lstrip("/")
    if p:
        return p
    m = re.search(r"(manuscript|正文)/\S+\.(md|txt)", text or "")
    if m:
        return m.group(0)
    try:
        from ..store import chapter_files
        files = chapter_files(slug)
    except Exception:
        files = []
    if not files:
        return "manuscript/001-第一章.md"
    # 空章优先：**最新章节是空的，就写它**，别往后跳。
    # 用户实测的毛病：新开的书自带一个空的「001-第一章.md」，旧逻辑按"最大章号 +1"算
    # → 直接跑去写第二章，第一章永远空着；而且 AI 以为自己是"接着写"，
    # 根本不知道这本书还没开张（）。
    for f in reversed(files):
        try:
            if int(f.get("words") or 0) <= 0:
                return f["path"]
        except Exception:
            continue
    nums, last = [], files[-1]["path"]
    for f in files:
        mm = re.search(r"(\d+)", f["path"].rsplit("/", 1)[-1])
        if mm:
            nums.append(int(mm.group(1)))
    nxt = (max(nums) + 1) if nums else len(files) + 1
    name = last.rsplit("/", 1)[-1]
    stem = re.sub(r"^\d+[-_]?", "", name)
    stem = re.sub(r"\.(md|txt)$", "", stem)
    # 章号在标题里也一起往前挪：上一章叫「005-第005章-木牌」，下一章就该是「006-第006章-木牌」，
    # 不然会出现「006-第005章-…」这种自相矛盾的文件名
    stem = re.sub(r"第\s*0*(\d+)\s*章", f"第{nxt:03d}章", stem)
    # 扩展名要留着：上一版把 `.md` 剥掉之后没加回来，写手真的写出了没有后缀的文件
    return f"manuscript/{nxt:03d}-{stem}.md"


def _book_state_bits(slug: str, target: str) -> str:
    """【这本书现在的状态】—— 新书 / 有空章时必须让 AI 知道它从哪儿开始写。

    用户实测的毛病：新开的书自带一个空的「001-第一章.md」，AI 从目录里看到"第一章"，
    就以为前情已经有了，**直接开写第二章**，第一章永远是空的；
    而且它以为自己是"接着写"，满篇"如前所述"这类承接语，读起来莫名其妙。
    """
    from ..store import chapter_files
    try:
        files = chapter_files(slug)
    except Exception:
        files = []
    if not files:
        return ("【这本书现在的状态】**还没有任何章节** —— 这是全新的一本书，没有任何前情。\n"
                "你这一章就是开场：把人物、地点、正在发生的事立起来；\n"
                "**不要**写「如前所述」「话说回来」「接上文」这类承接语（没有上文可接）。")
    def _empty(f):
        try:
            return int(f.get("words") or 0) <= 0
        except Exception:
            return False
    empties = [f for f in files if _empty(f)]
    tgt = next((f for f in files if f.get("path") == target), None)
    lines = ["【这本书现在的状态】共 %d 章，其中 %d 章还是空的。" % (len(files), len(empties))]
    if tgt is not None and _empty(tgt):
        lines.append("**这一章（%s）现在还是空的，你要写的就是它** —— "
                     "这本书还没有正文，直接从头讲起，不要承接任何「上一章」。"
                     % (tgt.get("name") or tgt.get("path")))
    elif empties:
        lines.append("还有空章：%s。这一轮要写的是 %s。"
                     % ("、".join(str(e.get("name") or e.get("path") or "?") for e in empties[:5]),
                        target))
    else:
        lines.append("上一章是 %s，接着往下写。" % (files[-1].get("name") or files[-1].get("path")))
    return "\n".join(lines)


def _index_bits(slug: str) -> str:
    """给 retriever 的索引（不花模型钱就能给的事实面）。"""
    d = dbm.db()
    bits = []
    try:
        from ..store import chapter_files
        files = chapter_files(slug)
        if files:
            bits.append("章节（按顺序）：\n" + "\n".join(
                f"- {c['path']}（{c['words']} 字）" for c in files[-20:]))
    except Exception:
        # 章节清单取不到 = 这次少一段上下文，编排照跑。
        pass
    ents = d.query("SELECT kind,name,data_json FROM entity WHERE slug=? ORDER BY kind,name LIMIT 40",
                   (slug,))
    if ents:
        lines = []
        for e in ents:
            data = d.jloads(e["data_json"], {}) or {}
            tag = str(data.get("summary") or data.get("tagline") or data.get("desc")
                      or data.get("性格") or "").strip()
            lines.append(f"- [{e['kind']}] {e['name']}" + (f"：{tag[:60]}" if tag else ""))
        bits.append("实体：\n" + "\n".join(lines))
    pend = d.query("SELECT name,kind,status,due_chapter FROM promise WHERE slug=? AND status!='paid'"
                   " ORDER BY id LIMIT 15", (slug,))
    if pend:
        bits.append("未兑现的伏笔：\n" + "\n".join(
            f"- {p['name']}（{p['kind']}／{p['status']}）" for p in pend))
    chunks = d.query("SELECT subject,topic,view_text FROM memory WHERE slug=? LIMIT 40", (slug,))
    if chunks:
        bits.append("记忆索引：\n" + "\n".join(
            f"- {c['subject']}／{c['topic']}：{(c['view_text'] or '')[:50]}" for c in chunks))
    return "\n\n".join(bits)


# ── 跑一棒 ──────────────────────────────────────────────────────────────────
async def _run_step(ctx: dict, seq: int, role: str, title: str, demand: str,
                    handoff_from: str, handoff_text: str, step_id: int,
                    is_prose: bool = False) -> str:
    """跑一个角色。返回它的产出（交给下一棒）。

    `is_prose`：**这一棒是不是"写正文"那一棒**（）。原来这两处的兜底都是
    `role == "writer"` —— 可用户可以把正文派给主创，那时候"稿子只在聊天里没落盘"
    的兜底就会失效（主创跑的是 leader 这个角色名）。所以判据从"角色名"改成"这一棒干什么"。
    """
    from . import agent_runtime as rt
    from ..llm.providers import stream_chat, stream_with_fallback

    sid = ctx["sid"]
    slug = ctx["slug"]
    inv = ctx["inv"]
    sess = ctx["sess"]
    r = ROLES[role]
    target = ctx["target_path"]
    values = preset_values(slug)

    events.emit(sid, "orchestra_step_start", {
        "type": "orchestra_step_start", "runId": ctx["run_id"], "seq": seq,
        "role": role, "roleName": r["name"], "title": title, "sees": list(r["sees"]),
        "handoffFrom": handoff_from},
        invocation_id=inv)

    memory_hits = rt._memory_hits(slug, ctx["goal"] + " " + handoff_text)
    # 每个角色看到的上下文**不一样**：critic/retriever 不给"写作设定堆"，writer 才给
    _pk = "solo.default" if ctx.get("solo") else r["profile"]
    system = build_system(_pk, slug, values,
                          memory_hits=memory_hits if role in ("leader", "writer") else None)
    # 这本书现在的状态：新书/空章必须说清楚，否则 AI 会跳过空的第一章直接写第二章
    system += "\n\n" + _book_state_bits(slug, target)
    system += ("\n\n【你这一步的角色】" + r["name"] + "：" + r["duty"] +
               "\n【你只能看到这些】" + "、".join(r["sees"]) +
               "\n【约束】" + ("你不改任何文件，只交结论。" if r["scope"] == "read" else
                                ("你只写正文（manuscript/ 下的文件），设定和世界观不要动。"
                                 if r["scope"] == "prose" else "你可以改文件，但改之前要说清影响面。")))

    head = [f"【总目标】{ctx['goal']}", f"【你这一棒】{title}：{demand}"]
    if target and role in ("writer", "leader"):
        head.append(f"【要写的文件】{target}")
    if handoff_from:
        head.append(f"【上一棒「{ROLES[handoff_from]['name']}」交给你的东西】\n{handoff_text[:HANDOFF_CHARS]}")
    if role == "critic":
        head.append("【机器质检命中】（这些是规则抓出来的，你在批注里要顺带确认哪些是真问题）\n"
                    + (ctx.get("lint_bits") or "（没有命中）"))
    if role == "retriever":
        head.append("【这本书的索引】\n" + _index_bits(slug))
    head.append("【输出】直接给这一步的结论，不要客套，不要「好的」「以下是」。")
    msgs = [{"role": "user", "content": "\n\n".join(head)}]

    # 「这一棒用了什么」的账（用户要的"看得见"）：跟单 Agent 那条路同一份算法、同一张卡片，
    # 只是这里能用的工具是**这一棒角色的**（权限本来就不同，要说清）。
    step_ctx = digest_system(system)
    step_called: list = []
    step_files: list = []

    def ctx_now() -> dict:
        return dict(step_ctx, tools={"allowed": list(r["tools"]), "called": list(step_called)},
                    files=list(step_files))

    events.emit(sid, "turn_context", {"type": "turn_context", "context": ctx_now(),
                                      "role": role, "seq": seq}, invocation_id=inv)

    provider, mid = ctx["provider"], ctx["mid"]
    calls_made: list[dict] = []
    done_calls: dict[str, dict] = {}   # 同一棒里重复的调用只真跑一次（模型爱重复）
    rejected: list[dict] = []
    wrote: list[str] = []
    texts: list[str] = []
    tok_in = tok_out = 0
    status = "done"

    for round_no in range(MAX_STEP_ROUNDS):
        if sid in rt.ABORTS:
            status = "aborted"
            break
        msg_id = uuid.uuid4().hex
        events.emit(sid, "message_start", {"type": "message_start", "role": "assistant",
                                           "messageId": msg_id, "round": round_no,
                                           "orchestra": {"role": role, "roleName": r["name"],
                                                         "title": title, "seq": seq}},
                    invocation_id=inv)
        buf: list[str] = []
        try:
            async for ev in stream_with_fallback(
                    provider, mid, msgs, system=system, temperature=0.85,
                    stream=ctx.get("stream"), primary_key=ctx.get("modelKey") or mk):
                if sid in rt.ABORTS:
                    break
                if ev["type"] == "delta":
                    buf.append(ev["delta"])
                    events.emit(sid, "message_update", {
                        "type": "message_update", "messageId": msg_id,
                        "update": {"type": "text_delta", "delta": ev["delta"]}},
                        invocation_id=inv)
                elif ev["type"] == "usage":
                    tok_in += int(ev["usage"].get("input") or 0)
                    tok_out += int(ev["usage"].get("output") or 0)
                elif ev["type"] == "notice":
                    rt.append_entry(sid, "system", [{"type": "text", "content": ev["notice"]}])
                elif ev["type"] == "error":
                    status = "error"
                    rt.append_entry(sid, "system", [{"type": "text",
                                                     "content": f"{r['name']}这一步模型出错了：{ev['error']}"}])
        except Exception as e:                       # 一棒挂了不要让整条链断在半路
            status = "error"
            rt.append_entry(sid, "system", [{"type": "text", "content": f"{r['name']}这一步失败：{e}"}])
            break

        raw = "".join(buf)
        visible, calls = rt._split_tool_lines(raw)
        # 只按"是不是已知工具"过滤掉模型瞎编的名字；
        # 越权（在已知工具里、但不属于这个角色）**不在这里丢**，要一路走到 scope_allows
        # 被明确挡下并落进 rejected_json —— 否则"可见范围不同"就是句空话。
        calls = [(n, a) for n, a in calls if n in KNOWN_TOOLS]
        blocks: list[dict] = [{"type": "role", "role": role, "roleName": r["name"],
                               "title": title, "seq": seq}]
        if visible:
            blocks.append({"type": "text", "content": visible})
            texts.append(visible)
        shown: set[str] = set()
        for n, a in calls:
            ok, why = scope_allows(role, n, a, target, ctx["mode"],
                                   MODES[ctx["mode"]]["writes"])
            sig = json.dumps([n, a], ensure_ascii=False, sort_keys=True)
            if ok and sig not in shown:
                shown.add(sig)
                blocks.append({"type": "tool_call", "name": n, "args": a})
        if visible or calls:
            rt.append_entry(sid, "assistant", blocks,
                            usage={"input": tok_in, "output": tok_out,
                                   "model": mid, "role": role, "context": ctx_now()})
        if step_called:
            try:                      # 边跑边推：用户能实时看见这一棒读了什么、改了什么
                events.emit(sid, "turn_context", {"type": "turn_context", "context": ctx_now(),
                                                  "role": role, "seq": seq}, invocation_id=inv)
            except Exception:
                pass
        msgs.append({"role": "assistant", "content": visible or raw[:4000]})
        if status == "error":
            break

        ran = False
        for n, a in calls:
            ok, why = scope_allows(role, n, a, target, ctx["mode"],
                                   MODES[ctx["mode"]]["writes"])
            if not ok:
                sig = json.dumps([n, a], ensure_ascii=False, sort_keys=True)
                if sig not in done_calls:      # 同一次越权只记一笔，别记成一排
                    rejected.append({"tool": n, "args": a, "why": why})
                    calls_made.append({"tool": n, "args": a, "blocked": True, "why": why})
                    done_calls[sig] = {"error": "blocked", "why": why}
                    events.emit(sid, "tool_execution_end", {
                        "type": "tool_execution_end", "toolName": n, "args": a, "isError": True,
                        "result": {"content": [{"type": "text", "text": "被挡下了：" + why}]}},
                        invocation_id=inv)
                rt.note_tool_call(step_called, step_files, n, a, {"error": "blocked"})
                msgs.append({"role": "user", "content": f"[tool:{n}] 被挡下了：{why}"})
                ran = True
                continue
            sig = json.dumps([n, a], ensure_ascii=False, sort_keys=True)
            if sig in done_calls:
                res = done_calls[sig]
                msgs.append({"role": "user", "content":
                             f"[tool:{n}] 这个调用这一步已经做过了，结果同上："
                             f"{json.dumps(res, ensure_ascii=False)[:2000]}"})
                ran = True
                continue
            ran = True
            events.emit(sid, "tool_execution_start", {
                "type": "tool_execution_start", "toolCallId": uuid.uuid4().hex,
                "toolName": n, "args": a, "role": role}, invocation_id=inv)
            res = await asyncio.to_thread(rt.run_tool, slug, n, a)
            done_calls[sig] = res
            calls_made.append({"tool": n, "args": a, "blocked": False,
                               "isError": "error" in res})
            rt.note_tool_call(step_called, step_files, n, a, res)
            if n == "write_file" and not res.get("error"):
                wrote.append(str(a.get("path") or ""))
            events.emit(sid, "tool_execution_end", {
                "type": "tool_execution_end", "toolName": n, "args": a, "role": role,
                "isError": "error" in res,
                "result": {"content": [{"type": "text",
                                        "text": json.dumps(res, ensure_ascii=False)[:6000]}]}},
                invocation_id=inv)
            rt.append_entry(sid, "tool_result", [
                {"type": "result", "name": n, "isError": "error" in res,
                 "content": [{"type": "text",
                              "text": json.dumps(res, ensure_ascii=False)[:6000]}]}])
            msgs.append({"role": "user", "content":
                         f"[tool:{n}] 结果：{json.dumps(res, ensure_ascii=False)[:6000]}"})
        if not ran:
            break

    # 只调工具、一句话没说的棒（模型很爱这样，尤其是"查证"这种读一堆文件的角色）：
    # 必须再问它一次"现在出结论"。不然下一棒拿到的是空气 —— 实跑里"查证"读了三个文件
    # 然后一声不吭，主创只能凭上一棒的材料硬编。
    if not any(t.strip() for t in texts) and calls_made and status == "done":
        nudge = ("时间到了：不要再调用任何工具。现在直接写结论 —— "
                 "把上面读到的内容整理成能交给下一棒的东西。")
        msgs.append({"role": "user", "content": nudge})
        msg_id = uuid.uuid4().hex
        events.emit(sid, "message_start", {"type": "message_start", "role": "assistant",
                                           "messageId": msg_id, "round": MAX_STEP_ROUNDS,
                                           "orchestra": {"role": role, "roleName": r["name"],
                                                         "title": title + "（收口）", "seq": seq}},
                    invocation_id=inv)
        buf2: list[str] = []
        try:
            async for ev in stream_chat(provider, mid, msgs, system=system, temperature=0.7,
                                        stream=ctx.get("stream")):
                if ev["type"] == "delta":
                    buf2.append(ev["delta"])
                    events.emit(sid, "message_update", {
                        "type": "message_update", "messageId": msg_id,
                        "update": {"type": "text_delta", "delta": ev["delta"]}},
                        invocation_id=inv)
                elif ev["type"] == "usage":
                    tok_in += int(ev["usage"].get("input") or 0)
                    tok_out += int(ev["usage"].get("output") or 0)
                elif ev["type"] == "notice":
                    rt.append_entry(sid, "system", [{"type": "text", "content": ev["notice"]}])
                elif ev["type"] == "error":
                    status = "error"
                    rt.append_entry(sid, "system", [{"type": "text",
                        "content": f"{r['name']}这一步（收口）模型出错：{ev['error']}"}])
        except Exception as e:
            # 打磨：以前这里是 `pass` —— 收口那一趟挂了，整棒会安静地"成功结束"，
            # 用户看到的是"写完了"，其实结论没产出。现在记进对话和状态里。
            status = "error"
            rt.append_entry(sid, "system", [{"type": "text",
                "content": f"{r['name']}这一步（收口）失败：{e}"}])
        final_text = "".join(buf2).strip()
        if final_text:
            texts.append(final_text)
            rt.append_entry(sid, "assistant", [
                {"type": "role", "role": role, "roleName": r["name"],
                 "title": title + "（收口）", "seq": seq},
                {"type": "text", "content": final_text}],
                usage={"input": tok_in, "output": tok_out, "model": mid, "role": role,
                       "context": ctx_now()})

    # 反过来的一种毛病：**写手把整段正文写在回复里，一个文件都没写**。
    # 「执行」模式说好了要落盘，半路丢稿子是产品事故（实跑抓到：1507 字初稿只在聊天里，
    # 下一棒的挑刺拿不到文件、用户的书里也没有这一章）。先催一次让它写进指定文件；
    # 还不写就替它落盘（记为 auto），并在界面上说清楚"这一步的稿子是编排代写的"。
    must_write = (is_prose and MODES[ctx["mode"]]["writes"] and bool(target)
                  and not wrote and any(t.strip() for t in texts)
                  and status == "done" and sid not in rt.ABORTS)
    if must_write:
        msgs.append({"role": "assistant", "content": "\n".join(texts)[:4000]})
        msgs.append({"role": "user", "content":
                     f"你上面的稿子还没落到文件里。现在**只**输出一行 "
                     f"[tool:write_file] {{\"path\": \"{target}\", \"content\": \"正文全文\"}}，"
                     "不要复述正文、不要解释、不要任何别的字。"})
        msg_id = uuid.uuid4().hex
        events.emit(sid, "message_start", {"type": "message_start", "role": "assistant",
                                           "messageId": msg_id, "round": MAX_STEP_ROUNDS,
                                           "orchestra": {"role": role, "roleName": r["name"],
                                                         "title": title + "（落盘）", "seq": seq}},
                    invocation_id=inv)
        buf3: list[str] = []
        try:
            async for ev in stream_chat(provider, mid, msgs, system=system, temperature=0.3,
                                        stream=ctx.get("stream")):
                if ev["type"] == "delta":
                    buf3.append(ev["delta"])
                    events.emit(sid, "message_update", {
                        "type": "message_update", "messageId": msg_id,
                        "update": {"type": "text_delta", "delta": ev["delta"]}},
                        invocation_id=inv)
                elif ev["type"] == "usage":
                    tok_in += int(ev["usage"].get("input") or 0)
                    tok_out += int(ev["usage"].get("output") or 0)
                elif ev["type"] == "error":
                    rt.append_entry(sid, "system", [{"type": "text",
                        "content": f"{r['name']}这一步（落盘）模型出错：{ev['error']}"}])
        except Exception as e:
            # 同上：落盘这一趟挂了最要命 —— 稿子只在聊天里，书里一个字都没有，
            # 而且这一棒的产出就是正文，静默失败等于"写手白干"。
            # 这里**故意不把 status 置成 error**：下面那段「编排代写」要求 status=='done'
            # 才会兜底把聊天里的稿子写进文件，把它置错等于顺手把兜底也关了。
            rt.append_entry(sid, "system", [{"type": "text",
                "content": f"{r['name']}这一步（落盘）失败：{e}"}])
        raw3 = "".join(buf3)
        _vis3, calls3 = rt._split_tool_lines(raw3)
        for n, a in calls3:
            if n != "write_file":
                continue
            ok, why = scope_allows(role, n, a, target, ctx["mode"], MODES[ctx["mode"]]["writes"])
            if not ok:
                continue
            res = await asyncio.to_thread(rt.run_tool, slug, n, a)
            calls_made.append({"tool": n, "args": {"path": a.get("path")}, "blocked": False,
                               "isError": "error" in res})
            if not res.get("error"):
                wrote.append(str(a.get("path") or ""))
            rt.append_entry(sid, "tool_result", [
                {"type": "result", "name": n, "isError": "error" in res,
                 "content": [{"type": "text",
                              "text": json.dumps(res, ensure_ascii=False)[:2000]}]}])
            break

    # 催过还不写：编排替它把稿子落盘（不写等于用户白等一场）。记为 auto，界面上看得出来。
    if (is_prose and MODES[ctx["mode"]]["writes"] and target and not wrote
            and status == "done"):
        draft = "\n".join(t for t in texts if t.strip()).strip()
        if len(draft) >= 120:
            res = await asyncio.to_thread(rt.run_tool, slug, "write_file",
                                          {"path": target, "content": draft})
            if not res.get("error"):
                wrote.append(target)
                calls_made.append({"tool": "write_file",
                                   "args": {"path": target, "content": "（编排代写：模型只说没落盘）"},
                                   "blocked": False, "isError": False, "auto": True})
                events.emit(sid, "tool_execution_end", {
                    "type": "tool_execution_end", "toolName": "write_file",
                    "args": {"path": target}, "role": role, "isError": False,
                    "result": {"content": [{"type": "text",
                                            "text": "模型把正文写在回复里没落盘，编排替它写进了 " + target}]}},
                    invocation_id=inv)
                rt.append_entry(sid, "system", [{"type": "text", "content":
                    "这一步模型只把正文写在回复里、没有落盘，编排已代它写进 " + target +
                    "（上面那步的 wrote 里带 auto 标记）。"}])


    # **把"等一下我再继续"这种自言自语从给用户看的产出里去掉。**
    # 用户实测报过："主创一个字没说，第六章就出来了，我以为它死了" ——
    # 其实它写了 4000 多字，但中间夹满了模型等工具结果时自己念的
    # 「空出这一行以等待工具执行结果。call:outline_read {}」这类占位句，
    # 把正经话全盖住了。这里整行丢掉（只影响**给用户看的那份**，
    # 工具调用记录在 calls_json 里，一个字没少）。
    _PH = re.compile(r"^[^\n]*(?:空出这一行以等待工具执行结果|等待工具执行结果)[^\n]*$", re.M)
    _PH2 = re.compile(r"^\s*call:[a-zA-Z_]+\s*\{?[^\n]*\}?\s*$", re.M)
    texts = [_PH2.sub("", _PH.sub("", t)) for t in texts]

    output = "\n".join(t for t in texts if t.strip()).strip()
    # 只调了 write_file、一个字没说的棒（模型常这样）：产出不能是空的，
    # 否则下一棒（挑刺）拿到的是空气，只能瞎编 —— 这里把写过的东西读回来当产出。
    if not output and wrote:
        from ..store import read_text
        pieces = []
        for path in wrote[:3]:
            try:
                body = read_text(slug, path)
            except Exception:
                body = ""
            if body.strip():
                pieces.append(f"【{path}】（这一步直接写了文件，没有额外说明）\n{body[:4000]}")
        output = "\n\n".join(pieces)
    elif wrote:      # 说了话又写了文件：把写出来的东西也带上，下一棒才看得到全文
        from ..store import read_text
        for path in wrote[:2]:
            try:
                body = read_text(slug, path)
            except Exception:
                continue
            if body.strip():
                output += f"\n\n【{path} 的当前内容】\n{body[:4000]}"
    _step_finish(step_id, output=output, calls=calls_made, rejected=rejected,
                 wrote=list(dict.fromkeys(wrote)),
                 tokens=(tok_in, tok_out), status=status)
    events.emit(sid, "orchestra_step_end", {
        "type": "orchestra_step_end", "runId": ctx["run_id"], "seq": seq, "role": role,
        "roleName": r["name"], "title": title, "status": status,
        "wrote": wrote, "rejected": rejected}, invocation_id=inv)
    ctx["wrote"].extend(wrote)
    ctx["wrote"] = list(dict.fromkeys(ctx["wrote"]))
    ctx["handoff"] = output
    return output


def _run_finally(sid: int, run_id: int, status: str, ctx: dict, prev_role: str,
                 inv: str, mode: str, t0: float) -> None:
    """一次编排的收尾：落 run 状态 + 补一条"这轮到这儿" + 发 run_end 事件。"""
    from . import agent_runtime as rt
    finish_run(run_id, status, ctx["wrote"])
    if ctx.get("handoff") and status == "done":
        try:
            rt.append_entry(sid, "assistant", [
                {"type": "role", "role": prev_role or "leader",
                 "roleName": (ROLES[prev_role]["name"] if prev_role else "主创"),
                 "title": "收尾", "seq": 999, "final": True},
                {"type": "text", "content": "—— 这轮到此为止。改了：" +
                 ("、".join(ctx["wrote"]) if ctx["wrote"] else "没有落盘（改动会在「改动」里等你确认）")}])
        except events.SessionGone:
            pass
    try:
        events.emit(sid, "orchestra_run_end", {
            "type": "orchestra_run_end", "runId": run_id, "status": status,
            "wrote": ctx["wrote"]}, invocation_id=inv)
    except events.SessionGone:
        pass
    # trace 记的是"跑了多久、停在什么状态"（token 数由各步自己累加），会话没了也不该丢这一条
    try:
        dbm.db().execute(
            "INSERT INTO trace(session_id,invocation_id,slug,provider,model,kind,stop_reason,"
            "input_tokens,output_tokens,cache_read,cache_write,ttft_ms,duration_ms,created_at)"
            " VALUES(?,?,?,?,?,?,?,0,0,0,0,0,?,?)",
            (str(sid), inv, ctx.get("slug") or "",
             (ctx.get("provider") or {}).get("id") if ctx.get("provider") else "",
             ctx.get("mid") or "", "orchestra." + mode, status,
             int((time.time() - t0) * 1000), dbm.now_ms()))
    except Exception:
        pass                     # trace 写不进去（比如会话没了的 FK）不影响这一轮的结论


def _lint_bits(slug: str, path: str) -> str:
    """给 critic 的机器质检命中（规则是纯静态的，本地就能跑，不花模型钱）。"""
    if not path:
        return ""
    try:
        from . import lint as L
        from ..store import read_text
        text = read_text(slug, path)
    except Exception:
        return ""
    if not text.strip():
        return ""
    try:
        report = L.scan(text, path=path, limit=40)
    except Exception as e:
        return f"（质检跑不动：{e}）"
    hits = report.get("hits") or []
    if not hits:
        return "（没有命中）"
    return f"这一章 {len(text)} 字，评分 {report.get('score')}（{report.get('grade')}），命中 {len(hits)} 条：\n" + \
        "\n".join(f"- 第 {h.get('line') or '?'} 行 [{h.get('category')}]「{h.get('text')}」"
                   f"（{h.get('name')}）建议：{h.get('advice')}" for h in hits[:20])


async def run(sid: int, text: str, inv: str, payload: dict, model_key: str = "") -> None:
    """跑一次编排。由 agent_runtime._run 在有 mode 时调进来。"""
    from . import agent_runtime as rt
    from ..llm.providers import provider_of, LLMError

    payload = payload or {}
    mode = str(payload.get("mode") or "execute")
    if mode not in MODES:
        mode = "execute"
    d = dbm.db()
    sess = rt.session_row(sid)
    slug = sess["slug"]
    t0 = time.time()
    mk = model_key or sess["model_key"] or ""
    try:
        provider, mid = provider_of(mk)
    except LLMError as e:
        rt.append_entry(sid, "system", [{"type": "text", "content": f"模型没配好：{e}"}])
        d.execute("UPDATE chat_session SET status='idle' WHERE id=?", (sid,))
        return

    target = _target_path(slug, text, payload)
    run_id = create_run(sid, slug, inv, mode, text, target)
    ctx = {"sid": sid, "slug": slug, "inv": inv, "run_id": run_id, "sess": sess, "mode": mode,
           "stream": payload.get("stream"),   # True=流式 / False=整段出 / None=自动
           "modelKey": mk,                    # 备用模型判据：跟这个不一样才叫备用
           "provider": provider, "mid": mid, "goal": text, "target_path": target,
           "wrote": [], "handoff": "", "lint_bits": ""}
    status = "done"
    prev_role = ""
    # 注意：这一整段（含最开始的"把用户这句话记进对话"）都要包在 SessionGone 的兜底里 ——
    # 打磨实测：把 try 从中间开始，用户刚好在这两步之间删掉会话，异常还是会漏出去。
    try:
        rt.append_entry(sid, "user", [{"type": "text", "content": text}])
        # 单人 / 分工：用户在前端选的（默认分工）。三种干活方式**都能**切成单人。
        _dv = payload.get("divided", True)
        if isinstance(_dv, str):
            _dv = _dv.strip().lower() not in ("0", "false", "no", "off", "")
        steps = steps_for(mode, slug, divided=bool(_dv))   # 分工在这一刻生效（预设有书级覆盖就按书）
        # 「一个人」= 所有棒都戴同一份合并档案（solo.default），而不是各角色各拿一份 ——
        # 用户要的"把那些乱七八糟的预设融到一块，专门给一个人用"。
        ctx["solo"] = (not bool(_dv))
        events.emit(sid, "orchestra_run_start", {
            "type": "orchestra_run_start", "runId": run_id, "mode": mode,
            "modeName": MODES[mode]["name"], "targetPath": target,
            # ⚠ `steps_for()` 从起返回的是**四元组**（多一个"这一棒是不是正文"），
            # 这里却还按三元组解包 → 抛 "too many values to unpack (expected 3)"，
            # 而且是在**发 run_start 的事件里**抛的 → 整轮连第一棒都没跑就结束。
            # 实测（）：用户发一句话 → 库里只有一条 user 条目 + 一条 system「编排出错」，
            # 界面上就是"AI 出不了字"。四元组全解出来，不用的那个用 _ 接。
            "steps": [{"role": r, "roleName": ROLES[r]["name"], "title": t}
                      for r, t, _p, _pr in steps]}, invocation_id=inv)
        for i, (role, title, demand, is_prose) in enumerate(steps, 1):
            if sid in rt.ABORTS:
                status = "aborted"
                break
            step_id = _step_insert(run_id, i, role, title, prev_role,
                                   ctx["handoff"] if prev_role else "")
            if role == "critic":
                ctx["lint_bits"] = _lint_bits(slug, target)
            ctx["handoff"] = await _run_step(ctx, i, role, title, demand, prev_role,
                                             ctx["handoff"], step_id, is_prose)
            prev_role = role
    except events.SessionGone:
        # 用户把对话删了：安静收尾（run 记录里会留 status=aborted），
        # 别再往已删的会话里写 entry —— 那正是这条 bug 的来源。
        status = "aborted"
    except Exception as e:
        status = "error"
        try:
            rt.append_entry(sid, "system", [{"type": "text", "content": f"编排出错：{e}"}])
        except events.SessionGone:
            status = "aborted"
    finally:
        # 收尾这三件事（写"回答"、发 run_end、记 trace）都可能在**会话已被删**的情况下写不进去。
        # 它们失败不影响"这一轮已经结束"这个事实，所以整段兜住：run 记录里 status 已经落好了。
        _run_finally(sid, run_id, status, ctx, prev_role, inv, mode, t0)
