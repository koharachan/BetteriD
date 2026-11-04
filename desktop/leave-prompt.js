'use strict';

/** OS / editor locale, e.g. "zh-CN" or "en". */
function isChinese(locale) {
    return /^zh\b/i.test(String(locale || ''));
}


/**
 * Native dialog shown when the editor refuses to unload because of unsaved
 * edits. Button 0 leaves; button 1 stays. Cancel is the default so Enter and
 * Escape keep the window open.
 */
function leaveDialogOptions({ locale, message, platform }) {
    const zh = isChinese(locale);
    const text = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    // Match Electron's quit menu label: "Exit" on Windows, "Quit" elsewhere.
    const exitLabel = zh ? '退出' : (platform === 'win32' ? 'Exit' : 'Quit');
    return {
        type: 'question',
        buttons: [exitLabel, zh ? '取消' : 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'BetteriD',
        message: text || (zh ? '你有未保存的更改' : 'You have unsaved changes'),
        detail: zh
            ? '这些修改已保存在本机，下次打开可以恢复。它们尚未上传到 OpenStreetMap。'
            : 'These edits are saved on this computer and can be restored the next time you open BetteriD. They have not been uploaded to OpenStreetMap.'
    };
}


/** `dialog.showMessageBoxSync` returns the clicked button index. */
function leaveApproved(buttonIndex) {
    return buttonIndex === 0;
}


module.exports = {
    isChinese,
    leaveDialogOptions,
    leaveApproved
};
