import { t } from '../core/localizer';


const TRANSLATED_ROLES = new Set([
  'access', 'admin_centre', 'backward', 'building', 'destination',
  'east', 'entry', 'exit', 'forward', 'from', 'house', 'inner', 'label',
  'member', 'north', 'outer', 'parking_space', 'part', 'perimeter',
  'platform', 'sign', 'south', 'space', 'stop', 'street', 'subarea',
  'to', 'via', 'west'
]);


/**
 * Add localized display labels to common relation-role suggestions while
 * preserving their raw OSM values when a suggestion is accepted.
 */
export function utilRelationRoleOptions(options) {
  return options.map(option => {
    const value = option.value;
    if (!TRANSLATED_ROLES.has(value)) return option;

    const label = t(`inspector.relation_roles.${value}`, { default: value });
    if (!label || label === value) return option;

    return {
      ...option,
      display: selection => selection.text(label),
      terms: [...(option.terms || []), label],
      title: `${label} (${value})`
    };
  });
}
