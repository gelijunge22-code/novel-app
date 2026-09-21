# -*- coding: utf-8 -*-
"""参考书架收图片 / 文件 —— 后端这一层按真实路径自测（不碰用户的数据：用一本临时书）。

为什么单独一个脚本：这条是用户点名的功能（"发一张图告诉 AI 这个人的感觉该怎么写"），
必须机器可判：传进去 → 列表里有 → 能读回来（字节一致）→ 能删（连磁盘一起）→ 提示词里带说明。
"""
from __future__ import annotations
import io, json, os, sys, struct, zlib, pathlib, time
import httpx

BASE = "http://127.0.0.1:8899"
ROOT = pathlib.Path(__file__).resolve().parent.parent
cli = httpx.Client(base_url=BASE, timeout=60.0)
FAKE = os.environ.get("USERPROFILE_PASSWORD") or ""

def password() -> str:
    for p in (pathlib.Path("/home/ubuntu/nbapp/config.json"), ROOT / "server" / "config.json"):
        try:
            d = json.loads(p.read_text("utf-8"))
            if d.get("app_password"):
                return str(d["app_password"])
        except Exception:
            pass
    return ""

results: list[dict] = []
def check(name: str, ok: bool, detail=None):
    results.append({"name": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name + ("" if detail is None else "  " + json.dumps(detail, ensure_ascii=False)[:300]))

def png(w=40, h=30, rgb=(200, 40, 40)) -> bytes:
    """手搓一张真 PNG（不依赖 Pillow）：纯色，足够验"能不能原样取回"。"""
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw))
            + chunk(b"IEND", b""))

def main() -> int:
    pw = password()
    if not pw:
        print("读不到口令"); return 2
    r = cli.post("/api/app/login", json={"password": pw})
    if r.status_code != 200:
        print("登录失败", r.status_code, r.text[:200]); return 2

    # 用一本**临时书**（不碰用户那本）：建 -> 传 -> 读回 -> 删（最后连着临时书一起清掉）
    slug = "refs-upload-selftest-" + str(int(time.time()))
    r = cli.post("/api/book", json={"title": "参考图片自测(临时)"})
    check("建临时书成功", r.status_code == 200, {"code": r.status_code, "body": r.text[:160]})
    if r.status_code != 200:
        print("建不出临时书，后面没法测"); return 1
    slug = r.json().get("slug") or slug          # 后端的 slug 是自己从书名生成的，以它为准
    bookdir = ROOT / "data" / "books" / slug

    try:
        img1, img2 = png(rgb=(200, 40, 40)), png(rgb=(30, 90, 210))
        files = [("files", ("人物参考图.png", img1, "image/png")),
                 ("files", ("2.jpg", img2, "image/jpeg"))]        # 第二个故意骗人的扩展名
        data = {"slug": slug, "title": "林诺的感觉", "tags": "人物,氛围", "note": "眼神要倔，肩有点塌。"}
        r = cli.post("/api/refs/upload", data=data, files=files)
        check("上传 2 张图 → 200", r.status_code == 200, {"code": r.status_code, "body": r.text[:200]})
        up = r.json() if r.status_code == 200 else {}
        check("回话里说收了 2 个", up.get("count") == 2, up.get("items"))
        ids = [it["id"] for it in up.get("items", [])]
        kinds = {it["kind"] for it in up.get("items", [])}
        check("两条都认成图片（kind=image）", kinds == {"image"}, sorted(kinds))

        r = cli.get("/api/refs", params={"slug": slug})
        items = r.json().get("items", [])
        check("列表里出现了这 2 条", len(items) == 2, [i["title"] for i in items])
        check("列表里带了 hasFile / mime（前端才知道要显示图）",
              all(i.get("hasFile") and i.get("mime", "").startswith("image/") for i in items),
              [(i["hasFile"], i["mime"]) for i in items])
        check("说明文字存下来了（这就是以后进提示词的东西）",
              all("眼神要倔" in (i["preview"] or "") for i in items), [i["preview"][:40] for i in items])
        check("标签也存了", all("人物" in (i["tags"] or []) for i in items), [i["tags"] for i in items])

        # 取回：字节必须一致（判据要能报红：故意拿另一张的 id 来比）
        r1 = cli.get("/api/refs/file", params={"slug": slug, "id": ids[0]})
        r2 = cli.get("/api/refs/file", params={"slug": slug, "id": ids[1]})
        check("取回第 1 张：200 + image/png", r1.status_code == 200 and r1.headers.get("content-type", "").startswith("image/png"),
              {"code": r1.status_code, "ct": r1.headers.get("content-type"), "n": len(r1.content)})
        check("取回的字节和传进去的一模一样", r1.content == img1, {"got": len(r1.content), "want": len(img1)})
        check("两张不是同一张（判据不是空判据）", r1.content != r2.content, {"n1": len(r1.content), "n2": len(r2.content)})

        # 文字类文件
        r = cli.post("/api/refs/upload",
                     data={"slug": slug, "note": "这段节奏要学", "tags": "写法"},
                     files=[("files", ("范文.md", "# 片段\n他抬头看了眼天。".encode("utf-8"), "text/markdown"))])
        check("传一个 .md → 认成 file 类", r.status_code == 200 and r.json()["items"][0]["kind"] == "file",
              {"code": r.status_code, "items": r.json().get("items")})
        md_id = r.json()["items"][0]["id"]
        r = cli.get("/api/refs/file", params={"slug": slug, "id": md_id})
        check("取回 .md：内容对", r.status_code == 200 and "他抬头看了眼天" in r.content.decode("utf-8"),
              {"code": r.status_code, "ct": r.headers.get("content-type")})

        # 不认的类型必须明说（不静默收下）
        r = cli.post("/api/refs/upload", data={"slug": slug},
                     files=[("files", ("病毒.exe", b"MZ\x90\x00", "application/octet-stream"))])
        check("不认的扩展名 → 400 且说人话", r.status_code == 400 and "认不出" in r.text,
              {"code": r.status_code, "body": r.text[:120]})
        # 一次超过 6 个
        many = [("files", (f"x{i}.png", img1, "image/png")) for i in range(7)]
        r = cli.post("/api/refs/upload", data={"slug": slug}, files=many)
        check("一次 7 个 → 400（上限 6）", r.status_code == 400, {"code": r.status_code})

        # 提示词里到底带了什么（这条最要紧：图片进上下文的是"说明文字 + 文件名"）
        r = cli.post("/api/write/preview", json={"slug": slug, "mode": "chapter", "refs": [ids[0]]})
        ctx = json.dumps(r.json(), ensure_ascii=False) if r.status_code == 200 else ""
        check("写作上下文里带上了这张图的说明", "眼神要倔" in ctx and "参考图" in ctx,
              {"code": r.status_code, "hit": ("眼神要倔" in ctx), "refTag": ("【参考图】" in ctx)})

        # 删：库里的行 + 磁盘上的文件，一起
        before = list((bookdir / ".novel" / "refs").glob("*")) if (bookdir / ".novel" / "refs").is_dir() else []
        r = cli.delete("/api/refs/item", params={"slug": slug, "id": ids[0]})
        after = list((bookdir / ".novel" / "refs").glob("*"))
        check("删一条 → 200 且回话里说删了文件", r.status_code == 200 and r.json().get("fileRemoved"),
              {"code": r.status_code, "body": r.text[:160]})
        check("磁盘上的文件真的少了 1 个", len(after) == len(before) - 1, {"before": len(before), "after": len(after)})
        r = cli.get("/api/refs", params={"slug": slug})
        check("删过之后列表剩 2 条（2 张图 + 1 个 md 里删掉 1）", r.json().get("count") == 2, r.json().get("count"))

        # 越权：另一本书的 id 拿不到这本书的文件
        r = cli.get("/api/refs/file", params={"slug": slug, "id": 999999})
        check("不存在的 id → 404 说人话", r.status_code == 404 and "没有文件" in r.text,
              {"code": r.status_code, "body": r.text[:80]})
    finally:
        try:
            cli.post("/api/book/delete", json={"slug": slug})
        except Exception:
            pass

    fails = [r for r in results if not r["ok"]]
    out = {"at": time.strftime("%Y-%m-%d %H:%M:%S"), "total": len(results),
           "passed": len(results) - len(fails), "fails": fails, "steps": results}
    (ROOT / "docs" / "参考图片实测.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), "utf-8")
    print(f"\n{len(results) - len(fails)}/{len(results)} 通过 → docs/参考图片实测.json")
    return 0 if not fails else 1

if __name__ == "__main__":
    sys.exit(main())
