# BetteriD 插件

插件是编辑器启动后加载的小模块。市场清单是仓库里的 [`data/plugins/marketplace.json`](../data/plugins/marketplace.json)，编辑器把它打进前端，不另发请求。

## 安装

打开 **偏好设置 → 插件**。可以安装清单里的插件，也可以粘贴一份自己的 JSON。远程入口只会在你按下安装之后加载，而且必须是 `https://`，或者 `http://127.0.0.1` / `http://localhost`。停用会在下次重新打开 BetteriD 时生效。

插件和编辑器跑在同一个页面里，能读写地图。只安装你信任的入口。

## 把插件放进市场

市场是一份人工整理的清单。要加入它，向本仓库提交一个拉取请求，在 `data/plugins/marketplace.json` 的 `plugins` 数组里加一条：

```json
{
  "id": "example.buildings",
  "name": "短名称",
  "description": "一两句说明它做什么。",
  "icon": "data:image/svg+xml,... 或 https:// 图片地址",
  "version": "1.0.0",
  "author": "你的名字",
  "license": "ISC",
  "homepage": "https://github.com/you/your-plugin",
  "entry": "https://cdn.example.com/betterid-plugin.js"
}
```

字段：

| 字段 | 要求 |
| --- | --- |
| `id` | 短标识，字母数字和 `.` `_` `-`，全清单唯一 |
| `name` | 显示名称 |
| `description` | 简短说明 |
| `icon` | 小图标，data URI 或 https 地址 |
| `version` `author` `license` `homepage` | 版本和来源信息 |
| `entry` | 远程模块 URL，必须导出 `setup(api)` 或 `default` |
| `builtin` | 可选。仓库内置模块的名字，目前只有示例 `hello`。有 `builtin` 时不需要 `entry` |

`setup(api)` 收到 `{ context, plugin, prefs }`。`context` 是 iD 的编辑上下文。示例见 [`modules/plugins/hello.js`](../modules/plugins/hello.js)。

审查时会看插件是否只做说明里写的事，以及入口是否还在。合并之后，下一次编辑器构建就会带上这条清单。
