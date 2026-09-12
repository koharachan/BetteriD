# Photoshop 风格工具栏（规划设计）

面向 BetteriD（iD fork）的左侧工具栏：框选、快速选择、魔棒、钢笔，以及一套 Adobe 风格快捷键。
本文档先记录 Photoshop 里这些工具与快捷键的真实行为（含出处），再给出映射到 OSM 编辑器的实现方案。

参考：[Adobe Photoshop 默认快捷键](https://helpx.adobe.com/photoshop/using/default-keyboard-shortcuts.html)、
[PS 快捷键备忘清单](https://raw.githubusercontent.com/jaywcjlove/reference/main/docs/adobe-photoshop.md)、
[魔棒工具（Adobe 帮助）](https://helpx.adobe.com/in/photoshop/desktop/make-selections/automatic-color-based-selections/select-areas-by-color-with-the-magic-wand-tool.html)、
[快速选择工具入门](https://sts.doit.wisc.edu/manuals/photoshop1/)。

## 1. Photoshop 里它们到底怎么工作

### 1.1 选框工具（Marquee，快捷键 `M`）

- 按住拖拽出矩形，`Shift+M` 在矩形/椭圆（以及单行/单列）之间循环；`M` 每次按回到上次用过的形状。
- 选区是**像素区域**，不是对象；结果是"哪些像素被选中"。
- 修饰键是 PS 选择体系的通用规则：`Shift` 加选、`Alt` 减选、`Shift+Alt` 交集。
- 选项栏：羽化（Feather）、消除锯齿（Anti-alias）、样式（正常/固定比例/固定大小）。
- 关键实现点：拖拽过程只记录起点/终点（矩形）或外接矩形（椭圆），松开时才落地；配合 `Shift` 约束正方形/正圆。

### 1.2 快速选择工具（Quick Selection，快捷键 `W`，`Shift+W` 与魔棒互切）

- 它是一支**画笔式**的智能选择：按住拖动，笔刷扫过的区域会像魔棒一样自动吸附到颜色/边缘相似的像素上。
- 内部可以理解为"沿笔迹不断对笔刷圆形范围内的像素做局部颜色相似扩展"，所以它能连续、增量地长成一片选区。
- 修饰键同样是 `Shift` 加、`Alt` 减（PS 里用 `Alt` 时笔刷会变成"减号"图标）。
- 选项栏：笔刷大小、对所有图层取样（Sample All Layers）、自动增强（Auto-Enhance）、取样大小；常配"选择并遮住/调整边缘"做精修。

### 1.3 魔棒工具（Magic Wand，快捷键 `W`，与快速选择同组）

- 单击一次，选中**与点击点颜色相近且（默认）连通**的像素区域，类似图像的"洪泛填充"。
- 选项栏决定行为：
  - 容差（Tolerance，0–255）：颜色差在容差内算同类；
  - 连续（Contiguous）：只选与点击处连通的一片，取消勾选则全图同色都选中；
  - 消除锯齿、对所有图层取样、取样大小。
- 修饰键：`Shift` 加选、`Alt` 减选、`Shift+Alt` 交集。

### 1.4 钢笔工具（Pen，快捷键 `P`，`Shift+P` 切自由钢笔）

- 单击落一个**角点**（尖角），单击并拖动落一个**平滑点**并拉出方向线（贝塞尔手柄），两段之间的曲线由手柄决定。
- 编辑路径：`Ctrl`（临时切直接选择）拖锚点/手柄改形状；`Alt` 放在锚点上切换到"转换点"工具，可单独折/拖一侧手柄。
- 闭合路径、`Ctrl+Enter` 把路径转为选区、或填充/描边；路径是矢量，不是像素。
- `Enter` 应用、`Esc` 取消。

### 1.5 这套快捷键（PS 侧）

| 快捷键 | Photoshop 行为 |
| --- | --- |
| 按住 `Space` 拖动 | 临时手工具，平移画布 |
| `Alt` + 滚轮 | 以指针为中心缩放（等价"缩放工具"） |
| `Ctrl` + 滚轮 | 水平滚动 |
| 滚轮 / `Shift`+滚轮 | 垂直滚动 / 大幅滚动 |
| `Alt` + 单击 | 临时吸管，吸取指针处颜色（吸管 `I`） |
| `Ctrl+T` | 自由变换（缩放/旋转/斜切/透视/变形） |
| `Ctrl+Alt+T` | 自由变换并复制一份 |
| `Ctrl+Shift+T` | 再次变换（重复上一次变换） |
| `Ctrl+Alt+Shift+T` | 再次变换并复制 |
| `Ctrl+J` | 通过拷贝新建图层（选区内容复制一份） |
| `Ctrl+Shift+J` | 通过剪切新建图层 |
| `Ctrl+Shift+V` | 原位粘贴（粘贴到原坐标） |
| `Shift` / `Alt` / `Shift+Alt` + 选择 | 加选 / 减选 / 交集 |

## 2. 映射到 OSM 编辑器（BetteriD）

地图没有"像素/图层"，但有**要素、节点、连通关系、标签**，可以一一对应：

| PS 概念 | BetteriD 对应 |
| --- | --- |
| 像素 | 地图要素（node/way/relation）及其节点 |
| 选区 | 当前选中要素集合（`context.selectedIDs()`，与 iD 的 select 模式共用） |
| 颜色相似 | 标签相似（比较 `tags`，`key=value` 相同的比例） |
| 连通（Contiguous） | 共享节点 / 成员关系上的邻接（`graph.parentWays`、`graph.childNodes`、relation 成员） |
| 图层 | 底图 / OSM 数据 / 覆盖物（选择只作用于 OSM 数据） |
| 自由变换 | 选区几何的移动/旋转/缩放（iD 的 move/rotate/scale 操作） |
| 复制图层 | 复制选区要素并保留标签（生成新的本地 id） |
| 原位粘贴 | 在**原坐标**粘贴剪贴板里的要素（iD 默认粘贴在鼠标位置） |
| 吸管 | 取指针处地图瓦片的屏幕颜色，转成 hex 复制到剪贴板 |
| 路径 | 新画的 OSM way（节点链）；钢笔曲线按贝塞尔采样成中间节点 |

### 2.1 框选（矩形/椭圆）

- 拖拽过程在地图上画一层半透明预览（`<rect>` / `<ellipse>`，SVG 覆盖层，不参与地图交互）。
- 松开时：矩形用 `history.intersects(extent)` 取候选；椭圆先取外接矩形候选，再用多边形（64 边近似）对要素的**可见几何点**做点在多边形内测试（节点用 `loc`，way 用其所有节点；只要有一个点在内或与轮廓相交即算选中）。
- 修饰键按 PS 规则：`Shift` 加、`Alt` 减、`Shift+Alt` 取交集；无修饰键替换选区。
- 选项：矩形 / 椭圆（工具栏子按钮 + `Shift+M` 循环）。

### 2.2 快速选择（笔刷式）

- 按住拖动，指针周围半径 `brushSize/2` 的圆形范围内的要素被"吸附"进选区（屏幕空间半径，和 PS 的笔刷像素一致的手感）。
- 为了让"吸附"像 PS 一样会找相似要素：笔刷命中的要素先取种子，再用与魔棒相同的**标签容差 + 连通**规则向外扩一圈（默认只扩一跳，避免误选整条网络）。
- `Shift`/`Alt` 控制加/减（PS 里拖动本身就是加，`Alt` 拖动为减）。
- 选项：笔刷大小（px）、容差。

### 2.3 魔棒

- 单击要素作为种子，按"洪泛"规则扩展：`容差`=允许的标签差异数（比较 key 相同且 value 相同的比例），`连续`=默认只走连通关系（共享节点/成员），关闭后按标签相似度全图匹配（在当前视口内的候选里）。
- 结果进入 `modeSelect`，`Shift`/`Alt` 加/减。
- 选项：容差（0–10，0 表示标签完全一致）、连续（默认开）、只选同类几何（默认开，避免把 node 和 way 混选）。

### 2.4 钢笔

- 单击 = 角点；单击拖动 = 平滑点（拖出的方向线决定这一段与下一段的贝塞尔曲线）。
- 曲线在落点/结束时按自适应步长（屏幕 8–16 px 一段）采样成 OSM 节点链，节点保持在同一 way 上。
- `Alt` 单击已有锚点 = 断开手柄（PS 的转换点）；`Backspace` 退一个点；`Enter`/双击/`Esc` 结束。
- 结束时像 iD 的绘制模式一样选择预设（线/面）并进入 `modeSelect`，可以立刻在侧栏改标签。
- 预览用 SVG 覆盖层画曲线（含手柄），不写 graph，避免产生大量临时实体。

### 2.5 Adobe 风格快捷键层（可开关）

新增偏好 `betterid.editing.adobe_shortcuts`，和 `betterid.editing.josm_shortcuts` 并排放在
**偏好设置 → 编辑**里（默认开，和 JOSM 兼容快捷键一样随时可关）：

| 快捷键 | 在 BetteriD 的行为 |
| --- | --- |
| 按住 `Space` 拖动 | 平移地图（PS 手工具）；`Space` 短按仍保留原 iD 行为（区域填充切换） |
| `Alt` + 滚轮 | 以指针为中心缩放 |
| `Ctrl` + 滚轮 | 地图水平滚动 |
| 滚轮 | 地图垂直滚动（不是缩放） |
| `Alt` + 单击 | 吸管：取指针处地图颜色 → hex 写入剪贴板 + 弹出提示 |
| `Ctrl+T` | 进入自由变换模式（选区可用旋转/缩放/移动手柄；`Enter` 应用、`Esc` 取消） |
| `Ctrl+Alt+T` | 自由变换并复制选区 |
| `Ctrl+Shift+T` | 再次变换（重复上一次变换参数） |
| `Ctrl+Alt+Shift+T` | 再次变换并复制 |
| `Ctrl+J` | 复制选区要素（新 id，保留标签，偏移一个可感知距离） |
| `Ctrl+Shift+J` | 剪切并复制（删除原要素，副本进入剪贴板） |
| `Ctrl+Shift+V` | 原位粘贴（粘贴到原坐标而非鼠标处） |

冲突处理：以上都以"偏好开启 + 无文本输入焦点"为前提；开关关闭时完全退回 iD 原有快捷键（`Ctrl+T` 等不与现有绑定冲突，`Space`/滚轮会改变现有手感，因此必须可关）。

## 3. 实现结构

```
modules/core/betterid_tools.js        工具与选项状态（prefs 读写、默认值、事件分发）
modules/util/betterid_selection.js    选区几何（矩形/椭圆命中、标签相似、连通扩展）
modules/ui/betterid_toolbar.js        左侧竖排工具栏（5 个按钮 + 选框形状 + 选项行，无说明文字）
modules/behavior/betterid_select_tools.js  框选 / 快速选择 / 魔棒（含选框与笔刷预览层）
modules/behavior/betterid_pen.js      钢笔（贝塞尔 + 采样成 OSM 节点链，含曲线与手柄预览）
modules/behavior/betterid_adobe.js    Adobe 快捷键层（滚轮/空格/Alt 单击/变换与剪贴板快捷键）
css/85_betterid_tools.css             左侧工具栏与预览层样式
```

- 工具通过 `context.install(behavior)` 安装，只在 OSM 数据层可编辑时生效；工具栏按钮切换 `betterid.tools.active`。
- 工具栏只保留图标按钮与当前工具的选项行（框选形状、笔刷大小、容差、连续）；没有工具时不留空白的选项区，
  宽度上限 150px。说明文字不进工具栏，快捷键说明写在偏好设置的对应条目里。

- 工具通过 `context.install(behavior)` 安装，只在 OSM 数据层可编辑时生效；工具栏按钮切换 `betterid.tools.active`。
- 选择结果统一走 `context.enter(modeSelect(context, ids))`，与 iD 的侧栏/校验/上传流程天然一致。
- 变换与复制用现有 action 组合：`actionMove`/`actionRotate`/`actionScale`、`actionAddEntity`，每次操作一个撤销步。
- 吸管用 `context.projection` 反查屏幕坐标，通过 `document.elementFromPoint` 找到瓦片 `<img>`/canvas 后读取像素（同源代理瓦片可直接 `canvas.drawImage` 取色）。

## 4. 验证

- 单元测试：选框几何（矩形/椭圆命中判定）、魔棒扩展（连通/容差/几何过滤）、钢笔贝塞尔采样点数与端点。
- 行为测试：修饰键加/减/交集、快速选择笔刷半径、快捷键在开关开/关两种状态下的行为。
- 浏览器验证（真实 Chromium）：拖出矩形/椭圆后选区与侧栏计数一致；魔棒点一条路的若干个连通段；快速选择扫过若干要素；钢笔画曲线后 way 节点数 > 点击次数且几何平滑；`Space` 拖动平移、`Alt+滚轮` 缩放、`Ctrl+滚轮` 水平滚动、`Alt+单击` 剪贴板里有 hex；`Ctrl+J`/`Ctrl+Shift+V`/`Ctrl+Alt+Shift+T` 的要素数量与几何符合预期。
