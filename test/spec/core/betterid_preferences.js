import {
    BETTERID_PREFS,
    experimentalFeatureEnabled,
    getProviderOrder,
    getSnapTolerance,
    getTranslationLanguages,
    setProviderOrder,
    setTranslationLanguages
} from '../../../modules/core/betterid_preferences';
import { prefs } from '../../../modules/core/preferences';
import {
    BETTERID_ADOBE_SHORTCUTS_PREF,
    BETTERID_SHORTCUT_PRESET_PREF,
    adobeShortcutsEnabled,
    adobeShortcutsIllustrator,
    setAdobeShortcuts,
    setShortcutPreset,
    shortcutPreset
} from '../../../modules/core/betterid_tools';


describe('BetteriD preferences', function() {
    afterEach(function() {
        Object.values(BETTERID_PREFS).forEach(key => prefs(key, null));
        prefs(BETTERID_ADOBE_SHORTCUTS_PREF, null);
        prefs(BETTERID_SHORTCUT_PRESET_PREF, null);
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

    it('keeps the Adobe shortcut layer off by default', function() {
        expect(shortcutPreset()).toEqual('off');
        expect(adobeShortcutsEnabled()).toBe(false);
        expect(adobeShortcutsIllustrator()).toBe(false);
    });

    it('remembers the Photoshop / Illustrator choice', function() {
        setShortcutPreset('photoshop');
        expect(shortcutPreset()).toEqual('photoshop');
        expect(adobeShortcutsEnabled()).toBe(true);
        expect(adobeShortcutsIllustrator()).toBe(false);

        setShortcutPreset('illustrator');
        expect(adobeShortcutsIllustrator()).toBe(true);

        setShortcutPreset('nonsense');
        expect(shortcutPreset()).toEqual('off');
    });

    it('migrates the old boolean Adobe preference', function() {
        prefs(BETTERID_ADOBE_SHORTCUTS_PREF, 'true');
        expect(shortcutPreset()).toEqual('photoshop');
        expect(adobeShortcutsEnabled()).toBe(true);

        prefs(BETTERID_ADOBE_SHORTCUTS_PREF, 'false');
        expect(shortcutPreset()).toEqual('off');
    });
});