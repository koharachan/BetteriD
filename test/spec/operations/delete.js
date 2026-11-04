import { select as d3_select } from 'd3-selection';

describe('iD.operationDelete', function () {
    let graph;

    const fakeContext = {
        graph: () => graph,
        entity: (id) => graph.entity(id),
        hasEntity: (id) => graph.hasEntity(id),
        perform: (action) => graph = action(graph),
        validator: () => ({ validate: () => {} }),
        enter: () => {},
        ui: () => ({
            sidebar:{}
        }),
        container: () => d3_select()
    };

    describe('selects next node automatically', function () {
        it('selects next node after deleting first node of a way', function () {
            graph = new iD.coreGraph([
                new iD.osmNode({ id: 'n1', type: 'node' }),
                new iD.osmNode({ id: 'n2', type: 'node' }),
                new iD.osmNode({ id: 'n3', type: 'node' }),
                new iD.osmWay({ id: 'w', nodes: ['n1', 'n2', 'n3'] }),
            ]);

            const operation = iD.operationDelete(fakeContext, ['n1']);
            fakeContext.enter = vi.fn();
            operation();
            expect(fakeContext.graph().hasEntity('w')).toBeTruthy();
            expect(fakeContext.enter).to.toHaveBeenCalledOnce();
            expect(fakeContext.enter.mock.calls[0][0].selectedIDs()).toEqual(['n2']);
        });

        it('moves the selection before performing the delete', function () {
            // The history `change` event (dispatched by `perform`) rebuilds the
            // operation list from `selectedIDs`. If the selection still pointed at
            // the deleted entity there, an operation could throw and abort the
            // dispatch, leaving stale geometry on screen.
            graph = new iD.coreGraph([
                new iD.osmNode({ id: 'n1', type: 'node', loc: [0, 0] }),
                new iD.osmNode({ id: 'n2', type: 'node', loc: [0, 1] }),
                new iD.osmNode({ id: 'n3', type: 'node', loc: [0, 2] }),
                new iD.osmWay({ id: 'w', nodes: ['n1', 'n2', 'n3'] }),
            ]);

            let enteredMode;
            const seen = [];
            const context = {
                ...fakeContext,
                enter: mode => { enteredMode = mode; },
                perform: action => {
                    seen.push({
                        selected: enteredMode && enteredMode.selectedIDs(),
                        deletedStillPresent: Boolean(graph.hasEntity('n2'))
                    });
                    graph = action(graph);
                }
            };

            iD.operationDelete(context, ['n2'])();

            expect(seen).toEqual([{ selected: ['n3'], deletedStillPresent: true }]);
            expect(graph.hasEntity('n2')).toBeFalsy();
            expect(graph.entity('w').nodes).toEqual(['n1', 'n3']);
        });

        it('selects previous node after deleting last node of a way', function () {            graph = new iD.coreGraph([
                new iD.osmNode({ id: 'n1', type: 'node' }),
                new iD.osmNode({ id: 'n2', type: 'node' }),
                new iD.osmNode({ id: 'n3', type: 'node' }),
                new iD.osmNode({ id: 'n4', type: 'node' }),
                new iD.osmWay({ id: 'w', nodes: ['n1', 'n2', 'n3', 'n4'] }),
            ]);

            const operation = iD.operationDelete(fakeContext, ['n4']);
            fakeContext.enter = vi.fn();
            operation();
            expect(fakeContext.graph().hasEntity('w')).toBeTruthy();
            expect(fakeContext.enter).to.toHaveBeenCalledOnce();
            expect(fakeContext.enter.mock.calls[0][0].selectedIDs()).toEqual(['n3']);
        });

        it('selects nearest node after deleting a middle node of a way', function () {
            graph = new iD.coreGraph([
                new iD.osmNode({ id: 'n1', type: 'node', loc: [0, 0] }),
                new iD.osmNode({ id: 'n2', type: 'node', loc: [1, 0] }),
                new iD.osmNode({ id: 'n3', type: 'node', loc: [3, 0] }),
                new iD.osmWay({ id: 'w', nodes: ['n1', 'n2', 'n3'] }),
            ]);

            const operation = iD.operationDelete(fakeContext, ['n2']);
            fakeContext.enter = vi.fn();
            operation();
            expect(fakeContext.graph().hasEntity('w')).toBeTruthy();
            expect(fakeContext.enter).to.toHaveBeenCalledOnce();
            expect(fakeContext.enter.mock.calls[0][0].selectedIDs()).toEqual(['n1']);
        });

        it('does not crash for a single-noded way', function () {
            // https://github.com/openstreetmap/iD/issues/9007
            graph = new iD.coreGraph([
                new iD.osmNode({ id: 'n', type: 'node' }),
                new iD.osmWay({ id: 'w', nodes: ['n'] }),
            ]);

            const operation = iD.operationDelete(fakeContext, ['n']);
            operation();
            expect(fakeContext.graph().hasEntity('w')).toBeFalsy();
        });
    });

    describe('ways that are still loading', function() {
        function loadingContext(isLoaded, extent) {
            return {
                ...fakeContext,
                connection: () => ({ isDataLoaded: () => isLoaded }),
                inIntro: () => false,
                map: () => ({ extent: () => extent || new iD.geoExtent([10, 10], [11, 11]) }),
                loadTileAtLoc: () => {},
                hasHiddenConnections: () => false,
                enter: () => {},
                perform: action => { graph = action(graph); }
            };
        }

        it('deletes an incomplete way and keeps nodes whose tiles are not loaded', function() {
            graph = new iD.coreGraph([
                new iD.osmNode({ id: 'n1', loc: [0, 0] }),
                new iD.osmWay({ id: 'w', nodes: ['n1', 'n-missing'] })
            ]);
            const context = loadingContext(false);
            const operation = iD.operationDelete(context, ['w']);
            expect(operation.disabled()).toBe(false);
            operation();
            expect(graph.hasEntity('w')).toBeFalsy();
            expect(graph.hasEntity('n1')).toBeTruthy();
        });

        it('still blocks a fully loaded way that is mostly off-screen', function() {
            graph = new iD.coreGraph([
                new iD.osmNode({ id: 'n1', loc: [0, 0] }),
                new iD.osmNode({ id: 'n2', loc: [1, 0] }),
                new iD.osmWay({ id: 'w', nodes: ['n1', 'n2'] })
            ]);
            const operation = iD.operationDelete(loadingContext(true), ['w']);
            expect(operation.disabled()).toBe('too_large');
        });

        it('still blocks a vertex whose tile is not downloaded', function() {
            graph = new iD.coreGraph([
                new iD.osmNode({ id: 'n1', loc: [0, 0] }),
                new iD.osmNode({ id: 'n2', loc: [1, 0] }),
                new iD.osmWay({ id: 'w', nodes: ['n1', 'n2'] })
            ]);
            const operation = iD.operationDelete(loadingContext(false, new iD.geoExtent([-1, -1], [2, 2])), ['n1']);
            expect(operation.disabled()).toBe('not_downloaded');
        });
    });
});
