import { actionChangeTags, coreContext, osmNode, osmWay } from '../../../../modules';
import { validationIssue, validationIssueFix } from '../../../../modules/core/validation';
import { buildValidationAutofix } from '../../../../modules/ui/sections/validation_autofix';


describe('validation autofix', function() {
    function issueFor(entityID, tags, options = {}) {
        return new validationIssue({
            type: 'test',
            severity: 'error',
            entityIds: [entityID],
            dynamicFixes: () => {
                const fixes = [new validationIssueFix({
                    title: { stringId: `fix-${entityID}` },
                    autoSafe: options.autoSafe !== false,
                    onClick: context => context.perform(
                        actionChangeTags(entityID, tags),
                        'individual annotation'
                    )
                })];
                if (options.ambiguous) {
                    fixes.push(new validationIssueFix({
                        title: { stringId: `other-${entityID}` },
                        autoSafe: options.secondSafe === true,
                        onClick: context => context.perform(graph => graph, 'other')
                    }));
                }
                return fixes;
            }
        });
    }

    function mergingIssueFor(entityID, tags) {
        return new validationIssue({
            type: 'test',
            severity: 'error',
            entityIds: [entityID],
            dynamicFixes: () => [new validationIssueFix({
                title: { stringId: `merge-${Object.keys(tags).join('-')}` },
                autoSafe: true,
                onClick: context => {
                    const entity = context.entity(entityID);
                    context.perform(
                        actionChangeTags(entityID, { ...entity.tags, ...tags }),
                        'individual annotation'
                    );
                }
            })]
        });
    }

    it('combines deterministic fixes into one undoable graph action', function() {
        const context = coreContext().init();
        context.history().merge([
            new osmNode({ id: 'n1', loc: [0, 0] }),
            new osmNode({ id: 'n2', loc: [1, 1] })
        ]);

        const plan = buildValidationAutofix([
            issueFor('n1', { amenity: 'bench' }),
            issueFor('n2', { tourism: 'information' })
        ], context);

        expect(plan.count).toBe(2);
        context.perform(plan.action, 'batch annotation');
        expect(context.entity('n1').tags).toStrictEqual({ amenity: 'bench' });
        expect(context.entity('n2').tags).toStrictEqual({ tourism: 'information' });
        expect(context.history().undoAnnotation()).toBe('batch annotation');

        context.undo();
        expect(context.entity('n1').tags).toStrictEqual({});
        expect(context.entity('n2').tags).toStrictEqual({});
    });

    it('skips fixes without explicit safety metadata and ambiguous choices', function() {
        const context = coreContext().init();
        context.history().merge([new osmNode({ id: 'n1', loc: [0, 0] })]);

        const plan = buildValidationAutofix([
            issueFor('n1', { amenity: 'bench' }, { autoSafe: false }),
            issueFor('n1', { amenity: 'drinking_water' }, { ambiguous: true })
        ], context);

        expect(plan.count).toBe(0);
        expect(plan.action(context.graph())).toBe(context.graph());
    });

    it('composes multiple fixes on the same entity without overwriting earlier tags', function() {
        const context = coreContext().init();
        context.history().merge([new osmNode({ id: 'n1', loc: [0, 0] })]);

        const plan = buildValidationAutofix([
            mergingIssueFor('n1', { amenity: 'bench' }),
            mergingIssueFor('n1', { material: 'wood' })
        ], context);
        context.perform(plan.action, 'batch annotation');

        expect(plan.count).toBe(2);
        expect(context.entity('n1').tags).toStrictEqual({
            amenity: 'bench',
            material: 'wood'
        });
    });

    it('excludes otherwise safe fixes on protected military entities', function() {
        const context = coreContext().init();
        context.history().merge([
            new osmNode({ id: 'n1', loc: [116.4, 39.9] }),
            new osmNode({ id: 'n2', loc: [116.401, 39.9] }),
            new osmNode({ id: 'n3', loc: [116.401, 39.901] }),
            new osmWay({
                id: 'w1',
                nodes: ['n1', 'n2', 'n3', 'n1'],
                tags: { landuse: 'military', old_tag: 'yes' }
            })
        ]);

        const plan = buildValidationAutofix([
            issueFor('w1', { landuse: 'military', new_tag: 'yes' })
        ], context);

        expect(plan.count).toBe(0);
    });
});
