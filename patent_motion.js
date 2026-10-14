/* =====================================================================
 * 특허 모션 (Patent Motion) 탭
 * - 특허/논문 PDF를 EXAONE 4.5(비전)로 해석해 '동작 사양 JSON'을 만들고
 * - 내장 애니메이션 엔진이 3D·측면도·평면도로 동작을 시연합니다.
 * - 엔진이 표현하는 기구: rotary_notch, press_notch, laser_notch, rotary_cut
 * 의존: three.js r128 + OrbitControls, pdf.js 3.11 (탭을 열 때 CDN에서 지연 로드)
 * EXAONE 호출은 앱의 AI 설정(exaoneProxyUrl / exaoneApiKey)을 그대로 사용합니다.
 * ===================================================================== */
(function () {
  'use strict';

  const CDN = {
    three: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
    orbit: 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js',
    pdf: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  };
  const EXAONE_URL = 'https://api.lgresearch.ai/v1/chat/completions';
  const EXAONE_MODEL = 'exaone-v4.5_33b';
  const TYPES = ['rotary_notch', 'press_notch', 'laser_notch', 'rotary_cut'];
  const TYPE_LABEL = {
    rotary_notch: '롤러 노칭', press_notch: '금형 프레스 노칭',
    laser_notch: '레이저 노칭', rotary_cut: '롤 커팅 (낱장 절단)',
  };
  const DEF_COLORS = {
    coated: '#1C1C1C', foil: '#B87333', other: '#8A8F98',
    roller: '#FFFFFF', blade: '#378ADD', laser: '#E24B4A',
  };
  const V = { x0: 20, x1: 660, yTop: 40, W: 110, YS: 170, YREF: 160, SPAN: 130 };
  const SL0 = 45, SL1 = 80, SPEED = 34;

  const $ = (id) => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
  const frac = (x) => x - Math.floor(x);
  const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && isFinite(+v) ? +v : d));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isHex = (c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c);
  const f1 = (v) => (Math.round(v * 10) / 10);

  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = clamp(Math.round(r + amt * 255), 0, 255); g = clamp(Math.round(g + amt * 255), 0, 255); b = clamp(Math.round(b + amt * 255), 0, 255);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  const scriptCache = {};
  function loadScript(src) {
    if (!scriptCache[src]) {
      scriptCache[src] = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.async = true;
        s.onload = () => resolve();
        s.onerror = () => { delete scriptCache[src]; reject(new Error('라이브러리를 불러오지 못했습니다: ' + src)); };
        document.head.appendChild(s);
      });
    }
    return scriptCache[src];
  }

  /* ------------------------------------------------------------------
   * 1. 사양(spec) 정규화
   * ------------------------------------------------------------------ */
  function normMaterial(m, name) {
    const t = (String(m || '') + ' ' + String(name || '')).toLowerCase();
    if (/foil|cu|copper|al\b|alum|무지|탭|tab|포일|금속박|集流|极耳/.test(t)) return 'foil';
    if (/coat|active|활물질|코팅|유지|바디|body|涂/.test(t)) return 'coated';
    return m === 'coated' || m === 'foil' ? m : 'other';
  }
  function normEdge(e, pitch) {
    const cut = e && ['tabs', 'trim', 'none'].includes(e.cut) ? e.cut : 'none';
    return { cut, tab_width_mm: clamp(num(e && e.tab_width_mm, pitch * 0.3), pitch * 0.08, pitch * 0.85) };
  }
  function toStrList(a) {
    if (!Array.isArray(a)) return a ? [String(a)] : [];
    return a.map((x) => (typeof x === 'string' ? x : (x && (x.text || x.name || JSON.stringify(x))) || '')).filter(Boolean).slice(0, 30);
  }

  function normalizeSpec(raw) {
    const warnings = [];
    const r = raw && typeof raw === 'object' ? raw : {};
    const webR = r.web && typeof r.web === 'object' ? r.web : {};
    const width = clamp(num(webR.width_mm, 110), 5, 3000);
    const pitch = clamp(num(webR.pitch_mm, 80), 2, 5000);
    let bands = Array.isArray(webR.bands) ? webR.bands.filter((b) => b && typeof b === 'object').map((b) => ({
      name: String(b.name || ''), width_mm: Math.max(0.1, num(b.width_mm, width / 3)), material: normMaterial(b.material, b.name),
    })) : [];
    if (bands.length < 2) {
      warnings.push('시트 띠(bands) 정보가 부족해 기본 구성(상부 무지부 + 코팅부)으로 표시합니다.');
      bands = [{ name: '무지부', width_mm: width * 0.2, material: 'foil' }, { name: '코팅부', width_mm: width * 0.8, material: 'coated' }];
    }
    bands = bands.slice(0, 6);
    let pre = null;
    const p = webR.preformed_tabs;
    if (p && typeof p === 'object' && (p.edge === 'top' || p.edge === 'bottom')) {
      pre = { edge: p.edge, tab_width_mm: clamp(num(p.tab_width_mm, pitch * 0.3), pitch * 0.08, pitch * 0.85) };
    }
    const unsupported = toStrList(r.unsupported);
    let stations = Array.isArray(r.stations) ? r.stations.filter((s) => s && typeof s === 'object') : [];
    stations = stations.filter((s) => {
      if (TYPES.includes(s.type)) return true;
      unsupported.push(`엔진이 모르는 유형 '${s.type}' (${s.label || '이름 없음'})은 표시하지 않았습니다.`);
      return false;
    });
    if (stations.length > 3) { warnings.push('스테이션이 3개를 넘어 앞의 3개만 표시합니다.'); stations = stations.slice(0, 3); }
    stations = stations.map((s, i) => {
      const o = { id: String(s.id || 's' + (i + 1)), type: s.type, label: String(s.label || TYPE_LABEL[s.type]) };
      if (s.type === 'rotary_cut') {
        o.blade = s.blade === 'helical' ? 'helical' : 'straight';
        o.skew = o.blade === 'helical' ? s.skew !== false : false;
        o.scrap_width_mm = Math.max(0, num(s.scrap_width_mm, 0));
      } else {
        const ed = s.edges && typeof s.edges === 'object' ? s.edges : {};
        o.edges = { top: normEdge(ed.top, pitch), bottom: normEdge(ed.bottom, pitch) };
        if (o.edges.top.cut === 'none' && o.edges.bottom.cut === 'none') {
          o.edges.top.cut = 'tabs';
          warnings.push(`${o.label}: 자르는 가장자리가 지정되지 않아 상부 탭 노칭으로 가정했습니다.`);
        }
        if (s.type === 'rotary_notch') {
          const sp = Math.round(num(s.segments_per_rev, 0));
          if (sp >= 1 && sp <= 12) o.segments_per_rev = sp;
          if (num(s.roller_diameter_mm, 0) > 0) o.roller_diameter_mm = num(s.roller_diameter_mm, 0);
        }
      }
      return o;
    });
    if (!stations.length && !pre) warnings.push('표시할 공정(stations)이 없습니다. 시트만 이송됩니다.');
    const colors = Object.assign({}, DEF_COLORS);
    if (r.colors && typeof r.colors === 'object') Object.keys(DEF_COLORS).forEach((k) => { if (isHex(r.colors[k])) colors[k] = r.colors[k]; });
    const parts = Array.isArray(r.parts) ? r.parts.filter((x) => x && typeof x === 'object').map((x) => ({
      no: String(x.no || ''), name: String(x.name || ''), role: String(x.role || ''),
    })).slice(0, 30) : [];
    const evidence = Array.isArray(r.evidence) ? r.evidence.map((x) => (typeof x === 'string' ? { text: x, source: '' } : {
      text: String((x && x.text) || ''), source: String((x && x.source) || ''),
    })).filter((x) => x.text).slice(0, 30) : [];
    const spec = {
      title: String(r.title || '제목 없음'), source: String(r.source || ''), summary: String(r.summary || ''),
      web: { width_mm: width, pitch_mm: pitch, bands, preformed_tabs: pre },
      stations, colors, parts, evidence, assumptions: toStrList(r.assumptions), unsupported,
    };
    return { spec, warnings };
  }

  /* ------------------------------------------------------------------
   * 2. 화면 배치 계산
   * ------------------------------------------------------------------ */
  function buildLayout(spec) {
    const w = spec.web;
    const k = V.W / w.width_mm;
    let hs = w.bands.map((b) => Math.max(8, b.width_mm * k));
    const sum = hs.reduce((a, b) => a + b, 0);
    hs = hs.map((h) => (h * V.W) / sum);
    const bands = [];
    let y = V.yTop;
    w.bands.forEach((b, i) => {
      bands.push(Object.assign({}, b, { y0: y, y1: y + hs[i], role: i === 0 ? 'top' : i === w.bands.length - 1 ? 'bottom' : 'mid' }));
      y += hs[i];
    });
    const P = clamp(w.pitch_mm * k, 60, 200);
    const kx = P / w.pitch_mm;
    const tabPx = (mm) => clamp(mm * kx, 8, P - 12);
    const n = spec.stations.length;
    const xsNom = n <= 1 ? [380] : n === 2 ? [470, 250] : [530, 380, 230];
    const feed = spec.stations.some((s) => s.type === 'press_notch') ? 'intermittent' : 'continuous';
    const pre = w.preformed_tabs ? { edge: w.preformed_tabs.edge, T: tabPx(w.preformed_tabs.tab_width_mm) } : null;
    const edgeT = { top: null, bottom: null };
    if (pre) edgeT[pre.edge] = pre.T;
    const st = spec.stations.map((s, i) => {
      const o = Object.assign({}, s, { x: xsNom[i], i });
      if (o.edges) {
        o.e = {};
        ['top', 'bottom'].forEach((ed) => {
          const e = o.edges[ed];
          o.e[ed] = { cut: e.cut, T: e.cut === 'tabs' ? tabPx(e.tab_width_mm) : 0 };
          if (e.cut === 'tabs' && edgeT[ed] == null) edgeT[ed] = o.e[ed].T;
        });
      }
      return o;
    });
    const Tref = edgeT.top != null ? edgeT.top : edgeT.bottom;
    const cc = Tref != null ? Tref + (P - Tref) / 2 : P / 2;
    st.forEach((o) => {
      if (o.type === 'rotary_notch') {
        let segs = o.segments_per_rev || Math.round((2 * Math.PI * 46) / P);
        segs = clamp(segs, 1, 12);
        let R = (segs * P) / (2 * Math.PI);
        while (R > 62 && segs > 1) { segs--; R = (segs * P) / (2 * Math.PI); }
        while (R < 26 && segs < 12) { segs++; R = (segs * P) / (2 * Math.PI); }
        o.segs = segs; o.R = R;
        o.UE = Math.ceil((o.x + SL1) / P) * P; o.UB = o.x + SL1;
      } else if (o.type === 'laser_notch') {
        o.UE = Math.ceil(o.x / P) * P; o.UB = o.x;
      } else if (o.type === 'press_notch') {
        const ed = o.e.top.cut !== 'none' ? 'top' : 'bottom';
        o.mainEdge = ed;
        const T = o.e[ed].T;
        o.c = o.e[ed].cut === 'tabs' ? T + (P - T) / 2 : P / 2;
        o.x = o.c + P * Math.round((o.x - o.c) / P);
      } else if (o.type === 'rotary_cut') {
        let nb = 1, R = P / (2 * Math.PI);
        while (R < 26) { nb++; R = (nb * P) / (2 * Math.PI); }
        o.nb = nb; o.R = R; o.helical = o.blade === 'helical'; o.f = 0.45;
        o.alpha = o.helical && o.skew ? Math.atan((o.f * P) / V.SPAN) : 0;
        o.xs = o.helical ? o.x + (V.SPAN / 2) * Math.tan(o.alpha) : o.x;
        o.g = o.scrap_width_mm > 0 ? clamp(o.scrap_width_mm * kx, 3, 20) : 3;
        o.cc = cc;
        o.slant = o.helical && !o.skew ? (o.f * P) / V.SPAN : 0;
        o.s0 = o.helical ? cc - o.xs + 0.5 * o.f * P : cc - o.x;
      }
    });
    const scaled = Math.abs(P - w.pitch_mm * k) > 0.5;
    return { k, kx, P, bands, stations: st, feed, pre, cc, scaled };
  }

  /* ------------------------------------------------------------------
   * 3. 시간 → 상태
   * ------------------------------------------------------------------ */
  function webState(L, t) {
    if (L.feed === 'continuous') return { s: SPEED * t, dwell: false, down: 0, downDone: false };
    const Tc = (L.P / SPEED) * 1.3, n = Math.floor(t / Tc), ph = t / Tc - n, mv = 0.55;
    const s = n * L.P + L.P * ease(Math.min(1, ph / mv));
    const dwell = ph >= mv;
    const q = dwell ? (ph - mv) / (1 - mv) : 0;
    return { s, dwell, down: dwell ? Math.sin(Math.PI * q) : 0, downDone: dwell && q >= 0.5, q };
  }
  function liftOf(s) { return s < SL0 ? 16 : s < SL1 ? 16 * (1 - ease((s - SL0) / (SL1 - SL0))) : 0; }

  /* 구간(interval) 연산 */
  function subtract(spans, rem) {
    let out = spans;
    rem.forEach(([a, b]) => {
      const next = [];
      out.forEach(([x, y]) => {
        if (b <= x || a >= y) { next.push([x, y]); return; }
        if (a > x) next.push([x, a]);
        if (b < y) next.push([b, y]);
      });
      out = next;
    });
    return out;
  }
  function tabSpans(T, xa, xb, s, P) {
    const out = [];
    const k0 = Math.floor((xa + s) / P) - 1, k1 = Math.floor((xb + s) / P) + 1;
    for (let k = k0; k <= k1; k++) {
      const a = k * P - s, b = a + T, lo = Math.max(a, xa), hi = Math.min(b, xb);
      if (hi > lo) out.push([lo, hi]);
    }
    return out;
  }
  function pressCut(o, uc, xc, W) {
    return uc >= o.x + W.P - 0.5 && (xc < o.x - 0.5 || (Math.abs(xc - o.x) < 0.5 && W.downDone));
  }

  function bandSpans(b, L, W) {
    const s = W.s, P = L.P, xa0 = V.x0 - 60, xb0 = V.x1 + 60;
    let spans = [[xa0, xb0]];
    if (L.pre && L.pre.edge === b.role) spans = tabSpans(L.pre.T, xa0, xb0, s, P);
    L.stations.forEach((o) => {
      if (!o.e) return;
      const e = o.e[b.role];
      if (!e || e.cut === 'none') return;
      if (o.type === 'press_notch') {
        const rem = [], half = e.cut === 'tabs' ? (P - e.T) / 2 : P / 2;
        const k0 = Math.floor((xa0 + s - o.c) / P) - 1, k1 = Math.floor((xb0 + s - o.c) / P) + 1;
        for (let k = k0; k <= k1; k++) {
          const uc = k * P + o.c, xc = uc - s;
          if (pressCut(o, uc, xc, Object.assign({ P }, W))) rem.push([xc - half, xc + half]);
        }
        spans = subtract(spans, rem);
      } else {
        const xa = Math.max(xa0, (e.cut === 'tabs' ? o.UE : o.UB) - s), xb = o.x;
        if (xb <= xa) return;
        if (e.cut === 'trim') spans = subtract(spans, [[xa, xb]]);
        else {
          const keep = tabSpans(e.T, xa, xb, s, P);
          spans = subtract(spans, subtract([[xa, xb]], keep));
        }
      }
    });
    return spans;
  }

  const lineX = (ln, y) => ln.xr + ln.m * (V.YREF - y);
  function cutLines(o, L, s, onlyDone) {
    const P = L.P, out = [];
    const k0 = Math.floor((V.x0 - 80 + s - o.cc) / P) - 1, k1 = Math.floor((V.x1 + 80 + s - o.cc) / P) + 1;
    for (let k = k0; k <= k1; k++) {
      const u = k * P + o.cc, xr = u - s;
      let p;
      if (o.helical) p = (s - (u - o.xs)) / (o.f * P);
      else p = xr <= o.x ? 1 : 0;
      if (onlyDone && p < 1) continue;
      out.push({ k, xr, m: o.slant, p, u });
    }
    return out;
  }
  function splitPolys(polys, cl, g, yMid) {
    const out = [];
    polys.forEach((pg) => {
      const lx = lineX(pg.L, yMid), rx = lineX(pg.R, yMid), cx = lineX(cl, yMid);
      if (cx > lx + 0.5 && cx < rx - 0.5) {
        out.push({ L: pg.L, R: { xr: cl.xr - g / 2, m: cl.m } });
        out.push({ L: { xr: cl.xr + g / 2, m: cl.m }, R: pg.R });
      } else out.push(pg);
    });
    return out;
  }
  function bandPolys(b, L, W) {
    let polys = bandSpans(b, L, W).map(([a, c]) => ({ L: { xr: a, m: 0 }, R: { xr: c, m: 0 } }));
    const yMid = (b.y0 + b.y1) / 2;
    L.stations.forEach((o) => {
      if (o.type !== 'rotary_cut') return;
      cutLines(o, L, W.s, true).forEach((cl) => { polys = splitPolys(polys, cl, o.g, yMid); });
    });
    return polys;
  }
  function polyPts(pg, y0, y1) {
    return [[lineX(pg.L, y0), y0], [lineX(pg.R, y0), y0], [lineX(pg.R, y1), y1], [lineX(pg.L, y1), y1]];
  }

  /* 잘려 나가는 조각 (평면 좌표 사각형 + 투명도 + 낙하량) */
  function scrapPieces(L, W) {
    const out = [], s = W.s, P = L.P;
    L.stations.forEach((o) => {
      if (o.e) {
        L.bands.forEach((b) => {
          if (b.role === 'mid') return;
          const e = o.e[b.role];
          if (!e || e.cut === 'none') return;
          const dir = b.role === 'top' ? -1 : 1;
          if (o.type === 'press_notch') {
            if (!W.dwell) return;
            const half = e.cut === 'tabs' ? (P - e.T) / 2 : P / 2;
            const uc = o.x + s;
            if (uc < o.x + P - 0.5) return;
            const op = W.q < 0.5 ? 1 : Math.max(0, 1 - (W.q - 0.5) / 0.35);
            if (op > 0) out.push({ x0: o.x - half, x1: o.x + half, y0: b.y0, y1: b.y1, op, drop: W.down * 10, mat: b.material, hot: true });
            return;
          }
          if (o.type === 'rotary_notch' && s < SL1) return;
          if (e.cut === 'trim') {
            if (o.UB - s >= o.x) return;
            for (let i = 0; i < 12; i++) {
              const x1 = o.x - i * 5, x0 = x1 - 5;
              if (x0 < o.UB - s) break;
              out.push({ x0, x1, y0: b.y0 - dir * i * 0 , y1: b.y1, op: 1 - i / 12, drop: i * 1.6, mat: b.material, shift: dir * i * 1.1 });
            }
            return;
          }
          const k0 = Math.floor((V.x0 + s) / P) - 1, k1 = Math.floor((o.x + s) / P) + 1;
          for (let k = k0; k <= k1; k++) {
            const ua = k * P + e.T, ub = (k + 1) * P;
            if (ua < o.UE) continue;
            const a = ua - s, c = ub - s;
            if (a < o.x && c > o.x) out.push({ x0: a, x1: o.x, y0: b.y0, y1: b.y1, op: 0.95, drop: 0, mat: b.material, hot: true });
            else if (c <= o.x) {
              const dd = o.x - c;
              if (dd < 45) out.push({ x0: a, x1: c, y0: b.y0, y1: b.y1, op: 1 - dd / 45, drop: dd * 0.8, mat: b.material, shift: dir * dd * 0.5 });
            }
          }
        });
      } else if (o.type === 'rotary_cut' && o.scrap_width_mm > 0) {
        cutLines(o, L, s, true).forEach((cl) => {
          const ds = o.x - cl.xr;
          if (ds >= 0 && ds < 30) out.push({ strip: true, cl, g: o.g, op: 1 - ds / 30, drop: ds * 0.6 });
        });
      }
    });
    return out;
  }

  /* ------------------------------------------------------------------
   * 4. 엔진 (상태 + 2D 렌더 + 상태 문구)
   * ------------------------------------------------------------------ */
  function matColor(C, m) { return m === 'foil' ? C.foil : m === 'coated' ? C.coated : C.other; }

  function renderTop(E) {
    const { L, W, C } = E;
    let h = '<rect x="0" y="0" width="680" height="205" fill="#F3F4F7"/>';
    L.bands.forEach((b) => {
      const col = matColor(C, b.material);
      bandPolys(b, L, W).forEach((pg) => {
        const pts = polyPts(pg, b.y0, b.y1).map((p) => f1(p[0]) + ',' + f1(p[1])).join(' ');
        h += `<polygon points="${pts}" fill="${col}" stroke="${shade(col, -0.12)}" stroke-width="0.6"/>`;
      });
    });
    scrapPieces(L, W).forEach((sp) => {
      if (sp.strip) {
        const pg = { L: { xr: sp.cl.xr - sp.g / 2, m: sp.cl.m }, R: { xr: sp.cl.xr + sp.g / 2, m: sp.cl.m } };
        const pts = polyPts(pg, V.yTop, V.yTop + V.W).map((p) => f1(p[0]) + ',' + f1(p[1])).join(' ');
        h += `<polygon points="${pts}" fill="${C.coated}" fill-opacity="${f1(sp.op)}"/>`;
        return;
      }
      const col = matColor(C, sp.mat), sh = sp.shift || 0;
      h += `<rect x="${f1(Math.max(V.x0, sp.x0))}" y="${f1(sp.y0 + sh)}" width="${f1(Math.max(0, Math.min(V.x1, sp.x1) - Math.max(V.x0, sp.x0)))}" height="${f1(sp.y1 - sp.y0)}" fill="${col}" fill-opacity="${f1(sp.op)}" stroke="${sp.hot ? C.blade : 'none'}" stroke-width="1.2" stroke-opacity="${f1(sp.op)}"/>`;
    });
    L.stations.forEach((o) => {
      h += `<line x1="${f1(o.x)}" y1="26" x2="${f1(o.x)}" y2="166" stroke="#888780" stroke-width="0.8" stroke-dasharray="4 3"/>`;
      h += `<text x="${f1(o.x)}" y="186" text-anchor="middle" font-size="12" fill="#5F5E5A">${o.i + 1}. ${esc(TYPE_LABEL[o.type])}</text>`;
      if (o.type === 'rotary_notch' || o.type === 'rotary_cut') {
        if (o.type === 'rotary_cut' && o.alpha) {
          const yt = 30, yb = 160, xt = o.x - (V.SPAN / 2) * Math.tan(o.alpha), xb2 = o.x + (V.SPAN / 2) * Math.tan(o.alpha);
          const dx = o.R / Math.cos(o.alpha);
          h += `<polygon points="${f1(xt - dx)},${yt} ${f1(xt + dx)},${yt} ${f1(xb2 + dx)},${yb} ${f1(xb2 - dx)},${yb}" fill="#FFFFFF" fill-opacity="0.45" stroke="#888780" stroke-width="0.8" stroke-dasharray="4 3"/>`;
        } else {
          h += `<rect x="${f1(o.x - o.R)}" y="28" width="${f1(o.R * 2)}" height="134" rx="5" fill="#FFFFFF" fill-opacity="0.45" stroke="#888780" stroke-width="0.8" stroke-dasharray="4 3"/>`;
        }
      }
      if (o.e) {
        L.bands.forEach((b) => {
          if (b.role === 'mid') return;
          const e = o.e[b.role];
          if (!e || e.cut === 'none') return;
          const inner = b.role === 'top' ? b.y1 : b.y0, outer = b.role === 'top' ? b.y0 : b.y1;
          if (o.type === 'press_notch') {
            const half = e.cut === 'tabs' ? (L.P - e.T) / 2 : L.P / 2;
            const yA = Math.min(inner, outer) - (b.role === 'top' ? 6 : 0), yB = Math.max(inner, outer) + (b.role === 'bottom' ? 6 : 0);
            h += `<rect x="${f1(o.x - half)}" y="${f1(yA)}" width="${f1(half * 2)}" height="${f1(yB - yA)}" fill="${C.blade}" fill-opacity="${f1(0.15 + 0.55 * E.W.down)}" stroke="${C.blade}" stroke-width="1"/>`;
            return;
          }
          const active = o.type === 'laser_notch' || E.W.s >= SL1;
          if (!active) return;
          const un = o.x + E.W.s, off = un - Math.floor(un / L.P) * L.P;
          if (e.cut === 'trim') {
            h += o.type === 'laser_notch' ? laserSpot(o.x, inner, C) : `<circle cx="${f1(o.x)}" cy="${f1(inner)}" r="3.5" fill="${C.blade}"/>`;
            return;
          }
          if (un < o.UE) return;
          let yS = null;
          if (off >= e.T) yS = inner;
          if (off < 2.5 || Math.abs(off - e.T) < 2.5 || L.P - off < 2.5) {
            const ph = off < 2.5 ? off / 2.5 : L.P - off < 2.5 ? 1 - (L.P - off) / 2.5 : Math.abs(off - e.T) / 2.5;
            if (o.type === 'laser_notch') yS = outer + (inner - outer) * clamp(ph, 0, 1);
            else h += `<line x1="${f1(o.x)}" y1="${f1(outer)}" x2="${f1(o.x)}" y2="${f1(inner)}" stroke="${C.blade}" stroke-width="3"/>`;
          }
          if (yS != null) h += o.type === 'laser_notch' ? laserSpot(o.x, yS, C) : `<circle cx="${f1(o.x)}" cy="${f1(yS)}" r="3.5" fill="${C.blade}"/>`;
        });
      }
      if (o.type === 'rotary_cut') {
        cutLines(o, L, E.W.s, false).forEach((cl) => {
          if (o.helical && cl.p > 0 && cl.p < 1) {
            const yc = V.YREF - V.SPAN * cl.p;
            const yEnd = Math.max(V.yTop - (o.slant ? 20 : 0), yc), yStart = V.yTop + V.W;
            if (yEnd < yStart) {
              (o.scrap_width_mm > 0 ? [-o.g / 2, o.g / 2] : [0]).forEach((d) => {
                h += `<line x1="${f1(lineX(cl, yStart) + d)}" y1="${f1(yStart)}" x2="${f1(lineX(cl, yEnd) + d)}" y2="${f1(yEnd)}" stroke="${C.blade}" stroke-width="2"/>`;
              });
            }
          }
          if (!o.helical && Math.abs(cl.xr - o.x) < 2.5) h += `<line x1="${f1(o.x)}" y1="${V.yTop}" x2="${f1(o.x)}" y2="${V.yTop + V.W}" stroke="${C.blade}" stroke-width="3"/>`;
          if (o.slant && cl.p >= 1) {
            const x0 = lineX(cl, V.yTop), x1 = lineX(cl, V.yTop - 20);
            h += `<line x1="${f1(x0)}" y1="${V.yTop}" x2="${f1(x1)}" y2="${V.yTop - 20}" stroke="${C.blade}" stroke-width="1.2"/>`;
          }
        });
      }
    });
    h += `<text x="20" y="200" font-size="11" fill="#888780">${L.scaled ? '가로 비율은 보기 좋게 조정됨 · ' : ''}오른쪽 → 왼쪽 이송</text>`;
    return h;
  }
  function laserSpot(x, y, C) {
    return `<circle cx="${f1(x)}" cy="${f1(y)}" r="6" fill="${C.laser}" fill-opacity="0.25"/><circle cx="${f1(x)}" cy="${f1(y)}" r="2.6" fill="${C.laser}"/>`;
  }

  function P2(cx, cy, r, aDeg) { return [f1(cx + r * Math.cos(aDeg * Math.PI / 180)), f1(cy + r * Math.sin(aDeg * Math.PI / 180))]; }

  function renderSide(E) {
    const { L, W, C } = E;
    const YS = V.YS;
    let h = '<rect x="0" y="0" width="680" height="300" fill="#F3F4F7"/>';
    h += `<line x1="20" y1="${YS}" x2="660" y2="${YS}" stroke="${shade(C.coated, 0.25)}" stroke-width="5"/><line x1="20" y1="${YS}" x2="660" y2="${YS}" stroke="${C.coated}" stroke-width="3"/>`;
    h += `<line x1="655" y1="${YS - 14}" x2="625" y2="${YS - 14}" stroke="#888780" stroke-width="1.2"/><polyline points="631,${YS - 18} 625,${YS - 14} 631,${YS - 10}" fill="none" stroke="#888780" stroke-width="1.2"/>`;
    L.stations.forEach((o) => {
      const maxCh = L.stations.length <= 1 ? 40 : L.stations.length === 2 ? 18 : 11;
      const lbl = o.label.length > maxCh ? o.label.slice(0, maxCh - 1) + '…' : o.label;
      const lab = `<text x="${f1(o.x)}" y="292" text-anchor="middle" font-size="12" fill="#5F5E5A">${o.i + 1}. ${esc(lbl)}</text>`;
      if (o.type === 'rotary_notch') {
        const R = o.R, lift = liftOf(W.s), ucy = YS - 2 - R - lift, lcy = YS + 2 + R;
        const gU = (u) => 90 - ((u - o.x - W.s) / R) * 180 / Math.PI, gL = (u) => -90 + ((u - o.x - W.s) / R) * 180 / Math.PI;
        h += `<line x1="${f1(o.x)}" y1="20" x2="${f1(o.x)}" y2="${f1(ucy)}" stroke="#888780" stroke-width="3"/><rect x="${f1(o.x - 26)}" y="6" width="52" height="22" rx="4" fill="#E3E5EA" stroke="#888780" stroke-width="0.6"/><text x="${f1(o.x)}" y="21" text-anchor="middle" font-size="11" fill="#5F5E5A">승강</text>`;
        h += `<circle cx="${f1(o.x)}" cy="${f1(ucy)}" r="${f1(R)}" fill="${C.roller}" stroke="#888780" stroke-width="1"/><circle cx="${f1(o.x)}" cy="${f1(ucy)}" r="${f1(R * 0.38)}" fill="#D3D1C7" stroke="#888780" stroke-width="0.6"/>`;
        h += `<circle cx="${f1(o.x)}" cy="${f1(lcy)}" r="${f1(R)}" fill="${C.roller}" stroke="#888780" stroke-width="1"/><circle cx="${f1(o.x)}" cy="${f1(lcy)}" r="${f1(R * 0.38)}" fill="#D3D1C7" stroke="#888780" stroke-width="0.6"/>`;
        const ia = P2(o.x, ucy, R * 0.34, gU(o.x + W.s) - 90), ib = P2(o.x, lcy, R * 0.34, gL(o.x + W.s) + 90);
        h += `<line x1="${f1(o.x)}" y1="${f1(ucy)}" x2="${ia[0]}" y2="${ia[1]}" stroke="#888780"/><line x1="${f1(o.x)}" y1="${f1(lcy)}" x2="${ib[0]}" y2="${ib[1]}" stroke="#888780"/>`;
        const te = o.e.top.cut === 'tabs' ? o.e.top : o.e.bottom.cut === 'tabs' ? o.e.bottom : null;
        if (te) {
          const kk = Math.floor((o.x + W.s) / L.P) - o.segs;
          for (let k = kk; k < kk + o.segs + 1; k++) {
            const ga = gU(k * L.P + te.T), gb = gU((k + 1) * L.P);
            const a = P2(o.x, ucy, R, gb), b = P2(o.x, ucy, R, ga);
            h += `<path d="M${a}A${f1(R)} ${f1(R)} 0 0 1 ${b}" fill="none" stroke="${C.blade}" stroke-width="3"/>`;
            [[ga, -1], [gb, 1]].forEach(([g, d]) => {
              const b1 = P2(o.x, ucy, R, g), b2 = P2(o.x, ucy, R, g + d * 4), tp = P2(o.x, ucy, R + 6, g);
              h += `<polygon points="${b1} ${b2} ${tp}" fill="${shade(C.blade, -0.15)}"/>`;
            });
            [k * L.P, k * L.P + te.T].forEach((u) => {
              const g = gL(u), p1 = P2(o.x, lcy, R, g - 3), p2 = P2(o.x, lcy, R - 7, g), p3 = P2(o.x, lcy, R, g + 3);
              h += `<polyline points="${p1} ${p2} ${p3}" fill="none" stroke="#5F5E5A" stroke-width="1.2"/>`;
            });
          }
        } else {
          h += `<circle cx="${f1(o.x)}" cy="${f1(ucy)}" r="${f1(R + 1.5)}" fill="none" stroke="${C.blade}" stroke-width="3"/>`;
        }
      } else if (o.type === 'press_notch') {
        const half = o.e[o.mainEdge].cut === 'tabs' ? (L.P - o.e[o.mainEdge].T) / 2 : L.P / 2;
        const bottom = YS - 34 + 40 * W.down;
        h += `<rect x="${f1(o.x - half - 22)}" y="${f1(YS + 2)}" width="${f1(half * 2 + 44)}" height="42" fill="#C9CCD3" stroke="#888780" stroke-width="0.8"/>`;
        h += `<rect x="${f1(o.x - half - 1)}" y="${f1(YS + 2)}" width="${f1(half * 2 + 2)}" height="42" fill="#9EA3AD"/>`;
        h += `<rect x="${f1(o.x - half - 30)}" y="${f1(bottom - 78)}" width="${f1(half * 2 + 60)}" height="22" rx="3" fill="#E3E5EA" stroke="#888780" stroke-width="0.8"/>`;
        h += `<rect x="${f1(o.x - half)}" y="${f1(bottom - 56)}" width="${f1(half * 2)}" height="56" fill="${C.blade}" stroke="${shade(C.blade, -0.2)}" stroke-width="1"/>`;
        h += `<text x="${f1(o.x + half + 30)}" y="${f1(YS + 30)}" font-size="11" fill="#5F5E5A">다이</text><text x="${f1(o.x + half + 34)}" y="${f1(bottom - 30)}" font-size="11" fill="#5F5E5A">펀치</text>`;
      } else if (o.type === 'laser_notch') {
        h += `<rect x="${f1(o.x - 20)}" y="56" width="40" height="46" rx="4" fill="#C9CCD3" stroke="#888780" stroke-width="0.8"/><rect x="${f1(o.x - 8)}" y="102" width="16" height="10" fill="#9EA3AD"/>`;
        h += `<text x="${f1(o.x + 28)}" y="82" font-size="11" fill="#5F5E5A">레이저 헤드</text>`;
        h += `<line x1="${f1(o.x)}" y1="112" x2="${f1(o.x)}" y2="${YS - 2}" stroke="${C.laser}" stroke-width="2" stroke-opacity="0.85"/><circle cx="${f1(o.x)}" cy="${YS}" r="5" fill="${C.laser}" fill-opacity="0.35"/>`;
      } else if (o.type === 'rotary_cut') {
        const R = o.R, ucy = YS - 2 - R, lcy = YS + 2 + R;
        h += `<circle cx="${f1(o.x)}" cy="${f1(ucy)}" r="${f1(R)}" fill="${C.roller}" stroke="#888780"/><circle cx="${f1(o.x)}" cy="${f1(ucy)}" r="${f1(R * 0.3)}" fill="#D3D1C7" stroke="#888780" stroke-width="0.6"/>`;
        h += `<circle cx="${f1(o.x)}" cy="${f1(lcy)}" r="${f1(R)}" fill="${C.roller}" stroke="#888780"/><circle cx="${f1(o.x)}" cy="${f1(lcy)}" r="${f1(R * 0.3)}" fill="#D3D1C7" stroke="#888780" stroke-width="0.6"/>`;
        const base = (W.s - o.s0) / R;
        for (let j = 0; j < o.nb; j++) {
          const th = Math.PI + base + (2 * Math.PI * j) / o.nb;
          const kp = [[R, th - 0.06], [R + 8, th - 0.02], [R + 8, th + 0.02], [R, th + 0.06]].map(([r, a]) => f1(o.x + r * Math.sin(a)) + ',' + f1(ucy - r * Math.cos(a))).join(' ');
          h += `<polygon points="${kp}" fill="${C.blade}" stroke="${shade(C.blade, -0.2)}" stroke-width="0.8"/>`;
          const gb = base + (2 * Math.PI * j) / o.nb;
          const gp = [[R, gb - 0.1], [R - 8, gb - 0.07], [R - 8, gb + 0.07], [R, gb + 0.1]].map(([r, a]) => f1(o.x - r * Math.sin(a)) + ',' + f1(lcy - r * Math.cos(a))).join(' ');
          h += `<polygon points="${gp}" fill="#D3D1C7" stroke="#888780" stroke-width="0.8"/>`;
        }
      }
      h += lab;
    });
    return h;
  }

  function statusText(E) {
    const { L, W } = E, lines = [];
    let head = '동작 중';
    L.stations.forEach((o) => {
      const n = `${o.i + 1}. ${TYPE_LABEL[o.type]}`;
      if (o.type === 'rotary_notch') {
        if (W.s < SL0) { lines.push(`${n}: 상부 롤러가 올라가 있는 상태로 회전만 합니다.`); head = '준비'; return; }
        if (W.s < SL1) { lines.push(`${n}: 상부 롤러가 내려와 커터가 하부 롤러 홈에 맞물립니다.`); head = '롤러 하강'; return; }
        const parts = [];
        ['top', 'bottom'].forEach((ed) => {
          const e = o.e[ed]; if (e.cut === 'none') return;
          const nm = ed === 'top' ? '상부' : '하부';
          if (e.cut === 'trim') { parts.push(`${nm} 연속 일자 절단`); return; }
          const un = o.x + W.s, off = un - Math.floor(un / L.P) * L.P;
          parts.push(un < o.UE ? `${nm} 첫 탭 위치 대기` : off < e.T ? `${nm} 탭 구간 (커터 사이 간격만큼 남아 탭이 됨)` : `${nm} 노칭 영역 절단 중`);
        });
        lines.push(`${n}: ${parts.join(' · ')}`);
      } else if (o.type === 'press_notch') {
        lines.push(`${n}: ${W.dwell ? (W.q < 0.5 ? '시트 정지 · 펀치 하강 타발' : '펀치 상승') : '시트 간헐 이송 (한 피치 이동)'}`);
      } else if (o.type === 'laser_notch') {
        lines.push(`${n}: 레이저가 이동하는 시트의 윤곽을 따라 연속 절단`);
      } else if (o.type === 'rotary_cut') {
        const cur = cutLines(o, L, W.s, false).find((c) => c.p > 0 && c.p < 1);
        if (o.helical && cur) lines.push(`${n}: 나선 칼날 접촉점이 롤러 축을 따라 이동하며 절단 ${Math.round(cur.p * 100)}%${o.skew ? ' (경사 보정으로 직각 절단)' : ' (경사 없음 → 절단선이 기울어짐)'}`);
        else if (!o.helical && cutLines(o, L, W.s, false).some((c) => Math.abs(c.xr - o.x) < 2.5)) lines.push(`${n}: 일자 칼날이 폭 전체를 한순간에 절단`);
        else lines.push(`${n}: 다음 절단 위치까지 회전 (시트는 연속 이송)`);
      }
    });
    if (!L.stations.length) lines.push('표시할 공정이 없습니다.');
    return { head, text: lines.join('\n') };
  }

  /* ------------------------------------------------------------------
   * 5. 3D 장면
   * ------------------------------------------------------------------ */
  class Scene3D {
    constructor(wrap) {
      const T = window.THREE;
      this.T = T; this.wrap = wrap;
      const W = wrap.clientWidth || 680, H = wrap.clientHeight || 380;
      this.rd = new T.WebGLRenderer({ antialias: true });
      this.rd.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.rd.setSize(W, H);
      wrap.appendChild(this.rd.domElement);
      this.sc = new T.Scene();
      this.sc.background = new T.Color('#E9EBF0');
      this.cam = new T.PerspectiveCamera(30, W / H, 1, 6000);
      this.sc.add(new T.AmbientLight(0xffffff, 0.55));
      const d1 = new T.DirectionalLight(0xffffff, 0.75); d1.position.set(150, 300, 250); this.sc.add(d1);
      const d2 = new T.DirectionalLight(0xffffff, 0.3); d2.position.set(-200, 100, -150); this.sc.add(d2);
      this.ctl = T.OrbitControls ? new T.OrbitControls(this.cam, this.rd.domElement) : null;
      if (this.ctl) this.ctl.enableDamping = true;
      this.root = null; this.prisms = []; this.np = 0;
      this.onResize = () => this.resize();
      window.addEventListener('resize', this.onResize);
    }
    resize() {
      const W = this.wrap.clientWidth || 680, H = this.wrap.clientHeight || 380;
      if (W < 10) return;
      this.rd.setSize(W, H); this.cam.aspect = W / H; this.cam.updateProjectionMatrix();
    }
    disposeRoot() {
      if (!this.root) return;
      this.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.dispose) o.material.dispose(); });
      this.sc.remove(this.root); this.root = null;
    }
    build(L, C) {
      const T = this.T;
      this.disposeRoot();
      this.root = new T.Group(); this.sc.add(this.root);
      this.L = L; this.C = C; this.st = [];
      const M = (c, o) => new T.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.55, metalness: 0.05 }, o || {}));
      const mRoll = M(C.roller, { roughness: 0.45 }), mBlade = M(C.blade, { roughness: 0.35, metalness: 0.3 });
      const mDark = M(0x5f5e5a, { roughness: 0.8 }), mShaft = M(0xb4b2a9, { metalness: 0.5, roughness: 0.4 }), mGray = M(0xc9ccd3, { roughness: 0.6 });
      const Z = (y) => 95 - y;
      const roller = (len, R) => {
        const g = new T.Group();
        const b = new T.Mesh(new T.CylinderGeometry(R, R, len, 64), mRoll); b.rotation.x = Math.PI / 2; g.add(b);
        const sh = new T.Mesh(new T.CylinderGeometry(R * 0.2, R * 0.2, len + 50, 20), mShaft); sh.rotation.x = Math.PI / 2; g.add(sh);
        return g;
      };
      const sector = (r0, r1, a0, a1, depth, mat) => {
        const s = new T.Shape();
        s.moveTo(r1 * Math.cos(a0), r1 * Math.sin(a0)); s.absarc(0, 0, r1, a0, a1, false);
        s.lineTo(r0 * Math.cos(a1), r0 * Math.sin(a1)); s.absarc(0, 0, r0, a1, a0, true);
        return new T.Mesh(new T.ExtrudeGeometry(s, { depth, bevelEnabled: false, curveSegments: 18 }), mat);
      };
      L.stations.forEach((o) => {
        const x3 = o.x - 380, rec = { o };
        if (o.type === 'rotary_notch') {
          const R = o.R, up = roller(150, R), lo = roller(150, R);
          up.position.x = lo.position.x = x3;
          this.root.add(up); this.root.add(lo);
          const aU = (u) => -Math.PI / 2 + (u - o.x) / R, aL = (u) => Math.PI / 2 - (u - o.x) / R;
          L.bands.forEach((b) => {
            if (b.role === 'mid') return;
            const e = o.e[b.role]; if (e.cut === 'none') return;
            const zin = b.role === 'top' ? Z(b.y1) : Z(b.y0), zout = b.role === 'top' ? Z(b.y0) : Z(b.y1), dirz = Math.sign(zout - zin);
            if (e.cut === 'trim') {
              const ring = new T.Mesh(new T.TorusGeometry(R + 1.6, 1.7, 10, 100), mBlade); ring.position.z = zin; up.add(ring);
              const rg = new T.Mesh(new T.TorusGeometry(R, 1.5, 8, 100), mDark); rg.position.z = zin; lo.add(rg);
              return;
            }
            for (let j = 0; j < o.segs; j++) {
              const a0 = aU(j * L.P + e.T), a1 = aU((j + 1) * L.P);
              const bl = sector(R - 2, R + 4, a0, a1, 2.6, mBlade); bl.position.z = zin - 1.3; up.add(bl);
              const len = Math.abs(zout - zin) + 6, zc = zin + dirz * len / 2;
              [a0, a1].forEach((a) => { const m = new T.Mesh(new T.BoxGeometry(6, 2, len), mBlade); m.rotation.z = a; m.position.set((R + 1) * Math.cos(a), (R + 1) * Math.sin(a), zc); up.add(m); });
              const b0 = aL((j + 1) * L.P), b1 = aL(j * L.P + e.T);
              const gr = sector(R - 2, R + 0.3, b0, b1, 3, mDark); gr.position.z = zin - 1.5; lo.add(gr);
              [aL(j * L.P), aL(j * L.P + e.T)].forEach((a) => { const m = new T.Mesh(new T.BoxGeometry(5, 2.8, len - 2), mDark); m.rotation.z = a; m.position.set((R - 1) * Math.cos(a), (R - 1) * Math.sin(a), zc); lo.add(m); });
            }
          });
          rec.up = up; rec.lo = lo;
        } else if (o.type === 'press_notch') {
          rec.punches = [];
          L.bands.forEach((b) => {
            if (b.role === 'mid') return;
            const e = o.e[b.role]; if (e.cut === 'none') return;
            const half = e.cut === 'tabs' ? (L.P - e.T) / 2 : L.P / 2;
            const zA = Z(b.y0), zB = Z(b.y1), zc = (zA + zB) / 2 + (b.role === 'top' ? 3 : -3), zw = Math.abs(zA - zB) + 6;
            const die = new T.Mesh(new T.BoxGeometry(half * 2 + 40, 30, zw + 30), mGray); die.position.set(x3, -16.5, zc); this.root.add(die);
            const punch = new T.Mesh(new T.BoxGeometry(half * 2, 44, zw), mBlade); punch.position.set(x3, 45, zc); this.root.add(punch);
            const plate = new T.Mesh(new T.BoxGeometry(half * 2 + 50, 10, zw + 40), mRoll); plate.position.set(x3, 72, zc); this.root.add(plate);
            rec.punches.push({ punch, plate });
          });
        } else if (o.type === 'laser_notch') {
          rec.heads = [];
          L.bands.forEach((b) => {
            if (b.role === 'mid') return;
            const e = o.e[b.role]; if (e.cut === 'none') return;
            const zin = b.role === 'top' ? Z(b.y1) : Z(b.y0), zout = b.role === 'top' ? Z(b.y0) : Z(b.y1);
            const head = new T.Mesh(new T.BoxGeometry(26, 34, 26), mGray); head.position.set(x3, 78, zin); this.root.add(head);
            const beam = new T.Mesh(new T.CylinderGeometry(0.8, 0.8, 1, 8), new T.MeshBasicMaterial({ color: C.laser })); this.root.add(beam);
            const spot = new T.Mesh(new T.SphereGeometry(2.4, 12, 12), new T.MeshBasicMaterial({ color: C.laser })); this.root.add(spot);
            rec.heads.push({ b, e, zin, zout, head, beam, spot });
          });
        } else if (o.type === 'rotary_cut') {
          const R = o.R, Lax = V.SPAN / Math.cos(o.alpha), len = Lax + 24;
          const sk = new T.Group(); sk.position.x = x3; sk.rotation.y = -o.alpha; this.root.add(sk);
          const up = roller(len, R), lo = roller(len, R);
          up.position.y = R + 0.9; lo.position.y = -(R + 0.9); sk.add(up); sk.add(lo);
          const dPhi = (o.f * L.P) / R;
          for (let j = 0; j < o.nb; j++) {
            const j0 = (2 * Math.PI * j) / o.nb;
            if (o.helical) {
              const pu = [], pl = [];
              for (let i = 0; i <= 40; i++) {
                const a = i / 40, z = -Lax / 2 + a * Lax, th = -dPhi * (a - 0.5) + j0;
                pu.push(new T.Vector3((R + 1) * Math.sin(th), (R + 1) * Math.cos(th), z));
                pl.push(new T.Vector3(-(R - 0.5) * Math.sin(th), (R - 0.5) * Math.cos(th), z));
              }
              up.add(new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3(pu), 60, 1.3, 6, false), mBlade));
              lo.add(new T.Mesh(new T.TubeGeometry(new T.CatmullRomCurve3(pl), 60, 1.2, 6, false), mDark));
            } else {
              const bl = new T.Mesh(new T.BoxGeometry(1.8, 6, Lax), mBlade); bl.position.set((R + 1) * Math.sin(j0), (R + 1) * Math.cos(j0), 0); bl.rotation.z = -j0; up.add(bl);
              const gv = new T.Mesh(new T.BoxGeometry(2.4, 4, Lax), mDark); gv.position.set(-(R - 0.5) * Math.sin(j0), (R - 0.5) * Math.cos(j0), 0); gv.rotation.z = j0; lo.add(gv);
            }
          }
          rec.up = up; rec.lo = lo; rec.sk = sk;
        }
        this.st.push(rec);
      });
      const xsAll = L.stations.map((o) => o.x - 380);
      const cx = xsAll.length ? (Math.min(...xsAll) + Math.max(...xsAll)) / 2 : 0;
      // 롤러가 기울어진 롤 커팅이 있으면 경사가 보이도록 더 위에서 내려다봄
      const skewed = L.stations.some((o) => o.type === 'rotary_cut' && o.alpha);
      this.home = skewed
        ? { pos: new T.Vector3(cx - 20, 470, 290), tgt: new T.Vector3(cx - 40, -10, 0) }
        : { pos: new T.Vector3(cx - 300, 250, 450), tgt: new T.Vector3(cx - 90, -10, 0) };
      this.resetCamera();
    }
    resetCamera() {
      if (!this.home) return;
      // 좁은 화면(휴대폰)에서는 같은 장면이 들어오도록 카메라를 뒤로 뺌
      const k = clamp(2.2 / (this.cam.aspect || 2), 1, 2.6);
      this.cam.position.copy(this.home.pos).sub(this.home.tgt).multiplyScalar(k).add(this.home.tgt);
      if (this.ctl) { this.ctl.target.copy(this.home.tgt); this.ctl.update(); } else this.cam.lookAt(this.home.tgt);
    }
    prism(color, op, metal) {
      const T = this.T;
      let it = this.prisms[this.np];
      if (!it) {
        const g = new T.BufferGeometry();
        g.setAttribute('position', new T.BufferAttribute(new Float32Array(108), 3));
        const m = new T.MeshStandardMaterial({ roughness: 0.6, metalness: 0.1 });
        const mesh = new T.Mesh(g, m); this.sc.add(mesh);
        it = { mesh, g, m }; this.prisms.push(it);
      }
      this.np++;
      it.mesh.visible = true; it.m.color.set(color); it.m.metalness = metal ? 0.3 : 0.05; it.m.roughness = metal ? 0.5 : 0.65;
      it.m.transparent = op < 1; it.m.opacity = op; it.m.depthWrite = op >= 1;
      return it;
    }
    setQuad(it, pts, y0, y1) {
      const P = it.g.attributes.position.array;
      const v = pts.map((p) => [p[0] - 380, 95 - p[1]]);
      const cx = (v[0][0] + v[1][0] + v[2][0] + v[3][0]) / 4, cz = (v[0][1] + v[1][1] + v[2][1] + v[3][1]) / 4;
      let n = 0;
      const tri = (a, b, c, want) => {
        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        if (nx * want[0] + ny * want[1] + nz * want[2] < 0) { const t = b; b = c; c = t; }
        [a, b, c].forEach((p) => { P[n++] = p[0]; P[n++] = p[1]; P[n++] = p[2]; });
      };
      const T3 = v.map((q) => [q[0], y1, q[1]]), B3 = v.map((q) => [q[0], y0, q[1]]);
      tri(T3[0], T3[1], T3[2], [0, 1, 0]); tri(T3[0], T3[2], T3[3], [0, 1, 0]);
      tri(B3[0], B3[2], B3[1], [0, -1, 0]); tri(B3[0], B3[3], B3[2], [0, -1, 0]);
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4, mx = (v[i][0] + v[j][0]) / 2 - cx, mz = (v[i][1] + v[j][1]) / 2 - cz, want = [mx, 0, mz];
        tri(T3[i], T3[j], B3[j], want); tri(T3[i], B3[j], B3[i], want);
      }
      it.g.attributes.position.needsUpdate = true;
      it.g.computeVertexNormals(); it.g.computeBoundingSphere();
    }
    update(E) {
      const { L, W, C } = E;
      if (!this.root || this.L !== L) return;
      this.np = 0;
      const h = 0.9;
      const clipPts = (pts) => pts.map(([x, y]) => [clamp(x, V.x0, V.x1), y]);
      L.bands.forEach((b) => {
        bandPolys(b, L, W).forEach((pg) => {
          const pts = polyPts(pg, b.y0, b.y1);
          if (Math.max(pts[1][0], pts[2][0]) < V.x0 || Math.min(pts[0][0], pts[3][0]) > V.x1) return;
          const it = this.prism(matColor(C, b.material), 1, b.material === 'foil');
          this.setQuad(it, clipPts(pts), -h, h);
        });
      });
      scrapPieces(L, W).forEach((sp) => {
        if (sp.op <= 0.02) return;
        if (sp.strip) {
          const pg = { L: { xr: sp.cl.xr - sp.g / 2, m: sp.cl.m }, R: { xr: sp.cl.xr + sp.g / 2, m: sp.cl.m } };
          const it = this.prism(C.coated, sp.op, false);
          this.setQuad(it, clipPts(polyPts(pg, V.yTop, V.yTop + V.W)), -h - sp.drop, h - sp.drop);
          return;
        }
        const x0 = Math.max(V.x0, sp.x0), x1 = Math.min(V.x1, sp.x1);
        if (x1 <= x0) return;
        const sh = sp.shift || 0;
        const it = this.prism(matColor(C, sp.mat), sp.op, sp.mat === 'foil');
        this.setQuad(it, [[x0, sp.y0 + sh], [x1, sp.y0 + sh], [x1, sp.y1 + sh], [x0, sp.y1 + sh]], -h - sp.drop, h - sp.drop);
      });
      for (let i = this.np; i < this.prisms.length; i++) this.prisms[i].mesh.visible = false;
      this.st.forEach((rec) => {
        const o = rec.o;
        if (o.type === 'rotary_notch') {
          rec.up.position.y = o.R + 0.9 + liftOf(W.s); rec.up.rotation.z = -W.s / o.R;
          rec.lo.position.y = -(o.R + 0.9); rec.lo.rotation.z = W.s / o.R;
        } else if (o.type === 'press_notch') {
          // 펀치 하단: 대기 23 → 최저 -1.2 (시트 관통, 다이 윗면 -1.5 직전)
          rec.punches.forEach((p) => { const yb = 23 - 24.2 * W.down; p.punch.position.y = yb + 22; p.plate.position.y = yb + 44 + 5; });
        } else if (o.type === 'laser_notch') {
          rec.heads.forEach((hd) => {
            const un = o.x + W.s, off = un - Math.floor(un / L.P) * L.P;
            let z = null;
            if (hd.e.cut === 'trim') z = hd.zin;
            else if (un >= o.UE) {
              if (off >= hd.e.T) z = hd.zin;
              if (off < 2.5 || Math.abs(off - hd.e.T) < 2.5 || L.P - off < 2.5) {
                const ph = off < 2.5 ? off / 2.5 : L.P - off < 2.5 ? 1 - (L.P - off) / 2.5 : Math.abs(off - hd.e.T) / 2.5;
                z = hd.zout + (hd.zin - hd.zout) * clamp(ph, 0, 1);
              }
            }
            const on = z != null;
            hd.beam.visible = hd.spot.visible = on;
            if (on) {
              const x3 = o.x - 380, top = 61;
              hd.beam.position.set(x3, (top + 1) / 2, (z + hd.zin) / 2);
              const dz = z - hd.zin, len = Math.sqrt((top - 1) * (top - 1) + dz * dz);
              hd.beam.scale.set(1, len, 1); hd.beam.rotation.set(Math.atan2(-dz, top - 1), 0, 0);
              hd.spot.position.set(x3, 1.2, z);
            }
          });
        } else if (o.type === 'rotary_cut') {
          // 상부 롤 하단(접촉점)과 하부 롤 상단이 시트와 같은 -x 방향으로 움직이도록 회전
          const base = (W.s - o.s0) / o.R;
          rec.up.rotation.z = Math.PI - base;
          rec.lo.rotation.z = base;
        }
      });
      if (this.ctl) this.ctl.update();
      this.rd.render(this.sc, this.cam);
    }
    destroy() { window.removeEventListener('resize', this.onResize); this.disposeRoot(); this.rd.dispose(); }
  }

  /* ------------------------------------------------------------------
   * 6. 샘플 사양
   * ------------------------------------------------------------------ */
  const SAMPLES = {
    toptec_mod: {
      title: '롤러 노칭 · 상부 직사각형 노칭 + 하부 일자 절단', source: 'KR102300705B1 (변형 컨셉)',
      summary: '상하 롤러가 시트 속도에 맞춰 회전하며, 상부 롤러의 성형지그 커터가 탭 쪽 가장자리를 직사각형으로 노칭해 탭을 남기고, 반대쪽 끝의 링 날이 하부 가장자리를 일자로 연속 절단한다.',
      web: { width_mm: 110, pitch_mm: 75, bands: [{ name: '무지부(탭)', width_mm: 22, material: 'foil' }, { name: '코팅부', width_mm: 76, material: 'coated' }, { name: '하부 절단부', width_mm: 12, material: 'coated' }], preformed_tabs: null },
      stations: [{ id: 's1', type: 'rotary_notch', label: '노칭유닛 120 (제1롤러 130 / 제2롤러 140)', edges: { top: { cut: 'tabs', tab_width_mm: 24 }, bottom: { cut: 'trim' } }, segments_per_rev: 4 }],
      parts: [{ no: '130', name: '제1롤러', role: '승강하며 회전, 성형지그 4세트 장착' }, { no: '134', name: '리드성형커터', role: '탭 양옆 세로 절단' }, { no: '135', name: '노칭커터', role: '탭 아래 선을 따라 연속 절단' }, { no: '140', name: '제2롤러', role: '성형슬롯으로 커터를 받음' }],
      evidence: [{ text: '상하 롤러 회전으로 가위처럼 점진 절단', source: '본문, 도 5~7' }, { text: '성형지그 사이 간격 T만큼 리드가 남음', source: '도 3' }],
      assumptions: ['하부 일자 절단은 원 특허를 변형한 검토 컨셉', '치수는 설명용 값'], unsupported: [],
    },
    toptec_orig: {
      title: '롤러 노칭 · 양쪽 가장자리 탭 노칭 (원 특허)', source: 'KR102300705B1',
      summary: '상하 롤러가 회전하며 시트 폭 방향 양쪽 가장자리를 동시에 노칭해, 양쪽에 리드(탭)를 남긴다. 원 특허의 커팅유닛은 표시하지 않았다.',
      web: { width_mm: 110, pitch_mm: 75, bands: [{ name: '상부 무지부', width_mm: 20, material: 'foil' }, { name: '코팅부', width_mm: 70, material: 'coated' }, { name: '하부 무지부', width_mm: 20, material: 'foil' }], preformed_tabs: null },
      stations: [{ id: 's1', type: 'rotary_notch', label: '노칭유닛 120', edges: { top: { cut: 'tabs', tab_width_mm: 14 }, bottom: { cut: 'tabs', tab_width_mm: 14 } }, segments_per_rev: 4 }],
      parts: [{ no: '130', name: '제1롤러', role: '성형지그 131 장착' }, { no: '140', name: '제2롤러', role: '가이드지그 141' }],
      evidence: [{ text: '전극시트 폭방향 양측에 리드를 성형하며 연속 노칭', source: '청구항 1' }],
      assumptions: ['원 특허의 커팅유닛 150 생략'], unsupported: ['커팅유닛 150 (상하 커터 승강 절단)'],
    },
    sany: {
      title: '나선 칼날 롤 커팅 (낱장 절단)', source: 'CN114833401A',
      summary: '탭이 이미 성형된 극판을, 기울어진 롤러의 나선 칼날이 회전하며 점진적으로 잘라 낱장으로 분리한다. 롤러를 기울여 절단선이 이송 방향에 직각이 되게 한다.',
      web: { width_mm: 110, pitch_mm: 150, bands: [{ name: '탭', width_mm: 20, material: 'foil' }, { name: '극판 바디', width_mm: 90, material: 'coated' }], preformed_tabs: { edge: 'top', tab_width_mm: 54 } },
      stations: [{ id: 's1', type: 'rotary_cut', label: '극판 롤 30 · 제2롤 40', blade: 'helical', skew: true, scrap_width_mm: 0 }],
      parts: [{ no: '20', name: '극판 절단칼', role: '롤 표면에 나선형 배치' }, { no: '30', name: '제1롤체', role: '종동, 칼날 장착' }, { no: '40', name: '제2롤체', role: '구동, 수용 홈' }, { no: '60', name: '탄성부', role: '축방향 힘 흡수' }],
      evidence: [{ text: '롤 축이 이송 방향과 협각을 이뤄 절단선이 이송 방향에 수직', source: '본문 [0035] 부근, 도 4' }],
      assumptions: ['경사각과 칼날이 감기는 비율은 설명용 값'], unsupported: [],
    },
    press: {
      title: '금형 프레스 노칭 (비교용)', source: '일반 공법',
      summary: '시트를 한 피치씩 간헐 이송하고, 멈춘 사이 펀치가 내려와 다이와 함께 무지부를 타발해 탭을 남긴다.',
      web: { width_mm: 110, pitch_mm: 90, bands: [{ name: '무지부(탭)', width_mm: 22, material: 'foil' }, { name: '코팅부', width_mm: 88, material: 'coated' }], preformed_tabs: null },
      stations: [{ id: 's1', type: 'press_notch', label: '노칭 금형 (펀치·다이)', edges: { top: { cut: 'tabs', tab_width_mm: 26 }, bottom: { cut: 'none' } } }],
      parts: [{ no: '-', name: '펀치', role: '상하 왕복 타발' }, { no: '-', name: '다이', role: '하부 고정 날' }],
      evidence: [], assumptions: ['비교용 일반 구성'], unsupported: [],
    },
    laser: {
      title: '레이저 노칭 (비교용)', source: '일반 공법',
      summary: '시트를 멈추지 않고 이송하면서 레이저 스폿이 탭 윤곽을 따라 무지부를 절단한다.',
      web: { width_mm: 110, pitch_mm: 90, bands: [{ name: '무지부(탭)', width_mm: 22, material: 'foil' }, { name: '코팅부', width_mm: 88, material: 'coated' }], preformed_tabs: null },
      stations: [{ id: 's1', type: 'laser_notch', label: '레이저 헤드 (갈바노 스캐너)', edges: { top: { cut: 'tabs', tab_width_mm: 26 }, bottom: { cut: 'none' } } }],
      parts: [{ no: '-', name: '레이저 헤드', role: '스폿을 윤곽 경로로 이동' }],
      evidence: [], assumptions: ['비교용 일반 구성'], unsupported: [],
    },
  };
  const SAMPLE_NAMES = { toptec_mod: '톱텍 변형: 상부 노칭 + 하부 일자', toptec_orig: '톱텍 원 특허: 양쪽 노칭', sany: 'Sany: 나선 칼날 롤 커팅', press: '비교: 금형 프레스 노칭', laser: '비교: 레이저 노칭' };

  /* ------------------------------------------------------------------
   * 7. EXAONE 호출
   * ------------------------------------------------------------------ */
  const SYSTEM_PROMPT = [
    '너는 이차전지 전극 공정 설비 특허를 읽고, 장치가 어떻게 움직이는지 애니메이션 엔진용 "동작 사양 JSON"으로 바꾸는 엔지니어다.',
    '반드시 JSON 객체 하나만 출력한다. 설명 문장, 마크다운, 코드블록은 쓰지 않는다.',
    '',
    '[엔진이 표현할 수 있는 것]',
    '- web: 오른쪽에서 왼쪽으로 이송되는 전극 시트. bands는 시트 폭 방향 띠를 위쪽 가장자리부터 아래쪽 가장자리 순서로 나열한다. material은 coated(활물질 코팅부), foil(무지부·탭이 되는 금속박), other 중 하나.',
    '- web.pitch_mm: 전극 1개 길이(탭 간격). web.preformed_tabs: 장치에 들어오기 전에 이미 탭이 있으면 {"edge":"top"|"bottom","tab_width_mm":숫자}, 없으면 null.',
    '- stations: 시트가 지나는 순서(상류→하류)로 최대 3개. type은 아래 4개 중 하나만 쓴다.',
    '  rotary_notch: 상하 롤러 한 쌍이 회전하며 가장자리를 노칭(롤러 외주 커터 + 상대 롤러의 홈/슬롯).',
    '  press_notch: 금형(펀치·다이)이 상하로 움직여 타발. 시트는 간헐 이송.',
    '  laser_notch: 레이저로 가장자리 윤곽을 절단.',
    '  rotary_cut: 롤러 칼날로 시트를 폭 방향으로 잘라 낱장 분리.',
    '- rotary_notch, press_notch, laser_notch는 "edges":{"top":{"cut":"tabs"|"trim"|"none","tab_width_mm":숫자},"bottom":{...}}. tabs=탭만 남기고 사이를 잘라냄, trim=가장자리를 일자로 연속 절단, none=자르지 않음.',
    '- rotary_notch는 "segments_per_rev"(롤러 1회전당 전극 수 = 도면의 성형지그·커터 세트 수)와 알면 "roller_diameter_mm".',
    '- rotary_cut은 "blade":"straight"|"helical", "skew":true|false(롤러 축이 이송 방향에 비스듬히 기울어 있으면 true), "scrap_width_mm"(이중 칼날로 띠를 잘라내면 그 폭, 아니면 0).',
    '- "colors"는 사용자가 색을 요청할 때만 넣는다: {"coated":"#RRGGBB","foil":"#RRGGBB","roller":"#RRGGBB","blade":"#RRGGBB"}.',
    '',
    '[출력 형식]',
    '{"title":"","source":"특허/논문 번호","summary":"장치가 무엇을 어떻게 하는지 2~3문장",',
    ' "web":{"width_mm":0,"pitch_mm":0,"bands":[{"name":"","width_mm":0,"material":"coated"}],"preformed_tabs":null},',
    ' "stations":[{"id":"s1","type":"rotary_notch","label":"도면 부호를 포함한 이름","edges":{"top":{"cut":"tabs","tab_width_mm":0},"bottom":{"cut":"none"}},"segments_per_rev":4}],',
    ' "parts":[{"no":"부호","name":"부품명","role":"역할"}],',
    ' "evidence":[{"text":"사양에 반영한 사실","source":"근거 위치(도 3, 청구항 4 등)"}],',
    ' "assumptions":["특허에 없어 추정한 내용"],',
    ' "unsupported":["엔진 유형으로 표현할 수 없는 기구나 동작"]}',
    '',
    '[규칙]',
    '- 치수(mm)는 특허에 있으면 그 값, 없으면 도면 비율로 추정하고 assumptions에 적는다.',
    '- 특허에 근거가 있는 것만 evidence에, 추정은 assumptions에 넣는다. 근거 없이 단정하지 않는다.',
    '- 4가지 유형에 맞지 않는 기구는 가장 가까운 유형으로 근사하고, 차이를 unsupported에 적는다.',
    '- 모든 문장은 한국어로 쓴다.',
  ].join('\n');

  function exaoneTarget() {
    let proxy = '';
    try { proxy = typeof window.getExaoneProxyUrl === 'function' ? window.getExaoneProxyUrl() : (localStorage.getItem('exaoneProxyUrl') || ''); } catch (e) { proxy = ''; }
    if (!proxy && typeof getExaoneProxyUrl === 'function') { try { proxy = getExaoneProxyUrl(); } catch (e) { /* noop */ } }
    const key = (localStorage.getItem('exaoneApiKey') || '').trim();
    return { proxy: (proxy || '').trim(), key };
  }

  async function exaoneChat(messages, opt) {
    const { proxy, key } = exaoneTarget();
    if (!proxy && !key) {
      const err = new Error('EXAONE 연결 정보가 없습니다. AI 설정에서 EXAONE 보안 프록시 URL 또는 API 키를 입력하세요.');
      err.code = 'no_config'; throw err;
    }
    const url = proxy || EXAONE_URL;
    const headers = { 'Content-Type': 'application/json' };
    if (!proxy && key) headers.Authorization = `Bearer ${key}`;
    const ctrl = new AbortController();
    const tm = setTimeout(() => ctrl.abort(), (opt && opt.timeoutMs) || 180000);
    try {
      const res = await fetch(url, {
        method: 'POST', headers, signal: ctrl.signal,
        body: JSON.stringify({
          model: EXAONE_MODEL, messages, temperature: 0.4, top_p: 0.95, top_k: 20,
          max_tokens: (opt && opt.maxTokens) || 6000,
          chat_template_kwargs: { enable_thinking: !!(opt && opt.thinking) },
        }),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        const slow = /timed?\s*out|timeout/i.test(t) || res.status === 504;
        throw new Error(`EXAONE 오류 ${res.status}${t ? ': ' + t.slice(0, 240) : ''}${slow ? '\n→ 프록시가 응답을 기다리다 끊었습니다. 도면 수를 줄이거나 \'깊게 생각하기\'를 끄고 다시 시도하세요. 로컬 프록시는 기본 60초 제한입니다.' : ''}`);
      }
      const data = await res.json();
      const msg = data && data.choices && data.choices[0] && data.choices[0].message;
      return String((msg && msg.content) || '');
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('EXAONE 응답 시간 초과 (도면 수를 줄이거나 다시 시도하세요)');
      if (e instanceof TypeError) throw new Error(`EXAONE에 연결하지 못했습니다 (${proxy ? '프록시 ' + proxy : '직접 호출'}). 프록시가 켜져 있는지, 주소가 맞는지 확인하세요.`);
      throw e;
    } finally { clearTimeout(tm); }
  }

  function extractJson(text) {
    let t = String(text || '');
    t = t.replace(/<(think|thought|thinking)>[\s\S]*?<\/\1>/gi, '');
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1];
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('응답에서 JSON을 찾지 못했습니다.');
    return JSON.parse(t.slice(a, b + 1));
  }

  async function chatJson(messages, opt, log) {
    const raw = await exaoneChat(messages, opt);
    try { return extractJson(raw); } catch (e) {
      log && log('JSON 형식이 맞지 않아 한 번 더 정리 요청합니다…');
      const fix = await exaoneChat([
        { role: 'system', content: '입력 텍스트에서 JSON 객체 하나만 올바른 문법으로 고쳐서 출력한다. 다른 글은 쓰지 않는다.' },
        { role: 'user', content: raw.slice(0, 20000) },
      ], { maxTokens: 4000, thinking: false });
      return extractJson(fix);
    }
  }

  /* ------------------------------------------------------------------
   * 8. PDF 처리
   * ------------------------------------------------------------------ */
  async function ensurePdfJs() {
    if (!window.pdfjsLib) await loadScript(CDN.pdf);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;
    return window.pdfjsLib;
  }
  async function readPdf(file, onProgress) {
    const lib = await ensurePdfJs();
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await lib.getDocument({ data }).promise;
    const n = Math.min(doc.numPages, 40), pages = [];
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      const text = tc.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
      const vp0 = page.getViewport({ scale: 1 });
      const sc = 150 / vp0.width, vp = page.getViewport({ scale: sc });
      const cv = document.createElement('canvas'); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
      await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
      pages.push({ no: i, text, chars: text.replace(/\s/g, '').length, thumb: cv.toDataURL('image/jpeg', 0.7), sel: false });
      onProgress && onProgress(i, n);
    }
    const drawingKw = /도면\s*\d|附图|FIG\.?\s*\d|图\s*\d/;
    pages.forEach((p, idx) => { p.sel = idx > 0 && p.chars < 400 && (drawingKw.test(p.text) || p.chars < 120); });
    let cnt = 0;
    pages.forEach((p) => { if (p.sel) { cnt++; if (cnt > 4) p.sel = false; } });
    return { doc, pages, total: doc.numPages };
  }
  async function pageImage(doc, no) {
    const page = await doc.getPage(no);
    const vp0 = page.getViewport({ scale: 1 }), sc = Math.min(2.2, 1100 / vp0.width), vp = page.getViewport({ scale: sc });
    const cv = document.createElement('canvas'); cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return cv.toDataURL('image/jpeg', 0.82);
  }
  function pickText(pages, limit) {
    const full = pages.map((p) => `[${p.no}쪽] ${p.text}`).join('\n');
    if (full.length <= limit) return full;
    const keys = ['도면의 간단한 설명', '부호의 설명', '附图说明', '附图标记', 'BRIEF DESCRIPTION OF THE DRAWINGS', 'REFERENCE', '청구항 1', '权利要求', '발명을 실시하기 위한', '具体实施方式', 'DETAILED DESCRIPTION'];
    const parts = [full.slice(0, Math.floor(limit * 0.35))];
    let budget = limit - parts[0].length;
    keys.forEach((k) => {
      if (budget <= 300) return;
      const i = full.indexOf(k, parts[0].length);
      if (i < 0) return;
      const take = Math.min(2600, budget);
      parts.push('…' + full.slice(i, i + take));
      budget -= take + 1;
    });
    return parts.join('\n').slice(0, limit);
  }

  /* ------------------------------------------------------------------
   * 9. UI
   * ------------------------------------------------------------------ */
  const CSS = `
  #tab-patentmotion .pm-intro{color:rgba(255,255,255,.65);font-size:13px;margin:-8px 0 16px;line-height:1.6}
  #tab-patentmotion .pm-card{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:16px 18px;margin-bottom:16px}
  #tab-patentmotion .pm-card h3{font-size:15px;margin:0 0 10px;display:flex;align-items:center;gap:8px}
  #tab-patentmotion .pm-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:8px 0}
  #tab-patentmotion .pm-muted{color:rgba(255,255,255,.6);font-size:12px}
  #tab-patentmotion .pm-drop{border:1.5px dashed rgba(0,212,255,.5);border-radius:10px;padding:18px;text-align:center;color:rgba(255,255,255,.75);cursor:pointer;font-size:13px}
  #tab-patentmotion .pm-drop.over{background:rgba(0,212,255,.08)}
  #tab-patentmotion .pm-thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px;margin-top:10px;max-height:300px;overflow:auto}
  #tab-patentmotion .pm-thumb{position:relative;border:2px solid transparent;border-radius:6px;cursor:pointer;background:#fff;overflow:hidden}
  #tab-patentmotion .pm-thumb img{width:100%;display:block}
  #tab-patentmotion .pm-thumb.sel{border-color:#00d4ff}
  #tab-patentmotion .pm-thumb span{position:absolute;left:0;bottom:0;right:0;background:rgba(26,26,46,.8);color:#fff;font-size:11px;padding:2px 4px}
  #tab-patentmotion .pm-thumb.sel span{background:#0086a8}
  #tab-patentmotion .pm-log{font-size:12px;color:rgba(255,255,255,.75);white-space:pre-wrap;margin-top:8px;min-height:18px}
  #tab-patentmotion .pm-err{color:#ff8a8a}
  #tab-patentmotion .pm-view{background:#F3F4F7;border-radius:10px;overflow:hidden;margin-top:8px}
  #tab-patentmotion .pm-view svg{display:block;width:100%;max-width:880px;height:auto;margin:0 auto}
  #tab-patentmotion .pm-3d{height:380px;position:relative;cursor:grab}
  #tab-patentmotion .pm-3d .pm-hint{position:absolute;left:10px;bottom:8px;font-size:11px;color:#5F5E5A;pointer-events:none}
  #tab-patentmotion .pm-label{font-size:12px;color:rgba(255,255,255,.65);margin-top:12px}
  #tab-patentmotion .pm-status{font-weight:600;font-size:14px}
  #tab-patentmotion .pm-status-sub{font-size:12px;color:rgba(255,255,255,.7);white-space:pre-line;min-height:34px}
  #tab-patentmotion .pm-badge{display:inline-block;font-size:11px;border-radius:10px;padding:1px 8px;margin-right:6px}
  #tab-patentmotion .pm-b-ev{background:rgba(0,255,136,.15);color:#7dffbf}
  #tab-patentmotion .pm-b-as{background:rgba(255,193,7,.15);color:#ffd36b}
  #tab-patentmotion .pm-b-un{background:rgba(255,107,107,.18);color:#ff9b9b}
  #tab-patentmotion .pm-list{margin:6px 0 0;padding-left:0;list-style:none;font-size:13px;line-height:1.6}
  #tab-patentmotion .pm-list li{margin:3px 0}
  #tab-patentmotion table.pm-tbl{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}
  #tab-patentmotion table.pm-tbl td,#tab-patentmotion table.pm-tbl th{border-bottom:1px solid rgba(255,255,255,.1);padding:5px 6px;text-align:left;vertical-align:top}
  #tab-patentmotion textarea.pm-ta{width:100%;min-height:70px;background:rgba(0,0,0,.25);color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:8px;font-size:13px;font-family:inherit;resize:vertical;box-sizing:border-box}
  #tab-patentmotion textarea.pm-json{min-height:220px;font-family:Consolas,monospace;font-size:12px}
  #tab-patentmotion .pm-colors label{display:inline-flex;align-items:center;gap:4px;font-size:12px;color:rgba(255,255,255,.75)}
  #tab-patentmotion .pm-colors input[type=color]{width:28px;height:22px;border:none;background:none;padding:0;cursor:pointer}
  #tab-patentmotion select.pm-sel{background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:8px 10px;font-size:13px}
  #tab-patentmotion select.pm-sel option{color:#000}
  #tab-patentmotion details summary{cursor:pointer;font-size:13px;color:rgba(255,255,255,.8)}
  @media (max-width:600px){#tab-patentmotion .pm-3d{height:300px}#tab-patentmotion .pm-card{padding:12px}}
  `;

  const HTML = `
  <div class="section-header">
    <h2><i class="fas fa-film"></i> 특허 모션</h2>
    <div class="pm-row" style="margin:0">
      <select class="pm-sel" id="pmSample"><option value="">샘플 불러오기…</option></select>
      <button class="btn btn-secondary" id="pmSaveJson"><i class="fas fa-download"></i> 사양 저장</button>
      <button class="btn btn-secondary" id="pmLoadJsonBtn"><i class="fas fa-folder-open"></i> 사양 열기</button>
      <input type="file" id="pmLoadJson" accept=".json,application/json" style="display:none">
    </div>
  </div>
  <p class="pm-intro">특허·논문 PDF를 첨부하면 EXAONE이 도면과 본문을 해석해 장치 동작을 애니메이션으로 보여 줍니다. AI 해석은 틀릴 수 있으니 '근거'와 '추정' 표시를 꼭 확인하세요. 미공개 사내 자료를 올릴 때는 보안 규정을 확인하세요.</p>

  <div class="pm-card">
    <h3><i class="fas fa-file-pdf"></i> 1. PDF 첨부</h3>
    <div class="pm-drop" id="pmDrop"><i class="fas fa-cloud-upload-alt"></i> 여기를 눌러 PDF를 고르거나 끌어다 놓으세요<input type="file" id="pmFile" accept="application/pdf,.pdf" style="display:none"></div>
    <div id="pmPdfInfo" class="pm-muted" style="margin-top:8px"></div>
    <div class="pm-thumbs" id="pmThumbs"></div>
    <div class="pm-row" id="pmAnalyzeRow" style="display:none">
      <button class="btn btn-primary" id="pmAnalyze"><i class="fas fa-magic"></i> AI 분석 시작</button>
      <label class="pm-muted"><input type="checkbox" id="pmThink"> 깊게 생각하기 (느리지만 정확도↑)</label>
      <span class="pm-muted">파란 테두리 = AI에 보낼 도면 페이지 (클릭해 선택/해제, 최대 6장)</span>
    </div>
    <div class="pm-log" id="pmLog"></div>
  </div>

  <div class="pm-card">
    <h3><i class="fas fa-play-circle"></i> 2. 동작 시연 <span class="pm-muted" id="pmTitle" style="font-weight:400"></span></h3>
    <div class="pm-row">
      <button class="btn btn-secondary" id="pmPlay"><i class="fas fa-pause"></i> 일시정지</button>
      <button class="btn btn-secondary" id="pmReset"><i class="fas fa-redo"></i> 처음부터</button>
      <button class="btn btn-secondary" id="pmCam"><i class="fas fa-video"></i> 시점 초기화</button>
      <span class="pm-muted">속도</span><input type="range" id="pmSpeed" min="0.25" max="2" step="0.25" value="1" style="width:110px"><span class="pm-muted" id="pmSpeedOut">1x</span>
      <span class="pm-colors" id="pmColors"></span>
    </div>
    <div class="pm-status" id="pmStatus">-</div>
    <div class="pm-status-sub" id="pmStatusSub"></div>
    <div class="pm-label">3D 사선 뷰 · 탭 쪽이 앞</div>
    <div class="pm-view pm-3d" id="pm3d"><span class="pm-hint" id="pm3dHint">드래그로 회전 · 휠로 확대/축소</span></div>
    <div class="pm-label">측면도 · 시트는 오른쪽에서 왼쪽으로 이송</div>
    <div class="pm-view"><svg id="pmSide" viewBox="0 0 680 300" role="img" aria-label="측면도"></svg></div>
    <div class="pm-label">평면도 · 측면도와 같은 가로 위치 기준</div>
    <div class="pm-view"><svg id="pmTop" viewBox="0 0 680 205" role="img" aria-label="평면도"></svg></div>
  </div>

  <div class="pm-card">
    <h3><i class="fas fa-clipboard-check"></i> 3. 해석 결과</h3>
    <div id="pmResult" class="pm-muted">아직 사양이 없습니다.</div>
  </div>

  <div class="pm-card">
    <h3><i class="fas fa-edit"></i> 4. 수정 요청</h3>
    <textarea class="pm-ta" id="pmFix" placeholder="예: 바디부는 검정, 탭은 구리색으로 / 하부는 일자로 자르게 바꿔줘 / 롤러 1회전에 탭 6개"></textarea>
    <div class="pm-row"><button class="btn btn-primary" id="pmFixBtn"><i class="fas fa-paper-plane"></i> AI로 수정</button><span class="pm-log" id="pmFixLog" style="margin:0"></span></div>
    <details style="margin-top:8px"><summary>사양 JSON 직접 편집</summary>
      <textarea class="pm-ta pm-json" id="pmJson" spellcheck="false"></textarea>
      <div class="pm-row"><button class="btn btn-secondary" id="pmJsonApply"><i class="fas fa-check"></i> 적용</button><span class="pm-log" id="pmJsonLog" style="margin:0"></span></div>
    </details>
  </div>`;

  const state = {
    inited: false, spec: null, layout: null, t: 0, run: true, speed: 1, last: null,
    scene: null, pdf: null, warnings: [], raf: null, busy: false,
  };

  function setLog(id, msg, isErr) {
    const el = $(id); if (!el) return;
    el.innerHTML = msg ? `<span class="${isErr ? 'pm-err' : ''}">${esc(msg)}</span>` : '';
  }

  function renderResult() {
    const s = state.spec, el = $('pmResult');
    if (!s) { el.innerHTML = '아직 사양이 없습니다.'; return; }
    const li = (arr, cls, label) => arr.map((x) => `<li><span class="pm-badge ${cls}">${label}</span>${esc(typeof x === 'string' ? x : x.text)}${x && x.source ? ` <span class="pm-muted">(${esc(x.source)})</span>` : ''}</li>`).join('');
    const st = s.stations.map((o, i) => {
      let d = '';
      if (o.edges) d = ['top', 'bottom'].map((ed) => { const e = o.edges[ed]; const nm = ed === 'top' ? '상부' : '하부'; return e.cut === 'none' ? '' : `${nm}: ${e.cut === 'tabs' ? '탭 노칭 (탭 폭 ' + f1(e.tab_width_mm) + 'mm)' : '일자 절단'}`; }).filter(Boolean).join(', ');
      if (o.type === 'rotary_cut') d = `${o.blade === 'helical' ? '나선 칼날' : '일자 칼날'}${o.skew ? ', 롤러 경사' : ''}${o.scrap_width_mm ? ', 스크랩 띠 ' + o.scrap_width_mm + 'mm' : ', 스크랩 없음'}`;
      return `<li>${i + 1}. <b>${esc(TYPE_LABEL[o.type])}</b> · ${esc(o.label)}${d ? ' — ' + esc(d) : ''}</li>`;
    }).join('');
    const bands = s.web.bands.map((b) => `${esc(b.name || b.material)} ${f1(b.width_mm)}mm`).join(' / ');
    el.innerHTML = `
      <div style="font-size:14px;font-weight:600;color:#fff">${esc(s.title)} <span class="pm-muted">${esc(s.source)}</span></div>
      <p style="font-size:13px;color:rgba(255,255,255,.85);margin:6px 0 8px;line-height:1.6">${esc(s.summary)}</p>
      <div class="pm-muted">시트: 폭 ${f1(s.web.width_mm)}mm · 피치 ${f1(s.web.pitch_mm)}mm · 띠(위→아래) ${bands}${s.web.preformed_tabs ? ' · 탭 사전 성형' : ''}</div>
      <ul class="pm-list">${st || '<li class="pm-muted">공정 없음</li>'}</ul>
      ${s.parts.length ? `<table class="pm-tbl"><tr><th>부호</th><th>부품</th><th>역할</th></tr>${s.parts.map((p) => `<tr><td>${esc(p.no)}</td><td>${esc(p.name)}</td><td>${esc(p.role)}</td></tr>`).join('')}</table>` : ''}
      <ul class="pm-list">${li(s.evidence, 'pm-b-ev', '근거')}${li(s.assumptions, 'pm-b-as', '추정')}${li(s.unsupported, 'pm-b-un', '미표현')}${li(state.warnings, 'pm-b-un', '자동 보정')}</ul>`;
  }

  function renderColors() {
    const c = state.spec ? state.spec.colors : DEF_COLORS;
    const items = [['coated', '바디'], ['foil', '탭/포일'], ['roller', '롤러'], ['blade', '커터']];
    $('pmColors').innerHTML = items.map(([k, n]) => `<label>${n}<input type="color" data-k="${k}" value="${c[k]}"></label>`).join(' ');
    $('pmColors').querySelectorAll('input').forEach((inp) => {
      inp.addEventListener('change', () => {
        if (!state.spec) return;
        state.spec.colors[inp.dataset.k] = inp.value;
        applySpec(state.spec, { keepTime: true, silent: true });
      });
    });
  }

  function applySpec(raw, opt) {
    const { spec, warnings } = normalizeSpec(raw);
    state.spec = spec; state.warnings = warnings;
    state.layout = buildLayout(spec);
    if (!(opt && opt.keepTime)) state.t = 0;
    if (state.scene) state.scene.build(state.layout, spec.colors);
    $('pmTitle').textContent = '· ' + spec.title;
    $('pmJson').value = JSON.stringify(spec, null, 2);
    try { localStorage.setItem('pm_last_spec', JSON.stringify(spec)); } catch (e) { /* noop */ }
    renderResult();
    if (!(opt && opt.silent)) renderColors();
  }

  function frame(ts) {
    state.raf = requestAnimationFrame(frame);
    const tab = $('tab-patentmotion');
    if (!tab || !tab.classList.contains('active')) { state.last = null; return; }
    if (state.last == null) state.last = ts;
    const dt = Math.min(0.05, (ts - state.last) / 1000);
    state.last = ts;
    if (state.run) state.t += dt * state.speed;
    if (!state.layout) return;
    const E = { L: state.layout, W: webState(state.layout, state.t), C: state.spec.colors };
    $('pmTop').innerHTML = renderTop(E);
    $('pmSide').innerHTML = renderSide(E);
    const st = statusText(E);
    $('pmStatus').textContent = st.head;
    $('pmStatusSub').textContent = st.text;
    if (state.scene) state.scene.update(E);
  }

  async function init3D() {
    try {
      if (!window.THREE) await loadScript(CDN.three);
      if (!window.THREE.OrbitControls) await loadScript(CDN.orbit).catch(() => null);
      state.scene = new Scene3D($('pm3d'));
      if (state.layout) state.scene.build(state.layout, state.spec.colors);
    } catch (e) {
      $('pm3dHint').textContent = '3D 뷰를 불러오지 못했습니다. 측면도와 평면도는 정상 동작합니다.';
    }
  }

  function renderThumbs() {
    const box = $('pmThumbs');
    if (!state.pdf) { box.innerHTML = ''; return; }
    box.innerHTML = state.pdf.pages.map((p) => `<div class="pm-thumb ${p.sel ? 'sel' : ''}" data-no="${p.no}" title="${p.chars}자"><img src="${p.thumb}" alt="${p.no}쪽"><span>${p.no}쪽${p.sel ? ' · 도면' : ''}</span></div>`).join('');
    box.querySelectorAll('.pm-thumb').forEach((d) => {
      d.addEventListener('click', () => {
        const p = state.pdf.pages.find((x) => x.no === +d.dataset.no);
        const cnt = state.pdf.pages.filter((x) => x.sel).length;
        if (!p.sel && cnt >= 6) { setLog('pmLog', '도면 이미지는 최대 6장까지 보낼 수 있습니다.', true); return; }
        p.sel = !p.sel; renderThumbs();
      });
    });
  }

  async function onFile(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { setLog('pmLog', 'PDF 파일만 첨부할 수 있습니다.', true); return; }
    if (file.size > 40 * 1024 * 1024) { setLog('pmLog', '40MB 이하 PDF만 처리합니다.', true); return; }
    setLog('pmLog', 'PDF를 읽는 중…');
    state.pdf = null; renderThumbs();
    $('pmPdfInfo').textContent = ''; $('pmAnalyzeRow').style.display = 'none';
    try {
      const pdf = await readPdf(file, (i, n) => setLog('pmLog', `PDF를 읽는 중… ${i}/${n}쪽`));
      pdf.name = file.name;
      state.pdf = pdf;
      const sel = pdf.pages.filter((p) => p.sel).length;
      $('pmPdfInfo').textContent = `${file.name} · ${pdf.total}쪽${pdf.total > 40 ? ' (앞 40쪽만 사용)' : ''} · 도면으로 보이는 페이지 ${sel}장 자동 선택`;
      $('pmAnalyzeRow').style.display = '';
      renderThumbs();
      setLog('pmLog', sel ? '' : '도면 페이지를 자동으로 찾지 못했습니다. 미리보기에서 도면 페이지를 직접 골라 주세요.');
    } catch (e) {
      setLog('pmLog', 'PDF를 읽지 못했습니다: ' + e.message, true);
    }
  }

  async function analyze() {
    if (state.busy || !state.pdf) return;
    const sel = state.pdf.pages.filter((p) => p.sel);
    state.busy = true; $('pmAnalyze').disabled = true;
    try {
      setLog('pmLog', `도면 ${sel.length}장을 이미지로 변환하는 중…`);
      const content = [{ type: 'text', text: '[특허 본문 발췌]\n' + pickText(state.pdf.pages, 14000) }];
      for (const p of sel) {
        content.push({ type: 'text', text: `[도면 이미지: PDF ${p.no}쪽]` });
        content.push({ type: 'image_url', image_url: { url: await pageImage(state.pdf.doc, p.no) } });
      }
      content.push({ type: 'text', text: '위 자료를 바탕으로 동작 사양 JSON 하나만 출력하라.' });
      setLog('pmLog', 'EXAONE이 도면과 본문을 해석하는 중… (최대 몇 분 걸릴 수 있습니다)');
      const t0 = Date.now();
      const raw = await chatJson([{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content }], { thinking: $('pmThink').checked, maxTokens: $('pmThink').checked ? 8000 : 4000 }, (m) => setLog('pmLog', m));
      applySpec(raw);
      setLog('pmLog', `해석 완료 (${Math.round((Date.now() - t0) / 1000)}초). 아래 동작과 '근거/추정'을 확인하고, 다르면 4번에서 수정 요청하세요.`);
    } catch (e) {
      setLog('pmLog', e.message, true);
      if (e.code === 'no_config' && typeof window.openAiSettingsModal === 'function') {
        $('pmLog').insertAdjacentHTML('beforeend', ' <button class="btn btn-secondary" id="pmOpenSet" style="padding:4px 10px;font-size:12px">AI 설정 열기</button>');
        $('pmOpenSet').onclick = () => window.openAiSettingsModal();
      }
    } finally { state.busy = false; $('pmAnalyze').disabled = false; }
  }

  async function fixWithAi() {
    const req = $('pmFix').value.trim();
    if (!req) { setLog('pmFixLog', '수정할 내용을 입력하세요.', true); return; }
    if (!state.spec) { setLog('pmFixLog', '먼저 PDF를 분석하거나 샘플을 불러오세요.', true); return; }
    if (state.busy) return;
    state.busy = true; $('pmFixBtn').disabled = true;
    setLog('pmFixLog', 'EXAONE이 사양을 수정하는 중…');
    try {
      const raw = await chatJson([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `[현재 사양]\n${JSON.stringify(state.spec)}\n\n[수정 요청]\n${req}\n\n요청을 반영한 전체 사양 JSON 하나만 출력하라. 요청과 관계없는 부분은 그대로 둔다. 바뀐 내용은 assumptions 맨 앞에 "사용자 요청: ..." 형태로 남긴다.` },
      ], { thinking: false, maxTokens: 4000 }, (m) => setLog('pmFixLog', m));
      applySpec(raw, { keepTime: true });
      setLog('pmFixLog', '수정을 반영했습니다.');
    } catch (e) {
      setLog('pmFixLog', e.message, true);
    } finally { state.busy = false; $('pmFixBtn').disabled = false; }
  }

  function bind() {
    const sampleSel = $('pmSample');
    Object.keys(SAMPLES).forEach((k) => { const o = document.createElement('option'); o.value = k; o.textContent = SAMPLE_NAMES[k]; sampleSel.appendChild(o); });
    sampleSel.addEventListener('change', () => { if (sampleSel.value) applySpec(JSON.parse(JSON.stringify(SAMPLES[sampleSel.value]))); sampleSel.value = ''; });
    $('pmSaveJson').addEventListener('click', () => {
      if (!state.spec) return;
      const blob = new Blob([JSON.stringify(state.spec, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = (state.spec.source || state.spec.title || 'spec').replace(/[^\w가-힣.-]+/g, '_').slice(0, 60) + '_motion.json';
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    $('pmLoadJsonBtn').addEventListener('click', () => $('pmLoadJson').click());
    $('pmLoadJson').addEventListener('change', async (e) => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      try { applySpec(JSON.parse(await f.text())); } catch (err) { setLog('pmJsonLog', 'JSON을 읽지 못했습니다: ' + err.message, true); }
    });
    const drop = $('pmDrop');
    drop.addEventListener('click', () => $('pmFile').click());
    $('pmFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; onFile(f); });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); onFile(e.dataTransfer.files[0]); });
    $('pmAnalyze').addEventListener('click', analyze);
    $('pmFixBtn').addEventListener('click', fixWithAi);
    $('pmJsonApply').addEventListener('click', () => {
      try { applySpec(JSON.parse($('pmJson').value), { keepTime: true }); setLog('pmJsonLog', '적용했습니다.'); } catch (e) { setLog('pmJsonLog', 'JSON 문법 오류: ' + e.message, true); }
    });
    $('pmPlay').addEventListener('click', () => { state.run = !state.run; $('pmPlay').innerHTML = state.run ? '<i class="fas fa-pause"></i> 일시정지' : '<i class="fas fa-play"></i> 재생'; });
    $('pmReset').addEventListener('click', () => { state.t = 0; });
    $('pmCam').addEventListener('click', () => state.scene && state.scene.resetCamera());
    $('pmSpeed').addEventListener('input', (e) => { state.speed = +e.target.value; $('pmSpeedOut').textContent = state.speed + 'x'; });
  }

  function init() {
    if (state.inited) return;
    const tab = $('tab-patentmotion');
    if (!tab) return;
    state.inited = true;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    tab.innerHTML = HTML;
    bind();
    let start = null;
    try { start = JSON.parse(localStorage.getItem('pm_last_spec') || 'null'); } catch (e) { start = null; }
    applySpec(start || JSON.parse(JSON.stringify(SAMPLES.toptec_mod)));
    state.raf = requestAnimationFrame(frame);
    init3D();
  }

  function hook() {
    const btn = document.querySelector('.tab-btn[data-tab="patentmotion"]');
    if (btn) btn.addEventListener('click', () => { init(); setTimeout(() => state.scene && state.scene.resize(), 50); });
    const tab = $('tab-patentmotion');
    if (tab && tab.classList.contains('active')) init();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hook); else hook();

  const PM = {};
  PM.normalizeSpec = normalizeSpec;
  PM.buildLayout = buildLayout;
  PM.extractJson = extractJson;
  PM.SAMPLES = SAMPLES;
  PM._state = state;
  PM.applySpec = (s) => applySpec(s);
  PM.init = init;
  window.PatentMotion = PM;
})();
