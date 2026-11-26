// MP4(H.264) 내보내기: WebCodecs VideoEncoder로 인코딩하고 직접 MP4 컨테이너를 만든다.
// WebCodecs를 쓸 수 없으면 MediaRecorder(실시간 녹화)로 대체한다.

export function webCodecsAvailable() {
  return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined' && window.isSecureContext;
}

export function recorderAvailable() {
  return typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
}

// ---------- MP4 박스 작성 ----------
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >>> 8) & 255, n & 255];
const str = (s) => Array.from(s, (c) => c.charCodeAt(0));
const zeros = (n) => new Array(n).fill(0);

function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function box(type, ...parts) {
  const body = concat(parts.map((p) => (p instanceof Uint8Array ? p : new Uint8Array(p))));
  return concat([new Uint8Array([...u32(body.length + 8), ...str(type)]), body]);
}
function full(type, version, flags, ...parts) {
  return box(type, [version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255], ...parts);
}
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].flatMap(u32);

function buildMoov({ width, height, timescale, samples, avcC, chunkOffset }) {
  const total = samples.reduce((a, s) => a + s.duration, 0);
  const movieTs = 1000;
  const movieDur = Math.round((total * movieTs) / timescale);

  const runs = [];
  for (const s of samples) {
    const last = runs[runs.length - 1];
    if (last && last[1] === s.duration) last[0]++;
    else runs.push([1, s.duration]);
  }
  const keys = [];
  samples.forEach((s, i) => { if (s.key) keys.push(i + 1); });

  const stts = full('stts', 0, 0, u32(runs.length), runs.flatMap((r) => [...u32(r[0]), ...u32(r[1])]));
  const stss = full('stss', 0, 0, u32(keys.length), keys.flatMap(u32));
  const stsc = full('stsc', 0, 0, u32(1), u32(1), u32(samples.length), u32(1));
  const stsz = full('stsz', 0, 0, u32(0), u32(samples.length), samples.flatMap((s) => u32(s.data.length)));
  const stco = full('stco', 0, 0, u32(1), u32(chunkOffset));
  const avc1 = box('avc1',
    zeros(6), u16(1), u16(0), u16(0), zeros(12),
    u16(width), u16(height), u32(0x480000), u32(0x480000), u32(0), u16(1),
    zeros(32), u16(0x18), u16(0xffff),
    box('avcC', avcC));
  const stsd = full('stsd', 0, 0, u32(1), avc1);
  const stbl = box('stbl', stsd, stts, stss, stsc, stsz, stco);
  const vmhd = full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0));
  const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
  const minf = box('minf', vmhd, dinf, stbl);
  const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(total), u16(0x55c4), u16(0));
  const hdlr = full('hdlr', 0, 0, u32(0), str('vide'), u32(0), u32(0), u32(0), str('VideoHandler'), [0]);
  const mdia = box('mdia', mdhd, hdlr, minf);
  const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(movieDur), u32(0), u32(0),
    u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width * 65536), u32(height * 65536));
  const trak = box('trak', tkhd, mdia);
  const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(movieTs), u32(movieDur), u32(0x10000), u16(0x100),
    u16(0), u32(0), u32(0), MATRIX, zeros(24), u32(2));
  return box('moov', mvhd, trak);
}

// moov를 앞에 두는 faststart 형태로 만든다(SNS 업로드·스트리밍에 유리).
export function muxMP4({ width, height, timescale, samples, avcC }) {
  const ftyp = box('ftyp', str('isom'), u32(512), str('isom'), str('iso2'), str('avc1'), str('mp41'));
  const dataLen = samples.reduce((a, s) => a + s.data.length, 0);
  const probe = buildMoov({ width, height, timescale, samples, avcC, chunkOffset: 0 });
  const chunkOffset = ftyp.length + probe.length + 8;
  const moov = buildMoov({ width, height, timescale, samples, avcC, chunkOffset });
  const mdatHeader = new Uint8Array([...u32(dataLen + 8), ...str('mdat')]);
  return new Blob([ftyp, moov, mdatHeader, ...samples.map((s) => s.data)], { type: 'video/mp4' });
}

// ---------- 인코딩 ----------
function levelFor(width, height, fps) {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const rate = mbs * fps;
  const levels = [['1F', 3600, 108000], ['20', 5120, 216000], ['28', 8192, 245760], ['2A', 8704, 522240], ['32', 22080, 589824], ['33', 36864, 983040], ['34', 36864, 2073600]];
  for (const [hex, maxFs, maxRate] of levels) if (mbs <= maxFs && rate <= maxRate) return hex;
  return '34';
}

function codecCandidates(width, height, fps) {
  const L = levelFor(width, height, fps);
  const list = [`avc1.42E0${L}`, `avc1.4D40${L}`, `avc1.6400${L}`, 'avc1.42E033', 'avc1.4D4033', 'avc1.640033', 'avc1.640034'];
  return [...new Set(list)];
}

const toU8 = (d) => (ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findConfig(width, height, fps, bitrate) {
  for (const codec of codecCandidates(width, height, fps)) {
    for (const hw of ['prefer-hardware', 'no-preference', 'prefer-software']) {
      const c = { codec, width, height, bitrate, framerate: fps, avc: { format: 'avc' }, hardwareAcceleration: hw };
      try {
        const s = await VideoEncoder.isConfigSupported(c);
        if (s.supported) return c;
      } catch { /* 다음 후보 */ }
    }
  }
  return null;
}

// frames: [{hold}], drawFrame(ctx, i) 가 캔버스에 i번째 프레임을 그린다.
export async function encodeMP4({ width, height, fps, frames, drawFrame, onProgress, signal }) {
  const bitrate = Math.round(Math.min(25e6, Math.max(1.5e6, width * height * fps * 0.18)));
  const config = await findConfig(width, height, fps, bitrate);
  if (!config) throw new Error('이 기기에서 H.264 인코더를 찾지 못했어요');

  const timescale = fps * 100;
  const samples = [];
  let avcC = null;
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (!avcC && meta && meta.decoderConfig && meta.decoderConfig.description) avcC = toU8(meta.decoderConfig.description).slice();
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, key: chunk.type === 'key', ts: chunk.timestamp });
    },
    error: (e) => { failure = e; },
  });
  encoder.configure(config);

  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  const durations = [];
  let t = 0;
  const keyEvery = Math.max(1, fps * 2);
  try {
    for (let i = 0; i < frames.length; i++) {
      if (signal && signal.aborted) throw new Error('취소했어요');
      drawFrame(ctx, i);
      const dur = Math.max(1, frames[i].hold) * 100;
      const vf = new VideoFrame(canvas, {
        timestamp: Math.round((t * 1e6) / timescale),
        duration: Math.round((dur * 1e6) / timescale),
      });
      encoder.encode(vf, { keyFrame: i % keyEvery === 0 });
      vf.close();
      durations.push(dur);
      t += dur;
      while (encoder.encodeQueueSize > 3) await sleep(4);
      if (failure) throw failure;
      if (onProgress) onProgress((i + 1) / frames.length);
      if (i % 4 === 3) await sleep(0);
    }
    await encoder.flush();
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
  if (failure) throw failure;
  if (!avcC) throw new Error('인코더가 코덱 정보를 주지 않았어요');
  if (!samples.length) throw new Error('인코딩된 프레임이 없어요');
  samples.sort((a, b) => a.ts - b.ts);
  samples.forEach((s, i) => { s.duration = durations[i] || 100; });
  if (!samples[0].key) samples[0].key = true;
  return muxMP4({ width, height, timescale, samples, avcC });
}

// 대체 방식: 캔버스를 실시간으로 녹화한다(애니메이션 길이만큼 시간이 걸림).
export async function recordVideo({ width, height, fps, frames, drawFrame, onProgress, signal }) {
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mime = types.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mime) throw new Error('이 브라우저는 영상 녹화를 지원하지 않아요');
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  drawFrame(ctx, 0);
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.min(20e6, width * height * fps * 0.2) });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start(250);
  for (let i = 0; i < frames.length; i++) {
    if (signal && signal.aborted) break;
    drawFrame(ctx, i);
    if (track.requestFrame) track.requestFrame();
    if (onProgress) onProgress((i + 1) / frames.length);
    await sleep((Math.max(1, frames[i].hold) * 1000) / fps);
  }
  rec.stop();
  await stopped;
  track.stop();
  return new Blob(chunks, { type: mime.split(';')[0] });
}
