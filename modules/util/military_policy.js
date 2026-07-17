import * as countryCoder from '@rapideditor/country-coder';

import { coreDifference } from '../core/difference';


const PROTECTED_COUNTRIES = new Set(['CN', 'HK', 'MO']);


/**
 * Return a policy violation when an edit creates or changes a military area
 * in mainland China, Hong Kong, or Macao.
 *
 * Existing military areas are treated as immutable together with their
 * descendant members and vertices.  Parent traversal makes this check apply
 * to edits that only move or retag a member node.
 */
export function utilMilitaryEditViolation(before, after) {
    if (!before || !after || before === after) return null;

    const changes = coreDifference(before, after).changes();

    for (const [entityID, change] of Object.entries(changes)) {
        const baseEntity = change.base;
        if (baseEntity && findProtectedMilitaryAncestor(baseEntity, before)) {
            return {
                type: 'protected_military',
                entityID,
                loc: firstLocation(baseEntity, before)
            };
        }
    }

    for (const [entityID, change] of Object.entries(changes)) {
        const headEntity = change.head;
        if (!headEntity || !isProtectedMilitaryRoot(headEntity, after)) continue;

        const baseEntity = change.base;
        if (!baseEntity || !isProtectedMilitaryRoot(baseEntity, before)) {
            return {
                type: 'create_military',
                entityID,
                loc: firstLocation(headEntity, after)
            };
        }
    }

    return null;
}


export function utilIsMilitaryArea(entity) {
    if (!entity || entity.type === 'node') return false;

    const tags = entity.tags || {};
    const militaryTagged = tags.landuse === 'military' ||
        (tags.military && tags.military !== 'no');
    if (!militaryTagged) return false;

    if (entity.type === 'way') return entity.isClosed();
    return entity.type === 'relation' &&
        (entity.isMultipolygon() || tags.type === 'boundary');
}


function findProtectedMilitaryAncestor(entity, graph, visited = new Set()) {
    if (!entity || visited.has(entity.id)) return null;
    visited.add(entity.id);

    if (isProtectedMilitaryRoot(entity, graph)) return entity;

    const parents = [];
    if (entity.type === 'node') {
        parents.push(...graph.parentWays(entity));
    }
    parents.push(...graph.parentRelations(entity));

    for (const parent of parents) {
        const military = findProtectedMilitaryAncestor(parent, graph, visited);
        if (military) return military;
    }
    return null;
}


function isProtectedMilitaryRoot(entity, graph) {
    return utilIsMilitaryArea(entity, graph) && locations(entity, graph)
        .some(loc => PROTECTED_COUNTRIES.has(
            countryCoder.iso1A2Code(loc, { level: 'territory' })
        ));
}


function firstLocation(entity, graph) {
    return locations(entity, graph)[0];
}


function locations(entity, graph, visited = new Set()) {
    if (!entity || visited.has(entity.id)) return [];
    visited.add(entity.id);

    if (entity.type === 'node') return entity.loc ? [entity.loc] : [];

    let result = [];
    if (entity.type === 'way') {
        for (const nodeID of entity.nodes || []) {
            const node = graph.hasEntity(nodeID);
            if (node?.loc) result.push(node.loc);
            if (result.length >= 32) break;
        }
    } else if (entity.type === 'relation') {
        for (const member of entity.members || []) {
            result.push(...locations(graph.hasEntity(member.id), graph, visited));
            if (result.length >= 32) break;
        }
    }

    try {
        const center = entity.extent(graph).center();
        if (center?.every(Number.isFinite)) result.push(center);
    } catch {
        // Incomplete relations are common while tiles are still loading.
    }

    return result.slice(0, 33);
}
