import { geoPath as d3_geoPath } from 'd3-geo';

import { osmNode } from '../osm/node';

var keysToCopyAndRetain = ['source', 'wheelchair'];
var keysToRetain = ['area'];
var buildingKeysToRetain = ['architect', 'building', 'height', 'layer', 'nycdoitt:bin', 'ref:GB:uprn', 'ref:linz:building_id'];

function isAddressKey(key) {
    return /^addr:.{1,}/.test(key);
}

function isBuildingKey(key) {
    return buildingKeysToRetain.indexOf(key) !== -1 ||
        /^building:.{1,}/.test(key) ||
        /^roof:.{1,}/.test(key);
}

export function actionExtractMovesAddressTags(entity) {
    var isBuilding = (entity.tags.building && entity.tags.building !== 'no') ||
        (entity.tags['building:part'] && entity.tags['building:part'] !== 'no');

    if (!isBuilding) return false;

    var hasAddressTags = false;
    for (var key in entity.tags) {
        if (entity.type === 'relation' && key === 'type') continue;
        if (keysToRetain.indexOf(key) !== -1) continue;
        if (keysToCopyAndRetain.indexOf(key) !== -1) continue;
        if (isBuildingKey(key)) continue;

        if (isAddressKey(key)) {
            hasAddressTags = true;
            continue;
        }

        return false;
    }

    return hasAddressTags;
}

export function actionExtract(entityID, projection) {

    var extractedNodeID;

    /** @param {boolean} shiftKeyPressed */
    var action = function(graph, shiftKeyPressed) {
        var entity = graph.entity(entityID);

        if (entity.type === 'node') {
            return extractFromNode(entity, graph, shiftKeyPressed);
        }

        return extractFromWayOrRelation(entity, graph);
    };

    /** @param {boolean} shiftKeyPressed */
    function extractFromNode(node, graph, shiftKeyPressed) {

        extractedNodeID = node.id;

        // Create a new node to replace the one we will detach
        var replacement = new osmNode({ loc: node.loc });
        graph = graph.replace(replacement);

        // Process each way in turn, updating the graph as we go
        graph = graph.parentWays(node)
            .reduce(function(accGraph, parentWay) {
                return accGraph.replace(parentWay.replaceNode(entityID, replacement.id));
            }, graph);

        if (!shiftKeyPressed) return graph;

        // Process any relations too
        // but only if the user holds down the shift key while triggering the operation.
        return graph.parentRelations(node)
            .reduce(function(accGraph, parentRel) {
                return accGraph.replace(parentRel.replaceMember(node, replacement));
            }, graph);
    }

    function extractFromWayOrRelation(entity, graph) {

        var fromGeometry = entity.geometry(graph);

        var extractedLoc = d3_geoPath(projection).centroid(entity.asGeoJSON(graph));
        extractedLoc = extractedLoc && projection.invert(extractedLoc);
        if (!extractedLoc  || !isFinite(extractedLoc[0]) || !isFinite(extractedLoc[1])) {
            extractedLoc = entity.extent(graph).center();
        }

        var indoorAreaValues = {
            area: true,
            corridor: true,
            elevator: true,
            level: true,
            room: true
        };

        var isBuilding = (entity.tags.building && entity.tags.building !== 'no') ||
            (entity.tags['building:part'] && entity.tags['building:part'] !== 'no');

        var isIndoorArea = fromGeometry === 'area' && entity.tags.indoor && indoorAreaValues[entity.tags.indoor];
        var moveAddressTags = actionExtractMovesAddressTags(entity);

        var entityTags = Object.assign({}, entity.tags);  // shallow copy
        var pointTags = {};
        for (var key in entityTags) {

            if (entity.type === 'relation' &&
                key === 'type') {
                continue;
            }

            if (keysToRetain.indexOf(key) !== -1) {
                continue;
            }

            if (isBuilding) {
                // don't transfer building-related tags
                if (isBuildingKey(key)) continue;
            }
            // leave `indoor` tag on the area
            if (isIndoorArea && key === 'indoor') {
                continue;
            }

            // copy the tag from the entity to the point
            pointTags[key] = entityTags[key];

            // leave addresses and some other tags so they're on both features
            if (keysToCopyAndRetain.indexOf(key) !== -1 ||
                (isAddressKey(key) && !moveAddressTags)) {
                continue;
            } else if (isIndoorArea && key === 'level') {
                // leave `level` on both features
                continue;
            }

            // remove the tag from the entity
            delete entityTags[key];
        }

        if (!isBuilding && !isIndoorArea && fromGeometry === 'area') {
            // ensure that areas keep area geometry
            entityTags.area = 'yes';
        }

        var replacement = new osmNode({ loc: extractedLoc, tags: pointTags });
        graph = graph.replace(replacement);

        extractedNodeID = replacement.id;

        return graph.replace(entity.update({tags: entityTags}));
    }

    action.getExtractedNodeID = function() {
        return extractedNodeID;
    };

    return action;
}
