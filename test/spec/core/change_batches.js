describe('iD.coreChangeBatches', function() {
    it('keeps a new way with its new child nodes', function() {
        var n1 = new iD.osmNode({ id: 'n-1', loc: [116.3, 39.9] });
        var n2 = new iD.osmNode({ id: 'n-2', loc: [116.4, 39.9] });
        var way = new iD.osmWay({ id: 'w-1', nodes: [n1.id, n2.id] });
        var graph = new iD.coreGraph([n1, n2, way]);
        var changes = { created: [n1, n2, way], deleted: [], modified: [] };

        var batches = iD.coreChangeBatches(changes, graph, { maxChanges: 2, strategy: 'fixed' });

        expect(batches).toHaveLength(1);
        expect(batches[0].created).toEqual([n1, n2, way]);
    });

    it('chunks independent entities by the requested size', function() {
        var nodes = [0, 1, 2, 3, 4].map(function(index) {
            return new iD.osmNode({ id: `n-${index + 1}`, loc: [116 + index, 39] });
        });
        var graph = new iD.coreGraph(nodes);
        var changes = { created: nodes, deleted: [], modified: [] };

        var batches = iD.coreChangeBatches(changes, graph, { maxChanges: 2, strategy: 'fixed' });

        expect(batches.map(batch => batch.count)).toEqual([2, 2, 1]);
    });

    it('keeps relation members in the same dependency component', function() {
        var node = new iD.osmNode({ id: 'n-1', loc: [116.3, 39.9] });
        var relation = new iD.osmRelation({
            id: 'r-1',
            members: [{ id: node.id, role: '', type: 'node' }]
        });
        var graph = new iD.coreGraph([node, relation]);
        var changes = { created: [node, relation], deleted: [], modified: [] };

        var batches = iD.coreChangeBatches(changes, graph, { maxChanges: 1, strategy: 'fixed' });

        expect(batches).toHaveLength(1);
        expect(batches[0].count).toBe(2);
    });
});
