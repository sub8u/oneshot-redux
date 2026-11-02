// OneShot Redux: content script (area selector + optional floating button)
(() => {
  'use strict';

  // If an older copy is running (extension reloaded / re-injected), tear it down first.
  if (window.__oneshotRedux && typeof window.__oneshotRedux.destroy === 'function') {
    try { window.__oneshotRedux.destroy(); } catch (_) { /* old context may be dead */ }
  }
  if (!(document.documentElement instanceof HTMLElement)) return; // skip SVG/XML documents

  const HOST_ID = 'oneshot-redux-host';
  const stale = document.getElementById(HOST_ID);
  if (stale) stale.remove();

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .overlay {
      position: fixed; inset: 0; z-index: 2147483647;
      cursor: crosshair; pointer-events: auto;
      background: rgba(12, 10, 24, 0.22);
      user-select: none; -webkit-user-select: none; touch-action: none;
    }
    .overlay.dragging { background: transparent; }
    .sel {
      position: fixed; display: none; pointer-events: none;
      border: 1.5px solid rgba(255,255,255,0.95);
      border-radius: 2px;
      box-shadow: 0 0 0 99999px rgba(12, 10, 24, 0.38), 0 0 0 1px rgba(0,0,0,0.25) inset;
    }
    .dims {
      position: fixed; display: none; pointer-events: none;
      font: 600 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #fff; background: rgba(20, 18, 32, 0.85);
      padding: 4px 6px; border-radius: 4px; white-space: nowrap;
    }
    .hint {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%);
      z-index: 2147483647; pointer-events: none;
      font: 500 13px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #24221e; background: #f8f6f0;
      padding: 10px 18px; border-radius: 999px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2), 0 10px 30px rgba(0,0,0,0.28);
    }
    .hint b { font-weight: 700; }
    .hint kbd {
      font: 600 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #5f5a51; background: #efebe2; border: 1px solid #e2ddd1; border-bottom-width: 2px;
      border-radius: 4px; padding: 2px 5px; margin: 0 1px;
    }
    .hint.quick { box-shadow: 0 0 0 3px hsl(48, 95%, 62%), 0 10px 30px rgba(0,0,0,0.28); }
    .toast {
      position: fixed; bottom: 24px; left: 50%; transform: translate(-50%, 8px);
      z-index: 2147483647; pointer-events: none; opacity: 0;
      transition: opacity .2s ease, transform .2s ease;
      font: 500 13px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #24221e; background: #f8f6f0;
      padding: 11px 18px; border-radius: 3px; max-width: 80vw;
      box-shadow: 0 1px 3px rgba(0,0,0,0.2), 0 12px 32px rgba(0,0,0,0.3);
    }
    .toast.show { opacity: 1; transform: translate(-50%, 0); }
    .toast.actionable { pointer-events: auto; display: flex; align-items: center; gap: 14px; }
    .toast button {
      all: unset; cursor: pointer; font-weight: 700; color: #24221e;
      padding: 2px 4px; border-radius: 4px;
      text-decoration: underline; text-decoration-color: hsl(48, 95%, 62%);
      text-decoration-thickness: 3px; text-underline-offset: 3px;
    }
    .toast button:hover { background: #efebe2; }
    .toast button:focus-visible { outline: 2px solid #2a63d4; outline-offset: 2px; }
  `;

  // ---------- Build shadow UI (no innerHTML, safe on Trusted Types pages) ----------
  const host = document.createElement('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.appendChild(style);

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };

  const toastEl = el('div', 'toast');
  root.appendChild(toastEl);

  document.documentElement.appendChild(host);

  let toastTimer = null;
  function toast(text, action) {
    toastEl.textContent = '';
    toastEl.append(document.createTextNode(text));
    toastEl.classList.toggle('actionable', !!action);
    if (action) {
      const btn = el('button', '', action.label);
      btn.type = 'button';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toastEl.classList.remove('show', 'actionable');
        action.run();
      });
      toastEl.append(btn);
    }
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show', 'actionable'), action ? 6000 : 3200);
  }

  function openEditor(id) {
    chrome.runtime.sendMessage({ type: 'OSR_OPEN_EDITOR', id }).catch(() => {
      toast('OneShot Redux was updated. Please reload this page.');
    });
  }

  // ---------- Area selector ----------
  let active = false;
  let overlay = null, selEl = null, dimsEl = null, hintEl = null;
  let start = null;
  let quick = false; // Enter toggles: the card goes straight to the clipboard

  function renderHint() {
    if (!hintEl) return;
    hintEl.textContent = '';
    hintEl.classList.toggle('quick', quick);
    const k = (t) => el('kbd', '', t);
    const txt = (t) => document.createTextNode(t);
    if (quick) {
      hintEl.append(el('b', '', 'Quick copy on'), txt(': drag to select, the card goes to your clipboard  ·  '),
        k('F'), txt(' whole view  ·  '), k('Enter'), txt(' off  ·  '), k('Esc'));
    } else {
      hintEl.append(el('b', '', 'Drag'), txt(' to select  ·  '), k('F'), txt(' whole view  ·  '),
        k('Enter'), txt(' quick copy  ·  '), k('L'), txt(' Library  ·  '), k('Esc'), txt(' cancel'));
    }
  }

  function startSelection() {
    if (active) return;
    if (!extensionAlive()) {
      toast('OneShot Redux was updated. Please reload this page.');
      return;
    }
    active = true;
    toastEl.classList.remove('show');

    overlay = el('div', 'overlay');
    selEl = el('div', 'sel');
    dimsEl = el('div', 'dims');
    hintEl = el('div', 'hint');
    quick = false;
    renderHint();
    overlay.append(selEl, dimsEl);
    root.append(overlay, hintEl);

    overlay.addEventListener('pointerdown', onDown);
    overlay.addEventListener('contextmenu', onContext);
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
  }

  function onContext(e) {
    e.preventDefault();
    cancel();
  }

  function onDown(e) {
    if (e.button !== 0) { cancel(); return; }
    e.preventDefault();
    e.stopPropagation();
    try { overlay.setPointerCapture(e.pointerId); } catch (_) {}
    start = { x: e.clientX, y: e.clientY };
    overlay.classList.add('dragging');
    hintEl.style.display = 'none';
    selEl.style.display = 'block';
    dimsEl.style.display = 'block';
    drawSel(e);
    overlay.addEventListener('pointermove', onMove);
    overlay.addEventListener('pointerup', onUp);
    overlay.addEventListener('pointercancel', cancel);
  }

  function currentRect(e) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const x2 = Math.max(0, Math.min(vw, e.clientX));
    const y2 = Math.max(0, Math.min(vh, e.clientY));
    const x = Math.min(start.x, x2), y = Math.min(start.y, y2);
    return { x, y, w: Math.abs(x2 - start.x), h: Math.abs(y2 - start.y) };
  }

  function drawSel(e) {
    const r = currentRect(e);
    Object.assign(selEl.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    dimsEl.textContent = Math.round(r.w) + ' × ' + Math.round(r.h);
    const dy = r.y > 26 ? r.y - 24 : r.y + r.h + 6;
    Object.assign(dimsEl.style, { left: r.x + 'px', top: dy + 'px' });
  }

  function onMove(e) {
    if (!start) return;
    e.preventDefault();
    drawSel(e);
  }

  function onUp(e) {
    if (!start) return;
    e.preventDefault();
    const rect = currentRect(e);
    const isQuick = quick;
    teardownSelection();

    if (rect.w < 8 || rect.h < 8) {
      toast('Selection too small. Try dragging a larger area.');
      finish();
      return;
    }
    capture(rect, isQuick);
  }

  // Runs synchronously inside the user's click/keypress so the clipboard
  // write is allowed; the PNG itself arrives a moment later.
  function capture(rect, isQuick) {
    const request = (async () => {
      // Make sure the overlay is gone from the screen before Chrome takes the screenshot.
      await nextPaint();
      const res = await chrome.runtime.sendMessage({
        type: 'OSR_CAPTURE',
        rect,
        quick: isQuick,
        viewport: { w: window.innerWidth, h: window.innerHeight },
        meta: getMeta()
      });
      if (!res || !res.ok) throw new Error((res && res.error) || 'unknown error');
      return res;
    })();

    if (!isQuick) {
      request
        .catch((err) => toast(extensionAlive()
          ? 'Capture failed: ' + ((err && err.message) || err)
          : 'OneShot Redux was updated. Please reload this page.'))
        .finally(finish);
      return;
    }

    let captured = null;
    const pngBlob = request.then(async (res) => {
      captured = res;
      return (await fetch(res.png)).blob();
    });

    let write;
    try {
      write = navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    } catch (err) {
      write = Promise.reject(err);
    }

    write.then(
      () => toast('Card copied to clipboard', { label: 'Edit', run: () => openEditor(captured.id) }),
      (err) => {
        if (captured) {
          // The card was made, but this page wouldn't let us use the clipboard.
          toast("Couldn't copy on this page.", { label: 'Open in editor', run: () => openEditor(captured.id) });
        } else {
          pngBlob.catch(() => {}); // already reported here
          toast(extensionAlive()
            ? 'Capture failed: ' + ((err && err.message) || err)
            : 'OneShot Redux was updated. Please reload this page.');
        }
      }
    ).finally(finish);
  }

  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      return;
    }
    if (start || e.metaKey || e.ctrlKey || e.altKey) return; // ignore keys mid-drag and shortcuts
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      quick = !quick;
      renderHint();
    } else if (e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      try { chrome.runtime.sendMessage({ type: 'OSR_OPEN_LIBRARY' }); } catch (_) { /* extension reloaded */ }
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      e.stopPropagation();
      const isQuick = quick;
      teardownSelection();
      capture({ x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }, isQuick);
    }
  }

  function onVisibility() {
    if (document.hidden) cancel();
  }

  function onBlur() {
    // Only cancel if the user hasn't started dragging (focus can flicker during a drag in some setups).
    if (!start) cancel();
  }

  function cancel() {
    if (!active) return;
    teardownSelection();
    finish();
  }

  function teardownSelection() {
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('blur', onBlur);
    if (overlay) overlay.remove();
    if (hintEl) hintEl.remove();
    overlay = selEl = dimsEl = hintEl = null;
    start = null;
  }

  function finish() {
    active = false;
  }

  function nextPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)));
    });
  }

  function getMeta() {
    return {
      url: location.href,
      title: (document.title || '').trim() || location.hostname,
      icons: getIcons(),
      themeColor: getThemeColor(),
      publishedAt: getPublishedDate()
    };
  }

  // Site icons, best first: Apple touch icons and large icons look sharper on the card.
  function getIcons() {
    const found = [];
    for (const l of document.querySelectorAll('link[rel]')) {
      const rel = (l.getAttribute('rel') || '').toLowerCase();
      if (!/icon/.test(rel) || !l.href || /mask-icon/.test(rel)) continue;
      const sizes = (l.getAttribute('sizes') || '').toLowerCase();
      let size = /apple-touch/.test(rel) ? 180 : 32;
      if (sizes === 'any') size = 256;
      const m = /(\d+)x\d+/.exec(sizes);
      if (m) size = Math.max(...sizes.match(/\d+(?=x)/g).map(Number));
      found.push({ href: l.href, size });
    }
    found.sort((a, b) => b.size - a.size);
    const urls = found.map((f) => f.href);
    urls.push(location.origin + '/apple-touch-icon.png', location.origin + '/favicon.ico');
    return [...new Set(urls)];
  }

  function getThemeColor() {
    const metas = [...document.querySelectorAll('meta[name="theme-color"]')];
    const plain = metas.find((m) => !m.media || window.matchMedia(m.media).matches) || metas[0];
    return plain ? (plain.content || '').trim() : '';
  }

  // Find the article's publish date from the page's own metadata.
  // Returns the raw string (formatted later), or '' if nothing trustworthy is found.
  function getPublishedDate() {
    const candidates = [];
    const metaSelectors = [
      'meta[property="article:published_time"]',
      'meta[name="article:published_time"]',
      'meta[itemprop="datePublished"]',
      'meta[property="og:article:published_time"]',
      'meta[name="parsely-pub-date"]',
      'meta[name="sailthru.date"]',
      'meta[name="pubdate"]',
      'meta[name="publishdate"]',
      'meta[name="publish-date"]',
      'meta[name="date"]',
      'meta[name="DC.date.issued"]',
      'meta[name="dcterms.created"]',
      'meta[name="citation_publication_date"]'
    ];
    for (const sel of metaSelectors) {
      const m = document.querySelector(sel);
      if (m && m.content) candidates.push(m.content);
    }
    // JSON-LD (most news sites): look for datePublished on Article-like objects.
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const stack = [JSON.parse(script.textContent)];
        while (stack.length) {
          const node = stack.pop();
          if (!node || typeof node !== 'object') continue;
          if (Array.isArray(node)) { stack.push(...node); continue; }
          if (typeof node.datePublished === 'string') candidates.push(node.datePublished);
          if (node['@graph']) stack.push(node['@graph']);
          if (node.mainEntity) stack.push(node.mainEntity);
        }
      } catch (_) { /* malformed JSON-LD is common; skip it */ }
    }
    const t = document.querySelector('time[itemprop="datePublished"], article time[datetime][pubdate], time[pubdate]');
    if (t) candidates.push(t.getAttribute('datetime') || t.textContent || '');

    const now = Date.now() + 36 * 3600 * 1000; // allow for time zones
    for (const raw of candidates) {
      const v = String(raw).trim();
      if (!v) continue;
      const ms = Date.parse(v);
      if (Number.isNaN(ms)) continue;
      const year = new Date(ms).getUTCFullYear();
      if (year < 1990 || ms > now) continue;
      return v;
    }
    return '';
  }

  function extensionAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  // ---------- Messages from the background (toolbar button / shortcut) ----------
  function onMessage(msg, _sender, sendResponse) {
    if (msg && msg.type === 'OSR_START') {
      startSelection();
      sendResponse({ ok: true });
    }
    return false;
  }
  chrome.runtime.onMessage.addListener(onMessage);

  // ---------- Cleanup hook for re-injection ----------
  window.__oneshotRedux = {
    destroy() {
      try { teardownSelection(); } catch (_) {}
      try { chrome.runtime.onMessage.removeListener(onMessage); } catch (_) {}
      host.remove();
    }
  };
})();
