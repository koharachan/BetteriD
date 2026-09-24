import { select as d3_select, selectAll as d3_selectAll } from 'd3-selection';

import { coreContext } from '../../../../modules';
import { prefs } from '../../../../modules/core/preferences';
import { BETTERID_SHORTCUT_PRESET_PREF } from '../../../../modules/core/betterid_tools';
import { uiSectionBetteridEditing } from '../../../../modules/ui/sections/betterid_preferences';


describe('BetteriD editing preferences', function() {
    let context, element;

    beforeEach(function() {
        context = coreContext().assetPath('../dist/').init();
        prefs(BETTERID_SHORTCUT_PRESET_PREF, null);
        element = d3_select('body')
            .append('div')
            .attr('class', 'ui-wrap')
            .call(uiSectionBetteridEditing(context).render);
    });

    afterEach(function() {
        prefs(BETTERID_SHORTCUT_PRESET_PREF, null);
        d3_selectAll('.ui-wrap').remove();
    });

    it('offers the Adobe shortcut layer right below the JOSM shortcut switch', function() {
        const josm = element.select('.preference-josm-shortcuts');
        const preset = element.select('.preference-shortcut-preset');

        expect(josm.empty()).toBe(false);
        expect(preset.empty()).toBe(false);
        expect(preset.node().previousElementSibling).toBe(josm.node());

        const options = preset.select('select').selectAll('option').nodes()
            .map(node => node.getAttribute('value'));
        expect(options).toEqual(['off', 'photoshop', 'illustrator']);
        expect(preset.select('select').property('value')).toBe('off');
    });

    it('stores the chosen preset in the preference the shortcut layer reads', function() {
        element.select('.preference-shortcut-preset select')
            .property('value', 'illustrator')
            .dispatch('change');
        expect(prefs(BETTERID_SHORTCUT_PRESET_PREF)).toBe('illustrator');

        element.select('.preference-shortcut-preset select')
            .property('value', 'off')
            .dispatch('change');
        expect(prefs(BETTERID_SHORTCUT_PRESET_PREF)).toBe('off');
    });
});
