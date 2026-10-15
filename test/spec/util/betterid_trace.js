import {
    alignmentScore, dilate, enclosedRegions, parseVisionPolygons, polygonArea, redMask, traceOutlines
} from '../../../modules/util/betterid_trace';


/** A synthetic "photo": grey ground with red rectangle outlines drawn on it. */
function image(width, height, draw) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
        data[i] = 120; data[i + 1] = 125; data[i + 2] = 110; data[i + 3] = 255;
    }
    const img = { width, height, data };
    if (draw) draw(img);
    return img;
}

function setPixel(img, x, y, rgb) {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
    const i = (y * img.width + x) * 4;
    img.data[i] = rgb[0]; img.data[i + 1] = rgb[1]; img.data[i + 2] = rgb[2]; img.data[i + 3] = 255;
}

function redRect(img, x1, y1, x2, y2, rgb) {
    const colour = rgb || [255, 0, 0];
    for (let x = x1; x <= x2; x++) { setPixel(img, x, y1, colour); setPixel(img, x, y2, colour); }
    for (let y = y1; y <= y2; y++) { setPixel(img, x1, y, colour); setPixel(img, x2, y, colour); }
}

function bounds(points) {
    const xs = points.map(p => p[0]);
    const ys = points.map(p => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}


describe('betterid AI tracing', function() {

    it('picks marker red and ignores roofs that are merely reddish', function() {
        const img = image(4, 1);
        setPixel(img, 0, 0, [255, 0, 0]);       // pure red stroke
        setPixel(img, 1, 0, [200, 60, 50]);     // compressed stroke edge
        setPixel(img, 2, 0, [170, 110, 100]);   // terracotta roof
        setPixel(img, 3, 0, [255, 200, 200]);   // pink
        expect(Array.from(redMask(img))).toEqual([1, 1, 0, 0]);
    });

    it('dilates a mask', function() {
        const mask = new Uint8Array(25);
        mask[12] = 1;   // centre of 5x5
        const grown = dilate(mask, 5, 5, 1);
        expect(Array.from(grown).reduce((a, b) => a + b, 0)).toEqual(9);
        expect(dilate(mask, 5, 5, 0)).not.toBe(mask);
    });

    it('finds the regions enclosed by strokes and drops noise', function() {
        const img = image(60, 40, i => {
            redRect(i, 5, 5, 25, 20);     // building A
            redRect(i, 35, 10, 55, 35);   // building B
            redRect(i, 30, 2, 31, 3);     // a 2x2 speck: encloses nothing
        });
        const regions = enclosedRegions(redMask(img), 60, 40);
        expect(regions).toHaveLength(2);
        expect(regions[0].area).toBeGreaterThan(regions[1].area);
        expect(regions[0].area).toEqual(19 * 24);   // B interior
        expect(regions[1].area).toEqual(19 * 14);   // A interior
    });

    it('traces outlined buildings into polygons on the stroke', function() {
        const img = image(90, 70, i => {
            redRect(i, 10, 10, 40, 30);
            redRect(i, 50, 20, 75, 55);
        });
        const shapes = traceOutlines(img, { strokeGrow: 1 });
        expect(shapes).toHaveLength(2);
        shapes.forEach(shape => expect(shape.points.length).toBeGreaterThanOrEqual(4));

        const [bx1, by1, bx2, by2] = bounds(shapes[0].points);
        // the bigger one is the 50..75 x 20..55 rectangle, within a pixel of the stroke
        expect(Math.abs(bx1 - 50)).toBeLessThanOrEqual(1);
        expect(Math.abs(by1 - 20)).toBeLessThanOrEqual(1);
        expect(Math.abs(bx2 - 76)).toBeLessThanOrEqual(1);
        expect(Math.abs(by2 - 56)).toBeLessThanOrEqual(1);
    });

    it('closes small gaps in a stroke', function() {
        const img = image(60, 40, i => {
            redRect(i, 5, 5, 45, 30);
            setPixel(i, 25, 5, [120, 125, 110]);   // one missing pixel in the top edge
        });
        expect(traceOutlines(img, { strokeGrow: 0 })).toHaveLength(0);
        expect(traceOutlines(img, { strokeGrow: 1 })).toHaveLength(1);
    });

    it('scores how much of the image the model left alone', function() {
        const original = image(50, 50);
        const marked = image(50, 50, i => redRect(i, 10, 10, 30, 30));
        expect(alignmentScore(original, marked)).toBeGreaterThan(0.95);

        const redrawn = image(50, 50, i => {
            for (let y = 0; y < 50; y++) for (let x = 0; x < 50; x++) setPixel(i, x, y, [30, 30, 30]);
        });
        expect(alignmentScore(original, redrawn)).toBeLessThan(0.1);
        expect(alignmentScore(original, image(10, 10))).toEqual(0);
    });

    it('validates polygons from a vision model answer', function() {
        const answer = {
            buildings: [
                { polygon: [[10, 10], [50, 10], [50, 40], [10, 40], [10, 10]] },
                { polygon: [[-5, 5], [20, 5], [20, 300]] },   // clamped into the image
                { polygon: [[1, 1], [2, 1]] },                // too few points
                { polygon: [{ x: 60, y: 60 }, { x: 70, y: 60 }, { x: 70, y: 70 }] },
                { polygon: 'nonsense' }
            ]
        };
        const result = parseVisionPolygons(answer, 100, 100);
        expect(result).toHaveLength(3);
        expect(result[0].points).toHaveLength(4);   // closing point dropped
        expect(result[1].points[0]).toEqual([0, 5]);
        expect(result[1].points[2]).toEqual([20, 100]);
        expect(result[2].points).toEqual([[60, 60], [70, 60], [70, 70]]);

        expect(parseVisionPolygons([[[0, 0], [10, 0], [10, 10]]], 20, 20)).toHaveLength(1);
        expect(parseVisionPolygons(null, 20, 20)).toEqual([]);
    });

    it('computes a signed polygon area', function() {
        expect(Math.abs(polygonArea([[0, 0], [10, 0], [10, 10], [0, 10]]))).toEqual(100);
    });
});
