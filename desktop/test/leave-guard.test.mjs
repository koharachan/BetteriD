import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { leaveApproved, leaveDialogOptions } = require('../leave-prompt.js');
const pkg = require('../package.json');

function loadGuard() {
    const code = fs.readFileSync(new URL('../app/leave-guard.js', import.meta.url), 'utf8');
    const sandbox = {
        document: {
            documentElement: { lang: '' },
            getElementById(id) {
                return id === 'id-container' ? { getAttribute: () => sandbox.containerLang } : null;
            }
        },
        navigator: { language: 'en-US' },
        onbeforeunload: null,
        BETTERID_DESKTOP: {
            confirmLeave: () => { throw new Error('confirmLeave was not stubbed'); }
        },
        __betteridErrors: [],
        containerLang: ''
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    return sandbox;
}

function beforeUnloadEvent() {
    return {
        defaultPrevented: false,
        returnValue: undefined,
        preventDefault() { this.defaultPrevented = true; }
    };
}

test('packaged files include the leave prompt and the page guard', () => {
    assert.ok(pkg.build.files.includes('leave-prompt.js'));
    assert.ok(pkg.build.files.includes('app/**/*'));
});

test('dialog copy follows the editor locale and Cancel is the default', () => {
    const en = leaveDialogOptions({
        locale: 'en-US',
        message: 'You have unsaved changes',
        platform: 'win32'
    });
    assert.deepEqual(en.buttons, ['Exit', 'Cancel']);
    assert.equal(en.defaultId, 1);
    assert.equal(en.cancelId, 1);
    assert.deepEqual(leaveDialogOptions({ locale: 'en', message: 'You have unsaved changes', platform: 'linux' }).buttons, ['Quit', 'Cancel']);
    assert.equal(en.message, 'You have unsaved changes');
    assert.match(en.detail, /saved on this computer/);

    const zh = leaveDialogOptions({ locale: 'zh-CN', message: '你有未保存的更改', platform: 'win32' });
    assert.deepEqual(zh.buttons, ['退出', '取消']);
    assert.equal(zh.message, '你有未保存的更改');
    assert.match(zh.detail, /已保存在本机/);

    assert.equal(leaveApproved(0), true);
    assert.equal(leaveApproved(1), false);
});

test('no unsaved changes closes without a dialog', () => {
    const sandbox = loadGuard();
    let asked = 0;
    sandbox.BETTERID_DESKTOP.confirmLeave = () => { asked += 1; return false; };
    sandbox.onbeforeunload = () => undefined;
    sandbox.BetteriDLeaveGuard.install();

    const event = beforeUnloadEvent();
    const result = sandbox.onbeforeunload(event);
    assert.equal(result, undefined);
    assert.equal(asked, 0);
    assert.equal(event.defaultPrevented, false);
});

test('confirming Exit lets the unload proceed after the editor has saved', () => {
    const sandbox = loadGuard();
    const order = [];
    sandbox.containerLang = 'zh-CN';
    sandbox.BETTERID_DESKTOP.confirmLeave = (message, locale) => {
        order.push('ask');
        assert.equal(message, '你有未保存的更改');
        assert.equal(locale, 'zh-CN');
        return true;
    };
    sandbox.onbeforeunload = () => {
        order.push('save');
        return '你有未保存的更改';
    };
    sandbox.BetteriDLeaveGuard.install();

    const event = beforeUnloadEvent();
    const result = sandbox.onbeforeunload(event);
    assert.deepEqual(order, ['save', 'ask']);
    assert.equal(result, undefined);
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.returnValue, undefined);
});

test('cancelling the dialog keeps the window open', () => {
    const sandbox = loadGuard();
    sandbox.BETTERID_DESKTOP.confirmLeave = () => false;
    sandbox.onbeforeunload = () => 'You have unsaved changes';
    sandbox.BetteriDLeaveGuard.install();

    const event = beforeUnloadEvent();
    const result = sandbox.onbeforeunload(event);
    assert.equal(result, 'You have unsaved changes');
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.returnValue, 'You have unsaved changes');
});

test('a dialog failure does not trap the window', () => {
    const sandbox = loadGuard();
    sandbox.BETTERID_DESKTOP.confirmLeave = () => { throw new Error('dialog failed'); };
    sandbox.onbeforeunload = () => 'You have unsaved changes';
    sandbox.BetteriDLeaveGuard.install();

    const event = beforeUnloadEvent();
    const result = sandbox.onbeforeunload(event);
    assert.equal(result, undefined);
    assert.equal(event.defaultPrevented, false);
    assert.equal(sandbox.__betteridErrors.length, 1);
});

test('an already approved leave skips the editor prompt', () => {
    const sandbox = loadGuard();
    let saved = 0;
    let asked = 0;
    sandbox.BETTERID_DESKTOP.confirmLeave = () => { asked += 1; return false; };
    sandbox.onbeforeunload = () => { saved += 1; return 'You have unsaved changes'; };
    sandbox.BetteriDLeaveGuard.install();
    sandbox.__betteridAllowLeave = true;

    const event = beforeUnloadEvent();
    const result = sandbox.onbeforeunload(event);
    assert.equal(result, undefined);
    assert.equal(saved, 0);
    assert.equal(asked, 0);
    assert.equal(sandbox.__betteridAllowLeave, false);
});

test('installing twice does not ask twice', () => {
    const sandbox = loadGuard();
    let asked = 0;
    sandbox.BETTERID_DESKTOP.confirmLeave = () => { asked += 1; return false; };
    sandbox.onbeforeunload = () => 'You have unsaved changes';
    sandbox.BetteriDLeaveGuard.install();
    sandbox.BetteriDLeaveGuard.install();

    sandbox.onbeforeunload(beforeUnloadEvent());
    assert.equal(asked, 1);
});

test('the shell can read the pending message without unloading', () => {
    const sandbox = loadGuard();
    sandbox.containerLang = 'en';
    sandbox.onbeforeunload = () => 'You have unsaved changes';
    sandbox.BetteriDLeaveGuard.install();

    const pending = sandbox.BetteriDLeaveGuard.pendingMessage();
    assert.equal(pending.message, 'You have unsaved changes');
    assert.equal(pending.locale, 'en');
});
