import { actionDiscardTags } from '../actions/discard_tags';
import { fileFetcher } from '../core/file_fetcher';
import { osmChangeset } from '../osm';
import { utilAIStatus } from '../util/ai_status';
import { JXON } from '../util/jxon';

let _discardTagsPromise;

function loadDiscardTags() {
    if (!_discardTagsPromise) {
        _discardTagsPromise = fileFetcher.get('discarded').catch(() => ({}));
    }
    return _discardTagsPromise;
}


/**
 * True when the proxy has a server-side privacy upload credential.
 * @returns {Promise<boolean>}
 */
export function utilPrivacyUploadAvailable() {
    return utilAIStatus().then(status => status.privacy === true);
}


/**
 * Build the osmChange document for the editor's pending edits, using the same
 * tag filtering as the "download changes" link and the normal uploader.
 *
 * @param {iD.Context} context
 * @returns {Promise<string>} osmChange XML
 */
export function utilPrivacyOsmChange(context) {
    return loadDiscardTags().then(discardTags => {
        const history = context.history();
        const changeset = new osmChangeset().update({ id: undefined });
        delete changeset.id;   // export without a changeset_id
        const changes = history.changes(actionDiscardTags(history.difference(), discardTags));
        return JXON.stringify(changeset.osmChangeJXON(changes));
    });
}


/**
 * Upload the pending edits as an anonymous ("privacy") changeset through the
 * proxy. The server holds the OSM credential; the browser never sees it.
 *
 * @param {iD.Context} context
 * @param {Object} tags          changeset tags from the commit panel
 * @returns {Promise<{changeset: number, url: string, created: number, modified: number, deleted: number}>}
 */
export function utilPrivacyUpload(context, tags) {
    return utilPrivacyOsmChange(context).then(osmChange => {
        const comment = (tags && tags.comment) || '';
        return fetch('/api/osm-ai/privacy/upload', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ comment: comment, tags: tags || {}, osmChange: osmChange })
        }).then(response => response.json().catch(() => ({})).then(payload => {
            if (!response.ok) {
                throw new Error(payload.error || ('HTTP ' + response.status));
            }
            return payload;
        }));
    });
}
