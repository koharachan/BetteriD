import type { Action } from '../core/history';
import type { EntityId, WayId } from '../osm';
import { actionDeleteNode } from './delete_node';
import { actionDeleteRelation } from './delete_relation';
import { actionDeleteWay, type DeleteWayOptions } from './delete_way';


export function actionDeleteMultiple(ids: EntityId[], options?: DeleteWayOptions): Action {
    var actions = {
        way: actionDeleteWay,
        node: actionDeleteNode,
        relation: actionDeleteRelation
    };


    const action: Action = function(graph) {
        ids.forEach(function(id) {
            if (graph.hasEntity(id)) { // It may have been deleted already.
                const entity = graph.entity(id);
                if (entity.type === 'way') {
                    graph = actionDeleteWay(id as WayId, options)(graph);
                } else {
                    graph = actions[entity.type](id as never)(graph);
                }
            }
        });

        return graph;
    };


    return action;
}
