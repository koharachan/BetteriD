import { select as d3_select } from 'd3-selection';

import { behaviorBetteridAdobe } from '../../../modules/behavior/betterid_adobe';
import { BETTERID_TOOL_PREF, BETTERID_SHORTCUT_PRESET_PREF } from '../../../modules/core/betterid_tools';
import { prefs } from '../../../modules/core/preferences';


describe('behaviorBetteridAdobe', function() {
    let container, context, behavior;

    beforeEach(function() {
        container = d3_select('body').append('div').attr('class', 'ideditor');
        context = iD.coreContext().assetPath('../dist/').init().container(container);
        container.append('div').attr('class', 'main-map').call(context.map());
        context.map().dimensions([1000, 1000]);
        context.map().centerZoom([0, 0], 18);
        context.enter(iD.modeBrowse(context));
        behavior = behaviorBetteridAdobe(context);
        context.install(behavior);
    });

    afterEach(function() {
        context.uninstall(behavior);
        prefs(BETTERID_TOOL_PREF, null);
        prefs(BETTERID_SHORTCUT_PRESET_PREF, null);
        container.remove();
    });

    function key(type, name, options) {
        const event = new KeyboardEvent(type, Object.assign({ key: name, bubbles: true, cancelable: true }, options || {}));
        window.dispatchEvent(event);
        return event;
    }


    it('leaves Space to iD with the select tool and the shortcut layer off', function() {
        const event = key('keydown', ' ');
        expect(event.defaultPrevented).toBe(false);
        expect(context.container().classed('betterid-hand-tool')).toBe(false);
    });

    it('holds the hand tool on Space while a palette tool is active', function() {
        prefs(BETTERID_TOOL_PREF, 'pen');
        const event = key('keydown', ' ');
        expect(event.defaultPrevented).toBe(true);
        expect(context.container().classed('betterid-hand-tool')).toBe(true);
        key('keyup', ' ');
        expect(context.container().classed('betterid-hand-tool')).toBe(false);
    });

    it('holds the hand tool on Space when the Adobe layer is on', function() {
        prefs(BETTERID_SHORTCUT_PRESET_PREF, 'photoshop');
        key('keydown', ' ');
        expect(context.container().classed('betterid-hand-tool')).toBe(true);
        window.dispatchEvent(new Event('blur'));
        expect(context.container().classed('betterid-hand-tool')).toBe(false);
    });

    it('deselects with Ctrl+Shift+A in the Illustrator preset', function() {
        prefs(BETTERID_SHORTCUT_PRESET_PREF, 'illustrator');
        const node = new iD.osmNode({ loc: [0, 0], tags: { amenity: 'cafe' } });
        context.perform(iD.actionAddEntity(node));
        context.enter(iD.modeSelect(context, [node.id]));
        expect(context.mode().id).toEqual('select');

        key('keydown', 'A', { ctrlKey: true, shiftKey: true });
        expect(context.mode().id).toEqual('browse');
    });
});
