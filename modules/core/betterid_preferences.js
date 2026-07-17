import { prefs } from './preferences';


export const BETTERID_PREFS = Object.freeze({
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

export const BETTERID_DEFAULTS = Object.freeze({
  translationLanguages: ['zh', 'zh-Hant', 'en'],
  searchOrder: ['openai', 'kimi'],
  textOrder: ['deepseek', 'openai', 'mimo'],
  visionOrder: ['openai', 'mimo']
});

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


export function getSnapTolerance() {
  const value = Number.parseInt(prefs(BETTERID_PREFS.snapTolerance), 10);
  return Number.isFinite(value) ? Math.max(2, Math.min(30, value)) : 8;
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
    if (result.length === 8) break;
  }
  return result.length ? result : BETTERID_DEFAULTS.translationLanguages.slice();
}


export function setTranslationLanguages(values) {
  const sanitized = [];
  for (const value of values || []) {
    const code = String(value || '').trim().replace(/_/g, '-');
    if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/.test(code)) continue;
    if (!sanitized.includes(code)) sanitized.push(code);
    if (sanitized.length === 8) break;
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
