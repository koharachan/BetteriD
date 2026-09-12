import { select as d3_select, selectAll as d3_selectAll } from 'd3-selection';

import { coreContext } from '../../../../modules';
import { prefs } from '../../../../modules/core/preferences';
import { BETTERID_ADOBE_SHORTCUTS_PREF } from '../../../../modules/core/betterid_tools';
import { uiSectionBetteridEditing } from '../../../../modules/ui/sections/betterid_preferences';


describe('BetteriD editing preferences', function() {
    let context, element;

    beforeEach(function() {
        context = coreContext().assetPath('../dist/').init();
        prefs(BETTERID_ADOBE_SHORTCUTS_PREF, null);
        element = d3_select('body')
            .append('div')
            .attr('class', 'ui-wrap')
            .call(uiSectionBetteridEditing(context).render);
    });

    afterEach(function() {
        prefs(BETTERID_ADOBE_SHORTCUTS_PREF, null);
        d3_selectAll('.ui-wrap').remove();
    });

    it('offers the Adobe shortcut layer right below the JOSM shortcut switch', function() {
        const josm = element.select('.preference-josm-shortcuts');
        const adobe = element.select('.preference-adobe-shortcuts');

        expect(josm.empty()).toBe(false);
        expect(adobe.empty()).toBe(false);
        expect(adobe.node().previousElementSibling).toBe(josm.node());
        expect(adobe.select('input').property('checked')).toBe(true);
    });

    it('stores the toggle in the preference the shortcut layer reads', function() {
        element.select('.preference-adobe-shortcuts input')
            .property('checked', false)
            .dispatch('change');
        expect(prefs(BETTERID_ADOBE_SHORTCUTS_PREF)).toBe('false');

        element.select('.preference-adobe-shortcuts input')
            .property('checked', true)
            .dispatch('change');
        expect(prefs(BETTERID_ADOBE_SHORTCUTS_PREF)).toBe('true');
    });
});
