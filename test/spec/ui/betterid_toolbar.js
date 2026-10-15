import { select as d3_select } from 'd3-selection';

import { uiBetteridToolPalette } from '../../../modules/ui/betterid_toolbar';
import {
    BETTERID_TOOL_PREF, BETTERID_MARQUEE_SHAPE_PREF, BETTERID_SELECTION_LAST_PREF,
    BETTERID_SHORTCUT_PRESET_PREF, BETTERID_PEN_TOLERANCE_PREF,
    betteridTool, marqueeShape, penTolerance
} from '../../../modules/core/betterid_tools';
import { prefs } from '../../../modules/core/preferences';


describe('uiBetteridToolPalette', function() {
    let container, context, overMap;

    beforeEach(function() {
        container = d3_select('body').append('div').attr('class', 'ideditor');
        context = iD.coreContext().assetPath('../dist/').init().container(container);
        container.append('div').attr('class', 'main-map').call(context.map());
        overMap = container.append('div').attr('class', 'over-map');
        overMap.call(uiBetteridToolPalette(context));
    });

    afterEach(function() {
        d3_select(window).on('keydown.betteridToolKeys', null, true);
        [BETTERID_TOOL_PREF, BETTERID_MARQUEE_SHAPE_PREF, BETTERID_SELECTION_LAST_PREF,
            BETTERID_SHORTCUT_PRESET_PREF, BETTERID_PEN_TOLERANCE_PREF].forEach(k => prefs(k, null));
        container.remove();
    });

    function key(name, options) {
        window.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: name, bubbles: true, cancelable: true }, options || {})));
    }

    function button(group) {
        return overMap.select('.betterid-tool-button[data-group="' + group + '"]');
    }


    it('renders one button per tool group', function() {
        expect(overMap.selectAll('.betterid-tool-button').size()).toEqual(4);
        expect(button('select').classed('active')).toBe(true);
    });

    it('switches tools with the Photoshop keys', function() {
        key('p');
        expect(betteridTool()).toEqual('pen');
        expect(button('pen').classed('active')).toBe(true);
        expect(context.container().classed('betterid-tool-active')).toBe(true);

        key('w');                                   // plain W belongs to iD's wireframe toggle
        expect(betteridTool()).toEqual('pen');
        key('W', { shiftKey: true });
        expect(betteridTool()).toEqual('quickselect');
        key('W', { shiftKey: true });               // same group again: swaps
        expect(betteridTool()).toEqual('magicwand');
        key('W', { shiftKey: true });
        expect(betteridTool()).toEqual('quickselect');

        key('v');
        expect(betteridTool()).toEqual('select');
        expect(context.container().classed('betterid-tool-active')).toBe(false);
    });

    it('cycles the marquee shape exactly once per Shift+M', function() {
        key('m');
        expect(betteridTool()).toEqual('marquee');
        expect(marqueeShape()).toEqual('rect');
        key('M', { shiftKey: true });
        expect(marqueeShape()).toEqual('ellipse');
        key('M', { shiftKey: true });
        expect(marqueeShape()).toEqual('rect');
        key('m');                                   // plain M on the active marquee also cycles
        expect(marqueeShape()).toEqual('ellipse');
    });

    it('keeps the active tool when its button is clicked again', function() {
        key('p');
        button('pen').node().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(betteridTool()).toEqual('pen');
    });

    it('shows the pen options and updates the slider in place', function() {
        key('p');
        const options = overMap.select('.betterid-tool-options');
        expect(options.empty()).toBe(false);
        const slider = options.select('input[type="range"]');
        expect(slider.empty()).toBe(false);

        slider.property('value', '1.25');
        slider.node().dispatchEvent(new Event('input', { bubbles: true }));
        expect(penTolerance()).toBeCloseTo(1.25, 6);
        // the same input element survived (no palette re-render under the pointer)
        expect(overMap.select('.betterid-tool-options input[type="range"]').node()).toBe(slider.node());
        expect(options.select('output').text()).toEqual('1.25px');
    });

    it('leaves the keys alone while typing', function() {
        const input = container.append('input').node();
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true, cancelable: true }));
        expect(betteridTool()).toEqual('select');
    });
});
