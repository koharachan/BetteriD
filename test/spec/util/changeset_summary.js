describe('iD.utilChangesetSummary', function() {
    it('returns aggregate data without names or entity ids', function() {
        var school = new iD.osmNode({
            id: 'n-1',
            tags: { amenity: 'school', name: '测试学校', 'name:en': 'Test School' }
        });
        var road = new iD.osmWay({
            id: 'w-1',
            tags: { highway: 'residential', surface: 'asphalt' }
        });

        var summary = iD.utilChangesetSummary({
            created: [school],
            deleted: [],
            modified: [road]
        });
        var serialized = JSON.stringify(summary);

        expect(summary.total).toBe(2);
        expect(summary.features).toEqual([
            { count: 1, feature: 'amenity=school' },
            { count: 1, feature: 'highway=residential' }
        ]);
        expect(serialized).not.toContain('测试学校');
        expect(serialized).not.toContain('Test School');
        expect(serialized).not.toContain('n-1');
    });
});
