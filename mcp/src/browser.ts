import { promises as fs } from 'node:fs';

import { chromium, type BrowserContext, type Page } from 'playwright';

import type { Tags } from './normalize.js';
import { buildEditorUrl, type MapViewInput } from './urls.js';

export interface AccountState {
  authenticated: boolean;
  display_name?: string;
  uid?: number;
  error?: string;
}

export interface MapView {
  center: [number, number];
  zoom: number;
  bbox: [number, number, number, number];
}

export interface EditorState {
  view: MapView;
  mode: string | null;
  selectedIDs: string[];
  changes: number;
  account: AccountState;
}

export interface EntityInfo {
  id: string;
  type: 'node' | 'way' | 'relation';
  tags: Tags;
  geometry?: string;
  loc?: [number, number];
  nodes?: string[];
  members?: { type: 'node' | 'way' | 'relation'; id: string; role?: string }[];
  center?: [number, number];
  nodeCount?: number;
  memberCount?: number;
  points?: [number, number][];
}

export interface ChangeSummary {
  count: number;
  created: string[];
  modified: string[];
  deleted: string[];
}

/** A single validation issue reported by the editor's built-in validators. */
export interface ValidationIssue {
  id: string;
  type: string;
  subtype?: string;
  severity: 'error' | 'warning' | 'suggestion';
  message: string;
  entityIds: string[];
  loc?: [number, number];
  fixes: { title: string; autoSafe: boolean; icon?: string; entityIds: string[] }[];
}

export interface AutofixResult {
  count: number;
  fixed: string[];
  annotation: string;
}

/** Before/after diff of a single changed entity. */
export interface EntityDiff {
  id: string;
  type: 'node' | 'way' | 'relation';
  action: 'created' | 'modified' | 'deleted';
  geometry_changed: boolean;
  tags_before: Tags;
  tags_after: Tags;
  tag_changes: { added: [string, string][]; changed: [string, string, string][]; removed: string[] };
  name_before?: string;
  name_after?: string;
}

export interface RouteTrace {
  relation_id: string;
  sequences: {
    ways: string[];
    nodes: string[];
    length_m: number;
  }[];
  stops: { id: string; role?: string; loc?: [number, number] }[];
  disconnected: boolean;
}

export interface BrowserEditorOptions {
  baseUrl: string;
  editorPath: string;
  headless: boolean;
  profileDir: string;
  timeoutMs: number;
  viewport: { width: number; height: number };
}

interface RouteMemberInput {
  way_ids: string[];
  stop_ids: string[];
  stop_role: string;
}

interface ListEntitiesInput {
  bbox?: [number, number, number, number];
  tags?: Tags;
  max: number;
}

/**
 * Drives the BetteriD single-page editor in a persistent Chromium profile so
 * the logged-in OpenStreetMap account and the editor state survive restarts.
 */
export class BetterIdBrowser {
  private readonly options: BrowserEditorOptions;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(options: BrowserEditorOptions) {
    this.options = options;
  }

  private get baseUrl(): string {
    return this.options.baseUrl.replace(/\/+$/, '');
  }

  async open(view?: MapViewInput): Promise<EditorState> {
    if (!this.context) {
      await fs.mkdir(this.options.profileDir, { recursive: true });
      this.context = await chromium.launchPersistentContext(this.options.profileDir, {
        headless: this.options.headless,
        viewport: this.options.viewport,
        args: ['--disable-dev-shm-usage']
      });
    }

    if (!this.page || this.page.isClosed()) {
      this.page = await this.context.newPage();
    }

    const url = buildEditorUrl(this.baseUrl, this.options.editorPath, view);
    await this.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: this.options.timeoutMs
    });
    await this.waitForEditor();
    await this.installPageHelpers();
    await this.dismissSplash();
    await this.page.waitForTimeout(800);
    return this.getState();
  }

  async ensureOpen(view?: MapViewInput): Promise<EditorState> {
    if (this.page && !this.page.isClosed() && (await this.editorReady())) {
      if (view) await this.setView(view.lat, view.lon, view.zoom);
      return this.getState();
    }
    return this.open(view);
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
      this.page = null;
    }
  }

  async getState(): Promise<EditorState> {
    const page = await this.requirePage();
    return page.evaluate(async () => {
      const context = (window as unknown as { context?: EditorLike }).context;
      if (!context) throw new Error('Editor is not ready');
      const map = context.map();
      const helpers = (window as unknown as { __betterIdMcp?: PageHelpers }).__betterIdMcp;
      if (!helpers) throw new Error('MCP page helpers are not installed');
      const account = await helpers.readAccount(context);
      const bbox = map.extent().rectangle() as [number, number, number, number];
      const center = map.center() as [number, number];
      return {
        view: { center, zoom: map.zoom(), bbox },
        mode: context.mode()?.id ?? null,
        selectedIDs: context.selectedIDs() ?? [],
        changes: context.history().changesCount(),
        account
      };
    });
  }

  async setView(lat: number, lon: number, zoom: number): Promise<EditorState> {
    const page = await this.requirePage();
    await page.evaluate(
      ({ lat, lon, zoom }) => {
        const context = (window as unknown as { context?: EditorLike }).context;
        if (!context) throw new Error('Editor is not ready');
        context.map().centerZoom([lon, lat], zoom);
      },
      { lat, lon, zoom }
    );
    await page.waitForTimeout(300);
    return this.getState();
  }

  async addPoint(
    lat: number,
    lon: number,
    tags: Tags = {},
    annotation = '添加节点'
  ): Promise<string> {
    const page = await this.requirePage();
    return page.evaluate(
      ({ lat, lon, tags, annotation }) => {
        const context = (window as unknown as { context?: EditorLike }).context;
        const iD = (window as unknown as { iD?: IDLike }).iD;
        if (!context || !iD) throw new Error('Editor is not ready');
        const node = new iD.osmNode({ loc: [lon, lat], tags });
        context.perform(iD.actionAddEntity(node), annotation);
        context.enter(iD.modeSelect(context, [node.id]));
        return node.id as string;
      },
      { lat, lon, tags, annotation }
    );
  }

  async addWay(
    points: { lat: number; lon: number }[],
    tags: Tags = {},
    closed = false
  ): Promise<{ id: string; node_ids: string[] }> {
    const page = await this.requirePage();
    return page.evaluate(
      ({ points, tags, closed }) => {
        const context = (window as unknown as { context?: EditorLike }).context;
        const iD = (window as unknown as { iD?: IDLike }).iD;
        if (!context || !iD) throw new Error('Editor is not ready');

        const nodes = points.map(
          ({ lat, lon }) => new iD.osmNode({ loc: [lon, lat], tags: {} })
        );
        const nodeIds = nodes.map((node) => node.id);
        if (closed && nodeIds.length > 1 && nodeIds[nodeIds.length - 1] !== nodeIds[0]) {
          nodeIds.push(nodeIds[0]);
        }
        const way = new iD.osmWay({ nodes: nodeIds, tags });
        context.perform(
          (graph: unknown) => {
            for (const node of nodes) {
              graph = iD.actionAddEntity(node)(graph);
            }
            return iD.actionAddEntity(way)(graph);
          },
          closed ? '添加闭合道路' : '添加道路'
        );
        context.enter(iD.modeSelect(context, [way.id]));
        return {
          id: way.id as string,
          node_ids: nodes.map((node) => node.id as string)
        };
      },
      { points, tags, closed }
    );
  }

  async addBusStop(
    lat: number,
    lon: number,
    tags: Tags
  ): Promise<string> {
    return this.addPoint(lat, lon, tags, '添加公交站');
  }

  async createBusRouteRelation(
    members: RouteMemberInput,
    tags: Tags
  ): Promise<string> {
    const page = await this.requirePage();
    return page.evaluate(
      ({ members, tags }) => {
        const context = (window as unknown as { context?: EditorLike }).context;
        const iD = (window as unknown as { iD?: IDLike }).iD;
        if (!context || !iD) throw new Error('Editor is not ready');

        const routeMembers: { type: 'way' | 'node'; id: string; role: string }[] = [
          ...members.way_ids.map((id) => ({ type: 'way' as const, id, role: '' })),
          ...members.stop_ids.map((id) => ({
            type: 'node' as const,
            id,
            role: members.stop_role
          }))
        ];
        const relation = new iD.osmRelation({ members: routeMembers, tags });
        context.perform(iD.actionAddEntity(relation), '创建公交线路关系');
        context.enter(iD.modeSelect(context, [relation.id]));
        return relation.id as string;
      },
      { members, tags }
    );
  }

  async addRelationMember(
    relationId: string,
    memberId: string,
    role: string
  ): Promise<EditorState> {
    const page = await this.requirePage();
    await page.evaluate(
      ({ relationId, memberId, role }) => {
        const context = (window as unknown as { context?: EditorLike }).context;
        const iD = (window as unknown as { iD?: IDLike }).iD;
        if (!context || !iD) throw new Error('Editor is not ready');
        const entity = context.graph().entity(memberId);
        context.perform(
          iD.actionAddMember(relationId, {
            type: entity.type,
            id: memberId,
            role: role || ''
          }),
          '添加公交线路成员'
        );
        context.enter(iD.modeSelect(context, [relationId]));
      },
      { relationId, memberId, role }
    );
    return this.getState();
  }

  async selectEntity(id: string, zoomTo = true): Promise<EditorState> {
    const page = await this.requirePage();
    await page.evaluate(
      ({ id, zoomTo }) => {
        const context = (window as unknown as { context?: EditorLike }).context;
        if (!context) throw new Error('Editor is not ready');
        context.zoomToEntity(id, zoomTo);
      },
      { id, zoomTo }
    );
    await page.waitForTimeout(400);
    return this.getState();
  }

  async getEntity(id: string): Promise<EntityInfo | null> {
    const page = await this.requirePage();
    return page.evaluate((id) => {
      const context = (window as unknown as { context?: EditorLike }).context;
      const helpers = (window as unknown as { __betterIdMcp?: PageHelpers }).__betterIdMcp;
      if (!context || !helpers) return null;
      return helpers.serializeEntity(context, id, true);
    }, id);
  }

  async listEntities(input: ListEntitiesInput): Promise<EntityInfo[]> {
    const page = await this.requirePage();
    return page.evaluate((input) => {
      const context = (window as unknown as { context?: EditorLike }).context;
      const iD = (window as unknown as { iD?: IDLike }).iD;
      const helpers = (window as unknown as { __betterIdMcp?: PageHelpers }).__betterIdMcp;
      if (!context || !iD || !helpers) throw new Error('Editor is not ready');

      const graph = context.graph();
      const extent = input.bbox
        ? new iD.geoExtent([input.bbox[0], input.bbox[1]], [input.bbox[2], input.bbox[3]])
        : context.map().extent();
      const ids = context.history().intersects(extent);
      const result: EntityInfo[] = [];

      for (const id of ids) {
        if (result.length >= input.max) break;
        const entity = graph.entity(id);
        if (input.tags && !helpers.matchesTags(entity.tags, input.tags)) continue;
        const info = helpers.serializeEntity(context, id, false);
        if (info) result.push(info);
      }
      return result;
    }, input);
  }

  async setTags(id: string, tags: Tags): Promise<EntityInfo | null> {
    const page = await this.requirePage();
    await page.evaluate(
      ({ id, tags }) => {
        const context = (window as unknown as { context?: EditorLike }).context;
        const iD = (window as unknown as { iD?: IDLike }).iD;
        if (!context || !iD) throw new Error('Editor is not ready');
        context.perform(iD.actionChangeTags(id, tags), '更新标签');
        context.enter(iD.modeSelect(context, [id]));
      },
      { id, tags }
    );
    return this.getEntity(id);
  }

  async undo(): Promise<EditorState> {
    const page = await this.requirePage();
    await page.evaluate(() => {
      const context = (window as unknown as { context?: EditorLike }).context;
      if (!context) throw new Error('Editor is not ready');
      if (context.history().undoAnnotation()) context.undo();
    });
    return this.getState();
  }

  async redo(): Promise<EditorState> {
    const page = await this.requirePage();
    await page.evaluate(() => {
      const context = (window as unknown as { context?: EditorLike }).context;
      if (!context) throw new Error('Editor is not ready');
      if (context.history().redoAnnotation()) context.redo();
    });
    return this.getState();
  }

  async getChanges(): Promise<ChangeSummary> {
    const page = await this.requirePage();
    return page.evaluate(() => {
      const context = (window as unknown as { context?: EditorLike }).context;
      if (!context) throw new Error('Editor is not ready');
      const changes = context.history().changes();
      return {
        count: context.history().changesCount(),
        created: changes.created.map((entity) => entity.id),
        modified: changes.modified.map((entity) => entity.id),
        deleted: changes.deleted.map((entity) => entity.id)
      };
    });
  }

  async saveChanges(
    comment: string,
    source?: string,
    hashtags?: string[]
  ): Promise<{
    changesets: string[];
    message: string;
  }> {
    const page = await this.requirePage();

    const account = await this.getAccount();
    if (!account.authenticated) {
      throw new Error('尚未登录 OpenStreetMap，请先调用 login 工具');
    }
    const changes = await this.getChanges();
    if (changes.count === 0) {
      throw new Error('当前没有待保存的修改');
    }

    const saveButton = page.locator('.top-toolbar button.save');
    await saveButton.waitFor({ state: 'visible', timeout: 10_000 });
    await saveButton.click();

    await page
      .locator('.modal .save-section')
      .waitFor({ state: 'visible', timeout: 10_000 });
    await page.locator('.form-field-comment textarea').fill(comment);
    if (source) {
      await page.locator('.form-field-source textarea').fill(source);
    }
    if (hashtags && hashtags.length) {
      const hashtagField = page.locator('.form-field-hashtags textarea');
      if (await hashtagField.count()) {
        await hashtagField.first().fill(hashtags.join(' '));
      }
    }

    await page.locator('.save-section .save-button').click();

    const success = page.locator('.modal .save-success');
    try {
      await success.waitFor({ state: 'visible', timeout: this.options.timeoutMs });
    } catch {
      const modalText = await page
        .locator('.modal')
        .first()
        .textContent()
        .catch(() => '保存失败，且无法读取错误信息');
      throw new Error(`保存失败：${modalText}`);
    }

    const changesets = await page.$$eval(
      '.modal .save-success a[href*="/changeset/"]',
      (links) => links.map((link) => link.getAttribute('href') ?? '').filter(Boolean)
    );
    const closeButton = page.locator('.modal .save-success button.close');
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click().catch(() => undefined);
    } else {
      await page.keyboard.press('Escape').catch(() => undefined);
    }

    return {
      changesets,
      message: changesets.length
        ? `保存成功，共 ${changesets.length} 个 changeset`
        : '保存成功'
    };
  }

  async getAccount(): Promise<AccountState> {
    const page = await this.requirePage();
    return page.evaluate(async () => {
      const context = (window as unknown as { context?: EditorLike }).context;
      if (!context) throw new Error('Editor is not ready');
      const helpers = (window as unknown as { __betterIdMcp?: PageHelpers }).__betterIdMcp;
      if (!helpers) throw new Error('MCP page helpers are not installed');
      return helpers.readAccount(context);
    });
  }

  /** Split the way(s) at the given node IDs. */
  async splitWay(nodeIds: string[], wayIds?: string[]): Promise<EditorState> {
    const page = await this.requirePage();
    await page.evaluate(
      ({ nodeIds, wayIds }) => {
        const context = (window as unknown as { context?: EditorLike }).context;
        const iD = (window as unknown as { iD?: IDLike }).iD;
        if (!context || !iD) throw new Error('Editor is not ready');
        const action = iD.actionSplit(nodeIds);
        if (wayIds && wayIds.length) action.limitWays(wayIds);
        context.perform(action, '拆分道路');
        const created = context.history().difference().extantIDs();
        context.enter(iD.modeSelect(context, created));
      },
      { nodeIds, wayIds }
    );
    return this.getState();
  }

  /** Join ways that share endpoints into a single way. */
  async joinWays(wayIds: string[]): Promise<EditorState> {
    const page = await this.requirePage();
    await page.evaluate(
      (wayIds) => {
        const context = (window as unknown as { context?: EditorLike }).context;
        const iD = (window as unknown as { iD?: IDLike }).iD;
        if (!context || !iD) throw new Error('Editor is not ready');
        context.perform(iD.actionJoin(wayIds), '合并道路');
        context.enter(iD.modeSelect(context, [wayIds[0]]));
      },
      wayIds
    );
    return this.getState();
  }

  /** Merge multiple nodes into one (duplicate node cleanup). */
  async mergeNodes(nodeIds: string[]): Promise<EditorState> {
    const page = await this.requirePage();
    await page.evaluate(
      (nodeIds) => {
        const context = (window as unknown as { context?: EditorLike }).context;
        const iD = (window as unknown as { iD?: IDLike }).iD;
        if (!context || !iD) throw new Error('Editor is not ready');
        context.perform(iD.actionMergeNodes(nodeIds), '合并节点');
        context.enter(iD.modeSelect(context, [nodeIds[0]]));
      },
      nodeIds
    );
    return this.getState();
  }

  /** Straighten a way (or selected nodes) onto a best-fit line. */
  async straightenWay(wayIds: string[]): Promise<EditorState> {
    const page = await this.requirePage();
    await page.evaluate(
      (wayIds) => {
        const context = (window as unknown as { context?: EditorLike }).context;
        const iD = (window as unknown as { iD?: IDLike }).iD;
        if (!context || !iD) throw new Error('Editor is not ready');
        context.perform(
          iD.actionStraightenWay(wayIds, context.projection),
          '拉直道路'
        );
        context.enter(iD.modeSelect(context, wayIds));
      },
      wayIds
    );
    return this.getState();
  }

  /** Square up the corners of an area (e.g. building footprints). */
  async orthogonalizeWay(wayId: string): Promise<EditorState> {
    const page = await this.requirePage();
    await page.evaluate(
      (wayId) => {
        const context = (window as unknown as { context?: EditorLike }).context;
        const iD = (window as unknown as { iD?: IDLike }).iD;
        if (!context || !iD) throw new Error('Editor is not ready');
        context.perform(
          iD.actionOrthogonalize(wayId, context.projection),
          '正交化道路'
        );
        context.enter(iD.modeSelect(context, [wayId]));
      },
      wayId
    );
    return this.getState();
  }

  /** Make a closed way circular (e.g. roundabouts, traffic circles). */
  async circularizeWay(wayId: string): Promise<EditorState> {
    const page = await this.requirePage();
    await page.evaluate(
      (wayId) => {
        const context = (window as unknown as { context?: EditorLike }).context;
        const iD = (window as unknown as { iD?: IDLike }).iD;
        if (!context || !iD) throw new Error('Editor is not ready');
        context.perform(
          iD.actionCircularize(wayId, context.projection),
          '圆形化道路'
        );
        context.enter(iD.modeSelect(context, [wayId]));
      },
      wayId
    );
    return this.getState();
  }

  /** Reverse the direction of a way, fixing direction-dependent tags. */
  async reverseWay(wayId: string): Promise<EditorState> {
    const page = await this.requirePage();
    await page.evaluate(
      (wayId) => {
        const context = (window as unknown as { context?: EditorLike }).context;
        const iD = (window as unknown as { iD?: IDLike }).iD;
        if (!context || !iD) throw new Error('Editor is not ready');
        context.perform(iD.actionReverse(wayId), '反转道路方向');
        context.enter(iD.modeSelect(context, [wayId]));
      },
      wayId
    );
    return this.getState();
  }

  /** Disconnect all ways sharing the given node (unglue). */
  async disconnectNode(nodeId: string): Promise<EditorState> {
    const page = await this.requirePage();
    await page.evaluate(
      (nodeId) => {
        const context = (window as unknown as { context?: EditorLike }).context;
        const iD = (window as unknown as { iD?: IDLike }).iD;
        if (!context || !iD) throw new Error('Editor is not ready');
        context.perform(iD.actionDisconnect(nodeId), '断开道路连接');
        const created = context.history().difference().extantIDs();
        context.enter(iD.modeSelect(context, created));
      },
      nodeId
    );
    return this.getState();
  }

  /** Extract an entity (e.g. building from a combined address feature). */
  async extractEntity(entityId: string): Promise<EditorState> {
    const page = await this.requirePage();
    await page.evaluate(
      (entityId) => {
        const context = (window as unknown as { context?: EditorLike }).context;
        const iD = (window as unknown as { iD?: IDLike }).iD;
        if (!context || !iD) throw new Error('Editor is not ready');
        context.perform(iD.actionExtract(entityId, context.projection), '提取要素');
        const created = context.history().difference().extantIDs();
        context.enter(iD.modeSelect(context, created));
      },
      entityId
    );
    return this.getState();
  }

  /** Delete the given entities (and any child nodes that become orphaned). */
  async deleteEntities(entityIds: string[]): Promise<EditorState> {
    const page = await this.requirePage();
    await page.evaluate(
      (entityIds) => {
        const context = (window as unknown as { context?: EditorLike }).context;
        const iD = (window as unknown as { iD?: IDLike }).iD;
        if (!context || !iD) throw new Error('Editor is not ready');
        context.perform(iD.actionDeleteMultiple(entityIds), '删除要素');
        context.enter(iD.modeSelect(context, []));
      },
      entityIds
    );
    return this.getState();
  }

  /**
   * Order a route relation's way members into connected sequences using the
   * editor's `osmJoinWays` geometry engine, then rewrite the relation members
   * in that order. Returns the ordered trace for the caller to verify.
   */
  async orderRouteMembers(relationId: string): Promise<RouteTrace & { ordered_ids: string[] }> {
    const page = await this.requirePage();
    const result = await page.evaluate((relationId) => {
      const context = (window as unknown as { context?: EditorLike }).context;
      const iD = (window as unknown as { iD?: IDLike }).iD;
      if (!context || !iD) throw new Error('Editor is not ready');
      const graph = context.graph();
      const relation = graph.entity(relationId);
      if (!relation || relation.type !== 'relation') {
        throw new Error(`不是有效的关系：${relationId}`);
      }

      const wayMembers = relation.members?.filter((m) => m.type === 'way') ?? [];
      const stopMembers = relation.members?.filter((m) => m.type === 'node') ?? [];

      const sequences = iD.osmJoinWays(wayMembers, graph) as unknown as {
        length: number;
        nodes: string[];
        actions: ((graph: unknown) => unknown)[];
        [index: number]: { type: 'way'; id: string; role?: string };
      };

      const orderedMembers: { type: 'way'; id: string; role?: string }[] = [];
      const seqInfo: { ways: string[]; nodes: string[]; length_m: number }[] = [];
      for (let i = 0; i < sequences.length; i++) {
        const seq = sequences[i] as unknown as { type: 'way'; id: string; role?: string }[] & {
          nodes: string[];
        };
        const seqMembers = Array.from(seq);
        const ways = seqMembers.map((m) => m.id);
        const nodes = seq.nodes ?? [];
        let lengthM = 0;
        for (let n = 1; n < nodes.length; n++) {
          const a = graph.entity(nodes[n - 1])?.loc;
          const b = graph.entity(nodes[n])?.loc;
          if (a && b) lengthM += iD.geoSphericalDistance(a, b);
        }
        orderedMembers.push(...(seqMembers as { type: 'way'; id: string; role?: string }[]));
        seqInfo.push({ ways, nodes, length_m: Math.round(lengthM) });
      }

      const reversalActions = sequences.actions ?? [];
      const newMembers = [...orderedMembers, ...stopMembers];
      context.perform(
        (graph: unknown) => {
          let g = graph as {
            replace(e: EntityLike): unknown;
            entity(id: string): EntityLike;
          };
          for (const action of reversalActions) g = action(g) as typeof g;
          return g.replace(g.entity(relationId).update({ members: newMembers }));
        },
        '整理公交线路成员顺序'
      );
      context.enter(iD.modeSelect(context, [relationId]));

      const stops = stopMembers.map((m) => ({
        id: m.id,
        role: m.role,
        loc: graph.entity(m.id)?.loc
      }));

      return {
        relation_id: relationId,
        sequences: seqInfo,
        stops,
        disconnected: seqInfo.length > 1,
        ordered_ids: orderedMembers.map((m) => m.id)
      };
    }, relationId);
    await this.getState();
    return result;
  }

  /** Trace a route relation into ordered way/nodes sequences and stops (read-only). */
  async traceRoute(relationId: string): Promise<RouteTrace> {
    const page = await this.requirePage();
    return page.evaluate((relationId) => {
      const context = (window as unknown as { context?: EditorLike }).context;
      const iD = (window as unknown as { iD?: IDLike }).iD;
      if (!context || !iD) throw new Error('Editor is not ready');
      const graph = context.graph();
      const relation = graph.entity(relationId);
      if (!relation || relation.type !== 'relation') {
        throw new Error(`不是有效的关系：${relationId}`);
      }

      const wayMembers = relation.members?.filter((m) => m.type === 'way') ?? [];
      const stopMembers = relation.members?.filter((m) => m.type === 'node') ?? [];
      const sequences = iD.osmJoinWays(wayMembers, graph) as unknown as {
        length: number;
        nodes: string[];
        [index: number]: { type: 'way'; id: string };
      };

      const seqInfo: { ways: string[]; nodes: string[]; length_m: number }[] = [];
      for (let i = 0; i < sequences.length; i++) {
        const seq = sequences[i] as unknown as { id: string }[] & { nodes: string[] };
        const ways = Array.from(seq).map((m) => m.id);
        const nodes = seq.nodes ?? [];
        let lengthM = 0;
        for (let n = 1; n < nodes.length; n++) {
          const a = graph.entity(nodes[n - 1])?.loc;
          const b = graph.entity(nodes[n])?.loc;
          if (a && b) lengthM += iD.geoSphericalDistance(a, b);
        }
        seqInfo.push({ ways, nodes, length_m: Math.round(lengthM) });
      }

      return {
        relation_id: relationId,
        sequences: seqInfo,
        stops: stopMembers.map((m) => ({
          id: m.id,
          role: m.role,
          loc: graph.entity(m.id)?.loc
        })),
        disconnected: seqInfo.length > 1
      };
    }, relationId);
  }

  /** Review all unsaved changes as before/after entity diffs. */
  async reviewChanges(): Promise<{ count: number; diffs: EntityDiff[] }> {
    const page = await this.requirePage();
    return page.evaluate(() => {
      const context = (window as unknown as { context?: EditorLike }).context;
      if (!context) throw new Error('Editor is not ready');
      const base = context.history().base();
      const graph = context.graph();
      const changes = context.history().changes();
      const diffs: EntityDiff[] = [];

      const tagsOf = (entity: EntityLike | undefined): Tags => entity?.tags ?? {};

      for (const entity of changes.created) {
        const after = tagsOf(entity);
        diffs.push({
          id: entity.id,
          type: entity.type,
          action: 'created',
          geometry_changed: true,
          tags_before: {},
          tags_after: after,
          tag_changes: {
            added: Object.entries(after),
            changed: [],
            removed: []
          },
          name_after: after.name
        });
      }
      for (const entity of changes.modified) {
        const beforeEntity = base.entity(entity.id);
        const before = tagsOf(beforeEntity);
        const after = tagsOf(entity);
        const added: [string, string][] = [];
        const changed: [string, string, string][] = [];
        const removed: string[] = [];
        for (const [key, value] of Object.entries(after)) {
          if (!(key in before)) added.push([key, value]);
          else if (before[key] !== value) changed.push([key, before[key], value]);
        }
        for (const key of Object.keys(before)) {
          if (!(key in after)) removed.push(key);
        }
        diffs.push({
          id: entity.id,
          type: entity.type,
          action: 'modified',
          geometry_changed:
            (entity.type === 'node' && !sameLoc(beforeEntity?.loc, entity.loc)) ||
            (entity.type === 'way' && !sameArray(beforeEntity?.nodes, entity.nodes)) ||
            (entity.type === 'relation' &&
              !sameArray(
                (beforeEntity?.members ?? []) as unknown as string[],
                (entity.members ?? []) as unknown as string[]
              )),
          tags_before: before,
          tags_after: after,
          tag_changes: { added, changed, removed },
          name_before: before.name,
          name_after: after.name
        });
      }
      for (const entity of changes.deleted) {
        const before = tagsOf(entity);
        diffs.push({
          id: entity.id,
          type: entity.type,
          action: 'deleted',
          geometry_changed: true,
          tags_before: before,
          tags_after: {},
          tag_changes: { added: [], changed: [], removed: Object.keys(before) },
          name_before: before.name
        });
      }
      return { count: diffs.length, diffs };

      function sameLoc(a?: [number, number], b?: [number, number]): boolean {
        return Boolean(a && b && a[0] === b[0] && a[1] === b[1]);
      }
      function sameArray(a?: unknown[], b?: unknown[]): boolean {
        return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
      }
    });
  }

  /** Checkpoint the editor history so edits can be rolled back with `restoreSnapshot`. */
  async snapshot(key: string): Promise<{ key: string }> {
    const page = await this.requirePage();
    await page.evaluate((key) => {
      const context = (window as unknown as { context?: EditorLike }).context;
      if (!context) throw new Error('Editor is not ready');
      context.history().checkpoint(key);
    }, key);
    return { key };
  }

  /** Restore the editor history to a previously taken snapshot. */
  async restoreSnapshot(key: string): Promise<EditorState> {
    const page = await this.requirePage();
    await page.evaluate((key) => {
      const context = (window as unknown as { context?: EditorLike }).context;
      if (!context) throw new Error('Editor is not ready');
      context.history().reset(key);
    }, key);
    return this.getState();
  }

  /**
   * Run the editor's built-in validators (20+ rules) and return matching issues.
   * `what`: 'all' (base + edited) or 'edited' (only user-modified entities).
   * `where`: 'all' or 'visible' (current map viewport).
   */
  async getValidationIssues(
    what: 'all' | 'edited' = 'edited',
    where: 'all' | 'visible' = 'all'
  ): Promise<ValidationIssue[]> {
    const page = await this.requirePage();
    await page.evaluate(() => {
      const context = (window as unknown as { context?: EditorLike }).context;
      if (!context) throw new Error('Editor is not ready');
      return context.validator().validate();
    });
    return page.evaluate(
      ({ what, where }) => {
        const context = (window as unknown as { context?: EditorLike }).context;
        if (!context) throw new Error('Editor is not ready');
        return context
          .validator()
          .getIssues({ what, where })
          .map((issue) => {
            const render = (fn: unknown): string => {
              if (typeof fn !== 'function') return String(fn ?? '');
              const texts: string[] = [];
              const el = {
                append: () => el,
                attr: () => el,
                text: (value: unknown) => {
                  if (typeof value === 'string') texts.push(value);
                  return el;
                },
                call: (sub: (el: unknown) => void) => {
                  sub(el);
                  return el;
                }
              };
              try {
                (fn as (el: unknown) => void)(el);
              } catch {
                /* ignore rendering errors */
              }
              return texts.join(' ');
            };
            const fixes = (issue.fixes ? issue.fixes(context) : [])
              .map((fix) => ({
                title: render(fix.title),
                autoSafe: fix.autoSafe === true,
                icon: fix.icon,
                entityIds: fix.entityIds ?? []
              }));
            return {
              id: issue.id,
              type: issue.type,
              subtype: issue.subtype,
              severity: issue.severity,
              message: render(issue.message(context)),
              entityIds: issue.entityIds ?? [],
              loc: issue.loc,
              fixes
            };
          });
      },
      { what, where }
    );
  }

  /**
   * Apply the editor's auto-safe validation fixes in a single batch action.
   * Ports the same decision logic the editor UI uses (see validation_autofix.js):
   * only issues with exactly one actionable fix marked `autoSafe` are applied.
   */
  async autoFixIssues(what: 'all' | 'edited' = 'edited'): Promise<AutofixResult> {
    const page = await this.requirePage();
    await page.evaluate(() => {
      const context = (window as unknown as { context?: EditorLike }).context;
      if (!context) throw new Error('Editor is not ready');
      return context.validator().validate();
    });
    return page.evaluate((what) => {
      const context = (window as unknown as { context?: EditorLike }).context;
      if (!context) throw new Error('Editor is not ready');
      const issues = context.validator().getIssues({ what, where: 'all' });

      const actions: ((graph: unknown) => unknown)[] = [];
      const fixed: string[] = [];
      let stagedGraph = context.graph();

      for (const issue of issues) {
        const decisionFixes = (issue.fixes ? issue.fixes(context) : []).filter(
          (fix) =>
            !fix.disabledReason &&
            typeof fix.onClick === 'function' &&
            fix.icon !== 'iD-icon-close'
        );
        if (decisionFixes.length !== 1 || !decisionFixes[0].autoSafe) continue;

        const captured: ((graph: unknown) => unknown)[] = [];
        const fixGraph = stagedGraph;
        const captureContext = new Proxy(context, {
          get(target, property) {
            if (property === 'perform' || property === 'replace') {
              return (...args: unknown[]) => {
                const values = args.slice();
                if (values.length && typeof values[values.length - 1] !== 'function') values.pop();
                if (!values.length || values.some((v) => typeof v !== 'function')) {
                  throw new Error('Auto-safe fixes must use graph actions');
                }
                captured.push(...(values as ((graph: unknown) => unknown)[]));
              };
            }
            if (property === 'graph') return () => fixGraph;
            if (property === 'entity') return (id: string) => fixGraph.entity(id);
            if (property === 'hasEntity') return (id: string) => fixGraph.hasEntity(id);
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          }
        });

        try {
          const onClick = decisionFixes[0].onClick;
          if (!onClick) continue;
          onClick(captureContext);
        } catch {
          continue;
        }
        if (!captured.length) continue;

        let preview: unknown = fixGraph;
        try {
          preview = captured.reduce(
            (graph: unknown, action) => action(graph),
            fixGraph as unknown
          );
        } catch {
          continue;
        }
        if (context.editPolicy?.(fixGraph, preview)) continue;

        actions.push(...captured);
        stagedGraph = preview as typeof stagedGraph;
        fixed.push(issue.type + (issue.subtype ? '/' + issue.subtype : ''));
      }

      if (actions.length) {
        context.perform(
          (graph: unknown) => actions.reduce((g, action) => action(g), graph),
          `自动修复 ${fixed.length} 个校验问题`
        );
        context.validator().validate();
      }
      return { count: fixed.length, fixed, annotation: `自动修复 ${fixed.length} 个校验问题` };
    }, what);
  }

  /** Mark a validation issue as ignored (kept out of issue lists). */
  async ignoreValidationIssue(issueId: string): Promise<{ ignored: string }> {
    const page = await this.requirePage();
    await page.evaluate((issueId) => {
      const context = (window as unknown as { context?: EditorLike }).context;
      if (!context) throw new Error('Editor is not ready');
      context.validator().ignoreIssue(issueId);
    }, issueId);
    return { ignored: issueId };
  }

  async login(): Promise<AccountState & { waiting?: boolean }> {
    const page = await this.requirePage();
    const current = await this.getAccount();
    if (current.authenticated) return current;

    const popupPromise = page.waitForEvent('popup', { timeout: 20_000 });
    await page.evaluate(() => {
      const context = (window as unknown as { context?: EditorLike }).context;
      if (!context) throw new Error('Editor is not ready');
      context.connection().authenticate();
    });

    const popup = await popupPromise;
    const deadline = Date.now() + this.options.timeoutMs;
    while (Date.now() < deadline) {
      const account = await this.getAccount().catch(() => ({ authenticated: false }));
      if (account.authenticated) {
        await popup.close().catch(() => undefined);
        return account;
      }
      await page.waitForTimeout(2_000);
    }

    return {
      authenticated: false,
      waiting: true,
      error: '登录等待超时，请在浏览器弹出的 OSM 页面中完成登录'
    };
  }

  async screenshot(): Promise<Buffer> {
    const page = await this.requirePage();
    return page.screenshot({ type: 'png' });
  }

  private async requirePage(): Promise<Page> {
    if (this.page && !this.page.isClosed() && (await this.editorReady())) {
      await this.installPageHelpers();
      return this.page;
    }
    await this.open();
    return this.page as Page;
  }

  private async editorReady(): Promise<boolean> {
    if (!this.page || this.page.isClosed()) return false;
    return this.page
      .evaluate(() => Boolean((window as unknown as { context?: EditorLike }).context))
      .catch(() => false);
  }

  private async waitForEditor(): Promise<void> {
    const page = this.page as Page;
    await page.waitForFunction(
      () => {
        const anyWindow = window as unknown as { context?: Record<string, unknown> };
        const context = anyWindow.context;
        return Boolean(
          context &&
            typeof context.map === 'function' &&
            typeof context.history === 'function' &&
            typeof context.connection === 'function'
        );
      },
      undefined,
      { timeout: this.options.timeoutMs }
    );
  }

  private async dismissSplash(): Promise<void> {
    const page = this.page as Page;
    const startEditing = page.locator('.modal .start-editing');
    if (await startEditing.isVisible({ timeout: 4_000 }).catch(() => false)) {
      await startEditing.click();
    }
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.keyboard.press('Escape').catch(() => undefined);
  }

  private async installPageHelpers(): Promise<void> {
    const page = this.page as Page;
    await page.evaluate(() => {
      (window as unknown as { __betterIdMcp?: PageHelpers }).__betterIdMcp = {
        async readAccount(context: EditorLike): Promise<AccountState> {
          const connection = context.connection();
          if (!connection.authenticated()) return { authenticated: false };

          return new Promise((resolve) => {
            connection.userDetails((error, user) => {
              if (error) {
                resolve({
                  authenticated: true,
                  error: error instanceof Error ? error.message : String(error)
                });
              } else {
                resolve({
                  authenticated: true,
                  display_name: user?.display_name,
                  uid: user?.uid
                });
              }
            });
          });
        },

        matchesTags(tags: Tags, expected: Tags): boolean {
          for (const [key, value] of Object.entries(expected)) {
            if (!(key in tags)) return false;
            if (value !== '*' && tags[key] !== value) return false;
          }
          return true;
        },

        serializeEntity(context: EditorLike, id: string, includePoints: boolean): EntityInfo | null {
          if (!context.hasEntity(id)) return null;
          const graph = context.graph() as {
            entity(id: string): EntityLike;
            geometry(id: string): string;
          };
          const entity = graph.entity(id);
          const base: EntityInfo = {
            id: entity.id,
            type: entity.type,
            tags: entity.tags ?? {},
            geometry: graph.geometry(id),
            center: entity.extent(graph).center()
          };

          if (entity.type === 'node') {
            base.loc = entity.loc;
          } else if (entity.type === 'way') {
            base.nodes = entity.nodes;
            base.nodeCount = entity.nodes?.length ?? 0;
            if (includePoints) {
              base.points = (entity.nodes ?? [])
                .map((nodeId) => {
                  try {
                    return graph.entity(nodeId).loc;
                  } catch {
                    return undefined;
                  }
                })
                .filter((loc): loc is [number, number] => Boolean(loc));
            }
          } else if (entity.type === 'relation') {
            base.members = entity.members;
            base.memberCount = entity.members?.length ?? 0;
          }
          return base;
        }
      };
    });
  }
}

interface PageHelpers {
  readAccount(context: EditorLike): Promise<AccountState>;
  matchesTags(tags: Tags, expected: Tags): boolean;
  serializeEntity(context: EditorLike, id: string, includePoints: boolean): EntityInfo | null;
}

interface EditorLike {
  map(): {
    center(): unknown;
    zoom(): number;
    extent(): { rectangle(): unknown };
    centerZoom(center: unknown, zoom: number): unknown;
  };
  mode(): { id?: string } | null | undefined;
  selectedIDs(): string[];
  hasEntity(id: string): boolean;
  history(): {
    changesCount(): number;
    changes(): {
      created: EntityLike[];
      modified: EntityLike[];
      deleted: EntityLike[];
    };
    undoAnnotation(): unknown;
    redoAnnotation(): unknown;
    intersects(extent: unknown): string[];
    base(): {
      entity(id: string): EntityLike | undefined;
    };
    difference(): {
      extantIDs(): string[];
    };
    checkpoint(key: string): unknown;
    reset(key?: string): unknown;
  };
  graph(): {
    entity(id: string): EntityLike;
    hasEntity(id: string): EntityLike | undefined;
    geometry(id: string): string;
    replace(entity: EntityLike): unknown;
    childNodes(entity: EntityLike): EntityLike[];
    parentWays(entity: EntityLike): EntityLike[];
  };
  connection(): {
    authenticated(): boolean;
    authenticate(): void;
    userDetails(callback: (error: unknown, user?: { display_name?: string; uid?: number }) => void): void;
  };
  perform(action: unknown, annotation?: string): void;
  enter(mode: unknown): void;
  zoomToEntity(id: string, zoomTo: boolean): void;
  undo(): void;
  redo(): void;
  projection: (loc: [number, number]) => [number, number];
  editPolicy?: (before: unknown, after: unknown) => unknown;
  validator(): {
    validate(): Promise<unknown>;
    getIssues(options: { what: string; where: string }): ValidationIssueLike[];
    ignoreIssue(id: string): void;
  };
}

interface ValidationIssueLike {
  id: string;
  type: string;
  subtype?: string;
  severity: 'error' | 'warning' | 'suggestion';
  message(context: EditorLike): unknown;
  entityIds?: string[];
  loc?: [number, number];
  fixes?(context: EditorLike): ValidationFixLike[];
}

interface ValidationFixLike {
  title: unknown;
  icon?: string;
  autoSafe?: boolean;
  disabledReason?: unknown;
  entityIds?: string[];
  onClick?(context: unknown): void;
}

interface EntityLike {
  id: string;
  type: 'node' | 'way' | 'relation';
  tags: Tags;
  loc?: [number, number];
  nodes?: string[];
  members?: { type: 'node' | 'way' | 'relation'; id: string; role?: string }[];
  extent(graph: unknown): { center(): [number, number] };
  update(attrs: Partial<EntityLike>): EntityLike;
  geometry(graph: unknown): string;
}

interface IDLike {
  osmNode: new (props: { loc: [number, number]; tags: Tags }) => EntityLike;
  osmWay: new (props: { nodes: string[]; tags: Tags }) => EntityLike;
  osmRelation: new (props: { members: unknown[]; tags: Tags }) => EntityLike;
  actionAddEntity: (entity: EntityLike) => (graph: unknown) => unknown;
  actionChangeTags: (id: string, tags: Tags) => unknown;
  actionAddMember: (relationId: string, member: unknown, index?: number) => unknown;
  actionSplit: (nodeIds: string[], wayIds?: string[]) => {
    limitWays(wayIds?: string[]): unknown;
    (graph: unknown): unknown;
  };
  actionJoin: (wayIds: string[]) => (graph: unknown) => unknown;
  actionMergeNodes: (nodeIds: string[], loc?: [number, number]) => (graph: unknown) => unknown;
  actionStraightenWay: (ids: string[], projection: unknown) => (graph: unknown) => unknown;
  actionOrthogonalize: (wayId: string, projection: unknown) => (graph: unknown) => unknown;
  actionCircularize: (wayId: string, projection: unknown) => (graph: unknown) => unknown;
  actionReverse: (wayId: string) => (graph: unknown) => unknown;
  actionDisconnect: (nodeId: string) => (graph: unknown) => unknown;
  actionExtract: (entityId: string, projection: unknown) => (graph: unknown) => unknown;
  actionDeleteMultiple: (entityIds: string[]) => (graph: unknown) => unknown;
  osmJoinWays: (members: unknown[], graph: unknown) => unknown;
  geoSphericalDistance: (a: [number, number], b: [number, number]) => number;
  modeSelect: (context: unknown, ids: string[]) => unknown;
  geoExtent: new (
    min: [number, number],
    max: [number, number]
  ) => unknown;
}
