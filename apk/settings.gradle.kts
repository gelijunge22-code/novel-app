// 单模块工程：这一个模块就是「写作台」App。构建见 build.sh（它先在仓库根目录准备
// python_src/ 与 assets/www/，再调 gradle 打包）。
pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
        google()
    }
}
dependencyResolutionManagement {
    repositories {
        mavenCentral()
        google()
    }
}
rootProject.name = "novelapp"
