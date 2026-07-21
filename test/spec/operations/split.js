import { operationSplit } from '../../../modules/operations/split';


describe('iD.operationSplit', function() {
    afterEach(function() {
        iD.prefs('betterid.editing.josm_shortcuts', null);
    });

    it('does not claim the split key when only ways are selected under JOSM shortcuts', function() {
        iD.prefs('betterid.editing.josm_shortcuts', 'true');

        const graph = new iD.coreGraph([
            new iD.osmWay({ id: 'w1', nodes: [] })
        ]);
        const context = {
            connection: () => null,
            graph: () => graph,
            hasHiddenConnections: () => false,
            history: () => ({ on: () => {} }),
            loadEntity: () => {},
            map: () => ({
                withinEditableZoom: () => true,
                extent: () => graph.extent()
            }),
            perform: () => {},
            selectedIDs: () => ['w1'],
            ui: () => ({ flash: () => {} })
        };

        const operation = operationSplit(context, ['w1']);
        expect(operation.availableForKeypress()).toBe(false);
    });
});
