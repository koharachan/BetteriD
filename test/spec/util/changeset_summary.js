describe('iD.utilChangesetSummary', function() {
    it('prioritizes named features and omits entity ids and supporting nodes', function() {
        var school = new iD.osmNode({ id: 'n-1', loc: [1, 1], tags: { amenity: 'school', name: '测试学校' } });
        var r1 = new iD.osmNode({ id: 'n-2', loc: [0.5, 0.5] });
        var r2 = new iD.osmNode({ id: 'n-3', loc: [1.5, 1.5] });
        var road = new iD.osmWay({ id: 'w-1', nodes: [r1.id, r2.id], tags: { highway: 'service', name: '校园内部道路' } });
        var a1 = new iD.osmNode({ id: 'n-4', loc: [0, 0] });
        var a2 = new iD.osmNode({ id: 'n-5', loc: [2, 0] });
        var a3 = new iD.osmNode({ id: 'n-6', loc: [2, 2] });
        var a4 = new iD.osmNode({ id: 'n-7', loc: [0, 2] });
        var campus = new iD.osmWay({
            id: 'w-2',
            nodes: [a1.id, a2.id, a3.id, a4.id, a1.id],
            tags: { landuse: 'education', name: '东河学校' }
        });
        var graph = new iD.coreGraph([school, r1, r2, road, a1, a2, a3, a4, campus]);

        var summary = iD.utilChangesetSummary({
            created: [school, r1, r2, road],
            deleted: [],
            modified: []
        }, {
            graph: graph,
            nearby: [campus],
            relevant: [
                { changeType: 'created', entity: school, graph: graph },
                { changeType: 'created', entity: road, graph: graph }
            ]
        });
        var serialized = JSON.stringify(summary);

        expect(summary.total).toBe(4);
        expect(summary.features).toEqual([
            { count: 1, feature: 'amenity=school' },
            { count: 1, feature: 'highway=service' }
        ]);
        expect(summary.meaningful_counts.created).toEqual({ area: 0, line: 1, point: 1, relation: 0 });
        expect(summary.supporting_geometry_nodes.created).toBe(2);
        expect(summary.named_features.map(item => item.name)).toEqual(['测试学校', '校园内部道路']);
        expect(summary.surrounding_named_areas).toEqual([{ feature: 'landuse=education', name: '东河学校' }]);
        expect(summary.actual_changes.map(item => item.action)).toEqual(['created', 'created']);
        expect(serialized).toContain('东河学校');
        expect(serialized).not.toContain('n-1');
        expect(serialized).not.toContain('w-1');
    });

    it('compares before and after values without listing unchanged tags as edits', function() {
        var n1 = new iD.osmNode({ id: 'n-10', loc: [0, 0] });
        var n2 = new iD.osmNode({ id: 'n-11', loc: [1, 1] });
        var roadBefore = new iD.osmWay({
            id: 'w-10',
            nodes: [n1.id, n2.id],
            tags: { highway: 'service', maxspeed: '20', name: '校园内部道路', surface: 'gravel' }
        });
        var roadAfter = roadBefore.update({
            tags: { highway: 'service', lit: 'yes', name: '校园内部道路', surface: 'asphalt' }
        });
        var baseGraph = new iD.coreGraph([n1, n2, roadBefore]);
        var graph = baseGraph.replace(roadAfter);
        var summary = iD.utilChangesetSummary({
            created: [],
            deleted: [],
            modified: [roadAfter]
        }, {
            baseGraph: baseGraph,
            entityChanges: { 'w-10': { base: roadBefore, head: roadAfter } },
            graph: graph,
            relevant: [{ changeType: 'modified', entity: roadAfter, graph: graph }]
        });

        expect(summary.actual_changes).toEqual([{
            action: 'modified',
            feature_after: 'highway=service',
            feature_before: 'highway=service',
            geometry: 'line',
            geometry_changed: false,
            name_after: '校园内部道路',
            name_before: '校园内部道路',
            tag_changes: {
                added: [{ key: 'lit', value: 'yes' }],
                changed: [{ after: 'asphalt', before: 'gravel', key: 'surface' }],
                removed: [{ key: 'maxspeed', value: '20' }]
            }
        }]);
        expect(JSON.stringify(summary.actual_changes[0].tag_changes)).not.toContain('highway');
        expect(JSON.stringify(summary.actual_changes[0].tag_changes)).not.toContain('name');
    });

    it('reports a moved way vertex as geometry-only change', function() {
        var nodeBefore = new iD.osmNode({ id: 'n-20', loc: [0, 0] });
        var nodeAfter = nodeBefore.move([0.5, 0.5]);
        var end = new iD.osmNode({ id: 'n-21', loc: [1, 1] });
        var road = new iD.osmWay({
            id: 'w-20',
            nodes: [nodeBefore.id, end.id],
            tags: { highway: 'service', name: '校园内部道路' }
        });
        var baseGraph = new iD.coreGraph([nodeBefore, end, road]);
        var graph = baseGraph.replace(nodeAfter);
        var summary = iD.utilChangesetSummary({
            created: [],
            deleted: [],
            modified: [nodeAfter]
        }, {
            baseGraph: baseGraph,
            entityChanges: { 'n-20': { base: nodeBefore, head: nodeAfter } },
            graph: graph,
            relevant: [{ changeType: 'modified', entity: road, graph: graph }]
        });

        expect(summary.actual_changes[0].geometry_changed).toBe(true);
        expect(summary.actual_changes[0].tag_changes).toEqual({ added: [], changed: [], removed: [] });
        expect(summary.actual_changes[0].feature_before).toBe('highway=service');
        expect(summary.actual_changes[0].feature_after).toBe('highway=service');
    });
});
