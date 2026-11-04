'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { unloadPrompt, wantsToLeave } = require('./quit');

describe('unloadPrompt', () => {
    it('uses the editor message and keeps Cancel as the default', () => {
        const prompt = unloadPrompt('en-US', 'You have unsaved changes', 'quit');
        assert.equal(prompt.message, 'You have unsaved changes');
        assert.deepEqual(prompt.buttons, ['Quit', 'Cancel']);
        assert.equal(prompt.defaultId, 1);
        assert.equal(prompt.cancelId, 1);
    });

    it('uses Chinese buttons for a zh locale', () => {
        const prompt = unloadPrompt('zh-CN', '你有未保存的更改', 'quit');
        assert.equal(prompt.message, '你有未保存的更改');
        assert.deepEqual(prompt.buttons, ['退出', '取消']);
    });

    it('asks to continue rather than quit when the page is only reloading', () => {
        const prompt = unloadPrompt('en', '', 'continue');
        assert.equal(prompt.message, 'You have unsaved changes');
        assert.deepEqual(prompt.buttons, ['Continue', 'Cancel']);
    });
});

describe('wantsToLeave', () => {
    it('treats only the leave button as confirmation', () => {
        assert.equal(wantsToLeave(0), true);
        assert.equal(wantsToLeave(1), false);
        assert.equal(wantsToLeave(undefined), false);
    });
});
