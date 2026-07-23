import { prefs } from './preferences';


export const BETTERID_PREFS = Object.freeze({
  backgroundSecondaryOpacity: 'betterid.background.secondary_opacity',
  backgroundSecondarySource: 'betterid.background.secondary_source',
  experimental: 'betterid.experimental.enabled',
  dualImagery: 'betterid.experimental.dual_imagery',
  localPhoto: 'betterid.experimental.local_photo',
  indoorFocus: 'betterid.experimental.indoor_focus',
  wasdNavigation: 'betterid.experimental.wasd_navigation',
  josmShortcuts: 'betterid.editing.josm_shortcuts',
  navigationMode: 'betterid.navigation.mode',
  nonLocalName: 'betterid.validation.non_local_name',
  rememberLocation: 'betterid.general.remember_location',
  rightDrag: 'betterid.editing.right_drag',
  snapTolerance: 'betterid.editing.snap_tolerance',
  translationLanguages: 'betterid.translation.languages',
  searchOrder: 'betterid.ai.search_order',
  textOrder: 'betterid.ai.text_order',
  visionOrder: 'betterid.ai.vision_order'
});

export const BETTERID_LEGACY_PREFS = Object.freeze({
  smartSplit: 'smartSplit',
  splitFixedCount: 'splitFixedCount',
  splitType: 'splitType'
});

export const BETTERID_DEFAULTS = Object.freeze({
  backgroundSecondaryOpacity: 0.5,
  navigationMode: 'walk',
  snapTolerance: 8,
  splitFixedCount: 50,
  splitType: 'auto',
  translationLanguages: ['zh', 'zh-Hant', 'en'],
  searchOrder: ['openai', 'kimi'],
  textOrder: ['deepseek', 'openai', 'mimo'],
  visionOrder: ['openai', 'mimo']
});

export const BETTERID_LIMITS = Object.freeze({
  backgroundOpacity: Object.freeze({ min: 0, max: 1 }),
  snapTolerance: Object.freeze({ min: 2, max: 30 }),
  splitFixedCount: Object.freeze({ min: 1, max: 500 }),
  translationLanguages: Object.freeze({ max: 8 })
});

export const BETTERID_PROVIDER_GROUPS = Object.freeze([
  Object.freeze({ kind: 'search', label: 'preferences.ai.search_order' }),
  Object.freeze({ kind: 'text', label: 'preferences.ai.text_order' }),
  Object.freeze({ kind: 'vision', label: 'preferences.ai.vision_order' })
]);

export const BETTERID_NAVIGATION_MODES = Object.freeze(['walk', 'fly']);
export const BETTERID_SPLIT_TYPES = Object.freeze(['auto', 'fixed', 'area']);

const ALLOWED_PROVIDERS = Object.freeze({
  search: new Set(BETTERID_DEFAULTS.searchOrder),
  text: new Set(BETTERID_DEFAULTS.textOrder),
  vision: new Set(BETTERID_DEFAULTS.visionOrder)
});


export function betteridBool(key, defaultValue = false) {
  const value = prefs(key);
  if (value === null || value === undefined) return defaultValue;
  return value === 'true';
}


export function setBetteridBool(key, value) {
  prefs(key, value ? 'true' : 'false');
}


export function getBetteridNumber(key, limits, defaultValue) {
  const value = Number.parseFloat(prefs(key));
  return Number.isFinite(value) ? clampNumber(value, limits.min, limits.max) : defaultValue;
}


export function setBetteridNumber(key, value, limits, defaultValue) {
  const number = Number(value);
  prefs(key, String(clampNumber(Number.isFinite(number) ? number : defaultValue, limits.min, limits.max)));
}


export function getSnapTolerance() {
  return Math.round(getBetteridNumber(
    BETTERID_PREFS.snapTolerance,
    BETTERID_LIMITS.snapTolerance,
    BETTERID_DEFAULTS.snapTolerance
  ));
}


export function setSnapTolerance(value) {
  const number = Number(value);
  setBetteridNumber(
    BETTERID_PREFS.snapTolerance,
    Number.isFinite(number) ? Math.round(number) : BETTERID_DEFAULTS.snapTolerance,
    BETTERID_LIMITS.snapTolerance,
    BETTERID_DEFAULTS.snapTolerance
  );
}


export function getSplitFixedCount() {
  return Math.round(getBetteridNumber(
    BETTERID_LEGACY_PREFS.splitFixedCount,
    BETTERID_LIMITS.splitFixedCount,
    BETTERID_DEFAULTS.splitFixedCount
  ));
}


export function setSplitFixedCount(value) {
  const number = Number(value);
  setBetteridNumber(
    BETTERID_LEGACY_PREFS.splitFixedCount,
    Number.isFinite(number) ? Math.round(number) : BETTERID_DEFAULTS.splitFixedCount,
    BETTERID_LIMITS.splitFixedCount,
    BETTERID_DEFAULTS.splitFixedCount
  );
}


export function getSplitType() {
  const value = prefs(BETTERID_LEGACY_PREFS.splitType);
  return BETTERID_SPLIT_TYPES.includes(value) ? value : BETTERID_DEFAULTS.splitType;
}


export function setSplitType(value) {
  prefs(BETTERID_LEGACY_PREFS.splitType, BETTERID_SPLIT_TYPES.includes(value) ? value : BETTERID_DEFAULTS.splitType);
}


export function getSecondaryBackgroundOpacity() {
  return getBetteridNumber(
    BETTERID_PREFS.backgroundSecondaryOpacity,
    BETTERID_LIMITS.backgroundOpacity,
    BETTERID_DEFAULTS.backgroundSecondaryOpacity
  );
}


export function setSecondaryBackgroundOpacity(value) {
  setBetteridNumber(
    BETTERID_PREFS.backgroundSecondaryOpacity,
    value,
    BETTERID_LIMITS.backgroundOpacity,
    BETTERID_DEFAULTS.backgroundSecondaryOpacity
  );
}


export function experimentalFeatureEnabled(featureKey) {
  return betteridBool(BETTERID_PREFS.experimental, false) &&
    betteridBool(featureKey, false);
}


export function getTranslationLanguages() {
  let values;
  try {
    values = JSON.parse(prefs(BETTERID_PREFS.translationLanguages));
  } catch { /* use defaults */ }

  if (!Array.isArray(values)) values = BETTERID_DEFAULTS.translationLanguages;
  const result = [];
  for (const value of values) {
    const code = String(value || '').trim().replace(/_/g, '-');
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(code)) continue;
    if (!result.includes(code)) result.push(code);
    if (result.length === BETTERID_LIMITS.translationLanguages.max) break;
  }
  return result.length ? result : BETTERID_DEFAULTS.translationLanguages.slice();
}


export function setTranslationLanguages(values) {
  const sanitized = [];
  for (const value of values || []) {
    const code = String(value || '').trim().replace(/_/g, '-');
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(code)) continue;
    if (!sanitized.includes(code)) sanitized.push(code);
    if (sanitized.length === BETTERID_LIMITS.translationLanguages.max) break;
  }
  prefs(
    BETTERID_PREFS.translationLanguages,
    JSON.stringify(sanitized.length ? sanitized : BETTERID_DEFAULTS.translationLanguages)
  );
}


export function getProviderOrder(kind) {
  const defaults = BETTERID_DEFAULTS[`${kind}Order`];
  const allowed = ALLOWED_PROVIDERS[kind];
  if (!defaults || !allowed) return [];

  let values;
  try {
    values = JSON.parse(prefs(BETTERID_PREFS[`${kind}Order`]));
  } catch { /* use defaults */ }

  if (!Array.isArray(values)) values = defaults;
  const result = values
    .map(value => String(value || '').toLowerCase())
    .filter((value, index, array) => allowed.has(value) && array.indexOf(value) === index);

  for (const provider of defaults) {
    if (!result.includes(provider)) result.push(provider);
  }
  return result;
}


export function setProviderOrder(kind, values) {
  const allowed = ALLOWED_PROVIDERS[kind];
  if (!allowed) return;
  const result = (values || [])
    .map(value => String(value || '').toLowerCase())
    .filter((value, index, array) => allowed.has(value) && array.indexOf(value) === index);
  prefs(BETTERID_PREFS[`${kind}Order`], JSON.stringify(result));
}


function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
