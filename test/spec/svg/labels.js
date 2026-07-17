describe('svgLabels', function() {
    describe('#areaGeometryIsComplete', function() {
        it('returns true for a way whose referenced nodes are loaded', function() {
            var n1 = new iD.osmNode({ id: 'n1', loc: [0, 0] });
            var n2 = new iD.osmNode({ id: 'n2', loc: [1, 0] });
            var way = new iD.osmWay({ id: 'w1', nodes: ['n1', 'n2', 'n1'] });
            var graph = new iD.coreGraph([n1, n2, way]);

            expect(iD.areaGeometryIsComplete(way, graph)).toBe(true);
        });

        it('returns false for a way with a missing referenced node', function() {
            var n1 = new iD.osmNode({ id: 'n1', loc: [0, 0] });
            var way = new iD.osmWay({ id: 'w1', nodes: ['n1', 'n2', 'n1'] });
            var graph = new iD.coreGraph([n1, way]);

            expect(iD.areaGeometryIsComplete(way, graph)).toBe(false);
        });

        it('returns false for a relation with incomplete child geometry', function() {
            var n1 = new iD.osmNode({ id: 'n1', loc: [0, 0] });
            var way = new iD.osmWay({ id: 'w1', nodes: ['n1', 'n2', 'n1'] });
            var relation = new iD.osmRelation({
                id: 'r1',
                members: [{ id: 'w1', type: 'way', role: 'outer' }]
            });
            var graph = new iD.coreGraph([n1, way, relation]);

            expect(iD.areaGeometryIsComplete(relation, graph)).toBe(false);
        });

        it('returns false for a relation with a missing member', function() {
            var relation = new iD.osmRelation({
                id: 'r1',
                members: [{ id: 'w1', type: 'way', role: 'outer' }]
            });
            var graph = new iD.coreGraph([relation]);

            expect(iD.areaGeometryIsComplete(relation, graph)).toBe(false);
        });
    });
});
