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
  grid: false, gridSize: '100', recent: [], layersOpen: false,
  selectMode: 'lasso', textFont: 'sans-serif', textSize: 72, textBold: false, textOutline: false, sound: true,
};
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('animate.prefs') || '{}');
    return { ...DEFAULT_PREFS, ...p, size: { ...DEFAULT_PREFS.size, ...(p.size || {}) }, opacity: { ...DEFAULT_PREFS.opacity, ...(p.opacity || {}) } };
  } catch { return { ...DEFAULT_PREFS }; }
}
const prefs = loadPrefs();
function savePrefs() { try { localStorage.setItem('animate.prefs', JSON.stringify(prefs)); } catch { /* 저장 불가 무시 */ } }

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
const audioBlobs = new Map();   // clipId -> Blob
const audioBuffers = new Map(); // clipId -> AudioBuffer

// 작업용 캔버스
let work, workCtx, backup, backupCtx, strokeBuf, sctx, below, belowCtx, above, aboveCtx, onion, onionCtx, tmp, tmpCtx;
let active = null;       // {fid, lid} — work 캔버스에 올라와 있는 셀
let workDirty = false;
let workBounds = null;   // [x0,y0,x1,y1] 그림이 있을 수 있는 영역

const view = $('#view');
const vctx = view.getContext('2d');
const V = { zoom: 1, x: 0, y: 0, r: 0 }; // r: 캔버스 회전(라디안)

function screenToDoc(sx, sy) {
  const dx = sx - V.x, dy = sy - V.y, c = Math.cos(V.r), s = Math.sin(V.r);
  return { x: (dx * c + dy * s) / V.zoom, y: (-dx * s + dy * c) / V.zoom };
}
// 화면 좌표 screenPt 아래에 문서 좌표 docPt 가 오도록 확대/회전/이동을 정한다
function placeView(screenPt, docPt, z, r) {
  V.zoom = z; V.r = r;
  const c = Math.cos(r), s = Math.sin(r);
  V.x = screenPt.x - (docPt.x * c - docPt.y * s) * z;
  V.y = screenPt.y - (docPt.x * s + docPt.y * c) * z;
}

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
  commitFloat();
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
  const rc = Math.cos(V.r), rs = Math.sin(V.r);
  vctx.setTransform(z * rc, z * rs, -z * rs, z * rc, V.x * dpr, V.y * dpr);
  vctx.imageSmoothingEnabled = V.zoom < 2 || V.r !== 0;
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
      if (float) { vctx.globalAlpha = L.opacity; drawFloat(vctx, float); }
      vctx.globalAlpha = 1;
    }
    vctx.drawImage(above, 0, 0);
  }

  if (prefs.grid) drawGrid(z);
  if (!playing) drawSelectionOverlay();
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
  V.r = 0;
  V.zoom = Math.min((r.width - 16) / W, (r.height - 16) / H);
  V.x = (r.width - W * V.zoom) / 2;
  V.y = (r.height - H * V.zoom) / 2;
  showHud();
  requestRender();
}

let hudTimer = 0;
function showHud() {
  const h = $('#hud');
  let deg = Math.round((V.r * 180) / Math.PI) % 360;
  if (deg > 180) deg -= 360;
  if (deg <= -180) deg += 360;
  h.textContent = `${Math.round(V.zoom * 100)}%` + (deg ? ` · ${deg}°` : '');
  h.hidden = false;
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => { h.hidden = true; }, 1200);
}

function toDoc(e) {
  const r = view.getBoundingClientRect();
  return screenToDoc(e.clientX - r.left, e.clientY - r.top);
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
  if (tool === 'select') { closeToolPanel(); selectDown(e, p); return; }
  if (tool === 'text') { closeToolPanel(); textAt(p); return; }
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
  if (stroke.kind) { selectMove(e); return; }
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
  if (stroke.kind) { selectUp(); return; }
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
  if (stroke.kind) {
    if (stroke.f0 && float) Object.assign(float, stroke.f0);
    stroke = null;
    requestRender();
    return;
  }
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

// =====================================================================
// 선택(올가미) · 떠 있는 그림(float) · 텍스트
// =====================================================================
let float = null;    // {canvas, cx, cy, sx, sy, rot, liftBox}
let selClip = null;  // 복사해 둔 선택 영역

function floatMatrix(f) {
  const c = Math.cos(f.rot), s = Math.sin(f.rot);
  return { a: c * f.sx, b: s * f.sx, c: -s * f.sy, d: c * f.sy, e: f.cx, f: f.cy };
}
function floatCorners(f) {
  const w = f.canvas.width / 2, h = f.canvas.height / 2, m = floatMatrix(f);
  return [[-w, -h], [w, -h], [w, h], [-w, h]].map(([u, v]) => ({ x: m.a * u + m.c * v + m.e, y: m.b * u + m.d * v + m.f }));
}
function floatRotHandle(f) {
  const k = floatCorners(f);
  const mx = (k[0].x + k[1].x) / 2, my = (k[0].y + k[1].y) / 2;
  let dx = mx - f.cx, dy = my - f.cy;
  const len = Math.hypot(dx, dy) || 1;
  dx /= len; dy /= len;
  const off = 36 / V.zoom;
  return { x: mx + dx * off, y: my + dy * off, mx, my };
}
function insideFloat(f, p) {
  const dx = p.x - f.cx, dy = p.y - f.cy, c = Math.cos(f.rot), s = Math.sin(f.rot);
  const u = (dx * c + dy * s) / f.sx, v = (-dx * s + dy * c) / f.sy;
  return Math.abs(u) <= f.canvas.width / 2 && Math.abs(v) <= f.canvas.height / 2;
}
function drawFloat(ctx, f) {
  const m = floatMatrix(f);
  ctx.save();
  ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f);
  ctx.drawImage(f.canvas, -f.canvas.width / 2, -f.canvas.height / 2);
  ctx.restore();
}
function pathTo(ctx, pts) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
}
function cloneCanvas(c) {
  const n = makeCanvas(c.width, c.height);
  n.getContext('2d').drawImage(c, 0, 0);
  return n;
}

function liftSelection(path) {
  const xs = path.map((p) => p.x), ys = path.map((p) => p.y);
  const bx = clamp(Math.floor(Math.min(...xs)), 0, W), by = clamp(Math.floor(Math.min(...ys)), 0, H);
  const ex = clamp(Math.ceil(Math.max(...xs)), 0, W), ey = clamp(Math.ceil(Math.max(...ys)), 0, H);
  const bw = ex - bx, bh = ey - by;
  if (bw < 2 || bh < 2) return;
  const c = makeCanvas(bw, bh);
  const cx = c.getContext('2d', { willReadFrequently: true });
  cx.translate(-bx, -by);
  pathTo(cx, path);
  cx.fillStyle = '#000';
  cx.fill();
  cx.globalCompositeOperation = 'source-in';
  cx.drawImage(work, 0, 0);
  const d = cx.getImageData(bx, by, bw, bh).data;
  let any = false;
  for (let i = 3; i < d.length; i += 4) if (d[i]) { any = true; break; }
  if (!any) { toast('선택한 곳에 그림이 없어요'); return; }
  backupCtx.clearRect(0, 0, W, H);
  backupCtx.drawImage(work, 0, 0);
  workCtx.save();
  workCtx.globalCompositeOperation = 'destination-out';
  pathTo(workCtx, path);
  workCtx.fill();
  workCtx.restore();
  float = { canvas: c, cx: bx + bw / 2, cy: by + bh / 2, sx: 1, sy: 1, rot: 0, liftBox: [bx, by, ex, ey] };
  updateSelBar();
  requestRender();
}

function startFloat(canvas, cx, cy, sx = 1, sy = 1, rot = 0) {
  commitFloat();
  backupCtx.clearRect(0, 0, W, H);
  backupCtx.drawImage(work, 0, 0);
  float = { canvas, cx, cy, sx, sy, rot, liftBox: null };
  updateSelBar();
  requestRender();
}

function finishFloat(stamp) {
  if (!float) return;
  const f = float;
  float = null;
  const k = floatCorners(f);
  let x0 = Math.min(...k.map((p) => p.x)), y0 = Math.min(...k.map((p) => p.y));
  let x1 = Math.max(...k.map((p) => p.x)), y1 = Math.max(...k.map((p) => p.y));
  if (!stamp) { x0 = x1 = f.cx; y0 = y1 = f.cy; }
  if (f.liftBox) {
    x0 = Math.min(x0, f.liftBox[0]); y0 = Math.min(y0, f.liftBox[1]);
    x1 = Math.max(x1, f.liftBox[2]); y1 = Math.max(y1, f.liftBox[3]);
  }
  if (stamp) {
    const m = floatMatrix(f);
    workCtx.save();
    workCtx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    workCtx.drawImage(f.canvas, -f.canvas.width / 2, -f.canvas.height / 2);
    workCtx.restore();
  }
  const bx = clamp(Math.floor(x0) - 1, 0, W), by = clamp(Math.floor(y0) - 1, 0, H);
  const ex = clamp(Math.ceil(x1) + 1, 0, W), ey = clamp(Math.ceil(y1) + 1, 0, H);
  updateSelBar();
  if (ex - bx > 0 && ey - by > 0) {
    pushPixelUndo(bx, by, ex - bx, ey - by, backupCtx.getImageData(bx, by, ex - bx, ey - by), workCtx.getImageData(bx, by, ex - bx, ey - by));
    extendBounds(bx, by, ex, ey);
    workDirty = true;
    afterEdit();
  }
  requestRender();
}
function commitFloat() { finishFloat(true); }
function deleteFloat() { finishFloat(false); }
function cancelFloat() {
  if (!float) return;
  float = null;
  workCtx.clearRect(0, 0, W, H);
  workCtx.drawImage(backup, 0, 0);
  updateSelBar();
  requestRender();
}

function copyFloat() {
  if (!float) return;
  selClip = { canvas: cloneCanvas(float.canvas), cx: float.cx, cy: float.cy, sx: float.sx, sy: float.sy, rot: float.rot };
  toast('복사했어요. 다른 프레임에서 붙여넣기 할 수 있어요');
  updateSelBar();
}
function pasteClip() {
  if (!selClip) return;
  const L = activeLayer();
  if (!L.visible || L.locked) { toast('숨기거나 잠긴 레이어에는 붙여넣을 수 없어요'); return; }
  const c = selClip;
  startFloat(cloneCanvas(c.canvas), c.cx, c.cy, c.sx, c.sy, c.rot);
  if (prefs.tool !== 'select') setTool('select');
}
function selectAll() {
  commitFloat();
  const b = workBounds || [0, 0, W, H];
  const x0 = clamp(b[0], 0, W), y0 = clamp(b[1], 0, H), x1 = clamp(b[2], 0, W), y1 = clamp(b[3], 0, H);
  liftSelection([{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]);
}

function updateSelBar() {
  const bar = $('#selBar');
  const show = !!project && (float || prefs.tool === 'select');
  bar.hidden = !show;
  if (!show) return;
  bar.textContent = '';
  const b = (label, fn, cls) => {
    const x = document.createElement('button');
    x.type = 'button'; x.textContent = label;
    if (cls) x.className = cls;
    x.onclick = fn;
    bar.append(x);
  };
  if (float) {
    b('✔ 확인', commitFloat, 'ok');
    b('✕ 취소', cancelFloat);
    b('📋 복사', copyFloat);
    b('✂ 잘라내기', () => { copyFloat(); deleteFloat(); });
    b('⇋ 좌우', () => { float.sx *= -1; requestRender(); });
    b('⇵ 상하', () => { float.sy *= -1; requestRender(); });
    b('↺ 원래대로', () => {
      float.rot = 0; float.sx = Math.sign(float.sx); float.sy = Math.sign(float.sy);
      if (float.liftBox) { float.cx = (float.liftBox[0] + float.liftBox[2]) / 2; float.cy = (float.liftBox[1] + float.liftBox[3]) / 2; }
      requestRender();
    });
    b('🗑 삭제', deleteFloat);
  } else {
    b(prefs.selectMode === 'rect' ? '▭ 사각형 선택' : '〰 자유 선택', () => {
      prefs.selectMode = prefs.selectMode === 'rect' ? 'lasso' : 'rect';
      savePrefs(); updateSelBar();
    });
    b('⬚ 레이어 전체 선택', selectAll);
  }
  if (selClip) b('📥 붙여넣기', pasteClip);
}

// 선택 도구에서 펜을 눌렀을 때
function selectDown(e, p) {
  if (float) {
    const tol = 24 / V.zoom;
    const rh = floatRotHandle(float);
    const corners = floatCorners(float);
    const base = { id: e.pointerId, type: e.pointerType, p0: p, f0: { ...float } };
    if (Math.hypot(p.x - rh.x, p.y - rh.y) < tol) { stroke = { ...base, kind: 'rotate' }; return; }
    if (corners.some((k) => Math.hypot(p.x - k.x, p.y - k.y) < tol)) { stroke = { ...base, kind: 'scale' }; return; }
    if (insideFloat(float, p)) { stroke = { ...base, kind: 'move' }; return; }
    commitFloat();
  }
  stroke = { id: e.pointerId, type: e.pointerType, kind: 'lasso', pts: [p], start: p };
  requestRender();
}
function selectMove(e) {
  const p = toDoc(e);
  const s = stroke;
  if (s.kind === 'lasso') {
    if (prefs.selectMode === 'rect') s.end = p;
    else {
      const last = s.pts[s.pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) * V.zoom > 3) s.pts.push(p);
    }
  } else if (s.kind === 'move') {
    float.cx = s.f0.cx + p.x - s.p0.x;
    float.cy = s.f0.cy + p.y - s.p0.y;
  } else if (s.kind === 'scale') {
    const d0 = Math.hypot(s.p0.x - s.f0.cx, s.p0.y - s.f0.cy) || 1;
    const k = Math.max(0.02, Math.hypot(p.x - s.f0.cx, p.y - s.f0.cy) / d0);
    float.sx = s.f0.sx * k; float.sy = s.f0.sy * k;
  } else if (s.kind === 'rotate') {
    const a0 = Math.atan2(s.p0.y - s.f0.cy, s.p0.x - s.f0.cx);
    const a1 = Math.atan2(p.y - s.f0.cy, p.x - s.f0.cx);
    let r = s.f0.rot + a1 - a0;
    const q = Math.PI / 4, near = Math.round(r / q) * q;
    if (Math.abs(r - near) < (4 * Math.PI) / 180) r = near;
    float.rot = r;
  }
  requestRender();
}
function selectUp() {
  const s = stroke;
  stroke = null;
  if (s.kind === 'lasso') {
    let path = s.pts;
    if (prefs.selectMode === 'rect') {
      const a = s.start, b = s.end || s.start;
      path = [{ x: a.x, y: a.y }, { x: b.x, y: a.y }, { x: b.x, y: b.y }, { x: a.x, y: b.y }];
    }
    if (path.length >= 3) liftSelection(path);
  }
  requestRender();
}

function drawSelectionOverlay() {
  const lw = 1.5 / V.zoom;
  if (stroke && stroke.kind === 'lasso') {
    let pts = stroke.pts;
    if (prefs.selectMode === 'rect') {
      const a = stroke.start, b = stroke.end || a;
      pts = [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }];
    }
    vctx.lineWidth = lw;
    vctx.setLineDash([6 / V.zoom, 4 / V.zoom]);
    vctx.strokeStyle = '#000'; pathTo(vctx, pts); vctx.stroke();
    vctx.lineDashOffset = 5 / V.zoom;
    vctx.strokeStyle = '#fff'; pathTo(vctx, pts); vctx.stroke();
    vctx.setLineDash([]); vctx.lineDashOffset = 0;
  }
  if (float) {
    const k = floatCorners(float);
    vctx.lineWidth = lw;
    vctx.setLineDash([6 / V.zoom, 4 / V.zoom]);
    vctx.strokeStyle = '#4c9dff'; pathTo(vctx, k); vctx.stroke();
    vctx.setLineDash([]);
    const rh = floatRotHandle(float);
    vctx.beginPath(); vctx.moveTo(rh.mx, rh.my); vctx.lineTo(rh.x, rh.y); vctx.stroke();
    const r = 9 / V.zoom;
    vctx.fillStyle = '#fff';
    for (const p of k) {
      vctx.beginPath(); vctx.rect(p.x - r, p.y - r, r * 2, r * 2); vctx.fill(); vctx.stroke();
    }
    vctx.fillStyle = '#ff7a45';
    vctx.beginPath(); vctx.arc(rh.x, rh.y, r * 1.1, 0, Math.PI * 2); vctx.fill(); vctx.stroke();
  }
}

// ---------- 텍스트 ----------
async function textAt(p) {
  const L = activeLayer();
  if (!L.visible || L.locked) { toast('숨기거나 잠긴 레이어에는 글자를 넣을 수 없어요'); return; }
  $('#textInput').value = '';
  $('#textFont').value = prefs.textFont;
  $('#textSize').value = prefs.textSize;
  $('#textBold').checked = prefs.textBold;
  $('#textOutline').checked = prefs.textOutline;
  setTimeout(() => $('#textInput').focus(), 60);
  if ((await openDialog($('#dlgText'))) !== 'ok') return;
  const text = $('#textInput').value.replace(/\s+$/, '');
  if (!text) return;
  prefs.textFont = $('#textFont').value;
  prefs.textSize = clamp(+$('#textSize').value || 72, 8, 600);
  prefs.textBold = $('#textBold').checked;
  prefs.textOutline = $('#textOutline').checked;
  savePrefs();
  const size = prefs.textSize;
  const font = `${prefs.textBold ? 'bold ' : ''}${size}px ${prefs.textFont}`;
  const lines = text.split('\n');
  const meas = makeCanvas(1, 1).getContext('2d');
  meas.font = font;
  const pad = Math.ceil(size * 0.2) + (prefs.textOutline ? Math.ceil(size / 8) : 0);
  const lh = Math.ceil(size * 1.25);
  const w = Math.ceil(Math.max(...lines.map((l) => meas.measureText(l).width))) + pad * 2;
  const h = lh * lines.length + pad * 2;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.font = font;
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => {
    const y = pad + i * lh + (lh - size) / 2;
    if (prefs.textOutline) {
      ctx.lineWidth = Math.max(2, size / 8);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#ffffff';
      ctx.strokeText(line, pad, y);
    }
    ctx.fillStyle = prefs.color;
    ctx.fillText(line, pad, y);
  });
  setTool('select');
  startFloat(c, p.x + w / 2, p.y + h / 2);
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
const angleOf = (pts) => (pts.length >= 2 ? Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x) : 0);
function gestureBaseline() {
  const pts = [...touches.values()];
  if (!pts.length) return;
  const c = centroid(pts);
  gest = {
    c0: c, s0: spread(pts, c), z0: V.zoom, r0: V.r, a0: angleOf(pts), d0: screenToDoc(c.x, c.y), n: pts.length,
    maxN: Math.max(gest ? gest.maxN : 0, pts.length),
    t0: gest ? gest.t0 : performance.now(), moved: gest ? gest.moved : 0,
  };
}
function snapAngle(r) {
  const q = Math.PI / 2;
  const near = Math.round(r / q) * q;
  return Math.abs(r - near) < (5 * Math.PI) / 180 ? near : r;
}
function gestureMove() {
  const pts = [...touches.values()];
  if (!gest || !pts.length) return;
  const c = centroid(pts);
  let z = gest.z0, r = gest.r0, turn = 0;
  if (pts.length >= 2) {
    z = clamp(gest.z0 * (spread(pts, c) / gest.s0), 0.05, 32);
    let da = angleOf(pts) - gest.a0;
    if (da > Math.PI) da -= 2 * Math.PI;
    if (da < -Math.PI) da += 2 * Math.PI;
    r = snapAngle(gest.r0 + da);
    turn = Math.abs(da) * spread(pts, c); // 돌린 거리(손가락이 움직인 길이)
  }
  placeView(c, gest.d0, z, r);
  // 이동·확대·회전 중 하나라도 하면 '톡'(실행취소)으로 보지 않는다
  gest.moved = Math.max(gest.moved, Math.hypot(c.x - gest.c0.x, c.y - gest.c0.y) + Math.abs(spread(pts, c) - gest.s0) + turn);
  showHud();
  requestRender();
}

view.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (!project) return;
  if (e.pointerType === 'touch') touches.set(e.pointerId, localPt(e));
  try { view.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
  closeMenus();
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
  const d = screenToDoc(p.x, p.y);
  if (e.shiftKey) placeView(p, d, V.zoom, snapAngle(V.r + e.deltaY * 0.002));
  else placeView(p, d, clamp(V.zoom * Math.exp(-e.deltaY * 0.0015), 0.05, 32), V.r);
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
  else if (k === 's') setTool('select');
  else if (k === 't') setTool('text');
  else if (k === 'enter' && float) commitFloat();
  else if (k === 'escape' && float) cancelFloat();
  else if ((k === 'delete' || k === 'backspace') && float) deleteFloat();
  else if ((e.ctrlKey || e.metaKey) && k === 'c' && float) copyFloat();
  else if ((e.ctrlKey || e.metaKey) && k === 'v') pasteClip();
  else if ((e.ctrlKey || e.metaKey) && k === 'a') { e.preventDefault(); setTool('select'); selectAll(); }
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
  if (float) { cancelFloat(); toast('선택을 취소했어요', 900); return; }
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
  commitFloat();
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
  commitFloat();
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
  drawAudioStrip();
}

function drawAudioStrip() {
  framesEl.querySelectorAll('.aclip').forEach((e) => e.remove());
  if (!project.audio || !project.audio.length) return;
  const kids = [...framesEl.querySelectorAll('.frame')];
  if (!kids.length) return;
  const [starts, total] = computeStarts();
  project.audio.forEach((clip, k) => {
    const st = frameStartTime(clip.start);
    const end = Math.min(total, st + clip.duration);
    if (end <= st) return;
    const i0 = frameAtTime(starts, st), i1 = frameAtTime(starts, end - 1e-6);
    const fd = (i) => frames()[i].hold / project.fps;
    const left = kids[i0].offsetLeft + kids[i0].offsetWidth * ((st - starts[i0]) / fd(i0));
    const right = kids[i1].offsetLeft + kids[i1].offsetWidth * ((end - starts[i1]) / fd(i1));
    const s = document.createElement('span');
    s.className = 'aclip';
    s.style.left = left + 'px';
    s.style.width = Math.max(6, right - left) + 'px';
    s.style.bottom = (2 + (k % 2) * 6) + 'px';
    s.title = clip.name;
    framesEl.append(s);
  });
}

function markActiveFrame() {
  framesEl.querySelectorAll('.frame').forEach((el, i) => el.classList.toggle('active', i === cur));
  const el = framesEl.querySelectorAll('.frame')[cur];
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
// 시간 계산
// =====================================================================
function computeStarts() {
  const st = [];
  let t = 0;
  for (const f of frames()) { st.push(t); t += f.hold / project.fps; }
  return [st, t];
}
function frameStartTime(i) {
  const fs = frames();
  let t = 0;
  for (let k = 0; k < Math.min(i, fs.length); k++) t += fs[k].hold;
  return t / project.fps;
}
function frameAtTime(starts, t) {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// =====================================================================
// 소리
// =====================================================================
let actx = null, audioNodes = [], previewNode = null;
function getAC() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
async function ensureAudioBuffers() {
  for (const clip of project.audio || []) {
    if (audioBuffers.has(clip.id) || !audioBlobs.has(clip.id)) continue;
    try {
      const buf = await getAC().decodeAudioData(await audioBlobs.get(clip.id).arrayBuffer());
      audioBuffers.set(clip.id, buf);
    } catch (e) { console.warn('소리 해석 실패', clip.name, e); }
  }
}
function stopAudio() {
  for (const n of audioNodes) { try { n.stop(); } catch { /* 이미 멈춤 */ } }
  audioNodes = [];
}
function scheduleAudio(fromTime, total) {
  stopAudio();
  if (!prefs.sound || !project.audio || !project.audio.length) return;
  const ac = getAC();
  const now = ac.currentTime + 0.02;
  for (const clip of project.audio) {
    const buf = audioBuffers.get(clip.id);
    if (!buf) continue;
    const st = frameStartTime(clip.start);
    const end = Math.min(total, st + buf.duration);
    if (end <= fromTime) continue;
    const src = ac.createBufferSource();
    src.buffer = buf;
    const g = ac.createGain();
    g.gain.value = clip.volume;
    src.connect(g).connect(ac.destination);
    if (st >= fromTime) src.start(now + (st - fromTime), 0, end - st);
    else src.start(now, fromTime - st, end - fromTime);
    audioNodes.push(src);
  }
}

async function addClip(blob, name, start, rec = false) {
  const id = uid();
  let duration = 0;
  try {
    const buf = await getAC().decodeAudioData(await blob.arrayBuffer());
    audioBuffers.set(id, buf);
    duration = buf.duration;
  } catch {
    toast('이 소리 파일은 열 수 없어요');
    return;
  }
  audioBlobs.set(id, blob);
  await store.putAudio({ key: `${project.id}|${id}`, cid: id, blob });
  project.audio.push({ id, name, start, volume: 1, duration, rec });
  scheduleSave();
  rebuildTimeline();
  if ($('#dlgAudio').open) renderAudioList();
  toast(`'${name}' 소리를 넣었어요`);
}

function renderAudioList() {
  const list = $('#audioList');
  list.textContent = '';
  $('#audioEmpty').hidden = project.audio.length > 0;
  for (const clip of project.audio) {
    const row = document.createElement('div');
    row.className = 'clip';
    const name = document.createElement('b');
    name.textContent = `${clip.rec ? '🎙' : '🎵'} ${clip.name} · ${clip.duration.toFixed(1)}초`;
    const btns = document.createElement('div');
    btns.className = 'row';
    const play = document.createElement('button');
    play.type = 'button'; play.className = 'mini'; play.textContent = '▶ 듣기';
    play.onclick = async () => {
      if (previewNode) { try { previewNode.stop(); } catch { /* 무시 */ } previewNode = null; return; }
      await ensureAudioBuffers();
      const buf = audioBuffers.get(clip.id);
      if (!buf) return;
      const ac = getAC();
      const src = ac.createBufferSource();
      src.buffer = buf;
      const g = ac.createGain(); g.gain.value = clip.volume;
      src.connect(g).connect(ac.destination);
      src.onended = () => { if (previewNode === src) previewNode = null; };
      src.start();
      previewNode = src;
    };
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'mini'; del.textContent = '🗑';
    del.onclick = async () => {
      if (!(await confirmDlg(`'${clip.name}' 소리를 지울까요?`, '지우기'))) return;
      project.audio = project.audio.filter((c) => c !== clip);
      audioBlobs.delete(clip.id); audioBuffers.delete(clip.id);
      await store.deleteAudio(`${project.id}|${clip.id}`);
      scheduleSave(); rebuildTimeline(); renderAudioList();
    };
    btns.append(play, del);
    const ctrl = document.createElement('div');
    ctrl.className = 'ctrl';
    const st = document.createElement('input');
    st.type = 'number'; st.min = 1; st.max = frames().length; st.value = clip.start + 1;
    st.onchange = () => { clip.start = clamp(Math.round(+st.value || 1), 1, frames().length) - 1; st.value = clip.start + 1; scheduleSave(); rebuildTimeline(); };
    const vol = document.createElement('input');
    vol.type = 'range'; vol.min = 0; vol.max = 150; vol.value = Math.round(clip.volume * 100);
    const volTxt = document.createElement('span');
    volTxt.textContent = vol.value + '%';
    vol.oninput = () => { clip.volume = vol.value / 100; volTxt.textContent = vol.value + '%'; scheduleSave(); };
    ctrl.append('시작 장면', st, '소리 크기', vol, volTxt);
    row.append(name, btns, ctrl);
    list.append(row);
  }
}

$('#btnAudio').onclick = async () => {
  if (playing) stopPlay();
  renderAudioList();
  $('#audioSound').checked = prefs.sound;
  await openDialog($('#dlgAudio'));
  if (previewNode) { try { previewNode.stop(); } catch { /* 무시 */ } previewNode = null; }
};
$('#audioSound').onchange = (e) => { prefs.sound = e.target.checked; savePrefs(); };
$('#audioAddFile').onclick = () => $('#fileAudio').click();
$('#fileAudio').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  await addClip(file, file.name.replace(/\.[^.]+$/, '').slice(0, 30), cur);
});

let recorder = null, recording = false;
$('#audioRecord').onclick = async () => {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
    toast('이 브라우저는 녹음을 지원하지 않아요'); return;
  }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { toast('마이크를 쓸 수 없어요. 마이크 권한을 허용해 주세요', 3500); return; }
  $('#dlgAudio').close();
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
  const chunks = [];
  const startFrame = cur;
  rec.ondataavailable = (ev) => { if (ev.data.size) chunks.push(ev.data); };
  rec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
    if (blob.size < 500) { toast('녹음된 소리가 없어요'); return; }
    const n = project.audio.filter((c) => c.rec).length + 1;
    await addClip(blob, '녹음 ' + n, startFrame, true);
  };
  recorder = rec;
  recording = true;
  rec.start();
  $('#btnPlay').classList.add('rec');
  startPlay();
  toast('녹음 중이에요. ■ 버튼을 누르면 끝나요', 3500);
};
function finishRecording() {
  recording = false;
  $('#btnPlay').classList.remove('rec');
  if (recorder && recorder.state !== 'inactive') recorder.stop();
  recorder = null;
}

async function mixAudio() {
  if (!project.audio || !project.audio.length) return null;
  await ensureAudioBuffers();
  const [, total] = computeStarts();
  const rate = 48000;
  const len = Math.ceil(total * rate);
  if (len <= 0) return null;
  const oac = new OfflineAudioContext(2, len, rate);
  let any = false;
  for (const clip of project.audio) {
    const buf = audioBuffers.get(clip.id);
    if (!buf) continue;
    const st = frameStartTime(clip.start);
    if (st >= total) continue;
    const src = oac.createBufferSource();
    src.buffer = buf;
    const g = oac.createGain();
    g.gain.value = clip.volume;
    src.connect(g).connect(oac.destination);
    src.start(st);
    any = true;
  }
  return any ? oac.startRendering() : null;
}

// =====================================================================
// 재생
// =====================================================================
let playing = false, playIdx = 0, playRaf = 0, playT0 = 0, playStarts = [], playTotal = 1;
function togglePlay() { playing ? stopPlay() : startPlay(); }
async function startPlay() {
  if (stroke || !project || playing) return;
  commitFloat();
  commitActive();
  [playStarts, playTotal] = computeStarts();
  playing = true;
  playIdx = cur;
  playT0 = performance.now() - playStarts[cur] * 1000;
  $('#btnPlay').classList.add('on');
  setPlayLabel(true);
  highlightPlay();
  requestRender();
  playRaf = requestAnimationFrame(playTick);
  if (prefs.sound && project.audio && project.audio.length) {
    getAC();
    await ensureAudioBuffers();
    if (playing) scheduleAudio(((performance.now() - playT0) / 1000) % playTotal, playTotal);
  }
}
function playTick(now) {
  if (!playing) return;
  let t = (now - playT0) / 1000;
  if (t >= playTotal) {
    const loops = Math.floor(t / playTotal);
    playT0 += loops * playTotal * 1000;
    t -= loops * playTotal;
    if (prefs.sound) scheduleAudio(t, playTotal);
  }
  const idx = frameAtTime(playStarts, t);
  if (idx !== playIdx) { playIdx = idx; highlightPlay(); render(); }
  playRaf = requestAnimationFrame(playTick);
}
function highlightPlay() {
  framesEl.querySelectorAll('.frame').forEach((el, i) => el.classList.toggle('playing', playing && i === playIdx));
  if (playing) {
    const el = framesEl.querySelectorAll('.frame')[playIdx];
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}
function stopPlay() {
  if (!playing) return;
  playing = false;
  cancelAnimationFrame(playRaf);
  stopAudio();
  if (recording) finishRecording();
  $('#btnPlay').classList.remove('on');
  setPlayLabel(false);
  highlightPlay();
  requestRender();
}
function setPlayLabel(on) {
  $('#btnPlay').innerHTML = on ? '■<small>멈춤</small>' : '▶<small>재생</small>';
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
    audio: (project.audio || []).map((c) => ({ ...c })),
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
  if (float) { scheduleSave(); return; } // 선택 영역을 옮기는 중에는 확정 후 저장
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
function flushAndSave() {
  if (!project) return;
  if (playing) stopPlay();
  if (stroke) { if (stroke.kind) cancelStroke(); else endStroke(); }
  commitFloat();
  saveNow();
}
document.addEventListener('visibilitychange', () => { if (document.hidden) flushAndSave(); });
window.addEventListener('pagehide', flushAndSave);

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
  $('#fpsNum').textContent = project.fps;
}

// =====================================================================
// 도구 UI
// =====================================================================
function setTool(t) {
  if (float && t !== 'select' && t !== 'text') commitFloat();
  prefs.tool = t;
  savePrefs();
  document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  syncSliders();
  updateSelBar();
  requestRender();
}
function syncSliders() {
  const k = toolKey();
  $('#sizeRange').value = prefs.size[k];
  showSizeDot();
}
function showSizeDot() {
  const v = prefs.size[toolKey()];
  $('#sizeVal').textContent = '굵기 ' + v;
  const d = clamp(Math.round(Math.sqrt(v) * 2.6), 3, 34);
  const dot = $('#sizeDot');
  dot.style.width = d + 'px'; dot.style.height = d + 'px';
  dot.style.background = prefs.tool === 'eraser' ? '#fff' : prefs.color;
}
document.querySelectorAll('.tool[data-tool]').forEach((b) => {
  b.addEventListener('click', () => {
    if (prefs.tool === b.dataset.tool) toggleToolPanel();
    else { setTool(b.dataset.tool); closeToolPanel(); }
  });
});
$('#sizeRange').addEventListener('input', (e) => {
  prefs.size[toolKey()] = +e.target.value;
  showSizeDot();
  savePrefs();
  const r = view.getBoundingClientRect();
  hover = hover || toDoc({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
  requestRender();
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
  const opacitySlider = (key) => slider('진하기', 5, 100, prefs.opacity[key], (v) => { prefs.opacity[key] = v; });
  if (t === 'brush') {
    h('붓 종류');
    const types = [['pen', '✒️ 펜'], ['pencil', '✏️ 연필'], ['marker', '🖍 마커'], ['airbrush', '💨 스프레이']];
    opts(...types.map(([k, n]) => opt(n, prefs.brushType === k, () => { prefs.brushType = k; savePrefs(); })));
    opacitySlider('brush');
    slider('손떨림 줄이기', 0, 90, prefs.smooth, (v) => { prefs.smooth = v; });
  } else if (t === 'eraser') {
    h('지우개');
    opacitySlider('eraser');
    const p = document.createElement('p');
    p.style.cssText = 'font-size:13px;color:#9aa3b5;margin:0';
    p.textContent = '굵기는 왼쪽 막대로 바꿔요. S펜 버튼을 누른 채 그려도 지워져요.';
    toolPanel.append(p);
  } else if (t === 'fill') {
    h('채우기');
    opts(opt('선 안쪽 채우기', prefs.fillAll, () => { prefs.fillAll = true; savePrefs(); }),
      opt('이 레이어만 보고 채우기', !prefs.fillAll, () => { prefs.fillAll = false; savePrefs(); }));
    slider('비슷한 색까지', 0, 160, prefs.fillTol, (v) => { prefs.fillTol = v; });
  } else if (t === 'shape') {
    h('도형');
    opts(...[['line', '╱ 직선'], ['rect', '▭ 네모'], ['ellipse', '◯ 동그라미']].map(([k, n]) =>
      opt(n, prefs.shapeType === k, () => { prefs.shapeType = k; savePrefs(); updateShapeIcon(); })));
    opts(opt('선만', !prefs.shapeFill, () => { prefs.shapeFill = false; savePrefs(); }),
      opt('속 채우기', prefs.shapeFill, () => { prefs.shapeFill = true; savePrefs(); }));
    opacitySlider('shape');
  } else if (t === 'select') {
    h('선택 방식');
    opts(opt('자유 선택(올가미)', prefs.selectMode !== 'rect', () => { prefs.selectMode = 'lasso'; savePrefs(); updateSelBar(); }),
      opt('사각형 선택', prefs.selectMode === 'rect', () => { prefs.selectMode = 'rect'; savePrefs(); updateSelBar(); }));
    const p = document.createElement('p');
    p.style.cssText = 'font-size:13px;color:#9aa3b5;margin:0';
    p.textContent = '선택한 뒤 안쪽을 끌면 이동, 모서리 네모로 크기, 위쪽 주황 동그라미로 회전해요.';
    toolPanel.append(p);
  } else if (t === 'text') {
    h('텍스트');
    const p = document.createElement('p');
    p.style.cssText = 'font-size:13px;color:#9aa3b5;margin:0';
    p.textContent = '글자를 넣을 위치를 누르세요. 색은 현재 색을 써요.';
    toolPanel.append(p);
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
  $('.tool[data-tool="shape"] .ico').textContent = { line: '╱', rect: '▭', ellipse: '◯' }[prefs.shapeType];
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
  showSizeDot();
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
longPress($('#btnOnion'), () => {
  prefs.onion = !prefs.onion; savePrefs(); updateToggles(); rebuildOnion(); requestRender();
  toast(prefs.onion ? '겹쳐보기 켬: 앞 장면은 빨강, 뒤 장면은 초록으로 보여요' : '겹쳐보기 끔', 1800);
}, openOnionDialog);
const moreMenu = $('#moreMenu');
function closeMenus() { moreMenu.hidden = true; closeToolPanel(); }
$('#btnMore').onclick = () => { const open = moreMenu.hidden; closeMenus(); moreMenu.hidden = !open; updateInfo(); };
$('#btnGrid').onclick = () => { prefs.grid = !prefs.grid; savePrefs(); updateToggles(); requestRender(); };
$('#btnOnionSet').onclick = () => { moreMenu.hidden = true; openOnionDialog(); };
$('#btnPenOnly').onclick = () => {
  prefs.penOnly = !prefs.penOnly; savePrefs(); updateToggles();
  toast(prefs.penOnly ? '펜으로만 그려요. 손가락은 움직이기·확대만 해요' : '손가락으로도 그릴 수 있어요');
};
$('#btnLayers').onclick = () => { prefs.layersOpen = !prefs.layersOpen; savePrefs(); updateToggles(); };
$('#layersClose').onclick = () => { prefs.layersOpen = false; savePrefs(); updateToggles(); };
$('#btnFit').onclick = () => { moreMenu.hidden = true; fitView(); };
$('#btnFullscreen').onclick = () => {
  moreMenu.hidden = true;
  if (document.fullscreenElement) document.exitFullscreen();
  else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => toast('전체 화면을 쓸 수 없어요'));
};
$('#btnHelp').onclick = () => { moreMenu.hidden = true; openDialog($('#dlgHelp')); };
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
// 빠르기(FPS) — 초등학생도 이해할 수 있는 설명과 함께 고르기
// =====================================================================
const FPS_INFO = [
  [4, '아주 느리게', '그림책을 한 장씩 넘기는 느낌'],
  [6, '느리게', '뚝뚝 끊기는 재미있는 움직임'],
  [8, '조금 느리게', '처음 해 보기 좋아요'],
  [12, '추천', '손그림 애니메이션의 기본 빠르기'],
  [24, '부드럽게', '만화영화처럼 부드러워요 · 그림이 많이 필요해요'],
  [30, '아주 부드럽게', '동영상처럼 매끄러워요 · 그림이 아주 많이 필요해요'],
];
function renderFpsCards(box, current, onPick) {
  box.textContent = '';
  for (const [n, title, desc] of FPS_INFO) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fps-card' + (n === current ? ' on' : '') + (n === 12 ? ' rec' : '');
    b.dataset.fps = n;
    b.innerHTML = `<span class="n">${n}</span><span class="t">${title}</span><span class="d">${desc}</span>`;
    b.onclick = () => {
      box.querySelectorAll('.fps-card').forEach((x) => x.classList.toggle('on', x === b));
      onPick(n);
    };
    box.append(b);
  }
}
function fpsCalcText(fps) {
  const ticks = frames().reduce((a, f) => a + f.hold, 0);
  return `지금 작품은 장면 ${frames().length}개 → ${fps} FPS로 재생하면 약 ${(ticks / fps).toFixed(1)}초예요. 1초를 채우려면 그림 ${fps}장이 필요해요.`;
}
$('#btnFps').onclick = async () => {
  if (playing) stopPlay();
  const input = $('#fpsInput');
  input.value = project.fps;
  const upd = (v) => { input.value = v; $('#fpsCalc').textContent = fpsCalcText(v); };
  renderFpsCards($('#fpsPresets'), project.fps, upd);
  input.oninput = () => {
    const v = clamp(Math.round(+input.value || 1), 1, 60);
    $('#fpsPresets').querySelectorAll('.fps-card').forEach((x) => x.classList.toggle('on', +x.dataset.fps === v));
    $('#fpsCalc').textContent = fpsCalcText(v);
  };
  upd(project.fps);
  if ((await openDialog($('#dlgFps'))) === 'ok') {
    const v = clamp(Math.round(+input.value || 12), 1, 60);
    project.fps = v;
    updateInfo();
    rebuildTimeline();
    scheduleSave();
    toast(`빠르기를 ${v} FPS로 바꿨어요`);
  }
};

// =====================================================================
// 새 작품 / 작품 설정 대화상자 (가로 HD · 세로 HD)
// =====================================================================
const ORIENTS = { land: [1280, 720], port: [720, 1280] };
async function projectDialog(mode) {
  const editing = mode === 'edit';
  $('#dlgProjectTitle').textContent = editing ? '작품 설정' : '새 작품';
  $('#pOk').textContent = editing ? '바꾸기' : '만들기';
  let size = editing ? [project.width, project.height] : ORIENTS.land;
  let fps = editing ? project.fps : 12;
  $('#pName').value = editing ? project.name : '새 애니메이션';
  $('#pBg').value = editing ? project.bg : '#ffffff';
  const btns = [...document.querySelectorAll('.orient-btn')];
  const sync = () => {
    btns.forEach((b) => b.classList.toggle('on', +b.dataset.w === size[0] && +b.dataset.h === size[1]));
    const changed = editing && (size[0] !== project.width || size[1] !== project.height);
    $('#resizeModeRow').hidden = !changed;
    const known = btns.some((b) => +b.dataset.w === size[0] && +b.dataset.h === size[1]);
    $('#pCurSize').textContent = editing && !known ? `지금 크기: ${size[0]}×${size[1]}` : '';
  };
  btns.forEach((b) => { b.onclick = () => { size = [+b.dataset.w, +b.dataset.h]; sync(); }; });
  renderFpsCards($('#pFpsList'), fps, (v) => { fps = v; });
  sync();
  if ((await openDialog($('#dlgProject'))) !== 'ok') return null;
  return {
    name: $('#pName').value.trim() || '새 애니메이션',
    width: size[0], height: size[1], fps,
    bg: $('#pBg').value,
    mode: (document.querySelector('input[name=rmode]:checked') || {}).value || 'fit',
  };
}

$('#btnSettings').onclick = async () => {
  moreMenu.hidden = true;
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
    if (project.audio && project.audio.length) txt += ` · 소리 ${project.audio.length}개 포함`;
  }
  if (fmt === 'gif' && ew * eh > 1280 * 720) txt += ' · GIF는 크기가 크면 오래 걸려요(0.5배 추천)';
  $('#exInfo').textContent = txt;
  $('#exTransparent').parentElement.hidden = !(fmt === 'png' || fmt === 'frame');
}
$('#formExport').addEventListener('change', exportInfo);

$('#btnExport').onclick = async () => {
  if (playing) stopPlay();
  commitFloat();
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
  let audio = null;
  if (fmt === 'mp4') {
    try { audio = await mixAudio(); } catch (e) { console.warn(e); toast('소리를 섞지 못해서 소리 없이 만들어요', 3000); }
  }
  const opts = { width: ew, height: eh, fps: project.fps, frames: fs, drawFrame: draw, onProgress, signal: exportAbort.signal, audio };
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
  if (blob.note) toast(blob.note, 4000);
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
    commitFloat();
    await saveNow();
  }
  float = null;
  $('#selBar').hidden = true;
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
    layers: [L], frames: [newFrame()], created: Date.now(), audio: [],
  };
  audioBlobs.clear(); audioBuffers.clear();
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
    const { meta, cels, audio } = await store.loadProject(pid);
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
    p.audio = meta.audio || [];
    audioBlobs.clear(); audioBuffers.clear();
    for (const rec of audio || []) audioBlobs.set(rec.cid, rec.blob);
    p.audio = p.audio.filter((c) => audioBlobs.has(c.id));
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
  setPlayLabel(false);
  updateToggles();
  updateSelBar();
  syncSliders();
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
