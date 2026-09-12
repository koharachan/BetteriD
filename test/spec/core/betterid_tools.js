import {
    BETTERID_SELECTION_LAST_PREF,
    BETTERID_TOOL_PREF,
    betteridTool,
    groupTool,
    selectionTool,
    setBetteridTool,
    setSelectionTool
} from '../../../modules/core/betterid_tools';
import { prefs } from '../../../modules/core/preferences';


describe('BetteriD tool groups', function() {
    afterEach(function() {
        prefs(BETTERID_TOOL_PREF, null);
        prefs(BETTERID_SELECTION_LAST_PREF, null);
    });

    it('defaults the selection group to the quick selection tool', function() {
        expect(selectionTool()).toEqual('quickselect');
        expect(groupTool('selection')).toEqual('quickselect');
    });

    it('remembers the last selection variant from the group menu', function() {
        setSelectionTool('magicwand');
        expect(selectionTool()).toEqual('magicwand');
        expect(groupTool('selection')).toEqual('magicwand');

        // an unknown value falls back to the first member
        prefs(BETTERID_SELECTION_LAST_PREF, 'nope');
        expect(selectionTool()).toEqual('quickselect');
    });

    it('activates a selection variant and keeps it as the group entry', function() {
        setBetteridTool('magicwand');
        expect(betteridTool()).toEqual('magicwand');
        expect(groupTool('selection')).toEqual('magicwand');

        // switching to another group leaves the group showing its last member
        setBetteridTool('pen');
        expect(betteridTool()).toEqual('pen');
        expect(groupTool('pen')).toEqual('pen');
        expect(groupTool('selection')).toEqual('magicwand');
        expect(groupTool('marquee')).toEqual('marquee');
    });
});
