import {
    floodSelect,
    brushSelect,
    pixelHex,
    pixelColor,
    maskOutline,
    maskPolygons
} from '../../../modules/util/betterid_imagery';


/** Build an ImageData-like object: `colors` is one `[r, g, b]` per pixel. */
function imageData(width, height, colors) {
    const data = new Uint8ClampedArray(width * height * 4);
    colors.forEach((color, index) => {
        data[index * 4] = color[0];
        data[index * 4 + 1] = color[1];
        data[index * 4 + 2] = color[2];
        data[index * 4 + 3] = 255;
    });
    return { width, height, data };
}


// a 4x4 image: left half blue, right half red
const LEFT = [0, 0, 255];
const RIGHT = [255, 0, 0];
const split = imageData(4, 4, [
    LEFT, LEFT, RIGHT, RIGHT,
    LEFT, LEFT, RIGHT, RIGHT,
    LEFT, LEFT, RIGHT, RIGHT,
    LEFT, LEFT, RIGHT, RIGHT
]);


describe('betterid imagery selection', function() {
    it('reads pixel colours and their hex', function() {
        expect(pixelColor(split, 0, 0)).toEqual([0, 0, 255]);
        expect(pixelColor(split, 3, 3)).toEqual([255, 0, 0]);
        expect(pixelHex(split, 3, 3)).toEqual('#FF0000');
        expect(pixelHex(split, 9, 9)).toEqual(null);
    });

    it('flood select only walks the connected similar pixels', function() {
        const contiguous = floodSelect(split, { x: 0, y: 0, tolerance: 1, contiguous: true });
        expect(Array.from(contiguous)).toEqual([
            1, 1, 0, 0,
            1, 1, 0, 0,
            1, 1, 0, 0,
            1, 1, 0, 0
        ]);

        const global = floodSelect(split, { x: 0, y: 0, tolerance: 1, contiguous: false });
        expect(Array.from(global)).toEqual(Array.from(contiguous));   // same colours, other half
    });

    it('widens the selection with the tolerance', function() {
        // each tolerance step is ~20 units of RGB distance, so a neighbour that
        // is 28 units away needs step 2
        const almost = imageData(1, 2, [LEFT, [20, 0, 235]]);
        expect(Array.from(floodSelect(almost, { x: 0, y: 0, tolerance: 1, contiguous: true }))).toEqual([1, 0]);
        expect(Array.from(floodSelect(almost, { x: 0, y: 0, tolerance: 2, contiguous: true }))).toEqual([1, 1]);
    });

    it('quick selection only takes brush pixels that match the seed colour', function() {
        const mask = new Uint8Array(16);
        brushSelect(split, mask, {
            points: [[1, 1], [2, 1]],
            radius: 1.5,
            tolerance: 1,
            seed: LEFT
        });
        // the brush covered both halves, but only blue pixels are close enough
        expect(mask[1 * 4 + 1]).toEqual(1);
        expect(mask[1 * 4 + 2]).toEqual(0);
        expect(mask[0 * 4 + 0]).toEqual(1);      // within the radius of (1,1)
        expect(mask[3 * 4 + 3]).toEqual(0);
    });

    it('traces the outline of a mask', function() {
        const mask = new Uint8Array(16);
        mask[1 * 4 + 1] = 1;   // a single pixel at (1,1)
        const runs = maskOutline(mask, 4, 4);
        expect(runs.length).toEqual(4);          // its four edges
        expect(runs).toContainEqual([1, 1, 2, 1]);
        expect(runs).toContainEqual([1, 2, 2, 2]);
        expect(runs).toContainEqual([1, 1, 1, 2]);
        expect(runs).toContainEqual([2, 1, 2, 2]);
    });

    it('turns a mask into closed polygons for convert-to-path', function() {
        const mask = new Uint8Array(16);
        for (let y = 0; y < 3; y++) {
            for (let x = 0; x < 3; x++) mask[y * 4 + x] = 1;
        }
        const polygons = maskPolygons(mask, 4, 4);
        expect(polygons.length).toEqual(1);
        expect(polygons[0].length).toBeGreaterThanOrEqual(4);

        // every corner of the filled square is on the traced path
        const xs = polygons[0].map(p => p[0]);
        const ys = polygons[0].map(p => p[1]);
        expect(Math.min(...xs)).toEqual(0);
        expect(Math.max(...xs)).toEqual(3);
        expect(Math.min(...ys)).toEqual(0);
        expect(Math.max(...ys)).toEqual(3);
    });
});
