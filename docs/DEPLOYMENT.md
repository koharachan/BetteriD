# 生产部署（Self-hosted）

本文档描述 BetteriD 线上实例的部署方式：一个容器同时承担编辑器静态资源、
OpenStreetMap 同源代理、OAuth 回调、AI 与翻译接口。文档只写通用流程与占位符，
**任何主机地址、端口映射、面板账号和密码都不得写进仓库**。

## 拓扑

```text
浏览器 ──TLS──▶ 边缘 / CDN（终止 TLS，注入 X-Forwarded-*）
                    │  纯 HTTP 回源
                    ▼
              betterid 容器（宿主机 9178）
                    ├── /id/               编辑器（dist/）
                    ├── /id/land.html      OAuth 回调页
                    ├── /                 上游 OSM 页面与瓦片代理
                    └── /api/osm-ai/*     翻译 / AI / 照片接口
```

- 容器内进程为 `p/` 编译出的 `osm`，默认监听 `0.0.0.0:9178`。
- 边缘层负责证书与缓存；回源使用明文 HTTP，回源地址必须与
  `OSM_OAUTH_REDIRECT_URI` 使用的域名一致。
- 缓存目录与已审核照片目录挂载到宿主机，容器重建不丢数据。
- 单实例足够：状态都在宿主机卷和上游 OSM 上，容器本身无状态。

## 前置条件

- Node.js 22+ 与 pnpm `10.28.2`（构建 `dist/`）
- Docker 或 Podman（部署容器）
- 一个已注册的 OpenStreetMap OAuth 2 应用，回调地址与线上域名一致
- 至少一个文本提供商密钥（`DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `MIMO_*`）

## 性能与静态资源

生产构建要把预设与名称索引指向自己的源站（浏览器不再跨境外请求 jsDelivr，
数据经过 CDN 缓存与 Brotli 压缩）：

```bash
ID_PRESETS_CDN_URL='https://<domain>/id/dist/tagging-schema/' \
ID_NSI_CDN_URL='https://<domain>/id/dist/nsi/' \
pnpm run all
```

- 预设来自 `node_modules/@openstreetmap/id-tagging-schema`（`scripts/build_data.js`
  在 URL 不是相对检出路径时改用本地包），名称索引由 `pnpm run dist:nsi` 复制到
  `dist/nsi/`（同一个 `dist:*` 管线，构建产物不入库）。
- 代理对文本类静态资源做 Brotli / gzip（`Accept-Encoding` 决定，`Vary` 标出），
  `?v=` 版本化的资源返回 `max-age=604800, immutable`；效果例如
  `iD.min.js` 2.16MB → 600KB、`nsi.min.json` 12.2MB → 1.5MB。
- 边缘（CDN）侧确认：静态资源命中缓存、压缩已开启、动态接口（`/api/*`）因上游
  `no-store` 不被缓存；`json|xml` 规则缓存 7 天可减少大文件回源。

## 构建与发布

1. 在仓库根目录产出编辑器静态资源：

   ```bash
   pnpm install --frozen-lockfile
   pnpm run all
   ```

2. 构建镜像。镜像定义在仓库根目录的 `Dockerfile`（多阶段：`rust:1.97-bookworm` 编译 `p/`，
   再拷进 `debian:bookworm-slim` 并带上 `dist/`、`index.html`、`land.html`）。

   ```bash
   docker build -t betterid:latest .
   ```

   没有 Docker 的构建机也可以在服务器上用 Podman 构建，只需要把构建上下文
   （`Dockerfile`、`p/`、`dist/`、`index.html`、`land.html`）传上去：

   ```bash
   podman build -t betterid:latest .
   ```

3. 迁移已有实例时可以直接搬镜像，避免在目标机装 Rust 工具链：

   ```bash
   docker save betterid:latest | gzip -1 > betterid-image.tar.gz
   # 传送到目标机后
   gunzip -c betterid-image.tar.gz | docker load
   ```

## 运行容器

密钥只放在宿主机的 env 文件里（`chmod 600`），不要写进镜像或仓库：

```bash
install -d -m 700 /opt/betterid/{cache,photo-uploads}
umask 077
cat > /opt/betterid/betterid.env <<'ENV'
OSM_LISTEN_ADDR=0.0.0.0:9178
OSM_ID_DIST_DIR=/app/dist
OSM_CACHE_DIR=/app/cache
OSM_PHOTO_UPLOAD_DIR=/app/photo-uploads
OSM_OAUTH_CLIENT_ID=<public client id>
OSM_OAUTH_REDIRECT_URI=https://<domain>/callback
DEEPSEEK_API_KEY=<provider key>
BING_TRANSLATE_API_KEY=
BING_TRANSLATE_REGION=
# 隐私编辑（可选）：由服务器持有的匿名 OSM 账号代传改动
OSM_PRIVACY_CLIENT_ID=<oauth client id>
OSM_PRIVACY_ACCESS_TOKEN=<oauth access token>
OSM_PRIVACY_REFRESH_TOKEN=<optional refresh token>
ENV
chmod 600 /opt/betterid/betterid.env
```

```bash
docker run -d --name betterid --restart=always \
  --network=host \
  --env-file /opt/betterid/betterid.env \
  -v /opt/betterid/cache:/app/cache \
  -v /opt/betterid/photo-uploads:/app/photo-uploads \
  betterid:latest
```

要点：

- `--network=host` 让容器直接绑定宿主 9178。**某些宿主机把 FORWARD 链策略设为
  DROP**，此时 `-p 9178:9178` 的 DNAT 发布端口在外部完全不可达（宿主机内部
  `curl 127.0.0.1:9178` 却正常），排查方法是同时对比一个宿主进程直接监听的端口
  与容器发布端口的外部连通性。用宿主网络可绕开这类防火墙差异。
- `--restart=always` 配合 `podman-restart.service`（`systemctl enable --now
  podman-restart.service`）保证重启后容器自动拉起。
- 挂载目录属主需要与容器内进程一致，SELinux 主机加 `:Z`。
- 反向代理/CDN 若下发 `X-Forwarded-For`，只有确认每一跳都可信时才把它加入
  `OSM_TRUSTED_PROXY_IPS`。

## 边缘层与回源切换

线上入口有两种可行形态，二选一：

1. **CDN / 边缘代理**：域名解析到边缘节点，边缘终止 TLS 并回源到
   `<origin host>:9178`。切换服务器时，在 CDN 面板把回源地址改成新主机即可，
   证书无需变动。
2. **直连主机**：把域名 A 记录直接指向目标主机，然后在主机上跑一层反向代理
   （Caddy/Nginx）签发证书并转发到 `127.0.0.1:9178`；需要放通 80/443。

无论哪种形态，回源都走明文 HTTP，因此不要把 `OSM_LISTEN_ADDR` 暴露成需要
额外 TLS 的形态。

## 上线检查清单

切流前在**外部网络**逐项验证（源机 curl 目标机，避免只测本机回环）：

```bash
B=http://<origin host>:9178
curl -s $B/api/osm-ai/status                 # {"ai":true,...}
curl -s -o /dev/null -w '%{http_code}\n' $B/id/
curl -s -o /dev/null -w '%{http_code}\n' $B/id/dist/iD.min.js
curl -s -o /dev/null -w '%{http_code}\n' $B/id/dist/locales/zh.min.json
curl -s -o /dev/null -w '%{http_code}\n' $B/id/land.html
```

新旧实例的同名路径应返回相同状态码（例如两者对不存在的 `dist/data/*.json`
同为 404 才是正常对齐）。随后切换边缘回源，确认：

- 首页 `/id/` 编辑器可加载，`/api/osm-ai/status` 返回 `deepseek` 等已配置提供商；
- OSM 登录跳转与 `/callback` 回调成功（回调域名必须与 OAuth 应用注册值一致）；
- 瓦片与 OSM 页面代理正常，无 403/429。

确认线上稳定后再停掉旧实例；回滚只需把边缘回源地址改回旧主机。

## 密钥管理

- `.env` / `betterid.env` 只存在于服务器，权限 `600`，永不提交、永不进镜像。
- 仓库内只保留 `p/.env.example` 这类占位文件。
- 提交前用 `git grep -I -E 'sk-[A-Za-z0-9_-]{20,}'` 自查；如曾在聊天、工单或
  日志里暴露过密钥，直接轮换，不要依赖删除历史。
- 主机地址、SSH 端口、面板密码同样按凭据处理：只写在本地忽略文件里，
  文档一律用 `<origin host>` 之类的占位符。

## 更新流程

1. 拉取目标版本，`pnpm run all` 重建 `dist/`；
2. `docker build -t betterid:<version> .`，本地起一个非 9178 端口冒烟；
3. 传送镜像到生产机 `docker load`；
4. `docker rm -f betterid` 后用同一 `--env-file` 与挂载重新 `docker run`；
5. 按上线检查清单复验，出现异常立即切回上一个镜像 tag。
