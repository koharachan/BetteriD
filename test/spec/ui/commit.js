import { select as d3_select, selectAll as d3_selectAll } from 'd3-selection';


describe('iD.uiCommit', function() {
    var context, element;

    beforeAll(function() {
        iD.presetManager.merge({
            fields: {
                comment: { key: 'comment', type: 'textarea', usage: 'changeset' },
                hashtags: { key: 'hashtags', type: 'semiCombo', usage: 'changeset' },
                source: { key: 'source', type: 'semiCombo', usage: 'changeset' }
            }
        });
    });

    beforeEach(function() {
        iD.prefs('disclosure.changeset_tag_editor.expanded', null);
        iD.prefs('disclosure.changes_list.expanded', 'false');

        var connection = {
            getClosedIDs: () => [],
            maxChangesetElements: () => 10000,
            userChangesets: callback => callback(null, []),
            userDetails: callback => callback(null, {
                id: 1,
                display_name: 'test',
                changesets_count: 1
            }),
            userURL: () => ''
        };

        context = iD.coreContext().assetPath('../dist/').init();
        context.connection = () => connection;

        element = d3_select('body')
            .append('div')
            .attr('class', 'ui-wrap')
            .call(iD.uiCommit(context));
    });

    afterEach(function() {
        d3_selectAll('.ui-wrap').remove();
        iD.prefs('disclosure.changeset_tag_editor.expanded', null);
        iD.prefs('disclosure.changes_list.expanded', null);
    });


    function tagRow(key) {
        return element.selectAll('.section-changeset-tag-editor .tag-row')
            .filter(d => d.key === key);
    }


    it('allows generated changeset tags to be edited', function() {
        var row = tagRow('imagery_used');

        expect(row.classed('readonly')).toBe(false);
        expect(row.select('input.key').attr('readonly')).toBeNull();
        expect(row.select('input.value').attr('readonly')).toBeNull();

        row.select('input.value').property('value', 'survey');
        iD.utilTriggerEvent(row.select('input.value'), 'change');

        expect(context.changeset.tags.imagery_used).toBe('survey');
        expect(tagRow('imagery_used').select('input.value').property('value')).toBe('survey');

        element.remove();
        element = d3_select('body')
            .append('div')
            .attr('class', 'ui-wrap')
            .call(iD.uiCommit(context));

        expect(context.changeset.tags.imagery_used).toBe('survey');
        expect(tagRow('imagery_used').select('input.value').property('value')).toBe('survey');

        iD.utilTriggerEvent(tagRow('imagery_used').select('button.remove'), 'mousedown', { button: 0 });
        expect(context.changeset.tags.imagery_used).toBeUndefined();
        expect(tagRow('imagery_used').empty()).toBe(true);

        element.remove();
        element = d3_select('body')
            .append('div')
            .attr('class', 'ui-wrap')
            .call(iD.uiCommit(context));

        expect(context.changeset.tags.imagery_used).toBeUndefined();
        expect(tagRow('imagery_used').empty()).toBe(true);
    });


    it('preserves the value when renaming a changeset tag', function() {
        var row = tagRow('created_by');
        var originalValue = context.changeset.tags.created_by;

        row.select('input.key').property('value', 'editor');
        iD.utilTriggerEvent(row.select('input.key'), 'change');

        expect(context.changeset.tags.created_by).toBeUndefined();
        expect(context.changeset.tags.editor).toBe(originalValue);
    });
});
