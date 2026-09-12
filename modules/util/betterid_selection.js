import { geoExtent } from '../geo';

/**
 * Pure geometry / graph helpers behind the Photoshop-style selection tools
 * (marquee, quick selection, magic wand). Kept free of DOM access so the
 * behaviour modules stay thin and these can be unit tested directly.
 */

const MAX_EXPANDED_ENTITIES = 2000;


/** Tag map of an entity, or of a plain tag object. */
function tagsOf(value) {
    if (!value || typeof value !== 'object') return {};
    if (value.tags && typeof value.tags === 'object') return value.tags;
    return value;
}


/** Number of tag keys whose value differs (0 = identical). */
export function tagDistance(a, b) {
    const tagsA = tagsOf(a);
    const tagsB = tagsOf(b);
    const keys = new Set([...Object.keys(tagsA), ...Object.keys(tagsB)]);
    let distance = 0;
    keys.forEach(key => {
        if (tagsA[key] !== tagsB[key]) distance++;
    });
    return distance;
}


/**
 * Screen-space sample points used for hit testing an entity against a marquee
 * or brush shape. Ways contribute their vertices plus segment midpoints so a
 * long diagonal segment is still caught by a small shape.
 */
export function entityScreenPoints(entity, graph, projection) {
    if (!entity) return [];

    if (entity.type === 'node') {
        return [projection(entity.loc)];
    }

    const points = [];
    const locs = [];
    const childIDs = entity.type === 'way'
        ? entity.nodes
        : entity.members.map(member => member.id);

    childIDs.forEach(id => {
        const child = graph.hasEntity(id);
        const loc = child && child.loc;
        if (loc) {
            points.push(projection(loc));
            locs.push(loc);
        }
    });

    for (let i = 1; i < locs.length; i++) {
        points.push(projection([
            (locs[i - 1][0] + locs[i][0]) / 2,
            (locs[i - 1][1] + locs[i][1]) / 2
        ]));
    }

    return points;
}


function visibleEntities(context, entities) {
    const graph = context.graph();
    const features = context.features();
    return entities.filter(entity =>
        !features.isHidden(entity, graph, entity.geometry(graph))
    );
}


/** Entities whose geometry intersects a screen-space rectangle. */
export function entitiesInRect(context, rect) {
    const projection = context.projection;
    const a = projection.invert([rect.minX, rect.minY]);
    const b = projection.invert([rect.maxX, rect.maxY]);
    const extent = geoExtent([Math.min(a[0], b[0]), Math.min(a[1], b[1])],
        [Math.max(a[0], b[0]), Math.max(a[1], b[1])]);

    return visibleEntities(context, context.history().intersects(extent));
}


/** Entities whose geometry falls inside a screen-space ellipse. */
export function entitiesInEllipse(context, ellipse) {
    const rect = {
        minX: ellipse.centerX - ellipse.radiusX,
        minY: ellipse.centerY - ellipse.radiusY,
        maxX: ellipse.centerX + ellipse.radiusX,
        maxY: ellipse.centerY + ellipse.radiusY
    };

    return entitiesInRect(context, rect).filter(entity => {
        const points = entityScreenPoints(entity, context.graph(), context.projection);
        return points.some(point => insideEllipse(point, ellipse));
    });
}


export function insideEllipse([x, y], ellipse) {
    const dx = (x - ellipse.centerX) / (ellipse.radiusX || 1);
    const dy = (y - ellipse.centerY) / (ellipse.radiusY || 1);
    return (dx * dx) + (dy * dy) <= 1;
}


/** Entities touched by a circular brush (screen space). */
export function entitiesInBrush(context, brush) {
    return entitiesInRect(context, {
        minX: brush.centerX - brush.radius,
        minY: brush.centerY - brush.radius,
        maxX: brush.centerX + brush.radius,
        maxY: brush.centerY + brush.radius
    }).filter(entity => {
        const points = entityScreenPoints(entity, context.graph(), context.projection);
        return points.some(point => {
            const dx = point[0] - brush.centerX;
            const dy = point[1] - brush.centerY;
            return (dx * dx) + (dy * dy) <= brush.radius * brush.radius;
        });
    }).map(entity => entity.id);
}


function neighborsOf(graph, entity) {
    const neighbors = [];

    if (entity.type === 'node') {
        graph.parentWays(entity).forEach(parent => {
            neighbors.push(parent);
            parent.nodes.forEach(id => {
                const sibling = graph.hasEntity(id);
                if (sibling) neighbors.push(sibling);
            });
        });
        graph.parentRelations(entity).forEach(parent => neighbors.push(parent));

    } else if (entity.type === 'way') {
        entity.nodes.forEach(id => {
            const child = graph.hasEntity(id);
            if (!child) return;
            neighbors.push(child);
            // sibling ways sharing this node (road networks, building rows, …)
            graph.parentWays(child).forEach(parent => {
                if (parent.id !== entity.id) neighbors.push(parent);
            });
        });
        graph.parentRelations(entity).forEach(parent => neighbors.push(parent));

    } else if (entity.type === 'relation') {
        entity.members.forEach(member => {
            const child = graph.hasEntity(member.id);
            if (child) neighbors.push(child);
        });
        graph.parentRelations(entity).forEach(parent => neighbors.push(parent));
    }

    return neighbors;
}


/**
 * Magic-wand expansion: flood from the seed entities over the graph, keeping
 * neighbours whose tags are within `tolerance` differences.
 *
 * @param {iD.coreGraph} graph
 * @param {string[]} seedIDs
 * @param {{tolerance?: number, contiguous?: boolean, sameGeometry?: boolean}} options
 * @returns {string[]}
 */
export function expandBySimilarity(graph, seedIDs, options) {
    const tolerance = Math.max(0, options && options.tolerance || 0);
    const contiguous = !options || options.contiguous !== false;
    const sameGeometry = !options || options.sameGeometry !== false;

    const seeds = seedIDs
        .map(id => graph.hasEntity(id))
        .filter(Boolean);

    const result = new Set(seeds.map(entity => entity.id));

    if (!contiguous) {
        // "sample all layers" style: match by tags anywhere in the graph
        // `graph.entities` may inherit from a parent graph's entity map, so walk
        // the enumerable chain instead of only the own properties
        const all = [];
        if (graph.entities) {
            for (const id in graph.entities) {
                const entity = graph.entities[id];
                if (entity) all.push(entity);
            }
        }
        seeds.forEach(seed => {
            all.forEach(entity => {
                if (!entity || result.has(entity.id)) return;
                if (sameGeometry && entity.geometry(graph) !== seed.geometry(graph)) return;
                if (tagDistance(seed, entity) <= tolerance) result.add(entity.id);
                if (result.size >= MAX_EXPANDED_ENTITIES) return;
            });
        });
        return Array.from(result);
    }

    const queue = seeds.slice();
    let head = 0;
    while (head < queue.length && result.size < MAX_EXPANDED_ENTITIES) {
        const entity = queue[head++];
        for (const neighbor of neighborsOf(graph, entity)) {
            if (!neighbor || result.has(neighbor.id)) continue;
            if (sameGeometry && neighbor.geometry(graph) !== entity.geometry(graph)) continue;
            if (tagDistance(entity, neighbor) > tolerance) continue;
            result.add(neighbor.id);
            queue.push(neighbor);
        }
    }

    return Array.from(result);
}
