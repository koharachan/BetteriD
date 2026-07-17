describe('iD.validationNonLocalName', function() {
    var context;

    beforeEach(async function() {
        iD.prefs('betterid.validation.non_local_name', null);
        iD.fileFetcher.cache().territory_languages = { cn: ['zh'], us: ['en'] };
        context = iD.coreContext().assetPath('../dist/').init();
        await Promise.resolve();
    });

    function validateName(name) {
        var node = new iD.osmNode({ id: 'n-1', loc: [116.4, 39.9], tags: { name: name } });
        context.perform(iD.actionAddEntity(node));
        var validator = iD.validationNonLocalName(context);
        return Promise.resolve().then(function() {
            return validator(node, context.graph());
        });
    }

    it('warns when a Chinese feature has only a Latin-script primary name', async function() {
        var issues = await validateName('Test School');
        expect(issues).toHaveLength(1);
        expect(issues[0].type).toBe('non_local_name');
    });

    it('accepts a Han-script primary name in China', async function() {
        var issues = await validateName('测试学校');
        expect(issues).toHaveLength(0);
    });

    it('warns when a token Han character is surrounded by a foreign primary name', async function() {
        var issues = await validateName('Test 中 International School');
        expect(issues).toHaveLength(1);
    });

    it('can be disabled in BetteriD preferences', async function() {
        iD.prefs('betterid.validation.non_local_name', 'false');
        var issues = await validateName('Test School');
        expect(issues).toHaveLength(0);
    });
});
