# MoeKoe 桌面封面轮播(Windows)

一个 MoeKoe Music 桌面封面轮播插件。

## 环境要求

- Windows
- MoeKoe Music `1.6.5` 或更高版本
- MoeKoe Music 插件系统可用

## 安装

### 方式一：软件内自动安装

1. 打开 `设置 -> 插件管理`
2. 切换到 `插件市场`
3. 搜索本插件并点击 `安装`
4. 安装完成后刷新插件列表或重启应用

### 方式二：手动安装

1. 下载本插件源码或发布包
2. 将插件文件夹放入 MoeKoe 插件目录 `plugins/extensions`
3. 打开 `设置 -> 插件管理`
4. 刷新插件列表

## 使用

1. 在插件管理页启用 `MoeKoe 桌面封面轮播`
2. 授权本插件的本地程序 `desktop-cover-carousel`
3. 播放在线歌曲
4. 插件会自动监听 `current_song` 变化，并根据歌曲 `hash` 拉取封面图片开始桌面轮播
5. 点击插件弹窗可以调整轮播间隔、淡入时间、显示方式、最大图片数量和随机顺序

本地歌曲或没有有效 `hash` 的歌曲不会请求封面数据，插件会保留上一首已经显示的桌面背景。

## 构建 native host

native host 源码位于 `src/Program.cs`。

```powershell
powershell -ExecutionPolicy Bypass -File .\src\build.ps1
```

生成文件：

```text
bin\DesktopCoverCarousel.exe
```

## 目录结构

```text
moekoe-desktop-carousel/
  manifest.json              插件清单
  background.js              插件后台消息转发
  song-watcher.js            主界面 current_song 监听脚本
  native-bridge.html         隐藏桥接页
  native-bridge.js           封面请求和 native host 指令桥接
  popup.html                 插件弹窗
  popup.css                  弹窗样式
  popup.js                   弹窗交互
  README.md                  插件说明
  bin/
    DesktopCoverCarousel.exe Windows native host
  src/
    Program.cs               native host 源码
    build.ps1                native host 编译脚本
```
