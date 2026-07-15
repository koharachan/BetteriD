const FEATURE_KEYS = [
  'aerialway', 'aeroway', 'amenity', 'barrier', 'boundary', 'building',
  'craft', 'highway', 'historic', 'landuse', 'leisure', 'man_made',
  'natural', 'office', 'place', 'power', 'public_transport', 'railway',
  'route', 'shop', 'tourism', 'waterway',
];


export function utilChangesetSummary(changes) {
  const counts = {};
  const featureCounts = new Map();
  const tagKeys = new Set();
  let total = 0;

  for (const action of ['created', 'modified', 'deleted']) {
    counts[action] = { node: 0, relation: 0, way: 0 };

    for (const entity of changes[action] || []) {
      counts[action][entity.type] += 1;
      total += 1;

      const tags = entity.tags || {};
      const featureKey = FEATURE_KEYS.find(key => tags[key]);
      if (featureKey) {
        const feature = `${featureKey}=${tags[featureKey]}`;
        featureCounts.set(feature, (featureCounts.get(feature) || 0) + 1);
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

  return {
    counts,
    features,
    tag_keys: [...tagKeys].sort().slice(0, 30),
    total,
  };
}
