/* =====================================================================
   TRAZO · Motor de caligrafía
   Sintropía Social
   - Binariza imágenes de manuscrito (normaliza iluminación de fotos)
   - Segmenta glifos, los agrupa por renglón y los alinea con la
     transcripción para etiquetarlos
   - Vectoriza cada glifo (contornos + curvas cuadráticas)
   - Construye la tipografía (OTF / TTF / WOFF / WOFF2)
   - Genera y lee la plantilla de captura (marcas de registro)
   Requiere: lib/trazo-fontlib.js (opentype.js + fonteditor-core)
   ===================================================================== */
(function (global) {
  'use strict';

  const T = {};
  const EM = 1000;
  const CAP_UNITS = 700;     // altura de mayúsculas objetivo
  const XH_UNITS = 380;      // altura de x objetivo (modo libre)

  // ---------- Juego de caracteres de la plantilla (100 casillas) ----------
  T.CHARSET = [
    ...'ABCDEFGHIJKLMNÑOPQRSTUVWXYZ',
    ...'abcdefghijklmnñopqrstuvwxyz',
    ...'áéíóúüÁÉÍÓÚ',
    ...'0123456789',
    ...'.,;:¿?¡!()"\'-/@#$%&+=*_«»'
  ];
  T.LOWER_X = new Set([...'acemnorsuvwxzñ']);      // sin ascendentes ni descendentes
  T.DESC = new Set([...'gjpqyçÇ,;()/_']);
  T.isLetterOrDigit = c => /[\p{L}\p{N}]/u.test(c);

  // ===================================================================
  //  Utilidades de imagen
  // ===================================================================
  T.loadImage = function (src) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = src;
    });
  };

  T.imageToCanvas = function (img, maxDim) {
    maxDim = maxDim || 2400;
    const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
    const s = Math.min(1, maxDim / Math.max(w0, h0));
    const c = document.createElement('canvas');
    c.width = Math.round(w0 * s); c.height = Math.round(h0 * s);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c;
  };

  // Mapa de tinta 0..1 (0 = papel, 1 = tinta) con normalización de iluminación
  T.inkMap = function (canvas, normalize) {
    const w = canvas.width, h = canvas.height;
    const d = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const lum = new Float32Array(w * h);
    for (let i = 0, j = 0; i < lum.length; i++, j += 4) {
      lum[i] = (0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]) / 255;
    }
    if (normalize !== false) {
      // fondo estimado: máximo local en baja resolución + suavizado
      const s = 8, bw = Math.ceil(w / s), bh = Math.ceil(h / s);
      const small = new Float32Array(bw * bh);
      for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
        let m = 0;
        for (let y = by * s; y < Math.min(h, by * s + s); y++)
          for (let x = bx * s; x < Math.min(w, bx * s + s); x++) { const v = lum[y * w + x]; if (v > m) m = v; }
        small[by * bw + bx] = m;
      }
      const dil = maxFilter(small, bw, bh, 3);
      const bg = boxBlur(dil, bw, bh, 3);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const b = Math.max(0.25, bilinear(bg, bw, bh, x / s - 0.5, y / s - 0.5));
        lum[y * w + x] = Math.min(1, lum[y * w + x] / b);
      }
    }
    const ink = new Float32Array(w * h);
    for (let i = 0; i < ink.length; i++) ink[i] = 1 - lum[i];
    return { ink, w, h };
  };

  function maxFilter(a, w, h, r) {
    const o = new Float32Array(a.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = 0;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++)
        for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) if (a[yy * w + xx] > m) m = a[yy * w + xx];
      o[y * w + x] = m;
    }
    return o;
  }
  function boxBlur(a, w, h, r) {
    const o = new Float32Array(a.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let yy = Math.max(0, y - r); yy <= Math.min(h - 1, y + r); yy++)
        for (let xx = Math.max(0, x - r); xx <= Math.min(w - 1, x + r); xx++) { s += a[yy * w + xx]; n++; }
      o[y * w + x] = s / n;
    }
    return o;
  }
  function bilinear(a, w, h, x, y) {
    x = Math.max(0, Math.min(w - 1, x)); y = Math.max(0, Math.min(h - 1, y));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    return a[y0 * w + x0] * (1 - fx) * (1 - fy) + a[y0 * w + x1] * fx * (1 - fy) + a[y1 * w + x0] * (1 - fx) * fy + a[y1 * w + x1] * fx * fy;
  }

  T.otsu = function (ink) {
    const hist = new Array(256).fill(0);
    for (let i = 0; i < ink.length; i++) hist[Math.min(255, Math.max(0, Math.round(ink[i] * 255)))]++;
    const total = ink.length;
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, t = 128;
    for (let i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; t = i; }
    }
    return Math.min(0.6, Math.max(0.25, t / 255));
  };

  // Componentes conexos (8-conectividad)
  T.components = function (mask, w, h) {
    const lab = new Int32Array(w * h);
    const parent = [0];
    const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
    let next = 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; if (!mask[i]) continue;
      const nb = [];
      if (x > 0 && lab[i - 1]) nb.push(lab[i - 1]);
      if (y > 0) {
        if (lab[i - w]) nb.push(lab[i - w]);
        if (x > 0 && lab[i - w - 1]) nb.push(lab[i - w - 1]);
        if (x < w - 1 && lab[i - w + 1]) nb.push(lab[i - w + 1]);
      }
      if (!nb.length) { lab[i] = next; parent.push(next); next++; }
      else { let m = nb[0]; for (const n of nb) if (n < m) m = n; lab[i] = m; for (const n of nb) unite(m, n); }
    }
    const map = new Map(); const comps = [];
    for (let i = 0; i < lab.length; i++) {
      if (!lab[i]) continue;
      const r = find(lab[i]);
      let id = map.get(r);
      if (id === undefined) { id = comps.length + 1; map.set(r, id); comps.push({ id, minx: 1e9, miny: 1e9, maxx: -1, maxy: -1, area: 0, edge: 0 }); }
      lab[i] = id;
      const c = comps[id - 1], x = i % w, y = (i / w) | 0;
      if (x < c.minx) c.minx = x; if (x > c.maxx) c.maxx = x; if (y < c.miny) c.miny = y; if (y > c.maxy) c.maxy = y; c.area++;
    }
    // perímetro aproximado para estimar grosor de trazo
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, l = lab[i]; if (!l) continue;
      if (x === 0 || !lab[i - 1] || x === w - 1 || !lab[i + 1] || y === 0 || !lab[i - w] || y === h - 1 || !lab[i + w]) comps[l - 1].edge++;
    }
    for (const c of comps) { c.w = c.maxx - c.minx + 1; c.h = c.maxy - c.miny + 1; c.cx = (c.minx + c.maxx) / 2; c.cy = (c.miny + c.maxy) / 2; }
    return { labels: lab, comps };
  };

  const median = a => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  T.median = median;

  // ===================================================================
  //  Segmentación de manuscrito libre
  // ===================================================================
  /**
   * @param canvas  imagen de la página
   * @param opts    { lineBoxes: [{y0,y1,x0,x1,texto}] en píxeles (opcional) }
   * @returns {page, glyphs, lines, stroke}
   */
  T.segmentPage = function (canvas, opts) {
    opts = opts || {};
    const { ink, w, h } = T.inkMap(canvas, true);
    const t = T.otsu(ink);
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < ink.length; i++) mask[i] = ink[i] > t ? 1 : 0;
    const { labels, comps } = T.components(mask, w, h);

    // grosor de trazo ≈ área / (perímetro / 2)
    let A = 0, P = 0; for (const c of comps) { if (c.area > 20) { A += c.area; P += c.edge; } }
    const stroke = P ? Math.max(1.5, 2 * A / P) : 3;
    const minArea = Math.max(6, stroke * stroke * 0.6);
    // descarta ruido y marcos/rayas enormes
    let cs = comps.filter(c => c.area >= minArea && c.w < w * 0.6 && c.h < h * 0.35);
    const medH = median(cs.filter(c => c.h > stroke * 2.5).map(c => c.h)) || 20;
    cs = cs.filter(c => !(c.w > medH * 12 && c.h < stroke * 3)); // rayas/subrayados largos

    // ---- renglones ----
    let lines = [];
    if (opts.lineBoxes && opts.lineBoxes.length) {
      lines = opts.lineBoxes.map((b, i) => ({ idx: i, box: b, texto: b.texto || '', comps: [] }));
      for (const c of cs) {
        let best = null, bd = 1e9;
        for (const L of lines) {
          const b = L.box, bh = b.y1 - b.y0, padY = bh * 0.25, padX = (b.x1 - b.x0) * 0.04 + medH;
          if (c.cx < b.x0 - padX || c.cx > b.x1 + padX) continue;
          let d = 0;
          if (c.cy < b.y0 - padY) d = b.y0 - padY - c.cy; else if (c.cy > b.y1 + padY) d = c.cy - (b.y1 + padY);
          const dc = Math.abs(c.cy - (b.y0 + b.y1) / 2) / bh;
          const score = d * 10 + dc;
          if (d < bh * 0.6 && score < bd) { bd = score; best = L; }
        }
        if (best) best.comps.push(c);
      }
    } else {
      // perfil de proyección con el "núcleo" vertical de cada componente
      const cov = new Float32Array(h);
      for (const c of cs) {
        if (c.h <= stroke * 1.5) continue;
        const a = Math.max(0, Math.round(c.cy - c.h * 0.22)), b = Math.min(h - 1, Math.round(c.cy + c.h * 0.22));
        for (let y = a; y <= b; y++) cov[y] += c.w;
      }
      const bands = []; let cur = null;
      for (let y = 0; y < h; y++) {
        if (cov[y] > 0) { if (!cur) cur = { y0: y, y1: y, m: 0 }; cur.y1 = y; cur.m += cov[y]; }
        else if (cur) { bands.push(cur); cur = null; }
      }
      if (cur) bands.push(cur);
      // une bandas muy cercanas (mismo renglón)
      const merged = [];
      for (const b of bands) {
        const p = merged[merged.length - 1];
        if (p && b.y0 - p.y1 < medH * 0.35) { p.y1 = b.y1; p.m += b.m; } else merged.push({ ...b });
      }
      const strong = merged.filter(b => b.m > medH * medH * 0.5);
      lines = strong.map((b, i) => ({ idx: i, cy: (b.y0 + b.y1) / 2, comps: [], texto: '' }));
      for (const c of cs) {
        let best = null, bd = 1e9;
        for (const L of lines) { const d = Math.abs(L.cy - c.cy); if (d < bd) { bd = d; best = L; } }
        if (best && bd < medH * 1.3) best.comps.push(c);
      }
      lines = lines.filter(L => L.comps.length);
      lines.forEach((L, i) => L.idx = i);
    }

    // ---- agrupar componentes en glifos (puntos de i/j, acentos, ñ, :, ;) ----
    const glyphs = [];
    for (const L of lines) {
      if (!L.comps.length) { L.glyphs = []; continue; }
      const lh = median(L.comps.map(c => c.h)) || medH;
      let groups = L.comps.map(c => ({ comps: [c], minx: c.minx, maxx: c.maxx, miny: c.miny, maxy: c.maxy }));
      let changed = true;
      while (changed) {
        changed = false;
        outer: for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
          const a = groups[i], b = groups[j];
          const ov = Math.min(a.maxx, b.maxx) - Math.max(a.minx, b.minx);
          const minW = Math.min(a.maxx - a.minx, b.maxx - b.minx) + 1;
          const ha = a.maxy - a.miny + 1, hb = b.maxy - b.miny + 1;
          const smallOne = Math.min(ha, hb) < lh * 0.6;
          const vgap = Math.max(a.miny, b.miny) - Math.min(a.maxy, b.maxy);
          if (ov / minW >= 0.45 && smallOne && vgap < lh * 1.1) {
            a.comps.push(...b.comps); a.minx = Math.min(a.minx, b.minx); a.maxx = Math.max(a.maxx, b.maxx);
            a.miny = Math.min(a.miny, b.miny); a.maxy = Math.max(a.maxy, b.maxy);
            groups.splice(j, 1); changed = true; break outer;
          }
        }
      }
      groups.sort((a, b) => (a.minx + a.maxx) - (b.minx + b.maxx));
      // espacios entre palabras
      const gaps = [];
      for (let i = 0; i < groups.length - 1; i++) gaps.push(groups[i + 1].minx - groups[i].maxx);
      const mg = median(gaps.filter(g => g > 0)) || stroke;
      const thr = Math.max(mg * 2.2 + 1, lh * 0.38);
      let word = 0;
      L.glyphs = groups.map((g, i) => {
        if (i > 0 && gaps[i - 1] > thr) word++;
        const gl = {
          id: glyphs.length, line: L.idx, word, comps: g.comps.map(c => c.id),
          minx: g.minx, maxx: g.maxx, miny: g.miny, maxy: g.maxy,
          w: g.maxx - g.minx + 1, h: g.maxy - g.miny + 1,
          label: null, conf: 0, source: '', wide: false
        };
        glyphs.push(gl); return gl;
      });
      L.wordGaps = gaps.filter(g => g > thr);
      L.lh = lh;
      const mw = median(L.glyphs.map(g => g.w));
      for (const g of L.glyphs) g.wide = g.w > mw * 2.1 && g.w > g.h * 1.3; // posible letra ligada (cursiva)
    }
    return { page: { canvas, ink, w, h, t, labels, stroke }, glyphs, lines };
  };

  // Limpia el texto de una línea de transcripción (marcas de duda, ilegible)
  T.cleanLine = function (s) {
    return String(s || '')
      .replace(/\{\{[^:}]+:([^}]*)\}\}/g, '$1')
      .replace(/\[ilegible\]/gi, ' ')
      .replace(/\s+/g, ' ').trim();
  };

  // Alinea glifos con el texto del renglón (por renglón completo o por palabra)
  T.alignLines = function (seg) {
    let aligned = 0;
    for (const L of seg.lines) {
      const txt = T.cleanLine(L.texto);
      if (!txt || !L.glyphs.length) continue;
      const chars = [...txt].filter(c => c !== ' ');
      if (chars.length === L.glyphs.length) {
        L.glyphs.forEach((g, i) => { g.label = chars[i]; g.conf = 0.9; g.source = 'alineación'; });
        aligned += chars.length; continue;
      }
      const words = txt.split(' ');
      const gw = [];
      for (const g of L.glyphs) (gw[g.word] = gw[g.word] || []).push(g);
      if (words.length === gw.length) {
        words.forEach((wd, k) => {
          const cc = [...wd];
          if (cc.length === gw[k].length) { gw[k].forEach((g, i) => { g.label = cc[i]; g.conf = 0.8; g.source = 'alineación'; }); aligned += cc.length; }
        });
      }
    }
    return aligned;
  };

  // Recorte de un glifo como canvas (para revisión visual)
  T.glyphCanvas = function (seg, g, size) {
    size = size || 96;
    const { ink, w, labels } = seg.page;
    const set = new Set(g.comps);
    const pad = 3;
    const x0 = Math.max(0, g.minx - pad), y0 = Math.max(0, g.miny - pad);
    const x1 = Math.min(seg.page.w - 1, g.maxx + pad), y1 = Math.min(seg.page.h - 1, g.maxy + pad);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const ctx = c.getContext('2d'); const id = ctx.createImageData(cw, ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = (y0 + y) * w + (x0 + x), l = labels[i];
      const v = (l && set.has(l)) || (!l && ink[i] < seg.page.t) ? ink[i] : 0;
      const lum = Math.round(255 * (1 - v)), o = (y * cw + x) * 4;
      id.data[o] = id.data[o + 1] = id.data[o + 2] = lum; id.data[o + 3] = 255;
    }
    ctx.putImageData(id, 0, 0);
    const out = document.createElement('canvas'); out.width = out.height = size;
    const o2 = out.getContext('2d'); o2.fillStyle = '#fff'; o2.fillRect(0, 0, size, size);
    const s = Math.min((size - 8) / cw, (size - 8) / ch, 4);
    o2.imageSmoothingQuality = 'high';
    o2.drawImage(c, (size - cw * s) / 2, (size - ch * s) / 2, cw * s, ch * s);
    return out;
  };

  // Hoja de contactos numerada para que la IA etiquete glifos
  T.contactSheet = function (seg, glyphList, cols) {
    cols = cols || 8;
    const cell = 110, rows = Math.ceil(glyphList.length / cols);
    const c = document.createElement('canvas'); c.width = cols * cell; c.height = rows * cell;
    const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    glyphList.forEach((g, i) => {
      const x = (i % cols) * cell, y = Math.floor(i / cols) * cell;
      ctx.drawImage(T.glyphCanvas(g.seg || seg, g, 90), x + 10, y + 16, 90, 90);
      ctx.strokeStyle = '#bbbbbb'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, cell - 1, cell - 1);
      ctx.fillStyle = '#d00000'; ctx.font = 'bold 15px Arial'; ctx.fillText(String(i + 1), x + 4, y + 15);
    });
    return c;
  };

  // ---- Métricas por renglón: línea base (regresión) y altura de x ----
  T.lineMetrics = function (seg) {
    for (const L of seg.lines) {
      const gs = L.glyphs;
      if (!gs.length) continue;
      const base = gs.filter(g => g.label && !T.DESC.has(g.label) && T.isLetterOrDigit(g.label));
      const pts = (base.length >= 2 ? base : gs).map(g => [(g.minx + g.maxx) / 2, g.maxy + 0.5]);
      // regresión robusta simple: ajusta, descarta residuos grandes, reajusta
      let fit = linfit(pts);
      const res = pts.map(p => Math.abs(p[1] - (fit.a + fit.b * p[0])));
      const mr = median(res) || 1;
      const keep = pts.filter((p, i) => res[i] <= mr * 2.5 + 1);
      if (keep.length >= 2) fit = linfit(keep);
      if (Math.abs(fit.b) > 0.25) fit = { a: median(pts.map(p => p[1])), b: 0 };
      L.baseline = x => fit.a + fit.b * x;
      const xs = gs.filter(g => g.label && T.LOWER_X.has(g.label)).map(g => g.h);
      const caps = gs.filter(g => g.label && /[A-ZÑ0-9bdfhklt]/.test(g.label)).map(g => g.h);
      let xh = median(xs);
      if (!xh && caps.length) xh = median(caps) * 0.55;
      if (!xh) xh = median(gs.map(g => g.h)) * 0.62;
      L.xh = Math.max(4, xh);
      L.scale = XH_UNITS / L.xh; // unidades por píxel
    }
  };
  function linfit(pts) {
    const n = pts.length; if (n === 1) return { a: pts[0][1], b: 0 };
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const den = n * sxx - sx * sx; if (Math.abs(den) < 1e-9) return { a: sy / n, b: 0 };
    const b = (n * sxy - sx * sy) / den; return { a: (sy - b * sx) / n, b };
  }

  // Elige la mejor instancia de cada carácter (la más típica)
  T.pickInstances = function (glyphs) {
    const by = new Map();
    for (const g of glyphs) if (g.label && g.label !== '∅' && [...g.label].length === 1 && !g.excluded) (by.get(g.label) || by.set(g.label, []).get(g.label)).push(g);
    const chosen = new Map();
    for (const [ch, list] of by) {
      if (list.some(g => g.chosen)) { chosen.set(ch, list.find(g => g.chosen)); continue; }
      const mh = median(list.map(g => g.h)), mw = median(list.map(g => g.w));
      let best = list[0], bd = 1e9;
      for (const g of list) { const d = Math.abs(g.h - mh) / mh + Math.abs(g.w - mw) / mw - g.conf * 0.3; if (d < bd) { bd = d; best = g; } }
      chosen.set(ch, best);
    }
    return { chosen, byChar: by };
  };

  // ===================================================================
  //  Vectorización
  // ===================================================================
  // Rastrea contornos de una máscara binaria (bordes de píxel).
  // Contorno exterior y huecos quedan con orientación opuesta.
  T.trace = function (b, w, h) {
    const W1 = w + 1;
    const out = new Map(); // vértice -> [aristas]
    const edges = [];
    const add = (x0, y0, x1, y1) => {
      const e = { a: y0 * W1 + x0, b: y1 * W1 + x1, dx: x1 - x0, dy: y1 - y0, used: false };
      edges.push(e); const k = e.a; if (!out.has(k)) out.set(k, []); out.get(k).push(e);
    };
    const B = (x, y) => x >= 0 && y >= 0 && x < w && y < h && b[y * w + x];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!b[y * w + x]) continue;
      if (!B(x, y - 1)) add(x, y, x + 1, y);
      if (!B(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!B(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!B(x - 1, y)) add(x, y + 1, x, y);
    }
    const loops = [];
    for (const e0 of edges) {
      if (e0.used) continue;
      const pts = []; let e = e0;
      while (e && !e.used) {
        e.used = true; pts.push([e.a % W1, (e.a / W1) | 0]);
        const cand = (out.get(e.b) || []).filter(n => !n.used);
        if (!cand.length) break;
        if (cand.length === 1) e = cand[0];
        else { // silla: girar a la derecha
          const rx = -e.dy, ry = e.dx;
          e = cand.find(n => n.dx === rx && n.dy === ry) || cand[0];
        }
      }
      if (pts.length >= 4) loops.push(pts);
    }
    return loops;
  };

  function dropCollinear(p) {
    const r = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[(i - 1 + p.length) % p.length], b = p[i], c = p[(i + 1) % p.length];
      if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) !== 0) r.push(b);
    }
    return r;
  }
  function midpoints(p) { return p.map((a, i) => { const b = p[(i + 1) % p.length]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }); }
  function rdp(pts, eps) {
    if (pts.length < 3) return pts;
    const [a, b] = [pts[0], pts[pts.length - 1]];
    let dmax = 0, idx = 0;
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + b[0] * a[1] - b[1] * a[0]) / L;
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > eps) { const l = rdp(pts.slice(0, idx + 1), eps), r = rdp(pts.slice(idx), eps); return l.slice(0, -1).concat(r); }
    return [a, b];
  }
  function rdpClosed(p, eps) {
    if (p.length < 6) return p;
    let far = 0, fd = 0;
    for (let i = 1; i < p.length; i++) { const d = Math.hypot(p[i][0] - p[0][0], p[i][1] - p[0][1]); if (d > fd) { fd = d; far = i; } }
    const a = rdp(p.slice(0, far + 1), eps), b = rdp(p.slice(far).concat([p[0]]), eps);
    return a.slice(0, -1).concat(b.slice(0, -1));
  }
  const polyArea = p => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
  T.polyArea = polyArea;

  // Polígono -> contorno cuadrático (semántica TrueType: on/off)
  function toQuadContour(p) {
    const n = p.length;
    const pts = p.map((b, i) => {
      const a = p[(i - 1 + n) % n], c = p[(i + 1) % n];
      const v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
      const l1 = Math.hypot(...v1) || 1, l2 = Math.hypot(...v2) || 1;
      const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2);
      return { x: b[0], y: b[1], on: cos < 0.42 }; // giro > ~65° = esquina
    });
    const seq = [];
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      seq.push(a);
      if (!a.on && !b.on) seq.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
    }
    let s = seq.findIndex(q => q.on);
    if (s < 0) return null;
    return seq.slice(s).concat(seq.slice(0, s));
  }

  /**
   * Vectoriza una región de tinta.
   * @param src  {ink, w, h, labels?, t}
   * @param g    {minx,miny,maxx,maxy, comps?}
   * @param map  (px, py) -> [X, Y] en unidades de fuente
   * @returns contornos [{x,y,on}]
   */
  T.vectorize = function (src, g, map) {
    const { ink, w, labels, t } = src;
    const set = g.comps ? new Set(g.comps) : null;
    const pad = 2;
    const x0 = Math.max(0, g.minx - pad), y0 = Math.max(0, g.miny - pad);
    const x1 = Math.min(src.w - 1, g.maxx + pad), y1 = Math.min(src.h - 1, g.maxy + pad);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    const crop = new Float32Array(cw * ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const i = (y0 + y) * w + (x0 + x);
      let v = ink[i];
      if (set && labels) { const l = labels[i]; if (l && !set.has(l)) v = 0; else if (!l && v >= t) v = 0; }
      crop[y * cw + x] = v;
    }
    const f = Math.max(1, Math.min(5, Math.round(220 / Math.max(ch, cw * 0.8))));
    const W = cw * f + 2, H = ch * f + 2;
    let up = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) up[y * W + x] = bilinear(crop, cw, ch, (x - 1) / f - 0.5 + 0.5 / f, (y - 1) / f - 0.5 + 0.5 / f);
    up = gauss3(gauss3(up, W, H), W, H);
    const bin = new Uint8Array(W * H);
    for (let i = 0; i < bin.length; i++) bin[i] = up[i] > t ? 1 : 0;
    const loops = T.trace(bin, W, H);
    const contours = [];
    for (const L of loops) {
      let p = dropCollinear(L);
      if (p.length < 3) continue;
      if (Math.abs(polyArea(p)) < 6 * f * f) continue;
      p = midpoints(p);
      p = rdpClosed(p, 0.55 + 0.1 * f);
      if (p.length < 3) continue;
      const fp = p.map(([x, y]) => map(x0 + (x - 1) / f, y0 + (y - 1) / f));
      const q = toQuadContour(fp);
      if (q) contours.push(q);
    }
    return contours;
  };
  function gauss3(a, w, h) {
    const t = new Float32Array(a.length), o = new Float32Array(a.length);
    for (let y = 0; y < h; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; t[i] = (a[i - 1] + 2 * a[i] + a[i + 1]) / 4; }
    for (let y = 1; y < h - 1; y++) for (let x = 0; x < w; x++) { const i = y * w + x; o[i] = (t[i - w] + 2 * t[i] + t[i + w]) / 4; }
    return o;
  }

  // Glifo libre -> contornos en unidades de fuente (x desde 0)
  T.glyphFromFree = function (seg, g) {
    const L = seg.lines[g.line];
    const s = L.scale, bl = L.baseline((g.minx + g.maxx) / 2);
    const contours = T.vectorize(seg.page, g, (px, py) => [(px - g.minx) * s, (bl - py) * s]);
    return finishGlyph(contours, seg.page.stroke * s);
  };

  function finishGlyph(contours, strokeUnits) {
    let minx = 1e9, maxx = -1e9, miny = 1e9, maxy = -1e9;
    for (const c of contours) for (const p of c) { minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x); miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y); }
    if (!contours.length) return null;
    for (const c of contours) for (const p of c) p.x -= minx;
    return { contours, width: maxx - minx, yMin: miny, yMax: maxy, stroke: strokeUnits };
  }

  // ===================================================================
  //  Plantilla de captura
  // ===================================================================
  // Geometría en mm (hoja carta 215.9 x 279.4)
  T.TPL = {
    page: [215.9, 279.4],
    markers: [[14, 14], [201.9, 14], [14, 265.4], [201.9, 265.4]], marker: 8,
    grid: { x: 22, y: 31, cols: 10, rows: 10, cw: 17.2, ch: 22.6 },
    box: { dx: 1, dy: 4.6, w: 15.2, h: 17.0 },
    guides: { cap: 0.18, x: 0.44, base: 0.70 }
  };

  T.templatePDF = function (jsPDF) {
    const P = T.TPL, doc = new jsPDF({ unit: 'mm', format: 'letter' });
    doc.setFillColor(0, 0, 0);
    for (const [x, y] of P.markers) doc.rect(x - P.marker / 2, y - P.marker / 2, P.marker, P.marker, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(107, 33, 245);
    doc.text('TRAZO  ·  Plantilla de caligrafía', 24, 15.5);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.8); doc.setTextColor(90, 90, 90);
    doc.text('Escribe un carácter por casilla con bolígrafo o plumón oscuro. Apoya las letras en la línea base (línea punteada inferior).', 24, 20.5);
    doc.text('Respeta las 4 marcas negras de las esquinas: deben verse completas en la foto o el escaneo.', 24, 24.2);
    const G = P.grid, Bx = P.box;
    T.CHARSET.forEach((ch, i) => {
      const cx = G.x + (i % G.cols) * G.cw, cy = G.y + Math.floor(i / G.cols) * G.ch;
      doc.setFontSize(7); doc.setTextColor(150, 150, 150);
      doc.text(ch === ' ' ? '␣' : ch, cx + Bx.dx + 0.6, cy + 3.4);
      doc.setDrawColor(205, 205, 205); doc.setLineWidth(0.2);
      doc.rect(cx + Bx.dx, cy + Bx.dy, Bx.w, Bx.h);
      doc.setDrawColor(225, 225, 225); doc.setLineDashPattern([0.6, 0.6], 0);
      for (const k of ['cap', 'x', 'base']) {
        const yy = cy + Bx.dy + Bx.h * P.guides[k];
        if (k === 'base') doc.setDrawColor(200, 200, 200); else doc.setDrawColor(228, 228, 228);
        doc.line(cx + Bx.dx + 0.4, yy, cx + Bx.dx + Bx.w - 0.4, yy);
      }
      doc.setLineDashPattern([], 0);
    });
    doc.setFontSize(7); doc.setTextColor(140, 140, 140);
    doc.text('Sintropía Social  ·  Trazo', 107.95, 274, { align: 'center' });
    return doc;
  };

  // Homografía de 4 puntos (src -> dst)
  function homography(src, dst) {
    const A = [], bb = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); bb.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); bb.push(v);
    }
    const hh = solve(A, bb); hh.push(1); return hh;
  }
  function solve(A, b) {
    const n = b.length; const M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  const applyH = (H, x, y) => { const d = H[6] * x + H[7] * y + H[8]; return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d]; };

  /** Lee una plantilla escaneada/fotografiada. Devuelve {glyphs: Map(char -> glyph), empties:[]} */
  T.readTemplate = function (canvas) {
    const { ink, w, h } = T.inkMap(canvas, true);
    const t = T.otsu(ink);
    const mask = new Uint8Array(w * h); for (let i = 0; i < ink.length; i++) mask[i] = ink[i] > t ? 1 : 0;
    const { comps } = T.components(mask, w, h);
    const cand = comps.filter(c => c.area > 60 && c.w / c.h > 0.6 && c.w / c.h < 1.6 && c.area / (c.w * c.h) > 0.72);
    if (cand.length < 4) throw new Error('No encontré las 4 marcas negras de las esquinas. Toma la foto de frente, con toda la hoja visible.');
    const maxA = Math.max(...cand.map(c => c.area));
    const big = cand.filter(c => c.area > maxA * 0.25);
    const corners = [[0, 0], [w, 0], [0, h], [w, h]];
    const picks = corners.map(([X, Y]) => { let b = null, bd = 1e18; for (const c of big) { const d = (c.cx - X) ** 2 + (c.cy - Y) ** 2; if (d < bd) { bd = d; b = c; } } return b; });
    if (new Set(picks).size < 4) throw new Error('Las marcas de esquina no se distinguen bien. Intenta con mejor luz o un escaneo.');
    // centroide más preciso que el centro del rectángulo
    const src = picks.map(c => [c.cx, c.cy]);
    const P = T.TPL;
    const Hmm2px = homography(P.markers, src); // mm -> px
    const pxPerMm = Math.hypot(src[1][0] - src[0][0], src[1][1] - src[0][1]) / (P.markers[1][0] - P.markers[0][0]);
    const R = 14; // px por mm en el recorte normalizado
    const G = P.grid, Bx = P.box;
    const inset = 1.0;
    const bw = Math.round((Bx.w - inset * 2) * R), bh = Math.round((Bx.h - inset * 2) * R);
    const result = new Map(), empties = [];
    const tCell = t;
    T.CHARSET.forEach((ch, i) => {
      const cx = G.x + (i % G.cols) * G.cw + Bx.dx + inset, cy = G.y + Math.floor(i / G.cols) * G.ch + Bx.dy + inset;
      const cell = new Float32Array(bw * bh);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const [sx, sy] = applyH(Hmm2px, cx + x / R, cy + y / R);
        cell[y * bw + x] = bilinear(ink, w, h, sx, sy);
      }
      const g = T.glyphFromCell(cell, bw, bh, tCell, {
        cap: (Bx.h * P.guides.cap - inset) * R, base: (Bx.h * P.guides.base - inset) * R
      });
      if (g) result.set(ch, g); else empties.push(ch);
    });
    return { glyphs: result, empties, pxPerMm };
  };

  /** Celda (plantilla o lienzo de dibujo) -> glifo. guides: {cap, base} en px de la celda */
  T.glyphFromCell = function (cell, bw, bh, t, guides) {
    const mask = new Uint8Array(bw * bh);
    for (let i = 0; i < cell.length; i++) mask[i] = cell[i] > t ? 1 : 0;
    const { labels, comps } = T.components(mask, bw, bh);
    let A = 0, P = 0; for (const c of comps) { A += c.area; P += c.edge; }
    const stroke = P ? Math.max(1.5, 2 * A / P) : 3;
    // quita ruido y restos del borde de la casilla
    const keep = comps.filter(c => c.area >= Math.max(10, stroke * stroke * 0.8) &&
      !((c.minx <= 1 || c.maxx >= bw - 2) && c.w < stroke * 2.2) &&
      !((c.miny <= 1 || c.maxy >= bh - 2) && c.h < stroke * 2.2));
    const total = keep.reduce((s, c) => s + c.area, 0);
    if (!keep.length || total < bw * bh * 0.002) return null;
    const g = { comps: keep.map(c => c.id), minx: Math.min(...keep.map(c => c.minx)), maxx: Math.max(...keep.map(c => c.maxx)), miny: Math.min(...keep.map(c => c.miny)), maxy: Math.max(...keep.map(c => c.maxy)) };
    const s = CAP_UNITS / (guides.base - guides.cap);
    const contours = T.vectorize({ ink: cell, w: bw, h: bh, labels, t }, g, (px, py) => [(px - g.minx) * s, (guides.base - py) * s]);
    const res = finishGlyph(contours, stroke * s);
    if (res) {
      // vista previa del recorte
      const c = document.createElement('canvas'); c.width = bw; c.height = bh;
      const ctx = c.getContext('2d'), id = ctx.createImageData(bw, bh);
      for (let i = 0; i < cell.length; i++) { const v = Math.round(255 * (1 - Math.min(1, cell[i]))); id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255; }
      ctx.putImageData(id, 0, 0); res.preview = c;
    }
    return res;
  };

  /** Lienzo de dibujo (fondo blanco, tinta oscura) -> glifo */
  T.glyphFromDrawing = function (canvas, guides) {
    const { ink, w, h } = T.inkMap(canvas, false);
    return T.glyphFromCell(ink, w, h, 0.45, guides);
  };

  // ===================================================================
  //  Diacríticos y signos sintéticos (si faltan)
  // ===================================================================
  const COMPOSE = {
    'á': ['a', 'acute'], 'é': ['e', 'acute'], 'í': ['i', 'acute'], 'ó': ['o', 'acute'], 'ú': ['u', 'acute'], 'ü': ['u', 'dier'], 'ñ': ['n', 'tilde'],
    'Á': ['A', 'acute'], 'É': ['E', 'acute'], 'Í': ['I', 'acute'], 'Ó': ['O', 'acute'], 'Ú': ['U', 'acute'], 'Ñ': ['N', 'tilde']
  };
  T.COMPOSE = COMPOSE;

  function cloneContours(cs) { return cs.map(c => c.map(p => ({ ...p }))); }
  function contourBox(c) { let a = [1e9, 1e9, -1e9, -1e9]; for (const p of c) { a[0] = Math.min(a[0], p.x); a[1] = Math.min(a[1], p.y); a[2] = Math.max(a[2], p.x); a[3] = Math.max(a[3], p.y); } return a; }
  const cArea = c => polyArea(c.map(p => [p.x, p.y]));

  function strokePoly(path, sw) { // polilínea -> polígono con grosor
    const L = [], R = [];
    for (let i = 0; i < path.length; i++) {
      const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
      let nx = -(b[1] - a[1]), ny = b[0] - a[0]; const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
      L.push([path[i][0] + nx * sw / 2, path[i][1] + ny * sw / 2]); R.push([path[i][0] - nx * sw / 2, path[i][1] - ny * sw / 2]);
    }
    return L.concat(R.reverse());
  }
  function circlePoly(cx, cy, r) { const p = []; for (let k = 0; k < 12; k++) { const a = k / 12 * Math.PI * 2; p.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } return p; }
  function polyToContour(p, outerSign) {
    let pts = p.map(([x, y]) => ({ x, y, on: true }));
    if (Math.sign(cArea(pts)) !== outerSign) pts.reverse();
    return pts;
  }

  T.composeGlyph = function (target, glyphMap) {
    const rule = COMPOSE[target]; if (!rule) return null;
    const base = glyphMap.get(rule[0]); if (!base) return null;
    let cs = cloneContours(base.contours);
    const outer = cs.reduce((m, c) => Math.abs(cArea(c)) > Math.abs(cArea(m)) ? c : m, cs[0]);
    const sign = Math.sign(cArea(outer)) || 1;
    const sw = Math.max(40, Math.min(110, base.stroke || 60));
    if (target === 'í') { // quita el punto de la i
      const top = Math.max(...cs.map(c => contourBox(c)[3]));
      cs = cs.filter(c => { const b = contourBox(c); return !(b[1] > XH_UNITS * 0.8 && b[3] >= top - 1 && (b[3] - b[1]) < (base.yMax - base.yMin) * 0.4); });
      if (!cs.length) cs = cloneContours(base.contours);
    }
    const box = cs.reduce((a, c) => { const b = contourBox(c); return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]; }, [1e9, 1e9, -1e9, -1e9]);
    const cx = (box[0] + box[2]) / 2, top = Math.max(box[3], target === target.toUpperCase() ? CAP_UNITS * 0.95 : XH_UNITS * 0.95) + sw * 1.4;
    let marks = [];
    if (rule[1] === 'acute') marks = [strokePoly([[cx - 40, top], [cx + 70, top + 170]], sw)];
    if (rule[1] === 'dier') marks = [circlePoly(cx - 90, top + 30, sw * 0.7), circlePoly(cx + 90, top + 30, sw * 0.7)];
    if (rule[1] === 'tilde') { const p = []; for (let k = 0; k <= 16; k++) { const u = k / 16; p.push([cx - 130 + u * 260, top + 40 + Math.sin(u * Math.PI * 2) * 45]); } marks = [strokePoly(p, sw)]; }
    for (const m of marks) cs.push(polyToContour(m, sign));
    return finishGlyph(cs, base.stroke);
  };

  T.rotateGlyph = function (g) { // ¿ desde ?, ¡ desde !
    const cs = cloneContours(g.contours), W = g.width, yc = (g.yMin + g.yMax) / 2 - (g.yMax - g.yMin) * 0.12;
    for (const c of cs) for (const p of c) { p.x = W - p.x; p.y = 2 * yc - p.y; }
    return finishGlyph(cs, g.stroke);
  };

  // ===================================================================
  //  Construcción de la tipografía
  // ===================================================================
  /**
   * @param glyphMap Map(char -> {contours, width, stroke})
   * @param opts {family, spaceWidth, synthesize:true}
   * @returns {otf:ArrayBuffer, ttf, woff, woff2, report}
   */
  T.buildFont = async function (glyphMap, opts) {
    const lib = global.TrazoFontLib; if (!lib) throw new Error('Falta lib/trazo-fontlib.js');
    const { opentype, Font, woff2 } = lib;
    opts = opts || {};
    const family = (opts.family || 'Mi Caligrafia').trim().slice(0, 40) || 'Mi Caligrafia';
    const ps = family.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]/g, '') || 'TrazoFont';
    const map = new Map(glyphMap);
    const synthesized = [];
    if (opts.synthesize !== false) {
      for (const ch of Object.keys(COMPOSE)) if (!map.has(ch)) { const g = T.composeGlyph(ch, map); if (g) { map.set(ch, g); synthesized.push(ch); } }
      if (!map.has('¿') && map.has('?')) { map.set('¿', T.rotateGlyph(map.get('?'))); synthesized.push('¿'); }
      if (!map.has('¡') && map.has('!')) { map.set('¡', T.rotateGlyph(map.get('!'))); synthesized.push('¡'); }
    }
    const strokes = [...map.values()].map(g => g.stroke).filter(Boolean);
    const sb = Math.round(Math.max(22, Math.min(80, (median(strokes) || 50) * 0.55)));
    const glyphs = [
      new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: 500, path: notdefPath(opentype) }),
      new opentype.Glyph({ name: 'space', unicode: 32, advanceWidth: Math.round(opts.spaceWidth || 300), path: new opentype.Path() }),
      new opentype.Glyph({ name: 'nbspace', unicode: 160, advanceWidth: Math.round(opts.spaceWidth || 300), path: new opentype.Path() })
    ];
    let yMax = 0, yMin = 0;
    const chars = [...map.keys()].filter(c => [...c].length === 1 && c !== ' ').sort();
    for (const ch of chars) {
      const g = map.get(ch);
      const path = new opentype.Path();
      for (const c of g.contours) {
        // orientación PostScript (exterior antihorario en y-arriba) la decide el trazado; mantenemos coherencia
        const q = c;
        path.moveTo(Math.round(q[0].x + sb), Math.round(q[0].y));
        for (let i = 1; i <= q.length; i++) {
          const p = q[i % q.length];
          if (p.on) path.lineTo(Math.round(p.x + sb), Math.round(p.y));
          else { const n = q[(i + 1) % q.length]; path.quadraticCurveTo(Math.round(p.x + sb), Math.round(p.y), Math.round(n.x + sb), Math.round(n.y)); i++; }
        }
        path.close();
        for (const p of c) { yMax = Math.max(yMax, p.y); yMin = Math.min(yMin, p.y); }
      }
      const cp = ch.codePointAt(0);
      glyphs.push(new opentype.Glyph({ name: 'uni' + cp.toString(16).toUpperCase().padStart(4, '0'), unicode: cp, advanceWidth: Math.round(g.width + sb * 2), path }));
    }
    const asc = Math.max(800, Math.ceil(yMax + 30)), desc = Math.min(-200, Math.floor(yMin - 30));
    const font = new opentype.Font({
      familyName: family, styleName: 'Regular', unitsPerEm: EM, ascender: asc, descender: desc,
      designer: opts.designer || 'Trazo · Sintropía Social', manufacturer: 'Sintropía Social',
      description: 'Tipografía generada con Trazo (Sintropía Social) a partir de caligrafía manuscrita.',
      version: '1.000', postScriptName: ps + '-Regular', glyphs
    });
    const otf = font.toArrayBuffer();
    if (!woff2.isInited()) await woff2.init(opts.wasmUrl || 'lib/woff2.wasm');
    const fe = Font.create(otf, { type: 'otf' });
    const ttf = toAB(fe.write({ type: 'ttf' }));
    const woff = toAB(fe.write({ type: 'woff' }));
    const w2 = toAB(fe.write({ type: 'woff2' }));
    return {
      otf, ttf, woff, woff2: w2, family, ps,
      report: { included: chars, synthesized, missing: T.CHARSET.filter(c => !map.has(c)) }
    };
  };
  function toAB(b) { if (b instanceof ArrayBuffer) return b; if (b.buffer) return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); return new Uint8Array(b).buffer; }
  function notdefPath(opentype) {
    const p = new opentype.Path();
    p.moveTo(60, 0); p.lineTo(440, 0); p.lineTo(440, 700); p.lineTo(60, 700); p.close();
    p.moveTo(110, 50); p.lineTo(110, 650); p.lineTo(390, 650); p.lineTo(390, 50); p.close();
    return p;
  }

  // Dibuja un glifo vectorizado (vista previa de control)
  T.drawGlyph = function (canvas, g) {
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    const s = H / 1200, ox = (W - g.width * s) / 2, oy = H * 0.72;
    ctx.strokeStyle = '#e6e0f5'; ctx.beginPath(); ctx.moveTo(0, oy); ctx.lineTo(W, oy); ctx.stroke();
    ctx.beginPath();
    for (const c of g.contours) {
      const P = p => [ox + p.x * s, oy - p.y * s];
      ctx.moveTo(...P(c[0]));
      for (let i = 1; i <= c.length; i++) {
        const p = c[i % c.length];
        if (p.on) ctx.lineTo(...P(p)); else { const n = c[(i + 1) % c.length]; ctx.quadraticCurveTo(...P(p), ...P(n)); i++; }
      }
      ctx.closePath();
    }
    ctx.fillStyle = '#1d1440'; ctx.fill('nonzero');
  };

  global.TrazoEngine = T;
})(window);
