// OneShot Redux: card editor
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const canvas = $('card');
  const ctx = canvas.getContext('2d');

  const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';

  const DEFAULT_PREFS = {
    hue: 270,
    sat: 32,
    hlHue: null,     // highlight hue override (for near-gray backgrounds)
    exact: '',       // exact custom color (hex), or '' to use hue/tone
    swatch: 'auto',
    tone: 'deep',
    texture: 'dots',
    highlightAlpha: 0.55,
    showFavicon: true,
    torn: true,
    showQr: true,
    snapWords: true,
    tighten: true
  };

  const TILT = -0.6; // degrees: the paper sits very slightly askew, like a real clipping

  const state = {
    ...DEFAULT_PREFS,
    drift: false,
    capture: null,
    captureId: '',
    img: null,
    favicon: null,
    paper: '#fbf9f4',
    title: '',
    domain: '',
    published: '',   // formatted publish date, or '' if the page didn't provide one
    qr: null,         // {count, isDark(r,c)} for the source URL
    highlights: [],   // {x,y,w,h} normalized 0..1 relative to the captured image
    undoStack: [],
    drag: null,       // {x0,y0,x1,y1} in canvas px while dragging
    layout: null,
    seed: 1,
    ocr: { status: 'idle', words: [] },
    hoverWord: -1,
    wordSel: null,     // {anchor, current} word indices while selecting
    downAt: null,
    groupSeq: 1,
    brand: null,       // {hex, hl} derived from the site's theme color or icon
    imgOrig: null,     // the capture as taken
    imgTrim: null,     // the capture trimmed to its content
    trim: null         // {sx, sy, W, H, nw, nh}: trimmed area in original pixels
  };

  // ---------- Utilities ----------
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function hostname(url) {
    try { return new URL(url).hostname; } catch (_) { return ''; }
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image failed to load'));
      img.src = src;
    });
  }

  // Chrome's built-in favicon service. Served from the extension's own origin,
  // so drawing it never "taints" the canvas (which would break export).
  function faviconSrc(pageUrl) {
    const u = new URL(chrome.runtime.getURL('/_favicon/'));
    u.searchParams.set('pageUrl', pageUrl);
    u.searchParams.set('size', '64');
    return u.toString();
  }

  // Sample the screenshot's edges so the paper blends seamlessly with the page background.
  function samplePaper(img) {
    try {
      const c = document.createElement('canvas');
      const w = Math.min(img.naturalWidth, 400);
      const h = Math.max(1, Math.round(img.naturalHeight * (w / img.naturalWidth)));
      c.width = w; c.height = h;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0, w, h);
      const pts = [[1, 1], [w - 2, 1], [1, h - 2], [w - 2, h - 2], [Math.floor(w / 2), 1], [Math.floor(w / 2), h - 2]];
      const samples = pts.map(([px, py]) => Array.from(x.getImageData(Math.max(0, px), Math.max(0, py), 1, 1).data));
      // Use the median brightness sample (robust against a stray dark pixel in one corner).
      samples.sort((a, b) => (a[0] + a[1] + a[2]) - (b[0] + b[1] + b[2]));
      const m = samples[Math.floor(samples.length / 2)];
      return `rgb(${m[0]}, ${m[1]}, ${m[2]})`;
    } catch (_) {
      return '#fbf9f4';
    }
  }

  const SWATCHES = [
    { id: 'forest',   name: 'Forest',   h: 100, s: 18, hl: 95 },
    { id: 'plum',     name: 'Plum',     h: 270, s: 32 },
    { id: 'walnut',   name: 'Walnut',   h: 28,  s: 28, hl: 36 },
    { id: 'navy',     name: 'Navy',     h: 218, s: 48 },
    { id: 'teal',     name: 'Teal',     h: 182, s: 38 },
    { id: 'crimson',  name: 'Crimson',  h: 350, s: 42 },
    { id: 'slate',    name: 'Slate',    h: 212, s: 14, hl: 205 },
    { id: 'charcoal', name: 'Charcoal', h: 30,  s: 4,  hl: 45 }
  ];

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function hexToHsl(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return null;
    const n = parseInt(m[1], 16);
    const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, sat = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h, s: sat * 100, l: l * 100 };
  }

  function tone() {
    const a = state.highlightAlpha;
    // Exact custom color: the chosen color itself, with a slightly deeper corner.
    if (state.exact) {
      const c = hexToHsl(state.exact);
      if (c) {
        const dark = c.l < 58;
        const hh = state.hlHue != null ? state.hlHue : c.h;
        const hs = c.s < 12 ? 70 : clamp(c.s * 1.2, 50, 85);
        return {
          dark,
          bg1: `hsl(${c.h}, ${c.s}%, ${clamp(c.l - (dark ? 9 : 7), 0, 100)}%)`,
          bg2: state.exact,
          glow: dark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.30)',
          title: dark ? 'rgba(255,255,255,0.92)' : 'rgba(24,22,30,0.86)',
          sub: dark ? 'rgba(255,255,255,0.60)' : 'rgba(24,22,30,0.55)',
          hl: `hsla(${hh}, ${hs}%, 72%, ${a})`,
          shadow: dark ? 'rgba(0,0,0,0.42)' : 'rgba(30,20,50,0.22)'
        };
      }
    }
    const h = state.hue, S = state.sat;
    const hh = state.hlHue != null ? state.hlHue : h;
    const hs = clamp(S * 1.8, 48, 80);
    switch (state.tone) {
      case 'rich':
        return {
          dark: true,
          bg1: `hsl(${h}, ${clamp(S * 1.6, 0, 85)}%, 26%)`, bg2: `hsl(${h + 24}, ${clamp(S * 1.7, 0, 90)}%, 39%)`,
          glow: 'rgba(255,255,255,0.10)',
          title: 'rgba(255,255,255,0.92)', sub: 'rgba(255,255,255,0.62)',
          hl: `hsla(${hh}, ${hs}%, 74%, ${a})`,
          shadow: 'rgba(0,0,0,0.38)'
        };
      case 'soft':
        return {
          dark: false,
          bg1: `hsl(${h}, ${clamp(S * 1.05, 0, 70)}%, 86%)`, bg2: `hsl(${h + 20}, ${clamp(S * 1.15, 0, 75)}%, 74%)`,
          glow: 'rgba(255,255,255,0.35)',
          title: 'rgba(24,22,30,0.86)', sub: 'rgba(24,22,30,0.55)',
          hl: `hsla(${hh}, ${hs}%, 70%, ${a})`,
          shadow: 'rgba(30,20,50,0.22)'
        };
      default: // deep
        return {
          dark: true,
          bg1: `hsl(${h}, ${S * 0.9}%, 13%)`, bg2: `hsl(${h + 18}, ${S}%, 23%)`,
          glow: 'rgba(255,255,255,0.07)',
          title: 'rgba(255,255,255,0.88)', sub: 'rgba(255,255,255,0.55)',
          hl: `hsla(${hh}, ${hs}%, 70%, ${a})`,
          shadow: 'rgba(0,0,0,0.45)'
        };
    }
  }

  // ---------- Background textures ----------
  // Built once per size/ink into an offscreen canvas, then faded toward the
  // center so the quote stays calm and the texture lives around the edges.
  const texCache = { key: '', canvas: null };

  function drawTexture(L, t) {
    if (!state.texture || state.texture === 'none') return;
    const ink = t.dark ? '255,255,255' : '28,24,40';
    const key = [state.texture, L.W, L.H, ink, state.seed].join('|');
    if (texCache.key !== key) {
      texCache.canvas = buildTexture(state.texture, L.W, L.H, L.u, ink, t.dark);
      texCache.key = key;
    }
    ctx.drawImage(texCache.canvas, 0, 0);
  }

  function buildTexture(type, W, H, u, ink, dark) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    const rnd = mulberry32((state.seed ^ hashStr(type)) >>> 0);
    const k = dark ? 1 : 0.85; // slightly less ink on light backgrounds
    const rgba = (al) => `rgba(${ink}, ${al * k})`;

    if (type === 'grain') {
      const img = x.createImageData(W, H);
      const d = img.data;
      const [r, g, b] = ink.split(',').map(Number);
      for (let i = 0; i < d.length; i += 4) {
        d[i] = r; d[i + 1] = g; d[i + 2] = b;
        d[i + 3] = (rnd() * rnd()) * 70 * k;
      }
      x.putImageData(img, 0, 0);
    } else if (type === 'dots') {
      const step = 22 * u, rad = 1.35 * u;
      x.fillStyle = rgba(0.3);
      const ox = (W % step) / 2, oy = (H % step) / 2;
      for (let yy = oy; yy < H; yy += step) {
        for (let xx = ox; xx < W; xx += step) {
          x.beginPath(); x.arc(xx, yy, rad, 0, Math.PI * 2); x.fill();
        }
      }
    } else if (type === 'grid') {
      const step = 34 * u;
      const ox = (W % step) / 2, oy = (H % step) / 2;
      let n = 0;
      for (let xx = ox; xx < W; xx += step, n++) {
        x.fillStyle = rgba(n % 4 === 0 ? 0.13 : 0.06);
        x.fillRect(Math.round(xx), 0, Math.max(1, u), H);
      }
      n = 0;
      for (let yy = oy; yy < H; yy += step, n++) {
        x.fillStyle = rgba(n % 4 === 0 ? 0.13 : 0.06);
        x.fillRect(0, Math.round(yy), W, Math.max(1, u));
      }
    } else if (type === 'binary') {
      const fs = Math.round(13 * u), cw = 15 * u, rh = 19 * u;
      x.font = `500 ${fs}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
      x.textBaseline = 'top';
      for (let xx = 4 * u; xx < W; xx += cw) {
        const colStrength = 0.05 + rnd() * 0.22; // each column is its own faint "stream"
        const gapStart = rnd() * H, gapLen = rnd() * H * 0.5;
        for (let yy = 4 * u; yy < H; yy += rh) {
          if (yy > gapStart && yy < gapStart + gapLen) continue;
          if (rnd() < 0.18) continue;
          x.fillStyle = rgba(colStrength * (0.5 + rnd() * 0.5));
          x.fillText(rnd() < 0.5 ? '0' : '1', xx, yy);
        }
      }
    } else if (type === 'circuit') {
      const g = 26 * u;
      const cols = Math.ceil(W / g), rows = Math.ceil(H / g);
      x.lineCap = 'round'; x.lineJoin = 'round';
      x.lineWidth = Math.max(1, 1.4 * u);
      // A few "chips" with pins
      const chips = 3 + Math.floor(rnd() * 2);
      for (let i = 0; i < chips; i++) {
        const cw = (4 + Math.floor(rnd() * 3)) * g, ch = (3 + Math.floor(rnd() * 2)) * g;
        const edge = rnd() < 0.5;
        const cx = Math.round((edge ? (rnd() < 0.5 ? rnd() * 0.15 : 0.85 + rnd() * 0.15) : rnd()) * (W - cw) / g) * g;
        const cy = Math.round(rnd() * (H - ch) / g) * g;
        x.fillStyle = rgba(0.035);
        x.strokeStyle = rgba(0.2);
        x.beginPath(); x.roundRect(cx, cy, cw, ch, 4 * u); x.fill(); x.stroke();
        x.beginPath();
        for (let px = cx + g * 0.5; px < cx + cw - g * 0.3; px += g * 0.75) {
          x.moveTo(px, cy); x.lineTo(px, cy - g * 0.45);
          x.moveTo(px, cy + ch); x.lineTo(px, cy + ch + g * 0.45);
        }
        x.stroke();
      }
      // Traces: mostly right angles, the odd 45°, with pads at both ends
      const traces = Math.round((cols * rows) / 9);
      const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
      x.strokeStyle = rgba(0.16);
      for (let i = 0; i < traces; i++) {
        let gx = Math.floor(rnd() * cols), gy = Math.floor(rnd() * rows);
        let d = Math.floor(rnd() * 4);
        const pts = [[gx * g, gy * g]];
        const segs = 2 + Math.floor(rnd() * 4);
        for (let sgi = 0; sgi < segs; sgi++) {
          const len = 1 + Math.floor(rnd() * 4);
          gx += dirs[d][0] * len; gy += dirs[d][1] * len;
          pts.push([gx * g, gy * g]);
          d = rnd() < 0.25 ? 4 + Math.floor(rnd() * 4) : Math.floor(rnd() * 4);
        }
        x.beginPath();
        pts.forEach(([px, py], j) => (j ? x.lineTo(px, py) : x.moveTo(px, py)));
        x.stroke();
        for (const [px, py] of [pts[0], pts[pts.length - 1]]) {
          x.beginPath(); x.arc(px, py, 2.6 * u, 0, Math.PI * 2);
          x.fillStyle = rgba(0.22); x.fill();
        }
      }
    }

    // Fade toward the center
    x.globalCompositeOperation = 'destination-in';
    const m = x.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.72);
    m.addColorStop(0, 'rgba(0,0,0,0.25)');
    m.addColorStop(0.45, 'rgba(0,0,0,0.5)');
    m.addColorStop(1, 'rgba(0,0,0,1)');
    x.fillStyle = m;
    x.fillRect(0, 0, W, H);
    return c;
  }

  function wrapText(text, maxW, maxLines) {
    const words = (text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    const lines = [];
    let line = '';
    for (let i = 0; i < words.length; i++) {
      const test = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width <= maxW || !line) {
        line = test;
      } else {
        lines.push(line);
        line = words[i];
        if (lines.length === maxLines) break;
      }
    }
    if (line && lines.length < maxLines) lines.push(line);
    // Ellipsize if text was cut off.
    const used = lines.join(' ').split(' ').length;
    if (used < words.length && lines.length) {
      let last = lines[lines.length - 1];
      while (last.length > 1 && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
      lines[lines.length - 1] = last.replace(/[\s,;:.-]+$/, '') + '…';
    }
    // A single overlong word: hard-truncate.
    return lines.map((l) => {
      if (ctx.measureText(l).width <= maxW) return l;
      let s = l;
      while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
      return s + '…';
    });
  }

  // ---------- Layout ----------
  function computeLayout() {
    const img = state.img;
    const nw = img.naturalWidth, nh = img.naturalHeight;
    const k = nw < 760 ? Math.min(2, 760 / nw) : 1; // upscale small captures a little
    const iw = Math.round(nw * k), ih = Math.round(nh * k);
    const u = Math.max(iw, 760) / 1000;             // design unit

    const padX = Math.round(40 * u);
    const padY = Math.round(42 * u);
    const tear = Math.round(13 * u);
    const paperW = iw + padX * 2;
    const paperH = ih + padY * 2;
    const margin = Math.round(84 * u);

    const titleSize = Math.round(30 * u);
    const domainSize = Math.round(21 * u);
    const favSize = Math.round(46 * u);
    const favGap = Math.round(16 * u);
    const showFav = state.showFavicon;

    ctx.font = `650 ${titleSize}px ${FONT}`;
    const titleMaxW = paperW - (showFav ? favSize + favGap : 0);
    const lines = state.title.trim() ? wrapText(state.title, titleMaxW, 2) : [];
    const lineH = Math.round(titleSize * 1.28);
    const subText = subLine();
    const hasDomain = !!subText;
    const textH = lines.length * lineH + (hasDomain ? Math.round(domainSize * 1.55) : 0);
    const headerH = (lines.length || hasDomain) ? Math.max(textH, showFav ? favSize : 0) : 0;
    const headerGap = headerH ? Math.round(30 * u) : 0;

    const W = paperW + margin * 2;
    const topPad = Math.round(margin * 0.8);

    // QR "sticker": overlaps the paper's bottom padding, hangs into the margin below.
    let qr = null;
    if (state.showQr && state.qr) {
      const quiet = 2; // modules of white border inside the sticker
      const modulePx = Math.max(3, Math.round((104 * u) / (state.qr.count + quiet * 2)));
      const box = modulePx * (state.qr.count + quiet * 2);
      const overlap = Math.min(Math.round(box * 0.32), Math.round(padY * 0.8));
      qr = { modulePx, box, quiet, overlap, radius: Math.round(10 * u) };
    }
    const bottom = qr ? Math.max(margin, qr.box - qr.overlap + Math.round(46 * u)) : margin;
    const H = topPad + headerH + headerGap + paperH + bottom;
    const paperX = margin;
    const paperY = topPad + headerH + headerGap;

    // Title block geometry (centered as a group).
    ctx.font = `650 ${titleSize}px ${FONT}`;
    let blockW = 0;
    for (const l of lines) blockW = Math.max(blockW, ctx.measureText(l).width);
    if (hasDomain) {
      ctx.font = `400 ${domainSize}px ${FONT}`;
      blockW = Math.max(blockW, ctx.measureText(subText).width);
    }

    state.layout = {
      k, iw, ih, u, padX, padY, tear, paperW, paperH, margin, W, H,
      paperX, paperY, imgX: paperX + padX, imgY: paperY + padY,
      titleSize, domainSize, favSize, favGap, lines, lineH, hasDomain, subText, qr,
      headerY: topPad, headerH, blockW, showFav,
      path: buildPaperPath(paperX, paperY, paperW, paperH, tear),
      tilt: state.torn ? TILT : 0
    };
  }

  function buildPaperPath(x, y, w, h, amp) {
    const pts = [];
    if (!state.torn) {
      return { pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], torn: false };
    }
    const rnd = mulberry32(state.seed);
    const step = () => amp * (0.7 + rnd() * 1.7);
    // Top edge (left → right)
    let cx = x;
    pts.push([x, y + rnd() * amp]);
    while (cx < x + w) {
      cx = Math.min(x + w, cx + step());
      pts.push([cx, y + rnd() * amp]);
    }
    // Bottom edge (right → left)
    let bx = x + w;
    pts.push([x + w, y + h - rnd() * amp]);
    while (bx > x) {
      bx = Math.max(x, bx - step());
      pts.push([bx, y + h - rnd() * amp]);
    }
    return { pts, torn: true };
  }

  function tracePaper(path) {
    ctx.beginPath();
    path.pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.closePath();
  }

  // ---------- Source line, publish date, QR ----------
  function subLine() {
    const d = state.domain.trim();
    if (d && state.published) return d + '  ·  ' + state.published;
    return d || state.published;
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Format the page's publish date as "12 Mar 2016". ISO dates use the date as the
  // publisher wrote it (avoids shifting a day across time zones). Unknown → ''.
  function formatPublished(raw) {
    if (!raw) return '';
    const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw).trim());
    if (iso) {
      const y = +iso[1], m = +iso[2], d = +iso[3];
      if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return `${d} ${MONTHS[m - 1]} ${y}`;
      return '';
    }
    const dt = new Date(raw);
    if (Number.isNaN(dt.getTime())) return '';
    return `${dt.getDate()} ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
  }

  // Drop common tracking parameters so the QR stays small and clean.
  function cleanUrl(url) {
    try {
      const u = new URL(url);
      for (const k of [...u.searchParams.keys()]) {
        if (/^(utm_|mc_|_hs)/i.test(k) || ['fbclid', 'gclid', 'dclid', 'msclkid', 'igshid', 'ref', 'ref_src', 'cmpid', 'ocid', 'smid'].includes(k.toLowerCase())) {
          u.searchParams.delete(k);
        }
      }
      return u.toString();
    } catch (_) {
      return url;
    }
  }

  function buildQr(url) {
    if (!url || typeof qrcode !== 'function' || !/^https?:/i.test(url)) return null;
    try {
      const q = qrcode(0, 'M');
      q.addData(cleanUrl(url));
      q.make();
      return { count: q.getModuleCount(), isDark: (r, c) => q.isDark(r, c) };
    } catch (_) {
      return null; // URL too long for a QR code
    }
  }

  function drawQr(L, t) {
    const q = L.qr;
    const x = L.paperX + L.paperW - q.box - Math.round(L.padX * 0.6);
    const y = L.paperY + L.paperH - q.overlap;

    // White sticker with a soft shadow
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.28)';
    ctx.shadowBlur = 18 * L.u;
    ctx.shadowOffsetY = 6 * L.u;
    roundRect(x, y, q.box, q.box, q.radius);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.restore();

    // Modules, in a dark tint of the background hue (still high-contrast for scanners)
    ctx.save();
    ctx.fillStyle = `hsl(${state.hue}, 35%, 14%)`;
    const n = state.qr.count;
    const m = q.modulePx;
    const ox = x + q.quiet * m, oy = y + q.quiet * m;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (state.qr.isDark(r, c)) ctx.fillRect(ox + c * m, oy + r * m, m, m);
      }
    }
    ctx.restore();

  }

  // Name, bottom-left on the background (balances the QR on the right).
  function drawBrand(L, t) {
    const size = Math.round(17 * L.u);
    const paperBottom = L.paperY + L.paperH;
    const y = L.qr
      ? paperBottom + (L.qr.box - L.qr.overlap) / 2
      : paperBottom + (L.H - paperBottom) / 2;
    ctx.save();
    ctx.font = `600 ${size}px ${FONT}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${(0.6 * L.u).toFixed(2)}px`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = t.sub;
    ctx.globalAlpha = 0.75;
    const x0 = L.paperX + Math.round(L.padX * 0.6);
    ctx.fillText('OneShot ', x0, y);
    const w1 = ctx.measureText('OneShot ').width;
    ctx.font = `italic 600 ${size}px ${FONT}`;
    ctx.fillText('Redux', x0 + w1, y);
    ctx.restore();
  }

  // ---------- Render ----------
  function render(opts = {}) {
    if (!state.img || !state.layout) return;
    const L = state.layout;
    const t = tone();
    if (canvas.width !== L.W) canvas.width = L.W;
    if (canvas.height !== L.H) canvas.height = L.H;

    ctx.save();
    ctx.clearRect(0, 0, L.W, L.H);

    // Background gradient + soft glow
    const g = ctx.createLinearGradient(0, 0, L.W, L.H);
    g.addColorStop(0, t.bg1);
    g.addColorStop(1, t.bg2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, L.W, L.H);
    const rg = ctx.createRadialGradient(L.W / 2, L.H * 0.15, 0, L.W / 2, L.H * 0.15, Math.max(L.W, L.H) * 0.75);
    rg.addColorStop(0, t.glow);
    rg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, L.W, L.H);

    drawTexture(L, t);
    drawHeader(L, t);

    ctx.save(); // paper group: tilted very slightly, like a real clipping
    if (L.tilt) {
      const cx = L.paperX + L.paperW / 2, cy = L.paperY + L.paperH / 2;
      ctx.translate(cx, cy); ctx.rotate(L.tilt * Math.PI / 180); ctx.translate(-cx, -cy);
    }
    // Two shadows: a wide ambient one, and a tight contact one where paper meets surface
    ctx.save();
    ctx.shadowColor = t.shadow; ctx.shadowBlur = 64 * L.u; ctx.shadowOffsetY = 26 * L.u;
    tracePaper(L.path); ctx.fillStyle = state.paper; ctx.fill();
    ctx.restore();
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.24)'; ctx.shadowBlur = 5 * L.u; ctx.shadowOffsetY = 2 * L.u;
    tracePaper(L.path); ctx.fillStyle = state.paper; ctx.fill();
    ctx.restore();
    // Torn paper shows its lighter core: a frayed white rim just outside the tear
    if (L.path.torn) {
      const mid = L.paperY + L.paperH / 2;
      const rim = { pts: L.path.pts.map(([px, py]) =>
        [px, py + (py < mid ? -1 : 1) * (2 + ((px * 7.13) % 1.7)) * L.u]), torn: true };
      tracePaper(rim);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.fill();
      tracePaper(L.path); ctx.fillStyle = state.paper; ctx.fill();
    }

    // Paper contents, clipped to the torn shape
    ctx.save();
    tracePaper(L.path);
    ctx.clip();
    ctx.fillStyle = state.paper;
    ctx.fillRect(L.paperX, L.paperY, L.paperW, L.paperH);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(state.img, L.imgX, L.imgY, L.iw, L.ih);

    // Highlights: multiply keeps the text crisp and dark underneath.
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = t.hl;
    const r = 5 * L.u;
    for (const h of state.highlights) {
      const seed = hashStr([h.x, h.y, h.w].map((v) => v.toFixed(4)).join());
      drawMarker(L.imgX + h.x * L.iw, L.imgY + h.y * L.ih, h.w * L.iw, h.h * L.ih, t.hl, seed);
    }
    if (!opts.export) {
      previewRects().forEach((d, i) => {
        drawMarker(L.imgX + d.x * L.iw, L.imgY + d.y * L.ih, d.w * L.iw, d.h * L.ih, t.hl, 101 + i);
      });
    }
    ctx.globalCompositeOperation = 'source-over';
    drawFibers(L);

    // Hover hint: a soft outline around the word under the pointer (never exported).
    if (!opts.export && state.hoverWord >= 0 && wordsActive()) {
      const w = state.ocr.words[state.hoverWord];
      if (w) {
        const pad = 3 * L.u;
        roundRect(L.imgX + w.x0 * L.iw - pad, L.imgY + w.y0 * L.ih - pad,
          (w.x1 - w.x0) * L.iw + pad * 2, (w.y1 - w.y0) * L.ih + pad * 2, r);
        ctx.lineWidth = Math.max(1, 1.5 * L.u);
        ctx.strokeStyle = `hsla(${state.hue}, 60%, 50%, 0.55)`;
        ctx.stroke();
      }
    }

    ctx.restore();

    // Fibrous highlight along torn edges
    if (L.path.torn) {
      ctx.save();
      tracePaper(L.path);
      ctx.lineWidth = Math.max(1, 1.6 * L.u);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore(); // paper group

    if (L.qr) drawQr(L, t);
    drawBrand(L, t);

    ctx.restore();
  }

  function roundRect(x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawHeader(L, t) {
    if (!L.headerH) return;
    const favW = L.showFav ? L.favSize + L.favGap : 0;
    const totalW = favW + L.blockW;
    const startX = Math.round(L.W / 2 - totalW / 2);
    const textX = startX + favW;
    const textH = L.lines.length * L.lineH + (L.hasDomain ? Math.round(L.domainSize * 1.55) : 0);
    const textY = L.headerY + Math.round((L.headerH - textH) / 2);

    if (L.showFav) {
      const fy = L.headerY + Math.round((L.headerH - L.favSize) / 2);
      drawFavicon(startX, fy, L.favSize, t);
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = `650 ${L.titleSize}px ${FONT}`;
    ctx.fillStyle = t.title;
    L.lines.forEach((line, i) => {
      // Center each line within the block when there's no icon (matches the reference look).
      const lw = ctx.measureText(line).width;
      const x = L.showFav ? textX : Math.round(L.W / 2 - lw / 2);
      ctx.fillText(line, x, textY + i * L.lineH);
    });
    if (L.hasDomain) {
      ctx.font = `400 ${L.domainSize}px ${FONT}`;
      ctx.fillStyle = t.sub;
      const d = L.subText;
      const dw = ctx.measureText(d).width;
      const x = L.showFav ? textX : Math.round(L.W / 2 - dw / 2);
      ctx.fillText(d, x, textY + L.lines.length * L.lineH + Math.round(L.domainSize * 0.3));
    }
  }

  function drawFavicon(x, y, size, t) {
    const r = size / 2;
    ctx.save();
    // Badge
    ctx.shadowColor = 'rgba(0,0,0,0.25)';
    ctx.shadowBlur = size * 0.25;
    ctx.shadowOffsetY = size * 0.06;
    ctx.beginPath();
    ctx.arc(x + r, y + r, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    const inner = size * 0.56;
    if (state.favicon) {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(state.favicon, x + (size - inner) / 2, y + (size - inner) / 2, inner, inner);
    } else {
      const letter = (state.domain.replace(/^www\./, '')[0] || '?').toUpperCase();
      ctx.fillStyle = `hsl(${state.hue}, 45%, 35%)`;
      ctx.font = `700 ${Math.round(size * 0.46)}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(letter, x + r, y + r + size * 0.02);
    }
    ctx.restore();
  }

  // ---------- Text detection (OCR, fully local) ----------
  function setOcrStatus(kind, text) {
    state.ocr.status = kind;
    const box = $('ocrStatus');
    box.dataset.state = kind;
    $('ocrText').textContent = text;
    updateHint();
  }

  function updateHint() {
    const hint = $('hint');
    if (state.ocr.status === 'done' && state.snapWords && state.ocr.words.length) {
      hint.textContent = 'Click a word, or drag across words to highlight. Drag in empty space to draw freely. Click a highlight to remove it.';
    } else if (state.ocr.status === 'running') {
      hint.textContent = 'Reading the text… You can already draw highlights by dragging.';
    } else {
      hint.textContent = 'Drag across the text to highlight it. Click a highlight to remove it.';
    }
  }

  // Tesseract reads small text better at ~2x, so upscale low-resolution captures.
  function ocrSource(img) {
    const nw = img.naturalWidth, nh = img.naturalHeight;
    const scale = nw < 1400 ? Math.min(2, 3000 / Math.max(nw, nh)) : 1;
    if (scale <= 1) return { source: img, scale: 1 };
    const c = document.createElement('canvas');
    c.width = Math.round(nw * scale);
    c.height = Math.round(nh * scale);
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(img, 0, 0, c.width, c.height);
    return { source: c, scale };
  }

  async function runOCR() {
    if (typeof Tesseract === 'undefined') {
      setOcrStatus('failed', 'Text detection unavailable. Drag to draw highlights.');
      return;
    }
    setOcrStatus('running', 'Preparing text detection…');
    const base = chrome.runtime.getURL('lib/tesseract/');
    let worker = null;
    try {
      worker = await Tesseract.createWorker('eng', 1, {
        workerPath: base + 'worker.min.js',
        corePath: base + 'tesseract-core-simd-lstm.js',
        langPath: base + 'lang',
        workerBlobURL: false,
        cacheMethod: 'none',
        gzip: true,
        logger: (m) => {
          if (m.status === 'recognizing text') {
            setOcrStatus('running', `Reading text… ${Math.round((m.progress || 0) * 100)}%`);
          }
        }
      });
      const src = state.img;
      const { source, scale } = ocrSource(src);
      const { data } = await worker.recognize(source, {}, { blocks: true, text: false });
      const words = extractWords(data, scale, src);
      if (state.img === src) {
        state.ocr.words = words;
      } else {
        // "Trim to content" was toggled while reading: map the words onto the current image.
        const cur = state.img, keep = state.highlights;
        state.img = src; state.highlights = []; state.ocr.words = words;
        useTrim(cur === state.imgTrim);
        state.highlights = keep;
      }
      const n = state.ocr.words.length;
      if (n) {
        setOcrStatus('done', `${n} word${n === 1 ? '' : 's'} detected. Click or drag across them.`);
      } else {
        setOcrStatus('failed', 'No text found. Drag to draw highlights.');
      }
    } catch (err) {
      console.warn('OneShot Redux OCR failed:', err);
      state.ocr.words = [];
      setOcrStatus('failed', 'Text detection failed. Drag to draw highlights.');
    } finally {
      if (worker) worker.terminate().catch(() => {});
      render();
    }
  }

  // Flatten Tesseract's blocks → paragraphs → lines → words into reading order.
  // Coordinates are normalized (0..1) to the captured image. Each word carries
  // its line's full height so highlights on one line line up neatly.
  function extractWords(data, scale, img) {
    const nw = img.naturalWidth * scale;
    const nh = img.naturalHeight * scale;
    const out = [];
    let line = 0;
    for (const b of (data && data.blocks) || []) {
      for (const p of b.paragraphs || []) {
        for (const l of p.lines || []) {
          const ws = (l.words || []).filter((w) =>
            w.text && w.text.trim() && w.confidence >= 25 &&
            w.bbox && w.bbox.x1 > w.bbox.x0 && w.bbox.y1 > w.bbox.y0);
          if (!ws.length) continue;
          // Line band from the median word heights (robust against a stray tall glyph).
          const tops = ws.map((w) => w.bbox.y0).sort((a, c) => a - c);
          const bots = ws.map((w) => w.bbox.y1).sort((a, c) => a - c);
          const ly0 = tops[Math.floor(tops.length / 2)];
          const ly1 = bots[Math.floor(bots.length / 2)];
          for (const w of ws) {
            out.push({
              text: w.text,
              line,
              x0: w.bbox.x0 / nw, x1: w.bbox.x1 / nw,
              y0: Math.min(ly0, w.bbox.y0 + (ly1 - ly0) * 0.25) / nh,
              y1: Math.max(ly1, w.bbox.y1 - (ly1 - ly0) * 0.25) / nh
            });
          }
          line++;
        }
      }
    }
    return out;
  }

  // ---------- Highlight interaction ----------
  function toCanvas(e) {
    const rect = canvas.getBoundingClientRect();
    const p = {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height)
    };
    const L = state.layout;
    if (L && L.tilt) {
      // The paper is drawn rotated; rotate the pointer back into paper coordinates.
      const cx = L.paperX + L.paperW / 2, cy = L.paperY + L.paperH / 2;
      const a = -L.tilt * Math.PI / 180, dx = p.x - cx, dy = p.y - cy;
      return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) };
    }
    return p;
  }

  function inImage(p) {
    const L = state.layout;
    return L && p.x >= L.imgX - L.padX * 0.5 && p.x <= L.imgX + L.iw + L.padX * 0.5 &&
      p.y >= L.imgY - L.padY * 0.5 && p.y <= L.imgY + L.ih + L.padY * 0.5;
  }

  function toNorm(p) {
    const L = state.layout;
    return {
      x: Math.max(0, Math.min(1, (p.x - L.imgX) / L.iw)),
      y: Math.max(0, Math.min(1, (p.y - L.imgY) / L.ih))
    };
  }

  function normDrag(d) {
    const a = toNorm({ x: d.x0, y: d.y0 });
    const b = toNorm({ x: d.x1, y: d.y1 });
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(a.x - b.x), h = Math.abs(a.y - b.y);
    return (w > 0 && h > 0) ? { x, y, w, h } : null;
  }

  function wordsActive() {
    return state.snapWords && state.ocr.status === 'done' && state.ocr.words.length > 0;
  }

  // Word directly under the pointer (with a little slack between words).
  function wordAt(p) {
    if (!wordsActive()) return -1;
    const n = toNorm(p);
    const ws = state.ocr.words;
    const slackX = 6 / state.img.naturalWidth;
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i];
      if (n.x >= w.x0 - slackX && n.x <= w.x1 + slackX && n.y >= w.y0 && n.y <= w.y1) return i;
    }
    return -1;
  }

  // Nearest word to the pointer while dragging: closest line vertically,
  // then closest word horizontally within that line.
  function nearestWord(p) {
    const n = toNorm(p);
    const ws = state.ocr.words;
    let bestLine = -1, bestDy = Infinity;
    for (const w of ws) {
      const dy = n.y < w.y0 ? w.y0 - n.y : (n.y > w.y1 ? n.y - w.y1 : 0);
      if (dy < bestDy) { bestDy = dy; bestLine = w.line; }
    }
    let best = -1, bestDx = Infinity;
    for (let i = 0; i < ws.length; i++) {
      if (ws[i].line !== bestLine) continue;
      const w = ws[i];
      const dx = n.x < w.x0 ? w.x0 - n.x : (n.x > w.x1 ? n.x - w.x1 : 0);
      if (dx < bestDx) { bestDx = dx; best = i; }
    }
    return best;
  }

  // Turn a run of words (in reading order) into one rounded bar per line.
  function wordRangeRects(a, b) {
    const [s, e] = a <= b ? [a, b] : [b, a];
    const byLine = new Map();
    for (let i = s; i <= e; i++) {
      const w = state.ocr.words[i];
      const r = byLine.get(w.line);
      if (!r) byLine.set(w.line, { x0: w.x0, x1: w.x1, y0: w.y0, y1: w.y1 });
      else {
        r.x0 = Math.min(r.x0, w.x0); r.x1 = Math.max(r.x1, w.x1);
        r.y0 = Math.min(r.y0, w.y0); r.y1 = Math.max(r.y1, w.y1);
      }
    }
    const ar = state.img.naturalHeight / state.img.naturalWidth;
    const rects = [];
    for (const r of byLine.values()) {
      const h = r.y1 - r.y0;
      const px = h * 0.22 * ar; // horizontal padding proportional to line height
      const py = h * 0.08;
      const x0 = Math.max(0, r.x0 - px), x1 = Math.min(1, r.x1 + px);
      const y0 = Math.max(0, r.y0 - py), y1 = Math.min(1, r.y1 + py);
      rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
    return rects;
  }

  function hitHighlight(p) {
    const n = toNorm(p);
    for (let i = state.highlights.length - 1; i >= 0; i--) {
      const h = state.highlights[i];
      if (n.x >= h.x && n.x <= h.x + h.w && n.y >= h.y && n.y <= h.y + h.h) return i;
    }
    return -1;
  }

  function removeHighlightAt(idx) {
    const g = state.highlights[idx].g;
    pushUndo();
    if (g) state.highlights = state.highlights.filter((h) => h.g !== g);
    else state.highlights.splice(idx, 1);
  }

  function pushUndo() {
    state.undoStack.push(state.highlights.map((h) => ({ ...h })));
    if (state.undoStack.length > 100) state.undoStack.shift();
  }

  // Rects currently being dragged (word range or freehand box), for live preview.
  function previewRects() {
    if (state.wordSel) return wordRangeRects(state.wordSel.anchor, state.wordSel.current);
    if (state.drag) {
      const d = normDrag(state.drag);
      return d ? [d] : [];
    }
    return [];
  }

  let raf = 0;
  function scheduleRender() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; render(); });
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.layout) return;
    const p = toCanvas(e);
    if (!inImage(p)) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    state.hoverWord = -1;
    state.downAt = p;
    const wi = wordAt(p);
    if (wi >= 0 && hitHighlight(p) < 0) {
      state.wordSel = { anchor: wi, current: wi };
    } else {
      state.drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    }
    scheduleRender();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!state.layout) return;
    const p = toCanvas(e);
    if (state.wordSel) {
      const wi = nearestWord(p);
      if (wi >= 0 && wi !== state.wordSel.current) {
        state.wordSel.current = wi;
        scheduleRender();
      }
      return;
    }
    if (state.drag) {
      state.drag.x1 = p.x;
      state.drag.y1 = p.y;
      scheduleRender();
      return;
    }
    const over = inImage(p);
    const onHl = over && hitHighlight(p) >= 0;
    const wi = over && !onHl ? wordAt(p) : -1;
    canvas.classList.toggle('over-image', over && !onHl && wi < 0);
    canvas.classList.toggle('over-highlight', onHl);
    canvas.classList.toggle('over-word', wi >= 0);
    if (wi !== state.hoverWord) {
      state.hoverWord = wi;
      scheduleRender();
    }
  });

  canvas.addEventListener('pointerleave', () => {
    if (state.hoverWord !== -1 && !state.wordSel) {
      state.hoverWord = -1;
      scheduleRender();
    }
  });

  function endInteraction() {
    const L = state.layout;
    if (state.wordSel) {
      const rects = wordRangeRects(state.wordSel.anchor, state.wordSel.current);
      state.wordSel = null;
      if (rects.length) {
        pushUndo();
        const g = state.groupSeq++;
        for (const r of rects) state.highlights.push({ ...r, g });
      }
    } else if (state.drag) {
      const d = state.drag;
      state.drag = null;
      const moved = Math.abs(d.x1 - d.x0) > 6 * L.u || Math.abs(d.y1 - d.y0) > 6 * L.u;
      if (!moved) {
        const idx = hitHighlight({ x: d.x0, y: d.y0 });
        if (idx >= 0) removeHighlightAt(idx);
      } else {
        const n = normDrag(d);
        if (n && n.w * L.iw > 4 && n.h * L.ih > 4) {
          pushUndo();
          state.highlights.push(n);
        }
      }
    }
    render();
  }
  canvas.addEventListener('pointerup', endInteraction);
  canvas.addEventListener('pointercancel', () => { state.drag = null; state.wordSel = null; render(); });

  function undo() {
    if (!state.undoStack.length) { toast('Nothing to undo'); return; }
    state.highlights = state.undoStack.pop();
    render();
  }

  // ---------- Controls ----------
  let savePrefsTimer = 0;
  function savePrefs() {
    clearTimeout(savePrefsTimer);
    savePrefsTimer = setTimeout(() => {
      const prefs = {};
      for (const k of Object.keys(DEFAULT_PREFS)) prefs[k] = state[k];
      chrome.storage.sync.set(prefs).catch(() => {});
    }, 400);
  }

  function updateHueLabel() {
    $('hueValue').textContent = Math.round(((state.hue % 360) + 360) % 360) + '°';
  }

  function swatchPreview(sw) {
    return `linear-gradient(135deg, hsl(${sw.h}, ${sw.s * 0.9}%, 16%), hsl(${sw.h + 18}, ${sw.s}%, 30%))`;
  }

  function buildSwatches() {
    const box = $('swatches');
    box.textContent = '';
    const auto = document.createElement('button');
    auto.type = 'button';
    auto.className = 'swatch auto';
    auto.dataset.swatch = 'auto';
    auto.title = state.brand ? 'Auto: colors from this site' : 'Auto: colors from the site (none found here, using Plum)';
    auto.setAttribute('role', 'radio');
    auto.setAttribute('aria-label', 'Auto, colors from the site');
    auto.textContent = 'A';
    if (state.brand) {
      const c = hexToHsl(state.brand.hex);
      auto.style.background = `linear-gradient(135deg, hsl(${c.h}, ${c.s}%, ${Math.max(6, c.l - 10)}%), ${state.brand.hex})`;
    }
    auto.addEventListener('click', () => {
      setSwatch('auto');
      applyAuto();
      $('hue').value = String(Math.round(state.hue));
      updateHueLabel();
      render();
      savePrefs();
    });
    box.appendChild(auto);
    for (const sw of SWATCHES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.dataset.swatch = sw.id;
      b.title = sw.name;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', sw.name);
      b.style.background = swatchPreview(sw);
      b.addEventListener('click', () => {
        state.exact = '';
        state.hue = sw.h;
        state.sat = sw.s;
        state.hlHue = sw.hl != null ? sw.hl : null;
        if (state.tone !== 'deep' && state.tone !== 'rich' && state.tone !== 'soft') setTone('deep');
        setSwatch(sw.id);
        $('hue').value = String(sw.h);
        updateHueLabel();
        render();
        savePrefs();
      });
      box.appendChild(b);
    }
    // Custom color (native picker; accepts any hex, e.g. a brand color)
    const label = document.createElement('label');
    label.className = 'swatch custom';
    label.title = 'Custom color';
    const input = document.createElement('input');
    input.type = 'color';
    input.id = 'customColor';
    input.setAttribute('aria-label', 'Custom color');
    input.value = state.exact || '#0070ad';
    input.addEventListener('input', () => {
      const c = hexToHsl(input.value);
      if (!c) return;
      state.exact = input.value;
      state.hue = c.h;
      state.sat = clamp(c.s, 4, 60);
      state.hlHue = c.s < 12 ? 45 : null;
      setSwatch('custom');
      $('hue').value = String(Math.round(c.h));
      updateHueLabel();
      scheduleRender();
      savePrefs();
    });
    label.appendChild(input);
    box.appendChild(label);
  }

  function setSwatch(id) {
    state.swatch = id;
    document.querySelectorAll('#swatches .swatch').forEach((el) => {
      const on = (el.dataset.swatch || 'custom') === id;
      el.setAttribute('aria-checked', String(on));
      el.classList.toggle('active', on);
    });
    if (id === 'custom' && state.exact) {
      const lab = document.querySelector('#swatches .swatch.custom');
      if (lab) lab.style.background = state.exact;
    }
  }

  function setTone(name) {
    state.tone = name;
    document.querySelectorAll('.segmented button').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.tone === name));
    });
  }

  function bindUI() {
    const hue = $('hue');
    hue.value = String(state.hue % 360);
    updateHueLabel();
    hue.addEventListener('input', () => {
      state.hue = Number(hue.value);
      state.exact = '';
      state.hlHue = null;
      if (state.sat < 22) state.sat = 32; // gray presets: make the slider visibly do something
      setSwatch('');
      updateHueLabel();
      scheduleRender();
      savePrefs();
    });

    setTone(state.tone);
    document.querySelectorAll('.segmented button').forEach((b) => {
      b.addEventListener('click', () => {
        setTone(b.dataset.tone);
        if (state.exact) { const c = hexToHsl(state.exact); state.exact = ''; if (c) { state.hue = c.h; state.sat = clamp(c.s, 4, 60); } setSwatch(''); }
        render();
        savePrefs();
      });
    });

    buildSwatches();
    setSwatch(state.swatch);

    document.querySelectorAll('.texture-grid button').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.texture === state.texture));
      b.addEventListener('click', () => {
        state.texture = b.dataset.texture;
        document.querySelectorAll('.texture-grid button').forEach((o) => o.setAttribute('aria-checked', String(o === b)));
        render();
        savePrefs();
      });
    });

    const drift = $('drift');
    drift.addEventListener('change', () => {
      state.drift = drift.checked;
      if (state.drift) startDrift();
    });

    const hlAlpha = $('hlAlpha');
    hlAlpha.value = String(state.highlightAlpha);
    hlAlpha.addEventListener('input', () => {
      state.highlightAlpha = Number(hlAlpha.value);
      scheduleRender();
      savePrefs();
    });

    $('undoBtn').addEventListener('click', undo);
    $('clearBtn').addEventListener('click', () => {
      if (!state.highlights.length) return;
      pushUndo();
      state.highlights = [];
      render();
    });

    const titleInput = $('titleInput');
    titleInput.value = state.title;
    titleInput.addEventListener('input', () => {
      state.title = titleInput.value;
      relayout();
    });

    const domainInput = $('domainInput');
    domainInput.value = state.domain;
    domainInput.addEventListener('input', () => {
      state.domain = domainInput.value;
      relayout();
    });

    bindCheck('showFavicon', () => relayout());
    bindCheck('torn', () => relayout());
    bindCheck('showQr', () => relayout());
    bindCheck('tighten', () => { useTrim(state.tighten); relayout(); });
    $('aboutBtn').addEventListener('click', () => {
      $('aboutVersion').textContent = 'Version ' + chrome.runtime.getManifest().version;
      $('about').showModal();
    });
    $('aboutClose').addEventListener('click', () => $('about').close());
    bindCheck('snapWords', () => { state.hoverWord = -1; updateHint(); render(); });

    $('downloadBtn').addEventListener('click', download);
    $('copyBtn').addEventListener('click', copy);
    $('downloadBtn').disabled = false;
    $('copyBtn').disabled = false;

    document.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const tag = (e.target && e.target.tagName) || '';
      const typing = tag === 'TEXTAREA' || tag === 'INPUT';
      const key = e.key.toLowerCase();
      if (key === 's') {
        // Always ours: never show the browser's "Save page as" dialog in the editor.
        e.preventDefault();
        download();
      } else if (key === 'z' && !typing) {
        e.preventDefault();
        undo();
      } else if (key === 'c' && !typing && !String(window.getSelection() || '')) {
        // ⌘C copies the card, unless you're copying text from a field.
        e.preventDefault();
        copy();
      }
    });
  }

  function bindCheck(id, onChange) {
    const box = $(id);
    box.checked = !!state[id];
    box.addEventListener('change', () => {
      state[id] = box.checked;
      onChange();
      savePrefs();
    });
  }

  function relayout() {
    computeLayout();
    render();
  }

  // "Infinite color slide": a slow, endless hue drift.
  let lastDrift = 0;
  function startDrift() {
    lastDrift = performance.now();
    const tick = (now) => {
      if (!state.drift) return;
      const dt = now - lastDrift;
      if (dt >= 50) { // ~20fps is plenty and keeps large canvases smooth
        if (state.exact) { state.exact = ''; setSwatch(''); }
        state.hue = (state.hue + dt * 0.012) % 360;
        $('hue').value = String(state.hue);
        updateHueLabel();
        render();
        lastDrift = now;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ---------- Export ----------
  function exportBlob() {
    render({ export: true });
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => {
        render(); // restore on-screen extras (hover outline)
        if (b) resolve(b); else reject(new Error('Could not create PNG'));
      }, 'image/png');
    });
  }

  function fileName() {
    const d = (state.domain || 'card').replace(/^www\./, '').replace(/[^a-z0-9.-]+/gi, '-');
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    return `oneshot-${d}-${ts}.png`;
  }

  async function download() {
    try {
      const blob = await exportBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName();
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('PNG downloaded');
    } catch (err) {
      console.error(err);
      toast('Download failed: ' + err.message);
    }
  }

  async function copy() {
    try {
      if (!navigator.clipboard || typeof ClipboardItem === 'undefined') throw new Error('Clipboard not available');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': exportBlob() })]);
      toast('Copied to clipboard');
    } catch (err) {
      console.error(err);
      toast('Copy failed: ' + err.message);
    }
  }

  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  function showEmpty(msg) {
    $('canvasWrap').hidden = true;
    $('hint').hidden = true;
    $('panel').hidden = true;
    if (msg) $('emptyMsg').textContent = msg;
    $('empty').hidden = false;
  }

  // ---------- Hand-drawn marker ----------
  function drawMarker(x, y, w, h, color, seed) {
    const rnd = mulberry32(seed || 7);
    const j = (a) => (rnd() - 0.5) * 2 * a;
    const sk = h * 0.18;
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = color;
    ctx.beginPath();
    const n = Math.max(4, Math.round(w / (h * 1.2)));
    ctx.moveTo(x + sk * 0.6 + j(h * 0.05), y + j(h * 0.05));
    for (let i = 1; i <= n; i++) ctx.lineTo(x + (w * i) / n, y + j(h * 0.06));
    ctx.lineTo(x + w + sk * 0.4 + j(h * 0.06), y + h * 0.35);           // chisel-tip end
    ctx.lineTo(x + w - sk * 0.2 + j(h * 0.06), y + h + j(h * 0.04));
    for (let i = n - 1; i >= 0; i--) ctx.lineTo(x + (w * i) / n, y + h + j(h * 0.06));
    ctx.lineTo(x - sk * 0.5 + j(h * 0.05), y + h * 0.7);
    ctx.closePath();
    ctx.fill();
    // Ink density: two faint streaks where the marker pressed harder
    ctx.globalAlpha = 0.28;
    for (const f of [0.12, 0.78]) {
      ctx.fillRect(x + w * 0.04 + j(h * 0.2), y + h * f, w * (0.82 + rnd() * 0.12), h * 0.1);
    }
    ctx.restore();
  }

  // ---------- Paper fibers ----------
  const fiberCache = { key: '', canvas: null };
  function drawFibers(L) {
    const w = Math.round(L.paperW), h = Math.round(L.paperH);
    const key = w + 'x' + h;
    if (fiberCache.key !== key) {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const x = c.getContext('2d');
      const rnd = mulberry32(99);
      const img = x.createImageData(w, h);
      const d = img.data;
      for (let i = 0; i < d.length; i += 4) {
        const v = rnd() < 0.5 ? 0 : 255;
        d[i] = d[i + 1] = d[i + 2] = v;
        d[i + 3] = rnd() * 10;
      }
      x.putImageData(img, 0, 0);
      x.strokeStyle = 'rgba(120,100,80,0.06)';
      x.lineWidth = 0.8;
      for (let i = 0; i < (w * h) / 9000; i++) {
        const px = rnd() * w, py = rnd() * h, len = 6 + rnd() * 16, a = rnd() * Math.PI;
        x.beginPath();
        x.moveTo(px, py);
        x.quadraticCurveTo(px + Math.cos(a) * len / 2 + rnd() * 3, py + Math.sin(a) * len / 2 + rnd() * 3,
          px + Math.cos(a) * len, py + Math.sin(a) * len);
        x.stroke();
      }
      fiberCache.key = key;
      fiberCache.canvas = c;
    }
    ctx.drawImage(fiberCache.canvas, L.paperX, L.paperY);
  }

  // ---------- Auto-tighten: trim to the content, even margins ----------
  function parseRgb(css) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css || '');
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [251, 249, 244];
  }

  function computeTrim(img, paper, pixelRatio) {
    try {
      const nw = img.naturalWidth, nh = img.naturalHeight;
      const c = document.createElement('canvas');
      c.width = nw; c.height = nh;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      const d = x.getImageData(0, 0, nw, nh).data;
      const [br, bg, bb] = parseRgb(paper);
      const differs = (i) => Math.abs(d[i] - br) + Math.abs(d[i + 1] - bg) + Math.abs(d[i + 2] - bb) > 60;
      const rowHas = (y) => { let n = 0; for (let xx = 0; xx < nw; xx++) if (differs((y * nw + xx) * 4) && ++n >= 2) return true; return false; };
      let top = 0; while (top < nh && !rowHas(top)) top++;
      if (top >= nh) return null; // blank capture
      let bottom = nh - 1; while (bottom > top && !rowHas(bottom)) bottom--;
      const colHas = (xx) => { let n = 0; for (let y = top; y <= bottom; y++) if (differs((y * nw + xx) * 4) && ++n >= 2) return true; return false; };
      let left = 0; while (left < nw && !colHas(left)) left++;
      let right = nw - 1; while (right > left && !colHas(right)) right--;
      if (right - left < 12 || bottom - top < 8) return null;
      const pad = Math.round(Math.max(10, 12 * pixelRatio));
      const t = { sx: left - pad, sy: top - pad, W: right - left + 1 + pad * 2, H: bottom - top + 1 + pad * 2, nw, nh };
      // Already tight? Leave it alone.
      if (Math.abs(t.W - nw) < 4 && Math.abs(t.H - nh) < 4) return null;
      return t;
    } catch (_) {
      return null;
    }
  }

  async function makeTrimmed(img, t) {
    const c = document.createElement('canvas');
    c.width = t.W; c.height = t.H;
    const x = c.getContext('2d');
    x.fillStyle = state.paper;
    x.fillRect(0, 0, t.W, t.H);
    x.drawImage(img, -t.sx, -t.sy);
    return loadImage(c.toDataURL('image/png'));
  }

  // Switch between the trimmed and original capture, keeping highlights and words in place.
  function useTrim(on) {
    const t = state.trim;
    const want = on && state.imgTrim ? state.imgTrim : state.imgOrig;
    if (!t || state.img === want) return;
    const toOrig = state.img === state.imgTrim;
    const mx = (v) => toOrig ? (v * t.W + t.sx) / t.nw : (v * t.nw - t.sx) / t.W;
    const my = (v) => toOrig ? (v * t.H + t.sy) / t.nh : (v * t.nh - t.sy) / t.H;
    const sw = toOrig ? t.W / t.nw : t.nw / t.W;
    const sh = toOrig ? t.H / t.nh : t.nh / t.H;
    state.highlights = state.highlights.map((h) => ({ ...h, x: mx(h.x), y: my(h.y), w: h.w * sw, h: h.h * sh }));
    state.ocr.words = state.ocr.words.map((w) => ({ ...w, x0: mx(w.x0), x1: mx(w.x1), y0: my(w.y0), y1: my(w.y1) }));
    state.undoStack = [];
    state.img = want;
  }

  // ---------- Publisher palette (the "Auto" swatch) ----------
  function parseColor(str) {
    const s = String(str || '').trim();
    let m = /^#([0-9a-f]{3})$/i.exec(s);
    if (m) return m[1].split('').map((ch) => parseInt(ch + ch, 16));
    m = /^#([0-9a-f]{6})/i.exec(s);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
    m = /rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(s);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }

  function rgbHsl([r, g, b]) {
    const hex = '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
    return hexToHsl(hex);
  }

  function hslHex(h, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
    return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  // A deep, card-friendly version of the brand color.
  function brandFrom(c, hl = null) {
    return { hex: hslHex(c.h, clamp(c.s, 30, 72), clamp(Math.min(c.l, 30), 14, 30)), hl };
  }

  function deriveBrand(themeColor, icon, iconIsSitesOwn) {
    // 1) The site's declared theme color, if it's a real color (not white/black/gray)
    const tc = parseColor(themeColor);
    if (tc) {
      const c = rgbHsl(tc);
      if (c.s >= 25 && c.l >= 10 && c.l <= 80) return brandFrom(c);
    }
    // 2) The dominant color of the site's icon
    if (!icon) return null;
    try {
      const N = 32, cv = document.createElement('canvas');
      cv.width = N; cv.height = N;
      const x = cv.getContext('2d', { willReadFrequently: true });
      x.drawImage(icon, 0, 0, N, N);
      const d = x.getImageData(0, 0, N, N).data;
      const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
      let opaque = 0, colorful = 0, darkSum = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < 180) continue;
        opaque++;
        const c = rgbHsl([d[i], d[i + 1], d[i + 2]]);
        darkSum += c.l;
        if (c.s < 30 || c.l < 15 || c.l > 85) continue;
        colorful++;
        const bin = bins[Math.floor(c.h / 30) % 12];
        bin.w += c.s; bin.r += d[i]; bin.g += d[i + 1]; bin.b += d[i + 2];
      }
      if (!opaque) return null;
      if (colorful >= opaque * 0.04) {
        const best = bins.reduce((a, b) => (b.w > a.w ? b : a));
        // Average color of the strongest hue family
        const pix = [];
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] < 180) continue;
          const c = rgbHsl([d[i], d[i + 1], d[i + 2]]);
          if (c.s >= 30 && c.l >= 15 && c.l <= 85 && bins[Math.floor(c.h / 30) % 12] === best) pix.push([d[i], d[i + 1], d[i + 2]]);
        }
        const avg = [0, 1, 2].map((k) => Math.round(pix.reduce((s, p) => s + p[k], 0) / pix.length));
        return brandFrom(rgbHsl(avg));
      }
      // A black-and-white logo (common for newspapers): a warm charcoal suits it.
      if (iconIsSitesOwn && darkSum / opaque < 45) return { hex: hslHex(30, 4, 20), hl: 45 };
      return null;
    } catch (_) {
      return null;
    }
  }

  function applyAuto() {
    if (state.brand) {
      const c = hexToHsl(state.brand.hex);
      state.exact = state.brand.hex;
      state.hue = c.h;
      state.sat = clamp(c.s, 4, 60);
      state.hlHue = state.brand.hl;
    } else {
      state.exact = '';
      state.hue = 270;
      state.sat = 32;
      state.hlHue = null;
    }
  }

  // ---------- Init ----------
  // Shared by the editor and the quick-mode renderer.
  async function prepare(id, data, prefs) {
    Object.assign(state, DEFAULT_PREFS);
    for (const k of Object.keys(DEFAULT_PREFS)) {
      if (prefs && prefs[k] !== undefined) state[k] = prefs[k];
    }
    if (!['deep', 'rich', 'soft'].includes(state.tone)) state.tone = 'deep';

    state.capture = data;
    state.captureId = id;
    state.seed = hashStr(id);
    state.title = data.title || '';
    state.domain = hostname(data.url);
    state.published = formatPublished(data.publishedAt);
    state.qr = buildQr(data.url);
    state.highlights = [];
    state.imgOrig = await loadImage(data.image);
    state.paper = samplePaper(state.imgOrig);

    // Site icon: the one fetched at capture time, else Chrome's icon service, else a letter badge.
    state.favicon = null;
    if (data.favicon) state.favicon = await loadImage(data.favicon).catch(() => null);
    const fetched = !!state.favicon;
    if (!state.favicon && data.url) state.favicon = await loadImage(faviconSrc(data.url)).catch(() => null);

    // Chrome's icon service returns a gray globe for unknown sites, so a black-and-white
    // reading only counts when the icon came from the site itself.
    state.brand = deriveBrand(data.themeColor, state.favicon, fetched);
    if (state.swatch === 'auto') applyAuto();

    state.trim = computeTrim(state.imgOrig, state.paper, data.pixelRatio || 1);
    state.imgTrim = state.trim ? await makeTrimmed(state.imgOrig, state.trim) : null;
    state.img = (state.tighten && state.imgTrim) || state.imgOrig;
  }

  // Quick mode: this page runs offscreen, renders a finished card on request,
  // and hands back the PNG. No editor UI, no text detection.
  function startRenderer() {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || msg.type !== 'OSR_RENDER') return false;
      (async () => {
        await prepare(msg.id, msg.data, msg.prefs || {});
        computeLayout();
        render({ export: true });
        return canvas.toDataURL('image/png');
      })().then(
        (png) => sendResponse({ ok: true, png }),
        (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
      );
      return true;
    });
  }

  async function init() {
    const id = new URLSearchParams(location.search).get('id');
    if (!id) { showEmpty(); return; }

    const stored = await chrome.storage.local.get(id);
    const data = stored[id];
    if (!data || !data.image) {
      showEmpty('This capture is no longer available. Only the most recent captures are kept. Capture the area again.');
      return;
    }

    const prefs = await chrome.storage.sync.get(DEFAULT_PREFS).catch(() => DEFAULT_PREFS);
    document.title = 'OneShot Redux: ' + (hostname(data.url) || 'Editor');

    try {
      await prepare(id, data, prefs);
    } catch (_) {
      showEmpty('The captured image could not be loaded. Please capture again.');
      return;
    }

    bindUI();
    computeLayout();
    render();
    runOCR();
  }

  if (new URLSearchParams(location.search).has('render')) {
    startRenderer();
  } else {
    init().catch((err) => {
      console.error(err);
      showEmpty('Something went wrong opening this capture: ' + err.message);
    });
  }
})();
