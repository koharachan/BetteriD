import {
    tagDistance, insideEllipse, expandBySimilarity
} from '../../../modules/util/betterid_selection';
import { combineSelection, selectionMode } from '../../../modules/core/betterid_tools';


describe('betterid selection helpers', function() {

    describe('tagDistance', function() {
        it('counts differing tag keys', function() {
            expect(tagDistance({ a: '1', b: '2' }, { a: '1', b: '2' })).toBe(0);
            expect(tagDistance({ a: '1' }, { a: '2' })).toBe(1);
            expect(tagDistance({ a: '1' }, { b: '1' })).toBe(2);
            expect(tagDistance({ highway: 'residential' }, { highway: 'residential', name: 'x' })).toBe(1);
            expect(tagDistance({}, {})).toBe(0);
        });
    });

    describe('insideEllipse', function() {
        const ellipse = { centerX: 100, centerY: 100, radiusX: 50, radiusY: 20 };

        it('accepts points inside and on the boundary', function() {
            expect(insideEllipse([100, 100], ellipse)).toBe(true);
            expect(insideEllipse([150, 100], ellipse)).toBe(true);
            expect(insideEllipse([100, 120], ellipse)).toBe(true);
        });

        it('rejects points outside', function() {
            expect(insideEllipse([151, 100], ellipse)).toBe(false);
            expect(insideEllipse([100, 121], ellipse)).toBe(false);
            expect(insideEllipse([300, 300], ellipse)).toBe(false);
        });
    });

    describe('expandBySimilarity', function() {
        function graph() {
            return new iD.coreGraph([
                new iD.osmNode({ id: 'n1', loc: [0, 0] }),
                new iD.osmNode({ id: 'n2', loc: [1, 0] }),
                new iD.osmNode({ id: 'n3', loc: [2, 0] }),
                new iD.osmNode({ id: 'n4', loc: [3, 0] }),
                new iD.osmWay({ id: 'w1', nodes: ['n1', 'n2'], tags: { highway: 'residential' } }),
                new iD.osmWay({ id: 'w2', nodes: ['n2', 'n3'], tags: { highway: 'residential' } }),
                new iD.osmWay({ id: 'w3', nodes: ['n3', 'n4'], tags: { highway: 'primary' } }),
                new iD.osmWay({ id: 'w4', nodes: ['n1', 'n4'], tags: { building: 'yes' } })
            ]);
        }

        it('floods along connected, identically tagged ways', function() {
            const ids = expandBySimilarity(graph(), ['w1'], { tolerance: 0, contiguous: true, sameGeometry: true });
            expect(ids).toContain('w1');
            expect(ids).toContain('w2');   // shares n2, same tags
            expect(ids).not.toContain('w3'); // different highway value
            expect(ids).not.toContain('w4'); // different geometry class
        });

        it('includes neighbours within the tolerance', function() {
            const ids = expandBySimilarity(graph(), ['w1'], { tolerance: 1, contiguous: true, sameGeometry: true });
            expect(ids).toContain('w3');
        });

        it('stops at the seed when contiguous expansion cannot match', function() {
            const ids = expandBySimilarity(graph(), ['w4'], { tolerance: 0, contiguous: true, sameGeometry: true });
            expect(ids).toEqual(['w4']);
        });

        it('matches by tags anywhere when not contiguous', function() {
            const ids = expandBySimilarity(graph(), ['w1'], { tolerance: 0, contiguous: false, sameGeometry: true });
            expect(ids).toContain('w2');
            expect(ids).not.toContain('w4');
        });
    });

    describe('Photoshop modifier semantics', function() {
        it('maps Shift/Alt/Shift+Alt to add/subtract/intersect', function() {
            expect(selectionMode({})).toBe('replace');
            expect(selectionMode({ shiftKey: true })).toBe('add');
            expect(selectionMode({ altKey: true })).toBe('subtract');
            expect(selectionMode({ shiftKey: true, altKey: true })).toBe('intersect');
        });

        it('combines selections', function() {
            expect(combineSelection(['a', 'b'], ['c'], 'replace')).toEqual(['c']);
            expect(combineSelection(['a', 'b'], ['c'], 'add').sort()).toEqual(['a', 'b', 'c']);
            expect(combineSelection(['a', 'b'], ['b'], 'subtract')).toEqual(['a']);
            expect(combineSelection(['a', 'b'], ['b', 'c'], 'intersect')).toEqual(['b']);
        });
    });
});
