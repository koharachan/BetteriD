/**
 * Turn an AI-marked image into map geometry.
 *
 * The "red outline" method asks an image model to draw a thin pure-red line
 * along every building edge and leave the rest of the photo untouched. These
 * helpers find the red strokes, take every region they enclose as a building
 * interior and turn each region into a polygon; the "vision JSON" method asks
 * a vision model for pixel polygons directly and only needs the validation
 * part. Everything here is pure (typed arrays in, arrays out) so the pipeline
 * is unit tested with synthetic images.
 */

import { maskPolygons } from './betterid_imagery';


// marker red (#FF0000) after JPEG compression; strict enough to leave
// terracotta roofs and brick alone
const DEFAULT_RED = Object.freeze({
    minRed: 180,
    maxGreen: 95,
    maxBlue: 95,
    minDominance: 100   // red minus the larger of green / blue
});


/** 1 for every pixel that is "marker red", 0 otherwise. */
export function redMask(imageData, options) {
    const { width, height, data } = imageData;
    const red = Object.assign({}, DEFAULT_RED, options);
    const mask = new Uint8Array(width * height);
    for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        if (r >= red.minRed && g <= red.maxGreen && b <= red.maxBlue &&
            r - Math.max(g, b) >= red.minDominance) {
            mask[p] = 1;
        }
    }
    return mask;
}


/** Grow a mask by `radius` pixels (square structuring element). */
export function dilate(mask, width, height, radius) {
    if (!radius) return mask.slice();
    const out = new Uint8Array(mask.length);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!mask[y * width + x]) continue;
            const minY = Math.max(0, y - radius);
            const maxY = Math.min(height - 1, y + radius);
            const minX = Math.max(0, x - radius);
            const maxX = Math.min(width - 1, x + radius);
            for (let yy = minY; yy <= maxY; yy++) {
                out.fill(1, yy * width + minX, yy * width + maxX + 1);
            }
        }
    }
    return out;
}


/**
 * Pixels reachable from the image border without crossing the strokes.
 * Everything else that is not a stroke is enclosed by one.
 */
function outsideMask(strokes, width, height) {
    const outside = new Uint8Array(strokes.length);
    const stack = [];
    const seed = p => {
        if (strokes[p] || outside[p]) return;
        outside[p] = 1;
        stack.push(p);
    };
    for (let x = 0; x < width; x++) {
        seed(x);
        seed((height - 1) * width + x);
    }
    for (let y = 0; y < height; y++) {
        seed(y * width);
        seed(y * width + width - 1);
    }
    while (stack.length) {
        const p = stack.pop();
        const x = p % width;
        const y = (p - x) / width;
        if (x > 0) seed(p - 1);
        if (x < width - 1) seed(p + 1);
        if (y > 0) seed(p - width);
        if (y < height - 1) seed(p + width);
    }
    return outside;
}


/**
 * The regions enclosed by the strokes, each as its own mask, biggest first.
 * Regions smaller than `minArea` or larger than `maxAreaFraction` of the
 * image are dropped (noise, and a model that redrew the whole picture).
 *
 * @returns {{mask: Uint8Array, area: number}[]}
 */
export function enclosedRegions(strokes, width, height, options) {
    const minArea = (options && options.minArea) || 40;
    const maxArea = Math.floor(width * height * ((options && options.maxAreaFraction) || 0.4));
    const outside = outsideMask(strokes, width, height);
    const visited = new Uint8Array(strokes.length);
    const regions = [];

    for (let start = 0; start < strokes.length; start++) {
        if (strokes[start] || outside[start] || visited[start]) continue;

        const mask = new Uint8Array(strokes.length);
        const stack = [start];
        visited[start] = 1;
        let area = 0;

        while (stack.length) {
            const p = stack.pop();
            mask[p] = 1;
            area++;
            const x = p % width;
            const y = (p - x) / width;
            const neighbours = [];
            if (x > 0) neighbours.push(p - 1);
            if (x < width - 1) neighbours.push(p + 1);
            if (y > 0) neighbours.push(p - width);
            if (y < height - 1) neighbours.push(p + width);
            for (const q of neighbours) {
                if (strokes[q] || outside[q] || visited[q]) continue;
                visited[q] = 1;
                stack.push(q);
            }
        }

        if (area >= minArea && area <= maxArea) regions.push({ mask, area });
    }

    regions.sort((a, b) => b.area - a.area);
    return regions;
}


/**
 * Polygons (pixel coordinates) of the shapes an outlined image encloses.
 *
 * @param {ImageData} imageData the edited image
 * @param {{strokeGrow?: number, minArea?: number, tolerance?: number, red?: object}} options
 * @returns {{points: number[][], area: number}[]}
 */
export function traceOutlines(imageData, options) {
    const { width, height } = imageData;
    const settings = options || {};
    // close the small gaps compression leaves in a thin stroke
    const strokes = dilate(redMask(imageData, settings.red), width, height, settings.strokeGrow ?? 1);
    const regions = enclosedRegions(strokes, width, height, settings);
    const tolerance = settings.tolerance ?? 1.5;
    const result = [];

    regions.forEach(region => {
        // the interior stops at the inner edge of the stroke; grow it back so
        // the outline sits on the stroke centre
        const grown = dilate(region.mask, width, height, settings.strokeGrow ?? 1);
        const polygons = maskPolygons(grown, width, height, tolerance).filter(polygon => polygon.length >= 3);
        if (!polygons.length) return;
        result.push({ points: polygons[0], area: region.area });
    });

    return result;
}


/**
 * How much of the picture the model left alone: the share of non-red pixels
 * whose brightness barely changed (0 = everything differs, 1 = identical).
 * A low score means the geometry cannot be trusted.
 */
export function alignmentScore(original, edited, options) {
    if (original.width !== edited.width || original.height !== edited.height) return 0;
    const strokes = redMask(edited, options && options.red);
    const step = Math.max(1, Math.floor(Math.sqrt((original.width * original.height) / 20000)));
    let compared = 0;
    let same = 0;
    for (let y = 0; y < original.height; y += step) {
        for (let x = 0; x < original.width; x += step) {
            const p = y * original.width + x;
            if (strokes[p]) continue;
            const i = p * 4;
            const a = (original.data[i] * 299 + original.data[i + 1] * 587 + original.data[i + 2] * 114) / 1000;
            const b = (edited.data[i] * 299 + edited.data[i + 1] * 587 + edited.data[i + 2] * 114) / 1000;
            compared++;
            if (Math.abs(a - b) <= 24) same++;
        }
    }
    return compared ? same / compared : 0;
}


/**
 * Polygons from a vision model's JSON answer
 * (`{"buildings":[{"polygon":[[x,y],...]}]}` or a bare array of polygons),
 * validated and clamped to the image.
 *
 * @returns {{points: number[][]}[]}
 */
export function parseVisionPolygons(answer, width, height) {
    let list = [];
    if (Array.isArray(answer)) list = answer;
    else if (answer && typeof answer === 'object') {
        list = answer.buildings || answer.features || answer.polygons || answer.shapes || [];
    }
    if (!Array.isArray(list)) return [];

    const result = [];
    list.forEach(item => {
        const raw = Array.isArray(item) ? item : item && (item.polygon || item.points || item.coordinates);
        if (!Array.isArray(raw)) return;
        const points = [];
        raw.forEach(point => {
            let x;
            let y;
            if (Array.isArray(point) && point.length >= 2) [x, y] = point;
            else if (point && typeof point === 'object') { x = point.x; y = point.y; }
            x = Number(x);
            y = Number(y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            points.push([Math.max(0, Math.min(width, x)), Math.max(0, Math.min(height, y))]);
        });
        // drop a repeated closing point
        if (points.length > 3) {
            const first = points[0];
            const last = points[points.length - 1];
            if (Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6) points.pop();
        }
        if (points.length >= 3 && Math.abs(polygonArea(points)) >= 4) result.push({ points });
    });
    return result;
}


export function polygonArea(points) {
    let area = 0;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        area += (points[j][0] + points[i][0]) * (points[j][1] - points[i][1]);
    }
    return area / 2;
}
