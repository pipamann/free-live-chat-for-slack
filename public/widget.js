/*!
 * Free Live Chat for Slack: website widget
 * MIT License, https://github.com/pipamann/free-live-chat-for-slack
 *
 * Embed:
 *   <script src="https://YOUR_WORKER.workers.dev/widget.js" data-turnstile-site-key="0x…" defer></script>
 *
 * Optional settings, either as data attributes (data-color, data-position, data-title, data-subtitle,
 * data-service-url) or before the script tag:
 *   <script>window.CHAT_CONFIG = { turnstileSiteKey: '0x…', color: '#0f766e', texts: { title: 'Hi there' } };</script>
 *
 * Open it from your own button: window.FreeLiveChat.open()
 */
(() => {
  'use strict';
  if (window.FreeLiveChat) return;

  const DEFAULT_TEXTS = {
    title: 'Chat with us',
    subtitle: 'We usually reply within a few minutes.',
    open: 'Open chat',
    close: 'Close chat',
    welcome: 'Hi! How can we help you?',
    placeholder: 'Write a message…',
    send: 'Send',
    attach: 'Attach a file',
    team: 'Team',
    bot: 'Assistant',
    typing: 'is typing…',
    contactTitle: 'Leave your contact details',
    contactHint: 'Email or phone number, whichever you prefer.',
    email: 'Email',
    phone: 'Phone',
    contactSubmit: 'Send details',
    contactInvalid: 'Please enter a valid email address or phone number.',
    ended: 'This chat has ended.',
    newChat: 'Start a new chat',
    retry: 'Try again',
    connecting: 'Connecting…',
    reconnecting: 'Connection lost, reconnecting…',
    failed: 'The chat is not available right now. Please try again later.',
    verifying: 'Checking that you are human…',
    uploading: 'Uploading',
    uploadFailed: 'Upload failed',
    fileTooLarge: 'Files can be at most 10 MB.',
    fileType: 'Only images (JPG, PNG, GIF, WebP), PDF and text files can be sent.',
  };
  const ALLOWED_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'];
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const MAX_MESSAGE_LENGTH = 1000;
  const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 20000];
  const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
  const PHONE = /^\+?[\d\s()./-]{6,30}$/;
  const URL_PATTERN = /https?:\/\/[^\s<>"']+/g;

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  const script = document.currentScript;
  const dataset = (script && script.dataset) || {};
  const options = window.CHAT_CONFIG || {};
  const scriptOrigin = script && script.src ? new URL(script.src, location.href).origin : '';
  const config = {
    serviceUrl: String(options.serviceUrl || dataset.serviceUrl || scriptOrigin).replace(/\/+$/, ''),
    turnstileSiteKey: options.turnstileSiteKey || dataset.turnstileSiteKey || '',
    color: options.color || dataset.color || '#2563eb',
    position: (options.position || dataset.position) === 'left' ? 'left' : 'right',
  };
  const texts = Object.assign({}, DEFAULT_TEXTS, options.texts || {});
  if (dataset.title) texts.title = dataset.title;
  if (dataset.subtitle) texts.subtitle = dataset.subtitle;
  const SESSION_KEY = `free-live-chat:${config.serviceUrl}`;
  const OPEN_KEY = `${SESSION_KEY}:open`;

  const storage = {
    get(area, key) {
      try {
        return window[area].getItem(key);
      } catch {
        return null; // storage disabled
      }
    },
    set(area, key, value) {
      try {
        if (value === null) window[area].removeItem(key);
        else window[area].setItem(key, value);
      } catch {
        // storage disabled: the chat still works, it just does not survive a reload
      }
    },
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  const state = {
    open: false,
    sessionId: null,
    wsUrl: null,
    ws: null,
    status: 'idle', // idle | connecting | active | answered | escalated | ended | error
    endMessage: '',
    messages: [], // { id, role, content, timestamp, staffName, attachments, pending, clientId }
    uploads: [], // { id, name }
    notice: '',
    error: '',
    typing: '',
    unread: 0,
    starting: false,
    contactSending: false,
    reconnectAttempts: 0,
    timers: {},
  };

  // ---------------------------------------------------------------------------
  // DOM (inside a shadow root, so the host page's CSS cannot break the widget)
  // ---------------------------------------------------------------------------

  const host = document.createElement('div');
  host.id = 'free-live-chat';
  host.style.setProperty('--flc-accent', config.color);
  const root = host.attachShadow({ mode: 'open' });
  // Turnstile renders into the page's DOM; a slot shows it inside the chat panel
  const turnstileHost = document.createElement('div');
  turnstileHost.slot = 'turnstile';
  host.append(turnstileHost);

  const css = `
    :host { all: initial; --flc-bg: #ffffff; --flc-soft: #f4f5f7; --flc-fg: #1f2328; --flc-muted: #636c76;
      --flc-border: #d8dee4; --flc-bubble: #ffffff; --flc-bot: #fff8e6; --flc-error-bg: #ffebe9; --flc-error: #a40e26; }
    @media (prefers-color-scheme: dark) {
      :host { --flc-bg: #1c2128; --flc-soft: #22272e; --flc-fg: #e6edf3; --flc-muted: #9198a1;
        --flc-border: #3d444d; --flc-bubble: #2d333b; --flc-bot: #3a3326; --flc-error-bg: #4c1d24; --flc-error: #ffb3b8; }
    }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    button, input, textarea { font: inherit; color: inherit; }
    button { cursor: pointer; }
    button:focus-visible, input:focus-visible, textarea:focus-visible, a:focus-visible { outline: 2px solid var(--flc-accent); outline-offset: 2px; }
    .launcher { position: fixed; bottom: 20px; right: 20px; width: 58px; height: 58px; border: 0; border-radius: 50%;
      background: var(--flc-accent); color: #fff; font-size: 26px; line-height: 1; box-shadow: 0 6px 20px rgba(0,0,0,.25);
      z-index: 2147483000; transition: transform .15s ease; }
    .launcher:hover { transform: scale(1.06); }
    .badge { position: absolute; top: -3px; right: -3px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px;
      background: #d1242f; color: #fff; font-size: 12px; font-weight: 700; line-height: 20px; }
    .panel { position: fixed; bottom: 92px; right: 20px; width: 370px; height: min(620px, calc(100vh - 112px));
      display: flex; flex-direction: column; overflow: hidden; border-radius: 16px; background: var(--flc-bg); color: var(--flc-fg);
      box-shadow: 0 12px 40px rgba(0,0,0,.25); z-index: 2147483000; font-size: 14px; line-height: 1.45; }
    .left .launcher, .left .panel { right: auto; left: 20px; }
    [hidden] { display: none !important; }
    header { display: flex; align-items: flex-start; gap: 12px; padding: 14px 16px; background: var(--flc-accent); color: #fff; }
    header .titles { flex: 1; min-width: 0; }
    header h2 { margin: 0; font-size: 16px; font-weight: 600; }
    header p { margin: 2px 0 0; font-size: 13px; opacity: .9; }
    .close { border: 0; background: transparent; font-size: 24px; line-height: 1; padding: 0 4px; color: #fff; }
    .log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; background: var(--flc-soft); }
    .intro { align-self: center; text-align: center; color: var(--flc-muted); margin: 8px 0 4px; }
    .msg { max-width: 82%; padding: 8px 12px; border-radius: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .msg.customer { align-self: flex-end; background: var(--flc-accent); color: #fff; border-bottom-right-radius: 4px; }
    .msg.staff, .msg.bot { align-self: flex-start; background: var(--flc-bubble); border: 1px solid var(--flc-border); border-bottom-left-radius: 4px; }
    .msg.bot { background: var(--flc-bot); }
    .msg.pending { opacity: .6; }
    .msg a { color: inherit; text-decoration: underline; }
    .name { font-size: 12px; font-weight: 600; margin-bottom: 2px; opacity: .85; }
    .time { font-size: 11px; opacity: .65; margin-top: 3px; text-align: right; }
    .file { display: block; margin-top: 4px; }
    .file img { display: block; max-width: 100%; max-height: 220px; border-radius: 8px; margin-top: 2px; }
    .notice { align-self: center; color: var(--flc-muted); font-size: 13px; text-align: center; padding: 2px 8px; }
    .error { margin: 0 12px 8px; padding: 8px 12px; border-radius: 8px; background: var(--flc-error-bg); color: var(--flc-error); font-size: 13px; }
    .typing { align-self: flex-start; color: var(--flc-muted); font-size: 13px; font-style: italic; }
    .card { align-self: stretch; padding: 12px; border-radius: 12px; background: var(--flc-bg); border: 1px solid var(--flc-border); }
    .card h3 { margin: 0 0 4px; font-size: 14px; }
    .card p { margin: 0 0 8px; color: var(--flc-muted); font-size: 13px; }
    .card label { display: block; font-size: 12px; color: var(--flc-muted); margin: 6px 0 2px; }
    .card input { width: 100%; padding: 8px 10px; border: 1px solid var(--flc-border); border-radius: 8px; background: var(--flc-bg); }
    .primary { margin-top: 10px; width: 100%; padding: 9px 12px; border: 0; border-radius: 8px; background: var(--flc-accent); color: #fff; font-weight: 600; }
    .primary:disabled, .send:disabled { opacity: .5; cursor: default; }
    .composer { display: flex; align-items: flex-end; gap: 6px; padding: 10px; border-top: 1px solid var(--flc-border); background: var(--flc-bg); }
    .composer textarea { flex: 1; min-height: 38px; max-height: 120px; resize: none; padding: 8px 10px; border: 1px solid var(--flc-border);
      border-radius: 10px; background: var(--flc-bg); }
    .attach { border: 0; background: transparent; font-size: 20px; padding: 6px; }
    .send { border: 0; border-radius: 10px; padding: 8px 14px; background: var(--flc-accent); color: #fff; font-weight: 600; }
    .turnstile { display: flex; justify-content: center; }
    @media (max-width: 480px) {
      .panel, .left .panel { inset: 0; width: 100%; height: 100%; border-radius: 0; }
    }
  `;

  function el(tag, props, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of [].concat(children || [])) if (child) node.append(child);
    return node;
  }

  const ui = {};
  ui.badge = el('span', { class: 'badge', hidden: true });
  ui.launcher = el('button', { class: 'launcher', type: 'button', 'aria-label': texts.open, 'aria-expanded': 'false', onclick: () => toggle() }, [
    el('span', { 'aria-hidden': 'true', text: '💬' }),
    ui.badge,
  ]);
  ui.log = el('div', { class: 'log', role: 'log', 'aria-live': 'polite' });
  ui.error = el('div', { class: 'error', role: 'alert', hidden: true });
  ui.input = el('textarea', {
    rows: 1,
    maxlength: MAX_MESSAGE_LENGTH,
    placeholder: texts.placeholder,
    'aria-label': texts.placeholder,
    oninput: () => autosize(),
    onkeydown: (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendMessage();
      }
    },
  });
  ui.fileInput = el('input', {
    type: 'file',
    accept: ALLOWED_TYPES.join(','),
    hidden: true,
    onchange: () => {
      for (const file of ui.fileInput.files) uploadFile(file);
      ui.fileInput.value = '';
    },
  });
  ui.send = el('button', { class: 'send', type: 'button', text: texts.send, onclick: () => sendMessage() });
  ui.composer = el('div', { class: 'composer' }, [
    el('button', { class: 'attach', type: 'button', 'aria-label': texts.attach, title: texts.attach, text: '📎', onclick: () => ui.fileInput.click() }),
    ui.fileInput,
    ui.input,
    ui.send,
  ]);
  ui.panel = el(
    'div',
    {
      class: 'panel',
      role: 'dialog',
      'aria-label': texts.title,
      hidden: true,
      ondragover: (event) => event.preventDefault(),
      ondrop: (event) => {
        event.preventDefault();
        if (state.sessionId && state.status !== 'ended') for (const file of event.dataTransfer.files) uploadFile(file);
      },
    },
    [
      el('header', {}, [
        el('div', { class: 'titles' }, [el('h2', { text: texts.title }), el('p', { text: texts.subtitle })]),
        el('button', { class: 'close', type: 'button', 'aria-label': texts.close, text: '×', onclick: () => toggle(false) }),
      ]),
      ui.log,
      el('div', { class: 'turnstile' }, [el('slot', { name: 'turnstile' })]),
      ui.error,
      ui.composer,
    ]
  );
  const wrapper = el('div', { class: config.position }, [ui.launcher, ui.panel]);

  if ('adoptedStyleSheets' in root && typeof CSSStyleSheet === 'function' && 'replaceSync' in CSSStyleSheet.prototype) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } else {
    root.append(el('style', { text: css }));
  }
  root.append(wrapper);
  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.open) toggle(false);
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
  const messageNodes = new Map();

  /** Text with clickable http(s) links. Everything is a text node, never HTML. */
  function linkify(text) {
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of text.matchAll(URL_PATTERN)) {
      let url = match[0];
      const trailing = /[.,;:!?)\]]+$/.exec(url);
      if (trailing) url = url.slice(0, -trailing[0].length);
      fragment.append(text.slice(last, match.index));
      fragment.append(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow', text: url }));
      last = match.index + url.length;
    }
    fragment.append(text.slice(last));
    return fragment;
  }

  function formatSize(bytes) {
    return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function attachmentNode(file) {
    if (!file || typeof file.url !== 'string' || !file.url.startsWith('/file/')) return null;
    const href = config.serviceUrl + file.url;
    const label = `${file.name} (${formatSize(file.size || 0)})`;
    const preview = /^image\//.test(file.mimeType) ? el('img', { src: href, alt: file.name, loading: 'lazy' }) : null;
    return el('a', { class: 'file', href, target: '_blank', rel: 'noopener noreferrer', download: file.name }, [
      preview,
      el('span', { text: preview ? '' : `📄 ${label}` }),
    ]);
  }

  function messageNode(message) {
    const key = `${message.id}:${message.pending ? 1 : 0}`;
    if (messageNodes.has(key)) return messageNodes.get(key);
    const role = ['customer', 'staff', 'bot'].includes(message.role) ? message.role : 'staff';
    const name = role === 'staff' ? message.staffName || texts.team : role === 'bot' ? texts.bot : '';
    const node = el('div', { class: `msg ${role}${message.pending ? ' pending' : ''}` }, [
      name ? el('div', { class: 'name', text: name }) : null,
      message.content ? el('div', {}, [linkify(String(message.content))]) : null,
      ...(Array.isArray(message.attachments) ? message.attachments.map(attachmentNode) : []),
      el('div', { class: 'time', text: timeFormat.format(new Date(message.timestamp || Date.now())) }),
    ]);
    messageNodes.set(key, node);
    return node;
  }

  function contactForm() {
    const email = el('input', { type: 'email', name: 'email', autocomplete: 'email', maxlength: 254 });
    const phone = el('input', { type: 'tel', name: 'phone', autocomplete: 'tel', maxlength: 30 });
    const submit = el('button', { class: 'primary', type: 'submit', text: texts.contactSubmit, disabled: state.contactSending });
    ui.contactSubmit = submit;
    return el(
      'form',
      {
        class: 'card',
        onsubmit: (event) => {
          event.preventDefault();
          const values = { email: email.value.trim(), phone: phone.value.trim() };
          const emailOk = EMAIL.test(values.email);
          const phoneOk = PHONE.test(values.phone);
          if ((values.email && !emailOk) || (values.phone && !phoneOk) || (!emailOk && !phoneOk)) {
            showError(texts.contactInvalid);
            return;
          }
          if (!send({ type: 'email', email: values.email || undefined, phone: values.phone || undefined })) return;
          state.contactSending = true;
          submit.disabled = true;
        },
      },
      [
        el('h3', { text: texts.contactTitle }),
        el('p', { text: texts.contactHint }),
        el('label', {}, [texts.email, email]),
        el('label', {}, [texts.phone, phone]),
        submit,
      ]
    );
  }

  let contactNode = null;

  function render() {
    const nearBottom = ui.log.scrollHeight - ui.log.scrollTop - ui.log.clientHeight < 80;
    const children = [el('div', { class: 'intro', text: texts.welcome })];
    for (const message of state.messages) children.push(messageNode(message));
    for (const upload of state.uploads) children.push(el('div', { class: 'msg customer pending', text: `${texts.uploading} ${upload.name}…` }));
    if (state.typing) children.push(el('div', { class: 'typing', text: `${state.typing} ${texts.typing}` }));
    if (state.status === 'escalated') {
      contactNode = contactNode || contactForm();
      children.push(contactNode);
    } else {
      contactNode = null;
    }
    if (state.status === 'ended') {
      children.push(
        el('div', { class: 'card' }, [
          el('p', { text: state.endMessage || texts.ended }),
          el('button', { class: 'primary', type: 'button', text: texts.newChat, onclick: () => restart() }),
        ])
      );
    } else if (state.status === 'error') {
      children.push(
        el('div', { class: 'card' }, [
          el('p', { text: texts.failed }),
          el('button', { class: 'primary', type: 'button', text: texts.retry, onclick: () => startSession() }),
        ])
      );
    } else if (state.notice) {
      children.push(el('div', { class: 'notice', text: state.notice }));
    }
    ui.log.replaceChildren(...children);
    if (nearBottom) ui.log.scrollTop = ui.log.scrollHeight;

    const connected = !!state.ws && state.ws.readyState === WebSocket.OPEN;
    ui.composer.hidden = state.status === 'ended' || state.status === 'error';
    ui.send.disabled = !connected;
    ui.badge.hidden = state.unread === 0;
    ui.badge.textContent = state.unread > 9 ? '9+' : String(state.unread);
  }

  function setNotice(text) {
    state.notice = text;
    render();
  }

  function showError(text) {
    ui.error.textContent = text;
    ui.error.hidden = false;
    clearTimeout(state.timers.error);
    state.timers.error = setTimeout(() => {
      ui.error.hidden = true;
    }, 6000);
  }

  function autosize() {
    ui.input.style.height = 'auto';
    ui.input.style.height = `${Math.min(ui.input.scrollHeight, 120)}px`;
  }

  // ---------------------------------------------------------------------------
  // Server communication
  // ---------------------------------------------------------------------------

  function visitorInfo() {
    let referrer = '';
    try {
      referrer = document.referrer ? new URL(document.referrer).origin : '';
    } catch {
      // ignore
    }
    return {
      userAgent: navigator.userAgent,
      language: navigator.language,
      // Without query string and hash: they can contain tokens or personal data
      pageUrl: location.origin + location.pathname,
      pageTitle: document.title,
      referrer,
      screenWidth: screen.width,
      screenHeight: screen.height,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  async function post(path, body) {
    const isForm = body instanceof FormData;
    const response = await fetch(config.serviceUrl + path, {
      method: 'POST',
      headers: isForm ? undefined : { 'Content-Type': 'application/json' },
      body: isForm ? body : JSON.stringify(body),
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      // not JSON
    }
    return { ok: response.ok, status: response.status, data };
  }

  let turnstileScript = null;
  function loadTurnstile() {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    turnstileScript =
      turnstileScript ||
      new Promise((resolve, reject) => {
        // No integrity hash: Cloudflare updates api.js in place and requires loading it from this exact URL
        const tag = document.createElement('script');
        tag.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        tag.onload = () => resolve(window.turnstile);
        tag.onerror = () => {
          turnstileScript = null;
          reject(new Error('Could not load Turnstile'));
        };
        document.head.append(tag);
      });
    return turnstileScript;
  }

  async function turnstileToken() {
    if (!config.turnstileSiteKey) {
      throw new Error('This chat needs a Turnstile site key: add data-turnstile-site-key to the script tag.');
    }
    setNotice(texts.verifying);
    const turnstile = await loadTurnstile();
    return new Promise((resolve, reject) => {
      const container = document.createElement('div');
      turnstileHost.replaceChildren(container);
      const finish = (callback, value) => {
        setTimeout(() => {
          try {
            turnstile.remove(widgetId);
          } catch {
            // already removed
          }
          turnstileHost.replaceChildren();
        });
        callback(value);
      };
      const widgetId = turnstile.render(container, {
        sitekey: config.turnstileSiteKey,
        appearance: 'interaction-only',
        callback: (token) => finish(resolve, token),
        'error-callback': () => finish(reject, new Error('Turnstile check failed')),
        'timeout-callback': () => finish(reject, new Error('Turnstile check timed out')),
      });
    });
  }

  async function startSession() {
    if (state.starting) return;
    state.starting = true;
    state.status = 'connecting';
    setNotice(texts.connecting);
    try {
      const stored = storage.get('localStorage', SESSION_KEY);
      let result = null;
      if (stored) {
        result = await post('/start', { sessionId: stored, visitor: visitorInfo() });
        // Expired or ended chats are replaced by a new one, which needs a fresh Turnstile token
        if (!result.ok && result.status === 400 && /turnstile/i.test(result.data.error || '')) result = null;
      }
      if (!result) {
        storage.set('localStorage', SESSION_KEY, null);
        const token = config.turnstileSiteKey ? await turnstileToken() : undefined;
        result = await post('/start', { visitor: visitorInfo(), turnstile_token: token });
      }
      if (!result.ok) throw new Error(result.data.error || `HTTP ${result.status}`);

      if (result.data.sessionId !== state.sessionId) {
        state.messages = [];
        messageNodes.clear();
      }
      state.sessionId = result.data.sessionId;
      storage.set('localStorage', SESSION_KEY, state.sessionId);
      connect(result.data.wsUrl);
    } catch (error) {
      console.error('[live chat]', error);
      state.status = 'error';
      setNotice('');
    } finally {
      state.starting = false;
    }
  }

  function connect(wsUrl) {
    if (wsUrl) state.wsUrl = wsUrl;
    disconnect();
    const ws = new WebSocket(state.wsUrl);
    state.ws = ws;
    ws.addEventListener('open', () => {
      if (state.ws !== ws) return;
      state.reconnectAttempts = 0;
      state.notice = '';
      clearInterval(state.timers.ping);
      // Keeps proxies from closing an idle connection; the server answers without waking up
      state.timers.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 25000);
      render();
    });
    ws.addEventListener('message', (event) => {
      if (state.ws !== ws || event.data === 'pong') return;
      try {
        handleServerMessage(JSON.parse(event.data));
      } catch (error) {
        console.error('[live chat] Bad message', error);
      }
    });
    ws.addEventListener('close', () => {
      if (state.ws !== ws) return;
      clearInterval(state.timers.ping);
      state.ws = null;
      if (state.status !== 'ended' && state.status !== 'error') scheduleReconnect();
      render();
    });
  }

  function disconnect() {
    clearInterval(state.timers.ping);
    clearTimeout(state.timers.reconnect);
    const ws = state.ws;
    state.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close();
  }

  function scheduleReconnect() {
    const attempt = state.reconnectAttempts++;
    state.notice = texts.reconnecting;
    const delay = RECONNECT_DELAYS[Math.min(attempt, RECONNECT_DELAYS.length - 1)];
    // After a few failures the chat may have expired: ask the server again (it resumes or starts a new one)
    state.timers.reconnect = setTimeout(() => (attempt >= 2 ? startSession() : connect()), delay);
  }

  function send(payload) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
      showError(texts.reconnecting);
      return false;
    }
    state.ws.send(JSON.stringify(payload));
    return true;
  }

  function handleServerMessage(message) {
    const payload = message.payload || {};
    switch (message.type) {
      case 'status': {
        if (Array.isArray(payload.messages)) {
          // The server's list is complete; resend messages it never received (lost during a reconnect)
          const pending = state.messages.filter((m) => m.pending);
          state.messages = payload.messages.slice();
          for (const local of pending) {
            const arrived = state.messages.some((m) => m.role === 'customer' && m.content === local.content);
            if (!arrived && send({ type: 'message', content: local.content, clientId: local.clientId })) state.messages.push(local);
          }
        }
        if (payload.status) setStatus(payload.status, payload.message);
        break;
      }
      case 'message':
        if (!state.messages.some((m) => m.id === payload.id)) state.messages.push(payload);
        if (payload.role !== 'customer') {
          state.typing = '';
          if (!state.open) state.unread++;
        }
        break;
      case 'message_ack': {
        const local = state.messages.find((m) => m.pending && m.clientId === payload.clientId);
        if (local) {
          local.id = payload.id;
          local.pending = false;
        }
        break;
      }
      case 'typing':
        state.typing = payload.name || texts.bot;
        clearTimeout(state.timers.typing);
        state.timers.typing = setTimeout(() => {
          state.typing = '';
          render();
        }, 20000);
        break;
      case 'error':
        state.contactSending = false;
        if (ui.contactSubmit) ui.contactSubmit.disabled = false;
        showError(payload.message || texts.failed);
        break;
    }
    render();
  }

  function setStatus(status, endMessage) {
    state.status = status;
    if (status === 'ended') {
      state.endMessage = endMessage || state.endMessage;
      state.contactSending = false;
      storage.set('localStorage', SESSION_KEY, null);
    }
  }

  // ---------------------------------------------------------------------------
  // Visitor actions
  // ---------------------------------------------------------------------------

  function sendMessage() {
    const content = ui.input.value.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!content) return;
    const clientId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (!send({ type: 'message', content, clientId })) return;
    state.messages.push({ id: clientId, clientId, role: 'customer', content, timestamp: Date.now(), pending: true });
    ui.input.value = '';
    autosize();
    render();
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  async function uploadFile(file) {
    if (!ALLOWED_TYPES.includes(file.type)) return showError(texts.fileType);
    if (file.size > MAX_FILE_SIZE) return showError(texts.fileTooLarge);
    if (!state.sessionId) return;
    const upload = { id: Math.random().toString(36).slice(2), name: file.name };
    state.uploads.push(upload);
    render();
    try {
      const reservation = await post('/upload/start', {
        sessionId: state.sessionId,
        filename: file.name,
        mimeType: file.type,
        size: file.size,
      });
      if (!reservation.ok) throw new Error(reservation.data.error || `HTTP ${reservation.status}`);
      const form = new FormData();
      form.append('file', file);
      form.append('fileId', reservation.data.fileId);
      form.append('sessionId', state.sessionId);
      const result = await post('/upload/complete', form);
      if (!result.ok) throw new Error(result.data.error || `HTTP ${result.status}`);
      // The file shows up as a message from the server
    } catch (error) {
      showError(`${texts.uploadFailed}: ${error.message}`);
    } finally {
      state.uploads = state.uploads.filter((u) => u !== upload);
      render();
    }
  }

  function restart() {
    disconnect();
    storage.set('localStorage', SESSION_KEY, null);
    Object.assign(state, { sessionId: null, wsUrl: null, messages: [], status: 'idle', endMessage: '', typing: '' });
    messageNodes.clear();
    startSession();
  }

  function toggle(open = !state.open) {
    state.open = open;
    ui.panel.hidden = !open;
    ui.launcher.setAttribute('aria-expanded', String(open));
    storage.set('sessionStorage', OPEN_KEY, open ? '1' : null);
    if (open) {
      state.unread = 0;
      if (state.status === 'idle' || state.status === 'error') startSession();
      render();
      setTimeout(() => ui.input.focus(), 0);
    } else {
      render();
      ui.launcher.focus();
    }
  }

  window.FreeLiveChat = {
    open: () => toggle(true),
    close: () => toggle(false),
    toggle: () => toggle(),
  };

  function mount() {
    document.body.append(host);
    render();
    // Stay open across page navigation within the same tab
    if (storage.get('sessionStorage', OPEN_KEY)) toggle(true);
  }

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
