/**
 * Raster helpers behind the Photoshop-style tools.
 *
 * The magic wand and the quick selection tool work on the *base imagery*, the
 * way they work on pixels in Photoshop, so these helpers capture the visible
 * raster, run the selection maths on it, and turn a selection back into map
 * geometry (marching-ant outlines, and the "convert selection to path" action).
 *
 * Tiles are re-fetched in CORS mode before they are drawn: drawing an
 * `<img>` straight from another origin would taint the canvas and make
 * `getImageData` throw in Firefox.
 */

const MAX_CANVAS_PIXELS = 4000 * 4000;


/** All tile images of the visible raster layers (topmost layer last). */
function tileImages() {
    return Array.from(document.querySelectorAll('img.tile'));
}


/**
 * Draw the visible base imagery into a canvas aligned with the map container.
 * Returns `null` when nothing readable is on screen.
 *
 * @param {*} context
 * @returns {Promise<{canvas: HTMLCanvasElement, width: number, height: number}|null>}
 */
export async function captureImagery(context) {
    const mapNode = context.container().select('.main-map').node();
    if (!mapNode) return null;

    const base = mapNode.getBoundingClientRect();
    const width = Math.round(base.width);
    const height = Math.round(base.height);
    if (width < 8 || height < 8 || width * height > MAX_CANVAS_PIXELS) return null;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    const tiles = tileImages().filter(image => {
        const rect = image.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        if (!image.complete || !image.naturalWidth) return false;
        return rect.right > base.left && rect.left < base.right &&
            rect.bottom > base.top && rect.top < base.bottom;
    });

    if (!tiles.length) return null;

    // fetch every tile at once: a cold capture would otherwise wait for each
    // tile in turn and feel broken
    const bitmaps = await Promise.all(tiles.map(image => loadBitmap(image)));

    let drawn = 0;
    bitmaps.forEach((bitmap, index) => {
        if (!bitmap) return;
        const rect = tiles[index].getBoundingClientRect();
        ctx.drawImage(
            bitmap.source,
            bitmap.x, bitmap.y, bitmap.width, bitmap.height,
            rect.left - base.left, rect.top - base.top, rect.width, rect.height
        );
        drawn++;
    });

    if (!drawn) return null;
    return { canvas, width, height };
}


/**
 * A drawable copy of a tile. Cross-origin tiles are fetched again (CORS) so the
 * canvas stays readable; same-origin tiles are used as they are.
 */
async function loadBitmap(image) {
    const usable = {
        source: image,
        x: 0,
        y: 0,
        width: image.naturalWidth,
        height: image.naturalHeight
    };

    const src = image.currentSrc || image.src;
    if (!src) return null;

    const crossOrigin = (() => {
        try {
            return new URL(src, window.location.href).origin !== window.location.origin;
        } catch {
            return true;   // unparsable URL: treat it as foreign
        }
    })();

    if (crossOrigin) {
        try {
            const response = await fetch(src, { mode: 'cors', credentials: 'omit' });
            if (!response.ok) return null;
            const blob = await response.blob();
            if (typeof createImageBitmap !== 'function') return null;
            const bitmap = await createImageBitmap(blob);
            return { source: bitmap, x: 0, y: 0, width: bitmap.width, height: bitmap.height };
        } catch {
            return null;   // no CORS: this imagery cannot be read at all
        }
    }

    return usable;
}


/** The hex colour of one pixel of a captured image, or `null`. */
export function pixelHex(imageData, x, y) {
    const { width, height, data } = imageData;
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    const i = (y * width + x) * 4;
    const value = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    return '#' + value.toString(16).padStart(6, '0').toUpperCase();
}


function colorLimit(tolerance) {
    // the wand options are 0..10; each step is ~20 units of RGB distance
    return Math.max(0, tolerance) * 20;
}


function colorDistance(data, i, r, g, b) {
    const dr = data[i] - r;
    const dg = data[i + 1] - g;
    const db = data[i + 2] - b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
}


/**
 * Flood selection from one pixel (magic wand). `contiguous` limits it to the
 * connected region, otherwise every similar pixel of the image is selected.
 *
 * @returns {Uint8Array} one byte per pixel, 1 = selected
 */
export function floodSelect(imageData, options) {
    const { width, height, data } = imageData;
    const mask = new Uint8Array(width * height);
    const seedX = Math.round(options.x);
    const seedY = Math.round(options.y);
    if (seedX < 0 || seedY < 0 || seedX >= width || seedY >= height) return mask;

    const seed = (seedY * width + seedX) * 4;
    const r = data[seed];
    const g = data[seed + 1];
    const b = data[seed + 2];
    const limit = colorLimit(options.tolerance);

    if (!options.contiguous) {
        for (let p = 0; p < width * height; p++) {
            if (colorDistance(data, p * 4, r, g, b) <= limit) mask[p] = 1;
        }
        return mask;
    }

    const stack = [seedY * width + seedX];
    mask[stack[0]] = 1;
    while (stack.length) {
        const p = stack.pop();
        const x = p % width;
        const y = (p - x) / width;

        if (x > 0 && !mask[p - 1] && colorDistance(data, (p - 1) * 4, r, g, b) <= limit) {
            mask[p - 1] = 1; stack.push(p - 1);
        }
        if (x < width - 1 && !mask[p + 1] && colorDistance(data, (p + 1) * 4, r, g, b) <= limit) {
            mask[p + 1] = 1; stack.push(p + 1);
        }
        if (y > 0 && !mask[p - width] && colorDistance(data, (p - width) * 4, r, g, b) <= limit) {
            mask[p - width] = 1; stack.push(p - width);
        }
        if (y < height - 1 && !mask[p + width] && colorDistance(data, (p + width) * 4, r, g, b) <= limit) {
            mask[p + width] = 1; stack.push(p + width);
        }
    }

    return mask;
}


/**
 * Quick selection: everything under the brush that is close to the colour the
 * gesture started on, added to `mask`.
 */
export function brushSelect(imageData, mask, options) {
    const { width, height, data } = imageData;
    const radius = Math.max(1, options.radius || 8);
    const limit = colorLimit(options.tolerance);
    const seed = options.seed;
    if (!seed) return mask;

    options.points.forEach(point => {
        const cx = Math.round(point[0]);
        const cy = Math.round(point[1]);
        const minX = Math.max(0, Math.round(cx - radius));
        const maxX = Math.min(width - 1, Math.round(cx + radius));
        const minY = Math.max(0, Math.round(cy - radius));
        const maxY = Math.min(height - 1, Math.round(cy + radius));
        const radiusSq = radius * radius;

        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                const dx = x - cx;
                const dy = y - cy;
                if (dx * dx + dy * dy > radiusSq) continue;
                const p = y * width + x;
                if (mask[p]) continue;
                if (colorDistance(data, p * 4, seed[0], seed[1], seed[2]) <= limit) mask[p] = 1;
            }
        }
    });

    return mask;
}


/** The colour at one image pixel, as `[r, g, b]`. */
export function pixelColor(imageData, x, y) {
    const { width, height, data } = imageData;
    if (x < 0 || y < 0 || x >= width || y >= height) return null;
    const i = (Math.round(y) * width + Math.round(x)) * 4;
    return [data[i], data[i + 1], data[i + 2]];
}


/**
 * Boundary of a mask, as horizontal/vertical runs in mask pixel coordinates.
 * Each run is `[x1, y1, x2, y2]`, so it can be drawn straight into a path.
 */
export function maskOutline(mask, width, height) {
    const runs = [];

    // horizontal edges between a row and the one above it
    for (let y = 0; y <= height; y++) {
        let start = -1;
        for (let x = 0; x <= width; x++) {
            const above = y > 0 ? mask[(y - 1) * width + x] : 0;
            const below = y < height ? mask[y * width + x] : 0;
            const edge = x < width && above !== below;
            if (edge && start === -1) {
                start = x;
            } else if (!edge && start !== -1) {
                runs.push([start, y, x, y]);
                start = -1;
            }
        }
    }

    // vertical edges between a column and the one to its left
    for (let x = 0; x <= width; x++) {
        let start = -1;
        for (let y = 0; y <= height; y++) {
            const left = x > 0 ? mask[y * width + (x - 1)] : 0;
            const right = x < width ? mask[y * width + x] : 0;
            const edge = y < height && left !== right;
            if (edge && start === -1) {
                start = y;
            } else if (!edge && start !== -1) {
                runs.push([x, start, x, y]);
                start = -1;
            }
        }
    }

    return runs;
}


function simplify(points, tolerance) {
    if (points.length < 3) return points;

    const first = points[0];
    const last = points[points.length - 1];
    let index = -1;
    let maxDistance = tolerance;

    const dx = last[0] - first[0];
    const dy = last[1] - first[1];
    const norm = Math.hypot(dx, dy);

    for (let i = 1; i < points.length - 1; i++) {
        const point = points[i];
        const distance = norm === 0
            ? Math.hypot(point[0] - first[0], point[1] - first[1])
            : Math.abs(dy * point[0] - dx * point[1] + last[0] * first[1] - last[1] * first[0]) / norm;
        if (distance > maxDistance) {
            index = i;
            maxDistance = distance;
        }
    }

    if (index === -1) return [first, last];

    const head = simplify(points.slice(0, index + 1), tolerance);
    const tail = simplify(points.slice(index), tolerance);
    return head.slice(0, -1).concat(tail);
}


/**
 * Closed polygons around the selected pixels, simplified so they can become OSM
 * geometry. Coordinates are in mask pixels.
 */
export function maskPolygons(mask, width, height) {
    const edges = new Map();   // "x,y" -> ["x2,y2", ...]

    const addEdge = (x1, y1, x2, y2) => {
        const key = x1 + ',' + y1;
        const list = edges.get(key);
        if (list) list.push([x2, y2]);
        else edges.set(key, [[x2, y2]]);
    };

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (!mask[y * width + x]) continue;
            if (y === 0 || !mask[(y - 1) * width + x]) addEdge(x, y, x + 1, y);
            if (x === width - 1 || !mask[y * width + x + 1]) addEdge(x + 1, y, x + 1, y + 1);
            if (y === height - 1 || !mask[(y + 1) * width + x]) addEdge(x + 1, y + 1, x, y + 1);
            if (x === 0 || !mask[y * width + x - 1]) addEdge(x, y + 1, x, y);
        }
    }

    const polygons = [];
    const startKeys = Array.from(edges.keys());

    startKeys.forEach(startKey => {
        while (edges.has(startKey) && edges.get(startKey).length) {
            const points = [];
            let key = startKey;
            let guard = 0;

            while (key && edges.has(key) && edges.get(key).length && guard++ < 200000) {
                const [x, y] = key.split(',').map(Number);
                points.push([x, y]);
                const next = edges.get(key).pop();
                if (!edges.get(key).length) edges.delete(key);
                key = next[0] + ',' + next[1];
                if (key === startKey) break;
            }

            if (points.length >= 4) {
                const tolerance = Math.max(1, Math.round(Math.min(width, height) / 200));
                const simplified = simplify(points.concat([points[0]]), tolerance);
                polygons.push(simplified.slice(0, -1));
            }
        }
    });

    // biggest first, so the main region wins
    polygons.sort((a, b) => b.length - a.length);
    return polygons;
}
