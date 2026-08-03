(() => {
  const modal = document.getElementById('betterid-login-modal');
  if (!modal) return;

  const dialog = modal.querySelector('.betterid-login-dialog');
  const accountLink = modal.querySelector('[data-betterid-account-login]');
  const oauthLink = modal.querySelector('[data-betterid-oauth-login]');
  const closeButtons = modal.querySelectorAll('[data-betterid-login-close]');
  const loginMenu = document.querySelector('.login-menu');
  let previousFocus = null;
  let closeTimer = null;

  function tokenKey() {
    return window.location.origin + 'oauth2_access_token';
  }

  function oauthToken() {
    try {
      return window.localStorage.getItem(tokenKey());
    } catch {
      return null;
    }
  }

  function clearOauthToken() {
    try {
      window.localStorage.removeItem(tokenKey());
    } catch {
      // Ignore storage errors so the homepage keeps working in restrictive browsers.
    }
  }

  function parseUser(payload) {
    const user = payload?.user ?? payload?.elements?.find(element => element.type === 'user');
    if (!user?.display_name) return null;
    return {
      displayName: user.display_name,
      imageURL: user.img?.href || user.image_url || null
    };
  }

  function oauthStartURL() {
    const url = new URL('/id/oauth/start', window.location.origin);
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const map = hash.get('map');
    if (map) url.searchParams.set('map', map);
    return url.pathname + url.search;
  }

  function userURL(displayName) {
    return '/user/' + encodeURIComponent(displayName).replace(/%20/g, '+');
  }

  function focusableElements() {
    return Array.from(modal.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      .filter(element => !element.hidden && element.getClientRects().length);
  }

  function renderLoggedInState(user) {
    if (!loginMenu || !user) return;

    const userLink = document.createElement('a');
    userLink.className = 'betterid-login-status-user';
    userLink.href = userURL(user.displayName);

    if (user.imageURL) {
      const avatar = document.createElement('img');
      avatar.className = 'betterid-login-status-avatar';
      avatar.src = user.imageURL;
      avatar.alt = '';
      avatar.loading = 'lazy';
      userLink.append(avatar);
    } else {
      const avatar = document.createElement('span');
      avatar.className = 'betterid-login-status-avatar betterid-login-status-avatar-placeholder';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = user.displayName.trim().charAt(0).toLocaleUpperCase() || '?';
      userLink.append(avatar);
    }

    const name = document.createElement('span');
    name.className = 'betterid-login-status-name';
    name.textContent = user.displayName;
    userLink.append(name);

    const logout = document.createElement('button');
    logout.type = 'button';
    logout.className = 'betterid-login-status-logout';
    logout.textContent = document.documentElement.lang?.startsWith('zh') ? '退出' : 'Log out';
    logout.addEventListener('click', () => {
      clearOauthToken();
      window.location.reload();
    });

    loginMenu.replaceChildren(userLink, logout);
    loginMenu.classList.add('betterid-login-status');
  }

  async function loadLoggedInState() {
    const token = oauthToken();
    if (!token || !loginMenu) return;

    try {
      const response = await fetch('/api/0.6/user/details.json', {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`
        },
        credentials: 'same-origin',
        cache: 'no-store'
      });

      if (response.status === 401 || response.status === 403) {
        clearOauthToken();
        return;
      }
      if (!response.ok) return;

      const user = parseUser(await response.json());
      renderLoggedInState(user);
    } catch {
      // Leave the original login links in place when the status probe fails.
    }
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
  loadLoggedInState();
})();
