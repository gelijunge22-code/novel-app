#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# 写作台 App —— 打包脚本（Gradle + Chaquopy）。
#
#   bash apk/build.sh            # 正常打包
#   SEED=0 bash apk/build.sh     # 不带书稿快照（不想把稿子放进安装包时用）
#
# 这一版和以前那版（aapt2 + javac + d8 手工打包）的区别，就一件事：
# **后端也进包**。手机上要跑 Python，需要 Chaquopy 的嵌入式 CPython 运行时，
# 它是个 Gradle 插件，所以整体换成 Gradle（理由见 docs/决策记录 D10）。
#
# 脚本干的事：
#   1. frontend/        → assets/www/            （前端内嵌，逐字节一致）
#   2. server/          → src/main/python/server （后端源码进包，手机上直接跑）
#   3. data/books/      → assets/seed.zip       （首启快照：手机断网也有书可看；打成 zip 是为了中文名不出乱码）
#   4. gradle assembleRelease → 复制成 手机写作台.apk，写 apk-version.json
#   5. 从**打好的包**里把版本号读回来，和 version.txt 对一遍（版本号唯一出处）
# ---------------------------------------------------------------------------
set -euo pipefail

export JAVA_HOME=${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}
export ANDROID_HOME=${ANDROID_HOME:-/home/ubuntu/android-sdk}
export PATH="$JAVA_HOME/bin:$PATH"

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)   # 跟着脚本走：clone 到哪都行，不写死路径
PROJ=$REPO/apk
GRADLE=${GRADLE:-/home/ubuntu/gradle-8.7/bin/gradle}
BT=$ANDROID_HOME/build-tools/34.0.0
# 别人 clone 下来没有 local.properties（它不该进 git）：按 ANDROID_HOME 现写一份
[ -f "$PROJ/local.properties" ] || echo "sdk.dir=$ANDROID_HOME" > "$PROJ/local.properties"
[ -x "$GRADLE" ] || { echo "找不到 gradle：$GRADLE（设 GRADLE= 指定）" >&2; exit 1; }

VERSION_FILE=$PROJ/version.txt
VER_CODE=$(grep -E '^versionCode=' "$VERSION_FILE" | cut -d= -f2 | tr -d '[:space:]')
VER_NAME=$(grep -E '^versionName=' "$VERSION_FILE" | cut -d= -f2- | tr -d '[:space:]')
[ -n "$VER_CODE" ] && [ -n "$VER_NAME" ] || { echo "version.txt 里读不到版本号" >&2; exit 1; }

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

log "0/5 准备（版本 $VER_NAME / $VER_CODE）"
mkdir -p "$PROJ/assets" "$PROJ/src/main/python" "$PROJ/libs"

# --- 1/2. 前端与后端源码（唯一出处：tools/sync_pkg.py，测试前也调它）--------
log "1/5 前端 → assets/www · 后端 → src/main/python/server"
python3 "$REPO/tools/sync_pkg.py"

# --- 3. 书稿快照 -----------------------------------------------------------
if [ "${SEED:-1}" = "1" ] && [ -d "$REPO/data/books" ]; then
  log "3/5 书稿快照 → assets/seed.zip（首启用；只铺一次，不覆盖手机上的新稿）"
  # 为什么打成 zip：书名/章节名全是中文，而 aapt2 打进 assets 的中文名**不带 UTF-8 标记**，
  # 读出来对不对要看系统实现怎么猜。自己打 zip（UTF-8 标记写死正确）+ App 里显式按 UTF-8 解码，
  # 这条路没有猜的成分；顺带首启少拷几百次文件。验证见 tools/verify_seed_zip.java。
  python3 - "$REPO/data/books" "$PROJ/assets/seed.zip" <<'PY'
import shutil, sys, zipfile
from pathlib import Path
src, dst = Path(sys.argv[1]), Path(sys.argv[2])
if dst.exists():
    dst.unlink()
d = dst.parent
if (d / "seed").exists():
    shutil.rmtree(d / "seed")          # 老布局清掉，免得两份快照并存
n = 0
books = [p for p in sorted(src.iterdir()) if p.is_dir()]
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:
    for book in books:
        for f in sorted(book.rglob("*")):
            if f.is_file():
                z.write(f, str(f.relative_to(src)))
                n += 1
print(f"   {n} 个文件 → seed.zip（{dst.stat().st_size} 字节，{len(books)} 本书）")
PY
else
  log "3/5 跳过书稿快照（SEED=0）"
  rm -f "$PROJ/assets/seed.zip"
  rm -rf "$PROJ/assets/seed"
fi

# --- 4. Gradle 打包 --------------------------------------------------------
log "4/5 gradle assembleRelease"
(cd "$PROJ" && "$GRADLE" -q assembleRelease --console=plain)
RAW=$PROJ/build/outputs/apk/release/novelapp-release.apk
[ -f "$RAW" ] || { echo "没打出 APK：$RAW" >&2; exit 1; }
cp -f "$RAW" "$PROJ/app-release.apk"
cp -f "$RAW" "$PROJ/手机写作台.apk"

# 打完立刻把 Gradle 守护进程收掉。
# 为什么：这台机器只有 3.6G 内存，Gradle 守护进程常驻能吃到 900MB，
# 会把系统的 OOM 杀手招来（真发生过：网关被 SIGKILL，用户断线）。
# gradle.properties 里已经设了 idletimeout=120000 自动退出，这里再主动收一次，
# 保证"打完包 = 内存还回去"。别把这行删了。
(cd "$PROJ" && "$GRADLE" -q --stop >/dev/null 2>&1 || true)

# --- 5. 版本校验 + 报告 ----------------------------------------------------
log "5/5 从打好的包里读回版本号并核对"
# 注意：这里不能用 `aapt2 ... | head -1` —— set -o pipefail 会把 aapt2 的 SIGPIPE 当失败，
# 整脚本会以 141 静默退出（2026-09-19 真踩过：包打好了，报告却还是上一版的）。先全读进来再取第一行。
BADGING_ALL=$("$BT/aapt2" dump badging "$RAW" 2>/dev/null || true)
BADGING=${BADGING_ALL%%$'\n'*}
PKG_CODE=$(printf '%s' "$BADGING" | sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p")
PKG_NAME=$(printf '%s' "$BADGING" | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")
if [ "$PKG_CODE" != "$VER_CODE" ] || [ "$PKG_NAME" != "$VER_NAME" ]; then
  echo "版本号对不上：version.txt=$VER_NAME/$VER_CODE 包里=$PKG_NAME/$PKG_CODE" >&2
  exit 1
fi
SIZE=$(stat -c%s "$RAW")
SHA=$(sha256sum "$RAW" | cut -d' ' -f1)
BUILT=$(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S %Z')
cat > "$PROJ/apk-version.json" <<JSON
{
  "versionCode": $VER_CODE,
  "versionName": "$VER_NAME",
  "size": $SIZE,
  "sha256": "$SHA",
  "builtAt": "$BUILT",
  "file": "手机写作台.apk"
}
JSON
{
  echo "打包报告 · $BUILT"
  echo "版本：versionName=$VER_NAME versionCode=$VER_CODE（version.txt 唯一出处，已从包里读回核对）"
  echo "文件：$PROJ/手机写作台.apk（$SIZE 字节）"
  echo "sha256：$SHA"
  echo "内嵌：前端 $(find "$PROJ/assets/www" -type f | wc -l) 个文件 · 后端 $(find "$PROJ/src/main/python/server" -name '*.py' | wc -l) 个 .py"
  if [ -f "$PROJ/assets/seed.zip" ]; then
    echo "快照：seed.zip $(stat -c%s "$PROJ/assets/seed.zip") 字节（首启解一次，只补缺不覆盖）"
  fi
  # 别把 Python 版本写死在这里：上一版是 3.12，这版为了 32 位降到 3.11，
  # 报告里还印着 3.12（第 9 遍自查抓到的"报告在骗人"）。直接从包里读出来。
  echo "Python 运行时：$(unzip -l "$RAW" | sed -n 's#.*lib/\([^/]*\)/libpython[0-9.]*\.so#\1#p' | tr '\n' ' ')（$(unzip -l "$RAW" | sed -n 's#.*lib/.*/\(libpython[0-9.]*\.so\)#\1#p' | head -1)）"
} | tee "$PROJ/build-report.txt"
echo
echo "OK：$PROJ/手机写作台.apk"
