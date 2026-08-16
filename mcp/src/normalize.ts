export type Tags = Record<string, string>;

export type OsmType = 'node' | 'way' | 'relation';

/** Trim and collapse inner whitespace in a display name. */
export function cleanName(value: string): string {
  return String(value).replace(/\s+/g, ' ').trim();
}

/** Convert full-width ASCII characters (often typed by IMEs) to half-width. */
export function normalizeFullWidth(value: string): string {
  return String(value)
    .replace(/[！-～]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) - 0xfee0)
    )
    .replace(/　/g, ' ');
}

/**
 * Conservative OSM tag cleanup: trim keys/values, drop empty values and empty
 * keys, and normalize full-width ASCII inside names and ref-like keys.
 */
export function normalizeTags(input: Tags): { tags: Tags; removed: string[] } {
  const tags: Tags = {};
  const removed: string[] = [];

  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim();
    if (!key) {
      removed.push(rawKey);
      continue;
    }
    const value = String(rawValue ?? '').trim();
    if (!value) {
      removed.push(key);
      continue;
    }
    const isNameLike = key === 'name' || key.startsWith('name:');
    tags[key] = isNameLike || key.startsWith('ref') ? normalizeFullWidth(value) : value;
  }

  return { tags, removed };
}

export function defaultMemberRole(type: OsmType): string {
  return type === 'node' ? 'stop' : '';
}

export interface BusRouteOptions {
  name?: string;
  ref?: string | number;
  from?: string;
  to?: string;
  operator?: string;
  network?: string;
  colour?: string;
  extraTags?: Tags;
}

/** Standard OSM tags for a `type=route, route=bus` relation. */
export function buildBusRouteTags(options: BusRouteOptions): Tags {
  const tags: Tags = { type: 'route', route: 'bus' };
  if (options.name) tags.name = cleanName(options.name);
  if (options.ref !== undefined && options.ref !== null && String(options.ref) !== '') {
    tags.ref = normalizeFullWidth(String(options.ref)).trim();
  }
  if (options.from) tags.from = cleanName(options.from);
  if (options.to) tags.to = cleanName(options.to);
  if (options.operator) tags.operator = cleanName(options.operator);
  if (options.network) tags.network = cleanName(options.network);
  if (options.colour) tags.colour = cleanName(options.colour);

  return normalizeTags({ ...tags, ...(options.extraTags ?? {}) }).tags;
}

export function buildBusStopTags(
  name: string,
  ref?: string | number,
  extraTags?: Tags
): Tags {
  const tags: Tags = { highway: 'bus_stop', name: cleanName(name) };
  if (ref !== undefined && ref !== null && String(ref) !== '') {
    tags.ref = normalizeFullWidth(String(ref)).trim();
  }
  return normalizeTags({ ...tags, ...(extraTags ?? {}) }).tags;
}
