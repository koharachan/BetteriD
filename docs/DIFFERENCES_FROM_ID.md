# BetteriD 与上游 iD 的差异

本文记录 BetteriD 相对 OpenStreetMap iD 原版的主要差异，方便维护 fork、做 release review，以及判断哪些改动可以拆分回推给上游。

## 比较口径

截至 2026-07-22，本地已抓取 `upstream/develop`：

- BetteriD HEAD：`9746e45e9`
- upstream/develop：`92a9251e9`
- merge base：`dc9d3cf57`

用于观察 BetteriD fork 增量的命令：

```bash
git fetch upstream
git diff --stat upstream/develop...HEAD
git diff --name-status upstream/develop...HEAD
```

当前增量统计为：

```text
172 files changed, 27628 insertions(+), 11274 deletions(-)
```

这个口径使用三点 diff，关注 BetteriD 自 merge base 以来相对上游 iD 的新增和修改；它不会把上游后来新增但 BetteriD 尚未合并的改动算作 BetteriD 功能。

## 差异总览

| 领域 | BetteriD 增量 | 与 iD 原版的关系 |
| --- | --- | --- |
| 品牌与发布 | 包名、主页、release 分支、GitHub Actions、版本说明改为 BetteriD | fork 维护必需，不适合直接回推 |
| 构建工具 | 从 npm lockfile 切到 pnpm workspace 和 `pnpm-lock.yaml` | 可能回推，但需要上游维护者接受工具链迁移 |
| 中文本地化 | BetteriD 自有中文覆盖、Osmose 翻译、常见值翻译 | 部分可回推为通用 i18n 改进 |
| 多语言名称 | 生成多个 `name:*` 候选并逐项确认 | 可讨论回推，但 AI/翻译代理依赖需拆开 |
| AI 标签助手 | 带来源和置信度的 OSM 标签建议 | 不适合整体回推；安全约束和服务端依赖较重 |
| AI changeset comment | 基于实际变更摘要生成 comment | 摘要结构可回推，AI 生成本体需要上游讨论 |
| 照片能力 | 本地照片底图、`image=*` 上传、审核、识别 | 本地照片底图较适合拆分；托管和审核服务依赖不适合直接回推 |
| 影像体验 | 双影像、不兼容来源屏蔽、自定义被屏蔽底图编辑入口 | 双影像和编辑入口可讨论；地区化屏蔽策略不适合直接回推 |
| 编辑体验 | 右键拖图、可调吸附范围、位置记忆、JOSM 快捷键、WASD 导航 | 多数可以拆成偏好或实验功能回推 |
| 移动端 | 触控绘制、全宽侧栏、套索和选择反馈优化 | 适合优先回推 |
| 校验 | 安全批量修复、非本地语言名称检查、天地图来源警告 | 批量修复机制适合回推；地区/来源规则需单独讨论 |
| 本地合规策略 | 中国大陆、香港、澳门军事区域编辑拦截 | 地区化策略，不适合进入 iD 原版 |
| Rust 代理 | 同源托管、OSM/OAuth 代理、AI 路由、照片处理、缓存 | 属于 BetteriD 部署架构，不适合回推到纯前端 iD |

## 前端功能差异

### 偏好面板

新增 BetteriD 偏好分组，包括：

- 记住上次地图位置
- 室内楼层聚焦
- 右键拖图
- JOSM 兼容快捷键
- 可调吸附范围
- 智能拆分设置
- 多语言名称目标语言
- AI 提供商顺序
- 实验功能总开关、双影像、本地照片底图和 WASD 导航

核心文件：

- `modules/core/betterid_preferences.js`
- `modules/ui/sections/betterid_preferences.js`

### AI 标签助手

iD 原版没有内置 AI 标签建议。BetteriD 在单选实体属性面板中增加 AI 标签助手，用户输入描述后，代理进行网页检索和模型归纳，返回候选 OSM 标签、理由、置信度和来源链接。

安全差异：

- 默认不选中低置信度建议。
- 删除操作默认不选中。
- 阻止 AI 写入来源、导入、元数据和图片等敏感标签。
- 用户必须手动勾选并应用，变更进入本地历史后仍走 iD 校验和上传流程。

核心文件：

- `modules/ui/sections/ai_tag_assistant.js`
- `p/src/ai.rs`

### Changeset 与上传

BetteriD 增强了上传前工作流：

- 结构化摘要真实创建、修改和删除内容，避免 comment 夸大或虚构。
- 可调用 AI 生成简洁 changeset comment。
- 支持按策略拆分大 changeset。
- 允许用户编辑、重命名和删除派生 changeset 标签，刷新面板不再覆盖用户选择。

核心文件：

- `modules/ui/commit.js`
- `modules/ui/changeset_editor.js`
- `modules/util/changeset_summary.js`
- `modules/core/change_batches.js`

### 影像、照片和室内编辑

BetteriD 增加双影像、本地照片底图和室内楼层聚焦。双影像适合做来源对照；本地照片底图用于现场照片辅助定位；室内聚焦用于降低多楼层建筑的视觉干扰。

`image=*` 字段被扩展为可上传、审核并公开托管照片。此功能依赖 Rust 代理，不属于纯前端能力。

核心文件：

- `modules/ui/sections/experimental_background.js`
- `modules/renderer/background.js`
- `modules/ui/fields/image.js`
- `p/src/photos.rs`

### 移动端与快捷键

BetteriD 改进触控绘制、选择、套索、旋转和侧栏布局，并协调 WASD 导航与 iD/JOSM 常用快捷键。短按和长按被区分处理，减少与 `A`、`W`、`Shift` 等现有功能冲突。

核心文件：

- `modules/behavior/mobile_draw.js`
- `modules/renderer/map.js`
- `modules/behavior/select.js`
- `css/84_mobile_ui.css`

## Rust 代理差异

iD 原版是前端应用。BetteriD 新增 `p/` Rust 服务作为生产入口：

- 托管 `dist/` 编辑器资源。
- 代理 OSM 网站、API、OAuth 和公开瓦片请求。
- 提供 `/api/osm-ai/*` 同源 API。
- 将 AI/翻译/视觉 provider key 保留在服务端。
- 对 AI 请求限流。
- 只缓存允许公开缓存的 GET 响应。
- 验证可信反向代理链。
- 处理照片上传、审核、JPEG 重新编码和不可变公开 URL。

完整部署说明见 [../p/README.md](../p/README.md)。

## 测试差异

BetteriD 为新增能力补充了对应回归测试：

- 移动端绘制和选择
- BetteriD 偏好
- changeset 拆分和摘要
- 背景影像和本地照片
- AI 标签助手
- `image=*` 上传字段
- 批量校验修复
- 非本地语言名称
- 军事区域保护
- 代理 provider 顺序、回退、照片和限流逻辑

运行：

```bash
pnpm test
cd p && cargo test
```

## 维护边界

建议把 BetteriD 改动分成三类维护：

1. **fork 专属**：品牌、部署域名、Rust 代理、地区化合规策略、AI provider 配置。
2. **可拆分回推**：移动端触控、拆分工具、可调吸附范围、双影像、changeset 摘要、批量安全修复、关系成员编辑细节。
3. **需要先讨论**：AI 标签建议、照片托管、工具链迁移、地区语言脚本检查、影像屏蔽策略。

具体候选见 [UPSTREAM_CANDIDATES.md](UPSTREAM_CANDIDATES.md)。
