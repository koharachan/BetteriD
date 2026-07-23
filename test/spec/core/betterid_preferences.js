import {
    BETTERID_PREFS,
    experimentalFeatureEnabled,
    getSecondaryBackgroundOpacity,
    getProviderOrder,
    getSplitFixedCount,
    getSnapTolerance,
    getTranslationLanguages,
    setSecondaryBackgroundOpacity,
    setProviderOrder,
    setSplitFixedCount,
    setSnapTolerance,
    setTranslationLanguages
} from '../../../modules/core/betterid_preferences';
import { prefs } from '../../../modules/core/preferences';


describe('BetteriD preferences', function() {
    afterEach(function() {
        Object.values(BETTERID_PREFS).forEach(key => prefs(key, null));
    });

    it('keeps experimental features off until both switches are enabled', function() {
        expect(experimentalFeatureEnabled(BETTERID_PREFS.localPhoto)).toBe(false);

        prefs(BETTERID_PREFS.localPhoto, 'true');
        expect(experimentalFeatureEnabled(BETTERID_PREFS.localPhoto)).toBe(false);

        prefs(BETTERID_PREFS.experimental, 'true');
        expect(experimentalFeatureEnabled(BETTERID_PREFS.localPhoto)).toBe(true);
    });

    it('defaults and clamps the configurable snap tolerance', function() {
        expect(getSnapTolerance()).toEqual(8);

        prefs(BETTERID_PREFS.snapTolerance, '1');
        expect(getSnapTolerance()).toEqual(2);

        prefs(BETTERID_PREFS.snapTolerance, '999');
        expect(getSnapTolerance()).toEqual(30);
    });

    it('clamps numeric preferences through their setters', function() {
        setSnapTolerance(0);
        setSplitFixedCount(0);
        setSecondaryBackgroundOpacity(0);

        expect(getSnapTolerance()).toEqual(2);
        expect(getSplitFixedCount()).toEqual(1);
        expect(getSecondaryBackgroundOpacity()).toEqual(0);
    });

    it('sanitizes translation languages and limits them to eight', function() {
        setTranslationLanguages([
            'zh_CN', 'en', 'en', 'not a locale', 'fr', 'de', 'es', 'it', 'ja', 'ko', 'ru'
        ]);

        expect(getTranslationLanguages()).toEqual([
            'zh-CN', 'en', 'fr', 'de', 'es', 'it', 'ja', 'ko'
        ]);
    });

    it('uses task defaults and preserves a valid provider preference order', function() {
        expect(getProviderOrder('search')).toEqual(['openai', 'kimi']);
        expect(getProviderOrder('text')).toEqual(['deepseek', 'openai', 'mimo']);
        expect(getProviderOrder('vision')).toEqual(['openai', 'mimo']);

        setProviderOrder('search', ['kimi', 'unknown', 'kimi']);
        setProviderOrder('text', ['mimo', 'openai', 'deepseek']);
        setProviderOrder('vision', ['mimo', 'openai']);

        expect(getProviderOrder('search')).toEqual(['kimi', 'openai']);
        expect(getProviderOrder('text')).toEqual(['mimo', 'openai', 'deepseek']);
        expect(getProviderOrder('vision')).toEqual(['mimo', 'openai']);
    });
});
