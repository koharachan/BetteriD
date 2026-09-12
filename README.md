# BetteriD

[![Build](https://github.com/koharachan/BetteriD/actions/workflows/build.yml/badge.svg?branch=release)](https://github.com/koharachan/BetteriD/actions/workflows/build.yml)
[![GitHub release](https://img.shields.io/github/v/release/koharachan/BetteriD)](https://github.com/koharachan/BetteriD/releases)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE.md)

BetteriD 是面向中文 OpenStreetMap 编辑场景的网页编辑器，基于
[iD](https://github.com/openstreetmap/iD) 开发。它保留 iD 的编辑工作流，补充中文本地化、
多语言名称、AI 辅助、移动端交互和可自托管的 Rust 同源代理。

- 在线使用：[map.osm.asia](https://map.osm.asia)
- 版本记录：[CHANGELOG.md](CHANGELOG.md)
- 问题反馈：[GitHub Issues](https://github.com/koharachan/BetteriD/issues)

> [!IMPORTANT]
> BetteriD 是独立、非官方的 OpenStreetMap 编辑器，不由 OpenStreetMap Foundation 运营或背书。
> 上传前请逐项核对标签、来源和变更说明，并遵守
> [OpenStreetMap 贡献条款](https://www.openstreetmap.org/copyright)。

## 0.1.5 Release

- Standard OpenStreetMap tiles are now routed through the Rust proxy with
  BetteriD identity headers and compliant caching to avoid blocked tile images.
- OSM.asia branding now applies across proxied OpenStreetMap pages, including
  login and OAuth pages.

Full notes: [0.1.5 changelog](CHANGELOG.md#betterid-015).

## 0.1.4 Release

- Extracting an address-only building now moves its `addr:*` tags onto a new
  address node. Buildings that also contain POI tags keep the existing Extract
  behavior.

Full notes: [0.1.4 changelog](CHANGELOG.md#betterid-014).

## 0.1.3 正式版

- 新增独立拆分工具，完善道路拆分、成员关系编辑和旋转操作。
- 改进移动端绘制、选择、套索及触控反馈，并协调 JOSM 快捷键与 WASD 导航。
- 优化室内楼层聚焦、工具栏、侧栏、组合框和 AI 标签助手交互。
- 完善 OpenStreetMap 官方 OAuth 登录与回调兼容性。

完整内容见 [0.1.3 changelog](CHANGELOG.md#betterid-013)。

## 0.1.2 正式版

- 合并上游 iD 最新 develop，带来 Mapillary 非安全照片 ID 处理修复、高德地名后缀误判修复、年度影像分组，以及旧标签建议里的 `*:wikidata` 链接。
- 保留被屏蔽底图的自定义编辑入口，方便直接替换保存过的地址。
- 完成上游前端 TypeScript 迁移，并补上影像、校验和数据获取路径的回归测试。

完整内容见 [0.1.2 changelog](CHANGELOG.md#betterid-012)。

## 0.1.1 正式版

- 默认屏蔽 Google、百度、高德/Autonavi、腾讯/QQ 等不允许用于 OSM 描绘的影像地址，同时保留 OSM API 下发的屏蔽规则。
- 解决导航快捷键冲突：短按 A/W/Shift 保留原操作，长按进入移动或修饰键行为，空格继续用于缩小。
- 允许编辑、重命名和删除自动生成的 changeset 标签，刷新提交面板时不再覆盖用户选择。
- 将镜像站页头品牌更新为 OSM.asia，并修复外部 Logo 的 CSP 加载限制。
- 完善原子发布中的 AI 配置继承、OAuth 官方授权地址和相关回归测试。

完整内容见 [0.1.1 changelog](CHANGELOG.md#betterid-011)。

## 0.1.0 正式版

- 建立 `release` 默认稳定分支，线上部署、编辑器版本与 GitHub Release 统一为 0.1.0。
- 新增带来源链接和置信度的 AI 标签助手，支持按偏好顺序在多个服务端提供商间回退。
- 新增完全留在浏览器内的本地照片底图，可定位、缩放和旋转，不会上传、审核或用于识别 POI。
- 为 `image=*` 字段增加照片上传、审核、公开托管和可选 POI 识别；识别结果不会改写图片网址。
- 新增双影像、室内楼层聚焦、右键拖图、吸附范围和移动端绘制优化。
- 完善 WASD 导航：短按 W 切换区域填充，长按 W 移动；Shift/空格缩放，默认移动速度提升为原来的 1.6 倍。
- 扩展中文本地化、多语言名称生成、Osmose 翻译、非本地语言名称检查和安全批量修复。
- Rust 代理新增 AI 路由、Kimi 搜索、OpenAI/MiMo 视觉能力、限流和可信反向代理处理。
- 前端构建和 CI 从 npm 迁移到 pnpm，稳定版 iD 翻译可在构建时继承。

完整内容见 [0.1.0 changelog](CHANGELOG.md#betterid-010)。

## 功能

### 中文与多语言

- BetteriD 自有翻译覆盖与上游稳定版 iD 翻译分层维护。
- 预设、字段、常见标签值、校验问题和 Osmose 内容的中文显示改进。
- 从主名称生成最多 8 个目标语言名称，应用前可逐项预览和选择。
- 可选的地区法定语言脚本检查，降低主 `name` 使用不合适语言的概率。

### AI 辅助

- 根据用户描述、现有标签、几何类型和位置检索 OSM 标签建议，并展示依据与来源。
- 生成简洁的 changeset comment；失败不会阻止正常提交。
- 文本、搜索和视觉任务分别配置服务端提供商顺序，并在配额或上游错误时静默回退。
- AI 输出只作为候选建议，应用标签和上传变更前始终需要人工复核。

### 编辑体验

- 智能拆分大批量 changeset，支持自动、固定数量和按区域三种策略。
- 可调吸附范围、右键拖图、兼容的 JOSM 快捷键、室内楼层聚焦和上次地图位置记忆。
- 移动端点/线绘制手势、全宽侧栏和触控布局优化。
- 实验功能包括双影像、本地照片底图以及 walk/fly 两种 WASD 导航模式。

### 编辑导入导出与隐私编辑

- 提交面板可将当前改动导出为 `osmChange`（`.osc`）文件，也可反过来导入
  `.osc` / `.osm` 作为待上传的本地改动（一次可撤销，缺少子节点的线/关系会跳过并提示）。
- 隐私编辑：由服务器持有的匿名 OSM 账号代传本次改动，浏览器只发送 `osmChange`
  文档、不接触任何凭据；服务器未配置凭据时按钮自动禁用。配置见
  [p/README.md](p/README.md#privacy-anonymous-upload)。

### 校验与安全

- 对明确且非破坏性的校验修复提供批量应用入口。
- 改进高德来源识别并增加天地图来源警告。
- 作为本地底图打开的照片不会离开浏览器；只有用户从 `image=*` 字段主动上传的照片才会检查大小、格式和尺寸，重新编码为 JPEG 去除元数据，并经过内容审核后公开。
- 在中国大陆、香港和澳门阻止创建或修改军事区域及其成员；确有需要时可转到官方 OSM 编辑器继续。

## 本地开发

要求：Node.js 22 或更高版本、pnpm `10.28.2`。运行 Rust 代理时还需要稳定版 Rust 工具链。

```bash
git clone https://github.com/koharachan/BetteriD.git
cd BetteriD
pnpm install --frozen-lockfile
pnpm start
```

浏览器打开 <http://127.0.0.1:8080>。常用检查命令：

```bash
pnpm run all
pnpm test
```

## 运行完整服务

先在仓库根目录构建编辑器，再启动 Rust 代理：

```bash
pnpm run all
cp p/.env.example p/.env
cd p
cargo run
```

打开 <http://127.0.0.1:9178/id/>。OAuth 回调、AI 提供商、照片存储和反向代理配置见
[p/README.md](p/README.md)。Windows + Visual Studio 用户也可以在 `p` 目录运行 `run-vs.cmd`。

线上实例的容器化部署（镜像构建、回源切换、上线检查、密钥与主机信息管理）见
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

所有提供商密钥只应配置在代理进程或 `.env` 中，不得写入前端源码、提交到 Git，或返回给浏览器。

## 文档

- [BetteriD Web Editor MCP](mcp/README.md)
- [代理部署与 API](p/README.md)
- [生产部署](docs/DEPLOYMENT.md)
- [0.0.2 功能设计与实现说明](docs/superpowers/specs/2026-07-14-id-cn-ai-features-design.md)
- [贡献指南](CONTRIBUTING.md)
- [版本记录](CHANGELOG.md)

## 上游与许可证

BetteriD 基于 OpenStreetMap 的 [iD editor](https://github.com/openstreetmap/iD)，感谢 iD 维护者和所有
上游贡献者。向上游通用功能提交改进时，请优先遵循 iD 的贡献规范。

本项目使用 [ISC License](LICENSE.md)。仓库还包含 D3.js、CLDR、editor-layer-index、Font Awesome、
Maki、Temaki、Rontgen、Mapillary JS、iD Tagging Schema、name-suggestion-index 和
osm-community-index 等开源组件；其版权和许可证分别遵循对应上游项目。
