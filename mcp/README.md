# BetteriD Web Editor MCP

一个面向 [BetteriD](../README.md) 网页编辑器的 Model Context Protocol
（MCP）服务器。它用 Playwright 驱动真实浏览器打开网页版编辑器，通过编辑器暴露的
`window.context` / `window.iD` 内部 API 完成绘图，并复用浏览器里已登录的
OpenStreetMap 账号。AI 客户端可以通过这些工具：

- 在网页编辑器里画点、画道路、画闭合面，读取和修改 OSM 标签；
- 绘制公交线路：添加公交站、创建 `type=route, route=bus` 关系、追加关系成员；
- 把口语描述解析成坐标并落图：`geocode` 把站名/街道名转成经纬度，再交给
  `set_map_view`、`add_way`、`add_bus_stop`；
- 规范化修改：`normalize_tags` 清理空标签和全角字符，`suggest_tags` 调用网页版
  AI 标签助手给出带来源的规范标签；
- 用网页账号上传 changeset（需要人工确认和登录）。

## 快速开始

要求：Node.js 22+、pnpm，以及一个可以打开的 BetteriD 网页（本地
`http://127.0.0.1:9178/id/` 或线上 `https://map.osm.asia/id/`）。

```bash
cd mcp
pnpm install
pnpm browsers:install
pnpm build
```

启动（stdio，供 MCP 客户端拉起）：

```bash
OSM_WEB_URL=http://127.0.0.1:9178 node dist/index.js
```

首次登录：启动后在 AI 客户端里调用 `login`，浏览器会弹出 OpenStreetMap OAuth
登录窗口。登录状态保存在 `mcp/.browser-profile/`，之后重启 MCP 无需重复登录。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `OSM_WEB_URL` | `http://127.0.0.1:9178` | BetteriD 网页版地址 |
| `OSM_MCP_EDITOR_PATH` | `/id/` | 编辑器路径；本地 Node dev server 可设为 `/` |
| `OSM_MCP_HEADLESS` | `false` | `1`/`true` 使用无头浏览器 |
| `OSM_MCP_PROFILE_DIR` | `mcp/.browser-profile` | Chromium 持久化配置，保存登录态 |
| `OSM_MCP_TIMEOUT_MS` | `180000` | 页面加载、登录等待、保存上传超时 |
| `OSM_MCP_VIEWPORT` | `1280,800` | 浏览器窗口尺寸 |
| `OSM_MCP_NOMINATIM_URL` | `https://nominatim.openstreetmap.org` | geocode 服务地址 |

## 工具

编辑器控制：

| 工具 | 用途 |
| --- | --- |
| `open_editor` | 打开编辑器并定位到指定经纬度/缩放 |
| `get_editor_state` | 视图、模式、选中项、未保存修改数、账号 |
| `set_map_view` | 移动地图 |
| `screenshot` | 截图 + 状态，供 AI 观察画面 |
| `get_account` / `login` | 检查账号、触发 OSM 登录 |

绘图与标签：

| 工具 | 用途 |
| --- | --- |
| `add_point` | 添加带标签的节点 |
| `add_way` | 按经纬度绘制道路或闭合面 |
| `set_tags` | 规范化并写入标签 |
| `normalize_tags` | 纯本地标签清理（空值、全角字符） |
| `list_entities` / `get_entity` | 查询视口内要素，挑选线路途经道路 |
| `select_entity` | 选中并缩放到实体 |
| `undo` / `redo` | 撤销/重做 |
| `get_changes` | 未保存修改汇总 |
| `save_changes` | 用网页账号上传 changeset |

公交线路：

| 工具 | 用途 |
| --- | --- |
| `add_bus_stop` | 添加 `highway=bus_stop` 标准化公交站 |
| `create_bus_route_relation` | 创建 `type=route, route=bus` 关系 |
| `add_relation_member` | 向线路关系追加道路/站点成员 |

描述转地图与规范化：

| 工具 | 用途 |
| --- | --- |
| `geocode` | 站名/街道名 → 经纬度候选 |
| `suggest_tags` | 调用网页版 AI 标签助手，返回带来源的规范标签 |

## 公交线路示例工作流

```text
1. geocode("人民广场公交站") → 得到经纬度候选
2. set_map_view(lat, lon, 18)  # 放大到目标区域
3. list_entities(tags: {highway: "*"})  # 找到线路途经道路
4. add_bus_stop(lat, lon, name="人民广场", ref="3路")
5. add_way(points=[...], tags={highway: "busway"})  # 如有缺路再补画
6. create_bus_route_relation(
     name="3路", ref="3路", from="东站", to="西站",
     way_ids=[...], stop_ids=[...])
7. screenshot()  # AI 检查
8. get_changes()
9. save_changes(comment="添加 3 路公交线路", source="survey")
```

口语描述（例如“从东河路出发，路过两个站到西站”）由 AI 客户端先解析成上述结构化
参数，MCP 负责地理编码、绘图和上传。上传前请务必让用户复核，遵守
[OpenStreetMap 贡献条款](https://www.openstreetmap.org/copyright)。

## MCP 客户端配置示例

Claude Desktop / 其他 stdio 客户端：

```json
{
  "mcpServers": {
    "betterid-web-editor": {
      "command": "node",
      "args": ["/path/to/osm/mcp/dist/index.js"],
      "env": {
        "OSM_WEB_URL": "http://127.0.0.1:9178"
      }
    }
  }
}
```

## 验证

```bash
cd mcp
pnpm build
pnpm test
```

`scripts/smoke.mjs` 是一个端到端冒烟脚本：通过 MCP stdio 连接服务器、打开线上
网页编辑器、画一条路、截图并撤销（不会保存任何真实 OSM 数据）：

```bash
node scripts/smoke.mjs
```

## 安全说明

- `save_changes` 会真实上传到 OpenStreetMap，使用前必须人工确认；
- 浏览器持久化配置目录包含 OSM 登录令牌，不要提交到 Git；
- `geocode` 使用 Nominatim 公共服务，注意使用量和服务条款；
- 绘图结果只写入浏览器编辑历史，撤销、关闭页面或 `undo` 可回退，上传前不会影响
  线上数据。
