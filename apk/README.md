# 手机写作台 · Android 外壳（前端内嵌）

这个目录把手机网页**整个装进 APK**：界面（HTML/CSS/JS、图标）随包走，断网也能把 App 打开、
读已经缓存过的章节；联网时跟自研后端（`server/`，本机 127.0.0.1:8899）说话。

**不用 Gradle / Android Studio**：`aapt2 + javac + d8 + zipalign + apksigner` 直接打
（这台机器只有 3G 内存，装不动 Android Studio）。工具在 `/home/ubuntu/android-sdk/build-tools/34.0.0/`
—— **不在 PATH 上，脚本里用的是全路径**。

## 一键重新打包

```bash
bash /home/ubuntu/novel-app/apk/build.sh
```

打包脚本干这几件事（幂等，随时可以重跑）：

1. 把 `../frontend/` **整份**复制进 `assets/www/`（先清空再复制：前端只有这一个源头，
   包里的副本不许手改，改前端只改 `frontend/`）；
2. 从 `version.txt` 读版本号，用 `aapt2 link --version-code/--version-name` 写进安装包；
3. 编译 Java → dex → 塞进 APK → zipalign → 签名（v1 JAR + v2，RSA 2048，10 年）；
4. **打完包再从安装包里把版本号读回来校验**，顺手写 `apk-version.json`
   （后端的 `/api/apk/version` 读的就是它）。

产物：

| 文件 | 说明 |
|---|---|
| `手机写作台.apk` | 主产物（中文名） |
| `app-release.apk` | 同一个包的英文名副本（兼容旧下载链接） |
| `apk-version.json` | 版本清单：versionCode/versionName/size/sha256/builtAt |
| `build-report.txt` | 最近一次构建的全过程证据（badging / 签名 / 对齐 / 包内文件清单） |

## 版本号：唯一出处是 `version.txt`

```
versionCode=6
versionName=1.6
```

改版本**只改这一个文件**。为什么这么较真：以前版本号写死在 Java 里一处、清单里一处，
清单升到 1.2 了 Java 还报 1.1 → 关于页**永远**提示「有新版本」，用户升到最新还被告知要更新。
现在三处必须一致，而且有实测脚本卡着：

```bash
bash /home/ubuntu/novel-app/tools/verify_apk.sh
```

它验：`version.txt` == 安装包 `aapt2 dump badging` == `apk-version.json` == 后端 `/api/apk/version`、
前端内嵌文件与 `frontend/` **逐字节一致**、签名/对齐通过、新写的 Java（返回键 `AndroidBack`、
分享 `share`）确实在 `classes.dex` 里。
网页端的「该不该提示更新」另有一把：`node tools/e2e-version.js`（最新时不许提示、旧了必须提示）。

## 目录结构

```
apk/
├── AndroidManifest.xml                  # com.nbapp.desk，minSdk 24 / targetSdk 34，usesCleartextTraffic
├── version.txt                          # 版本号唯一出处
├── build.sh                             # 一键打包（口令从 keystore.txt 读，脚本里不留口令）
├── assets/www/                          # 从 ../frontend/ 复制来的内嵌前端（不进 git，每次重建）
├── assets/error.html                    # 加载失败时的中文错误页
├── src/com/nbapp/desk/MainActivity.java # 外壳：WebView + 内嵌拦截 + 返回键 + 下载安装 + 分享
├── res/                                 # strings/styles/colors/图标
├── tools/gen_icon.py                    # 生成「深棕底白字 文」图标（Pillow）
├── keystore.jks / keystore.txt          # 签名密钥与口令（**不进 git**，见 .gitignore）
└── build/                               # 中间产物（可删，每次重建）
```

## App 行为（跟网页版一致的地方就不重复说了）

- **内嵌前端**：`/`、`/index.html`、`/manifest.webmanifest`、`/icon-*.png`、`/favicon.ico`、
  `/js/*`、`/css/*` 这些请求由外壳直接从 `assets/www/` 返回；其余请求走网络。
  页面 URL 仍然是服务器地址，所以 cookie / localStorage 挂在服务器名下，行为跟浏览器一致
  （登录态不会因为换了个「本地页面」而丢）。
- **断网也能进**：页面加载失败不再直接甩错误页；有离线缓存时照常进书架、能读读过的章节
  （缓存逻辑在 `frontend/js/store.js` 的 `Offline` 里）。
- **返回键逐层退**：`onBackPressed` → 先问网页 `window.AndroidBack()`：
  抽屉 → 弹窗 → 工具详情（文件浏览器里一层目录一层目录地退）→ 工具宫格 → 书架 → 最后才是「再按一次退出」。
  实测：`node tools/e2e-back.js`。
- **App 内下载更新 + 弹安装**：关于/设置里点「下载更新」调 `Android.downloadApk(url, name)`，
  外壳用 `DownloadManager` 下到系统下载目录，下完自动弹安装（`FileProvider` + `REQUEST_INSTALL_PACKAGES`）。
- **分享**：阅读器菜单右上角的分享按钮调 `Android.share(title, text)`，拉起系统「分享到」面板。
  网页里没有这个桥时退回系统分享 API，再不行就复制到剪贴板（点了必须有反馈）。
- **全屏沉浸**：API 30+ 用 `setDecorFitsSystemWindows(false)`，24–29 用 `IMMERSIVE_STICKY`；
  状态栏颜色跟随主题（`Android.setStatusBar(color, 深色图标?)`）。
- **JS 桥**（`window.Android`）：`keepAwake/setKeepAwake`、`getVersion`、`getVersionCode`、`getPlatform`、
  `getServerUrl`、`retry/reload`、`openSettings`、`downloadApk`、`share`、`toast`、`setStatusBar`。
- **服务器地址**：首次启动可填（存 SharedPreferences），设置里随时能改；默认值见
  `MainActivity.DEFAULT_SERVER`（**部署决定**：等自研后端接上公网后改成我们自己的地址）。

## 签名

- package `com.nbapp.desk`；签名 `apksigner --v1-signing-enabled true --v2-signing-enabled true`。
- 密钥 `keystore.jks`、口令 `keystore.txt` **都不进 git**（`.gitignore` 里躺着），
  `build.sh` 从 `keystore.txt` 读口令，也支持用环境变量给（`NOVELAPP_KS_PASS` / `NOVELAPP_KS_KEYPASS`）。
- 升级必须用同一个密钥签名，否则手机不认、装不上；**别丢这两个文件**。

## 安装

```bash
adb install -r /home/ubuntu/novel-app/apk/手机写作台.apk
```

手机需要能访问后端的地址（现在是明文 HTTP，清单里已开 `usesCleartextTraffic`）。
本机没有 KVM，跑不了安卓模拟器；所以「内嵌 + 断网 + 返回键 + 版本提示」这些行为是用
**同一套规则在无头 Chrome 里模拟**验证的（`tools/e2e-offline.js`、`tools/e2e-back.js`、
`tools/e2e-version.js`），真机安装由用户点一下确认即可。
