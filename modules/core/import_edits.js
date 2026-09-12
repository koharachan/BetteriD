import { actionAddEntity } from '../actions/add_entity';
import { actionDeleteMultiple } from '../actions/delete_multiple';
import { osmIdManager, osmNode, osmRelation, osmWay } from '../osm';
import { JXON } from '../util/jxon';

const ELEMENT_TYPES = ['node', 'way', 'relation'];


function toArray(value) {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}


function readTags(raw) {
    const tags = {};
    for (const tag of toArray(raw.tag)) {
        const key = tag && tag['@k'];
        if (typeof key !== 'string' || !key) continue;
        const value = tag['@v'];
        tags[key] = value === undefined || value === null ? '' : String(value);
    }
    return tags;
}


function readId(type, raw) {
    const id = Number(raw['@id']);
    if (Number.isFinite(id) && String(raw['@id'] ?? '').trim() !== '') {
        return osmIdManager.fromOSM(type, id);
    }
    return osmIdManager.newId(type);
}


function buildEntity(type, raw) {
    const id = readId(type, raw);
    const props = { id, tags: readTags(raw) };

    const version = raw['@version'];
    if (version !== undefined) props.version = String(version);

    if (type === 'node') {
        const lat = Number(raw['@lat']);
        const lon = Number(raw['@lon']);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
        props.loc = [lon, lat];
        return new osmNode(props);
    }

    if (type === 'way') {
        const nodes = toArray(raw.nd)
            .map(nd => Number(nd && nd['@ref']))
            .filter(ref => Number.isFinite(ref))
            .map(ref => osmIdManager.fromOSM('node', ref));
        if (!nodes.length) return null;
        props.nodes = nodes;
        return new osmWay(props);
    }

    const members = toArray(raw.member)
        .filter(member => member && ELEMENT_TYPES.includes(String(member['@type'])))
        .map(member => {
            const memberType = String(member['@type']);
            const ref = Number(member['@ref']);
            if (!Number.isFinite(ref)) return null;
            return {
                type: memberType,
                id: osmIdManager.fromOSM(memberType, ref),
                role: member['@role'] === undefined ? '' : String(member['@role'])
            };
        })
        .filter(Boolean);
    props.members = members;
    return new osmRelation(props);
}


function collectGroup(group, sink) {
    for (const type of ELEMENT_TYPES) {
        for (const raw of toArray(group[type])) {
            if (!raw || typeof raw !== 'object') continue;
            const entity = buildEntity(type, raw);
            if (entity) sink.push(entity);
        }
    }
}


function collectDeleted(group, sink) {
    for (const type of ELEMENT_TYPES) {
        for (const raw of toArray(group[type])) {
            if (!raw || typeof raw !== 'object') continue;
            const id = Number(raw['@id']);
            if (Number.isFinite(id) && String(raw['@id'] ?? '').trim() !== '') {
                sink.push(osmIdManager.fromOSM(type, id));
            }
        }
    }
}


/**
 * Parse an `.osc` (osmChange) or `.osm` document into pending edits.
 *
 * Returns `{ entities, deletedIDs }`, where `entities` are create/modify
 * candidates and `deletedIDs` are the ids requested for deletion.
 *
 * @param {string} xmlText
 */
export function coreParseEdits(xmlText) {
    if (typeof xmlText !== 'string' || !xmlText.trim()) {
        throw new Error('The file is empty');
    }

    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) {
        throw new Error('The file is not valid XML');
    }

    const root = JXON.build(doc.documentElement);
    const rootName = doc.documentElement.nodeName.toLowerCase();

    const entities = [];
    const deletedIDs = [];

    if (rootName === 'osmchange') {
        collectGroup(root.create || {}, entities);
        collectGroup(root.modify || {}, entities);
        collectDeleted(root.delete || {}, deletedIDs);
    } else if (rootName === 'osm') {
        collectGroup(root, entities);
        // `<node visible="false">` in a planet-style dump means "deleted"
        for (const type of ELEMENT_TYPES) {
            for (const raw of toArray(root[type])) {
                if (raw && String(raw['@visible']) === 'false') {
                    const id = Number(raw['@id']);
                    if (Number.isFinite(id)) deletedIDs.push(osmIdManager.fromOSM(type, id));
                }
            }
        }
        for (const id of deletedIDs) {
            const index = entities.findIndex(entity => entity.id === id);
            if (index !== -1) entities.splice(index, 1);
        }
    } else {
        throw new Error('The file has no <osmChange> or <osm> element');
    }

    if (!entities.length && !deletedIDs.length) {
        throw new Error('The file contains no editable feature');
    }

    return { entities, deletedIDs };
}


/**
 * Apply parsed edits to the editor as a single undoable step.
 *
 * `osmChange` documents map `create`/`modify` onto new pending changes and
 * `delete` onto deletions; plain `.osm` documents are merged in as changes.
 * Ways and relations whose children are missing both from the file and from
 * the current graph are skipped so an incomplete extract cannot break rendering.
 *
 * @param {iD.Context} context
 * @param {string} xmlText
 */
export function coreImportEdits(context, xmlText) {
    const { entities, deletedIDs } = coreParseEdits(xmlText);
    const graph = context.graph();
    const available = new Set(entities.map(entity => entity.id));

    const importable = [];
    let skipped = 0;

    for (const entity of entities) {
        if (entity.type === 'node') {
            importable.push(entity);
            continue;
        }

        const children = entity.type === 'way'
            ? entity.nodes
            : entity.members.map(member => member.id);

        const complete = children.every(id => available.has(id) || graph.hasEntity(id));
        if (complete) {
            importable.push(entity);
        } else {
            skipped++;
        }
    }

    const deletable = deletedIDs.filter(id => graph.hasEntity(id));
    const missing = deletedIDs.length - deletable.length;

    const actions = importable.map(entity => actionAddEntity(entity));
    if (deletable.length) actions.push(actionDeleteMultiple(deletable));

    if (actions.length) {
        context.perform(...actions);
        context.validator().validate();
    }

    return {
        imported: importable.length,
        deleted: deletable.length,
        skipped: skipped + missing
    };
}
