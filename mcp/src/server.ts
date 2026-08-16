import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { BetterIdApi } from './api.js';
import { BetterIdBrowser } from './browser.js';
import {
  buildBusRouteTags,
  buildBusStopTags,
  defaultMemberRole,
  normalizeTags,
  type Tags
} from './normalize.js';

const tagsSchema = z.record(z.string(), z.string());
const providerOrder = z.array(z.string().trim().min(1).max(32)).max(8).optional();
const pointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180)
});
const bboxSchema = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
  z.number().min(-180).max(180),
  z.number().min(-90).max(90)
]);

const viewSchema = z
  .object({
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    zoom: z.number().min(1).max(22).optional()
  })
  .refine(
    (value) =>
      (value.lat === undefined && value.lon === undefined && value.zoom === undefined) ||
      (value.lat !== undefined && value.lon !== undefined && value.zoom !== undefined),
    {
      message: 'lat、lon、zoom 需要同时提供',
      path: ['view']
    }
  );

function textResult(data: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export interface BetterIdMcpServerOptions {
  browser: BetterIdBrowser;
  api: BetterIdApi;
}

export class BetterIdMcpServer {
  private readonly browser: BetterIdBrowser;
  private readonly api: BetterIdApi;

  constructor(options: BetterIdMcpServerOptions) {
    this.browser = options.browser;
    this.api = options.api;
  }

  register(server: McpServer): void {
    server.registerTool(
      'open_editor',
      {
        title: 'Open BetteriD editor',
        description:
          '打开 BetteriD 网页编辑器，可定位到指定经纬度和缩放级别，并返回当前视图、模式、未保存修改数和登录账号。',
        inputSchema: viewSchema
      },
      async (input) => {
        const view =
          input.lat !== undefined && input.lon !== undefined && input.zoom !== undefined
            ? { lat: input.lat, lon: input.lon, zoom: input.zoom }
            : undefined;
        return textResult(await this.browser.ensureOpen(view));
      }
    );

    server.registerTool(
      'get_editor_state',
      {
        title: 'Get editor state',
        description:
          '读取网页编辑器当前状态：地图中心/缩放/范围、模式、选中实体、未保存修改数和 OSM 登录账号。'
      },
      async () => textResult(await this.browser.ensureOpen())
    );

    server.registerTool(
      'set_map_view',
      {
        title: 'Set map view',
        description: '移动网页编辑器地图到指定经纬度和缩放级别。',
        inputSchema: z.object({
          lat: z.number().min(-90).max(90),
          lon: z.number().min(-180).max(180),
          zoom: z.number().min(1).max(22)
        })
      },
      async ({ lat, lon, zoom }) => textResult(await this.browser.setView(lat, lon, zoom))
    );

    server.registerTool(
      'screenshot',
      {
        title: 'Screenshot editor',
        description:
          '截取网页编辑器当前画面并附上编辑器状态，供 AI 观察地图、已绘制道路和选中效果。'
      },
      async () => {
        await this.browser.ensureOpen();
        const [state, png] = await Promise.all([
          this.browser.getState(),
          this.browser.screenshot()
        ]);
        return {
          content: [
            { type: 'text', text: JSON.stringify(state, null, 2) },
            { type: 'image', data: png.toString('base64'), mimeType: 'image/png' }
          ]
        };
      }
    );

    server.registerTool(
      'get_account',
      {
        title: 'Get OSM account',
        description: '检查网页编辑器当前登录的 OpenStreetMap 账号。'
      },
      async () => textResult(await this.browser.ensureOpen().then(() => this.browser.getAccount()))
    );

    server.registerTool(
      'login',
      {
        title: 'Login to OSM',
        description:
          '触发 OpenStreetMap OAuth 登录弹窗并等待账号生效。首次使用请在浏览器窗口里完成人工登录，之后账号会保存在浏览器配置目录中。'
      },
      async () => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.login());
      }
    );

    server.registerTool(
      'add_point',
      {
        title: 'Add point',
        description: '在指定经纬度添加一个带标签的节点（例如 POI 或公交站）。',
        inputSchema: z.object({
          lat: z.number().min(-90).max(90),
          lon: z.number().min(-180).max(180),
          tags: tagsSchema.optional(),
          normalize: z.boolean().default(true)
        })
      },
      async ({ lat, lon, tags, normalize }) => {
        await this.browser.ensureOpen();
        const clean = tags ? (normalize ? normalizeTags(tags).tags : tags) : {};
        return textResult({
          id: await this.browser.addPoint(lat, lon, clean)
        });
      }
    );

    server.registerTool(
      'add_way',
      {
        title: 'Add way',
        description:
          '按经纬度顺序绘制一条道路或闭合面，支持设置标签；可用于画公交线路途经道路、地块或建筑轮廓。',
        inputSchema: z.object({
          points: z.array(pointSchema).min(2).max(500),
          tags: tagsSchema.optional(),
          closed: z.boolean().default(false),
          normalize: z.boolean().default(true)
        })
      },
      async ({ points, tags, closed, normalize }) => {
        await this.browser.ensureOpen();
        const clean = tags ? (normalize ? normalizeTags(tags).tags : tags) : {};
        return textResult(await this.browser.addWay(points, clean, closed));
      }
    );

    server.registerTool(
      'add_bus_stop',
      {
        title: 'Add bus stop',
        description:
          '添加标准化的公交站节点（highway=bus_stop），可带站名、线路号和其他标签，返回新节点 ID。',
        inputSchema: z.object({
          lat: z.number().min(-90).max(90),
          lon: z.number().min(-180).max(180),
          name: z.string().trim().min(1),
          ref: z.union([z.string(), z.number()]).optional(),
          extra_tags: tagsSchema.optional()
        })
      },
      async ({ lat, lon, name, ref, extra_tags }) => {
        await this.browser.ensureOpen();
        const tags = buildBusStopTags(name, ref, extra_tags);
        return textResult({
          id: await this.browser.addBusStop(lat, lon, tags),
          tags
        });
      }
    );

    server.registerTool(
      'create_bus_route_relation',
      {
        title: 'Create bus route relation',
        description:
          '用已存在的道路和公交站创建 OSM 公交线路关系（type=route, route=bus），道路角色为空、站点角色默认 stop。',
        inputSchema: z.object({
          way_ids: z.array(z.string().trim().min(1)).max(500),
          stop_ids: z.array(z.string().trim().min(1)).max(500),
          name: z.string().trim().min(1),
          ref: z.union([z.string(), z.number()]).optional(),
          from: z.string().trim().optional(),
          to: z.string().trim().optional(),
          operator: z.string().trim().optional(),
          network: z.string().trim().optional(),
          colour: z.string().trim().optional(),
          stop_role: z.enum(['stop', 'platform', '']).default('stop'),
          extra_tags: tagsSchema.optional()
        })
      },
      async (input) => {
        await this.browser.ensureOpen();
        const tags = buildBusRouteTags(input);
        return textResult({
          id: await this.browser.createBusRouteRelation(
            {
              way_ids: input.way_ids,
              stop_ids: input.stop_ids,
              stop_role: input.stop_role
            },
            tags
          ),
          tags
        });
      }
    );

    server.registerTool(
      'add_relation_member',
      {
        title: 'Add relation member',
        description: '把道路或站点加入现有公交线路关系，可指定 role（stop/platform/空字符串）。',
        inputSchema: z.object({
          relation_id: z.string().trim().min(1),
          member_id: z.string().trim().min(1),
          role: z.string().trim().max(64).default('')
        })
      },
      async ({ relation_id, member_id, role }) => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.addRelationMember(relation_id, member_id, role));
      }
    );

    server.registerTool(
      'list_entities',
      {
        title: 'List entities',
        description:
          '列出当前视口或指定范围内已加载的 OSM 要素（道路、公交站、POI 等），可按键值过滤，用于挑选公交线路途经道路。',
        inputSchema: z.object({
          bbox: bboxSchema.optional(),
          tags: tagsSchema.optional(),
          max: z.number().int().min(1).max(500).default(200)
        })
      },
      async (input) => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.listEntities(input));
      }
    );

    server.registerTool(
      'get_entity',
      {
        title: 'Get entity',
        description: '读取单个实体的完整信息，道路会附带所有节点经纬度，关系会附带成员列表。',
        inputSchema: z.object({ id: z.string().trim().min(1) })
      },
      async ({ id }) => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.getEntity(id));
      }
    );

    server.registerTool(
      'select_entity',
      {
        title: 'Select entity',
        description: '选中编辑器中的实体并默认缩放到它，便于继续修改或截图确认。',
        inputSchema: z.object({
          id: z.string().trim().min(1),
          zoom_to: z.boolean().default(true)
        })
      },
      async ({ id, zoom_to }) => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.selectEntity(id, zoom_to));
      }
    );

    server.registerTool(
      'set_tags',
      {
        title: 'Set entity tags',
        description:
          '规范化并写入实体的 OSM 标签（可覆盖现有标签），默认会自动清理空值和全角字符。',
        inputSchema: z.object({
          id: z.string().trim().min(1),
          tags: tagsSchema,
          normalize: z.boolean().default(true)
        })
      },
      async ({ id, tags, normalize }) => {
        await this.browser.ensureOpen();
        const clean = normalize ? normalizeTags(tags).tags : tags;
        return textResult(await this.browser.setTags(id, clean));
      }
    );

    server.registerTool(
      'normalize_tags',
      {
        title: 'Normalize OSM tags',
        description:
          '纯本地规范化标签：去掉空键空值、修正全角字符，返回清理结果和被移除的键，不改动编辑器。',
        inputSchema: z.object({ tags: tagsSchema })
      },
      async ({ tags }) => textResult(normalizeTags(tags))
    );

    server.registerTool(
      'undo',
      { title: 'Undo last edit', description: '撤销网页编辑器中的上一步修改。' },
      async () => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.undo());
      }
    );

    server.registerTool(
      'redo',
      { title: 'Redo last edit', description: '重做网页编辑器中被撤销的上一步修改。' },
      async () => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.redo());
      }
    );

    server.registerTool(
      'get_changes',
      {
        title: 'Get unsaved changes',
        description: '查看网页编辑器中尚未上传的修改：新建、修改、删除的要素 ID 与数量。'
      },
      async () => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.getChanges());
      }
    );

    server.registerTool(
      'save_changes',
      {
        title: 'Save changes',
        description:
          '用网页账号把当前修改上传到 OpenStreetMap。需要 comment；可选 source 和 hashtags。未登录会报错。',
        inputSchema: z.object({
          comment: z.string().trim().min(1).max(255),
          source: z.string().trim().max(255).optional(),
          hashtags: z.array(z.string().trim().min(1)).max(10).optional()
        })
      },
      async ({ comment, source, hashtags }) => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.saveChanges(comment, source, hashtags));
      }
    );

    server.registerTool(
      'geocode',
      {
        title: 'Geocode place or street',
        description:
          '把口语描述中的地名、街道名、站点名解析成经纬度候选，供后续 set_map_view / add_way / add_bus_stop 使用。',
        inputSchema: z.object({
          query: z.string().trim().min(1),
          limit: z.number().int().min(1).max(5).default(5)
        })
      },
      async ({ query, limit }) => textResult(await this.api.geocode(query, limit))
    );

    server.registerTool(
      'suggest_tags',
      {
        title: 'Suggest OSM tags',
        description:
          '调用 BetteriD 网页版 AI 标签助手，根据描述、现有标签、几何类型和位置返回带来源的规范化 OSM 标签建议。',
        inputSchema: z.object({
          description: z.string().trim().min(1).max(4000),
          tags: tagsSchema.optional(),
          geometry: z.string().trim().min(1).max(64).optional(),
          location: pointSchema.optional(),
          locale: z.string().trim().min(2).max(35).optional(),
          provider_order: providerOrder,
          text_provider_order: providerOrder
        })
      },
      async (input) => {
        const state = await this.browser.ensureOpen();
        const location =
          input.location ?? { lat: state.view.center[1], lon: state.view.center[0] };
        return textResult(
          await this.api.suggestTags({
            description: input.description,
            tags: input.tags,
            geometry: input.geometry,
            location,
            locale: input.locale ?? 'zh-CN',
            provider_order: input.provider_order,
            text_provider_order: input.text_provider_order
          })
        );
      }
    );
  }
}
