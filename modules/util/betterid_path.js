/**
 * Pure geometry behind the pen tool: cubic beziers, their flattening into the
 * polyline that becomes an OSM way, and the small vector helpers the gestures
 * need. Everything here works in screen pixels and knows nothing about the
 * DOM or the map, so it can be unit tested directly.
 *
 * Flattening follows how a careful mapper places nodes on a curve: nodes sit
 * evenly along each bend, denser where it is tight and absent where the path
 * is straight, with the polyline never further than `tolerance` pixels from
 * the true curve.
 */

const MIN_SAMPLES = 16;
const MAX_SAMPLES = 256;


export function vecAdd(a, b) { return [a[0] + b[0], a[1] + b[1]]; }
export function vecSub(a, b) { return [a[0] - b[0], a[1] - b[1]]; }
export function vecScale(a, k) { return [a[0] * k, a[1] * k]; }
export function vecLength(a) { return Math.hypot(a[0], a[1]); }
export function vecDistance(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }
export function vecLerp(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }


/** Point on the cubic bezier (p0, c1, c2, p3) at parameter `t`. */
export function bezierPoint(p0, c1, c2, p3, t) {
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    return [
        a * p0[0] + b * c1[0] + c * c2[0] + d * p3[0],
        a * p0[1] + b * c1[1] + c * c2[1] + d * p3[1]
    ];
}


/**
 * De Casteljau split of a cubic at `t`: two cubics that together draw exactly
 * the same curve. Used when an anchor is inserted on an existing segment, so
 * adding a point never changes the shape.
 *
 * @returns {{left: number[][], right: number[][]}} each as [p0, c1, c2, p3]
 */
export function bezierSplit(p0, c1, c2, p3, t) {
    const p01 = vecLerp(p0, c1, t);
    const p12 = vecLerp(c1, c2, t);
    const p23 = vecLerp(c2, p3, t);
    const p012 = vecLerp(p01, p12, t);
    const p123 = vecLerp(p12, p23, t);
    const mid = vecLerp(p012, p123, t);
    return {
        left: [p0, p01, p012, mid],
        right: [mid, p123, p23, p3]
    };
}


/** Distance from `point` to the segment a-b. */
export function pointSegmentDistance(point, a, b) {
    const ab = vecSub(b, a);
    const lengthSq = ab[0] * ab[0] + ab[1] * ab[1];
    if (lengthSq < 1e-12) return vecDistance(point, a);
    let t = ((point[0] - a[0]) * ab[0] + (point[1] - a[1]) * ab[1]) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    return vecDistance(point, [a[0] + ab[0] * t, a[1] + ab[1] * t]);
}


/** True when both control points lie within `tolerance` of the chord p0-p3. */
export function isStraight(p0, c1, c2, p3, tolerance) {
    return pointSegmentDistance(c1, p0, p3) <= tolerance &&
        pointSegmentDistance(c2, p0, p3) <= tolerance;
}


/**
 * Cumulative arc-length table of a cubic: `[{s, t, p}]` with `s` the length
 * from p0, sampled densely enough for the curve's size.
 */
export function arcLengthTable(p0, c1, c2, p3, steps) {
    if (!steps) {
        const hull = vecDistance(p0, c1) + vecDistance(c1, c2) + vecDistance(c2, p3);
        steps = Math.max(MIN_SAMPLES, Math.min(MAX_SAMPLES, Math.ceil(hull / 2)));
    }

    const table = [{ s: 0, t: 0, p: p0 }];
    let previous = p0;
    let total = 0;
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const p = i === steps ? p3 : bezierPoint(p0, c1, c2, p3, t);
        total += vecDistance(previous, p);
        table.push({ s: total, t, p });
        previous = p;
    }
    return table;
}


/** The point of the table at arc length `s`, with the index it sits before. */
function pointAtLength(table, s) {
    let index = 1;
    while (index < table.length - 1 && table[index].s < s) index++;
    const a = table[index - 1];
    const b = table[index];
    const span = b.s - a.s;
    const f = span < 1e-9 ? 0 : (s - a.s) / span;
    return { p: vecLerp(a.p, b.p, f), t: a.t + (b.t - a.t) * f, index };
}


/**
 * Largest distance between the dense samples and the polyline through
 * `points` (each carrying the table `index` it was taken from).
 */
function polylineDeviation(table, points) {
    let worst = 0;
    let previous = { p: table[0].p, index: 0 };
    for (const current of points) {
        for (let i = previous.index; i <= current.index && i < table.length; i++) {
            const d = pointSegmentDistance(table[i].p, previous.p, current.p);
            if (d > worst) worst = d;
        }
        previous = current;
    }
    return worst;
}


/**
 * Ramer-Douglas-Peucker: drop the points of a polyline that lie within
 * `tolerance` of the line through their neighbours. End points are kept, and
 * so is any point flagged `keep` (anchors the user placed).
 *
 * @param {Array<number[]|{p: number[], keep?: boolean}>} points
 */
export function simplifyPolyline(points, tolerance) {
    if (points.length < 3) return points.slice();

    const coords = points.map(item => Array.isArray(item) ? item : item.p);
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    points.forEach((item, i) => {
        if (!Array.isArray(item) && item.keep) keep[i] = 1;
    });

    // split at user anchors first, then simplify each run between them
    const stack = [];
    let start = 0;
    for (let i = 1; i < points.length; i++) {
        if (keep[i]) {
            stack.push([start, i]);
            start = i;
        }
    }

    while (stack.length) {
        const [first, last] = stack.pop();
        if (last - first < 2) continue;

        let index = -1;
        let maxDistance = tolerance;
        for (let i = first + 1; i < last; i++) {
            const d = pointSegmentDistance(coords[i], coords[first], coords[last]);
            if (d > maxDistance) {
                maxDistance = d;
                index = i;
            }
        }
        if (index !== -1) {
            keep[index] = 1;
            stack.push([first, index], [index, last]);
        }
    }

    return points.filter((item, i) => keep[i]);
}


/**
 * Flatten one cubic into the points that follow `p0` (the last one is `p3`).
 *
 * Nodes are spaced evenly along the curve: the fewest uniform arc-length steps
 * that keep every chord within `tolerance` of the curve. A straight segment
 * yields no intermediate node at all, and a final pass drops the nodes that a
 * straight-ish stretch does not need. Nodes closer than `minSpacing` to the
 * previous one are skipped (the anchor itself always stays).
 *
 * @param {{tolerance: number, minSpacing?: number, maxNodes?: number}} options
 * @returns {number[][]}
 */
export function flattenCubic(p0, c1, c2, p3, options) {
    const tolerance = Math.max(0.05, (options && options.tolerance) || 0.75);
    const minSpacing = Math.max(0, (options && options.minSpacing) || 0);
    const maxNodes = Math.max(1, (options && options.maxNodes) || 96);

    if (isStraight(p0, c1, c2, p3, tolerance)) return [p3];

    const table = arcLengthTable(p0, c1, c2, p3);
    const total = table[table.length - 1].s;
    if (total < 1e-6) return [p3];

    const candidatesFor = n => {
        const candidates = [];
        for (let k = 1; k < n; k++) {
            candidates.push(pointAtLength(table, total * k / n));
        }
        candidates.push({ p: p3, index: table.length - 1 });
        return candidates;
    };
    const fits = candidates => polylineDeviation(table, candidates) <= tolerance;

    // the chord error falls roughly with 1/n², so start near the estimate
    // and settle on the smallest n that fits
    let chosen = candidatesFor(1);
    if (!fits(chosen)) {
        const first = polylineDeviation(table, chosen);
        let n = Math.max(2, Math.min(maxNodes, Math.floor(Math.sqrt(first / tolerance))));
        chosen = candidatesFor(n);
        if (fits(chosen)) {
            while (n > 1) {
                const fewer = candidatesFor(n - 1);
                if (!fits(fewer)) break;
                chosen = fewer;
                n--;
            }
        } else {
            while (n < maxNodes) {
                n++;
                chosen = candidatesFor(n);
                if (fits(chosen)) break;
            }
        }
    }

    // the uniform spacing is dictated by the tightest bend: let the flatter
    // stretches of the same segment go without the nodes they do not need
    const simplified = simplifyPolyline(
        [{ p: p0, keep: true }].concat(chosen.map(c => ({ p: c.p }))),
        tolerance
    ).slice(1).map(item => item.p);

    if (minSpacing <= 0) return simplified;

    const spaced = [];
    let previous = p0;
    simplified.forEach((point, i) => {
        const isLast = i === simplified.length - 1;
        if (!isLast && vecDistance(point, previous) < minSpacing) return;
        spaced.push(point);
        previous = point;
    });
    // the end point always wins over a node that crowds it
    if (spaced.length > 1 && vecDistance(spaced[spaced.length - 2], p3) < minSpacing) {
        spaced.splice(spaced.length - 2, 1);
    }
    return spaced;
}


/**
 * Control points of the segment from anchor `a` to anchor `b`, in screen
 * space. Anchors are `{p, handleIn, handleOut}` with handles as absolute
 * points or `null` for a corner.
 */
export function segmentControls(a, b) {
    return [a.p, a.handleOut || a.p, b.handleIn || b.p, b.p];
}


/**
 * Flatten a whole path of anchors. The result keeps a reference to the anchor
 * each node came from (`anchor` is `null` for the in-between nodes), so the
 * caller can reuse an existing OSM node where an anchor was snapped to one.
 *
 * A closed path bends the segment from the last anchor back to the first one;
 * the first anchor is not repeated at the end.
 *
 * @param {Array<{p: number[], handleIn: number[]|null, handleOut: number[]|null}>} anchors
 * @returns {Array<{p: number[], anchor: object|null}>}
 */
export function flattenPath(anchors, closed, options) {
    if (!anchors.length) return [];
    const out = [{ p: anchors[0].p, anchor: anchors[0] }];
    if (anchors.length < 2) return out;

    const segments = closed ? anchors.length : anchors.length - 1;
    for (let i = 0; i < segments; i++) {
        const a = anchors[i];
        const b = anchors[(i + 1) % anchors.length];
        const [p0, c1, c2, p3] = segmentControls(a, b);
        const points = flattenCubic(p0, c1, c2, p3, options);
        points.forEach((p, k) => {
            const isAnchor = k === points.length - 1;
            if (closed && isAnchor && i === segments - 1) return;   // back at the start
            out.push({ p, anchor: isAnchor ? b : null });
        });
    }
    return out;
}


/**
 * Nearest point of a path to `point`: the segment index, the parameter on
 * that segment and the distance, or `null` when nothing is within `radius`.
 */
export function nearestOnPath(anchors, closed, point, radius) {
    if (anchors.length < 2) return null;
    const segments = closed ? anchors.length : anchors.length - 1;
    let best = null;

    for (let i = 0; i < segments; i++) {
        const a = anchors[i];
        const b = anchors[(i + 1) % anchors.length];
        const [p0, c1, c2, p3] = segmentControls(a, b);

        // quick reject on the control hull
        const minX = Math.min(p0[0], c1[0], c2[0], p3[0]) - radius;
        const maxX = Math.max(p0[0], c1[0], c2[0], p3[0]) + radius;
        const minY = Math.min(p0[1], c1[1], c2[1], p3[1]) - radius;
        const maxY = Math.max(p0[1], c1[1], c2[1], p3[1]) + radius;
        if (point[0] < minX || point[0] > maxX || point[1] < minY || point[1] > maxY) continue;

        const table = arcLengthTable(p0, c1, c2, p3);
        for (let k = 1; k < table.length; k++) {
            const d = pointSegmentDistance(point, table[k - 1].p, table[k].p);
            if (d <= radius && (!best || d < best.distance)) {
                // parameter of the closest point on this little chord
                const ab = vecSub(table[k].p, table[k - 1].p);
                const lengthSq = ab[0] * ab[0] + ab[1] * ab[1];
                let f = lengthSq < 1e-12 ? 0 :
                    ((point[0] - table[k - 1].p[0]) * ab[0] + (point[1] - table[k - 1].p[1]) * ab[1]) / lengthSq;
                f = Math.max(0, Math.min(1, f));
                best = {
                    segment: i,
                    t: table[k - 1].t + (table[k].t - table[k - 1].t) * f,
                    distance: d,
                    p: vecLerp(table[k - 1].p, table[k].p, f)
                };
            }
        }
    }
    return best;
}


/**
 * Snap the direction origin→point to the nearest multiple of `step` degrees
 * (Photoshop's Shift constraint), keeping its length.
 */
export function constrainAngle(origin, point, step) {
    const stepRad = ((step || 45) * Math.PI) / 180;
    const d = vecSub(point, origin);
    const length = vecLength(d);
    if (length < 1e-9) return point.slice();
    const angle = Math.round(Math.atan2(d[1], d[0]) / stepRad) * stepRad;
    return [origin[0] + Math.cos(angle) * length, origin[1] + Math.sin(angle) * length];
}


/**
 * Rotate `handle` (a vector from the anchor) so it points opposite to
 * `other` while keeping its own length: how a smooth point's second handle
 * follows when the first one is dragged.
 */
export function alignOpposite(handle, other) {
    const length = vecLength(handle);
    const otherLength = vecLength(other);
    if (length < 1e-9 || otherLength < 1e-9) return handle;
    return vecScale(other, -length / otherLength);
}
