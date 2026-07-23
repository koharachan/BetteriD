# BetteriD

[![Build](https://github.com/koharachan/BetteriD/actions/workflows/build.yml/badge.svg?branch=release)](https://github.com/koharachan/BetteriD/actions/workflows/build.yml)
[![GitHub release](https://img.shields.io/github/v/release/koharachan/BetteriD)](https://github.com/koharachan/BetteriD/releases)
[![License: ISC](https://img.shields.io/badge/license-ISC-blue.svg)](LICENSE.md)

BetteriD 是面向中文 OpenStreetMap 编辑场景的网页编辑器，基于
[iD editor](https://github.com/openstreetmap/iD) 开发。它保留 iD 的核心编辑工作流，在中文本地化、多语言名称、AI 辅助、移动端交互、影像对照和可自托管同源代理方面做增强。

- 在线使用：[map.osm.asia](https://map.osm.asia)
- 版本记录：[CHANGELOG.md](CHANGELOG.md)
- 问题反馈：[GitHub Issues](https://github.com/koharachan/BetteriD/issues)
- 上游项目：[openstreetmap/iD](https://github.com/openstreetmap/iD)

> [!IMPORTANT]
> BetteriD 是独立、非官方的 OpenStreetMap 编辑器，不由 OpenStreetMap Foundation 运营或背书。
> 上传前请逐项核对标签、来源和变更说明，并遵守
> [OpenStreetMap 贡献条款](https://www.openstreetmap.org/copyright)。

## 当前版本

当前 release 分支版本为 `0.1.3`。

### 0.1.3 重点

- 新增独立拆分工具，完善道路拆分、成员关系编辑和旋转操作。
- 改进移动端绘制、选择、套索及触控反馈。
- 协调 JOSM 快捷键与 WASD 导航，降低快捷键冲突。
- 优化室内楼层聚焦、工具栏、侧栏、组合框和 AI 标签助手交互。
- 完善 OpenStreetMap 官方 OAuth 登录与回调兼容性。

完整记录见 [CHANGELOG.md](CHANGELOG.md#betterid-013)。

## BetteriD 与 iD 的主要区别

BetteriD 相对上游 iD 增加了以下能力：

- **中文与多语言编辑**：独立维护中文覆盖翻译，支持多语言名称生成、Osmose 内容翻译和非本地语言 `name` 检查。
- **AI 辅助**：通过同源 Rust 代理提供 changeset comment、OSM 标签建议、照片审核与可选 POI 标签识别。
- **编辑效率**：支持智能 changeset 拆分、安全批量校验修复、可调吸附范围、右键拖图、位置记忆和 JOSM 兼容快捷键。
- **影像与现场资料**：支持双影像、本地照片底图、`image=*` 照片上传托管和室内楼层聚焦。
- **移动端体验**：补充触控绘制、双击结束线、全宽侧栏、更大的触控目标和移动端布局修复。
- **自托管部署**：新增 Rust 代理，统一托管编辑器、OSM/OAuth 代理、AI 路由、照片处理、缓存和反向代理安全策略。
- **本地安全策略**：默认屏蔽不适合 OSM 描绘的影像来源，并在中国大陆、香港、澳门阻止编辑军事区域及其成员。

详细比较见 [docs/DIFFERENCES_FROM_ID.md](docs/DIFFERENCES_FROM_ID.md)。

## 文档

- [功能指南](docs/FEATURES.md)：面向使用者和维护者的 BetteriD 功能地图。
- [与上游 iD 的差异](docs/DIFFERENCES_FROM_ID.md)：按代码、功能和维护边界说明 fork 增量。
- [可回推上游候选](docs/UPSTREAM_CANDIDATES.md)：哪些改动适合拆成 PR 贡献给 iD 原版。
- [Rust 代理部署与 API](p/README.md)：生产入口、环境变量、AI/照片 API 和安全边界。
- [中文增强与 AI 功能设计](docs/superpowers/specs/2026-07-14-id-cn-ai-features-design.md)：0.0.2 功能设计说明。
- [贡献指南](CONTRIBUTING.md)：开发流程、测试和提交约定。

## 本地开发

要求：

- Node.js 22 或更高版本
- pnpm `10.28.2`
- 运行 Rust 代理时需要稳定版 Rust 工具链

```bash
git clone https://github.com/koharachan/BetteriD.git
cd BetteriD
pnpm install --frozen-lockfile
pnpm start
```

浏览器打开 <http://127.0.0.1:8080>。

常用检查命令：

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

所有提供商密钥只应配置在代理进程或 `.env` 中，不得写入前端源码、提交到 Git，或返回给浏览器。

## 许可证与致谢

BetteriD 基于 OpenStreetMap 的 [iD editor](https://github.com/openstreetmap/iD)。感谢 iD 维护者和所有上游贡献者。

本项目使用 [ISC License](LICENSE.md)。仓库还包含 D3.js、CLDR、editor-layer-index、Font Awesome、Maki、Temaki、Rontgen、Mapillary JS、iD Tagging Schema、name-suggestion-index 和 osm-community-index 等开源组件；其版权和许可证分别遵循对应上游项目。
