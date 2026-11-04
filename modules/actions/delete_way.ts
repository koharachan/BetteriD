import type { coreGraph } from '../core/graph';
import type { Action } from '../core/history';
import type { osmNode, WayId } from '../osm';
import { osmNodeGeometriesForTags } from '../osm/tags';
import { actionDeleteRelation } from './delete_relation';


export interface DeleteWayOptions {
    /**
     * Child nodes to detach from the way but leave in the graph.
     * Used when the tile around a node has not loaded yet, so the node may
     * still belong to a way the editor has not seen.
     */
    preserveNodeIDs?: Iterable<string>;
}


// https://github.com/openstreetmap/potlatch2/blob/master/net/systemeD/halcyon/connection/actions/DeleteWayAction.as
export function actionDeleteWay(wayID: WayId, options?: DeleteWayOptions): Action {
    const preserve = new Set(options && options.preserveNodeIDs ? options.preserveNodeIDs : []);

    function canDeleteNode(node: osmNode, graph: coreGraph) {
        // don't delete nodes still attached to ways or relations
        if (graph.parentWays(node).length ||
            graph.parentRelations(node).length) return false;

        var geometries = osmNodeGeometriesForTags(node.tags);
        // don't delete if this node can be a standalone point
        if (geometries.point) return false;
        // delete if this node only be a vertex
        if (geometries.vertex) return true;

        // iD doesn't know if this should be a point or vertex,
        // so only delete if there are no interesting tags
        return !node.hasInterestingTags();
    }


    const action: Action = function(graph) {
        var way = graph.hasEntity(wayID);
        if (!way) return graph;

        graph.parentRelations(way).forEach(function(parent) {
            parent = parent.removeMembersWithID(wayID);
            graph = graph.replace(parent);

            if (parent.isDegenerate()) {
                graph = actionDeleteRelation(parent.id)(graph);
            }
        });

        (new Set(way.nodes)).forEach(function(nodeID) {
            graph = graph.replace(way.removeNode(nodeID));
            if (preserve.has(nodeID)) return;

            // A way can be deleted before every child node has arrived.
            var node = graph.hasEntity(nodeID);
            if (node && canDeleteNode(node, graph)) {
                graph = graph.remove(node);
            }
        });

        return graph.remove(way);
    };


    return action;
}
