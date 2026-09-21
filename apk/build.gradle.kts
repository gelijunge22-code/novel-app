// 写作台 App —— 后端（Python）和前端一起打进安装包。
//
// 为什么用 Gradle：手机上要跑 Python 需要 Chaquopy（嵌入式 CPython 运行时），
// 它是个 Gradle 插件（见 docs/决策记录 D10）。以前那套 aapt2+javac+d8 的手工打包
// **只够打一个网页壳**，装不下 Python 运行时和一堆 wheel，所以这一版整体换成 Gradle。
// 版本号仍然只有一个出处：apk/version.txt。

import java.util.Properties

plugins {
    id("com.android.application") version "8.5.2"
    id("com.chaquo.python") version "17.0.0"
}

// ── 版本号：只从 version.txt 读（别在别处再写一份）─────────────────────────────
val versionFile = file("version.txt")
val verCode: Int = versionFile.readLines()
    .first { it.startsWith("versionCode=") }.substringAfter("=").trim().toInt()
val verName: String = versionFile.readLines()
    .first { it.startsWith("versionName=") }.substringAfter("=").trim()

// ── 签名口令：从 keystore.txt 读（那个文件在 .gitignore 里，不进 git）──────────
val ksTxt = file("keystore.txt")
val ksStorePass = providers.environmentVariable("NOVELAPP_KS_PASS").orNull
    ?: ksTxt.takeIf { it.exists() }?.readLines()
        ?.firstOrNull { it.startsWith("storePassword:") }?.substringAfter(":")?.trim()
val ksAlias = providers.environmentVariable("NOVELAPP_KS_ALIAS").orNull
    ?: ksTxt.takeIf { it.exists() }?.readLines()
        ?.firstOrNull { it.startsWith("alias:") }?.substringAfter(":")?.trim() ?: "nbapp"
val ksKeyPass = providers.environmentVariable("NOVELAPP_KS_KEYPASS").orNull ?: ksStorePass

android {
    namespace = "com.nbapp.desk"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.nbapp.desk"
        minSdk = 24
        targetSdk = 34
        versionCode = verCode
        versionName = verName
        // 三种 ABI 都打：
        //   arm64-v8a    现代手机（主流）
        //   armeabi-v7a  32 位老机器/廉价机（用户实测"装不上"就是缺这个）
        //   x86_64       模拟器/少数平板
        // 代价是包更大（每种 ABI 一套 Python 运行时的 .so 和原生 wheel），用户说了"几 GB 都行"。
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
    }

    signingConfigs {
        create("release") {
            if (ksStorePass != null) {
                storeFile = file("keystore.jks")
                storePassword = ksStorePass
                keyAlias = ksAlias
                keyPassword = ksKeyPass
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            isShrinkResources = false
            if (ksStorePass != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    // 沿用原来的目录布局（src/ res/ assets/ AndroidManifest.xml 都在 apk/ 下）
    sourceSets {
        getByName("main") {
            manifest.srcFile("AndroidManifest.xml")
            java.srcDirs("src")
            res.srcDirs("res")
            assets.srcDirs("assets")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    lint { abortOnError = false }

    // Python 运行时要能从解压出来的 lib 目录直接加载，所以走 legacy 打包
    packaging { jniLibs { useLegacyPackaging = true } }
}

chaquopy {
    defaultConfig {
        // 3.11 而不是 3.12：Chaquopy 的 Android wheel 索引里，带 C 扩展的包
        // （aiohttp / multidict / yarl / frozenlist —— 听书那套要用）
        // **没有 cp312 的 armeabi_v7a 轮子**，只有到 cp311 为止。
        // 要同时支持 32 位手机，就只能用 3.11；服务器代码用 3.11 全量编译过，0 个文件不过。
        version = "3.11"
        // 构建期的 Python 必须和上面同版本（Chaquopy 的硬要求）
        buildPython("/home/ubuntu/.local/share/uv/python/cpython-3.11.15-linux-x86_64-gnu/bin/python3.11")
        pip {
            // 依赖全部预先落在 apk/libs/（见 tools/make_apk_libs.py），
            // 这样打包是**可复现**的：不联网也能装出一样的结果。
            options("--find-links", file("libs").absolutePath)
            // `--no-index` 是第 9 遍打磨加的，很要紧：
            //   以前只给 --find-links，pip 还会去 PyPI 挑**更新的**版本 ——
            //   实测装出来的是 fastapi 0.125 / aiohttp 3.10.10 / propcache 这些
            //   我们**没测过**的东西（apk/libs 里钉的那套被绕过去了）。
            //   现在只认 libs：打进包的就是 tools/verify_pkg_stack.py 测过的那一套。
            options("--no-index")
            // 版本一律钉死，和 apk/libs 里的轮子一一对应（改这里也要改 make_apk_libs.py）
            listOf("fastapi==0.115.6", "starlette==0.41.3", "uvicorn==0.32.1", "httpx==0.28.1",
                   "httpcore==1.0.7", "h11==0.14.0", "anyio==4.7.0", "sniffio==1.3.1",
                   "idna==3.10", "certifi==2024.8.30", "click==8.1.7",
                   "typing_extensions==4.12.2", "python-multipart==0.0.20",
                   "edge-tts==7.2.8", "tabulate==0.9.0", "attrs==24.2.0",
                   "aiosignal==1.3.1", "async-timeout==4.0.3",
                   // pydantic 1.x 纯 Python 版：2.x 要编译出来的 pydantic_core，Android 上装不了
                   "pydantic==1.10.18",
                   // 带 C 扩展的（Android 原生轮子，三种 ABI 都有）
                   "aiohttp==3.9.1", "multidict==5.1.0", "yarl==1.9.3", "frozenlist==1.4.0"
            ).forEach { install(it) }
        }
    }
}
