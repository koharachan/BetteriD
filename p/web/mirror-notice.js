(() => {
  const notice = document.getElementById('betterid-mirror-notice');
  const confirm = notice?.querySelector('[data-betterid-mirror-confirm]');
  if (!notice || !confirm || typeof notice.showModal !== 'function') return;

  const storageKey = 'betterid.mirror-notice.v1';
  try {
    if (window.localStorage.getItem(storageKey) === 'acknowledged') return;
  } catch {
    // The notice still works when storage is unavailable.
  }

  confirm.addEventListener('click', () => {
    try {
      window.localStorage.setItem(storageKey, 'acknowledged');
    } catch {
      // Closing the notice must not depend on storage access.
    }
    notice.close();
  });

  notice.addEventListener('cancel', event => event.preventDefault());
  notice.showModal();
})();
