# -*- coding: utf-8 -*-
"""预设（类酒馆）：写作人设 / 文风 / 尺度 / 模型参数。

两种作用域（与旧层一致）：
* `scope=global` —— 所有书共用的默认
* `scope=book&slug=<书>` —— 这一本书自己的覆盖（`hasOwn` 表示有没有）

字段形状照旧层实测的那份（前端预设页是通用渲染器，只看 `fields` 结构）。
"""
from __future__ import annotations

import json
import re
import time
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException, Request

from .. import db as dbm
from ..security import current_user
from ..store import P, book_dir, now_ms, read_text, write_text

router = APIRouter(tags=["presets"])

# 内置风格库（我们的资源，放在 server/assets/styles/ 下，随包走）
STYLE_DIR = Path(__file__).resolve().parent.parent / "assets" / "styles"
REF_DIR = Path(__file__).resolve().parent.parent / "assets" / "references"

PROFILES: list[dict] = [
    {
        "profileKey": "writer",
        "name": "正文写作",
        "description": "写正文的那位。这些设置决定它下笔时的口吻、节奏和禁区。",
        "fields": [
            {"path": "customTopSystemPrompt", "component": "textarea",
             "label": "最高优先级置顶提示词", "rows": 6,
             "description": "插在写作提示词最前面，优先级最高；文风、字数等设置都排在它后面。",
             "placeholder": "写入需要长期置顶的指令，例如整体尺度、长期禁写内容。",
             "defaultValue": "你在写小说，不是在写总结。\n- 只写这一章该发生的事，不替读者总结，不在段尾拔高。\n- 不写「他知道，从这一刻起……」这类句子。\n- 人物说话要像人说话：允许停顿、打断、答非所问。\n- 写完就停，不要问「要不要继续」。"},
            {"path": "writingStylePreset", "component": "resource-preset",
             "label": "文风要求",
             "description": "条文式的文风规则（用词、句式、禁用项），作为写作约束注入。",
             "placeholder": "选择默认文风要求", "rows": 3,
             "defaultValue": "强节奏网文.md"},
            {"path": "writingReferencePreset", "component": "resource-preset",
             "label": "参考写法",
             "description": "一段可以拿来对照的范文，用来锚定语感。",
             "placeholder": "选择参考写法", "rows": 3, "defaultValue": "第三人称限制视角.md"},
            {"path": "narrativePerson", "component": "radio",
             "label": "叙事人称",
             "description": "决定视角贴在哪个人身上。",
             "options": [
                 {"value": "third-limited", "label": "第三人称·限制视角", "description": "只写视角人物知道的事"},
                 {"value": "third-omniscient", "label": "第三人称·全知", "description": "叙述者什么都知道"},
                 {"value": "first", "label": "第一人称", "description": "以「我」来叙述"}],
             "defaultValue": "third-limited"},
            {"path": "paragraphRhythm", "component": "textarea",
             "label": "段落节奏",
             "description": "长短句、段落长度的要求，越具体越听话。",
             "placeholder": "例如：对话多、单段不超过五行、动作句用短句", "rows": 3,
             "defaultValue": "- 单段不超过 5 行；对话单独成段。\n- 同一段里不塞两个场景。\n- 每 3~5 段要有一次推进（新信息或新动作），不留纯氛围段。"},
            {"path": "wordCountControl", "component": "radio",
             "label": "单章篇幅",
             "description": "这一章大概写多长。",
             "options": [{"value": "short", "label": "短（2000 字上下）", "description": ""},
                         {"value": "medium", "label": "中（3000~4000 字）", "description": ""},
                         {"value": "long", "label": "长（5000 字以上）", "description": ""}],
             "defaultValue": "medium"},
            {"path": "polishingWorkflow", "component": "textarea",
             "label": "润色流程",
             "description": "写完之后的检查步骤，例如先删水词再对设定。",
             "placeholder": "例如：先删水词与总结句，再核对角色称呼与前文是否一致", "rows": 3,
             "defaultValue": "1. 删水词：「似乎」「仿佛」「不禁」「深深地」这类能删就删。\n2. 删段尾总结：把「他明白了……」「从这一刻起……」删掉。\n3. 核对称呼与时间线：跟前面章节对一遍。\n4. 查重复：同一段里不重复用同一个形容词。"},
            {"path": "adultStylePrompt", "component": "textarea",
             "label": "尺度与禁区",
             "description": "**由作者自己定**。不填就是不额外限制，写手自行把握。",
             "placeholder": "例如：可以写亲密戏与暴力，但有分寸；或写清你自己要的尺度", "rows": 3,
             "defaultValue": ""},
            {"path": "fileChangeAwareness", "component": "radio",
             "label": "改动感知",
             "description": "AI 改过的文件是否需要你确认后才算数。",
             "options": [{"value": "on", "label": "要确认", "description": "改动进「改动」工具等你收"},
                         {"value": "off", "label": "直接用", "description": "改完就算数"}],
             "defaultValue": "on"},
        ],
    },
    {
        "profileKey": "leader.default",
        "name": "主创",
        "description": "总管全书的那位：排大纲、派活、改设定。",
        "fields": [
            {"path": "customTopSystemPrompt", "component": "textarea",
             "label": "最高优先级置顶提示词", "rows": 6,
             "description": "插在它的提示词最前面。", "defaultValue": "你是这本书的主管。\n- 用户跟你商量，你给结论、给选项，不写正文（正文交给写作的那位）。\n- 改设定、改大纲之前先问用户。\n- 用户自己写的条目不许覆盖。"},
            # 第 33 轮：这三项以前是**没人读的死配置**（填了不生效 = 用户说的"儿戏"）。
            # 现在每一项都在 `llm/prompts.py` 的 PROFILE_EXTRA / DELEGATE_ROWS 里有落点，
            # `tools/preset_audit.py` 会挨个核"它到底改了什么"。
            {"path": "planningStyle", "component": "radio",
             "label": "干活方式",
             "description": "这本书的 AI 对话默认用哪种方式（对话页里临时切换以对话页为准）。",
             "options": [{"value": "plan", "label": "先给方案再动手", "description": "重要改动先等你点头"},
                         {"value": "execute", "label": "直接动手", "description": "边做边报，会改稿"},
                         {"value": "discuss", "label": "只出主意", "description": "不碰你的稿子"}],
             "defaultValue": "discuss"},
            {"path": "delegateProse", "component": "radio",
             "label": "正文交给谁",
             "description": "改了它，执行/计划模式里写正文那一棒真换成这个人（可选谁由编排里真有的角色决定）。",
             "options": [{"value": "writer", "label": "写手（默认）", "description": "只写正文，只能改 manuscript/"},
                         {"value": "leader", "label": "主创", "description": "主创自己写，写完后仍会过挑刺"}],
             "defaultValue": "writer"},
            {"path": "delegateRetrieve", "component": "radio",
             "label": "取上下文交给谁",
             "description": "改了它，编排里「取料」那一棒真换成这个人。",
             "options": [{"value": "retriever", "label": "取上下文（默认）", "description": "只找料、写清出处，不改文件"},
                         {"value": "leader", "label": "主创", "description": "主创亲自找料"}],
             "defaultValue": "retriever"},
            {"path": "delegateResearch", "component": "radio",
             "label": "查证交给谁",
             "description": "改了它，编排里「核实事实」那一棒真换成这个人。",
             "options": [{"value": "researcher", "label": "查证（默认）", "description": "核名字/能力/时间线，查不到就直说"},
                         {"value": "leader", "label": "主创", "description": "主创亲自核实"}],
             "defaultValue": "researcher"},
            {"path": "delegatePolicy", "component": "textarea",
             "label": "分工补充说明",
             "description": "这段话会原样写进主创的提示词（是提示词，不是开关；上面的选项才是真改流程）。",
             "rows": 3,
             "placeholder": "例如：感情戏先跟我商量；改人名之前先把受影响的章节列出来",
             "defaultValue": "派活说清楚三件事：要什么、给谁、什么时候要。\n改人名 / 改设定之前，先把受影响的章节列出来给用户看。"},
        ],
    },
    {
        "profileKey": "leader.assets",
        "name": "素材助手",
        "description": "整理设定、素材、人物卡的那位。",
        "fields": [
            {"path": "customTopSystemPrompt", "component": "textarea",
             "label": "最高优先级置顶提示词", "rows": 5,
             "description": "插在它的提示词最前面。", "defaultValue": "你是整理设定与素材的那位。\n- 按人物、地点、物品、事件分类，每条一句话，不展开。\n- 只整理用户给的料，不自己编设定。"},
            {"path": "organizeStyle", "component": "textarea",
             "label": "整理风格",
             "description": "素材怎么分类、怎么命名 —— 只进「素材助手」的提示词（其它角色看不到）。",
             "rows": 3, "defaultValue": "- 分类顺序：人物 → 地点 → 物品 → 事件。\n- 每条格式：名字 —— 一句话说明（写清来自哪一章 / 哪个文件）。\n- 同一个人有多个称呼的合并成一条，别名写在后面。"},
        ],
    },


    {
        "profileKey": "world.engine",
        "name": "世界引擎",
        "description": "维护世界观设定与时间线。这些设置只影响它自己。",
        "fields": [
            {"path": "customTopSystemPrompt", "component": "textarea",
             "label": "最高优先级置顶提示词", "rows": 6,
             "description": "插在它的提示词最前面。", "defaultValue": "你是维护世界设定与时间线的那位。\n- 设定以用户写的为准。\n- 发现正文跟设定不一致时，指出冲突、问用户以哪个为准，不自己改设定。"},
            {"path": "worldRules", "component": "textarea",
             "label": "世界规则",
             "description": "这个世界的硬规则（力量体系、地理、禁忌）—— 只进「世界引擎」的提示词。",
             "rows": 4, "placeholder": "例如：魂力等级不可越级；同一时刻同一人不能在两处",
             "defaultValue": "（这里写这个世界的硬规则，例如：）\n- 力量分级不可越级。\n- 同一时刻，同一个人不能出现在两个地方。\n- 死了的人不能没有解释就复活。"},
        ],
    },
    {
        "profileKey": "researcher",
        "name": "查证",
        "description": "核实名字、称呼、能力、时间线的那位。",
        "fields": [
            {"path": "customTopSystemPrompt", "component": "textarea",
             "label": "最高优先级置顶提示词", "rows": 5,
             "description": "插在它的提示词最前面。", "defaultValue": "你是核实事实的那位。\n- 查得到就给结论；查不到就说「查不到」，不编。\n- 每条结论写清依据：哪一章、哪个文件、还是网上哪一页。"},
            {"path": "researchStyle", "component": "textarea",
             "label": "查证侧重",
             "description": "要它重点核什么 —— 只进「查证」的提示词。",
             "rows": 3, "placeholder": "例如：优先核年份与人名写法；原作设定与同人设定分开列",
             "defaultValue": "- 优先核：人名与称呼、时间线、能力 / 物品的规则。\n-「原作设定」和「这本书自己改的设定」分开列，别混在一起。"},
        ],
    },
    {
        "profileKey": "critic",
        "name": "挑刺",
        "description": "逐条挑毛病的那位（不改文件，只交批注）。",
        "fields": [
            {"path": "customTopSystemPrompt", "component": "textarea",
             "label": "最高优先级置顶提示词", "rows": 5,
             "description": "插在它的提示词最前面。", "defaultValue": "你是挑刺的那位，只交批注，不改文件。\n- 逐条挑，每条要说清「在哪」「改成什么」。\n- 只挑真问题，不为了挑而挑。"},
            {"path": "criticFocus", "component": "textarea",
             "label": "挑刺侧重",
             "description": "要它重点挑什么 —— 只进「挑刺」的提示词。",
             "rows": 3, "placeholder": "例如：先挑人设走样，再挑节奏；不要挑文笔偏好",
             "defaultValue": "按这个顺序挑：\n1. 人设有没有走样（说话方式、行为逻辑）。\n2. 时间线和设定有没有打架。\n3. 有没有 AI 味（比喻堆砌、排比抒怀、段尾总结、空泛形容词）。\n4. 这一段有没有推进剧情。"},
        ],
    },
    {
        "profileKey": "inline.editor",
        "name": "内联改稿",
        "description": "你在正文里圈一段让它改的那位（圈选即改）。",
        "fields": [
            {"path": "customTopSystemPrompt", "component": "textarea",
             "label": "最高优先级置顶提示词", "rows": 5,
             "description": "插在它的提示词最前面。", "defaultValue": "你只改用户圈出来的那一段。\n- 保持原意、原人称、原称呼。\n- 只改这一处，不顺手改上下文。"},
            {"path": "inlineStyle", "component": "textarea",
             "label": "改稿要求",
             "description": "只进「内联改稿」的提示词：改的时候要守什么规矩。",
             "rows": 3, "placeholder": "例如：只改我圈的那几句，不要顺手改上下文；保留原有称呼",
             "defaultValue": "- 先说改了什么（一句话），再给改后的文字。\n- 不重写整章，不解释写作思路。"},
        ],
    },
    {
        "profileKey": "retriever",
        "name": "取上下文",
        "description": "把这一章要用的料找齐的那位。",
        "fields": [
            {"path": "customTopSystemPrompt", "component": "textarea",
             "label": "最高优先级置顶提示词", "rows": 5,
             "description": "插在它的提示词最前面。", "defaultValue": "你是找料的那位。\n- 只找跟这一章相关的，写清出处（哪一章 / 哪个文件）。\n- 不改任何文件。"},
            {"path": "retrieveFocus", "component": "textarea",
             "label": "取料侧重",
             "description": "要它优先找什么 —— 只进「取上下文」的提示词。",
             "rows": 3, "placeholder": "例如：优先找前两章结尾与人物最近状态",
             "defaultValue": "优先找这四样：\n1. 这一章要出场的人物，以及他们最近的状态。\n2. 上一章的结尾（好接着写）。\n3. 还没回收的伏笔。\n4. 跟这一章地点相关的设定。"},
        ],
    },
]

# 顺序 = 预设页上从左到右的标签顺序（只增不减：原来那三页一个没动，后面是补上的真档案）
PROFILE_ORDER = ["writer", "leader.default", "leader.assets",
                 "world.engine", "researcher", "critic", "retriever", "inline.editor"]


def _label_of(text: str, stem: str) -> str:
    """资源名的显示法：先看 front-matter 的 label/title，再看第一个标题行，最后退回文件名。"""
    for line in text.splitlines()[:12]:
        m = re.match(r'^\s*(?:label|title)\s*:\s*"?([^"]+)"?\s*$', line)
        if m:
            return m.group(1).strip()
    for line in text.splitlines():
        if line.strip():
            return line.lstrip("# ").strip() or stem
    return stem


def _style_options() -> list[dict]:
    """内置文风/参考范文（`server/assets/styles`、`server/assets/references`）。"""
    out = [{"key": "", "label": "（不指定）", "content": ""}]
    for d in (STYLE_DIR, REF_DIR):
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.md")):
            try:
                text = f.read_text("utf-8")
            except Exception:
                continue
            out.append({"key": f.name, "label": _label_of(text, f.stem), "content": text})
    return out


def resource_content(slug: str, profile_key: str, key: str) -> str:
    """把预设里选的资源 key 变成**正文**。

    以前 `build_system` 直接把 key 当成内容塞进提示词（写作人设里就会出现一行
    「文风：克制白描.md」），等于选了没用。查找顺序：
      1. 书里那份（`<书>/agents/<档案>/<key>`，用户在手机上改过的以这份为准）
      2. 书里按老习惯放的两处（`<书>/agents/<档案>/styles|references/<文件名>`）
      3. 内置资源（`server/assets/styles|references/<文件名>`）
    找不到就返回空串，调用方自己决定退回什么。
    """
    key = (key or "").strip().replace("\\", "/")
    if not key or slug == "" and profile_key == "":
        return ""
    cands: list[Path] = []
    base = key.lstrip("/")
    name = base.rsplit("/", 1)[-1]
    if slug:
        try:
            home = book_dir(slug) / "agents" / (profile_key or DEFAULT_PROFILE)
            cands += [home / base, home / name, home / "styles" / name,
                      home / "references" / name]
            b = book_dir(slug)
            cands += [b / base, b / name]
        except Exception:
            # 这本书没有对应目录（新书 / 没买过这类资源）→ 继续试全局那两个候选路径。
            pass
    cands += [STYLE_DIR / name, REF_DIR / name]
    for p in cands:
        try:
            if p.is_file():
                return p.read_text("utf-8")
        except Exception:
            continue
    return ""


DEFAULT_PROFILE = "writer"


def _home_of(slug: str, profile_key: str):
    try:
        return book_dir(slug) / "agents" / (profile_key or DEFAULT_PROFILE)
    except Exception:
        return None


def write_profile_resources(slug: str, profile_key: str, values: dict) -> list[str]:
    """把这次选的文风/参考范文复制一份到书里（`<书>/agents/<档案>/`）。

    这是老平台的行为（选了就把资源落进书里），好处是：AI 用 read_file 也读得到，
    文件浏览器里能看见；**已存在的同名文件不动**（用户自己改过的那份优先）。
    """
    written: list[str] = []
    home = _home_of(slug, profile_key)
    if not home:
        return written
    for f in next((p["fields"] for p in PROFILES if p["profileKey"] == profile_key), []):
        if f.get("component") != "resource-preset":
            continue
        key = str(values.get(f["path"]) or "").strip()
        if not key:
            continue
        body = resource_content(slug, profile_key, key)
        if not body:
            continue
        rel = key.replace("\\", "/").lstrip("/")
        if "/" not in rel:
            rel = ("styles/" if f["path"] == "writingStylePreset" else "references/") + rel
        dst = home / rel
        try:
            if dst.exists():
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text(body, encoding="utf-8")
            written.append(rel)
        except Exception:
            continue
    return written


def _tpl_field(f: dict, values: dict) -> dict:
    c = f.get("component") or "text"
    out = {"path": f.get("path"), "component": c,
           "label": f.get("label") or f.get("path"),
           "description": f.get("description") or "",
           "placeholder": f.get("placeholder") or "",
           "rows": f.get("rows") or 3,
           "defaultValue": f.get("defaultValue")}
    if c == "resource-preset":
        opts = _style_options()
        cur = values.get(f["path"]) or f.get("defaultValue") or ""
        out["options"] = [{"value": o["key"], "label": o["label"]} for o in opts]
        out["current"] = cur
        out["editable"] = True
    elif c in ("radio", "select"):
        out["options"] = [{"value": o.get("value"), "label": o.get("label"),
                           "description": o.get("description") or ""}
                          for o in (f.get("options") or [])]
    return out


def _saved(scope: str, slug: str) -> dict[str, dict]:
    rows = dbm.db().query("SELECT * FROM preset WHERE scope=? AND slug=?", (scope, slug))
    return {r["profile_key"]: r for r in rows}


def _values_for(profile_key: str, scope: str, slug: str) -> dict:
    prof = next((p for p in PROFILES if p["profileKey"] == profile_key), None)
    base = {f["path"]: f.get("defaultValue") for f in (prof or {}).get("fields", [])}
    if scope == "book" and slug:
        g = _saved("global", "")
        if profile_key in g:
            base.update(dbm.db().jloads(g[profile_key]["values_json"], {}))
    own = _saved(scope, slug)
    if profile_key in own:
        base.update(dbm.db().jloads(own[profile_key]["values_json"], {}))
    return base


def _model_for(profile_key: str, scope: str, slug: str) -> dict:
    own = _saved(scope, slug)
    rec = own.get(profile_key)
    if rec:
        m = dbm.db().jloads(rec["model_json"], {})
        if m:
            return _norm_model(m)
    if scope == "book" and slug:
        g = _saved("global", "")
        if profile_key in g:
            m = dbm.db().jloads(g[profile_key]["model_json"], {})
            if m:
                return _norm_model(m)
    return _norm_model({})


def _norm_model(m: dict) -> dict:
    return {"modelKey": m.get("modelKey"), "temperature": m.get("temperature"),
            "topK": m.get("topK"), "reasoningEffort": m.get("reasoningEffort") or "medium",
            "stream": m.get("stream", True)}


def _landing(path: str) -> dict:
    """预设项 → {kind, what}。读不到就返回空（判据会把"没落点"的项报红）。"""
    try:
        from ..llm.prompts import PRESET_LANDING
        kind, what = PRESET_LANDING.get(path, ("", ""))
        return {"kind": kind, "what": what}
    except Exception:
        return {"kind": "", "what": ""}


def build_presets(scope: str = "global", slug: str = "") -> dict:
    from .books import model_options
    scope = "book" if (scope == "project" or scope == "book") else "global"
    slug = slug if scope == "book" else ""
    profiles = []
    for p in PROFILES:
        key = p["profileKey"]
        values = _values_for(key, scope, slug)
        profiles.append({
            "profileKey": key, "name": p["name"],
            # landing：这一项改的到底是什么（提示词 / 流程 / 开关）。从 prompts.PRESET_LANDING
            # 读，**同一份出处** —— 界面上的标注和判据核的是同一个表。
            "fields": [dict(_tpl_field(f, values),
                            landing=_landing(f["path"])) for f in p["fields"]],
            "values": values,
            "model": _model_for(key, scope, slug),
            "issues": [],
        })
    order = {k: i for i, k in enumerate(PROFILE_ORDER)}
    profiles.sort(key=lambda x: order.get(x["profileKey"], 99))
    md = dbm.db().scalar("SELECT value_json FROM setting WHERE key='models.default'")
    return {"profiles": profiles,
            "models": model_options()["models"],
            "modelDefaults": _norm_model({"modelKey": md.strip('"') if md else None,
                                          "stream": True}),
            "scope": scope, "slug": slug,
            "hasOwn": bool(_saved("book", slug)) if slug else False}


@router.get("/presets")
async def presets(request: Request, scope: str = "global", slug: str = ""):
    current_user(request)
    return build_presets(scope, slug)


@router.post("/presets/save")
async def preset_save(request: Request, payload: dict = Body(...)):
    current_user(request)
    key = payload.get("profileKey")
    if not key or key not in {p["profileKey"] for p in PROFILES}:
        raise HTTPException(400, "缺少或不认识的 profileKey")
    scope = "book" if (payload.get("scope") in ("project", "book")) else "global"
    slug = (payload.get("slug") or "") if scope == "book" else ""
    if scope == "book":
        from .books import require_book
        require_book(slug)
    values = payload.get("values") or {}
    model = payload.get("model") or {}
    d = dbm.db()
    d.execute(
        "INSERT INTO preset(scope,slug,profile_key,values_json,model_json,updated_at)"
        " VALUES(?,?,?,?,?,?) ON CONFLICT(scope,slug,profile_key) DO UPDATE SET"
        " values_json=excluded.values_json, model_json=excluded.model_json,"
        " updated_at=excluded.updated_at",
        (scope, slug, key, d.jdumps(values), d.jdumps(model), now_ms()))
    wrote = write_profile_resources(slug, key, values) if slug else []
    return {"ok": True, "profileKey": key, "scope": scope, "slug": slug,
            "resourcesWritten": wrote}


@router.post("/presets/reset")
async def preset_reset(request: Request, payload: dict = Body(...)):
    """把这本书的独立设定删掉，让它重新跟着全局走（先留一份备份，手滑能捞回来）。"""
    current_user(request)
    slug = (payload.get("slug") or "").strip()
    if not slug:
        raise HTTPException(400, "缺少 slug")
    from .books import require_book
    s = require_book(slug)
    rows = dbm.db().query("SELECT * FROM preset WHERE scope='book' AND slug=?", (s,))
    if not rows:
        return {"ok": True, "removed": False}
    bak = P.data / "trash" / f"preset-{s}-{int(time.time())}.json"
    bak.parent.mkdir(parents=True, exist_ok=True)
    bak.write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    dbm.db().execute("DELETE FROM preset WHERE scope='book' AND slug=?", (s,))
    return {"ok": True, "removed": True, "backup": bak.name}


@router.get("/presets/resource")
async def preset_resource(request: Request, profileKey: str, path: str = "",
                          key: str = "", scope: str = "global", slug: str = ""):
    """看某条文风/参考预设的正文（只读预览）。"""
    current_user(request)
    want = key or path
    if not want:
        raise HTTPException(400, "缺少 key")
    for o in _style_options():
        if o["key"] == want:
            return {"key": o["key"], "label": o["label"], "content": o["content"], "editable": True}
    raise HTTPException(404, want + "：没找到这条预设资源（可能还没选，或者资源被删了）")
