import { t } from '../../core/localizer';
import { svgIcon } from '../../svg/icon';
import { uiSection } from '../section';


export function uiSectionValidationAutofix(context) {
    const section = uiSection('issues-autofix', context)
        .content(renderContent)
        .shouldDisplay(() => currentPlan().count > 0);

    function currentPlan() {
        return buildValidationAutofix(
            context.validator().getIssues({ what: 'edited', where: 'all' }),
            context
        );
    }

    function renderContent(selection) {
        const plan = currentPlan();

        let box = selection.selectAll('.validation-autofix')
            .data([plan]);

        const enter = box.enter()
            .append('div')
            .attr('class', 'validation-autofix');

        const copy = enter.append('div')
            .attr('class', 'validation-autofix-copy');

        copy.append('strong')
            .call(t.append('betterid.validation_autofix.title'));

        copy.append('span')
            .attr('class', 'validation-autofix-count');

        enter.append('button')
            .attr('class', 'action validation-autofix-button')
            .call(svgIcon('#iD-icon-wrench', 'pre-text'))
            .append('span')
            .call(t.append('betterid.validation_autofix.action'));

        box = box.merge(enter);

        box.select('.validation-autofix-count')
            .call(t.addOrUpdate('betterid.validation_autofix.preview', { count: plan.count }));

        box.select('.validation-autofix-button')
            .property('disabled', !plan.count)
            .on('click', applyFixes);
    }

    function applyFixes() {
        const plan = currentPlan();
        if (!plan.count) return;

        context.perform(
            plan.action,
            t('betterid.validation_autofix.annotation', { count: plan.count })
        );
        context.validator().validate();
    }

    context.validator().on('validated.uiSectionValidationAutofix', () => {
        window.requestIdleCallback(section.reRender);
    });

    return section;
}


/**
 * Convert explicitly auto-safe validation fixes into one graph action.
 * Fix callbacks keep using the validationIssueFix onClick API; a context proxy
 * captures their graph actions instead of creating separate history entries.
 */
export function buildValidationAutofix(issues, context) {
    const actions = [];
    let count = 0;
    let stagedGraph = context.graph();

    for (const issue of issues || []) {
        const decisionFixes = issue.fixes(context).filter(fix =>
            !fix.disabledReason && typeof fix.onClick === 'function' &&
            fix.icon !== 'iD-icon-close'
        );

        // Multiple actionable fixes still require a user decision, even if
        // only one of them is marked auto-safe.
        if (decisionFixes.length !== 1 || !decisionFixes[0].autoSafe) continue;

        const captured = [];
        const fixGraph = stagedGraph;
        const captureContext = new Proxy(context, {
            get(target, property) {
                if (property === 'perform' || property === 'replace') {
                    return (...args) => captureActions(args, captured);
                }
                if (property === 'graph') return () => fixGraph;
                if (property === 'entity') return entityID => fixGraph.entity(entityID);
                if (property === 'hasEntity') return entityID => fixGraph.hasEntity(entityID);
                const value = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
            }
        });

        try {
            decisionFixes[0].onClick(captureContext);
        } catch {
            continue;
        }

        if (!captured.length) continue;

        let preview;
        try {
            preview = captured.reduce((graph, action) => action(graph), fixGraph);
        } catch {
            continue;
        }
        if (context.editPolicy?.(fixGraph, preview)) continue;

        actions.push(...captured);
        stagedGraph = preview;
        count++;
    }

    return {
        count,
        action: graph => actions.reduce((result, action) => action(result), graph)
    };
}


function captureActions(args, captured) {
    const values = args.slice();
    if (values.length && typeof values.at(-1) !== 'function') values.pop();
    if (!values.length || values.some(value => typeof value !== 'function')) {
        throw new Error('Auto-safe fixes must use graph actions');
    }
    captured.push(...values);
}
