import { presetCollection, presetPreset } from '../../../modules';
import { uiPresetListGeometryMatches } from '../../../modules/ui/preset_list';


describe('preset list geometry choices', function() {
    const line = presetPreset('__test_line', {
        name: 'Test line',
        geometry: ['line'],
        tags: { highway: 'service' }
    }, true);
    const area = presetPreset('__test_area', {
        name: 'Test area',
        geometry: ['area'],
        tags: { building: 'yes' }
    }, true);
    const both = presetPreset('__test_both', {
        name: 'Test both',
        geometry: ['line', 'area'],
        tags: { barrier: 'fence' }
    }, true);
    const presets = presetCollection([line, area, both]);

    it('keeps line-only and area-only presets for mobile geometry choices', function() {
        const result = uiPresetListGeometryMatches(presets, ['line', 'area'], true);

        expect(result.collection.map(preset => preset.id)).toStrictEqual([
            '__test_line', '__test_area', '__test_both'
        ]);
    });

    it('preserves desktop match-all behavior', function() {
        const result = uiPresetListGeometryMatches(presets, ['line', 'area'], false);

        expect(result.collection.map(preset => preset.id)).toStrictEqual(['__test_both']);
    });
});
