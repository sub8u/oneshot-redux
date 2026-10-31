// OneShot Redux: the Library page (search, reopen, copy, export).
(() => {
  'use strict';

  const LIB = self.OSRLibrary;
  const $ = (id) => document.getElementById(id);
  const grid = $('grid');
  const q = $('q');

  let entries = [];             // newest first
  const thumbUrls = new Map();  // id -> { url, v } (v = the card version it shows)
  let indexing = false;

  // ---------- Helpers ----------
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = (ms) => { const d = new Date(ms); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
  const isoDay = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const tokens = (s) => norm(s).split(/[^a-z0-9%$€£.,'-]+/).map((t) => t.replace(/^[.,'-]+|[.,'-]+$/g, '')).filter(Boolean);

  let toastTimer = 0;
  function toast(msg, action) {
    const t = $('toast');
    t.textContent = msg;
    if (action) {
      const b = el('button', '', action.label);
      b.type = 'button';
      b.addEventListener('click', () => { t.classList.remove('show'); action.run(); });
      t.append(b);
    }
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), action ? 6000 : 2400);
  }

  // ---------- Search ----------
  // Every word you type must appear (as a word or the start of one) in the
  // card's text, highlight, headline or site. Highlighted text ranks highest.
  function score(e, toks) {
    if (!toks.length) return 1;
    const fields = [
      [tokens(e.highlighted), 4],
      [tokens(e.text), 2],
      [tokens(e.title), 2],
      [tokens(e.domain), 1]
    ];
    let total = 0;
    for (const t of toks) {
      let best = 0;
      for (const [words, weight] of fields) {
        if (words.some((w) => w === t)) best = Math.max(best, weight * 2);
        else if (words.some((w) => w.startsWith(t))) best = Math.max(best, weight);
      }
      if (!best) return 0;
      total += best;
    }
    return total;
  }

  // A short excerpt around the first match, with matches marked.
  function snippetNodes(source, toks, max = 170) {
    const text = String(source || '');
    if (!toks.length) return [document.createTextNode(text.length > max ? text.slice(0, max).replace(/\s+\S*$/, '') + '…' : text)];
    const lower = norm(text);
    let first = -1;
    for (const t of toks) {
      const re = new RegExp('(^|[^a-z0-9])' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const m = re.exec(lower);
      if (m && (first < 0 || m.index < first)) first = m.index + m[1].length;
    }
    if (first < 0) return snippetNodes(text, [], max);
    let start = Math.max(0, first - 60);
    if (start > 0) start = text.indexOf(' ', start) + 1 || start;
    let end = Math.min(text.length, start + max);
    if (end < text.length) end = text.lastIndexOf(' ', end) > start ? text.lastIndexOf(' ', end) : end;
    const slice = text.slice(start, end);
    const lslice = norm(slice);
    // mark ranges
    const ranges = [];
    for (const t of toks) {
      const re = new RegExp('(^|[^a-z0-9])(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[a-z0-9]*)', 'g');
      let m;
      while ((m = re.exec(lslice))) ranges.push([m.index + m[1].length, m.index + m[1].length + m[2].length]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
    const nodes = [];
    if (start > 0) nodes.push(document.createTextNode('…'));
    let pos = 0;
    for (const [a, b] of ranges) {
      if (a < pos) continue;
      nodes.push(document.createTextNode(slice.slice(pos, a)));
      nodes.push(el('mark', '', slice.slice(a, b)));
      pos = b;
    }
    nodes.push(document.createTextNode(slice.slice(pos)));
    if (end < text.length) nodes.push(document.createTextNode('…'));
    return nodes;
  }

  // ---------- Render ----------
  function render() {
    const toks = tokens(q.value);
    const shown = entries
      .map((e) => ({ e, s: score(e, toks) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => (toks.length ? b.s - a.s : 0) || (b.e.createdAt - a.e.createdAt))
      .map((x) => x.e);

    grid.textContent = '';
    for (const e of shown) grid.append(tile(e, toks));

    const total = entries.length;
    $('count').textContent = toks.length
      ? `${shown.length} of ${total} card${total === 1 ? '' : 's'}`
      : `${total} card${total === 1 ? '' : 's'}`;
    $('empty').hidden = total > 0;
    $('noresults').hidden = !(total > 0 && shown.length === 0);
    $('exportBtn').disabled = total === 0;
  }

  function thumbUrl(e) {
    const cur = thumbUrls.get(e.id);
    if (cur && cur.v === e.updatedAt) return cur.url;
    if (cur) URL.revokeObjectURL(cur.url); // the card was edited: show the new version
    if (!e.thumb) return '';
    const url = URL.createObjectURL(e.thumb);
    thumbUrls.set(e.id, { url, v: e.updatedAt });
    return url;
  }

  function tile(e, toks) {
    const t = el('article', 'tile');
    t.setAttribute('role', 'listitem');
    t.tabIndex = 0;
    t.title = 'Open in the editor';

    const img = el('img', 'thumb');
    img.alt = e.highlighted || e.title || 'Quote card';
    img.loading = 'lazy';
    img.src = thumbUrl(e);
    t.append(img);

    const meta = el('div', 'meta');
    meta.append(el('div', 'title', e.title || e.domain || 'Untitled'));

    const src = el('div', 'source');
    if (e.domain) {
      const site = el('span', 'site', e.domain);
      site.title = `Show cards from ${e.domain}`;
      site.addEventListener('click', (ev) => { ev.stopPropagation(); q.value = e.domain; render(); });
      src.append(site);
    }
    if (e.published) src.append(el('span', '', `· ${e.published}`));
    src.append(el('span', '', `· saved ${fmtDate(e.createdAt)}`));
    meta.append(src);

    const snip = el('div', 'snippet');
    const hasText = e.text || e.highlighted;
    if (toks.length && hasText) {
      const inHl = score({ highlighted: e.highlighted }, toks) > 0;
      snip.append(...snippetNodes(inHl ? e.highlighted : e.text, toks));
    } else if (e.highlighted) {
      snip.append(document.createTextNode('“'), ...snippetNodes(e.highlighted, []), document.createTextNode('”'));
    } else if (e.text) {
      snip.append(...snippetNodes(e.text, []));
    } else {
      snip.classList.add('pending');
      snip.textContent = e.indexed ? 'No text found in this card.' : 'Reading the text so you can search it…';
    }
    meta.append(snip);
    t.append(meta);

    const actions = el('div', 'tile-actions');
    const act = (label, title, fn, cls) => {
      const b = el('button', cls || '', label);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
      actions.append(b);
    };
    act('Copy', 'Copy the card', () => copyCard(e));
    act('Download', 'Download the card as PNG', () => downloadCard(e));
    if (e.url) act('Source', 'Open the original article', () => window.open(e.url, '_blank', 'noopener'));
    act('Delete', 'Delete from your Library', () => deleteCard(e), 'danger');
    t.append(actions);

    const open = () => { location.href = chrome.runtime.getURL('editor.html?lib=' + encodeURIComponent(e.id)); };
    t.addEventListener('click', open);
    t.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(); });
    return t;
  }

  // ---------- Card images ----------
  // Cards are stored as capture + edits and re-created on demand by a hidden copy of the editor.
  let framePromise = null;
  function renderer() {
    if (!framePromise) {
      framePromise = new Promise((resolve, reject) => {
        const f = document.createElement('iframe');
        f.src = chrome.runtime.getURL('editor.html?render=frame');
        f.hidden = true;
        f.setAttribute('aria-hidden', 'true');
        f.addEventListener('load', () => {
          const fn = f.contentWindow && f.contentWindow.OSRRenderEntry;
          fn ? resolve(fn) : reject(new Error('Card renderer unavailable'));
        });
        document.body.append(f);
      });
    }
    return framePromise;
  }

  let renderQueue = Promise.resolve();
  function cardBlob(e) {
    if (e.card) return Promise.resolve(e.card); // cards saved by early versions
    // One render at a time: the renderer has a single canvas.
    const job = renderQueue.then(async () => (await renderer())(e));
    renderQueue = job.catch(() => {});
    return job;
  }

  // ---------- Actions ----------
  async function copyCard(e) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': cardBlob(e) })]);
      toast('Copied to clipboard');
    } catch (err) {
      toast('Copy failed: ' + err.message);
    }
  }

  function cardFileName(e) {
    const site = (e.domain || 'card').replace(/^www\./, '');
    const title = (e.title || '').replace(/\s+-\s+[^-]+$/, ''); // drop " - Publication" suffix
    const base = `${isoDay(e.createdAt)} ${site} - ${title}`.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return (base.length > 90 ? base.slice(0, 90).trim() : base) || `card-${e.id}`;
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function downloadCard(e) {
    try {
      saveBlob(await cardBlob(e), cardFileName(e) + '.png');
    } catch (err) {
      toast('Download failed: ' + err.message);
    }
  }

  async function deleteCard(e) {
    await LIB.remove(e.id);
    entries = entries.filter((x) => x.id !== e.id);
    render();
    toast('Card deleted', {
      label: 'Undo',
      run: async () => {
        await LIB.put(e);
        entries.push(e);
        entries.sort((a, b) => b.createdAt - a.createdAt);
        render();
      }
    });
  }

  // ---------- Export all (zip: cards + spreadsheet + JSON) ----------
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // Minimal ZIP writer ("stored": PNGs are already compressed).
  async function makeZip(files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(await f.data.arrayBuffer());
      const crc = crc32(data);
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(lh.buffer, name, data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(ch.buffer, name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, p) => s + (p.byteLength || p.length), 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
  }

  const csvCell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';

  async function exportAll() {
    const btn = $('exportBtn');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Preparing…';
    try {
      const list = await LIB.all();
      const used = new Set();
      const files = [], rows = [], meta = [];
      let i = 0;
      for (const e of list) {
        btn.textContent = `Preparing ${++i} of ${list.length}…`;
        let name = cardFileName(e), n = 2;
        while (used.has(name)) name = `${cardFileName(e)} (${n++})`;
        used.add(name);
        files.push({ name: `cards/${name}.png`, data: await cardBlob(e) });
        const rec = {
          file: `cards/${name}.png`,
          saved: new Date(e.createdAt).toISOString(),
          published: e.published || '',
          title: e.title || '',
          site: e.domain || '',
          url: e.url || '',
          highlighted: e.highlighted || '',
          text: e.text || ''
        };
        rows.push(rec);
        meta.push(rec);
      }
      const cols = ['saved', 'published', 'title', 'site', 'url', 'highlighted', 'text', 'file'];
      const csv = '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
      const enc = new TextEncoder();
      files.push({ name: 'library.csv', data: enc.encode(csv) });
      files.push({ name: 'library.json', data: enc.encode(JSON.stringify({ app: 'OneShot Redux', exported: new Date().toISOString(), cards: meta }, null, 2)) });
      const zip = await makeZip(files);
      saveBlob(zip, `oneshot-redux-library-${isoDay(Date.now())}.zip`);
      toast(`Exported ${list.length} card${list.length === 1 ? '' : 's'}`);
    } catch (err) {
      console.error(err);
      toast('Export failed: ' + err.message);
    } finally {
      btn.textContent = label;
      btn.disabled = entries.length === 0;
    }
  }

  // ---------- Background indexing (text for cards saved by quick copy) ----------
  async function indexMissing() {
    if (indexing || typeof Tesseract === 'undefined') return;
    const todo = entries.filter((e) => !e.text && !e.indexed && e.source && e.source.image);
    if (!todo.length) return;
    indexing = true;
    const status = $('indexing');
    status.hidden = false;
    const base = chrome.runtime.getURL('lib/tesseract/');
    let worker = null;
    try {
      worker = await Tesseract.createWorker('eng', 1, {
        workerPath: base + 'worker.min.js',
        corePath: base + 'tesseract-core-simd-lstm.js',
        langPath: base + 'lang',
        workerBlobURL: false,
        cacheMethod: 'none',
        gzip: true
      });
      let done = 0;
      for (const e of todo) {
        status.textContent = `Making ${todo.length - done} card${todo.length - done === 1 ? '' : 's'} searchable…`;
        let text = '';
        try {
          const bm = await createImageBitmap(e.source.image);
          const scale = bm.width < 1400 ? Math.min(2, 3000 / Math.max(bm.width, bm.height)) : 1;
          const c = document.createElement('canvas');
          c.width = Math.round(bm.width * Math.max(1, scale));
          c.height = Math.round(bm.height * Math.max(1, scale));
          c.getContext('2d').drawImage(bm, 0, 0, c.width, c.height);
          const { data } = await worker.recognize(c);
          text = (data.text || '').replace(/\s+/g, ' ').trim();
        } catch (_) { /* leave empty */ }
        await LIB.patch(e.id, { text, indexed: true });
        const live = entries.find((x) => x.id === e.id);
        if (live) { live.text = text; live.indexed = true; }
        done++;
        render();
      }
    } catch (err) {
      console.warn('OneShot Redux: indexing failed', err);
    } finally {
      if (worker) worker.terminate().catch(() => {});
      status.hidden = true;
      indexing = false;
    }
  }

  // ---------- Settings: save switch and keep limit ----------
  const LIB_DEFAULTS = { save: true, keep: 0 };
  let settings = { ...LIB_DEFAULTS };

  async function loadSettings() {
    const v = await chrome.storage.sync.get({ library: LIB_DEFAULTS }).catch(() => ({}));
    settings = { ...LIB_DEFAULTS, ...(v.library || {}) };
    $('saveToggle').checked = !!settings.save;
    showKeep();
  }

  // Show the saved limit, even if it isn't one of the standard choices.
  function showKeep() {
    const sel = $('keepSelect'), v = String(settings.keep || 0);
    if (![...sel.options].some((o) => o.value === v)) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = `newest ${v}`;
      sel.append(o);
    }
    sel.value = v;
  }

  function saveSettings() {
    return chrome.storage.sync.set({ library: settings }).catch(() => {});
  }

  $('saveToggle').addEventListener('change', () => {
    settings.save = $('saveToggle').checked;
    saveSettings();
    toast(settings.save ? 'New cards will be saved to your Library' : 'New cards won\'t be saved. Existing cards stay.');
  });

  $('keepSelect').addEventListener('change', async () => {
    const keep = Number($('keepSelect').value);
    const extra = keep > 0 ? Math.max(0, entries.length - keep) : 0;
    if (!extra) {
      settings.keep = keep;
      saveSettings();
      $('keepConfirm').hidden = true;
      return;
    }
    // Shrinking below what you already have: ask before deleting anything.
    $('keepConfirmText').textContent =
      `Keeping the newest ${keep} will remove your ${extra} oldest card${extra === 1 ? '' : 's'}. Export them first if you want a copy.`;
    $('keepConfirm').hidden = false;
    $('keepConfirmYes').onclick = async () => {
      settings.keep = keep;
      await saveSettings();
      const removed = await LIB.prune(keep);
      $('keepConfirm').hidden = true;
      toast(`Removed ${removed} older card${removed === 1 ? '' : 's'}`);
      load();
    };
    $('keepConfirmNo').onclick = () => {
      $('keepSelect').value = String(settings.keep || 0);
      $('keepConfirm').hidden = true;
    };
  });

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'sync' && ch.library) {
      settings = { ...LIB_DEFAULTS, ...(ch.library.newValue || {}) };
      $('saveToggle').checked = !!settings.save;
      showKeep();
    }
  });

  async function showUsage() {
    try {
      const { usage } = await navigator.storage.estimate();
      if (usage) $('usage').textContent = `Using ${usage < 1e6 ? '< 1' : Math.round(usage / 1e6)} MB on this computer`;
    } catch (_) { /* optional */ }
  }

  // ---------- Init ----------
  async function load() {
    entries = await LIB.all();
    for (const [id, t] of thumbUrls) {
      if (!entries.some((e) => e.id === id)) { URL.revokeObjectURL(t.url); thumbUrls.delete(id); }
    }
    render();
    showUsage();
    indexMissing();
  }

  let searchTimer = 0;
  q.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(render, 90); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { q.value = ''; render(); } });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
  });
  $('exportBtn').addEventListener('click', exportAll);
  // Pick up cards made in other tabs when you come back to the Library.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });

  const initial = new URLSearchParams(location.search).get('q');
  if (initial) q.value = initial;
  loadSettings();
  load().catch((err) => { console.error(err); toast('Could not open the Library: ' + err.message); });
})();
