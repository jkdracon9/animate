// MP4 내보내기: WebCodecs(VideoEncoder/AudioEncoder)로 인코딩하고 직접 MP4 컨테이너를 만든다.
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

function avcEntry(width, height, avcC) {
  return box('avc1',
    zeros(6), u16(1), u16(0), u16(0), zeros(12),
    u16(width), u16(height), u32(0x480000), u32(0x480000), u32(0), u16(1),
    zeros(32), u16(0x18), u16(0xffff),
    box('avcC', avcC));
}

function audioEntryHeader(channels, rate) {
  return [...zeros(6), ...u16(1), ...zeros(8), ...u16(channels), ...u16(16), ...u16(0), ...u16(0), ...u32(rate * 65536)];
}
function aacEntry(channels, rate, asc) {
  const dsi = [0x05, asc.length, ...asc];
  const dcd = [0x40, 0x15, 0, 0, 0, ...u32(160000), ...u32(128000), ...dsi];
  const decCfg = [0x04, dcd.length, ...dcd];
  const es = [0x00, 0x02, 0x00, ...decCfg, 0x06, 0x01, 0x02];
  const esds = full('esds', 0, 0, [0x03, es.length, ...es]);
  return box('mp4a', audioEntryHeader(channels, rate), esds);
}
function opusEntry(channels, rate, preSkip) {
  const dOps = box('dOps', [0, channels, ...u16(preSkip), ...u32(rate), ...u16(0), 0]);
  return box('Opus', audioEntryHeader(channels, 48000), dOps);
}

function buildTrak(track, trackId, chunkOffset, movieTs) {
  const { samples, timescale } = track;
  const total = samples.reduce((a, s) => a + s.duration, 0);
  const movieDur = Math.round((total * movieTs) / timescale);
  const isVideo = track.kind === 'video';

  const runs = [];
  for (const s of samples) {
    const last = runs[runs.length - 1];
    if (last && last[1] === s.duration) last[0]++;
    else runs.push([1, s.duration]);
  }
  const stts = full('stts', 0, 0, u32(runs.length), runs.flatMap((r) => [...u32(r[0]), ...u32(r[1])]));
  const stsc = full('stsc', 0, 0, u32(1), u32(1), u32(samples.length), u32(1));
  const stsz = full('stsz', 0, 0, u32(0), u32(samples.length), samples.flatMap((s) => u32(s.data.length)));
  const stco = full('stco', 0, 0, u32(1), u32(chunkOffset));
  const stsd = full('stsd', 0, 0, u32(1), track.entry);
  const parts = [stsd, stts];
  if (isVideo) {
    const keys = [];
    samples.forEach((s, i) => { if (s.key) keys.push(i + 1); });
    parts.push(full('stss', 0, 0, u32(keys.length), keys.flatMap(u32)));
  }
  parts.push(stsc, stsz, stco);
  const stbl = box('stbl', ...parts);
  const mhd = isVideo ? full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)) : full('smhd', 0, 0, u16(0), u16(0));
  const dinf = box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));
  const minf = box('minf', mhd, dinf, stbl);
  const mdhd = full('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(total), u16(0x55c4), u16(0));
  const hdlr = full('hdlr', 0, 0, u32(0), str(isVideo ? 'vide' : 'soun'), u32(0), u32(0), u32(0),
    str(isVideo ? 'VideoHandler' : 'SoundHandler'), [0]);
  const mdia = box('mdia', mdhd, hdlr, minf);
  const tkhd = full('tkhd', 0, 3, u32(0), u32(0), u32(trackId), u32(0), u32(movieDur), u32(0), u32(0),
    u16(0), u16(0), u16(isVideo ? 0 : 0x0100), u16(0), MATRIX,
    u32(isVideo ? track.width * 65536 : 0), u32(isVideo ? track.height * 65536 : 0));
  return { trak: box('trak', tkhd, mdia), movieDur };
}

function buildMoov(tracks, offsets) {
  const movieTs = 1000;
  const traks = tracks.map((t, i) => buildTrak(t, i + 1, offsets[i], movieTs));
  const movieDur = Math.max(...traks.map((t) => t.movieDur));
  const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(movieTs), u32(movieDur), u32(0x10000), u16(0x100),
    u16(0), u32(0), u32(0), MATRIX, zeros(24), u32(tracks.length + 1));
  return box('moov', mvhd, ...traks.map((t) => t.trak));
}

// tracks: [{kind, timescale, samples:[{data,duration,key}], entry, width?, height?}]
// moov를 앞에 두는 faststart 형태(SNS 업로드·스트리밍에 유리). 트랙마다 하나의 청크로 저장한다.
export function muxMP4(tracks) {
  const ftyp = box('ftyp', str('isom'), u32(512), str('isom'), str('iso2'), str('avc1'), str('mp41'));
  const sizes = tracks.map((t) => t.samples.reduce((a, s) => a + s.data.length, 0));
  const probe = buildMoov(tracks, tracks.map(() => 0));
  const offsets = [];
  let o = ftyp.length + probe.length + 8;
  for (const s of sizes) { offsets.push(o); o += s; }
  const moov = buildMoov(tracks, offsets);
  const dataLen = sizes.reduce((a, b) => a + b, 0);
  const mdatHeader = new Uint8Array([...u32(dataLen + 8), ...str('mdat')]);
  const blobs = [ftyp, moov, mdatHeader];
  for (const t of tracks) for (const s of t.samples) blobs.push(s.data);
  return new Blob(blobs, { type: 'video/mp4' });
}

// ---------- 영상 인코딩 ----------
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

async function findVideoConfig(width, height, fps, bitrate) {
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

// ---------- 소리 인코딩 (AAC 우선, 안 되면 Opus) ----------
async function encodeAudio(buffer, signal) {
  if (typeof AudioEncoder === 'undefined' || typeof AudioData === 'undefined') return null;
  const rate = buffer.sampleRate, ch = Math.min(2, buffer.numberOfChannels);
  const cands = [
    { type: 'aac', config: { codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: ch, bitrate: 160000 } },
    { type: 'opus', config: { codec: 'opus', sampleRate: rate, numberOfChannels: ch, bitrate: 128000 } },
  ];
  let pick = null;
  for (const c of cands) {
    try { if ((await AudioEncoder.isConfigSupported(c.config)).supported) { pick = c; break; } } catch { /* 다음 */ }
  }
  if (!pick) return null;
  const samples = [];
  let desc = null, failure = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      if (!desc && meta && meta.decoderConfig && meta.decoderConfig.description) desc = toU8(meta.decoderConfig.description).slice();
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({ data, ts: chunk.timestamp, dur: chunk.duration });
    },
    error: (e) => { failure = e; },
  });
  enc.configure(pick.config);
  const block = 4096;
  const chans = [];
  for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
  for (let off = 0; off < buffer.length; off += block) {
    if (signal && signal.aborted) { enc.close(); throw new Error('취소했어요'); }
    const n = Math.min(block, buffer.length - off);
    const data = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) data.set(chans[c].subarray(off, off + n), c * n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: rate, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round((off / rate) * 1e6), data });
    enc.encode(ad);
    ad.close();
    while (enc.encodeQueueSize > 8) await sleep(2);
    if (failure) throw failure;
  }
  await enc.flush();
  enc.close();
  if (failure) throw failure;
  if (!samples.length) return null;
  samples.sort((a, b) => a.ts - b.ts);
  const defDur = pick.type === 'aac' ? 1024 : 960;
  const outRate = pick.type === 'opus' ? 48000 : rate;
  const list = samples.map((s) => ({ data: s.data, duration: s.dur ? Math.max(1, Math.round((s.dur * outRate) / 1e6)) : defDur, key: true }));
  let entry;
  if (pick.type === 'aac') {
    const freqIdx = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].indexOf(rate);
    const asc = desc && desc.length >= 2 ? Array.from(desc) : [(2 << 3) | (Math.max(0, freqIdx) >> 1), ((Math.max(0, freqIdx) & 1) << 7) | (ch << 3)];
    entry = aacEntry(ch, rate, asc);
  } else {
    let preSkip = 312;
    if (desc && desc.length >= 12 && String.fromCharCode(...desc.slice(0, 8)) === 'OpusHead') preSkip = desc[10] | (desc[11] << 8);
    entry = opusEntry(ch, rate, preSkip);
  }
  return { kind: 'audio', timescale: outRate, samples: list, entry, codec: pick.type };
}

// frames: [{hold}], drawFrame(ctx, i) 가 캔버스에 i번째 프레임을 그린다. audio: AudioBuffer|null
export async function encodeMP4({ width, height, fps, frames, drawFrame, onProgress, signal, audio }) {
  const bitrate = Math.round(Math.min(25e6, Math.max(1.5e6, width * height * fps * 0.18)));
  const config = await findVideoConfig(width, height, fps, bitrate);
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
  const videoShare = audio ? 0.85 : 1;
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
      if (onProgress) onProgress(((i + 1) / frames.length) * videoShare);
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
  const tracks = [{ kind: 'video', timescale, samples, entry: avcEntry(width, height, avcC), width, height }];
  let audioNote = '';
  if (audio) {
    try {
      const a = await encodeAudio(audio, signal);
      if (a) tracks.push(a);
      else audioNote = '이 기기는 소리 인코딩을 지원하지 않아 소리 없이 만들었어요';
    } catch (e) {
      if (signal && signal.aborted) throw e;
      console.warn(e);
      audioNote = '소리를 넣지 못했어요: ' + e.message;
    }
  }
  if (onProgress) onProgress(1);
  const blob = muxMP4(tracks);
  blob.note = audioNote;
  return blob;
}

// 대체 방식: 캔버스를 실시간으로 녹화한다(애니메이션 길이만큼 시간이 걸림).
export async function recordVideo({ width, height, fps, frames, drawFrame, onProgress, signal, audio }) {
  const types = audio
    ? ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  const mime = types.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mime) throw new Error('이 브라우저는 영상 녹화를 지원하지 않아요');
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  drawFrame(ctx, 0);
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  let ac = null, src = null;
  if (audio) {
    ac = new AudioContext();
    const dest = ac.createMediaStreamDestination();
    src = ac.createBufferSource();
    src.buffer = audio;
    src.connect(dest);
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  }
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.min(20e6, width * height * fps * 0.2) });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const stopped = new Promise((r) => { rec.onstop = r; });
  rec.start(250);
  if (src) src.start();
  const t0 = performance.now();
  let elapsed = 0;
  for (let i = 0; i < frames.length; i++) {
    if (signal && signal.aborted) break;
    drawFrame(ctx, i);
    if (track.requestFrame) track.requestFrame();
    if (onProgress) onProgress((i + 1) / frames.length);
    elapsed += (Math.max(1, frames[i].hold) * 1000) / fps;
    await sleep(Math.max(0, t0 + elapsed - performance.now()));
  }
  rec.stop();
  await stopped;
  track.stop();
  if (src) { try { src.stop(); } catch { /* 이미 끝남 */ } }
  if (ac) ac.close();
  return new Blob(chunks, { type: mime.split(';')[0] });
}
