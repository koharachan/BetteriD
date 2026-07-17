import * as countryCoder from '@rapideditor/country-coder';

import { fileFetcher } from '../core/file_fetcher';
import { BETTERID_PREFS, betteridBool } from '../core/betterid_preferences';
import { t } from '../core/localizer';
import { presetManager } from '../presets';
import { validationIssue } from '../core/validation';


const FALLBACK_SCRIPTS = new Map([
  ['am', 'Ethi'],
  ['ar', 'Arab'],
  ['az', 'Latn'],
  ['be', 'Cyrl'],
  ['bg', 'Cyrl'],
  ['bn', 'Beng'],
  ['bo', 'Tibt'],
  ['el', 'Grek'],
  ['fa', 'Arab'],
  ['gu', 'Gujr'],
  ['he', 'Hebr'],
  ['hi', 'Deva'],
  ['hy', 'Armn'],
  ['ja', 'Jpan'],
  ['ka', 'Geor'],
  ['km', 'Khmr'],
  ['kn', 'Knda'],
  ['ko', 'Kore'],
  ['lo', 'Laoo'],
  ['ml', 'Mlym'],
  ['mn', 'Cyrl'],
  ['my', 'Mymr'],
  ['pa', 'Guru'],
  ['ru', 'Cyrl'],
  ['si', 'Sinh'],
  ['ta', 'Taml'],
  ['te', 'Telu'],
  ['th', 'Thai'],
  ['uk', 'Cyrl'],
  ['ur', 'Arab'],
  ['zh', 'Hani'],
]);

const SCRIPT_TESTS = [
  ['Arab', /\p{Script=Arabic}/u],
  ['Armn', /\p{Script=Armenian}/u],
  ['Beng', /\p{Script=Bengali}/u],
  ['Cyrl', /\p{Script=Cyrillic}/u],
  ['Deva', /\p{Script=Devanagari}/u],
  ['Ethi', /\p{Script=Ethiopic}/u],
  ['Geor', /\p{Script=Georgian}/u],
  ['Grek', /\p{Script=Greek}/u],
  ['Gujr', /\p{Script=Gujarati}/u],
  ['Guru', /\p{Script=Gurmukhi}/u],
  ['Hani', /\p{Script=Han}/u],
  ['Hebr', /\p{Script=Hebrew}/u],
  ['Jpan', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['Khmr', /\p{Script=Khmer}/u],
  ['Knda', /\p{Script=Kannada}/u],
  ['Kore', /\p{Script=Hangul}/u],
  ['Laoo', /\p{Script=Lao}/u],
  ['Latn', /\p{Script=Latin}/u],
  ['Mlym', /\p{Script=Malayalam}/u],
  ['Mong', /\p{Script=Mongolian}/u],
  ['Mymr', /\p{Script=Myanmar}/u],
  ['Sinh', /\p{Script=Sinhala}/u],
  ['Taml', /\p{Script=Tamil}/u],
  ['Telu', /\p{Script=Telugu}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Tibt', /\p{Script=Tibetan}/u],
];


export function validationNonLocalName() {
  const type = 'non_local_name';
  let _territoryLanguages = {};

  fileFetcher.get('territory_languages')
    .then(data => { _territoryLanguages = data || {}; })
    .catch(() => { /* ignore */ });


  function expandScript(script) {
    if (script === 'Hans' || script === 'Hant') return ['Hani'];
    if (script === 'Jpan') return ['Hani', 'Jpan'];
    if (script === 'Kore') return ['Hani', 'Kore'];
    return script ? [script] : [];
  }


  function scriptsForLanguage(language) {
    try {
      const script = new Intl.Locale(language.replace('_', '-')).maximize().script;
      return expandScript(script);
    } catch {
      return expandScript(FALLBACK_SCRIPTS.get(language.split('-')[0]));
    }
  }


  function scriptsInName(name) {
    return SCRIPT_TESTS
      .filter(([, regex]) => regex.test(name))
      .map(([script]) => script);
  }


  function localScriptShare(name, expected) {
    let local = 0;
    let recognized = 0;
    for (const character of name) {
      const scripts = SCRIPT_TESTS
        .filter(([, regex]) => regex.test(character))
        .map(([script]) => script);
      if (!scripts.length) continue;
      recognized++;
      if (scripts.some(script => expected.has(script))) local++;
    }
    return recognized ? local / recognized : 1;
  }


  function countryCodeForEntity(entity, graph) {
    const center = entity.extent(graph).center();
    const countryCode = countryCoder.iso1A2Code(center, { level: 'territory' });
    return countryCode && countryCode.toLowerCase();
  }


  function localScripts(countryCode) {
    const scripts = new Set();
    const languages = (_territoryLanguages[countryCode] || []).slice(0, 12);

    for (const language of languages) {
      for (const script of scriptsForLanguage(language)) {
        scripts.add(script);
      }
    }
    return scripts;
  }


  function makeIssue(entity) {
    return new validationIssue({
      type,
      subtype: 'foreign_name',
      severity: 'warning',
      message: function(context) {
        const currentEntity = context.hasEntity(this.entityIds[0]);
        if (!currentEntity) return '';
        const preset = presetManager.match(currentEntity, context.graph());
        return t.append('issues.non_local_name.message', {
          feature: preset.name(),
          name: currentEntity.tags.name,
        });
      },
      reference: showReference,
      entityIds: [entity.id],
      hash: `name=${entity.tags.name}`,
    });
  }


  function showReference(selection) {
    selection.selectAll('.issue-reference')
      .data([0])
      .enter()
      .append('div')
      .attr('class', 'issue-reference')
      .call(t.append('issues.non_local_name.reference'));
  }


  const validation = function checkNonLocalName(entity, graph) {
    if (!betteridBool(BETTERID_PREFS.nonLocalName, true)) return [];
    const name = entity.tags.name;
    if (!name || !_territoryLanguages) return [];

    const countryCode = countryCodeForEntity(entity, graph);
    if (!countryCode) return [];

    const expected = localScripts(countryCode);
    const actual = scriptsInName(name);
    if (!expected.size || !actual.length) return [];
    if (actual.every(script => expected.has(script))) return [];
    // A token local character should not make an otherwise foreign primary
    // name pass. Mixed-script names need a meaningful local-script majority.
    if (localScriptShare(name, expected) >= 0.5) return [];

    return [makeIssue(entity)];
  };

  validation.type = type;
  return validation;
}
