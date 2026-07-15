function entityDependencies(entity) {
  if (entity.type === 'way') return entity.nodes || [];
  if (entity.type === 'relation') return (entity.members || []).map(member => member.id);
  return [];
}


function entityCenter(entity, graph, entitiesByID) {
  if (entity.type === 'node' && entity.loc) return entity.loc;

  if (entity.type === 'way') {
    const locations = (entity.nodes || [])
      .map(id => entitiesByID.get(id) || graph?.hasEntity(id))
      .filter(child => child?.loc)
      .map(child => child.loc);
    if (locations.length) {
      const sum = locations.reduce((result, loc) => [result[0] + loc[0], result[1] + loc[1]], [0, 0]);
      return [sum[0] / locations.length, sum[1] / locations.length];
    }
  }

  try {
    return entity.extent(graph).center();
  } catch {
    return null;
  }
}


function makeComponents(entries, graph) {
  const entitiesByID = new Map(entries.map(entry => [entry.entity.id, entry.entity]));
  const parents = new Map(entries.map(entry => [entry.entity.id, entry.entity.id]));

  function find(id) {
    const parent = parents.get(id);
    if (parent === id) return id;
    const root = find(parent);
    parents.set(id, root);
    return root;
  }

  function union(a, b) {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parents.set(rootB, rootA);
  }

  for (const { entity } of entries) {
    for (const dependencyID of entityDependencies(entity)) {
      if (parents.has(dependencyID)) union(entity.id, dependencyID);
    }
  }

  const grouped = new Map();
  for (const entry of entries) {
    const root = find(entry.entity.id);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(entry);
  }

  return [...grouped.values()].map(componentEntries => {
    const centers = componentEntries
      .map(entry => entityCenter(entry.entity, graph, entitiesByID))
      .filter(Boolean);
    const center = centers.length ? centers.reduce(
      (result, loc) => [result[0] + loc[0] / centers.length, result[1] + loc[1] / centers.length],
      [0, 0]
    ) : null;
    return { center, entries: componentEntries };
  });
}


function shouldSortByArea(components, strategy) {
  if (strategy === 'area') return true;
  if (strategy !== 'auto') return false;

  const centers = components.map(component => component.center).filter(Boolean);
  if (centers.length < 2) return false;
  const longitudes = centers.map(center => center[0]);
  const latitudes = centers.map(center => center[1]);
  const longitudeSpan = Math.max(...longitudes) - Math.min(...longitudes);
  const latitudeSpan = Math.max(...latitudes) - Math.min(...latitudes);
  return longitudeSpan > 0.25 || latitudeSpan > 0.25;
}


function packComponents(components, maxChanges) {
  const batches = [];
  let current = [];
  let currentCount = 0;

  for (const component of components) {
    const componentCount = component.entries.length;
    if (current.length && currentCount + componentCount > maxChanges) {
      batches.push(current);
      current = [];
      currentCount = 0;
    }
    current.push(component);
    currentCount += componentCount;
  }
  if (current.length) batches.push(current);
  return batches;
}


export function coreChangeBatches(changes, graph, options = {}) {
  const maxChanges = Math.max(1, Number.parseInt(options.maxChanges, 10) || 50);
  const strategy = options.strategy || 'auto';
  const entries = [];

  for (const action of ['created', 'modified', 'deleted']) {
    for (const entity of changes[action] || []) {
      entries.push({ action, entity });
    }
  }
  if (!entries.length) return [];

  const components = makeComponents(entries, graph);
  if (shouldSortByArea(components, strategy)) {
    components.sort((a, b) => {
      if (!a.center) return 1;
      if (!b.center) return -1;
      return a.center[1] - b.center[1] || a.center[0] - b.center[0];
    });
  }

  return packComponents(components, maxChanges).map((batchComponents, index, all) => {
    const batch = { created: [], deleted: [], modified: [] };
    for (const component of batchComponents) {
      for (const entry of component.entries) {
        batch[entry.action].push(entry.entity);
      }
    }
    batch.count = batch.created.length + batch.modified.length + batch.deleted.length;
    batch.index = index + 1;
    batch.total = all.length;
    return batch;
  });
}
