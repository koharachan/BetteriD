import {
    alignOpposite, arcLengthTable, bezierPoint, bezierSplit, constrainAngle, flattenCubic,
    flattenPath, isStraight, nearestOnPath, pointSegmentDistance, simplifyPolyline
} from '../../../modules/util/betterid_path';


/** Largest distance from the dense true curve to the polyline `points`. */
function deviation(p0, c1, c2, p3, points) {
    const polyline = [p0].concat(points);
    let worst = 0;
    for (let i = 0; i <= 400; i++) {
        const q = bezierPoint(p0, c1, c2, p3, i / 400);
        let best = Infinity;
        for (let k = 1; k < polyline.length; k++) {
            best = Math.min(best, pointSegmentDistance(q, polyline[k - 1], polyline[k]));
        }
        worst = Math.max(worst, best);
    }
    return worst;
}


describe('betterid path geometry', function() {

    describe('bezierPoint / bezierSplit', function() {
        const p0 = [0, 0], c1 = [0, 100], c2 = [100, 100], p3 = [100, 0];

        it('passes through the end points', function() {
            expect(bezierPoint(p0, c1, c2, p3, 0)).toEqual([0, 0]);
            expect(bezierPoint(p0, c1, c2, p3, 1)).toEqual([100, 0]);
        });

        it('splits into two curves that draw the same shape', function() {
            const { left, right } = bezierSplit(p0, c1, c2, p3, 0.3);
            expect(left[0]).toEqual(p0);
            expect(right[3]).toEqual(p3);
            expect(left[3]).toEqual(right[0]);

            for (let i = 0; i <= 10; i++) {
                const t = i / 10;
                const original = bezierPoint(p0, c1, c2, p3, t);
                const piece = t <= 0.3
                    ? bezierPoint(...left, t / 0.3)
                    : bezierPoint(...right, (t - 0.3) / 0.7);
                expect(piece[0]).toBeCloseTo(original[0], 6);
                expect(piece[1]).toBeCloseTo(original[1], 6);
            }
        });
    });


    describe('isStraight', function() {
        it('treats control points on the chord as straight', function() {
            expect(isStraight([0, 0], [0, 0], [50, 0], [50, 0], 0.5)).toBe(true);
            expect(isStraight([0, 0], [10, 0.2], [40, -0.2], [50, 0], 0.5)).toBe(true);
            expect(isStraight([0, 0], [10, 5], [40, 0], [50, 0], 0.5)).toBe(false);
        });
    });


    describe('arcLengthTable', function() {
        it('is monotonic and ends on the last point', function() {
            const table = arcLengthTable([0, 0], [0, 100], [100, 100], [100, 0]);
            for (let i = 1; i < table.length; i++) {
                expect(table[i].s).toBeGreaterThanOrEqual(table[i - 1].s);
            }
            expect(table[table.length - 1].p).toEqual([100, 0]);
            expect(table[table.length - 1].t).toEqual(1);
        });
    });


    describe('simplifyPolyline', function() {
        it('removes points within the tolerance of the line through their neighbours', function() {
            const points = [[0, 0], [10, 0.1], [20, -0.1], [30, 0], [40, 5], [50, 0]];
            const result = simplifyPolyline(points, 0.5);
            // the wobble along the first run goes, the real bend stays
            expect(result).toEqual([[0, 0], [30, 0], [40, 5], [50, 0]]);
        });

        it('keeps flagged points', function() {
            const points = [{ p: [0, 0] }, { p: [10, 0], keep: true }, { p: [20, 0] }, { p: [30, 0] }];
            const result = simplifyPolyline(points, 0.5);
            expect(result.map(item => item.p)).toEqual([[0, 0], [10, 0], [30, 0]]);
        });
    });


    describe('flattenCubic', function() {
        it('gives a straight segment no intermediate node at all', function() {
            expect(flattenCubic([0, 0], [0, 0], [300, 0], [300, 0], { tolerance: 0.75 })).toEqual([[300, 0]]);
            expect(flattenCubic([0, 0], [100, 0], [200, 0], [300, 0], { tolerance: 0.75 })).toEqual([[300, 0]]);
        });

        it('keeps the polyline within the tolerance of the curve', function() {
            const p0 = [0, 0], c1 = [0, 120], c2 = [200, 120], p3 = [200, 0];
            [0.3, 0.75, 1.5].forEach(tolerance => {
                const points = flattenCubic(p0, c1, c2, p3, { tolerance });
                expect(points[points.length - 1]).toEqual(p3);
                expect(deviation(p0, c1, c2, p3, points)).toBeLessThanOrEqual(tolerance * 1.05);
            });
        });

        it('uses fewer nodes for a looser tolerance', function() {
            const p0 = [0, 0], c1 = [0, 120], c2 = [200, 120], p3 = [200, 0];
            const fine = flattenCubic(p0, c1, c2, p3, { tolerance: 0.3 }).length;
            const coarse = flattenCubic(p0, c1, c2, p3, { tolerance: 1.5 }).length;
            expect(coarse).toBeLessThan(fine);
            expect(coarse).toBeGreaterThan(1);
        });

        it('spaces the nodes evenly along a uniform bend', function() {
            // a quarter-circle-ish arc has (almost) constant curvature
            const k = 0.5523 * 100;
            const p0 = [0, 100], c1 = [0, 100 - k], c2 = [100 - k, 0], p3 = [100, 0];
            const points = [p0].concat(flattenCubic(p0, c1, c2, p3, { tolerance: 0.5 }));
            const gaps = [];
            for (let i = 1; i < points.length; i++) {
                gaps.push(Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
            }
            expect(gaps.length).toBeGreaterThan(3);
            const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
            const spread = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) * (g - mean), 0) / gaps.length) / mean;
            expect(spread).toBeLessThan(0.1);
        });

        it('leaves the straight part of a segment without nodes', function() {
            // bends only near the end: the long straight run must stay empty
            const p0 = [0, 0], c1 = [250, 0], c2 = [300, 0], p3 = [300, 60];
            const points = flattenCubic(p0, c1, c2, p3, { tolerance: 0.75 });
            const early = points.filter(p => p[0] < 150);
            expect(early).toHaveLength(0);
            expect(points.length).toBeGreaterThan(1);
        });

        it('honours a minimum spacing but always keeps the end point', function() {
            const p0 = [0, 0], c1 = [0, 30], c2 = [40, 30], p3 = [40, 0];
            const points = flattenCubic(p0, c1, c2, p3, { tolerance: 0.1, minSpacing: 12 });
            const polyline = [p0].concat(points);
            for (let i = 1; i < polyline.length - 1; i++) {
                const gap = Math.hypot(polyline[i][0] - polyline[i - 1][0], polyline[i][1] - polyline[i - 1][1]);
                expect(gap).toBeGreaterThanOrEqual(12);
            }
            expect(points[points.length - 1]).toEqual(p3);
        });
    });


    describe('flattenPath', function() {
        const anchors = [
            { p: [0, 0], handleIn: null, handleOut: [0, 80] },
            { p: [100, 0], handleIn: [100, 80], handleOut: null },
            { p: [200, 0], handleIn: null, handleOut: null }
        ];

        it('returns the anchors with their references and the nodes between them', function() {
            const result = flattenPath(anchors, false, { tolerance: 0.75 });
            expect(result[0]).toEqual({ p: [0, 0], anchor: anchors[0] });
            expect(result[result.length - 1]).toEqual({ p: [200, 0], anchor: anchors[2] });

            const anchorItems = result.filter(item => item.anchor);
            expect(anchorItems.map(item => item.anchor)).toEqual(anchors);
            expect(result.length).toBeGreaterThan(3);
            // the straight final segment adds no node
            const between = result.filter(item => !item.anchor && item.p[0] > 100);
            expect(between).toHaveLength(0);
        });

        it('does not repeat the first anchor of a closed path', function() {
            const result = flattenPath(anchors, true, { tolerance: 0.75 });
            const firsts = result.filter(item => item.anchor === anchors[0]);
            expect(firsts).toHaveLength(1);
            expect(result[0].anchor).toBe(anchors[0]);
        });
    });


    describe('nearestOnPath', function() {
        const anchors = [
            { p: [0, 0], handleIn: null, handleOut: null },
            { p: [100, 0], handleIn: null, handleOut: null },
            { p: [100, 100], handleIn: null, handleOut: null }
        ];

        it('finds the segment and position under the pointer', function() {
            const hit = nearestOnPath(anchors, false, [50, 2], 5);
            expect(hit.segment).toEqual(0);
            expect(hit.t).toBeCloseTo(0.5, 1);
            expect(hit.p[0]).toBeCloseTo(50, 0);
        });

        it('returns null away from the path', function() {
            expect(nearestOnPath(anchors, false, [50, 20], 5)).toBeNull();
        });
    });


    describe('constrainAngle / alignOpposite', function() {
        it('snaps to 45 degree steps and keeps the length', function() {
            const snapped = constrainAngle([0, 0], [100, 10], 45);
            expect(snapped[0]).toBeCloseTo(Math.hypot(100, 10), 6);
            expect(snapped[1]).toBeCloseTo(0, 6);

            const diagonal = constrainAngle([0, 0], [10, 9], 45);
            expect(diagonal[0]).toBeCloseTo(diagonal[1], 6);
        });

        it('points the handle opposite to the other one, keeping its own length', function() {
            const aligned = alignOpposite([30, 0], [0, 10]);
            expect(aligned[0]).toBeCloseTo(0, 6);
            expect(aligned[1]).toBeCloseTo(-30, 6);
        });
    });
});
