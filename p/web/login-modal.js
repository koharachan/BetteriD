(() => {
  const modal = document.getElementById('betterid-login-modal');
  if (!modal) return;

  const dialog = modal.querySelector('.betterid-login-dialog');
  const accountLink = modal.querySelector('[data-betterid-account-login]');
  const oauthLink = modal.querySelector('[data-betterid-oauth-login]');
  const closeButtons = modal.querySelectorAll('[data-betterid-login-close]');
  let previousFocus = null;
  let closeTimer = null;

  function oauthStartURL() {
    const url = new URL('/id/oauth/start', window.location.origin);
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const map = hash.get('map');
    if (map) url.searchParams.set('map', map);
    return url.pathname + url.search;
  }

  function focusableElements() {
    return Array.from(modal.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter(element => !element.hidden && element.getClientRects().length);
  }

  function openModal(loginURL, trigger) {
    if (closeTimer) window.clearTimeout(closeTimer);
    previousFocus = trigger || document.activeElement;
    accountLink.href = loginURL || '/login?referer=%2F';
    oauthLink.href = oauthStartURL();
    modal.hidden = false;
    document.documentElement.classList.add('betterid-login-open');
    document.body.classList.add('betterid-login-open');
    window.requestAnimationFrame(() => {
      modal.classList.add('is-open');
      dialog.focus();
    });
  }

  function closeModal() {
    modal.classList.remove('is-open');
    document.documentElement.classList.remove('betterid-login-open');
    document.body.classList.remove('betterid-login-open');
    closeTimer = window.setTimeout(() => {
      modal.hidden = true;
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
    }, 180);
  }

  document.addEventListener('click', event => {
    const trigger = event.target.closest('.login-menu a[href*="/login"]');
    if (!trigger || trigger.closest('#betterid-login-modal')) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openModal(trigger.getAttribute('href'), trigger);
  }, true);

  closeButtons.forEach(button => button.addEventListener('click', closeModal));

  document.addEventListener('keydown', event => {
    if (modal.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = focusableElements();
    if (!focusable.length) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  window.addEventListener('pageshow', () => {
    modal.classList.remove('is-open');
    modal.hidden = true;
    document.documentElement.classList.remove('betterid-login-open');
    document.body.classList.remove('betterid-login-open');
  });

  modal.dataset.betteridReady = 'true';
})();
