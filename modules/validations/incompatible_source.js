import { t } from '../core/localizer';
import { utilDisplayLabel } from '../util/utilDisplayLabel';
import { validationIssue, validationIssueFix } from '../core/validation';

const incompatibleRules = [
  {
    id: 'amap',
    regex: /(^amap$|(?:^|\W)amap\.com|autonavi|mapabc|高德(?:地图|导航|影像|卫星|街景)?(?=$|[\s;,_/()\-]))/i,
    exceptRegex: /高德([路山桥街巷]|大道)/i
  },
  {
    id: 'tianditu',
    regex: /(tianditu|tiandimap|天地图(?:影像|卫星|街景|矢量|底图)?(?=$|[\s;,_/()\-]))/i
  },
  {
    id: 'baidu',
    regex: /(baidu|mapbar|百度)/i
  },
  {
    id: 'google',
    regex: /(google)/i,
    exceptRegex: /((books|drive)\.google|google\s?(books|drive|plus))|(esri\/Google_(Africa|Open)_Buildings)/i
  }
];

/**
 * @param {string} str String (e.g. tag value) to check for incompatible sources
 * @returns {{id:string, regex: RegExp, exceptRegex?: RegExp}[]}
 */
export function getIncompatibleSources(str) {
  if (typeof str !== 'string' || !str.trim()) return [];
  return incompatibleRules
    .filter(rule =>
      rule.regex.test(str) &&
      !rule.exceptRegex?.test(str)
    );
}

export function validationIncompatibleSource() {
  const type = 'incompatible_source';

  const validation = function checkIncompatibleSource(entity) {
    const entitySources = entity.tags && entity.tags.source && entity.tags.source.split(';');
    if (!entitySources) return [];

    const entityID = entity.id;

    return entitySources
      .flatMap(source => getIncompatibleSources(source)
        .map(matchRule => new validationIssue({
          type: type,
          severity: 'warning',
          message: (context) => {
            const entity = context.hasEntity(entityID);
            return entity ? t.append('issues.incompatible_source.feature.message', {
              feature: utilDisplayLabel(entity, context.graph(), true /* verbose */),
              value: source
            }) : '';
          },
          reference: getReference(matchRule.id),
          entityIds: [entityID],
          hash: source,
          dynamicFixes: () => {
            return [
              new validationIssueFix({ title: t.append('issues.fix.remove_proprietary_data.title') })
            ];
          }
        }))
      );

      function getReference(id) {
        return function showReference(selection) {
          selection.selectAll('.issue-reference')
            .data([0])
            .enter()
            .append('div')
            .attr('class', 'issue-reference')
            .call(t.append(`issues.incompatible_source.reference.${id}`));
        };
      }
    };

    validation.type = type;

    return validation;
}
