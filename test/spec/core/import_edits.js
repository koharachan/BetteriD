import { coreImportEdits, coreParseEdits } from '../../../modules/core/import_edits';
import { osmNode } from '../../../modules/osm';


const OSC = `<?xml version="1.0" encoding="UTF-8"?>
<osmChange version="0.6" generator="BetteriD">
  <create>
    <node id="-1" lat="52.1" lon="5.1"><tag k="amenity" v="cafe"/></node>
  </create>
  <modify>
    <way id="-2"><nd ref="-1"/><nd ref="-1"/><tag k="highway" v="service"/></way>
  </modify>
</osmChange>`;


describe('coreImportEdits', function() {
    let context;

    beforeEach(function() {
        context = iD.coreContext().assetPath('../dist/').init();
    });

    function loadBase(entities) {
        context.history().merge(entities);
    }

    it('imports osmChange create/modify entries as pending edits', function() {
        const result = coreImportEdits(context, OSC);

        expect(result.imported).toBe(2);
        expect(result.skipped).toBe(0);
        expect(context.hasEntity('n-1')).toBeTruthy();
        expect(context.hasEntity('w-2')).toBeTruthy();
        expect(context.history().hasChanges()).toBe(true);
        expect(context.history().difference().summary().length).toBe(2);
    });

    it('applies <delete> entries to existing features', function() {
        loadBase([new osmNode({ id: 'n1001', loc: [5.1, 52.1] })]);

        const result = coreImportEdits(context, '<osmChange><delete><node id="1001"/></delete></osmChange>');

        expect(result.deleted).toBe(1);
        expect(context.hasEntity('n1001')).toBeFalsy();
    });

    it('skips ways whose nodes are neither in the file nor in the graph', function() {
        const result = coreImportEdits(context, '<osmChange><create><way id="-5"><nd ref="999"/></way></create></osmChange>');

        expect(result.imported).toBe(0);
        expect(result.skipped).toBe(1);
        expect(context.hasEntity('w-5')).toBeFalsy();
    });

    it('reads plain .osm documents and keeps existing ids', function() {
        const result = coreImportEdits(context,
            '<osm version="0.6"><node id="2002" lat="52.2" lon="5.2"><tag k="name" v="x"/></node></osm>');

        expect(result.imported).toBe(1);
        expect(context.hasEntity('n2002')).toBeTruthy();
    });

    it('treats visible="false" entries in .osm files as deletions', function() {
        loadBase([new osmNode({ id: 'n3003', loc: [5.3, 52.3] })]);

        const result = coreImportEdits(context,
            '<osm version="0.6"><node id="3003" lat="52.3" lon="5.3" visible="false"/></osm>');

        expect(result.deleted).toBe(1);
        expect(context.hasEntity('n3003')).toBeFalsy();
    });

    it('parses tags, way nodes and relation members', function() {
        const parsed = coreParseEdits(`<osmChange><create>
            <node id="1" lat="1" lon="2"><tag k="a" v="b"/></node>
            <way id="3"><nd ref="1"/><nd ref="2"/></way>
            <relation id="4"><member type="way" ref="3" role="outer"/></relation>
        </create></osmChange>`);

        const node = parsed.entities.find(entity => entity.id === 'n1');
        const way = parsed.entities.find(entity => entity.id === 'w3');
        const relation = parsed.entities.find(entity => entity.id === 'r4');

        expect(node.tags).toStrictEqual({ a: 'b' });
        expect(way.nodes).toStrictEqual(['n1', 'n2']);
        expect(relation.members).toStrictEqual([{ type: 'way', id: 'w3', role: 'outer' }]);
    });

    it('rejects invalid XML and files without features', function() {
        expect(() => coreParseEdits('<osmChange><create>')).toThrow();
        expect(() => coreParseEdits('<osm></osm>')).toThrow();
        expect(() => coreParseEdits('   ')).toThrow();
    });
});
