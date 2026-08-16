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
      created: { id: string }[];
      modified: { id: string }[];
      deleted: { id: string }[];
    };
    undoAnnotation(): unknown;
    redoAnnotation(): unknown;
    intersects(extent: unknown): string[];
  };
  graph(): {
    entity(id: string): EntityLike;
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
}

interface EntityLike {
  id: string;
  type: 'node' | 'way' | 'relation';
  tags: Tags;
  loc?: [number, number];
  nodes?: string[];
  members?: { type: 'node' | 'way' | 'relation'; id: string; role?: string }[];
  extent(graph: unknown): { center(): [number, number] };
}

interface IDLike {
  osmNode: new (props: { loc: [number, number]; tags: Tags }) => EntityLike;
  osmWay: new (props: { nodes: string[]; tags: Tags }) => EntityLike;
  osmRelation: new (props: { members: unknown[]; tags: Tags }) => EntityLike;
  actionAddEntity: (entity: EntityLike) => (graph: unknown) => unknown;
  actionChangeTags: (id: string, tags: Tags) => unknown;
  actionAddMember: (relationId: string, member: unknown, index?: number) => unknown;
  modeSelect: (context: unknown, ids: string[]) => unknown;
  geoExtent: new (
    min: [number, number],
    max: [number, number]
  ) => unknown;
}
