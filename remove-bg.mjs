// PNG background remover — Node.js built-ins only
// Converts RGB PNG to RGBA PNG with white background removed via flood fill

import { readFileSync, writeFileSync } from 'fs';
import { inflateSync, deflateSync } from 'zlib';
import { createHash } from 'crypto';

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u32(n) {
  const b = Buffer.alloc(4); b.writeUInt32BE(n); return b;
}

function makeChunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([t, data]));
  return Buffer.concat([u32(data.length), t, data, u32(crc)]);
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function unfilter(rows, w, bpp) {
  const out = rows.map(r => r.slice(1)); // strip filter byte
  for (let y = 0; y < rows.length; y++) {
    const f = rows[y][0];
    const row = out[y];
    const prev = y > 0 ? out[y - 1] : null;
    for (let x = 0; x < w * bpp; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
      if (f === 1) row[x] = (row[x] + a) & 0xFF;
      else if (f === 2) row[x] = (row[x] + b) & 0xFF;
      else if (f === 3) row[x] = (row[x] + Math.floor((a + b) / 2)) & 0xFF;
      else if (f === 4) row[x] = (row[x] + paethPredictor(a, b, c)) & 0xFF;
    }
  }
  return out;
}

function process(inputPath, outputPath) {
  const buf = readFileSync(inputPath);

  // Parse chunks
  let off = 8;
  const chunks = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off+4, off+8).toString('ascii');
    const data = buf.slice(off+8, off+8+len);
    chunks.push({ type, data });
    off += 12 + len;
    if (type === 'IEND') break;
  }

  const ihdrData = chunks.find(c => c.type === 'IHDR').data;
  const W = ihdrData.readUInt32BE(0);
  const H = ihdrData.readUInt32BE(4);
  const bitDepth = ihdrData[8];
  const colorType = ihdrData[9]; // 2=RGB
  console.log(`${W}x${H} depth=${bitDepth} colorType=${colorType}`);

  // Decompress IDAT
  const compressed = Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data));
  const raw = inflateSync(compressed);

  const bpp = 3; // RGB
  const stride = 1 + W * bpp;

  // Split into rows
  const rawRows = [];
  for (let y = 0; y < H; y++) rawRows.push(raw.slice(y * stride, y * stride + stride));

  // Unfilter
  const rows = unfilter(rawRows, W, bpp);

  // Build RGBA pixel array
  const pixels = Buffer.alloc(W * H * 4, 255);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const si = x * 3;
      const di = (y * W + x) * 4;
      pixels[di]   = rows[y][si];
      pixels[di+1] = rows[y][si+1];
      pixels[di+2] = rows[y][si+2];
      pixels[di+3] = 255;
    }
  }

  // Flood fill white background from edges (threshold 238)
  const visited = Buffer.alloc(W * H, 0);
  const queue = [];
  const enqueue = (y, x) => {
    const i = y * W + x;
    if (visited[i]) return;
    const pi = i * 4;
    if (pixels[pi] >= 238 && pixels[pi+1] >= 238 && pixels[pi+2] >= 238) {
      visited[i] = 1; queue.push(i);
    }
  };
  for (let x = 0; x < W; x++) { enqueue(0, x); enqueue(H-1, x); }
  for (let y = 0; y < H; y++) { enqueue(y, 0); enqueue(y, W-1); }

  while (queue.length) {
    const i = queue.pop();
    pixels[i*4+3] = 0;
    const x = i % W, y = Math.floor(i / W);
    if (y > 0)   enqueue(y-1, x);
    if (y < H-1) enqueue(y+1, x);
    if (x > 0)   enqueue(y, x-1);
    if (x < W-1) enqueue(y, x+1);
    // Expand with slightly lower threshold for anti-alias
    const checkNeighbor = (ny, nx) => {
      if (ny<0||ny>=H||nx<0||nx>=W) return;
      const ni = ny*W+nx;
      if (visited[ni]) return;
      const pi = ni*4;
      if (pixels[pi]>=230 && pixels[pi+1]>=230 && pixels[pi+2]>=230) {
        visited[ni]=1; queue.push(ni);
      }
    };
    checkNeighbor(y-1,x); checkNeighbor(y+1,x);
    checkNeighbor(y,x-1); checkNeighbor(y,x+1);
  }

  // 2nd pass: remaining isolated bright whites
  for (let i = 0; i < W * H; i++) {
    const pi = i * 4;
    if (pixels[pi]>=245 && pixels[pi+1]>=245 && pixels[pi+2]>=245 && pixels[pi+3]>0) {
      pixels[pi+3] = 0;
    }
  }

  // Re-encode as RGBA PNG (filter type 0 = None for each row)
  const bpp4 = 4;
  const rawOut = Buffer.alloc(H * (1 + W * bpp4));
  for (let y = 0; y < H; y++) {
    rawOut[y * (1 + W * bpp4)] = 0; // filter None
    for (let x = 0; x < W; x++) {
      const si = (y * W + x) * 4;
      const di = y * (1 + W * bpp4) + 1 + x * 4;
      rawOut[di]   = pixels[si];
      rawOut[di+1] = pixels[si+1];
      rawOut[di+2] = pixels[si+2];
      rawOut[di+3] = pixels[si+3];
    }
  }

  const compressed2 = deflateSync(rawOut, { level: 6 });

  // Build IHDR for RGBA
  const newIhdr = Buffer.alloc(13);
  newIhdr.writeUInt32BE(W, 0);
  newIhdr.writeUInt32BE(H, 4);
  newIhdr[8] = 8;  // bit depth
  newIhdr[9] = 6;  // color type RGBA
  newIhdr[10] = 0; newIhdr[11] = 0; newIhdr[12] = 0;

  const pngSig = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  const out = Buffer.concat([
    pngSig,
    makeChunk('IHDR', newIhdr),
    makeChunk('IDAT', compressed2),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);

  writeFileSync(outputPath, out);
  console.log(`Saved: ${outputPath} (${Math.round(out.length/1024)}KB)`);
}

const base = 'C:/Users/yvesd/OneDrive/Documents/KUNDA/Claude-Cowork/TRIBU-M EVENTS/tribu-m/assets/';
process(base + 'masque.png', base + 'masque-clean.png');
process(base + 'masque-v2.png', base + 'masque-v2.png');
