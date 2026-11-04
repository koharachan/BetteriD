// Dialog copy for leaving the editor.
//
// In a browser, `window.onbeforeunload` returning a string asks the user
// before the tab closes. Electron does not show that dialog: any return
// value other than `undefined` cancels the close and nothing else happens.
// The shell shows this prompt instead, then allows the unload only when
// the user chooses to leave. Choice 0 is leave; anything else stays.

'use strict';

function isChinese(locale) {
    return /^zh\b/i.test(String(locale || ''));
}

function unloadPrompt(locale, message, intent) {
    const zh = isChinese(locale);
    const text = typeof message === 'string' ? message.trim() : '';
    const quitting = intent !== 'continue';
    const leave = quitting ? (zh ? '退出' : 'Quit') : (zh ? '继续' : 'Continue');
    const cancel = zh ? '取消' : 'Cancel';
    const fallback = zh ? '你有未保存的更改' : 'You have unsaved changes';
    const detail = zh
        ? '这些修改还没有上传到 OpenStreetMap。取消可以继续编辑。本机会留下一份副本，下次打开可以恢复。'
        : 'These edits have not been uploaded to OpenStreetMap. Cancel to keep editing. A copy stays on this computer and can be restored the next time BetteriD opens.';

    return {
        type: 'question',
        title: 'BetteriD',
        message: text || fallback,
        detail,
        buttons: [leave, cancel],
        defaultId: 1,
        cancelId: 1,
        noLink: true
    };
}

function wantsToLeave(choice) {
    return choice === 0;
}

module.exports = { unloadPrompt, wantsToLeave };
