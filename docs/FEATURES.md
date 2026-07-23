# BetteriD 功能指南

本文面向使用者、维护者和部署者，说明 BetteriD 在 iD 基础上增加的主要能力、入口和安全边界。

## 功能地图

| 能力 | 入口 | 主要文件 |
| --- | --- | --- |
| BetteriD 偏好 | 侧栏偏好面板 | `modules/ui/sections/betterid_preferences.js`, `modules/core/betterid_preferences.js` |
| AI 标签助手 | 单选实体后的属性面板 | `modules/ui/sections/ai_tag_assistant.js`, `p/src/ai.rs` |
| 多语言名称生成 | 本地化名称字段 | `modules/ui/fields/localized.js`, `p/src/translate.rs` |
| AI changeset comment | 上传面板 | `modules/ui/commit.js`, `modules/util/changeset_summary.js` |
| 智能拆分 changeset | 上传面板和拆分工具 | `modules/core/change_batches.js`, `modules/ui/tools/split.js`, `p/src/split.rs` |
| 安全批量校验修复 | 问题面板 | `modules/ui/sections/validation_autofix.js` |
| 双影像和本地照片底图 | 背景面板实验功能 | `modules/ui/sections/experimental_background.js`, `modules/renderer/background.js` |
| `image=*` 照片上传和识别 | 图片字段 | `modules/ui/fields/image.js`, `p/src/photos.rs` |
| 移动端绘制优化 | 触控地图编辑 | `modules/behavior/mobile_draw.js`, `css/84_mobile_ui.css` |
| 中国区军事区域保护 | 所有编辑动作入栈前 | `modules/util/military_policy.js`, `modules/ui/military_warning.js` |
| Rust 同源代理 | 生产服务入口 | `p/src/main.rs`, `p/README.md` |

## 中文与多语言

BetteriD 将自有中文覆盖翻译放在 `data/betterid_locale_overrides.json`，避免被上游 iD 翻译更新覆盖。构建时可通过 `pnpm run translations` 继承上游稳定发行翻译；需要直接拉取 Transifex 开发翻译时使用 `pnpm run translations:dev`。

多语言名称生成从主名称出发，按偏好里的语言列表生成候选。默认目标为 `zh`、`zh-Hant` 和 `en`，最多 8 个语言代码。写入标签前，用户可以逐项预览和选择。

非本地语言 `name` 检查会结合地区语言和脚本比例判断，目标是提醒“主名称可能不是当地常用语言”，而不是自动改写任何标签。

## AI 辅助

AI 能力通过同源 Rust 代理提供，浏览器只知道任务能力和提供商名称，不接收 API key。

| 任务 | 默认提供商顺序 | 说明 |
| --- | --- | --- |
| 文本、翻译、changeset comment | DeepSeek -> OpenAI -> MiMo | 失败时回退，不阻止手动编辑 |
| 带网页检索的标签建议 | OpenAI -> Kimi | 输出候选标签、理由、置信度和来源 |
| 图片审核和视觉识别 | OpenAI -> MiMo | 仅处理用户主动上传到 `image=*` 的照片 |

AI 标签助手只在单选实体时显示。它会提交用户描述、现有单值标签、几何类型、位置和界面语言；返回结果经过前后端归一化。助手不会写入 `source`、`source:*`、`created_by`、`attribution`、`tiger:*`、`odbl:*`、`import` 等来源或元数据标签。

changeset comment 生成基于结构化的实际变更摘要。生成失败时，上传流程仍可继续，用户可以手写说明。

## 影像与照片

双影像允许在主底图之外选择第二底图，并独立调整透明度，适合对照不同年份或不同来源的影像。

本地照片底图完全留在浏览器内：选择照片后可移动、缩放、旋转和调整透明度，不上传、不审核、不用于 POI 识别。

`image=*` 字段的照片上传是另一条路径。用户主动选择照片后，Rust 代理会检查格式、大小、像素和尺寸，应用 EXIF 方向，重新编码为 JPEG 去除元数据，通过服务端审核后才返回不可变同源公开 URL。可选的照片识别只接受本服务签发的照片 ID 或 URL。

## 编辑体验

BetteriD 增加了可调吸附范围、右键拖图、位置记忆、JOSM 兼容快捷键和 WASD 导航。WASD 属于实验功能，支持 `walk` 和 `fly` 两种模式；表单聚焦时不会截获输入。

智能 changeset 拆分支持自动、固定数量和按区域拆分。它适合降低大批量上传失败风险，但每个批次仍需要用户检查变更说明和来源。

安全批量校验修复只处理被标记为确定、非破坏性的修复。其他问题仍保留逐项处理。

## 移动端

移动端补充了空白地图手势绘制、点/线绘制优化、双击结束线、全宽侧栏、触控反馈和至少 44x44 像素的触控目标。目标是让手机或平板可以完成轻量编辑，而不是替代桌面端复杂关系维护。

## 安全边界

- AI 建议只作为候选，不能替代实地调查、合法影像、OSM Wiki 或本地知识。
- 服务端密钥只能配置在 Rust 代理或 `.env` 中，不得进入前端源码、构建产物或浏览器响应。
- 不兼容 OSM 描绘的影像来源默认屏蔽，同时保留 OSM API 下发的屏蔽规则。
- 在中国大陆、香港和澳门，创建或修改军事区域及其成员会被拦截；确有需要时，弹窗会引导到官方 OSM 编辑器。
- 部署者需要为公开照片配置持久化目录、备份和保留周期。

## 验证

前端验证：

```bash
pnpm test
```

Rust 代理验证：

```bash
cd p
cargo fmt --check
cargo test
cargo clippy --all-targets --all-features
```

发布前还应检查构建产物和提交内容，确认没有 `.env`、API key、OAuth secret 或其他凭据。
