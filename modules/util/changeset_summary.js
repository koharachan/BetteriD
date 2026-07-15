const FEATURE_KEYS = [
  'aerialway', 'aeroway', 'amenity', 'barrier', 'boundary', 'building',
  'craft', 'highway', 'historic', 'landuse', 'leisure', 'man_made',
  'natural', 'office', 'place', 'power', 'public_transport', 'railway',
  'route', 'shop', 'tourism', 'waterway',
];

const NAME_KEYS = ['name', 'official_name', 'short_name', 'brand', 'operator', 'ref'];
const PLACE_KEYS = ['addr:city', 'addr:district', 'addr:place', 'addr:street', 'is_in', 'place'];


function featureFor(tags) {
  const featureKey = FEATURE_KEYS.find(key => tags[key]);
  return featureKey ? `${featureKey}=${tags[featureKey]}` : null;
}


function preferredName(tags) {
  const key = NAME_KEYS.find(nameKey => tags[nameKey]);
  return key ? tags[key] : null;
}


function geometryFor(entity, graph) {
  if (entity.type === 'node') return 'point';
  if (entity.type === 'way') return entity.isArea() ? 'area' : 'line';
  try {
    return entity.geometry(graph);
  } catch {
    return entity.type;
  }
}


function sameArray(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}


function tagChangesFor(beforeTags, afterTags) {
  const added = [];
  const changed = [];
  const removed = [];
  const keys = new Set([...Object.keys(beforeTags), ...Object.keys(afterTags)]);

  for (const key of [...keys].sort()) {
    const hadBefore = Object.prototype.hasOwnProperty.call(beforeTags, key);
    const hasAfter = Object.prototype.hasOwnProperty.call(afterTags, key);
    if (hadBefore && hasAfter && beforeTags[key] === afterTags[key]) continue;

    if (!hadBefore) {
      added.push({ key, value: afterTags[key] });
    } else if (!hasAfter) {
      removed.push({ key, value: beforeTags[key] });
    } else {
      changed.push({ after: afterTags[key], before: beforeTags[key], key });
    }
  }

  return {
    added: added.slice(0, 20),
    changed: changed.slice(0, 20),
    removed: removed.slice(0, 20)
  };
}


function geometryChanged(baseEntity, headEntity, baseGraph, headGraph) {
  if (!baseEntity || !headEntity || baseEntity.type !== headEntity.type) return false;

  if (headEntity.type === 'node') {
    return !sameArray(baseEntity.loc, headEntity.loc);
  }

  if (headEntity.type === 'way') {
    if (!sameArray(baseEntity.nodes, headEntity.nodes)) return true;
    if (!baseGraph || !headGraph) return false;

    return headEntity.nodes.some(nodeID => {
      const baseNode = baseGraph.hasEntity(nodeID);
      const headNode = headGraph.hasEntity(nodeID);
      return baseNode && headNode && !sameArray(baseNode.loc, headNode.loc);
    });
  }

  if (headEntity.type === 'relation') {
    return !sameArray(baseEntity.members, headEntity.members);
  }

  return false;
}


function actualChangeFor(item, options, geometry) {
  const action = item.changeType;
  const entityChange = options.entityChanges?.[item.entity.id] || {};
  const baseEntity = entityChange.base || options.baseGraph?.hasEntity(item.entity.id);
  const headEntity = entityChange.head || options.graph?.hasEntity(item.entity.id);
  const beforeTags = baseEntity?.tags || {};
  const afterTags = headEntity?.tags || {};

  return {
    action,
    feature_after: featureFor(afterTags),
    feature_before: featureFor(beforeTags),
    geometry,
    geometry_changed: action === 'modified' && geometryChanged(baseEntity, headEntity, options.baseGraph, options.graph),
    name_after: preferredName(afterTags),
    name_before: preferredName(beforeTags),
    tag_changes: tagChangesFor(beforeTags, afterTags)
  };
}


export function utilChangesetSummary(changes, options = {}) {
  const counts = {};
  const featureCounts = new Map();
  const featureActionCounts = new Map();
  const tagKeys = new Set();
  let total = 0;

  for (const action of ['created', 'modified', 'deleted']) {
    counts[action] = { node: 0, relation: 0, way: 0 };

    for (const entity of changes[action] || []) {
      counts[action][entity.type] += 1;
      total += 1;

      const tags = entity.tags || {};
      const feature = featureFor(tags);
      if (feature) {
        featureCounts.set(feature, (featureCounts.get(feature) || 0) + 1);
        const actionCounts = featureActionCounts.get(feature) || { created: 0, deleted: 0, modified: 0 };
        actionCounts[action] += 1;
        featureActionCounts.set(feature, actionCounts);
      }

      for (const key of Object.keys(tags)) {
        if (key === 'name' || key.startsWith('name:')) continue;
        tagKeys.add(key);
      }
    }
  }

  const features = [...featureCounts.entries()]
    .map(([feature, count]) => ({ count, feature }))
    .sort((a, b) => b.count - a.count || a.feature.localeCompare(b.feature))
    .slice(0, 12);

  const featureActions = [...featureActionCounts.entries()]
    .map(([feature, actionCounts]) => ({ feature, ...actionCounts }))
    .sort((a, b) => {
      const aTotal = a.created + a.modified + a.deleted;
      const bTotal = b.created + b.modified + b.deleted;
      return bTotal - aTotal || a.feature.localeCompare(b.feature);
    })
    .slice(0, 12);

  const meaningfulCounts = {};
  const meaningfulNodeCounts = { created: 0, deleted: 0, modified: 0 };
  const namedFeatures = [];
  const closedFeatures = [];
  const actualChanges = [];
  const places = new Set();
  const relevant = options.relevant || [];

  for (const action of ['created', 'modified', 'deleted']) {
    meaningfulCounts[action] = { area: 0, line: 0, point: 0, relation: 0 };
  }

  for (const item of relevant) {
    const action = item.changeType;
    const entity = item.entity;
    if (!meaningfulCounts[action] || !entity) continue;

    const tags = entity.tags || {};
    const feature = featureFor(tags) || entity.type;
    const geometry = geometryFor(entity, item.graph || options.graph);
    const countKey = geometry in meaningfulCounts[action] ? geometry : 'relation';
    meaningfulCounts[action][countKey] += 1;
    if (entity.type === 'node') meaningfulNodeCounts[action] += 1;

    const name = preferredName(tags);
    if (name && !namedFeatures.some(item => item.name === name && item.action === action)) {
      namedFeatures.push({ action, feature, geometry, name });
    }

    const isClosedWay = entity.type === 'way' && entity.isClosed();
    const isMultipolygon = entity.type === 'relation' && entity.isMultipolygon?.();
    if ((isClosedWay || isMultipolygon) && !closedFeatures.some(item => item.name === name && item.feature === feature)) {
      closedFeatures.push({ action, feature, geometry, name: name || null });
    }

    for (const key of PLACE_KEYS) {
      if (tags[key]) places.add(tags[key]);
    }

    actualChanges.push(actualChangeFor(item, options, geometry));
  }

  const supportingGeometryNodes = {};
  for (const action of ['created', 'modified', 'deleted']) {
    supportingGeometryNodes[action] = Math.max(0, counts[action].node - meaningfulNodeCounts[action]);
  }

  let editedExtent = null;
  for (const item of relevant) {
    try {
      const extent = item.entity.extent(item.graph || options.graph);
      editedExtent = editedExtent ? editedExtent.extend(extent) : extent;
    } catch {
      // Ignore incomplete entities that cannot provide an extent.
    }
  }

  const relevantIDs = new Set(relevant.map(item => item.entity?.id));
  const surroundingNamedAreas = [];
  if (editedExtent && options.graph) {
    const center = editedExtent.center();
    const candidates = (options.nearby || [])
      .filter(entity => entity && !relevantIDs.has(entity.id) && preferredName(entity.tags || {}))
      .filter(entity => (
        (entity.type === 'way' && (entity.isArea() || entity.isClosed())) ||
        (entity.type === 'relation' && entity.isMultipolygon?.())
      ))
      .map(entity => {
        try {
          const extent = entity.extent(options.graph);
          return extent.contains(center) ? { entity, extent } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.extent.area() - b.extent.area());

    for (const candidate of candidates) {
      const tags = candidate.entity.tags || {};
      const name = preferredName(tags);
      const feature = featureFor(tags) || candidate.entity.type;
      if (!surroundingNamedAreas.some(area => area.name === name)) {
        surroundingNamedAreas.push({ feature, name });
      }
      if (surroundingNamedAreas.length >= 5) break;
    }
  }

  return {
    actual_changes: actualChanges.slice(0, 20),
    closed_features: closedFeatures.slice(0, 12),
    counts,
    feature_actions: featureActions,
    features,
    meaningful_counts: meaningfulCounts,
    named_features: namedFeatures.slice(0, 12),
    places: [...places].slice(0, 12),
    supporting_geometry_nodes: supportingGeometryNodes,
    surrounding_named_areas: surroundingNamedAreas,
    tag_keys: [...tagKeys].sort().slice(0, 30),
    total,
  };
}
