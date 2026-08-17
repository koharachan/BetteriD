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

    server.registerTool(
      'get_validation_issues',
      {
        title: 'Get validation issues',
        description:
          '运行 BetteriD 网页编辑器内置的 20+ 条校验规则（如 missing_tag、crossing_ways、disconnected_way、unsquare_way 等），返回当前视口或已编辑要素的校验问题，含严重级别、类型、说明和涉及的要素 ID。what=edited 只查用户修改过的要素，what=all 包含下载数据中既有问题；where=visible 只查当前视口。',
        inputSchema: z.object({
          what: z.enum(['all', 'edited']).default('edited'),
          where: z.enum(['all', 'visible']).default('all')
        })
      },
      async ({ what, where }) =>
        textResult(await this.browser.getValidationIssues(what, where))
    );

    server.registerTool(
      'auto_fix_issues',
      {
        title: 'Auto-fix validation issues',
        description:
          '把编辑器判定为"自动安全"的校验问题（如无效 URL、过期标签升级）批量修复为一个历史步骤。只应用编辑器明确标记 autoSafe 的修复，不会做需要用户决策的操作。返回修复数量和类型。',
        inputSchema: z.object({
          what: z.enum(['all', 'edited']).default('edited')
        })
      },
      async ({ what }) => textResult(await this.browser.autoFixIssues(what))
    );

    server.registerTool(
      'ignore_validation_issue',
      {
        title: 'Ignore validation issue',
        description: '把指定校验问题标记为已忽略，问题列表不再显示（可配合 get_validation_issues 返回的 id 使用）。',
        inputSchema: z.object({
          issue_id: z.string().trim().min(1)
        })
      },
      async ({ issue_id }) => textResult(await this.browser.ignoreValidationIssue(issue_id))
    );

    server.registerTool(
      'split_way',
      {
        title: 'Split way at nodes',
        description:
          '在指定的一个或多个节点处拆分道路（支持在多个道路共用的节点处只拆选中道路，用 way_ids 限定）。返回拆分后的编辑器状态。',
        inputSchema: z.object({
          node_ids: z.array(z.string().trim().min(1)).min(1).max(50),
          way_ids: z.array(z.string().trim().min(1)).max(50).optional()
        })
      },
      async ({ node_ids, way_ids }) => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.splitWay(node_ids, way_ids));
      }
    );

    server.registerTool(
      'join_ways',
      {
        title: 'Join ways',
        description: '把首尾相连的多条道路合并为一条（自动处理方向，保留最早创建的要素 ID）。',
        inputSchema: z.object({
          way_ids: z.array(z.string().trim().min(1)).min(2).max(100)
        })
      },
      async ({ way_ids }) => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.joinWays(way_ids));
      }
    );

    server.registerTool(
      'merge_nodes',
      {
        title: 'Merge nodes',
        description: '把多个节点合并为一个（清理重复节点），默认取带标签的节点位置或平均位置。',
        inputSchema: z.object({
          node_ids: z.array(z.string().trim().min(1)).min(2).max(100)
        })
      },
      async ({ node_ids }) => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.mergeNodes(node_ids));
      }
    );

    server.registerTool(
      'straighten_way',
      {
        title: 'Straighten way',
        description: '把选中道路拉直为最佳拟合直线（可用于修正画歪的路段）。',
        inputSchema: z.object({
          way_ids: z.array(z.string().trim().min(1)).min(1).max(50)
        })
      },
      async ({ way_ids }) => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.straightenWay(way_ids));
      }
    );

    server.registerTool(
      'orthogonalize_way',
      {
        title: 'Orthogonalize way',
        description: '把闭合面（如建筑轮廓）的角修正为直角，用于规整建筑、地块等。',
        inputSchema: z.object({
          way_id: z.string().trim().min(1)
        })
      },
      async ({ way_id }) => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.orthogonalizeWay(way_id));
      }
    );

    server.registerTool(
      'circularize_way',
      {
        title: 'Circularize way',
        description: '把闭合道路修整为圆形（适用于环岛、转盘等）。',
        inputSchema: z.object({
          way_id: z.string().trim().min(1)
        })
      },
      async ({ way_id }) => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.circularizeWay(way_id));
      }
    );

    server.registerTool(
      'reverse_way',
      {
        title: 'Reverse way',
        description: '反转道路方向并自动修正方向相关标签（left/right、forward/backward 等），用于纠正单行道方向。',
        inputSchema: z.object({
          way_id: z.string().trim().min(1)
        })
      },
      async ({ way_id }) => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.reverseWay(way_id));
      }
    );

    server.registerTool(
      'disconnect_way',
      {
        title: 'Disconnect ways at node',
        description: '在指定节点处断开所有共享该节点的道路（glue 的逆操作），用于分离本应不连通的道路。',
        inputSchema: z.object({
          node_id: z.string().trim().min(1)
        })
      },
      async ({ node_id }) => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.disconnectNode(node_id));
      }
    );

    server.registerTool(
      'extract_entity',
      {
        title: 'Extract entity',
        description:
          '提取要素：把地址信息从"仅地址的建筑"提取到新地址节点，或把 POI 与地址拆分为独立要素。用于拆分混在一起的地址与建筑物。',
        inputSchema: z.object({
          entity_id: z.string().trim().min(1)
        })
      },
      async ({ entity_id }) => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.extractEntity(entity_id));
      }
    );

    server.registerTool(
      'delete_entities',
      {
        title: 'Delete entities',
        description: '删除指定的一个或多个要素（删除道路会连带删除孤立的子节点）。此操作不可直接撤销之外的恢复，请谨慎。',
        inputSchema: z.object({
          entity_ids: z.array(z.string().trim().min(1)).min(1).max(200)
        })
      },
      async ({ entity_ids }) => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.deleteEntities(entity_ids));
      }
    );

    server.registerTool(
      'order_route_members',
      {
        title: 'Order route relation members',
        description:
          '用编辑器几何引擎把公交线路关系的道路成员按连接顺序排好（自动反转方向、把断开的线段分成多段），站点成员保持相对顺序，然后重写关系成员顺序。返回排序后的轨迹供核对。',
        inputSchema: z.object({
          relation_id: z.string().trim().min(1)
        })
      },
      async ({ relation_id }) => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.orderRouteMembers(relation_id));
      }
    );

    server.registerTool(
      'trace_route',
      {
        title: 'Trace route relation',
        description:
          '只读地追踪公交线路关系：返回按几何连接排序的道路序列（含节点数和长度）、站点列表，以及是否存在断开的线段。用于检查线路完整性。',
        inputSchema: z.object({
          relation_id: z.string().trim().min(1)
        })
      },
      async ({ relation_id }) => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.traceRoute(relation_id));
      }
    );

    server.registerTool(
      'review_changes',
      {
        title: 'Review unsaved changes',
        description:
          '逐要素列出未保存修改的前后对比：新建/修改/删除、标签差异（新增/变更/移除）、几何是否变化。上传前先调用它核对。',
        inputSchema: z.object({})
      },
      async () => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.reviewChanges());
      }
    );

    server.registerTool(
      'snapshot',
      {
        title: 'Snapshot editor history',
        description: '给编辑器历史打一个快照标记，之后可用 restore_snapshot 一键回滚到此刻（撤销所有后续修改）。',
        inputSchema: z.object({
          key: z.string().trim().min(1).max(64).default('mcp')
        })
      },
      async ({ key }) => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.snapshot(key));
      }
    );

    server.registerTool(
      'restore_snapshot',
      {
        title: 'Restore editor snapshot',
        description: '回滚编辑器历史到指定快照（撤销快照之后的所有修改）。谨慎使用，会丢弃之后的编辑。',
        inputSchema: z.object({
          key: z.string().trim().min(1).max(64).default('mcp')
        })
      },
      async ({ key }) => {
        await this.browser.ensureOpen();
        return textResult(await this.browser.restoreSnapshot(key));
      }
    );

    server.registerTool(
      'translate_name',
      {
        title: 'Translate name to multiple languages',
        description:
          '用 BetteriD 网页版 AI 翻译把名称翻译成多个语言（默认 zh、zh-Hant、en），返回每种语言的 name:lang 标签值，供 apply 到实体。',
        inputSchema: z.object({
          text: z.string().trim().min(1).max(4000),
          target_langs: z.array(z.string().trim().min(2).max(35)).min(1).max(8).optional(),
          provider_order: providerOrder
        })
      },
      async ({ text, target_langs, provider_order }) =>
        textResult(
          await this.api.translate({
            text,
            target_langs: target_langs ?? ['zh', 'zh-Hant', 'en'],
            provider_order
          })
        )
    );

    server.registerTool(
      'summarize_changes',
      {
        title: 'Summarize changes with AI',
        description:
          '调用 BetteriD 网页版 AI 总结当前未保存修改，生成一句不超过 80 字的中文 changeset 注释，可直接作为 save_changes 的 comment。',
        inputSchema: z.object({
          provider_order: providerOrder
        })
      },
      async ({ provider_order }) => {
        await this.browser.ensureOpen();
        const review = await this.browser.reviewChanges();
        const summary = {
          total: review.count,
          created: review.diffs.filter((d) => d.action === 'created').map((d) => ({
            id: d.id,
            type: d.type,
            name: d.name_after,
            tags: d.tags_after
          })),
          modified: review.diffs.filter((d) => d.action === 'modified').map((d) => ({
            id: d.id,
            type: d.type,
            name: d.name_before ?? d.name_after,
            tag_changes: d.tag_changes
          })),
          deleted: review.diffs.filter((d) => d.action === 'deleted').map((d) => ({
            id: d.id,
            type: d.type,
            name: d.name_before
          }))
        };
        return textResult(await this.api.summarize({ summary, provider_order }));
      }
    );
  }
}
