import { t } from '../core/localizer';
import { actionDeleteMultiple } from '../actions/delete_multiple';
import { behaviorOperation } from '../behavior/operation';
import { geoSphericalDistance } from '../geo';
import { modeBrowse } from '../modes/browse';
import { modeSelect } from '../modes/select';
import { uiCmd } from '../ui/cmd';
import { utilGetAllNodes, utilTotalExtent } from '../util';


export function operationDelete(context, selectedIDs) {
    var multi = (selectedIDs.length === 1 ? 'single' : 'multiple');
    var nodes = utilGetAllNodes(selectedIDs, context.graph());
    var coords = nodes.map(function(n) { return n.loc; });
    var extent = utilTotalExtent(selectedIDs, context.graph());


    var operation = function() {
        var nextSelectedID;
        var nextSelectedLoc;

        if (selectedIDs.length === 1) {
            var id = selectedIDs[0];
            var entity = context.entity(id);
            var geometry = entity.geometry(context.graph());
            var parents = context.graph().parentWays(entity);
            var parent = parents[0];

            // Select the next closest node in the way.
            if (geometry === 'vertex' && parent) {
                var wayNodes = parent.nodes;
                var i = wayNodes.indexOf(id);

                if (i === 0) {
                    i++;
                } else if (i === wayNodes.length - 1) {
                    i--;
                } else {
                    var prev = context.hasEntity(wayNodes[i - 1]);
                    var next = context.hasEntity(wayNodes[i + 1]);
                    if (prev && next) {
                        var a = geoSphericalDistance(entity.loc, prev.loc);
                        var b = geoSphericalDistance(entity.loc, next.loc);
                        i = a < b ? i - 1 : i + 1;
                    } else if (prev) {
                        i = i - 1;
                    } else if (next) {
                        i = i + 1;
                    } else {
                        i = -1;
                    }
                }

                nextSelectedID = i >= 0 ? wayNodes[i] : null;
                if (nextSelectedID && context.hasEntity(nextSelectedID)) {
                    nextSelectedLoc = context.entity(nextSelectedID).loc;
                } else {
                    nextSelectedID = null;
                }
            }
        }

        // Move the selection off the deleted entities before performing the
        // action: the history `change` event rebuilds the operation list from
        // `selectedIDs`, and any operation that looks its selection up in the
        // new graph would throw and abort that dispatch (and its redraw).
        if (nextSelectedID && nextSelectedLoc) {
            if (context.hasEntity(nextSelectedID)) {
                context.enter(modeSelect(context, [nextSelectedID]).follow(true));
            } else {
                context.map().centerEase(nextSelectedLoc);
                context.enter(modeBrowse(context));
            }
        } else {
            context.enter(modeBrowse(context));
        }

        var preserve = [];
        if (selectionIsWays()) {
            selectedIDs.forEach(function(wayID) {
                var way = context.hasEntity(wayID);
                if (!way) return;
                way.nodes.forEach(function(nodeID) {
                    var node = context.hasEntity(nodeID);
                    if (node && nodeUnloaded(node)) preserve.push(nodeID);
                });
            });
        }

        context.perform(
            actionDeleteMultiple(selectedIDs, preserve.length ? { preserveNodeIDs: preserve } : undefined),
            operation.annotation()
        );
        context.validator().validate();

    };


    function osmConnection() {
        if (typeof context.connection !== 'function') return null;
        return context.connection();
    }


    function selectionIsWays() {
        return selectedIDs.length > 0 && selectedIDs.every(function(id) {
            var entity = context.hasEntity(id);
            return entity && entity.type === 'way';
        });
    }


    function wayIsIncomplete(id) {
        var entity = context.hasEntity(id);
        if (!entity || entity.type !== 'way') return false;
        return entity.nodes.some(function(nodeID) { return !context.hasEntity(nodeID); });
    }


    /** True when the tile around this node has not been downloaded yet. */
    function nodeUnloaded(node) {
        if (typeof context.inIntro === 'function' && context.inIntro()) return false;
        var osm = osmConnection();
        if (!osm || typeof osm.isDataLoaded !== 'function') return false;
        return !osm.isDataLoaded(node.loc);
    }


    function someMissing() {
        if (typeof context.inIntro === 'function' && context.inIntro()) return false;
        var osm = osmConnection();
        if (osm && typeof osm.isDataLoaded === 'function') {
            var missing = coords.filter(function(loc) { return !osm.isDataLoaded(loc); });
            if (missing.length) {
                if (typeof context.loadTileAtLoc === 'function') {
                    missing.forEach(function(loc) { context.loadTileAtLoc(loc); });
                }
                return true;
            }
        }
        return false;
    }


    /**
     * A whole way may be deleted before its geometry or the surrounding
     * tiles have finished loading. Individual vertices stay blocked, and a
     * fully loaded way that is mostly off-screen stays blocked.
     */
    function wayStillLoading() {
        return selectionIsWays() && (selectedIDs.some(wayIsIncomplete) || someMissing());
    }


    operation.available = function() {
        return true;
    };


    operation.disabled = function() {
        var loading = wayStillLoading();
        if (!loading && mostlyOffscreen()) {
            return 'too_large';
        } else if (!selectionIsWays() && someMissing()) {
            return 'not_downloaded';
        } else if (selectedIDs.some(hiddenConnection)) {
            return 'connected_to_hidden';
        } else if (selectedIDs.some(protectedMember)) {
            return 'part_of_relation';
        } else if (selectedIDs.some(incompleteRelation)) {
            return 'incomplete_relation';
        } else if (selectedIDs.some(hasWikidataTag)) {
            return 'has_wikidata_tag';
        }

        return false;


        function mostlyOffscreen() {
            if (typeof context.map !== 'function') return false;
            var map = context.map();
            if (!map || typeof map.extent !== 'function') return false;
            return extent.percentContainedIn(map.extent()) < 0.8;
        }

        function hiddenConnection(id) {
            if (typeof context.hasHiddenConnections !== 'function') return false;
            try {
                return context.hasHiddenConnections(id);
            } catch {
                // child nodes that are not in the graph yet cannot be checked
                return false;
            }
        }

        function hasWikidataTag(id) {
            var entity = context.entity(id);
            return entity.tags.wikidata && entity.tags.wikidata.trim().length > 0;
        }

        function incompleteRelation(id) {
            var entity = context.entity(id);
            return entity.type === 'relation' && !entity.isComplete(context.graph());
        }

        function protectedMember(id) {
            var entity = context.entity(id);
            if (entity.type !== 'way') return false;

            var parents = context.graph().parentRelations(entity);
            for (var i = 0; i < parents.length; i++) {
                var parent = parents[i];
                var type = parent.tags.type;
                var role = parent.memberById(id).role || 'outer';
                if (type === 'route' || type === 'boundary' || (type === 'multipolygon' && role === 'outer')) {
                    return true;
                }
            }
            return false;
        }
    };


    operation.tooltip = function() {
        var disable = operation.disabled();
        return disable ?
            t.append('operations.delete.' + disable + '.' + multi) :
            t.append('operations.delete.description.' + multi);
    };


    operation.annotation = function() {
        return selectedIDs.length === 1 ?
            t('operations.delete.annotation.' + context.graph().geometry(selectedIDs[0])) :
            t('operations.delete.annotation.feature', { n: selectedIDs.length });
    };


    operation.id = 'delete';
    operation.keys = [uiCmd('⌘⌫'), uiCmd('⌘⌦'), uiCmd('⌦')];
    operation.title = t.append('operations.delete.title');
    operation.behavior = behaviorOperation(context).which(operation);

    return operation;
}
