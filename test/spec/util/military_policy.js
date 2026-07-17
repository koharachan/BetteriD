import {
    actionChangeTags,
    actionMoveNode,
    coreContext,
    coreGraph,
    osmNode,
    osmRelation,
    osmWay,
    utilMilitaryEditViolation
} from '../../../modules';
import { uiMilitaryOfficialEditURL } from '../../../modules/ui/military_warning';


describe('military edit policy', function() {
    function militaryWayGraph(center = [116.4, 39.9]) {
        const [x, y] = center;
        const nodes = [
            new osmNode({ id: 'n1', loc: [x, y] }),
            new osmNode({ id: 'n2', loc: [x + 0.001, y] }),
            new osmNode({ id: 'n3', loc: [x + 0.001, y + 0.001] })
        ];
        const way = new osmWay({
            id: 'w1',
            nodes: ['n1', 'n2', 'n3', 'n1'],
            tags: { landuse: 'military' }
        });
        return new coreGraph([...nodes, way]);
    }

    it.each([
        ['mainland China', [116.4, 39.9]],
        ['Hong Kong', [114.17, 22.3]],
        ['Macao', [113.55, 22.2]]
    ])('blocks changing military area vertices in %s', function(_name, center) {
        const before = militaryWayGraph(center);
        const after = actionMoveNode('n1', [center[0] + 0.01, center[1]])(before);

        expect(utilMilitaryEditViolation(before, after)).toMatchObject({
            type: 'protected_military',
            entityID: 'n1'
        });
    });

    it('blocks members nested inside a military multipolygon', function() {
        const before = militaryWayGraph();
        const way = before.entity('w1').update({ tags: {} });
        const relation = new osmRelation({
            id: 'r1',
            tags: { type: 'multipolygon', military: 'danger_area' },
            members: [{ id: 'w1', type: 'way', role: 'outer' }]
        });
        const graph = before.replace(way).replace(relation);
        const after = actionMoveNode('n2', [116.42, 39.9])(graph);

        expect(utilMilitaryEditViolation(graph, after)?.type).toBe('protected_military');
    });

    it('blocks tagging an existing Chinese area as military', function() {
        const before = militaryWayGraph().replace(
            militaryWayGraph().entity('w1').update({ tags: { landuse: 'forest' } })
        );
        const after = actionChangeTags('w1', { landuse: 'military' })(before);

        expect(utilMilitaryEditViolation(before, after)?.type).toBe('create_military');
    });

    it('blocks creating a Chinese military=* area', function() {
        const military = militaryWayGraph();
        const before = military.replace(military.entity('w1').update({ tags: { landuse: 'forest' } }));
        const after = actionChangeTags('w1', { military: 'training_area' })(before);

        expect(utilMilitaryEditViolation(before, after)?.type).toBe('create_military');
    });

    it.each([
        ['retagging the area', graph => actionChangeTags('w1', { landuse: 'military', name: 'changed' })(graph)],
        ['retagging a member node', graph => actionChangeTags('n2', { barrier: 'gate' })(graph)],
        ['deleting a member node', graph => graph.remove(graph.entity('n2'))]
    ])('blocks %s on an existing Chinese military area', function(_name, edit) {
        const before = militaryWayGraph();

        expect(utilMilitaryEditViolation(before, edit(before))?.type).toBe('protected_military');
    });

    it('does not apply the China policy to military areas elsewhere', function() {
        const before = militaryWayGraph([-73.98, 40.75]);
        const after = actionMoveNode('n1', [-73.97, 40.75])(before);

        expect(utilMilitaryEditViolation(before, after)).toBeNull();
    });

    it('blocks perform and redo at the history write boundary', function() {
        const context = coreContext().init();
        const graph = militaryWayGraph();
        context.history().merge(Object.values(graph.base().entities));

        let blocked = 0;
        context.on('blockedEdit.test', () => blocked++);
        context.perform(graph => actionMoveNode('n1', [116.41, 39.9])(graph), 'move');

        expect(context.entity('n1').loc).toStrictEqual([116.4, 39.9]);
        expect(blocked).toBe(1);

        context.replace(graph => actionChangeTags('n2', { barrier: 'gate' })(graph), 'retag');
        expect(context.entity('n2').tags).toStrictEqual({});
        expect(blocked).toBe(2);

        const policy = context.editPolicy;
        context.editPolicy = () => null;
        context.perform(graph => actionMoveNode('n1', [116.41, 39.9])(graph), 'move');
        expect(context.history().undoAnnotation()).toBe('move');
        context.undo();
        context.editPolicy = policy;
        expect(context.history().redoAnnotation()).toBe('move');
        expect(context.editPolicy(
            context.graph(),
            actionMoveNode('n1', [116.41, 39.9])(context.graph())
        )?.type)
            .toBe('protected_military');
        context.redo();

        expect(context.entity('n1').loc).toStrictEqual([116.4, 39.9]);
        expect(blocked).toBe(3);
    });

    it('builds an official OSM editor link at the blocked location', function() {
        const context = {
            map: () => ({ center: () => [0, 0], zoom: () => 14 })
        };

        expect(uiMilitaryOfficialEditURL(context, [116.4, 39.9]))
            .toBe('https://www.openstreetmap.org/edit?editor=id#map=16/39.9/116.4');
    });
});
