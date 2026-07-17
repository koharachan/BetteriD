import { t } from '../core/localizer';
import { uiModal } from './modal';


export function uiMilitaryWarning(context, violation) {
    const container = context.container();
    if (!container || container.empty()) return;
    if (!container.select('.military-warning').empty()) return;

    const modal = uiModal(container);
    modal.select('.modal')
        .classed('modal-alert military-warning', true);

    const content = modal.select('.content');
    content.append('div')
        .attr('class', 'modal-section header')
        .call(t.append('betterid.military_warning.title'));

    content.append('div')
        .attr('class', 'modal-section message-text')
        .call(t.append('betterid.military_warning.message'));

    const buttons = content.append('div')
        .attr('class', 'modal-section buttons cf');

    buttons.append('button')
        .attr('class', 'button secondary-action')
        .on('click', modal.close)
        .call(t.append('betterid.military_warning.cancel'));

    buttons.append('a')
        .attr('class', 'button action')
        .attr('target', '_blank')
        .attr('rel', 'noopener')
        .attr('href', uiMilitaryOfficialEditURL(context, violation?.loc))
        .call(t.append('betterid.military_warning.official'));
}


export function uiMilitaryOfficialEditURL(context, loc) {
    const center = loc || context.map().center();
    const zoom = Math.max(16, Math.round(context.map().zoom()));
    return `https://www.openstreetmap.org/edit?editor=id#map=${zoom}/${center[1]}/${center[0]}`;
}
