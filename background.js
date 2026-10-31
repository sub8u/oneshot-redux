// OneShot Redux: background service worker (Manifest V3)
'use strict';

const MAX_CAPTURES = 8;

// Pages where Chrome never allows extensions to run or capture.
const RESTRICTED = [
  /^chrome:/i, /^edge:/i, /^about:/i, /^brave:/i, /^opera:/i, /^vivaldi:/i,
  /^chrome-extension:/i, /^chrome-search:/i, /^devtools:/i, /^view-source:/i,
  /^https:\/\/chromewebstore\.google\.com/i, /^https:\/\/chrome\.google\.com\/webstore/i
];

function isRestricted(url) {
  return !url || RESTRICTED.some((re) => re.test(url));
}

// ---------- Triggers ----------
chrome.action.onClicked.addListener((tab) => startCapture(tab));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'start-capture') startCapture(tab);
  else if (command === 'open-library') chrome.tabs.create({ url: chrome.runtime.getURL('library.html') });
});

async function startCapture(tab) {
  if (!tab || !tab.id) {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  }
  if (!tab || !tab.id) return;

  if (tab.url && isRestricted(tab.url)) {
    flashBadge(tab.id, "OneShot Redux can't run on this page");
    return;
  }

  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'OSR_START' });
  } catch (_) {
    // Content script not present yet (page opened before install, or reloaded extension).
    try {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(tab.id, { type: 'OSR_START' });
    } catch (err) {
      console.warn('OneShot Redux: could not start on this page.', err);
      flashBadge(tab.id, "OneShot Redux can't run on this page");
    }
  }
}

function flashBadge(tabId, title) {
  chrome.action.setBadgeBackgroundColor({ color: '#c0392b', tabId });
  chrome.action.setBadgeText({ text: '!', tabId });
  chrome.action.setTitle({ title, tabId });
  setTimeout(() => {
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
    chrome.action.setTitle({ title: 'OneShot Redux: capture an area', tabId }).catch(() => {});
  }, 2500);
}

// ---------- Capture + crop ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'OSR_CAPTURE') {
    handleCapture(msg, sender)
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true; // keep the channel open for the async response
  }
  if (msg && msg.type === 'OSR_OPEN_EDITOR' && msg.id) {
    openEditor(msg.id, sender.tab).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  return false;
});

async function handleCapture(msg, sender) {
  const tab = sender.tab;
  if (!tab) throw new Error('No tab');

  const iconPromise = fetchIcon(msg.meta.icons || []);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  const shotBlob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(shotBlob);

  // Captured image size vs. CSS viewport gives the true pixel ratio
  // (covers devicePixelRatio and page zoom).
  const scale = bitmap.width / Math.max(1, msg.viewport.w);
  let sx = Math.round(msg.rect.x * scale);
  let sy = Math.round(msg.rect.y * scale);
  let sw = Math.round(msg.rect.w * scale);
  let sh = Math.round(msg.rect.h * scale);
  sx = Math.max(0, Math.min(sx, bitmap.width - 1));
  sy = Math.max(0, Math.min(sy, bitmap.height - 1));
  sw = Math.max(1, Math.min(sw, bitmap.width - sx));
  sh = Math.max(1, Math.min(sh, bitmap.height - sy));

  const canvas = new OffscreenCanvas(sw, sh);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
  bitmap.close();
  const cropped = await canvas.convertToBlob({ type: 'image/png' });
  const image = await blobToDataURL(cropped);

  const id = 'cap_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const record = {
      image,
      width: sw,
      height: sh,
      pixelRatio: scale,
      url: msg.meta.url,
      title: msg.meta.title,
      faviconUrl: msg.meta.faviconUrl,
      publishedAt: msg.meta.publishedAt || '',
      themeColor: msg.meta.themeColor || '',
      favicon: await iconPromise,
      createdAt: Date.now()
  };
  await chrome.storage.local.set({ [id]: record });
  await pruneCaptures();

  if (msg.quick) {
    // Quick mode: render the finished card with the last-used style, no editor.
    const png = await renderQuickCard(id, record);
    return { ok: true, quick: true, id, png };
  }

  await openEditor(id, tab);
  return { ok: true };
}

async function openEditor(id, tab) {
  const opts = { url: chrome.runtime.getURL('editor.html?id=' + encodeURIComponent(id)) };
  if (tab) { opts.index = tab.index + 1; opts.openerTabId = tab.id; }
  await chrome.tabs.create(opts);
}

// ---------- Quick mode rendering (offscreen document) ----------
// The card renderer lives in editor.js. An offscreen copy of the editor page
// renders the card without opening a visible tab.
const OFFSCREEN_URL = 'editor.html?render=1';
let creatingOffscreen = null;

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification: 'Render quote card images for quick copy'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

async function renderQuickCard(id, record) {
  await ensureOffscreen();
  const prefs = await chrome.storage.sync.get(null);
  // The offscreen page may still be starting up: retry briefly until its renderer answers.
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await chrome.runtime.sendMessage({ type: 'OSR_RENDER', id, data: record, prefs }).catch(() => null);
    if (res && res.ok) return res.png;
    if (res && res.error) throw new Error(res.error);
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Card renderer did not respond');
}

// Fetch the site's icon here (works in Chrome and Safari), largest first.
// Returns a data URL, or '' to let the editor fall back.
async function fetchIcon(urls) {
  for (const url of urls.slice(0, 4)) {
    try {
      if (!/^(https?:|data:)/i.test(url)) continue;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
      clearTimeout(timer);
      if (!res.ok) continue;
      const blob = await res.blob();
      if (!blob.size || blob.size > 512 * 1024) continue;
      const type = blob.type || '';
      if (type && !type.startsWith('image/') && !/\.ico(\?|$)/i.test(url)) continue;
      return await blobToDataURL(type ? blob : new Blob([blob], { type: 'image/x-icon' }));
    } catch (_) { /* try the next candidate */ }
  }
  return '';
}

async function blobToDataURL(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return 'data:' + (blob.type || 'image/png') + ';base64,' + btoa(binary);
}

// Keep only the most recent captures so storage doesn't grow forever.
async function pruneCaptures() {
  const all = await chrome.storage.local.get(null);
  const caps = Object.entries(all)
    .filter(([k, v]) => k.startsWith('cap_') && v && v.createdAt)
    .sort((a, b) => b[1].createdAt - a[1].createdAt);
  const stale = caps.slice(MAX_CAPTURES).map(([k]) => k);
  if (stale.length) await chrome.storage.local.remove(stale);
}
