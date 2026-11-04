import { prefs } from '../../../modules/core/preferences';
import {
    LAST_GEOREF_PREF,
    buildGeoref,
    commitAnnotatedFeatures,
    embedPngText,
    georefForImage,
    locToPixel,
    pixelToLoc,
    readPngText
} from '../../../modules/util/betterid_imagery_exchange';

const TINY_PNG = Uint8Array.from(atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
), char => char.charCodeAt(0));


describe('betterid imagery exchange', function() {
    afterEach(function() {
        prefs(LAST_GEOREF_PREF, null);
    });

    it('round-trips a pixel through the saved map transform', function() {
        const georef = georefForImage(buildGeoref({ k: 256, x: 128, y: 128 }, {
            x: 10, y: 20, width: 100, height: 80
        }), 200, 160);
        const loc = pixelToLoc(georef, 40, 50);
        const back = locToPixel(georef, loc);
        expect(back[0]).toBeCloseTo(40, 5);
        expect(back[1]).toBeCloseTo(50, 5);
    });

    it('stores and reads a georef tEXt chunk', function() {
        const text = JSON.stringify({ version: 1, width: 2, height: 2 });
        const png = embedPngText(TINY_PNG, 'betterid-georef', text);
        expect(readPngText(png, 'betterid-georef')).toEqual(text);
        expect(readPngText(png, 'other')).toBeNull();
    });

    it('commits closed building ways from annotated coordinates', function() {
        let graph = new iD.coreGraph();
        const context = {
            perform: (...args) => {
                args.slice(0, -1).forEach(action => { graph = action(graph); });
            },
            hasEntity: id => graph.hasEntity(id)
        };
        const ids = commitAnnotatedFeatures(context, {
            buildings: [{
                loc: [[0, 0], [0, 0.001], [0.001, 0.001]],
                tags: { building: 'yes' }
            }],
            areas: [{
                loc: [[1, 1], [1, 1.002], [1.002, 1.002], [1.002, 1]],
                tags: { area: 'yes' }
            }]
        });
        expect(ids).toHaveLength(2);
        const building = graph.entity(ids[0]);
        const area = graph.entity(ids[1]);
        expect(building.isClosed()).toBe(true);
        expect(building.tags.building).toEqual('yes');
        expect(area.tags.area).toEqual('yes');
        expect(area.nodes[0]).toEqual(area.nodes[area.nodes.length - 1]);
    });
});
