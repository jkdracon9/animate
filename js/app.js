import * as store from './store.js';
import { encodeMP4, recordVideo, webCodecsAvailable, recorderAvailable } from './mp4.js';
import { encodeGIF } from './gif.js';
import { ZipWriter } from './zip.js';

// =====================================================================
// 공통 도우미
// =====================================================================
const $ = (s) => document.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w); c.height = Math.max(1, h);
  return c;
}
const canvasToBlob = (c, type = 'image/png', q) => new Promise((res, rej) =>
  c.toBlob((b) => (b ? res(b) : rej(new Error('이미지 변환 실패'))), type, q));

let toastTimer = 0;
function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function openDialog(dlg) {
  return new Promise((resolve) => {
    dlg.returnValue = '';
    const onClose = () => { dlg.removeEventListener('close', onClose); resolve(dlg.returnValue); };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}
async function confirmDlg(text, okLabel = '확인') {
  $('#confirmText').textContent = text;
  $('#confirmOk').textContent = okLabel;
  return (await openDialog($('#dlgConfirm'))) === 'ok';
}
async function promptDlg(text, value) {
  $('#promptText').textContent = text;
  const inp = $('#promptInput');
  inp.value = value || '';
  setTimeout(() => inp.select(), 50);
  const r = await openDialog($('#dlgPrompt'));
  return r === 'ok' ? inp.value.trim() : null;
}

// =====================================================================
// 설정값(도구 등) — 기기별로 localStorage 에 기억
// =====================================================================
const DEFAULT_PREFS = {
  tool: 'brush', color: '#1f1f1f', brushType: 'pen', shapeType: 'line', shapeFill: false,
  size: { brush: 8, eraser: 40, shape: 6 }, opacity: { brush: 100, eraser: 100, shape: 100 },
  smooth: 25, fillTol: 40, fillAll: true,
  penOnly: false, onion: true, onionPrev: 1, onionNext: 1, onionAlpha: 30, onionTint: true,
  grid: false, gridSize: '100', recent: [], layersOpen: true,
};
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('animate.prefs') || '{}');
    return { ...DEFAULT_PREFS, ...p, size: { ...DEFAULT_PREFS.size, ...(p.size || {}) }, opacity: { ...DEFAULT_PREFS.opacity, ...(p.opacity || {}) } };
  } catch { return { ...DEFAULT_PREFS }; }
}
const prefs = loadPrefs();
function savePrefs() { try { localStorage.setItem('animate.prefs', JSON.stringify(prefs)); } catch { /* 저장 불가 무시 */ } }

const SIZE_PRESETS = [
  ['가로 HD', 1280, 720], ['가로 FHD', 1920, 1080], ['세로 쇼츠 HD', 720, 1280], ['세로 쇼츠 FHD', 1080, 1920],
  ['정사각', 1080, 1080], ['4:3', 1440, 1080], ['탭 화면', 2000, 1200],
];
const FPS_PRESETS = [4, 6, 8, 10, 12, 15, 24, 30, 48, 60];
const PALETTE = ['#000000', '#3b3b3b', '#7a7a7a', '#b8b8b8', '#ffffff', '#7a1f1f', '#d62828', '#ff6b6b', '#ffb4a2', '#f77f00',
  '#fcbf49', '#ffe66d', '#8ac926', '#2a9d8f', '#0b6e4f', '#4cc9f0', '#1982c4', '#3a0ca3', '#6a4c93', '#c77dff',
  '#ff70a6', '#8d5524', '#c68642', '#f1c27d', '#ffdbac', '#264653', '#e9c46a', '#e76f51', '#a8dadc', '#1d3557'];

// =====================================================================
// 상태
// =====================================================================
let project = null;      // {id,name,width,height,fps,bg,layers,frames,...}
let cur = 0;             // 현재 프레임 인덱스
let layerId = null;      // 현재 레이어 id
let W = 0, H = 0;
let saved = new Map();   // 저장된 셀 key -> 셀 객체 (변경 감지용)

// 작업용 캔버스
let work, workCtx, backup, backupCtx, strokeBuf, sctx, below, belowCtx, above, aboveCtx, onion, onionCtx, tmp, tmpCtx;
let active = null;       // {fid, lid} — work 캔버스에 올라와 있는 셀
let workDirty = false;
let workBounds = null;   // [x0,y0,x1,y1] 그림이 있을 수 있는 영역

const view = $('#view');
const vctx = view.getContext('2d');
const V = { zoom: 1, x: 0, y: 0 };

const frames = () => project.frames;
const layers = () => project.layers;
const activeLayer = () => project.layers.find((L) => L.id === layerId);
const frameById = (id) => project.frames.find((f) => f.id === id);
const layerById = (id) => project.layers.find((L) => L.id === id);

function setupBuffers() {
  W = project.width; H = project.height;
  const mk = () => { const c = makeCanvas(W, H); return [c, c.getContext('2d')]; };
  [work, workCtx] = mk(); [backup, backupCtx] = mk(); [strokeBuf, sctx] = mk();
  [below, belowCtx] = mk(); [above, aboveCtx] = mk(); [onion, onionCtx] = mk();
  tmp = makeCanvas(W, H); tmpCtx = tmp.getContext('2d', { willReadFrequently: true });
  thumbs.clear();
  active = null;
}

// =====================================================================
// 셀(프레임 × 레이어) 처리
// =====================================================================
function drawCels(ctx, f, list = project.layers) {
  for (const L of list) {
    if (!L.visible) continue;
    ctx.globalAlpha = L.opacity;
    if (active && f.id === active.fid && L.id === active.lid) ctx.drawImage(work, 0, 0);
    else {
      const c = f.cels[L.id];
      if (c) ctx.drawImage(c.canvas, c.x, c.y);
    }
  }
  ctx.globalAlpha = 1;
}

function extendBounds(x0, y0, x1, y1) {
  if (!workBounds) workBounds = [x0, y0, x1, y1];
  else {
    workBounds[0] = Math.min(workBounds[0], x0); workBounds[1] = Math.min(workBounds[1], y0);
    workBounds[2] = Math.max(workBounds[2], x1); workBounds[3] = Math.max(workBounds[3], y1);
  }
}

// work 캔버스에서 실제 그림이 있는 부분만 잘라 새 셀로 만든다.
function trimWork() {
  if (!workBounds) return null;
  const bx = clamp(Math.floor(workBounds[0]), 0, W), by = clamp(Math.floor(workBounds[1]), 0, H);
  const ex = clamp(Math.ceil(workBounds[2]), 0, W), ey = clamp(Math.ceil(workBounds[3]), 0, H);
  const bw = ex - bx, bh = ey - by;
  if (bw <= 0 || bh <= 0) { workBounds = null; return null; }
  const d = workCtx.getImageData(bx, by, bw, bh).data;
  let minX = bw, minY = bh, maxX = -1, maxY = -1;
  for (let y = 0; y < bh; y++) {
    let row = y * bw * 4 + 3;
    for (let x = 0; x < bw; x++, row += 4) {
      if (d[row]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        maxY = y;
      }
    }
  }
  if (maxX < 0) { workBounds = null; return null; }
  const cw = maxX - minX + 1, ch = maxY - minY + 1;
  const c = makeCanvas(cw, ch);
  c.getContext('2d').drawImage(work, bx + minX, by + minY, cw, ch, 0, 0, cw, ch);
  workBounds = [bx + minX, by + minY, bx + minX + cw, by + minY + ch];
  return { canvas: c, x: bx + minX, y: by + minY };
}

function commitActive() {
  if (!active || !workDirty) return;
  workDirty = false;
  const f = frameById(active.fid);
  if (!f || !layerById(active.lid)) return;
  const t = trimWork();
  if (t) f.cels[active.lid] = t; else delete f.cels[active.lid];
}

function loadActive() {
  const f = frames()[cur];
  workCtx.clearRect(0, 0, W, H);
  const c = f.cels[layerId];
  if (c) {
    workCtx.drawImage(c.canvas, c.x, c.y);
    workBounds = [c.x, c.y, c.x + c.canvas.width, c.y + c.canvas.height];
  } else workBounds = null;
  active = { fid: f.id, lid: layerId };
  workDirty = false;
  rebuildCaches();
}

function rebuildCaches() {
  const f = frames()[cur];
  const li = project.layers.findIndex((L) => L.id === layerId);
  belowCtx.clearRect(0, 0, W, H);
  drawCels(belowCtx, f, project.layers.slice(0, li));
  aboveCtx.clearRect(0, 0, W, H);
  drawCels(aboveCtx, f, project.layers.slice(li + 1));
  rebuildOnion();
}

function rebuildOnion() {
  onionCtx.clearRect(0, 0, W, H);
  if (!prefs.onion) return;
  const fs = frames();
  const base = prefs.onionAlpha / 100;
  const draw = (idx, color, alpha) => {
    tmpCtx.clearRect(0, 0, W, H);
    drawCels(tmpCtx, fs[idx]);
    if (prefs.onionTint) {
      tmpCtx.globalCompositeOperation = 'source-in';
      tmpCtx.fillStyle = color;
      tmpCtx.fillRect(0, 0, W, H);
      tmpCtx.globalCompositeOperation = 'source-over';
    }
    onionCtx.globalAlpha = alpha;
    onionCtx.drawImage(tmp, 0, 0);
    onionCtx.globalAlpha = 1;
  };
  for (let k = prefs.onionPrev; k >= 1; k--) if (cur - k >= 0) draw(cur - k, '#ff3b3b', base / k);
  for (let k = prefs.onionNext; k >= 1; k--) if (cur + k < fs.length) draw(cur + k, '#18b45b', base / k);
}

function setActive(fi, lid = layerId) {
  if (stroke) return;
  commitActive();
  cur = clamp(fi, 0, frames().length - 1);
  layerId = lid;
  loadActive();
  markActiveFrame();
  refreshLayers();
  requestRender();
  scheduleSave();
}

// =====================================================================
// 화면 그리기
// =====================================================================
let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(render);
}

let hover = null; // 펜/마우스 커서 위치(문서 좌표)
function render() {
  renderQueued = false;
  if (!project) return;
  const dpr = window.devicePixelRatio || 1;
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.fillStyle = '#3a3f4b';
  vctx.fillRect(0, 0, view.width, view.height);
  const z = V.zoom * dpr;
  vctx.setTransform(z, 0, 0, z, V.x * dpr, V.y * dpr);
  vctx.imageSmoothingEnabled = V.zoom < 2;
  vctx.shadowColor = 'rgba(0,0,0,.35)'; vctx.shadowBlur = 12 / V.zoom;
  vctx.fillStyle = project.bg;
  vctx.fillRect(0, 0, W, H);
  vctx.shadowBlur = 0; vctx.shadowColor = 'transparent';

  if (playing) {
    drawCels(vctx, frames()[playIdx]);
  } else {
    if (prefs.onion) vctx.drawImage(onion, 0, 0);
    vctx.drawImage(below, 0, 0);
    const L = activeLayer();
    if (L && L.visible) {
      vctx.globalAlpha = L.opacity;
      if (stroke && stroke.buffered) {
        // 반투명 획: work 위에 획 버퍼를 합쳐 미리 보여준다
        vctx.drawImage(work, 0, 0);
        vctx.globalAlpha = L.opacity * stroke.alpha;
        vctx.drawImage(strokeBuf, 0, 0);
      } else vctx.drawImage(work, 0, 0);
      vctx.globalAlpha = 1;
    }
    vctx.drawImage(above, 0, 0);
  }

  if (prefs.grid) drawGrid(z);
  vctx.lineWidth = 1 / V.zoom;
  vctx.strokeStyle = 'rgba(0,0,0,.35)';
  vctx.strokeRect(0, 0, W, H);

  if (hover && !stroke && !playing && ['brush', 'eraser', 'shape'].includes(prefs.tool)) {
    const r = Math.max(1, curSize() / 2);
    vctx.lineWidth = 1.5 / V.zoom;
    vctx.strokeStyle = 'rgba(255,255,255,.9)';
    vctx.beginPath(); vctx.arc(hover.x, hover.y, r, 0, Math.PI * 2); vctx.stroke();
    vctx.strokeStyle = 'rgba(0,0,0,.6)';
    vctx.beginPath(); vctx.arc(hover.x, hover.y, r + 1.5 / V.zoom, 0, Math.PI * 2); vctx.stroke();
  }
}

function drawGrid() {
  vctx.lineWidth = 1 / V.zoom;
  vctx.strokeStyle = 'rgba(76,157,255,.45)';
  vctx.beginPath();
  if (prefs.gridSize === 'thirds') {
    for (let i = 1; i < 3; i++) {
      vctx.moveTo((W * i) / 3, 0); vctx.lineTo((W * i) / 3, H);
      vctx.moveTo(0, (H * i) / 3); vctx.lineTo(W, (H * i) / 3);
    }
  } else {
    const g = +prefs.gridSize;
    for (let x = g; x < W; x += g) { vctx.moveTo(x, 0); vctx.lineTo(x, H); }
    for (let y = g; y < H; y += g) { vctx.moveTo(0, y); vctx.lineTo(W, y); }
  }
  vctx.stroke();
  vctx.strokeStyle = 'rgba(255,122,69,.6)';
  vctx.beginPath();
  vctx.moveTo(W / 2, 0); vctx.lineTo(W / 2, H); vctx.moveTo(0, H / 2); vctx.lineTo(W, H / 2);
  vctx.stroke();
}

function resizeView() {
  const r = view.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  view.width = Math.round(r.width * dpr);
  view.height = Math.round(r.height * dpr);
  requestRender();
}

function fitView() {
  const r = view.getBoundingClientRect();
  if (!r.width || !project) return;
  V.zoom = Math.min((r.width - 32) / W, (r.height - 32) / H);
  V.x = (r.width - W * V.zoom) / 2;
  V.y = (r.height - H * V.zoom) / 2;
  showHud();
  requestRender();
}

let hudTimer = 0;
function showHud() {
  const h = $('#hud');
  h.textContent = `${Math.round(V.zoom * 100)}%`;
  h.hidden = false;
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => { h.hidden = true; }, 1200);
}

function toDoc(e) {
  const r = view.getBoundingClientRect();
  return { x: (e.clientX - r.left - V.x) / V.zoom, y: (e.clientY - r.top - V.y) / V.zoom };
}

// =====================================================================
// 브러시 재료(연필 질감, 에어브러시 도장)
// =====================================================================
let pencilPattern = null, airStamp = null;
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rebuildBrushMaterials() {
  const [r, g, b] = hexToRgb(prefs.color);
  const pc = makeCanvas(48, 48);
  const px = pc.getContext('2d');
  const img = px.createImageData(48, 48);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random();
    img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b;
    img.data[i + 3] = v > 0.45 ? 150 + Math.random() * 105 : Math.random() * 60;
  }
  px.putImageData(img, 0, 0);
  pencilPattern = sctx ? sctx.createPattern(pc, 'repeat') : null;

  airStamp = makeCanvas(128, 128);
  const ax = airStamp.getContext('2d');
  const gr = ax.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, `rgba(${r},${g},${b},1)`);
  gr.addColorStop(0.5, `rgba(${r},${g},${b},.45)`);
  gr.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ax.fillStyle = gr;
  ax.fillRect(0, 0, 128, 128);
}

const toolKey = () => (prefs.tool === 'eraser' ? 'eraser' : prefs.tool === 'shape' ? 'shape' : 'brush');
const curSize = () => prefs.size[toolKey()];
const curOpacity = () => prefs.opacity[toolKey()] / 100;

// =====================================================================
// 그리기 입력
// =====================================================================
let stroke = null;
let penSeen = false;

function pressureOf(e) {
  if (e.pointerType !== 'pen') return 1;
  return e.pressure > 0 ? e.pressure : 0.5;
}

function seg(ctx, a, b, w) {
  ctx.lineWidth = w;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01) {
    ctx.beginPath(); ctx.arc(a.x, a.y, w / 2, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle; ctx.fill();
  } else {
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
}

function growStroke(x, y, pad) {
  const b = stroke.bbox;
  b[0] = Math.min(b[0], x - pad); b[1] = Math.min(b[1], y - pad);
  b[2] = Math.max(b[2], x + pad); b[3] = Math.max(b[3], y + pad);
}

function dab(a, b, pa, pb) {
  const size = curSize();
  const p = (pa + pb) / 2;
  if (stroke.tool === 'eraser') {
    const w = stroke.type === 'pen' ? size * (0.35 + 0.65 * p) : size;
    workCtx.save();
    workCtx.globalCompositeOperation = 'destination-out';
    workCtx.globalAlpha = stroke.alpha;
    workCtx.strokeStyle = '#000';
    seg(workCtx, a, b, w);
    workCtx.restore();
    growStroke(a.x, a.y, w); growStroke(b.x, b.y, w);
    return;
  }
  const bt = prefs.brushType;
  if (bt === 'airbrush') {
    const r = size * (0.5 + 0.5 * p);
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const step = Math.max(1, r * 0.2);
    stroke.carry = (stroke.carry || 0) + dist;
    sctx.globalAlpha = 0.06 + 0.12 * p;
    if (dist === 0) sctx.drawImage(airStamp, a.x - r, a.y - r, r * 2, r * 2);
    while (stroke.carry >= step) {
      stroke.carry -= step;
      const t = dist ? 1 - stroke.carry / dist : 1;
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
      sctx.drawImage(airStamp, x - r, y - r, r * 2, r * 2);
    }
    sctx.globalAlpha = 1;
    growStroke(a.x, a.y, r); growStroke(b.x, b.y, r);
    return;
  }
  let w = size;
  if (bt === 'pen') w = size * (0.12 + 0.88 * p);
  if (bt === 'pencil') w = Math.max(1, size * (0.4 + 0.6 * p));
  sctx.strokeStyle = bt === 'pencil' && pencilPattern ? pencilPattern : prefs.color;
  sctx.globalAlpha = bt === 'pencil' ? 0.35 + 0.65 * p : 1;
  seg(sctx, a, b, w);
  sctx.globalAlpha = 1;
  growStroke(a.x, a.y, w); growStroke(b.x, b.y, w);
}

function drawShape() {
  const s = stroke.start, e = stroke.last;
  sctx.clearRect(0, 0, W, H);
  const w = curSize();
  sctx.strokeStyle = prefs.color; sctx.fillStyle = prefs.color;
  sctx.lineWidth = w; sctx.lineCap = 'round'; sctx.lineJoin = 'round';
  sctx.beginPath();
  const type = prefs.shapeType;
  if (type === 'line') { sctx.moveTo(s.x, s.y); sctx.lineTo(e.x, e.y); }
  else if (type === 'rect') sctx.rect(Math.min(s.x, e.x), Math.min(s.y, e.y), Math.abs(e.x - s.x), Math.abs(e.y - s.y));
  else sctx.ellipse((s.x + e.x) / 2, (s.y + e.y) / 2, Math.abs(e.x - s.x) / 2, Math.abs(e.y - s.y) / 2, 0, 0, Math.PI * 2);
  if (prefs.shapeFill && type !== 'line') sctx.fill(); else sctx.stroke();
  stroke.bbox = [Math.min(s.x, e.x) - w, Math.min(s.y, e.y) - w, Math.max(s.x, e.x) + w, Math.max(s.y, e.y) + w];
}

function startStroke(e) {
  const L = activeLayer();
  if (!L.visible) { toast('숨긴 레이어예요. 눈 아이콘을 켜 주세요.'); return; }
  if (L.locked) { toast('잠긴 레이어예요. 자물쇠를 풀어 주세요.'); return; }
  const p = toDoc(e);
  let tool = prefs.tool;
  if (tool === 'fill') { doFill(p); return; }
  if (tool === 'picker') { pickColor(p); return; }
  // S펜 버튼을 누른 채 그리면 지우개
  if (e.pointerType === 'pen' && (e.buttons & 32 || e.buttons & 2) && tool === 'brush') tool = 'eraser';
  backupCtx.clearRect(0, 0, W, H);
  backupCtx.drawImage(work, 0, 0);
  const key = tool === 'eraser' ? 'eraser' : tool === 'shape' ? 'shape' : 'brush';
  stroke = {
    id: e.pointerId, type: e.pointerType, tool, start: p, last: p, raw: p, sm: { ...p },
    pr: pressureOf(e), bbox: [p.x, p.y, p.x, p.y], buffered: tool !== 'eraser',
    alpha: prefs.opacity[key] / 100, carry: 0,
  };
  if (stroke.buffered) sctx.clearRect(0, 0, W, H);
  if (tool !== 'shape') dab(p, p, stroke.pr, stroke.pr);
  closeToolPanel();
  requestRender();
}

function moveStroke(e) {
  const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const ev of list.length ? list : [e]) {
    const p = toDoc(ev);
    if (stroke.tool === 'shape') { stroke.last = p; continue; }
    const k = 1 - (prefs.smooth / 100) * 0.93;
    const sm = { x: stroke.sm.x + (p.x - stroke.sm.x) * k, y: stroke.sm.y + (p.y - stroke.sm.y) * k };
    const npr = stroke.pr + (pressureOf(ev) - stroke.pr) * 0.6;
    dab(stroke.sm, sm, stroke.pr, npr);
    stroke.sm = sm; stroke.pr = npr; stroke.raw = p;
  }
  if (stroke.tool === 'shape') drawShape();
  requestRender();
}

function endStroke() {
  const s = stroke;
  if (s.tool === 'shape') drawShape();
  else if (prefs.smooth > 0 && s.raw) dab(s.sm, s.raw, s.pr, s.pr * 0.6);
  const bx = clamp(Math.floor(s.bbox[0]) - 2, 0, W), by = clamp(Math.floor(s.bbox[1]) - 2, 0, H);
  const ex = clamp(Math.ceil(s.bbox[2]) + 2, 0, W), ey = clamp(Math.ceil(s.bbox[3]) + 2, 0, H);
  const bw = ex - bx, bh = ey - by;
  if (s.buffered && bw > 0 && bh > 0) {
    workCtx.globalAlpha = s.alpha;
    workCtx.drawImage(strokeBuf, bx, by, bw, bh, bx, by, bw, bh);
    workCtx.globalAlpha = 1;
  }
  stroke = null;
  if (bw > 0 && bh > 0) {
    pushPixelUndo(bx, by, bw, bh, backupCtx.getImageData(bx, by, bw, bh), workCtx.getImageData(bx, by, bw, bh));
    extendBounds(bx, by, ex, ey);
    workDirty = true;
    afterEdit();
  }
  requestRender();
}

function cancelStroke() {
  if (!stroke) return;
  workCtx.clearRect(0, 0, W, H);
  workCtx.drawImage(backup, 0, 0);
  stroke = null;
  requestRender();
}

// ---------- 채우기 ----------
function doFill(p) {
  const sx = Math.floor(p.x), sy = Math.floor(p.y);
  if (sx < 0 || sy < 0 || sx >= W || sy >= H) return;
  tmpCtx.clearRect(0, 0, W, H);
  if (prefs.fillAll) drawCels(tmpCtx, frames()[cur]);
  else tmpCtx.drawImage(work, 0, 0);
  const src = tmpCtx.getImageData(0, 0, W, H).data;
  const i0 = (sy * W + sx) * 4;
  const r0 = src[i0], g0 = src[i0 + 1], b0 = src[i0 + 2], a0 = src[i0 + 3];
  const tol = prefs.fillTol;
  const match = (j) => {
    const i = j * 4;
    return Math.abs(src[i] - r0) <= tol && Math.abs(src[i + 1] - g0) <= tol &&
      Math.abs(src[i + 2] - b0) <= tol && Math.abs(src[i + 3] - a0) <= tol;
  };
  const mask = new Uint8Array(W * H);
  const stack = [sy * W + sx];
  let minX = sx, maxX = sx, minY = sy, maxY = sy;
  while (stack.length) {
    const idx = stack.pop();
    if (mask[idx]) continue;
    const y = (idx / W) | 0;
    const row = y * W;
    let l = idx - row, r = l;
    while (l > 0 && !mask[row + l - 1] && match(row + l - 1)) l--;
    while (r < W - 1 && !mask[row + r + 1] && match(row + r + 1)) r++;
    for (let x = l; x <= r; x++) mask[row + x] = 1;
    if (l < minX) minX = l;
    if (r > maxX) maxX = r;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= H) continue;
      let inSpan = false;
      const nrow = ny * W;
      for (let x = l; x <= r; x++) {
        const j = nrow + x;
        if (!mask[j] && match(j)) { if (!inSpan) { stack.push(j); inSpan = true; } } else inSpan = false;
      }
    }
  }
  // 선 가장자리 틈을 메우기 위해 1픽셀 넓힌다
  const bx = Math.max(0, minX - 1), by = Math.max(0, minY - 1);
  const ex = Math.min(W, maxX + 2), ey = Math.min(H, maxY + 2);
  const bw = ex - bx, bh = ey - by;
  const before = workCtx.getImageData(bx, by, bw, bh);
  const after = new ImageData(new Uint8ClampedArray(before.data), bw, bh);
  const d = after.data;
  const [fr, fg, fb] = hexToRgb(prefs.color);
  const fa = curOpacity();
  for (let y = by; y < ey; y++) {
    for (let x = bx; x < ex; x++) {
      const j = y * W + x;
      const core = mask[j] === 1;
      const ring = !core && ((x > 0 && mask[j - 1]) || (x < W - 1 && mask[j + 1]) || (y > 0 && mask[j - W]) || (y < H - 1 && mask[j + W]));
      if (!core && !ring) continue;
      const o = ((y - by) * bw + (x - bx)) * 4;
      if (core && fa >= 1) {
        d[o] = fr; d[o + 1] = fg; d[o + 2] = fb; d[o + 3] = 255;
      } else {
        // 기존 픽셀 아래로 채우기 (선을 덮지 않음)
        const ea = d[o + 3] / 255;
        const na = fa * (1 - ea);
        const oa = ea + na;
        if (oa <= 0) continue;
        d[o] = (d[o] * ea + fr * na) / oa;
        d[o + 1] = (d[o + 1] * ea + fg * na) / oa;
        d[o + 2] = (d[o + 2] * ea + fb * na) / oa;
        d[o + 3] = oa * 255;
      }
    }
  }
  workCtx.putImageData(after, bx, by);
  pushPixelUndo(bx, by, bw, bh, before, after);
  extendBounds(bx, by, ex, ey);
  workDirty = true;
  afterEdit();
  requestRender();
}

// ---------- 스포이트 ----------
let pickCanvas = null;
function pickColor(p) {
  if (!pickCanvas) pickCanvas = makeCanvas(1, 1);
  const c = pickCanvas.getContext('2d', { willReadFrequently: true });
  c.setTransform(1, 0, 0, 1, -Math.floor(p.x), -Math.floor(p.y));
  c.fillStyle = project.bg;
  c.fillRect(0, 0, W, H);
  drawCels(c, frames()[cur]);
  const d = c.getImageData(0, 0, 1, 1).data;
  setColor('#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join(''), true);
  setTool('brush');
  toast('색을 가져왔어요');
}

// ---------- 입력 이벤트 ----------
const touches = new Map();
let gest = null;
let mousePan = null;

function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}
function spread(pts, c) {
  let s = 0;
  for (const p of pts) s += Math.hypot(p.x - c.x, p.y - c.y);
  return s / pts.length || 1;
}
function localPt(e) {
  const r = view.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function gestureBaseline() {
  const pts = [...touches.values()];
  if (!pts.length) return;
  const c = centroid(pts);
  gest = {
    c0: c, s0: spread(pts, c), z0: V.zoom, x0: V.x, y0: V.y, n: pts.length,
    maxN: Math.max(gest ? gest.maxN : 0, pts.length),
    t0: gest ? gest.t0 : performance.now(), moved: gest ? gest.moved : 0,
  };
}
function gestureMove() {
  const pts = [...touches.values()];
  if (!gest || !pts.length) return;
  const c = centroid(pts);
  let z = gest.z0;
  if (pts.length >= 2) z = clamp(gest.z0 * (spread(pts, c) / gest.s0), 0.05, 32);
  const dx = (gest.c0.x - gest.x0) / gest.z0, dy = (gest.c0.y - gest.y0) / gest.z0;
  V.zoom = z;
  V.x = c.x - dx * z;
  V.y = c.y - dy * z;
  gest.moved = Math.max(gest.moved, Math.hypot(c.x - gest.c0.x, c.y - gest.c0.y) + Math.abs(spread(pts, c) - gest.s0));
  showHud();
  requestRender();
}

view.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!project) return;
  if (e.pointerType === 'touch') touches.set(e.pointerId, localPt(e));
  try { view.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
  closeToolPanel();
  if (e.pointerType === 'pen' && !penSeen) {
    penSeen = true;
    if (!prefs.penOnly) {
      prefs.penOnly = true; savePrefs(); updateToggles();
      toast('S펜이 감지되어 펜 전용 모드를 켰어요. 손가락으로는 이동·확대만 돼요.', 3500);
    }
  }
  if (playing) { stopPlay(); return; }
  if (e.pointerType === 'touch') {
    if (prefs.penOnly || touches.size > 1) {
      if (stroke && stroke.type === 'touch') cancelStroke();
      if (!stroke) gestureBaseline();
      return;
    }
  }
  if (e.pointerType === 'mouse' && e.button !== 0) {
    mousePan = { x: e.clientX, y: e.clientY, vx: V.x, vy: V.y };
    return;
  }
  if (stroke || gest) return;
  startStroke(e);
});

view.addEventListener('pointermove', (e) => {
  if (!project) return;
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) {
    touches.set(e.pointerId, localPt(e));
    if (gest) { gestureMove(); return; }
  }
  if (stroke && e.pointerId === stroke.id) { moveStroke(e); return; }
  if (mousePan) {
    V.x = mousePan.vx + e.clientX - mousePan.x;
    V.y = mousePan.vy + e.clientY - mousePan.y;
    requestRender();
    return;
  }
  if (e.pointerType !== 'touch') { hover = toDoc(e); requestRender(); }
});

function pointerEnd(e) {
  if (e.pointerType === 'touch') {
    touches.delete(e.pointerId);
    if (gest) {
      if (touches.size === 0) {
        const g = gest;
        gest = null;
        if (performance.now() - g.t0 < 320 && g.moved < 14) {
          if (g.maxN === 2) undo();
          else if (g.maxN >= 3) redo();
        }
      } else gestureBaseline();
    }
  }
  if (stroke && e.pointerId === stroke.id) endStroke();
  if (mousePan && e.pointerType === 'mouse') mousePan = null;
}
view.addEventListener('pointerup', pointerEnd);
view.addEventListener('pointercancel', pointerEnd);
view.addEventListener('pointerleave', (e) => { if (e.pointerType !== 'touch') { hover = null; requestRender(); } });
view.addEventListener('contextmenu', (e) => e.preventDefault());
view.addEventListener('wheel', (e) => {
  e.preventDefault();
  const p = localPt(e);
  const z = clamp(V.zoom * Math.exp(-e.deltaY * 0.0015), 0.05, 32);
  V.x = p.x - ((p.x - V.x) * z) / V.zoom;
  V.y = p.y - ((p.y - V.y) * z) / V.zoom;
  V.zoom = z;
  showHud();
  requestRender();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (!project || $('#editor').hidden || e.target.closest('input,dialog')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); redo(); }
  else if (k === ' ') { e.preventDefault(); togglePlay(); }
  else if (k === 'b') setTool('brush');
  else if (k === 'e') setTool('eraser');
  else if (k === 'g') setTool('fill');
  else if (k === 'i') setTool('picker');
  else if (k === 'u') setTool('shape');
  else if (k === 'arrowleft') setActive(cur - 1);
  else if (k === 'arrowright') setActive(cur + 1);
});

// =====================================================================
// 실행취소
// =====================================================================
const undoStack = [], redoStack = [];
let undoBytes = 0;
const UNDO_MAX_BYTES = 160e6;

function pushUndo(u) {
  undoStack.push(u);
  undoBytes += u.bytes || 0;
  for (const r of redoStack) undoBytes -= r.bytes || 0;
  redoStack.length = 0;
  while (undoStack.length > 80 || (undoBytes > UNDO_MAX_BYTES && undoStack.length > 1)) {
    const old = undoStack.shift();
    undoBytes -= old.bytes || 0;
  }
  updateUndoButtons();
}
function pushPixelUndo(x, y, w, h, before, after) {
  pushUndo({ t: 'px', fid: active.fid, lid: active.lid, x, y, w, h, before, after, bytes: w * h * 8 });
}
function snapshot() {
  return {
    layers: project.layers.map((L) => ({ ...L })),
    frames: project.frames.map((f) => ({ id: f.id, hold: f.hold, cels: { ...f.cels } })),
    cur, layerId,
  };
}
function restoreSnapshot(s) {
  project.layers = s.layers.map((L) => ({ ...L }));
  project.frames = s.frames.map((f) => ({ id: f.id, hold: f.hold, cels: { ...f.cels } }));
  cur = clamp(s.cur, 0, project.frames.length - 1);
  layerId = layerById(s.layerId) ? s.layerId : project.layers[0].id;
  active = null;
  loadActive();
}
function applyPixel(u, which) {
  const fi = project.frames.findIndex((f) => f.id === u.fid);
  if (fi < 0 || !layerById(u.lid)) return false;
  if (!active || active.fid !== u.fid || active.lid !== u.lid) {
    commitActive();
    cur = fi; layerId = u.lid;
    loadActive();
  }
  workCtx.putImageData(u[which], u.x, u.y);
  extendBounds(u.x, u.y, u.x + u.w, u.y + u.h);
  workDirty = true;
  return true;
}
function undo() {
  if (stroke || playing) return;
  const u = undoStack.pop();
  if (!u) { toast('더 이상 되돌릴 수 없어요'); return; }
  if (u.t === 'px') applyPixel(u, 'before');
  else { commitActive(); restoreSnapshot(u.before); }
  redoStack.push(u);
  afterHistory(u);
  toast('실행취소', 700);
}
function redo() {
  if (stroke || playing) return;
  const u = redoStack.pop();
  if (!u) { toast('다시 실행할 내용이 없어요'); return; }
  if (u.t === 'px') applyPixel(u, 'after');
  else { commitActive(); restoreSnapshot(u.after); }
  undoStack.push(u);
  afterHistory(u);
  toast('다시실행', 700);
}
function afterHistory(u) {
  if (u.t === 'st') { thumbs.clear(); rebuildTimeline(); }
  else { markActiveFrame(); queueThumb(); }
  refreshLayers();
  updateUndoButtons();
  updateInfo();
  scheduleSave();
  requestRender();
}
function clearHistory() {
  undoStack.length = 0; redoStack.length = 0; undoBytes = 0;
  updateUndoButtons();
}
function updateUndoButtons() {
  $('#btnUndo').disabled = !undoStack.length;
  $('#btnRedo').disabled = !redoStack.length;
  $('#btnUndo').style.opacity = undoStack.length ? 1 : 0.4;
  $('#btnRedo').style.opacity = redoStack.length ? 1 : 0.4;
}

// 구조 변경(프레임·레이어 추가/삭제/이동 등)을 실행취소 가능하게 감싼다
function structOp(fn, { thumbsStale = false } = {}) {
  if (stroke || playing) return;
  commitActive();
  const before = snapshot();
  const ok = fn();
  if (ok === false) return;
  const after = snapshot();
  pushUndo({ t: 'st', before, after, bytes: 0 });
  active = null;
  loadActive();
  if (thumbsStale) thumbs.clear();
  rebuildTimeline();
  refreshLayers();
  updateInfo();
  scheduleSave();
  requestRender();
}

function afterEdit() {
  queueThumb();
  refreshLayerThumb();
  updateInfo();
  scheduleSave();
}

// =====================================================================
// 타임라인(프레임)
// =====================================================================
const thumbs = new Map(); // fid -> canvas
const framesEl = $('#frames');

function thumbSize() {
  const th = 124;
  return [Math.round(clamp((th * W) / H, 40, 260)), th];
}
function drawThumb(f, c) {
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = project.bg;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.setTransform(c.width / W, 0, 0, c.height / H, 0, 0);
  drawCels(ctx, f);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
function thumbFor(f) {
  let c = thumbs.get(f.id);
  if (!c) {
    const [tw, th] = thumbSize();
    c = makeCanvas(tw, th);
    thumbs.set(f.id, c);
    drawThumb(f, c);
  }
  return c;
}
let thumbTimer = 0;
function queueThumb() {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    const f = frames()[cur];
    if (f) drawThumb(f, thumbFor(f));
  }, 250);
}

function rebuildTimeline() {
  framesEl.textContent = '';
  frames().forEach((f, i) => {
    const d = document.createElement('div');
    d.className = 'frame';
    d.dataset.i = i;
    d.append(thumbFor(f));
    const n = document.createElement('span');
    n.className = 'num'; n.textContent = i + 1;
    d.append(n);
    if (f.hold > 1) {
      const h = document.createElement('span');
      h.className = 'hold-badge'; h.textContent = '×' + f.hold;
      d.append(h);
    }
    d.addEventListener('click', () => { if (playing) stopPlay(); setActive(i); });
    framesEl.append(d);
  });
  const add = document.createElement('button');
  add.className = 'frame-add'; add.textContent = '＋'; add.title = '맨 뒤에 새 프레임';
  add.addEventListener('click', () => structOp(() => { project.frames.push(newFrame()); cur = project.frames.length - 1; }));
  framesEl.append(add);
  markActiveFrame();
}

function markActiveFrame() {
  [...framesEl.children].forEach((el, i) => el.classList.toggle('active', i === cur));
  const el = framesEl.children[cur];
  if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const f = frames()[cur];
  $('#frPos').textContent = `${cur + 1} / ${frames().length}`;
  $('#holdVal').textContent = '×' + f.hold;
}

const newFrame = (hold = 1) => ({ id: uid(), hold, cels: {} });
let clipFrame = null;

$('#frAdd').onclick = () => structOp(() => { project.frames.splice(cur + 1, 0, newFrame()); cur++; });
$('#frDup').onclick = () => structOp(() => {
  const f = frames()[cur];
  project.frames.splice(cur + 1, 0, { id: uid(), hold: f.hold, cels: { ...f.cels } });
  cur++;
});
$('#frDel').onclick = () => structOp(() => {
  if (frames().length === 1) { frames()[0].cels = {}; toast('마지막 프레임은 내용만 지웠어요'); return; }
  project.frames.splice(cur, 1);
  cur = Math.min(cur, frames().length - 1);
}, { thumbsStale: frames().length === 1 });
$('#frCopy').onclick = () => {
  commitActive();
  const f = frames()[cur];
  clipFrame = { hold: f.hold, cels: { ...f.cels } };
  toast('프레임을 복사했어요');
};
$('#frPaste').onclick = () => {
  if (!clipFrame) { toast('먼저 프레임을 복사하세요'); return; }
  structOp(() => {
    const cels = {};
    for (const [lid, c] of Object.entries(clipFrame.cels)) if (layerById(lid)) cels[lid] = c;
    project.frames.splice(cur + 1, 0, { id: uid(), hold: clipFrame.hold, cels });
    cur++;
  });
};
$('#frLeft').onclick = () => structOp(() => {
  if (cur === 0) return false;
  const f = project.frames;
  [f[cur - 1], f[cur]] = [f[cur], f[cur - 1]];
  cur--;
});
$('#frRight').onclick = () => structOp(() => {
  const f = project.frames;
  if (cur >= f.length - 1) return false;
  [f[cur + 1], f[cur]] = [f[cur], f[cur + 1]];
  cur++;
});
$('#holdMinus').onclick = () => structOp(() => { const f = frames()[cur]; if (f.hold <= 1) return false; f.hold--; });
$('#holdPlus').onclick = () => structOp(() => { const f = frames()[cur]; if (f.hold >= 99) return false; f.hold++; });

// =====================================================================
// 레이어
// =====================================================================
const layerListEl = $('#layerList');
const MAX_LAYERS = 16;
const newLayer = (name) => ({ id: uid(), name, visible: true, opacity: 1, locked: false });

function layerThumbDraw(L, c) {
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  const s = Math.min(c.width / W, c.height / H);
  ctx.setTransform(s, 0, 0, s, (c.width - W * s) / 2, (c.height - H * s) / 2);
  const f = frames()[cur];
  if (active && active.lid === L.id && active.fid === f.id) ctx.drawImage(work, 0, 0);
  else { const cel = f.cels[L.id]; if (cel) ctx.drawImage(cel.canvas, cel.x, cel.y); }
}

function refreshLayers() {
  if (!project) return;
  layerListEl.textContent = '';
  for (let i = project.layers.length - 1; i >= 0; i--) {
    const L = project.layers[i];
    const row = document.createElement('div');
    row.className = 'layer' + (L.id === layerId ? ' active' : '');
    const eye = document.createElement('button');
    eye.textContent = '👁'; eye.title = '보이기/숨기기';
    if (!L.visible) eye.classList.add('off');
    eye.onclick = (ev) => {
      ev.stopPropagation();
      L.visible = !L.visible;
      layerVisualChanged();
    };
    const thumb = makeCanvas(108, 72);
    thumb.dataset.lid = L.id;
    layerThumbDraw(L, thumb);
    const name = document.createElement('span');
    name.className = 'lname'; name.textContent = L.name;
    const lock = document.createElement('button');
    lock.textContent = L.locked ? '🔒' : '🔓'; lock.title = '잠금';
    if (!L.locked) lock.classList.add('off');
    lock.onclick = (ev) => { ev.stopPropagation(); L.locked = !L.locked; refreshLayers(); scheduleSave(); };
    row.append(eye, thumb, name, lock);
    row.onclick = () => { if (L.id !== layerId) setActive(cur, L.id); };
    row.ondblclick = async () => {
      const n = await promptDlg('레이어 이름', L.name);
      if (n) { L.name = n; refreshLayers(); scheduleSave(); }
    };
    let pressTimer = 0;
    row.addEventListener('pointerdown', () => {
      pressTimer = setTimeout(async () => {
        const n = await promptDlg('레이어 이름', L.name);
        if (n) { L.name = n; refreshLayers(); scheduleSave(); }
      }, 650);
    });
    row.addEventListener('pointerup', () => clearTimeout(pressTimer));
    row.addEventListener('pointerleave', () => clearTimeout(pressTimer));
    layerListEl.append(row);
  }
  const L = activeLayer();
  $('#layerOpacity').value = Math.round(L.opacity * 100);
  $('#layerOpVal').textContent = Math.round(L.opacity * 100) + '%';
}

function refreshLayerThumb() {
  const c = layerListEl.querySelector(`canvas[data-lid="${layerId}"]`);
  const L = activeLayer();
  if (c && L) layerThumbDraw(L, c);
}

function layerVisualChanged() {
  rebuildCaches();
  thumbs.clear();
  rebuildTimeline();
  refreshLayers();
  scheduleSave();
  requestRender();
}

$('#layerAdd').onclick = () => {
  if (layers().length >= MAX_LAYERS) { toast(`레이어는 최대 ${MAX_LAYERS}개예요`); return; }
  structOp(() => {
    const li = project.layers.findIndex((L) => L.id === layerId);
    const L = newLayer('레이어 ' + (project.layers.length + 1));
    project.layers.splice(li + 1, 0, L);
    layerId = L.id;
  });
};
$('#layerDup').onclick = () => {
  if (layers().length >= MAX_LAYERS) { toast(`레이어는 최대 ${MAX_LAYERS}개예요`); return; }
  structOp(() => {
    const li = project.layers.findIndex((L) => L.id === layerId);
    const src = project.layers[li];
    const L = { ...newLayer(src.name + ' 복사'), opacity: src.opacity };
    project.layers.splice(li + 1, 0, L);
    for (const f of project.frames) if (f.cels[src.id]) f.cels[L.id] = f.cels[src.id];
    layerId = L.id;
  }, { thumbsStale: true });
};
$('#layerDel').onclick = async () => {
  if (layers().length === 1) { toast('레이어가 하나뿐이라 지울 수 없어요'); return; }
  structOp(() => {
    const li = project.layers.findIndex((L) => L.id === layerId);
    const [L] = project.layers.splice(li, 1);
    for (const f of project.frames) delete f.cels[L.id];
    layerId = project.layers[Math.max(0, li - 1)].id;
  }, { thumbsStale: true });
};
$('#layerMerge').onclick = () => {
  const li = project.layers.findIndex((L) => L.id === layerId);
  if (li === 0) { toast('맨 아래 레이어는 합칠 수 없어요'); return; }
  structOp(() => {
    const top = project.layers[li], bot = project.layers[li - 1];
    for (const f of project.frames) {
      const t = f.cels[top.id];
      if (!t) continue;
      const b = f.cels[bot.id];
      const x0 = Math.min(t.x, b ? b.x : t.x), y0 = Math.min(t.y, b ? b.y : t.y);
      const x1 = Math.max(t.x + t.canvas.width, b ? b.x + b.canvas.width : 0);
      const y1 = Math.max(t.y + t.canvas.height, b ? b.y + b.canvas.height : 0);
      const c = makeCanvas(x1 - x0, y1 - y0);
      const cx = c.getContext('2d');
      if (b) cx.drawImage(b.canvas, b.x - x0, b.y - y0);
      cx.globalAlpha = top.visible ? top.opacity / (bot.opacity || 1) : 0;
      cx.globalAlpha = Math.min(1, cx.globalAlpha);
      cx.drawImage(t.canvas, t.x - x0, t.y - y0);
      f.cels[bot.id] = { canvas: c, x: x0, y: y0 };
      delete f.cels[top.id];
    }
    project.layers.splice(li, 1);
    layerId = bot.id;
  }, { thumbsStale: true });
};
$('#layerUp').onclick = () => structOp(() => {
  const a = project.layers, i = a.findIndex((L) => L.id === layerId);
  if (i >= a.length - 1) return false;
  [a[i], a[i + 1]] = [a[i + 1], a[i]];
}, { thumbsStale: true });
$('#layerDown').onclick = () => structOp(() => {
  const a = project.layers, i = a.findIndex((L) => L.id === layerId);
  if (i <= 0) return false;
  [a[i], a[i - 1]] = [a[i - 1], a[i]];
}, { thumbsStale: true });
$('#layerOpacity').addEventListener('input', (e) => {
  const L = activeLayer();
  L.opacity = e.target.value / 100;
  $('#layerOpVal').textContent = e.target.value + '%';
  requestRender();
});
$('#layerOpacity').addEventListener('change', () => { thumbs.clear(); rebuildTimeline(); scheduleSave(); });

// =====================================================================
// 재생
// =====================================================================
let playing = false, playIdx = 0, playAcc = 0, playLast = 0, playRaf = 0;
function togglePlay() { playing ? stopPlay() : startPlay(); }
function startPlay() {
  if (stroke || !project) return;
  commitActive();
  playing = true;
  playIdx = cur; playAcc = 0; playLast = performance.now();
  $('#btnPlay').classList.add('on');
  $('#btnPlay').textContent = '■';
  highlightPlay();
  requestRender();
  playRaf = requestAnimationFrame(playTick);
}
function playTick(now) {
  if (!playing) return;
  let dt = now - playLast;
  playLast = now;
  if (dt > 250) dt = 250;
  playAcc += dt;
  const fs = frames();
  let dur = (fs[playIdx].hold * 1000) / project.fps;
  let changed = false;
  while (playAcc >= dur) {
    playAcc -= dur;
    playIdx = (playIdx + 1) % fs.length;
    dur = (fs[playIdx].hold * 1000) / project.fps;
    changed = true;
  }
  if (changed) { highlightPlay(); render(); }
  playRaf = requestAnimationFrame(playTick);
}
function highlightPlay() {
  [...framesEl.children].forEach((el, i) => el.classList.toggle('playing', playing && i === playIdx));
}
function stopPlay() {
  if (!playing) return;
  playing = false;
  cancelAnimationFrame(playRaf);
  $('#btnPlay').classList.remove('on');
  $('#btnPlay').textContent = '▶';
  highlightPlay();
  requestRender();
}

// =====================================================================
// 저장
// =====================================================================
let saveTimer = 0, saving = false, saveAgain = false;
function scheduleSave() {
  if (!project) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 1500);
}
function metaOf() {
  return {
    id: project.id, name: project.name, width: project.width, height: project.height, fps: project.fps, bg: project.bg,
    layers: project.layers.map((L) => ({ ...L })), frames: project.frames.map((f) => ({ id: f.id, hold: f.hold })),
    cur, layerId, created: project.created, updated: Date.now(), frameCount: project.frames.length,
  };
}
async function galleryThumb() {
  const tw = 360, th = Math.round(clamp((360 * H) / W, 120, 480));
  const c = makeCanvas(tw, th);
  const ctx = c.getContext('2d');
  ctx.fillStyle = project.bg; ctx.fillRect(0, 0, tw, th);
  ctx.setTransform(tw / W, 0, 0, th / H, 0, 0);
  drawCels(ctx, frames()[0]);
  return canvasToBlob(c, 'image/jpeg', 0.8);
}
async function saveNow() {
  if (!project) return;
  clearTimeout(saveTimer);
  if (saving) { saveAgain = true; return; }
  saving = true;
  try {
    if (!stroke) commitActive();
    const pid = project.id;
    const current = new Map();
    for (const f of project.frames) {
      for (const [lid, c] of Object.entries(f.cels)) current.set(`${pid}|${f.id}|${lid}`, { c, fid: f.id, lid });
    }
    const puts = [], dels = [];
    for (const [key, v] of current) {
      if (saved.get(key) !== v.c) {
        puts.push({ key, fid: v.fid, lid: v.lid, x: v.c.x, y: v.c.y, blob: await canvasToBlob(v.c.canvas) });
      }
    }
    for (const key of saved.keys()) if (!current.has(key)) dels.push(key);
    const meta = metaOf();
    meta.thumb = await galleryThumb();
    await store.saveProject(meta, puts, dels);
    if (project && project.id === pid) saved = new Map([...current].map(([k, v]) => [k, v.c]));
  } catch (err) {
    console.error(err);
    toast('저장하지 못했어요: ' + err.message, 4000);
  } finally {
    saving = false;
    if (saveAgain) { saveAgain = false; scheduleSave(); }
  }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
window.addEventListener('pagehide', () => saveNow());

// =====================================================================
// 정보 표시
// =====================================================================
function memoryMB() {
  let px = W * H * 7;
  for (const f of project.frames) for (const c of Object.values(f.cels)) px += c.canvas.width * c.canvas.height;
  return Math.round((px * 4 + undoBytes) / 1048576);
}
function updateInfo() {
  if (!project) return;
  $('#projName').textContent = project.name;
  const mb = memoryMB();
  $('#projInfo').textContent = `${W}×${H} · ${frames().length}프레임 · 약 ${mb}MB`;
  $('#projInfo').style.color = mb > 1200 ? '#ff7a7a' : '';
  $('#btnFps').textContent = project.fps + ' fps';
}

// =====================================================================
// 도구 UI
// =====================================================================
function setTool(t) {
  prefs.tool = t;
  savePrefs();
  document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  syncSliders();
  requestRender();
}
function syncSliders() {
  const k = toolKey();
  $('#sizeRange').value = prefs.size[k];
  $('#sizeVal').textContent = prefs.size[k];
  $('#opacityRange').value = prefs.opacity[k];
  $('#opacityVal').textContent = prefs.opacity[k] + '%';
}
document.querySelectorAll('.tool[data-tool]').forEach((b) => {
  b.addEventListener('click', () => {
    if (prefs.tool === b.dataset.tool) toggleToolPanel();
    else { setTool(b.dataset.tool); closeToolPanel(); }
  });
});
$('#sizeRange').addEventListener('input', (e) => {
  prefs.size[toolKey()] = +e.target.value;
  $('#sizeVal').textContent = e.target.value;
  savePrefs();
  const r = view.getBoundingClientRect();
  hover = hover || toDoc({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
  requestRender();
});
$('#opacityRange').addEventListener('input', (e) => {
  prefs.opacity[toolKey()] = +e.target.value;
  $('#opacityVal').textContent = e.target.value + '%';
  savePrefs();
});

const toolPanel = $('#toolPanel');
function closeToolPanel() { toolPanel.hidden = true; }
function toggleToolPanel() {
  if (!toolPanel.hidden) { closeToolPanel(); return; }
  const t = prefs.tool;
  const opt = (label, on, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label;
    if (on) b.classList.add('on');
    b.onclick = () => { fn(); toggleToolPanel(); toggleToolPanel(); };
    return b;
  };
  toolPanel.textContent = '';
  const h = (txt) => { const e = document.createElement('h4'); e.textContent = txt; toolPanel.append(e); };
  const opts = (...btns) => { const d = document.createElement('div'); d.className = 'opts'; d.append(...btns); toolPanel.append(d); };
  const slider = (label, min, max, val, fn) => {
    const l = document.createElement('label');
    const s = document.createElement('span'); s.textContent = `${label} ${val}`;
    const i = document.createElement('input'); i.type = 'range'; i.min = min; i.max = max; i.value = val;
    i.oninput = () => { fn(+i.value); s.textContent = `${label} ${i.value}`; savePrefs(); };
    l.append(s, i); toolPanel.append(l);
  };
  if (t === 'brush') {
    h('브러시 종류');
    const types = [['pen', '펜 (필압 굵기)'], ['pencil', '연필'], ['marker', '마커 (일정 굵기)'], ['airbrush', '에어브러시']];
    opts(...types.map(([k, n]) => opt(n, prefs.brushType === k, () => { prefs.brushType = k; savePrefs(); })));
    slider('손떨림 보정', 0, 90, prefs.smooth, (v) => { prefs.smooth = v; });
  } else if (t === 'eraser') {
    h('지우개');
    const p = document.createElement('p');
    p.style.cssText = 'font-size:13px;color:#9aa3b5;margin:0';
    p.textContent = '왼쪽 슬라이더로 크기와 세기를 조절해요. S펜 버튼을 누른 채 그려도 지워져요.';
    toolPanel.append(p);
  } else if (t === 'fill') {
    h('채우기 기준');
    opts(opt('모든 레이어 보고 채우기', prefs.fillAll, () => { prefs.fillAll = true; savePrefs(); }),
      opt('현재 레이어만', !prefs.fillAll, () => { prefs.fillAll = false; savePrefs(); }));
    slider('허용 오차', 0, 160, prefs.fillTol, (v) => { prefs.fillTol = v; });
  } else if (t === 'shape') {
    h('도형');
    opts(...[['line', '직선'], ['rect', '사각형'], ['ellipse', '원']].map(([k, n]) =>
      opt(n, prefs.shapeType === k, () => { prefs.shapeType = k; savePrefs(); updateShapeIcon(); })));
    opts(opt('선만', !prefs.shapeFill, () => { prefs.shapeFill = false; savePrefs(); }),
      opt('채우기', prefs.shapeFill, () => { prefs.shapeFill = true; savePrefs(); }));
  } else {
    h('스포이트');
    const p = document.createElement('p');
    p.style.cssText = 'font-size:13px;color:#9aa3b5;margin:0';
    p.textContent = '화면을 누르면 그 위치의 색을 가져와요.';
    toolPanel.append(p);
  }
  toolPanel.hidden = false;
}
function updateShapeIcon() {
  $('.tool[data-tool="shape"]').textContent = { line: '╱', rect: '▭', ellipse: '◯' }[prefs.shapeType];
}

// ---------- 색 ----------
function setColor(hex, addRecent = false) {
  prefs.color = hex.toLowerCase();
  $('#colorChip').style.background = prefs.color;
  if (addRecent) {
    prefs.recent = [prefs.color, ...prefs.recent.filter((c) => c !== prefs.color)].slice(0, 10);
  }
  savePrefs();
  rebuildBrushMaterials();
}

const hsv = { h: 0, s: 0, v: 0 };
function hexToHsv(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: mx ? d / mx : 0, v: mx };
}
function hsvToHex({ h, s, v }) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return '#' + [f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function drawPicker() {
  const sv = $('#svPad'), hp = $('#huePad');
  const c = sv.getContext('2d');
  c.fillStyle = `hsl(${hsv.h},100%,50%)`;
  c.fillRect(0, 0, sv.width, sv.height);
  let g = c.createLinearGradient(0, 0, sv.width, 0);
  g.addColorStop(0, '#fff'); g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g; c.fillRect(0, 0, sv.width, sv.height);
  g = c.createLinearGradient(0, 0, 0, sv.height);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, '#000');
  c.fillStyle = g; c.fillRect(0, 0, sv.width, sv.height);
  c.strokeStyle = hsv.v > 0.5 ? '#000' : '#fff'; c.lineWidth = 2;
  c.beginPath(); c.arc(hsv.s * sv.width, (1 - hsv.v) * sv.height, 7, 0, Math.PI * 2); c.stroke();
  const h = hp.getContext('2d');
  g = h.createLinearGradient(0, 0, 0, hp.height);
  for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, `hsl(${i * 60},100%,50%)`);
  h.fillStyle = g; h.fillRect(0, 0, hp.width, hp.height);
  h.fillStyle = '#fff'; h.fillRect(0, (hsv.h / 360) * hp.height - 2, hp.width, 4);
  $('#colorPreview').style.background = prefs.color;
  $('#colorHex').value = prefs.color;
}
function bindPad(el, fn) {
  const handle = (e) => {
    const r = el.getBoundingClientRect();
    fn(clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1));
    setColor(hsvToHex(hsv));
    drawPicker();
  };
  el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); handle(e); });
  el.addEventListener('pointermove', (e) => { if (e.buttons) handle(e); });
}
bindPad($('#svPad'), (x, y) => { hsv.s = x; hsv.v = 1 - y; });
bindPad($('#huePad'), (x, y) => { hsv.h = Math.min(359.9, y * 360); });
$('#colorHex').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  if (/^#?[0-9a-f]{6}$/i.test(v)) {
    setColor(v.startsWith('#') ? v : '#' + v);
    Object.assign(hsv, hexToHsv(prefs.color));
    drawPicker();
  }
});
function fillSwatches(el, list) {
  el.textContent = '';
  for (const c of list) {
    const b = document.createElement('button');
    b.type = 'button'; b.style.background = c; b.title = c;
    b.onclick = () => { setColor(c); Object.assign(hsv, hexToHsv(c)); drawPicker(); };
    el.append(b);
  }
}
$('#colorBtn').onclick = async () => {
  Object.assign(hsv, hexToHsv(prefs.color));
  fillSwatches($('#swatches'), PALETTE);
  fillSwatches($('#recentSwatches'), prefs.recent);
  drawPicker();
  await openDialog($('#dlgColor'));
  setColor(prefs.color, true);
};
$('#colorSystem').onclick = () => { const n = $('#colorNative'); n.value = prefs.color; n.click(); };
$('#colorNative').addEventListener('input', (e) => {
  setColor(e.target.value);
  Object.assign(hsv, hexToHsv(prefs.color));
  drawPicker();
});

// ---------- 상단 토글 ----------
function updateToggles() {
  $('#btnOnion').classList.toggle('on', prefs.onion);
  $('#btnGrid').classList.toggle('on', prefs.grid);
  $('#btnPenOnly').classList.toggle('on', prefs.penOnly);
  $('#btnLayers').classList.toggle('on', prefs.layersOpen);
  $('#layers').hidden = !prefs.layersOpen;
}
function longPress(el, onTap, onLong) {
  let t = 0, fired = false;
  el.addEventListener('pointerdown', () => { fired = false; t = setTimeout(() => { fired = true; onLong(); }, 550); });
  el.addEventListener('pointerup', () => clearTimeout(t));
  el.addEventListener('pointerleave', () => clearTimeout(t));
  el.addEventListener('click', () => { if (!fired) onTap(); });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); });
}
let onionHintShown = false;
longPress($('#btnOnion'), () => {
  prefs.onion = !prefs.onion; savePrefs(); updateToggles(); rebuildOnion(); requestRender();
  if (!onionHintShown) { onionHintShown = true; toast('길게 누르면 어니언 스킨 설정이 열려요'); }
}, openOnionDialog);
longPress($('#btnGrid'), () => { prefs.grid = !prefs.grid; savePrefs(); updateToggles(); requestRender(); }, openOnionDialog);
$('#btnPenOnly').onclick = () => {
  prefs.penOnly = !prefs.penOnly; savePrefs(); updateToggles();
  toast(prefs.penOnly ? '펜 전용: 손가락은 이동·확대만 해요' : '손가락으로도 그릴 수 있어요');
};
$('#btnLayers').onclick = () => { prefs.layersOpen = !prefs.layersOpen; savePrefs(); updateToggles(); setTimeout(resizeView, 0); };
$('#btnFit').onclick = fitView;
$('#btnUndo').onclick = undo;
$('#btnRedo').onclick = redo;
$('#btnPlay').onclick = togglePlay;
$('#btnBack').onclick = () => showGallery();
$('#projName').onclick = async () => {
  const n = await promptDlg('프로젝트 이름', project.name);
  if (n) { project.name = n; updateInfo(); scheduleSave(); }
};

async function openOnionDialog() {
  const set = (id, v) => { $(id).value = v; };
  set('#onPrev', prefs.onionPrev); set('#onNext', prefs.onionNext); set('#onAlpha', prefs.onionAlpha);
  $('#onTint').checked = prefs.onionTint;
  $('#gridSize').value = prefs.gridSize;
  const upd = () => {
    prefs.onionPrev = +$('#onPrev').value; prefs.onionNext = +$('#onNext').value;
    prefs.onionAlpha = +$('#onAlpha').value; prefs.onionTint = $('#onTint').checked;
    prefs.gridSize = $('#gridSize').value;
    $('#onPrevVal').textContent = prefs.onionPrev;
    $('#onNextVal').textContent = prefs.onionNext;
    $('#onAlphaVal').textContent = prefs.onionAlpha + '%';
    savePrefs();
    if (project) { rebuildOnion(); requestRender(); }
  };
  upd();
  const dlg = $('#dlgOnion');
  dlg.oninput = upd; dlg.onchange = upd;
  await openDialog(dlg);
}

// ---------- 이미지 가져오기 ----------
$('#btnImport').onclick = () => $('#fileImage').click();
$('#fileImage').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  if (layers().length >= MAX_LAYERS) { toast(`레이어는 최대 ${MAX_LAYERS}개예요`); return; }
  try {
    const bmp = await createImageBitmap(file);
    const s = Math.min(1, W / bmp.width, H / bmp.height);
    const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
    const c = makeCanvas(w, h);
    c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close();
    structOp(() => {
      const li = project.layers.findIndex((L) => L.id === layerId);
      const L = newLayer('이미지');
      project.layers.splice(li + 1, 0, L);
      frames()[cur].cels[L.id] = { canvas: c, x: Math.round((W - w) / 2), y: Math.round((H - h) / 2) };
      layerId = L.id;
    }, { thumbsStale: true });
    toast('이미지를 새 레이어로 넣었어요');
  } catch (err) {
    toast('이미지를 열 수 없어요: ' + err.message);
  }
});

// =====================================================================
// FPS 대화상자
// =====================================================================
$('#btnFps').onclick = async () => {
  const box = $('#fpsPresets');
  box.textContent = '';
  const input = $('#fpsInput');
  input.value = project.fps;
  for (const f of FPS_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = f;
    if (f === project.fps) b.classList.add('on');
    b.onclick = () => { input.value = f; box.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); };
    box.append(b);
  }
  if ((await openDialog($('#dlgFps'))) === 'ok') {
    const v = clamp(Math.round(+input.value || 12), 1, 60);
    project.fps = v;
    updateInfo();
    scheduleSave();
    toast(`${v} FPS로 바꿨어요`);
  }
};

// =====================================================================
// 프로젝트 만들기 / 설정 대화상자
// =====================================================================
function setupSizePresets() {
  const box = $('#sizePresets');
  box.textContent = '';
  for (const [name, w, h] of SIZE_PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `${name}<small>${w}×${h}</small>`;
    b.dataset.w = w; b.dataset.h = h;
    b.onclick = () => { $('#pW').value = w; $('#pH').value = h; projDlgUpdate(); };
    box.append(b);
  }
}
function projDlgUpdate() {
  const w = +$('#pW').value, h = +$('#pH').value;
  $('#sizePresets').querySelectorAll('button').forEach((b) => b.classList.toggle('on', +b.dataset.w === w && +b.dataset.h === h));
  let warn = '';
  if (w * h > 1920 * 1200) warn = '큰 크기는 태블릿 메모리를 많이 써요. 짧은 작품에만 추천해요.';
  if (w % 2 || h % 2) warn = 'MP4는 짝수 크기만 돼요. 만들 때 자동으로 짝수로 맞춰요.';
  $('#pWarn').textContent = warn;
}
$('#pW').addEventListener('input', projDlgUpdate);
$('#pH').addEventListener('input', projDlgUpdate);
$('#pSwap').onclick = () => { const w = $('#pW').value; $('#pW').value = $('#pH').value; $('#pH').value = w; projDlgUpdate(); };

async function projectDialog(mode) {
  setupSizePresets();
  const editing = mode === 'edit';
  $('#dlgProjectTitle').textContent = editing ? '프로젝트 설정' : '새 프로젝트';
  $('#pOk').textContent = editing ? '적용' : '만들기';
  $('#resizeModeRow').hidden = !editing;
  if (editing) {
    $('#pName').value = project.name; $('#pW').value = project.width; $('#pH').value = project.height;
    $('#pFps').value = project.fps; $('#pBg').value = project.bg;
  } else {
    $('#pName').value = '새 애니메이션'; $('#pW').value = 1920; $('#pH').value = 1080; $('#pFps').value = 12; $('#pBg').value = '#ffffff';
  }
  projDlgUpdate();
  if ((await openDialog($('#dlgProject'))) !== 'ok') return null;
  return {
    name: $('#pName').value.trim() || '새 애니메이션',
    width: clamp(even(+$('#pW').value || 1920), 16, 3840),
    height: clamp(even(+$('#pH').value || 1080), 16, 3840),
    fps: clamp(Math.round(+$('#pFps').value || 12), 1, 60),
    bg: $('#pBg').value,
    mode: (document.querySelector('input[name=rmode]:checked') || {}).value || 'fit',
  };
}

$('#btnSettings').onclick = async () => {
  if (playing) stopPlay();
  const r = await projectDialog('edit');
  if (!r) return;
  commitActive();
  project.name = r.name; project.fps = r.fps;
  const bgChanged = project.bg !== r.bg;
  project.bg = r.bg;
  if (r.width !== project.width || r.height !== project.height) {
    resizeProject(r.width, r.height, r.mode);
    toast(`${r.width}×${r.height}로 바꿨어요 (실행취소 기록은 지워졌어요)`, 3000);
  } else if (bgChanged) {
    thumbs.clear(); rebuildTimeline();
  }
  updateInfo();
  requestRender();
  scheduleSave();
};

function resizeProject(nw, nh, mode) {
  const ow = W, oh = H;
  let sx, sy, ox, oy;
  if (mode === 'stretch') { sx = nw / ow; sy = nh / oh; ox = 0; oy = 0; }
  else if (mode === 'fit') { const s = Math.min(nw / ow, nh / oh); sx = sy = s; ox = (nw - ow * s) / 2; oy = (nh - oh * s) / 2; }
  else { sx = sy = 1; ox = Math.round((nw - ow) / 2); oy = Math.round((nh - oh) / 2); }
  for (const f of project.frames) {
    for (const [lid, c] of Object.entries(f.cels)) {
      const w = Math.max(1, Math.round(c.canvas.width * sx)), h = Math.max(1, Math.round(c.canvas.height * sy));
      const nc = makeCanvas(w, h);
      const ctx = nc.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(c.canvas, 0, 0, w, h);
      f.cels[lid] = { canvas: nc, x: Math.round(c.x * sx + ox), y: Math.round(c.y * sy + oy) };
    }
  }
  project.width = nw; project.height = nh;
  setupBuffers();
  rebuildBrushMaterials();
  clearHistory();
  loadActive();
  rebuildTimeline();
  refreshLayers();
  fitView();
}

// =====================================================================
// 내보내기
// =====================================================================
let exportAbort = null, exportUrl = null;
function exportSize() {
  const s = +(document.querySelector('input[name=exs]:checked') || {}).value || 1;
  return [even(W * s), even(H * s)];
}
function exportInfo() {
  const fmt = document.querySelector('input[name=exf]:checked').value;
  const [ew, eh] = exportSize();
  const ticks = frames().reduce((a, f) => a + f.hold, 0);
  const sec = (ticks / project.fps).toFixed(2);
  let txt = `${ew}×${eh} · ${project.fps}fps · ${frames().length}프레임 · ${sec}초`;
  if (fmt === 'mp4') {
    if (webCodecsAvailable()) txt += ' · H.264 인코더 사용';
    else if (recorderAvailable()) txt += ' · 이 브라우저는 실시간 녹화 방식으로 만들어요(WebM일 수 있음)';
    else txt += ' · ⚠ 이 브라우저는 영상 만들기를 지원하지 않아요';
    if (ew > 4096 || eh > 4096) txt += ' · ⚠ 4096px를 넘으면 실패할 수 있어요';
  }
  if (fmt === 'gif' && ew * eh > 1280 * 720) txt += ' · GIF는 크기가 크면 오래 걸려요(0.5배 추천)';
  $('#exInfo').textContent = txt;
  $('#exTransparent').parentElement.hidden = !(fmt === 'png' || fmt === 'frame');
}
$('#formExport').addEventListener('change', exportInfo);

$('#btnExport').onclick = async () => {
  if (playing) stopPlay();
  commitActive();
  $('#exResult').hidden = true;
  $('#exProgress').hidden = true;
  $('#exStart').disabled = false;
  exportInfo();
  await openDialog($('#dlgExport'));
  if (exportAbort) exportAbort.abort();
};

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

$('#exStart').onclick = async () => {
  const fmt = document.querySelector('input[name=exf]:checked').value;
  const [ew, eh] = exportSize();
  const transparent = $('#exTransparent').checked && (fmt === 'png' || fmt === 'frame');
  const fs = frames();
  const draw = (ctx, i) => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (transparent) ctx.clearRect(0, 0, ew, eh);
    else { ctx.fillStyle = project.bg; ctx.fillRect(0, 0, ew, eh); }
    ctx.setTransform(ew / W, 0, 0, eh / H, 0, 0);
    ctx.imageSmoothingQuality = 'high';
    drawCels(ctx, fs[i]);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };
  const bar = $('#exProgress');
  bar.hidden = false;
  bar.firstElementChild.style.width = '0%';
  const onProgress = (p) => { bar.firstElementChild.style.width = Math.round(p * 100) + '%'; };
  $('#exStart').disabled = true;
  $('#exResult').hidden = true;
  exportAbort = new AbortController();
  const opts = { width: ew, height: eh, fps: project.fps, frames: fs, drawFrame: draw, onProgress, signal: exportAbort.signal };
  const base = (project.name.replace(/[\\/:*?"<>|]/g, '').trim() || 'animate') + '_' + stamp();
  let blob, name;
  try {
    if (fmt === 'mp4') {
      if (webCodecsAvailable()) {
        try { blob = await encodeMP4(opts); name = base + '.mp4'; }
        catch (err) {
          if (exportAbort.signal.aborted) throw err;
          console.warn(err);
          if (!recorderAvailable()) throw err;
          toast('H.264 인코더 실패 → 실시간 녹화로 다시 만들어요', 3000);
          blob = await recordVideo(opts);
        }
      } else if (recorderAvailable()) blob = await recordVideo(opts);
      else throw new Error('이 브라우저는 영상 만들기를 지원하지 않아요');
      if (!name) name = base + (blob.type.includes('mp4') ? '.mp4' : '.webm');
    } else if (fmt === 'gif') {
      blob = await encodeGIF(opts); name = base + '.gif';
    } else if (fmt === 'png') {
      const zip = new ZipWriter();
      const c = makeCanvas(ew, eh);
      const ctx = c.getContext('2d');
      let n = 0;
      const total = fs.reduce((a, f) => a + f.hold, 0);
      for (let i = 0; i < fs.length; i++) {
        if (exportAbort.signal.aborted) throw new Error('취소했어요');
        draw(ctx, i);
        const data = new Uint8Array(await (await canvasToBlob(c)).arrayBuffer());
        for (let k = 0; k < fs[i].hold; k++) {
          n++;
          zip.add(`frame_${String(n).padStart(4, '0')}.png`, data);
        }
        onProgress(n / total);
      }
      blob = zip.blob(); name = base + '_png.zip';
    } else {
      const c = makeCanvas(ew, eh);
      draw(c.getContext('2d'), cur);
      blob = await canvasToBlob(c); name = base + `_frame${cur + 1}.png`;
      onProgress(1);
    }
  } catch (err) {
    console.error(err);
    if (!exportAbort.signal.aborted) toast('내보내기 실패: ' + err.message, 5000);
    $('#exStart').disabled = false;
    bar.hidden = true;
    exportAbort = null;
    return;
  }
  exportAbort = null;
  $('#exStart').disabled = false;
  showExportResult(blob, name);
};

function showExportResult(blob, name) {
  if (exportUrl) URL.revokeObjectURL(exportUrl);
  exportUrl = URL.createObjectURL(blob);
  const box = $('#exResult');
  box.textContent = '';
  if (blob.type.startsWith('video/')) {
    const v = document.createElement('video');
    v.src = exportUrl; v.controls = true; v.loop = true; v.muted = true; v.playsInline = true; v.autoplay = true;
    box.append(v);
  } else if (blob.type.startsWith('image/')) {
    const img = document.createElement('img');
    img.src = exportUrl;
    box.append(img);
  }
  const info = document.createElement('div');
  info.className = 'info';
  info.textContent = `${name} · ${(blob.size / 1048576).toFixed(2)}MB`;
  const row = document.createElement('div');
  row.className = 'row';
  const dl = document.createElement('button');
  dl.type = 'button'; dl.className = 'btn primary'; dl.textContent = '⤓ 기기에 저장';
  dl.onclick = () => {
    const a = document.createElement('a');
    a.href = exportUrl; a.download = name;
    document.body.append(a); a.click(); a.remove();
    toast('다운로드 폴더에 저장했어요');
  };
  row.append(dl);
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    const sh = document.createElement('button');
    sh.type = 'button'; sh.className = 'btn'; sh.textContent = '공유 / 갤러리에 저장';
    sh.onclick = async () => {
      try { await navigator.share({ files: [file], title: project.name }); }
      catch (err) { if (err.name !== 'AbortError') toast('공유 실패: ' + err.message); }
    };
    row.append(sh);
  }
  box.append(info, row);
  box.hidden = false;
}

// =====================================================================
// 갤러리
// =====================================================================
let galleryUrls = [];
async function showGallery() {
  if (project) {
    stopPlay();
    await saveNow();
  }
  project = null;
  active = null;
  clearHistory();
  $('#editor').hidden = true;
  $('#gallery').hidden = false;
  galleryUrls.forEach((u) => URL.revokeObjectURL(u));
  galleryUrls = [];
  const list = await store.listProjects();
  const box = $('#galList');
  box.textContent = '';
  $('#galEmpty').hidden = list.length > 0;
  for (const m of list) {
    const card = document.createElement('div');
    card.className = 'card';
    const th = document.createElement('button');
    th.className = 'thumb';
    if (m.thumb) {
      const u = URL.createObjectURL(m.thumb);
      galleryUrls.push(u);
      th.style.backgroundImage = `url(${u})`;
    }
    th.onclick = () => openProject(m.id);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const b = document.createElement('b'); b.textContent = m.name;
    const sm = document.createElement('small');
    sm.textContent = `${m.width}×${m.height} · ${m.fps}fps · ${m.frameCount || m.frames.length}프레임 · ${new Date(m.updated).toLocaleDateString()}`;
    meta.append(b, sm);
    const ops = document.createElement('div');
    ops.className = 'ops';
    const mk = (txt, fn) => { const x = document.createElement('button'); x.textContent = txt; x.onclick = fn; return x; };
    ops.append(
      mk('열기', () => openProject(m.id)),
      mk('이름', async () => {
        const n = await promptDlg('프로젝트 이름', m.name);
        if (n) { await store.putMeta({ ...m, name: n }); showGallery(); }
      }),
      mk('복제', async () => { await store.duplicateProject(m.id, uid(), m.name + ' 복사'); showGallery(); }),
      mk('삭제', async () => {
        if (await confirmDlg(`'${m.name}' 프로젝트를 삭제할까요? 되돌릴 수 없어요.`, '삭제')) {
          await store.deleteProject(m.id); showGallery();
        }
      }),
    );
    card.append(th, meta, ops);
    box.append(card);
  }
  const est = await store.storageEstimate();
  $('#galStorage').textContent = est
    ? `사용 중인 저장 공간: ${(est.usage / 1048576).toFixed(1)}MB / 사용 가능: 약 ${(est.quota / 1073741824).toFixed(1)}GB · 작품은 이 기기 브라우저 안에 저장돼요`
    : '작품은 이 기기 브라우저 안에 저장돼요';
}

$('#galNew').onclick = async () => {
  const r = await projectDialog('new');
  if (!r) return;
  const L = newLayer('레이어 1');
  const p = {
    id: uid(), name: r.name, width: r.width, height: r.height, fps: r.fps, bg: r.bg,
    layers: [L], frames: [newFrame()], created: Date.now(),
  };
  enterEditor(p, new Map(), 0, L.id);
  await saveNow();
};
$('#galFullscreen').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => toast('전체 화면을 쓸 수 없어요'));
};

async function openProject(pid) {
  toast('불러오는 중…', 10000);
  try {
    const { meta, cels } = await store.loadProject(pid);
    if (!meta) throw new Error('프로젝트가 없어요');
    const p = { ...meta, frames: meta.frames.map((f) => ({ id: f.id, hold: f.hold || 1, cels: {} })) };
    delete p.thumb;
    const byId = new Map(p.frames.map((f) => [f.id, f]));
    const lids = new Set(p.layers.map((L) => L.id));
    const savedMap = new Map();
    for (const rec of cels) {
      const f = byId.get(rec.fid);
      if (!f || !lids.has(rec.lid)) continue;
      const bmp = await createImageBitmap(rec.blob);
      const c = makeCanvas(bmp.width, bmp.height);
      c.getContext('2d').drawImage(bmp, 0, 0);
      bmp.close && bmp.close();
      const cel = { canvas: c, x: rec.x, y: rec.y };
      f.cels[rec.lid] = cel;
      savedMap.set(rec.key, cel);
    }
    const lid = lids.has(meta.layerId) ? meta.layerId : p.layers[0].id;
    enterEditor(p, savedMap, clamp(meta.cur || 0, 0, p.frames.length - 1), lid);
    toast('불러왔어요', 900);
  } catch (err) {
    console.error(err);
    toast('불러오지 못했어요: ' + err.message, 4000);
  }
}

function enterEditor(p, savedMap, fi, lid) {
  project = p;
  saved = savedMap;
  cur = fi; layerId = lid;
  setupBuffers();
  rebuildBrushMaterials();
  clearHistory();
  $('#gallery').hidden = true;
  $('#editor').hidden = false;
  updateToggles();
  resizeView();
  loadActive();
  rebuildTimeline();
  refreshLayers();
  updateInfo();
  fitView();
}

// =====================================================================
// 시작
// =====================================================================
new ResizeObserver(() => { if (project) resizeView(); }).observe($('#stage'));
window.addEventListener('orientationchange', () => setTimeout(() => { if (project) fitView(); }, 300));

setColor(prefs.color);
setTool(prefs.tool);
updateShapeIcon();
updateToggles();
store.requestPersist();
showGallery();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW 등록 실패', e));
}
