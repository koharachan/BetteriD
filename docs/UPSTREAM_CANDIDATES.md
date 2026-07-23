# 可回推给 iD 原版的功能候选

本文从 BetteriD 当前差异中筛选更适合提交给 `openstreetmap/iD` 的功能，并按上游接受概率、通用性和拆分难度排序。

## 推荐优先级

| 优先级 | 候选 | 原因 | 建议拆分 |
| --- | --- | --- | --- |
| P1 | 移动端绘制和触控布局优化 | 通用、用户价值明确、不依赖 BetteriD 后端 | 多个小 PR：绘制手势、触控目标、侧栏布局、套索反馈 |
| P1 | 独立拆分工具和拆分行为修复 | iD 用户普遍需要，已有测试覆盖 | 先提交 bugfix，再提交工具入口 |
| P1 | 关系成员和成员关系编辑细节 | 属于核心编辑体验，不带地区/AI 假设 | 按 raw member editor、membership editor 分 PR |
| P1 | changeset 派生标签可编辑 | 尊重用户显式选择，逻辑清楚 | 单独 PR，附提交面板回归测试 |
| P2 | 可调吸附范围 | 通用编辑偏好，适合高级用户 | 需要上游同意偏好入口和默认值 |
| P2 | 安全批量校验修复入口 | 能提升修复效率，但要严格限定 `autoSafe` | 先回推模型标记，再回推 UI |
| P2 | changeset 结构化摘要 | AI 无关部分可帮助生成更准确的说明或未来 UI | 只提交摘要数据结构和测试，不提交 AI |
| P2 | 室内楼层聚焦 | 对室内编辑有通用价值 | 需配合 UI/渲染说明和性能测试 |
| P2 | 双影像对照 | 对影像校验很有价值 | 作为实验功能讨论，避免默认开启 |
| P2 | 被屏蔽自定义底图仍可编辑 | 有助于用户替换失效或不合规 URL | 小 PR，强调不能绕过实际渲染屏蔽 |
| P3 | JOSM 兼容快捷键 | 迁移用户友好，但快捷键冲突需要上游共识 | 做成可选偏好，逐个快捷键讨论 |
| P3 | 本地照片底图 | 通用但交互和隐私说明需要打磨 | 仅回推浏览器本地 overlay，不包含上传/审核/识别 |
| P3 | 非本地语言 `name` 检查 | 对多语地区有价值，但规则容易有争议 | 先做 issue/RFC，按国家语言数据讨论 |
| P3 | pnpm 工具链迁移 | 可提升一致性，但影响所有贡献者 | 只有上游主动愿意时再做 |

## 不建议直接回推

以下能力更适合保留在 BetteriD，或需要先在上游 issue 中做长期讨论：

- BetteriD 品牌、域名、镜像站提示和 release 流程。
- Rust 同源代理整体架构。
- AI provider 路由、Kimi/OpenAI/DeepSeek/MiMo 配置和服务端密钥管理。
- AI 标签助手整体功能。
- `image=*` 照片托管、审核和视觉识别。
- 中国大陆、香港、澳门军事区域编辑拦截。
- 针对特定地区或特定来源的默认影像屏蔽策略。
- 捐赠、QQ群、OSM.asia 部署相关文案。

这些功能并非“不好”，而是上游 iD 原版通常需要保持纯前端、全球通用、无特定服务依赖和低政策耦合。

## 建议的上游 PR 路线

### 1. 先推纯 bugfix 和小 UX

优先选择不改变产品方向的修复：

- 移动端控件不遮挡侧栏。
- 触控目标尺寸和移动端绘制反馈。
- 拆分后 selection/hover/cleanup 的稳定性。
- changeset 派生标签不覆盖用户手动编辑。
- 组合框、工具栏、侧栏的小交互修复。

这类 PR 容易 review，也能建立维护者信任。

### 2. 再推编辑效率功能

把较大的能力拆成独立、可关闭、测试充分的 PR：

- dedicated split tool
- adjustable snap tolerance
- safe validation autofix
- indoor level focus
- dual imagery

每个 PR 都应说明：

- 默认行为是否变化
- 对新手是否可见
- 是否有偏好开关
- 是否影响键盘、触控或可访问性
- 是否有单元测试和手动测试步骤

### 3. AI 相关先不开 PR，先开讨论

AI 标签建议和照片识别涉及事实来源、版权、隐私、错误责任、服务端成本和 OSM 社群接受度。建议先把 BetteriD 的经验写成 issue 或 discussion：

- AI 建议必须是候选，不能自动上传。
- 必须展示来源和置信度。
- 必须禁止写入来源、导入和元数据标签。
- 必须保留人工复核。
- 需要清楚区分“模型推断”和“可验证事实”。

如果上游有兴趣，再考虑提交不依赖具体 provider 的接口或实验开关。

## 每个候选的拆分建议

### 移动端绘制

建议从 `modules/behavior/mobile_draw.js` 和 `css/84_mobile_ui.css` 中拆出最小闭环：

- 空白地图触控绘制点/线。
- 双击或明确手势结束线。
- 避免控件覆盖全宽侧栏。
- 保证触控目标尺寸。

不要把 WASD、AI、BetteriD 偏好一起带入。

### 独立拆分工具

拆分顺序：

1. 提交 split action/operation 的行为修复和测试。
2. 提交 toolbar tool 入口。
3. 如有必要，再提交移动端或快捷键适配。

目标是让维护者可以分别接受“修复”和“新增入口”。

### 安全批量校验修复

先抽象 `autoSafe` 或等价标记，让 validation fix 明确声明自己是确定且非破坏性的；再加问题面板批量入口。

PR 中应避免把所有 fix 都批量化，宁可先支持少量高确定性的修复。

### Changeset 摘要

建议只回推 `modules/util/changeset_summary.js` 中 AI 无关的真实变更摘要能力：

- 创建、修改、删除数量。
- 主要 feature 类型。
- 实际 tag 增删改。
- 支撑几何节点与有意义对象的区分。

AI comment 生成保留在 BetteriD。

### 本地照片底图

可回推的只有“浏览器本地 overlay”：

- 文件不上传。
- 数据不持久公开。
- 用户可调整位置、比例、旋转和透明度。
- 清楚提示不能替代合法来源。

照片审核、公开 URL、视觉识别和 `image=*` 写入不适合一起回推。

## 推荐提交顺序

1. `fix(commit): preserve user-edited changeset tags`
2. `fix(mobile): avoid controls overlapping full-width pane`
3. `feat(mobile): improve touch drawing feedback`
4. `fix(split): clean up selection after splitting ways`
5. `feat(split): add dedicated split toolbar tool`
6. `feat(preferences): add adjustable snap tolerance`
7. `feat(validation): mark deterministic fixes as auto-safe`
8. `feat(validation): add safe autofix batch action`
9. `feat(background): add optional dual imagery comparison`
10. `feat(indoor): focus selected indoor level`

每一步都尽量保持小 diff、小测试面和清楚的 before/after 说明。
