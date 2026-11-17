import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

const read = (p) => fs.readFileSync(p);
const mod = async (p) => WebAssembly.compile(read(p));

const jpegDec = (await import('@jsquash/jpeg/decode.js')).default;
const jpegEnc = (await import('@jsquash/jpeg/encode.js')).default;
const jpegInitDec = (await import('@jsquash/jpeg/decode.js')).init;
const jpegInitEnc = (await import('@jsquash/jpeg/encode.js')).init;
const pngDec = (await import('@jsquash/png/decode.js')).default;
const pngEnc = (await import('@jsquash/png/encode.js')).default;
const pngInitDec = (await import('@jsquash/png/decode.js')).init;
const pngInitEnc = (await import('@jsquash/png/encode.js')).init;
const webpEnc = (await import('@jsquash/webp/encode.js')).default;
const webpInitEnc = (await import('@jsquash/webp/encode.js')).init;

await jpegInitDec(await mod('node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm'));
await jpegInitEnc(await mod('node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm'));
await pngInitDec(await mod('node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm'));
await pngInitEnc(await mod('node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm'));
await webpInitEnc(await mod('node_modules/@jsquash/webp/codec/enc/webp_enc_simd.wasm'));

const mp = (w, h) => (w * h) / 1e6;
async function time(label, fn, iters = 3) {
  const ts = [];
  let out;
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    out = await fn();
    ts.push(performance.now() - t0);
  }
  ts.sort((a, b) => a - b);
  const med = ts[Math.floor(ts.length / 2)];
  console.log(`${label.padEnd(42)} median ${med.toFixed(0).padStart(5)} ms  (${ts.map(t=>t.toFixed(0)).join('/')} ms)`);
  return { med, out };
}

// JPEG 2000x1500 = 3 MP
const jpg = read('photo.jpg');
const { med: jdecMs, out: imgFromJpg } = await time('mozjpeg decode 3MP (2000x1500)', () => jpegDec(jpg));
const { med: jencMs } = await time('mozjpeg encode 3MP q75', () => jpegEnc(imgFromJpg, { quality: 75 }));
console.log(`   -> jpeg total ${(jdecMs + jencMs).toFixed(0)} ms, ${((jdecMs+jencMs)/3).toFixed(0)} ms/MP`);

// PNG 2000x1500
const png = read('shot.png');
const { med: pdecMs, out: imgFromPng } = await time('png decode 3MP (2000x1500)', () => pngDec(png));
const { med: pencMs, out: pngOut } = await time('png encode 3MP (default)', () => pngEnc(imgFromPng));
console.log(`   -> png total ${(pdecMs + pencMs).toFixed(0)} ms, ${((pdecMs+pencMs)/3).toFixed(0)} ms/MP, out ${(pngOut.byteLength/1024).toFixed(0)} KiB from ${(png.length/1024).toFixed(0)} KiB`);

const { med: wencMs } = await time('webp encode 3MP q75', () => webpEnc(imgFromJpg, { quality: 75 }));
console.log(`   -> webp ms/MP (enc only) ${(wencMs/3).toFixed(0)}`);
