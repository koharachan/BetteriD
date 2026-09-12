import { dispatch as d3_dispatch } from 'd3-dispatch';

import { fileFetcher } from './file_fetcher';
import { actionDiscardTags } from '../actions/discard_tags';
import { actionMergeRemoteChanges } from '../actions/merge_remote_changes';
import { actionNoop } from '../actions/noop';
import { actionRevert } from '../actions/revert';
import { coreChangeBatches } from '../core/change_batches';
import { coreGraph } from '../core/graph';
import { t } from '../core/localizer';
import { osmChangeset } from '../osm';
import { utilArrayUnion, utilArrayUniq, utilDisplayName, utilDisplayType, utilRebind } from '../util';

const AUTO_SPLIT_MAX_CHANGES = 1500;

/** @param {iD.Context} context */
export function coreUploader(context) {

    var dispatch = d3_dispatch(
        // Start and end events are dispatched exactly once each per legitimate outside call to `save`
        'saveStarted', // dispatched as soon as a call to `save` has been deemed legitimate
        'saveEnded',   // dispatched after the result event has been dispatched

        'willAttemptUpload', // dispatched before the actual upload call occurs, if it will
        'progressChanged',

        // Each save results in one of these outcomes:
        'resultNoChanges', // upload wasn't attempted since there were no edits
        'resultErrors',    // upload failed due to errors
        'resultConflicts', // upload failed due to data conflicts
        'resultSuccess'    // upload completed without errors
    );

    var _isSaving = false;

    let _anyConflictsAutomaticallyResolved = false;
    var _conflicts = [];
    var _errors = [];
    var _origChanges;
    var _saveOptions = {};
    var _uploadedChangesets = [];

    var _discardTags = {};
    fileFetcher.get('discarded')
        .then(function(d) { _discardTags = d; })
        .catch(function() { /* ignore */ });

    const uploader = {};

    uploader.isSaving = function() {
        return _isSaving;
    };

    uploader.save = function(changeset, tryAgain, checkConflicts, saveOptions) {
        // Guard against accidentally entering save code twice - #4641
        if (_isSaving && !tryAgain) {
            return;
        }
        if (!tryAgain) {
            _saveOptions = saveOptions || {};
            _uploadedChangesets = [];
        }

        var osm = context.connection();
        if (!osm) return;

        // If user somehow got logged out mid-save, try to reauthenticate..
        // This can happen if they were logged in from before, but the tokens are no longer valid.
        if (!osm.authenticated()) {
            osm.authenticate(function(err) {
                if (!err) {
                    uploader.save(changeset, tryAgain, checkConflicts);  // continue where we left off..
                }
            });
            return;
        }

        if (!_isSaving) {
            _isSaving = true;
            dispatch.call('saveStarted', this);
        }

        var history = context.history();

        _anyConflictsAutomaticallyResolved = false;
        _conflicts = [];
        _errors = [];

        // Store original changes, in case user wants to download them as an .osc file
        _origChanges = history.changes(actionDiscardTags(history.difference(), _discardTags));

        // First time, `history.perform` a no-op action.
        // Any conflict resolutions will be done as `history.replace`
        // Remember to pop this later if needed
        if (!tryAgain) {
            history.perform(actionNoop());
        }

        // Attempt a fast upload.. If there are conflicts, re-enter with `checkConflicts = true`.
        // Large uploads are split automatically, so run the full check before the first batch.
        if (!checkConflicts && !shouldSplitChanges(_origChanges)) {
            upload(changeset);

        // Split uploads always run the full check before the first batch.
        } else {
            performFullConflictCheck(changeset);
        }

    };


    function performFullConflictCheck(changeset) {

        var osm = context.connection();
        if (!osm) return;

        var history = context.history();

        var localGraph = context.graph();
        var remoteGraph = new coreGraph(history.base(), true);

        var summary = history.difference().summary();
        var _toCheck = [];
        for (var i = 0; i < summary.length; i++) {
            var item = summary[i];
            if (item.changeType === 'modified') {
                _toCheck.push(item.entity.id);
            }
        }

        var _toLoad = withChildNodes(_toCheck, localGraph);
        var _loaded = {};
        var _toLoadCount = 0;
        var _toLoadTotal = _toLoad.length;

        if (_toCheck.length) {
            dispatch.call('progressChanged', this, _toLoadCount, _toLoadTotal);
            _toLoad.forEach(function(id) { _loaded[id] = false; });
            osm.loadMultiple(_toLoad, loaded);
        } else {
            upload(changeset);
        }

        return;

        function withChildNodes(ids, graph) {
            var s = new Set(ids);
            ids.forEach(function(id) {
                var entity = graph.entity(id);
                if (entity.type !== 'way') return;

                graph.childNodes(entity).forEach(function(child) {
                    if (child.version !== undefined) {
                        s.add(child.id);
                    }
                });
            });

            return Array.from(s);
        }


        // Reload modified entities into an alternate graph and check for conflicts..
        function loaded(err, result) {
            if (_errors.length) return;

            if (err) {
                _errors.push({
                    msg: err.message || err.responseText,
                    details: [ t('save.status_code', { code: err.status }) ]
                });
                didResultInErrors();

            } else {
                var loadMore = [];

                result.data.forEach(function(entity) {
                    remoteGraph.replace(entity);
                    _loaded[entity.id] = true;
                    _toLoad = _toLoad.filter(function(val) { return val !== entity.id; });

                    if (!entity.visible) return;

                    // Because loadMultiple doesn't download /full like loadEntity,
                    // need to also load children that aren't already being checked..
                    var i, id;
                    if (entity.type === 'way') {
                        for (i = 0; i < entity.nodes.length; i++) {
                            id = entity.nodes[i];
                            if (_loaded[id] === undefined) {
                                _loaded[id] = false;
                                loadMore.push(id);
                            }
                        }
                    } else if (entity.type === 'relation' && entity.isMultipolygon()) {
                        for (i = 0; i < entity.members.length; i++) {
                            id = entity.members[i].id;
                            if (_loaded[id] === undefined) {
                                _loaded[id] = false;
                                loadMore.push(id);
                            }
                        }
                    }
                });

                _toLoadCount += result.data.length;
                _toLoadTotal += loadMore.length;
                dispatch.call('progressChanged', this, _toLoadCount, _toLoadTotal);

                if (loadMore.length) {
                    _toLoad.push.apply(_toLoad, loadMore);
                    osm.loadMultiple(loadMore, loaded);
                }

                if (!_toLoad.length) {
                    detectConflicts();
                    upload(changeset);
                }
            }
        }


        function detectConflicts() {
            function choice(id, text, action) {
                return {
                    id: id,
                    text: text,
                    action: function() {
                        history.replace(action);
                    }
                };
            }
            function formatUser(selection, d) {
                selection
                    .append('a')
                    .attr('href', osm.userURL(d))
                    .attr('target', '_blank')
                    .text(d);
            }
            function entityName(entity) {
                return utilDisplayName(entity) || (utilDisplayType(entity.id) + ' ' + entity.id);
            }

            function sameVersions(local, remote) {
                if (local.version !== remote.version) return false;

                if (local.type === 'way') {
                    var children = utilArrayUnion(local.nodes, remote.nodes);
                    for (var i = 0; i < children.length; i++) {
                        var a = localGraph.hasEntity(children[i]);
                        var b = remoteGraph.hasEntity(children[i]);
                        if (a && b && a.version !== b.version) return false;
                    }
                }

                return true;
            }

            _toCheck.forEach(function(id) {
                var local = localGraph.entity(id);
                var remote = remoteGraph.entity(id);

                if (sameVersions(local, remote)) return;

                var merge = actionMergeRemoteChanges(id, localGraph, remoteGraph, _discardTags, formatUser);

                history.replace(merge);

                var mergeConflicts = merge.conflicts();
                if (!mergeConflicts.length) {
                    _anyConflictsAutomaticallyResolved = true;
                    return; // merged safely
                }

                var forceLocal = actionMergeRemoteChanges(id, localGraph, remoteGraph, _discardTags).withOption('force_local');
                var forceRemote = actionMergeRemoteChanges(id, localGraph, remoteGraph, _discardTags).withOption('force_remote');
                var keepMine = t('save.conflict.' + (remote.visible ? 'keep_local' : 'restore'));
                var keepTheirs = t('save.conflict.' + (remote.visible ? 'keep_remote' : 'delete'));

                _conflicts.push({
                    id: id,
                    name: entityName(local),
                    details: mergeConflicts,
                    chosen: 1,
                    choices: [
                        choice(id, keepMine, forceLocal),
                        choice(id, keepTheirs, forceRemote)
                    ]
                });
            });
        }
    }


    async function upload(changeset) {
        try {
            var osm = context.connection();
            if (!osm) {
                _errors.push({ msg: 'No OSM Service' });
            }

            if (_conflicts.length) {
                didResultInConflicts(changeset);

            } else if (_errors.length) {
                didResultInErrors();

            } else {
                if (_anyConflictsAutomaticallyResolved) {
                    changeset.tags.merge_conflict_resolved = 'automatically';
                    if (changeset.id) {
                        await osm.updateChangesetTags(changeset);
                    }
                }

                var history = context.history();
                var changes = history.changes(actionDiscardTags(history.difference(), _discardTags));
                var hasChanges = changes.modified.length || changes.created.length || changes.deleted.length;
                if (!hasChanges) {
                    didResultInNoChanges();
                    return;
                }

                var batches = shouldSplitChanges(changes) ?
                    coreChangeBatches(changes, context.graph(), splitOptions(changes)) : [changes];

                dispatch.call('willAttemptUpload', this);
                if (batches.length > 1) {
                    uploadBatches(changeset, batches);
                } else {
                    osm.putChangeset(changeset, batches[0], uploadCallback);
                }
            }
        } catch (err) {
            _errors.push({
                msg: err?.message || t('save.error'),
                details: [t('save.unknown_error_details')]
            });
            didResultInErrors();
        }
    }


    function uploadBatches(changeset, batches) {
        var osm = context.connection();
        if (!osm) return;

        function uploadNext(index) {
            var batch = batches[index];
            dispatch.call('progressChanged', this, index + 1, batches.length, 'save.upload_progress');

            var tags = Object.assign({}, changeset.tags);
            if (tags.comment) {
                tags.comment = `${tags.comment}（第 ${index + 1}/${batches.length} 批）`;
            }
            var batchChangeset = new osmChangeset({ tags: tags });

            osm.putChangeset(batchChangeset, batch, function(err, uploadedChangeset) {
                if (err) {
                    var completedIDs = _uploadedChangesets.map(item => item.id).filter(Boolean);
                    _errors.push({
                        msg: t('save.split_failed', { completed: completedIDs.length, total: batches.length }),
                        details: completedIDs.length ?
                            [t('save.split_completed_ids', { ids: completedIDs.join(', ') })] :
                            [t('save.status_code', { code: err.status })]
                    });
                    didResultInErrors();
                    return;
                }

                _uploadedChangesets.push(uploadedChangeset);
                if (index + 1 < batches.length) {
                    uploadNext(index + 1);
                } else {
                    didResultInSuccess(uploadedChangeset);
                }
            });
        }

        uploadNext(0);
    }


    function shouldSplitChanges(changes) {
        if (_saveOptions.enabled) return true;

        var changeCount = changes.created.length + changes.modified.length + changes.deleted.length;
        return changeCount > AUTO_SPLIT_MAX_CHANGES;
    }


    function splitOptions(changes) {
        if (_saveOptions.enabled) return _saveOptions;

        var changeCount = changes.created.length + changes.modified.length + changes.deleted.length;
        return {
            enabled: true,
            maxChanges: Math.min(AUTO_SPLIT_MAX_CHANGES, Math.ceil(changeCount / 2)),
            strategy: 'auto'
        };
    }


    function uploadCallback(err, changeset) {
        if (err) {
            if (err.status === 409) {  // 409 Conflict
                uploader.save(changeset, true, true);  // tryAgain = true, checkConflicts = true
            } else {
                _errors.push({
                    msg: err.message || err.responseText,
                    details: [ t('save.status_code', { code: err.status }) ]
                });
                didResultInErrors();
            }

        } else {
            didResultInSuccess(changeset);
        }
    }

    function didResultInNoChanges() {

        dispatch.call('resultNoChanges', this);

        endSave();

        context.flush(); // reset iD
    }

    function didResultInErrors() {

        context.history().pop();

        dispatch.call('resultErrors', this, _errors);

        endSave();
    }


    function didResultInConflicts(changeset) {
        // add a changeset tag to aid reviewers
        changeset.tags.merge_conflict_resolved = 'manually';
        context.connection().updateChangesetTags(changeset);

        _conflicts.sort(function(a, b) { return b.id.localeCompare(a.id); });

        dispatch.call('resultConflicts', this, changeset, _conflicts, _origChanges);

        endSave();
    }


    function didResultInSuccess(changeset) {

        // delete the edit stack cached to local storage
        context.history().clearSaved();

        if (!_uploadedChangesets.length) _uploadedChangesets = [changeset];
        dispatch.call('resultSuccess', this, changeset, _uploadedChangesets.slice());

        // Add delay to allow for postgres replication #1646 #2678
        window.setTimeout(function() {

            endSave();

            context.flush(); // reset iD
        }, 2500);
    }


    function endSave() {
        _isSaving = false;

        dispatch.call('saveEnded', this);
    }


    /**
     * Finish a changeset that was uploaded outside this pipeline (the
     * server-side "privacy" upload): run the same success flow the uploader
     * would have run, so the success screen shows and the editor resets.
     *
     * @param {{ id: string|number }} changeset
     */
    uploader.privatelyUploaded = function(changeset) {
        dispatch.call('willAttemptUpload', this, changeset);
        context.history().clearSaved();
        _uploadedChangesets = [changeset];
        dispatch.call('resultSuccess', this, changeset, _uploadedChangesets.slice());

        // Add delay to allow for postgres replication #1646 #2678
        window.setTimeout(function() {
            try {
                endSave();
            } finally {
                context.flush();   // reset iD (always, even if a listener threw)
            }
        }, 2500);
    };


    uploader.cancelConflictResolution = function() {
        context.history().pop();
    };


    uploader.processResolvedConflicts = function(changeset) {
        var history = context.history();

        for (var i = 0; i < _conflicts.length; i++) {
            if (_conflicts[i].chosen === 1) {  // user chose "use theirs"
                var entity = context.hasEntity(_conflicts[i].id);
                if (entity && entity.type === 'way') {
                    var children = utilArrayUniq(entity.nodes);
                    for (var j = 0; j < children.length; j++) {
                        history.replace(actionRevert(children[j]));
                    }
                }
                history.replace(actionRevert(_conflicts[i].id));
            }
        }

        uploader.save(changeset, true, false);  // tryAgain = true, checkConflicts = false
    };


    uploader.uploadedChangesets = function() {
        return _uploadedChangesets.slice();
    };


    uploader.reset = function() {
        _saveOptions = {};
        _uploadedChangesets = [];
    };


    return utilRebind(uploader, dispatch, 'on');
}
