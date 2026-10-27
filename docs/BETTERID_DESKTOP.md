# BetteriD Windows / Linux 桌面端

桌面端是一个 Electron 壳，不启动 BetteriD 的 Rust/Node 服务端：编辑器、预设、NSI、翻译和图标资源随应用打包，OpenStreetMap API、底图和 OAuth 从桌面端直接访问。

## 本地运行

在仓库根目录：

```bash
pnpm install --frozen-lockfile
pnpm run desktop:bundle
pnpm run desktop:start
```

`desktop:bundle` 会生成 `dist-desktop/iD.min.js`，并把预设和 name-suggestion-index 配置为相对路径。应用的 smoke 检查会验证编辑器、地图 SVG、工具栏和桌面桥接均已加载：

```bash
pnpm run desktop:smoke
```

## 打包

```bash
# Windows x64：NSIS 安装包和 portable 包（在 Windows 上执行）
pnpm run desktop:dist:win

# Linux x64：AppImage、deb 和 tar.gz
pnpm run desktop:dist:linux
```

两条命令都会先执行 `desktop:bundle`。它们不会自己构建编辑器资源，所以干净克隆上要先跑一次 `pnpm run all`（CSS、数据、精灵图、`dist/iD.js`），否则 `dist/` 是空的。

生成物位于 `dist-desktop/packages/`：`BetteriD-<version>-linux-x64.AppImage`、`BetteriD-<version>-linux-amd64.deb`、`BetteriD-<version>-linux-x64.tar.gz`（deb 按 Debian 习惯用 amd64 后缀）。`dist-desktop/` 不提交到仓库。

仓库目前没有自动化桌面打包流程，Linux 产物是在本地构建后用 `gh release upload v1.0.0-beta dist-desktop/packages/*` 挂到 release 上的。要改成 CI 打包，把本地那份 `.github/workflows/desktop-linux.yml` 推送上去即可（它会在 `v*` 标签触发，构建上面三个产物并自动上传）——推送 `.github/workflows/` 需要 token 带 `workflow` 权限，`gh auth refresh -s workflow` 可加。

## Linux 安装

- **deb**：`sudo apt install ./BetteriD-<version>-linux-amd64.deb`。apt 会一起装 GTK、NSS 等依赖，并写入桌面菜单项。
- **AppImage**：`chmod +x BetteriD-<version>-linux-x64.AppImage` 后直接运行。AppImage 依赖 FUSE；Ubuntu 26.04 这类不带 libfuse2 的发行版用 `./BetteriD-<version>-linux-x64.AppImage --appimage-extract-and-run`，或者改用 deb / tar.gz。
- **tar.gz**：解压后运行目录里的 `betterid` 可执行文件。AppImage 和 tar.gz 都不会写系统菜单。

启动时报 `The SUID sandbox helper binary was found, but is not configured correctly`，是因为 `chrome-sandbox` 不是 root 拥有、4755 权限（手动解压 tar.gz 时常见）。要么用 deb 安装（postinst 会设好），要么临时用 `--no-sandbox` 启动。

窗口图标取自打包进来的 `build/icon.png`。`desktop/package.json` 里 `desktopName: "betterid.desktop"` 加 `linux.syncDesktopName: true`，`.desktop` 文件名、`StartupWMClass` 和 Electron 的 `app_id` 三者一致（都是 `betterid`），桌面环境才能把运行中的窗口和菜单项对应起来。

## 桌面端没有服务器

- 静态资源通过应用内部的 `betterid://app` scheme 提供，不依赖 localhost HTTP 服务。
- OSM API 使用 `config.json` 中的 `url` / `apiUrl`，编辑请求直接发往 OpenStreetMap。
- OAuth 登录在 Electron popup 内完成；桌面壳在回调导航发生前截获 URL，再通过 `BroadcastChannel` 交给 `osm-auth`。默认回调地址是 `http://127.0.0.1:8080/land.html`，这里不是服务端地址，也不会监听端口。
- 自己注册 OAuth 客户端时，必须把实际回调地址注册为与 `desktop/config.json` 一致的精确值，并在用户配置文件中替换 `client_id`。
- 每个请求带有 `BetteriD-Desktop/<version>` User-Agent。桌面端为底图读取补充 CORS 响应头，使魔棒、快速选择和 AI 描边能够读取允许跨域的影像。

## 配置文件

应用菜单中的 **BetteriD → Open settings file…** 会打开用户配置文件。默认配置来自 `desktop/config.json`，用户配置会覆盖它，通常位于：

- Windows：`%APPDATA%/BetteriD/config.json`
- Linux：`~/.config/BetteriD/config.json`

示例：

```json
{
  "osm": {
    "url": "https://www.openstreetmap.org",
    "apiUrl": "https://api.openstreetmap.org",
    "client_id": "your-public-osm-oauth-client-id",
    "redirect_uri": "http://127.0.0.1:8080/land.html"
  }
}
```

## 自定义 AI 来源

桌面端不会调用 `/api/osm-ai/*`。在编辑器的 **偏好设置 → AI** 中启用 **使用我自己的 AI 来源**，填写：

- OpenAI 兼容 API 的 base URL；
- API key；
- 文本、视觉、生图模型；
- 图片编辑 API 类型：`/images/edits` 或返回图片的 chat completion。

提供了 OpenAI、DeepSeek、Moonshot/Kimi、Gemini、OpenRouter 和本机 Ollama 预设，也可以填写任意兼容来源。API key 存在当前浏览器 origin 的 localStorage 中，只发送到用户填写的 base URL；不会进入仓库、桌面资源包或 BetteriD 服务器。

桌面端支持两种 AI 描边方式：

1. **生图模型，红色描边**：让图片模型保持原图，仅沿建筑/水域等目标画纯红闭合线；客户端检测红线、提取封闭区域并转成 OSM 面。
2. **视觉模型，多边形坐标**：让视觉模型直接返回像素多边形，客户端校验、裁剪和转换坐标。

结果会作为一个撤销步骤加入地图并保持选中。AI 结果只是一组候选几何，上传前必须对照底图检查，不应把模型输出当作事实。
