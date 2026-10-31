// Live updates for signed-in users, without reloading the page:
// - unread counters in the menu, and a pop-up when a new notification arrives;
// - lists marked data-live-refresh (notifications, conversations, queues) refresh themselves;
// - in an open conversation: new messages, read receipts, "typing…", and sending without a reload.
// The server is asked every few seconds (see src/routes/live.js): serverless hosting cannot keep
// WebSocket connections open. Requests carry "X-Live: 1" so they do not count as user activity
// and an unattended screen is still signed out after the idle timeout.
document.addEventListener('DOMContentLoaded', () => {
  const body = document.body;
  if (!body.dataset.live) return;

  const VISIBLE_MS = 5000;   // how often to ask while the page is on screen
  const THREAD_MS = 2500;    // ...and while a conversation is open
  const HIDDEN_MS = 30000;   // ...and while the tab is in the background
  const TYPING_EVERY_MS = 2500;
  const TYPING_IDLE_MS = 4000;
  const PHOTO_MAX_SIDE = 1600; // photos are shrunk to at most this many pixels wide or high before sending

  const thread = document.querySelector('[data-thread]');
  const form = document.querySelector('[data-message-form]');
  const textarea = form ? form.querySelector('textarea') : null;
  const csrf = form ? form.querySelector('input[name=_csrf]').value : '';
  let since = Number(body.dataset.liveSince) || 0;
  let lastId = thread ? Number(thread.dataset.lastId) || 0 : 0;
  let counts = null;
  let pendingRefresh = false;
  let failures = 0;
  let timer = null;
  let stopped = false;
  let polling = false; // one request at a time, so a notification is never announced twice
  const baseTitle = document.title.replace(/^\(\d+\) /, '');

  const visible = () => document.visibilityState === 'visible';
  const liveHeaders = { 'X-Live': '1', Accept: 'application/json' };
  const loginPath = body.dataset.live.replace(/\/live$/, '/login'); // '/live' -> '/login', '/admin/live' -> '/admin/login'

  /** Did the server answer that the session has ended (idle timeout, signed out elsewhere)? */
  const isSignedOut = (res) => res.status === 401 || (res.redirected && new URL(res.url).pathname === loginPath);

  /** The session ended: reload, which shows the sign-in page and returns here after signing in. */
  function signedOut() {
    stopped = true;
    clearTimeout(timer);
    window.location.reload();
  }

  // ---- Counters and pop-ups ----

  /** Restart a one-off CSS animation (the bell ringing, a counter popping); see the Icons section of style.css. */
  function replay(el, className) {
    el.classList.remove(className);
    void el.offsetWidth; // let the browser notice the removal, so adding the class again restarts the animation
    el.classList.add(className);
  }

  function setBadges(data) {
    const values = { notifications: data.unreadNotifications, messages: data.unreadMessages };
    document.querySelectorAll('[data-badge]').forEach((el) => {
      const n = values[el.dataset.badge] || 0;
      const grew = n > (Number(el.textContent) || 0) || (el.hidden && n > 0);
      el.textContent = String(n);
      el.hidden = n === 0;
      if (grew) {
        replay(el, 'pop');
        const bell = el.closest('.icon-link');
        if (bell) replay(bell, 'ring');
      }
    });
    document.title = data.unreadNotifications ? `(${data.unreadNotifications}) ${baseTitle}` : baseTitle;
  }

  // Unread notifications waiting when the page opens: ring the bell once to draw the eye.
  document.querySelectorAll('.icon-link [data-badge="notifications"]:not([hidden])').forEach((el) => {
    replay(el.closest('.icon-link'), 'ring');
  });

  let toastBox = null;
  function toast(n) {
    if (!toastBox) {
      toastBox = document.createElement('div');
      toastBox.className = 'live-toasts';
      toastBox.setAttribute('aria-live', 'polite');
      body.appendChild(toastBox);
    }
    const item = document.createElement('div');
    item.className = 'live-toast';
    const link = document.createElement('a');
    link.href = n.url;
    const icon = document.createElement('i');
    icon.className = 'fa-regular fa-bell';
    icon.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = n.title;
    const detail = document.createElement('small');
    detail.textContent = n.body;
    text.append(title, detail);
    link.append(icon, text);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'live-toast-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
    close.addEventListener('click', () => item.remove());
    item.append(link, close);
    toastBox.prepend(item);
    while (toastBox.children.length > 3) toastBox.lastElementChild.remove();
    setTimeout(() => item.remove(), 10000);
  }

  /** Reload the parts of the page marked data-live-refresh from the server, keeping the rest. */
  async function refreshRegions() {
    const regions = [...document.querySelectorAll('[data-live-refresh][id]')];
    if (!regions.length) return;
    // Wait while the user is in the middle of something inside a list (typing in a field, a busy button). A link
    // that merely kept focus after being tapped does not count.
    const typingIn = (r) => r.contains(document.activeElement) && document.activeElement.matches('input, textarea, select');
    if (!visible() || regions.some((r) => typingIn(r) || r.querySelector('.is-loading'))) {
      pendingRefresh = true;
      return;
    }
    const res = await fetch(window.location.href, { headers: { 'X-Live': '1' }, credentials: 'same-origin' });
    if (isSignedOut(res)) return signedOut();
    if (!res.ok) throw new Error(`HTTP ${res.status}`); // tried again on the next round
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    pendingRefresh = false;
    if (regions.some((r) => !doc.getElementById(r.id))) return; // the page no longer has these lists
    regions.forEach((r) => {
      const fresh = document.importNode(doc.getElementById(r.id), true);
      r.replaceWith(fresh);
      document.dispatchEvent(new CustomEvent('content:replaced', { detail: fresh })); // see app.js
    });
  }

  // ---- Conversation ----

  function nearBottom() {
    return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 80;
  }

  // Whether the newest message is in view, kept up to date as the user scrolls. When the conversation changes
  // size (a photo finishes loading, the keyboard opens) it then stays on the newest message, unless the user
  // had scrolled up to read older ones.
  let pinned = true;
  const keepPinned = thread && window.ResizeObserver
    ? new ResizeObserver(() => { if (pinned) thread.scrollTop = thread.scrollHeight; })
    : null;
  if (thread) {
    // Only scrolling up means the user left the newest message; content growing above (photos loading)
    // also fires scroll events but does not move the position up.
    let lastTop = thread.scrollTop;
    thread.addEventListener('scroll', () => {
      if (thread.scrollTop < lastTop - 2) pinned = nearBottom();
      else if (nearBottom()) pinned = true;
      lastTop = thread.scrollTop;
    }, { passive: true });
    thread.scrollTop = thread.scrollHeight;
    if (keepPinned) {
      keepPinned.observe(thread);
      thread.querySelectorAll('.msg-photo img').forEach((img) => keepPinned.observe(img));
    }
  }

  function addMessage(m) {
    if (thread.querySelector(`.msg[data-id="${m.id}"]`)) return false;
    const empty = thread.querySelector('[data-thread-empty]');
    if (empty) empty.remove();
    const el = document.createElement('div');
    el.className = m.mine ? 'msg mine' : 'msg';
    el.dataset.id = String(m.id);
    if (m.image) {
      const link = document.createElement('a');
      link.className = 'msg-photo';
      link.href = m.image;
      link.target = '_blank';
      link.rel = 'noopener';
      const img = document.createElement('img');
      img.alt = 'Photo';
      if (m.mine) pinned = true; // the user's own photo: show it once it has loaded
      if (keepPinned) keepPinned.observe(img); // it takes its height only once loaded
      img.src = m.image;
      link.appendChild(img);
      el.appendChild(link);
    }
    if (m.body) {
      const text = document.createElement('span');
      text.className = 'body';
      text.textContent = m.body;
      el.appendChild(text);
    }
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = m.when;
    if (m.mine) {
      const read = document.createElement('span');
      read.dataset.read = '';
      read.textContent = ' · read';
      read.hidden = !m.read;
      meta.appendChild(read);
    }
    el.appendChild(meta);
    const latest = thread.querySelector('#latest');
    if (latest) latest.removeAttribute('id');
    el.id = 'latest';
    // Keep messages in order even if a reply and our own send cross.
    const later = [...thread.querySelectorAll('.msg[data-id]')].find((x) => Number(x.dataset.id) > m.id);
    thread.insertBefore(el, later || null);
    lastId = Math.max(lastId, m.id);
    return true;
  }

  function showReadUpTo(id) {
    thread.querySelectorAll('.msg.mine[data-id]').forEach((el) => {
      const mark = el.querySelector('[data-read]');
      if (mark && Number(el.dataset.id) <= id) mark.hidden = false;
    });
  }

  function applyThread(t) {
    const stick = nearBottom();
    let added = false;
    t.messages.forEach((m) => { added = addMessage(m) || added; });
    showReadUpTo(t.lastReadId);
    const typing = document.querySelector('[data-typing]');
    if (typing) typing.hidden = !t.typing;
    showCall(t.call);
    if (added && stick) thread.scrollTop = thread.scrollHeight;
  }

  /** The banner for a call the doctor started: Join (patient) or Rejoin / End (doctor); hidden once it ends. */
  function showCall(call) {
    const banner = document.querySelector('[data-call-banner]');
    if (!banner) return;
    banner.hidden = !call;
    if (!call) return;
    banner.querySelector('[data-call-text]').textContent = call.label;
    const join = banner.querySelector('[data-call-join]');
    join.href = call.url;
    join.querySelector('i').className = `fa-solid ${call.mode === 'audio' ? 'fa-phone' : 'fa-video'}`;
    const end = banner.querySelector('[data-call-end]');
    if (end) end.action = call.endUrl;
  }

  // Typing indicator: tell the server while the user types, and once when they stop.
  let typingSentAt = 0;
  let typingIdle = null;
  function sendTyping(on) {
    typingSentAt = on ? Date.now() : 0;
    fetch(`${thread.dataset.thread}/typing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ _csrf: csrf, typing: on ? '1' : '0' }),
      credentials: 'same-origin',
    }).catch(() => {});
  }

  if (thread && form && textarea) {
    // The message box grows with what is typed, up to the height limit in the CSS.
    // Anything that makes the message area smaller keeps the newest message in view if it was.
    const keepBottom = (change) => {
      const stick = nearBottom();
      change();
      if (stick) thread.scrollTop = thread.scrollHeight;
    };
    const fit = () => keepBottom(() => {
      textarea.style.height = 'auto';
      textarea.style.height = `${textarea.scrollHeight + 2}px`;
    });
    textarea.addEventListener('input', fit);

    textarea.addEventListener('input', () => {
      clearTimeout(typingIdle);
      if (!textarea.value.trim()) {
        if (typingSentAt) sendTyping(false);
        return;
      }
      if (Date.now() - typingSentAt > TYPING_EVERY_MS) sendTyping(true);
      typingIdle = setTimeout(() => { if (typingSentAt) sendTyping(false); }, TYPING_IDLE_MS);
    });

    // Ctrl+Enter (Cmd+Enter on a Mac) sends.
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    const errorBox = form.querySelector('[data-message-error]');
    const button = form.querySelector('button[type=submit]');
    const showError = (message) => {
      errorBox.textContent = message;
      errorBox.hidden = !message;
    };

    // Photos: shrunk in the browser (phone photos are often several megabytes) and sent with the message.
    const photoButton = form.querySelector('[data-photo-button]');
    const photoInput = form.querySelector('[data-photo-input]');
    const preview = form.querySelector('[data-photo-preview]');
    let photo = null; // data URL of the photo to send
    const setPhoto = (dataUrl) => {
      const stick = nearBottom();
      const toBottom = () => { if (stick) thread.scrollTop = thread.scrollHeight; };
      photo = dataUrl;
      preview.hidden = !photo;
      const img = preview.querySelector('img');
      img.onload = toBottom; // the preview takes its height once the picture has loaded
      img.src = photo || '';
      textarea.required = !photo; // a photo may be sent without text
      toBottom();
    };
    // Any kind of picture can be chosen: whatever the browser can open itself (JPEG, PNG, GIF, WebP, AVIF, BMP,
    // SVG, and HEIC/TIFF in Safari), plus HEIC/HEIF (iPhone and many Android cameras) and TIFF through decoders
    // in public/vendor that are only downloaded when needed. Every picture is sent as a smaller JPEG.
    async function shrink(file) {
      const picture = await openPicture(file);
      const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(picture.width, picture.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(picture.width * scale));
      canvas.height = Math.max(1, Math.round(picture.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // transparent areas would otherwise turn black in a JPEG
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(picture.source, 0, 0, canvas.width, canvas.height);
      if (picture.source.close) picture.source.close();
      return canvas.toDataURL('image/jpeg', 0.82);
    }
    if (photoButton && photoInput && preview) {
      photoButton.hidden = false;
      photoButton.addEventListener('click', () => photoInput.click());
      photoInput.addEventListener('change', async () => {
        const file = photoInput.files[0];
        photoInput.value = '';
        if (!file) return;
        showError('');
        if (!looksLikePicture(file)) return showError('Please choose a picture.');
        photoButton.classList.add('is-loading', 'is-loading-icon'); // opening a large HEIC can take a moment
        try {
          setPhoto(await shrink(file));
          textarea.focus();
        } catch {
          showError('This picture could not be opened. It may be damaged, or in a format this browser cannot read.');
        } finally {
          photoButton.classList.remove('is-loading', 'is-loading-icon');
        }
      });
      form.querySelector('[data-photo-remove]').addEventListener('click', () => setPhoto(null));
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (button.classList.contains('is-loading')) return;
      if (!textarea.value.trim() && !photo) return showError('Type a message or add a photo first.');
      showError('');
      button.classList.add('is-loading');
      button.disabled = true;
      clearTimeout(typingIdle);
      try {
        const res = await fetch(form.action, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrf },
          body: JSON.stringify({ body: textarea.value, image: photo }),
          credentials: 'same-origin',
        });
        if (isSignedOut(res)) return signedOut();
        const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : {};
        if (!res.ok) throw new Error(data.error || 'The message could not be sent. Please try again.');
        typingSentAt = 0;
        textarea.value = '';
        fit();
        setPhoto(null);
        addMessage(data.message);
        thread.scrollTop = thread.scrollHeight;
      } catch (err) {
        showError(err instanceof TypeError ? 'The message could not be sent. Check your connection and try again.' : err.message);
      } finally {
        button.classList.remove('is-loading');
        button.disabled = false;
        textarea.focus();
      }
    });
  }

  // ---- Opening pictures (for photos in messages) ----

  const PICTURE_NAME = /\.(jpe?g|jfif|pjpeg|png|apng|gif|webp|avif|bmp|dib|ico|svg|heic|heif|hif|tiff?)$/i;
  const looksLikePicture = (file) => file.type.startsWith('image/') || PICTURE_NAME.test(file.name);

  /** What the first bytes say the file is (names and types are often missing for HEIC on Windows). */
  function sniff(bytes) {
    const text = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
    if (text(4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(text(8, 12))) return 'heic';
    if ((text(0, 2) === 'II' && bytes[2] === 42) || (text(0, 2) === 'MM' && bytes[3] === 42)) return 'tiff';
    return null;
  }

  const scripts = {};
  /** Load one of the decoders in public/vendor, once. */
  function loadScript(src) {
    scripts[src] ??= new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => { delete scripts[src]; reject(new Error(`Could not load ${src}`)); };
      document.head.appendChild(el);
    });
    return scripts[src];
  }

  /** Raw pixels on a canvas, ready to draw. */
  function pixelsToCanvas(data, width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
    return { source: canvas, width, height };
  }

  async function openHeic(bytes) {
    await loadScript('/static/vendor/libheif/libheif.js');
    let lib = window.libheif();
    if (lib && typeof lib.then === 'function') lib = await lib;
    if (lib && lib.ready) await lib.ready;
    const [image] = new lib.HeifDecoder().decode(bytes);
    if (!image) throw new Error('No picture in this HEIC file');
    const width = image.get_width();
    const height = image.get_height();
    const target = { data: new Uint8ClampedArray(width * height * 4), width, height };
    await new Promise((resolve, reject) => {
      image.display(target, (shown) => (shown ? resolve() : reject(new Error('HEIC decoding failed'))));
    });
    if (image.free) image.free();
    return pixelsToCanvas(target.data, width, height);
  }

  async function openTiff(bytes) {
    await loadScript('/static/vendor/pako/pako_inflate.min.js'); // UTIF uses it for compressed TIFFs
    await loadScript('/static/vendor/utif/UTIF.js');
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const [page] = window.UTIF.decode(buffer);
    if (!page) throw new Error('No picture in this TIFF file');
    window.UTIF.decodeImage(buffer, page);
    return pixelsToCanvas(new Uint8ClampedArray(window.UTIF.toRGBA8(page)), page.width, page.height);
  }

  /** Something drawable for any picture file the browser or the decoders can read. */
  async function openPicture(file) {
    try {
      const bitmap = await createImageBitmap(file);
      return { source: bitmap, width: bitmap.width, height: bitmap.height };
    } catch { /* not a format this browser opens directly; try the other ways */ }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = sniff(bytes) || (/\.(heic|heif|hif)$/i.test(file.name) ? 'heic' : /\.tiff?$/i.test(file.name) ? 'tiff' : null);
    if (kind === 'heic') return openHeic(bytes);
    if (kind === 'tiff') return openTiff(bytes);
    // Some formats (e.g. SVG) open as an image element but not as a bitmap.
    const img = new Image();
    img.src = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    await img.decode();
    return { source: img, width: img.naturalWidth || 1200, height: img.naturalHeight || 1200 };
  }

  // ---- Phone keyboard ----
  // On the messages pages the screen is sized to the area above the keyboard, so opening it shrinks the
  // conversation instead of covering it or pushing the header off screen, and the newest message stays just
  // above the message box (as in WhatsApp). Android Chrome also resizes the page itself (the viewport meta tag);
  // this covers iPhones and other browsers.
  if (body.classList.contains('chat-screen') && window.visualViewport) {
    const vv = window.visualViewport;
    const fitScreen = () => {
      document.documentElement.style.setProperty('--app-height', `${Math.round(vv.height)}px`);
      window.scrollTo(0, 0); // iOS scrolls the page to show the focused box; the layout already does
      if (thread && pinned) thread.scrollTop = thread.scrollHeight;
    };
    vv.addEventListener('resize', fitScreen);
    window.addEventListener('resize', fitScreen); // Android, where the keyboard resizes the window itself
    vv.addEventListener('scroll', () => { if (window.scrollY) window.scrollTo(0, 0); });
    window.addEventListener('load', fitScreen); // after fonts and photos have taken their space
    fitScreen();
    // While typing, small extras give their room to the conversation (.composing in style.css).
    if (textarea) {
      textarea.addEventListener('focus', () => body.classList.add('composing'));
      textarea.addEventListener('blur', () => body.classList.remove('composing'));
    }
  }

  // ---- Polling ----

  async function poll() {
    timer = null;
    if (stopped || polling) return;
    polling = true;
    const params = new URLSearchParams({ since: String(since) });
    let url = `${body.dataset.live}?${params}`;
    if (thread) {
      params.set('after', String(lastId));
      if (visible()) params.set('active', '1');
      url = `${thread.dataset.thread}/updates?${params}`;
    }
    try {
      const res = await fetch(url, { headers: liveHeaders, credentials: 'same-origin' });
      if (isSignedOut(res)) return signedOut();
      if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      failures = 0;

      const fresh = data.notifications.filter((n) => n.id > since).reverse();
      since = Math.max(since, data.lastNotificationId);
      // Skip those already read, e.g. about the conversation open on screen, which shows its messages itself.
      fresh.forEach((n) => { if (!n.read) toast(n); });

      // Something new, or read elsewhere (another tab, another device): the lists on this page are out of date.
      if (fresh.length || (counts && (counts.unreadNotifications !== data.unreadNotifications ||
        counts.unreadMessages !== data.unreadMessages))) pendingRefresh = true;
      counts = data;
      setBadges(data);
      if (data.thread) applyThread(data.thread);
      if (pendingRefresh) await refreshRegions();
    } catch {
      failures++;
    } finally {
      polling = false;
    }
    schedule();
  }

  function schedule() {
    if (stopped) return;
    clearTimeout(timer);
    const base = !visible() ? HIDDEN_MS : thread ? THREAD_MS : VISIBLE_MS;
    // Back off while the server cannot be reached.
    timer = setTimeout(poll, Math.min(base * 2 ** failures, 60000));
  }

  // Opening an unread notification or conversation clears its highlight and tag straight away (the server marks
  // it read as it opens), so it already shows as read when the user comes back to the list.
  document.addEventListener('click', (e) => {
    const item = e.target.closest('a.notice.unread, a.chat-item.unread');
    if (!item) return;
    item.classList.remove('unread');
    item.querySelectorAll('[data-unread-tag]').forEach((tag) => tag.remove());
  });

  // A page brought back by the Back button shows how it was; fetch the current state at once.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && !stopped) {
      pendingRefresh = true;
      clearTimeout(timer);
      poll();
    }
  });

  // Coming back to the tab: catch up at once.
  document.addEventListener('visibilitychange', () => {
    if (visible() && !stopped) {
      clearTimeout(timer);
      poll();
    }
  });
  schedule();
});
