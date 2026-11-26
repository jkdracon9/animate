// 애니메이션 GIF 인코더 (프레임별 256색 팔레트 + LZW 압축)

class ByteWriter {
  constructor() { this.chunks = []; this.buf = new Uint8Array(1 << 16); this.pos = 0; }
  byte(b) { if (this.pos === this.buf.length) this.flush(); this.buf[this.pos++] = b; }
  bytes(arr) { for (let i = 0; i < arr.length; i++) this.byte(arr[i]); }
  u16(n) { this.byte(n & 255); this.byte((n >> 8) & 255); }
  str(s) { for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i)); }
  flush() { if (this.pos) { this.chunks.push(this.buf.slice(0, this.pos)); this.pos = 0; } }
  blob(type) { this.flush(); return new Blob(this.chunks, { type }); }
}

// 15비트 색 버킷 중 많이 쓰인 256색을 팔레트로 쓴다.
function quantize(px) {
  const n = px.length >> 2;
  const counts = new Uint32Array(32768);
  const sr = new Float64Array(32768), sg = new Float64Array(32768), sb = new Float64Array(32768);
  const keys = new Uint16Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = px[p], g = px[p + 1], b = px[p + 2];
    const k = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    keys[i] = k; counts[k]++; sr[k] += r; sg[k] += g; sb[k] += b;
  }
  const used = [];
  for (let k = 0; k < 32768; k++) if (counts[k]) used.push(k);
  used.sort((a, b) => counts[b] - counts[a]);
  const top = used.slice(0, 256);
  const palette = new Uint8Array(768);
  const pr = new Int32Array(top.length), pg = new Int32Array(top.length), pb = new Int32Array(top.length);
  const lut = new Int16Array(32768).fill(-1);
  top.forEach((k, j) => {
    const c = counts[k];
    pr[j] = Math.round(sr[k] / c); pg[j] = Math.round(sg[k] / c); pb[j] = Math.round(sb[k] / c);
    palette[j * 3] = pr[j]; palette[j * 3 + 1] = pg[j]; palette[j * 3 + 2] = pb[j];
    lut[k] = j;
  });
  const idx = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const k = keys[i];
    let j = lut[k];
    if (j < 0) {
      const r = ((k >> 10) << 3) | 4, g = (((k >> 5) & 31) << 3) | 4, b = ((k & 31) << 3) | 4;
      let best = Infinity;
      for (let m = 0; m < top.length; m++) {
        const dr = r - pr[m], dg = g - pg[m], db = b - pb[m];
        const d = dr * dr * 3 + dg * dg * 4 + db * db * 2;
        if (d < best) { best = d; j = m; }
      }
      lut[k] = j;
    }
    idx[i] = j;
  }
  return { palette, idx };
}

function lzw(out, idx, minCode) {
  out.byte(minCode);
  const clear = 1 << minCode, eoi = clear + 1;
  let next = eoi + 1, size = minCode + 1;
  let table = new Map();
  let cur = 0, bits = 0;
  const block = new Uint8Array(255);
  let bl = 0;
  const emitByte = (b) => {
    block[bl++] = b;
    if (bl === 255) { out.byte(255); out.bytes(block); bl = 0; }
  };
  const emit = (code) => {
    cur |= code << bits; bits += size;
    while (bits >= 8) { emitByte(cur & 255); cur >>>= 8; bits -= 8; }
  };
  emit(clear);
  let prefix = idx[0];
  for (let i = 1; i < idx.length; i++) {
    const k = idx[i];
    const key = (prefix << 8) | k;
    const v = table.get(key);
    if (v !== undefined) { prefix = v; continue; }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      next = eoi + 1; size = minCode + 1; table = new Map();
    } else {
      if (next >= (1 << size)) size++;
      table.set(key, next++);
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) emitByte(cur & 255);
  if (bl > 0) { out.byte(bl); out.bytes(block.subarray(0, bl)); }
  out.byte(0);
}

export async function encodeGIF({ width, height, fps, frames, drawFrame, onProgress, signal }) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const out = new ByteWriter();
  out.str('GIF89a'); out.u16(width); out.u16(height); out.byte(0); out.byte(0); out.byte(0);
  out.bytes([0x21, 0xff, 0x0b]); out.str('NETSCAPE2.0'); out.bytes([3, 1, 0, 0, 0]);
  let wanted = 0, written = 0;
  for (let i = 0; i < frames.length; i++) {
    if (signal && signal.aborted) throw new Error('취소했어요');
    drawFrame(ctx, i);
    const px = ctx.getImageData(0, 0, width, height).data;
    const { palette, idx } = quantize(px);
    wanted += (Math.max(1, frames[i].hold) * 100) / fps;
    const delay = Math.max(2, Math.round(wanted - written));
    written += delay;
    out.bytes([0x21, 0xf9, 4, 0x04, delay & 255, (delay >> 8) & 255, 0, 0]);
    out.byte(0x2c); out.u16(0); out.u16(0); out.u16(width); out.u16(height); out.byte(0x87);
    out.bytes(palette);
    lzw(out, idx, 8);
    if (onProgress) onProgress((i + 1) / frames.length);
    await new Promise((r) => setTimeout(r, 0));
  }
  out.byte(0x3b);
  return out.blob('image/gif');
}
