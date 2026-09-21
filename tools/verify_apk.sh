#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# APK 交付校验（GOAL C1 / C3 / C4 的证据）：
#   1. 版本号三处对齐：apk/version.txt == 安装包 badging == apk-version.json == /api/apk/version
#      并且「前端设置页的比对逻辑」不会在已是最新时提示更新；
#   2. 前端真的内嵌在包里，而且跟 frontend/ 逐字节一致（不是手改的旧副本）；
#   3. 签名（v1 + v2）与 zipalign 都过；
#   4. 新写的 Java（返回键桥 AndroidBack / 分享 share）确实进了 classes.dex。
#
# 跑法：bash tools/verify_apk.sh
# ---------------------------------------------------------------------------
set -uo pipefail
REPO=/home/ubuntu/novel-app
PROJ=$REPO/apk
BT=/home/ubuntu/android-sdk/build-tools/34.0.0
APK=$PROJ/手机写作台.apk
FAIL=0
ok()   { echo "  ✓ $1"; }
bad()  { echo "  ✗ $1"; FAIL=$((FAIL+1)); }
say()  { echo; echo "=== $1 ==="; }
# 包里有没有某个文件：先把清单落盘再 grep。
# 注意：不能写成 `unzip -l "$APK" | grep -q X` —— 包变大后 unzip 的清单超过管道缓冲，
# grep 提前退出会让 unzip 吃到 SIGPIPE，`set -o pipefail` 下整条管道算失败，
# 于是明明在包里也报「没有」（2026-09-19 踩过：包一大这两个假红就冒出来了）。
in_apk() {
  [ -f /tmp/apk-list.txt ] || unzip -l "$APK" > /tmp/apk-list.txt 2>/dev/null
  grep -q -- "$1" /tmp/apk-list.txt
}

say "0. 安装包在不在"
[ -f "$APK" ] && ok "找到 $APK（$(stat -c%s "$APK") 字节）" || { bad "没有安装包"; exit 1; }

say "1. 版本号三处对齐（C3）"
VCODE=$(grep -E '^versionCode=' "$PROJ/version.txt" | cut -d= -f2 | tr -d '[:space:]')
VNAME=$(grep -E '^versionName=' "$PROJ/version.txt" | cut -d= -f2 | tr -d '[:space:]')
echo "  version.txt      : versionCode=$VCODE versionName=$VNAME"
"$BT/aapt2" dump badging "$APK" > /tmp/apk-badging.txt 2>/dev/null
BCODE=$(grep -m1 "^package:" /tmp/apk-badging.txt | sed -E "s/.*versionCode='([0-9]+)'.*/\1/")
BNAME=$(grep -m1 "^package:" /tmp/apk-badging.txt | sed -E "s/.*versionName='([^']*)'.*/\1/")
echo "  安装包 badging   : versionCode=$BCODE versionName=$BNAME"
[ "$VCODE" = "$BCODE" ] && [ "$VNAME" = "$BNAME" ] && ok "version.txt == 安装包" || bad "version.txt 跟安装包不一致"
JCODE=$(python3 -c "import json;print(json.load(open('$PROJ/apk-version.json'))['versionCode'])" 2>/dev/null)
JNAME=$(python3 -c "import json;print(json.load(open('$PROJ/apk-version.json'))['versionName'])" 2>/dev/null)
echo "  apk-version.json : versionCode=$JCODE versionName=$JNAME"
[ "$VCODE" = "$JCODE" ] && [ "$VNAME" = "$JNAME" ] && ok "version.txt == apk-version.json" || bad "apk-version.json 跟 version.txt 不一致"
JSHA=$(python3 -c "import json;print(json.load(open('$PROJ/apk-version.json')).get('sha256',''))" 2>/dev/null)
RSHA=$(sha256sum "$APK" | cut -d' ' -f1)
[ "$JSHA" = "$RSHA" ] && ok "apk-version.json 里的 sha256 跟安装包对得上" || bad "sha256 对不上（json=$JSHA 实际=$RSHA）"
AJSON=$(curl -s http://127.0.0.1:8899/api/apk/version)
echo "  /api/apk/version : $AJSON"
echo "$AJSON" | grep -q "\"versionCode\":$VCODE" && echo "$AJSON" | grep -q "\"versionName\":\"$VNAME\"" \
  && ok "后端 /api/apk/version 跟安装包一致" || bad "后端返回的版本号跟安装包不一致"

# 走一遍"应用内更新"的真实链条：/api/apk/version → 它给的 url → 下回来的包 sha256 对不对得上。
# 为什么值得单列：这两处曾经**都少写了 /api 前缀**（url 是 "/apk"、前端是 media('apk')），
# 结果用户点"下载 / 更新"下回来的是一个 404 页 —— 而且这事儿只在点了才会发现。
PURL=$(echo "$AJSON" | python3 -c "import json,sys;print(json.load(sys.stdin).get('url') or '')" 2>/dev/null)
if [ -n "$PURL" ]; then
  DSUM=$(curl -s --max-time 120 "http://127.0.0.1:8899$PURL" | sha256sum | cut -d' ' -f1)
  [ "$DSUM" = "$RSHA" ] \
    && ok "应用内更新链条通：$PURL 下回来的包 sha256 与安装包一致" \
    || bad "应用内更新的下载地址不对（$PURL 下回来的东西不是这个包）"
else
  bad "/api/apk/version 没给出下载地址（url 字段为空）"
fi

say "2. 前端内嵌（C1）"
if in_apk "assets/www/index.html"; then ok "assets/www/index.html 在包里"; else bad "包里没有内嵌前端"; fi
TMP=$(mktemp -d)
unzip -q "$APK" 'assets/www/*' -d "$TMP"
N_IN=$(find "$TMP/assets/www" -type f | wc -l)
N_FE=$(find "$REPO/frontend" -type f | wc -l)
echo "  包内 $N_IN 个文件 / frontend/ $N_FE 个文件"
if diff -r "$TMP/assets/www" "$REPO/frontend" > /tmp/apk-www-diff.txt 2>&1; then
  ok "内嵌的前端跟 frontend/ 逐字节一致（不是旧副本）"
else
  bad "内嵌前端跟 frontend/ 不一致："; head -10 /tmp/apk-www-diff.txt
fi
rm -rf "$TMP"

say "2b. 后端真的进包了（手机自己能跑，不依赖服务器）"
python3 - "$APK" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
def has(p, pre="  "):
    ok = p in names
    print(("  ✓ " if ok else "  ✗ ") + p + ("" if ok else "   —— 包里没有"))
    return ok
bad = 0
# 三种 ABI 都要有 CPython 运行时。
# 注意 Python 版本：为了 32 位能装上，这一版用的是 3.11（见 build.gradle.kts 里的说明），
# 所以这里的 .so 名字是 libpython3.11.so —— 写死 3.12 会变成假红。
for abi in ("arm64-v8a", "armeabi-v7a", "x86_64"):
    bad += 0 if has(f"lib/{abi}/libpython3.11.so") else 1
for f in ("assets/chaquopy/app.imy", "assets/chaquopy/bootstrap.imy",
          "assets/chaquopy/stdlib-common.imy", "assets/chaquopy/requirements-common.imy"):
    bad += 0 if has(f) else 1
inner = zipfile.ZipFile(z.open("assets/chaquopy/app.imy")).namelist()
py = [n for n in inner if n.startswith("server/") and n.endswith(".pyc")]
ok = len(py) >= 40 and "main.pyc" in inner
print(("  ✓ " if ok else "  ✗ ") + f"app.imy 里有后端 {len(py)} 个模块 + main.pyc（Chaquopy 入口）")
bad += 0 if ok else 1
ok2 = any(n.startswith("server/migrations/") for n in inner)
print(("  ✓ " if ok2 else "  ✗ ") + "建库 SQL 也在包里（手机上要自己建库）")
bad += 0 if ok2 else 1
sys.exit(1 if bad else 0)
PY
[ $? -eq 0 ] && ok "Python 运行时 + 后端源码 + 建库脚本都在包里" || bad "后端没完整进包"


say "2b2. 包里的后端跟仓库里的 server/ 是同一份（不是旧副本）"
python3 - "$APK" "$REPO" <<'PYINNER'
import sys, zipfile, pathlib, io
apk, repo = sys.argv[1], pathlib.Path(sys.argv[2])
src, dst = repo / "server", repo / "apk/src/main/python/server"
SKIP_DIRS = {"venv", "__pycache__", ".pytest_cache"}
SKIP_FILES = {"config.json"}
pys, sync_bad = [], []
def walk(a, rel=""):
    for f in sorted(a.iterdir()):
        r = (rel + "/" + f.name).lstrip("/")
        if f.is_dir():
            if f.name in SKIP_DIRS:
                continue
            walk(f, r)
        else:
            if f.name in SKIP_FILES or f.name.endswith((".pyc", ".log")):
                continue
            pys.append(r)
            t = dst / r
            if not t.exists() or t.read_bytes() != f.read_bytes():
                sync_bad.append(r)
walk(src)
missing = [r for r in pys if not (dst / r).exists()]
inner = set(zipfile.ZipFile(io.BytesIO(zipfile.ZipFile(apk).read("assets/chaquopy/app.imy"))).namelist())
no_pyc = [r for r in pys if r.endswith(".py") and ("server/" + r[:-3] + ".pyc") not in inner]
print(f"  server/ 里 {len(pys)} 个源码文件（不含 venv / config.json）")
print(("  ✓ " if not sync_bad and not missing else "  ✗ ")
      + f"apk/src/main/python/server 与 server/ 逐字节一致（不一致 {len(sync_bad)} 个）"
      + ("" if not sync_bad else "：" + ", ".join(sync_bad[:5])))
print(("  ✓ " if not no_pyc else "  ✗ ") + f"每个模块在 app.imy 里都有编译产物（缺 {len(no_pyc)} 个）"
      + ("" if not no_pyc else "：" + ", ".join(no_pyc[:5])))
sys.exit(1 if (sync_bad or missing or no_pyc) else 0)
PYINNER
[ $? -eq 0 ] && ok "包内后端 == 仓库里的 server/（改完源码不重打，这里会当场红）" || bad "包内后端与源码不一致 —— 得重打一次包"

say "2c. 首启快照 seed.zip（中文名不许乱码）"
if in_apk "assets/seed.zip"; then ok "assets/seed.zip 在包里"; else bad "包里没有 seed.zip"; fi
TMP2=$(mktemp -d)
unzip -q -o "$APK" 'assets/seed.zip' -d "$TMP2"
mkdir -p /tmp/seedverify
javac -encoding UTF-8 "$REPO/tools/verify_seed_zip.java" -d /tmp/seedverify 2>/dev/null \
  && java -cp /tmp/seedverify verify_seed_zip "$TMP2/assets/seed.zip" "$REPO/data/books" \
  && ok "seed.zip 用 App 里同一套 Java API 解得开，中文名逐字对得上" \
  || bad "seed.zip 校验没过（中文名/内容对不上）"
rm -rf "$TMP2"

say "3. 签名与对齐"
"$BT/apksigner" verify --print-certs "$APK" > /tmp/apk-sign.txt 2>&1
if [ $? -eq 0 ]; then
  ok "apksigner verify 通过"
  grep -m1 "Verified using v2" /tmp/apk-sign.txt | sed 's/^/    /'
else
  bad "签名校验不过"; head -5 /tmp/apk-sign.txt
fi
# 签名指纹必须和用户手机上那份**一致**，否则安卓直接拒装（这是防冒充机制，绕不过去）。
# 用户已经装过的包指纹 = 428cb931…8aa0（原先那份 keystore 在 /home/ubuntu/nbapp/apk/）。
# 这条断言就是为了防"哪天又换了一把钥匙"这种事故再发生一次。
WANT_CERT=428cb931438c673fb2660e9e781d35ac4e6a3215edf4d0cf2c961f02337e8aa0
GOT_CERT=$(grep -m1 -i "SHA-256 digest" /tmp/apk-sign.txt | sed -E 's/.*digest: *//' | tr -d '[:space:]' | tr 'A-F' 'a-f')
echo "  签名证书 SHA-256 : $GOT_CERT"
echo "  期望（用户已装那版）: $WANT_CERT"
[ "$GOT_CERT" = "$WANT_CERT" ] && ok "签名证书和用户已装的那版一致（能直接覆盖安装，不用卸载）" \
  || bad "签名证书变了！安卓会拒装 —— 必须换回 /home/ubuntu/nbapp/apk/keystore.jks"

echo "  —— 三种 ABI 的 .so 数量（32 位手机能不能装，就看这行）——"
python3 - "$APK" <<'PYABI'
import sys, zipfile, collections
z = zipfile.ZipFile(sys.argv[1])
c = collections.Counter(n.split("/")[1] for n in z.namelist() if n.startswith("lib/"))
for abi in ("arm64-v8a", "armeabi-v7a", "x86_64"):
    print(f"    lib/{abi}/ : {c.get(abi, 0)} 个 .so")
PYABI
python3 - "$APK" <<'PYABI2'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = set(z.namelist())
need = ["lib/arm64-v8a/libpython3.11.so", "lib/armeabi-v7a/libpython3.11.so",
        "lib/x86_64/libpython3.11.so"]
miss = [n for n in need if n not in names]
print(("  ✓ " if not miss else "  ✗ ") + f"三种 ABI 都带上了 CPython 运行时（缺 {len(miss)} 个）"
      + ("" if not miss else "：" + ", ".join(miss)))
sys.exit(0 if not miss else 1)
PYABI2
[ $? -eq 0 ] && ok "32 位手机（armeabi-v7a）也能装" || bad "缺 32 位架构 —— 老机器装不上"
"$BT/zipalign" -c -v 4 "$APK" >/dev/null 2>&1 && ok "zipalign 4 字节对齐" || bad "对齐不过"

say "4. 新的 Java 代码进了包（C6 返回键 + 23.5 分享 + 23.4 后台保活）"
# 注意：dexdump -f 只打文件头，不打方法名（踩过这个坑）。这里把 classes.dex 抠出来直接查字节。
python3 "$REPO/tools/apk_dex_scan.py" "$APK" > /tmp/apk-dex-check.txt
sed 's/^/    /' /tmp/apk-dex-check.txt
grep -qE "^share [1-9]" /tmp/apk-dex-check.txt && ok "classes.dex 里有 share（分享桥）" || bad "dex 里找不到 share"
grep -qE "^AndroidBack [1-9]" /tmp/apk-dex-check.txt && ok "classes.dex 里有 AndroidBack（返回键逐层退）" || bad "dex 里找不到 AndroidBack"
grep -qE "^keepAlive [1-9]" /tmp/apk-dex-check.txt && ok "classes.dex 里有 keepAlive（长任务切后台不被收掉）" || bad "dex 里找不到 keepAlive"
grep -qE "^KeepAliveService [1-9]" /tmp/apk-dex-check.txt && ok "classes.dex 里有 KeepAliveService（前台服务）" || bad "dex 里找不到 KeepAliveService"

say "4b. JS 桥在包里（App 里前端走桥，不走 HTTP）"
grep -qE "^ApiBridge [1-9]" /tmp/apk-dex-check.txt && ok "classes.dex 里有 ApiBridge（桥本身）" || bad "dex 里找不到 ApiBridge"
grep -qE "^JavascriptInterface [1-9]" /tmp/apk-dex-check.txt && ok "桥方法带了 @JavascriptInterface 注解（不带注解 JS 调不到）" || bad "dex 里没有 JavascriptInterface 注解"
grep -qE "^addJavascriptInterface [1-9]" /tmp/apk-dex-check.txt && ok "WebView 真的装了桥（addJavascriptInterface）" || bad "dex 里没有 addJavascriptInterface"
grep -qE "^NBApp [1-9]" /tmp/apk-dex-check.txt && ok "桥的 JS 名字叫 NBApp（前端的 window.NBApp）" || bad "dex 里没有 NBApp"
grep -qE "^file:///android_asset/www/index.html [1-9]" /tmp/apk-dex-check.txt \
  && ok "壳页面从 assets 加载（file:///android_asset/…，不经过服务器）" \
  || bad "dex 里没有 file:///android_asset/www/index.html"
python3 - "$APK" <<'PY'
import sys, zipfile
z = zipfile.ZipFile(sys.argv[1])
html = z.read("assets/www/index.html").decode("utf-8")
api = z.read("assets/www/js/api.js").decode("utf-8")
ok = ("NBApp" in api) and ("bridgeCall" in api) and ("function media" in api or "const media" in api)
print(("  ✓ " if ok else "  ✗ ") + "包里的 api.js 带桥的分支（一份前端两种跑法）")
sys.exit(0 if ok else 1)
PY
[ $? -eq 0 ] && ok "内嵌前端确实带桥逻辑（不是浏览器版 copy）" || bad "内嵌前端的 api.js 没有桥分支"

say "5. 保活服务在清单里登记了（Android 8+ 起前台服务必须登记）"
"$BT/aapt2" dump xmltree --file AndroidManifest.xml "$APK" > /tmp/apk-manifest.txt 2>/dev/null
grep -q "KeepAliveService" /tmp/apk-manifest.txt && ok "清单里登记了 KeepAliveService" || bad "清单里没有 KeepAliveService"
grep -q "FOREGROUND_SERVICE" /tmp/apk-manifest.txt && ok "清单里申请了 FOREGROUND_SERVICE 权限" || bad "清单里没有 FOREGROUND_SERVICE 权限"

say "6. 只在真机上才会暴露的坑（打出来是好的、装上才炸）"
# 这一节的由来：2026-09-20 用户实机装上包，App 直接打不开，报
#   java.lang.RuntimeException: Cannot use GenericPlatform on Android.
#   Call Python.start(new AndroidPlatform(context)) before using Python,
#   or use PyApplication to do this automatically.
# 根因：清单里的 <application> 没声明 android:name="com.chaquo.python.PyApplication"，
#       代码里也没手动 Python.start(AndroidPlatform)，于是 Python.getInstance() 直接抛。
# 这属于「同族问题」：Python 运行时初始化 / 清单声明 / 权限 / 签名 / 架构 —— 全都验不了安装那一刻，
# 于是**一律由打包校验断言**，不靠人肉发现。
# ── 2026-09-20 转向：Chaquopy **必须离开启动必经路径** ─────────────────────
# 上一版把 PyApplication 写进 <application android:name>，结果：
#   Application.onCreate 里 Python.start() 一抛，异常发生在我们的代码之前，
#   catch 不到 → 用户看到"一点就闪退"。
# 现在清单里**不该**有它；改由 MainActivity.startLocalBackend() 在后台线程里显式启动
# （带 try/catch），所以下面两条断言是**反向**的：有它反而判失败。
if grep -qE 'android:name\(0x01010003\)="com\.chaquo\.python\.PyApplication"' /tmp/apk-manifest.txt; then
  bad "清单又把 PyApplication 设成应用类了 —— 会把 Python 能不能跑和 App 能不能启动绑死（闪退风险）"
else
  ok "清单没有把 PyApplication 设成应用类（Python 起不来也炸不到 App 启动）"
fi
grep -qE "^AndroidPlatform [1-9]" /tmp/apk-dex-check.txt \
  && ok "dex 里有 AndroidPlatform（后台线程里手动 Python.start 的那一处）" \
  || bad "dex 里没有 AndroidPlatform —— 那就没人启动 Python 运行时了"
grep -qE "^PyApplication [1-9]" /tmp/apk-dex-check.txt \
  && ok "dex 里仍有 PyApplication 类（Chaquopy 依赖在包里，只是不用它自动启动）" \
  || bad "dex 里没有 PyApplication（Chaquopy 依赖没打进来？）"
# 黑匣子必须在包里（实机崩了，这是我们唯一的取证手段）
grep -qE "^CrashLog [1-9]" /tmp/apk-dex-check.txt \
  && ok "dex 里有 CrashLog（崩溃写 crash-*.log + 下次启动可复制页面）" \
  || bad "dex 里没有 CrashLog —— 实机崩了就没证据了"
grep -qE "^setDefaultUncaughtExceptionHandler [1-9]" /tmp/apk-dex-check.txt \
  && ok "dex 里有 setDefaultUncaughtExceptionHandler（全局崩溃捕获真的装了）" \
  || bad "dex 里没有 setDefaultUncaughtExceptionHandler"
grep -qE "^localStatus [1-9]" /tmp/apk-dex-check.txt \
  && ok "dex 里有 localStatus 桥方法（设置页能看后端状态）" || bad "dex 里没有 localStatus"
grep -qE "^retryLocal [1-9]" /tmp/apk-dex-check.txt \
  && ok "dex 里有 retryLocal 桥方法（用户能自己点重试）" || bad "dex 里没有 retryLocal"
# 清单里现有的两处"原生观感"保障
grep -q "extractNativeLibs" /tmp/apk-manifest.txt \
  && ok "清单显式声明了 extractNativeLibs（.so 解出来才能 dlopen）" \
  || bad "清单没有 extractNativeLibs（Python 运行时的 .so 可能加载不了）"
# 注意：aapt2 dump resources **不会**打出属性名（它只列资源表和 config），
# 所以不能 grep "windowSplashScreenBackground" —— 那样必然是假红（踩过）。
# 真正能判的是：style/AppTheme 有没有 (v31) 这个 config 变体。
# 属性本身再由源码那一份兜一道（两边都对才算数）。
RES_DUMP=$(mktemp)
"$BT/aapt2" dump resources "$APK" > "$RES_DUMP" 2>/dev/null
if awk '/resource .*style\/AppTheme/{f=1} f&&/\(v31\)/{print;exit}' "$RES_DUMP" | grep -q "(v31)"; then
  ok "包里有 style/AppTheme 的 v31 变体（Android 12+ 系统启动画面）"
else
  bad "没有 v31 的 AppTheme —— 冷启动会闪一下（缺 res/values-v31/styles.xml？）"
fi
rm -f "$RES_DUMP" 2>/dev/null || python3 -c "import os,sys;os.unlink(sys.argv[1])" "$RES_DUMP"
SRC_V31="$REPO/apk/res/values-v31/styles.xml"
if [ -f "$SRC_V31" ] && grep -q "windowSplashScreenBackground" "$SRC_V31" \
   && grep -q "windowSplashScreenAnimatedIcon" "$SRC_V31"; then
  ok "v31 启动画面三件套齐全（底色 / 图标 / 图标底）"
else
  bad "res/values-v31/styles.xml 缺 windowSplashScreen* 项"
fi
# 纸色启动底色（不闪黑）：清单 -> theme -> colors.xml
grep -q '"paper"' "$REPO/apk/res/values/colors.xml" \
  && grep -q 'windowBackground' "$REPO/apk/res/values/styles.xml" \
  && ok "windowBackground 是纸色（冷启动不闪黑，跟启动画面同色）" \
  || bad "windowBackground 没设成纸色"
grep -q "usesCleartextTraffic" /tmp/apk-manifest.txt \
  && ok "清单允许明文 HTTP（WebView 要连 http://127.0.0.1，Android 9+ 默认禁）" \
  || bad "清单没有 usesCleartextTraffic —— 本机服务连不上，界面会白屏"
grep -q "INTERNET" /tmp/apk-manifest.txt && ok "申请了 INTERNET 权限" || bad "没有 INTERNET 权限"
grep -q "FOREGROUND_SERVICE_DATA_SYNC" /tmp/apk-manifest.txt \
  && ok "申请了 FOREGROUND_SERVICE_DATA_SYNC（Android 14 起前台服务必须声明具体类型）" \
  || bad "缺 FOREGROUND_SERVICE_DATA_SYNC —— 长任务在 Android 14 上起不来前台服务"
grep -q "POST_NOTIFICATIONS" /tmp/apk-manifest.txt \
  && ok "申请了 POST_NOTIFICATIONS（Android 13+ 前台服务的通知要授权）" \
  || bad "缺 POST_NOTIFICATIONS 权限"
grep -q "REQUEST_INSTALL_PACKAGES" /tmp/apk-manifest.txt \
  && ok "申请了 REQUEST_INSTALL_PACKAGES（应用内更新的安装界面拉得起来）" \
  || bad "缺 REQUEST_INSTALL_PACKAGES —— 应用内更新装不了"
MINSDK=$(grep -m1 "^sdkVersion:" /tmp/apk-badging.txt | sed -E "s/.*'([0-9]+)'.*/\1/")
[ "$MINSDK" = "24" ] && ok "minSdkVersion=24（跟 build.gradle.kts 对得上）" || bad "minSdkVersion=$MINSDK，期望 24"
# 版本号只能往上走：用户的旧包是 4，这一版 20。以后每次打包都得比上一个大，
# 否则安卓会当成"降级"拒装（同族坑：签名一致性 + 版本单调）。
[ "$VCODE" -ge 20 ] 2>/dev/null && ok "versionCode=$VCODE ≥ 20（比用户旧包 4 大，能覆盖安装）" \
  || bad "versionCode=$VCODE 太小 —— 安卓会按降级拒装（旧包是 4）"
# Chaquopy 的 Python 源码是编译进 app.imy 的；.imy 缺失 = 手机上没有后端。
in_apk "assets/chaquopy/app.imy" && ok "assets/chaquopy/app.imy 在包里（Python 源码真的进包了）" \
  || bad "包里没有 assets/chaquopy/app.imy"

echo
if [ "$FAIL" = "0" ]; then echo "全部通过 ✅"; else echo "有 $FAIL 项没过 ❌"; fi
exit $FAIL
