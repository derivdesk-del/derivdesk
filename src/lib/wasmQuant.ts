/**
 * WebAssembly-accelerated Quantitative Compute Kernel
 *
 * Compiles a tiny deterministic WebAssembly binary (IEEE-754 f64 linear-memory kernel)
 * directly in memory via `WebAssembly.Module` / `WebAssembly.Instance` with automatic
 * JS fallback if WASM execution is disabled in a restricted environment.
 */

interface WasmQuantExports {
  mem: WebAssembly.Memory;
  sum_f64: (len: number) => number;
  sum_sq_diff_f64: (len: number, mean: number) => number;
  binomial_z: (count: number, n: number, p: number) => number;
}

/**
 * Hand-assembled WASM binary (181 bytes):
 *  - Type 0: (i32) -> f64            [sum_f64]
 *  - Type 1: (i32, f64) -> f64       [sum_sq_diff_f64]
 *  - Type 2: (f64, f64, f64) -> f64  [binomial_z]
 *  - Memory: 1 page (64 KiB, exported as "mem")
 *  - Exports: mem, sum_f64, sum_sq_diff_f64, binomial_z
 */
function buildWasmBinary(): Uint8Array {
  const bytes: number[] = [];
  const pushU32 = (v: number) => {
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v !== 0) b |= 0x80;
      bytes.push(b);
    } while (v !== 0);
  };
  const pushStr = (s: string) => {
    pushU32(s.length);
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
  };
  const pushSection = (id: number, body: number[]) => {
    bytes.push(id);
    pushU32(body.length);
    bytes.push(...body);
  };

  // Magic + Version 1
  bytes.push(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);

  // Type section (1): 3 function signatures
  pushSection(1, [
    0x03,
    // type 0: (i32) -> f64
    0x60, 0x01, 0x7f, 0x01, 0x7c,
    // type 1: (i32, f64) -> f64
    0x60, 0x02, 0x7f, 0x7c, 0x01, 0x7c,
    // type 2: (f64, f64, f64) -> f64
    0x60, 0x03, 0x7c, 0x7c, 0x7c, 0x01, 0x7c,
  ]);

  // Function section (3): func 0 -> type 0, func 1 -> type 1, func 2 -> type 2
  pushSection(3, [0x03, 0x00, 0x01, 0x02]);

  // Memory section (5): min 1 page
  pushSection(5, [0x01, 0x00, 0x01]);

  // Export section (7)
  const expBody: number[] = [0x04];
  const addExport = (name: string, kind: number, idx: number) => {
    expBody.push(name.length);
    for (let i = 0; i < name.length; i++) expBody.push(name.charCodeAt(i));
    expBody.push(kind, idx);
  };
  addExport('mem', 0x02, 0x00);
  addExport('sum_f64', 0x00, 0x00);
  addExport('sum_sq_diff_f64', 0x00, 0x01);
  addExport('binomial_z', 0x00, 0x02);
  pushSection(7, expBody);

  // Code section (10)
  // Helper: 0.0 in IEEE-754 f64 = 8 zero bytes
  const f64Zero = [0x44, 0, 0, 0, 0, 0, 0, 0, 0];
  // 1.0 in IEEE-754 f64 LE: 00 00 00 00 00 00 F0 3F
  const f64One = [0x44, 0, 0, 0, 0, 0, 0, 0xf0, 0x3f];

  // Func 0: sum_f64(len: local 0) -> f64
  // locals: i32 i (local 1), f64 acc (local 2)
  const func0 = [
    0x02, 0x01, 0x7f, 0x01, 0x7c,
    ...f64Zero, 0x21, 0x02, // acc = 0.0
    0x41, 0x00, 0x21, 0x01, // i = 0
    0x02, 0x40,             // block void
    0x03, 0x40,             // loop void
    0x20, 0x01, 0x20, 0x00, 0x4e, // i >= len
    0x0d, 0x01,             // br_if 1 (break)
    // acc = acc + f64.load(i << 3)
    0x20, 0x02,
    0x20, 0x01, 0x41, 0x03, 0x74, // (i << 3)
    0x2b, 0x03, 0x00,             // f64.load align=3 offset=0
    0xa0,                         // f64.add
    0x21, 0x02,                   // set acc
    // i = i + 1
    0x20, 0x01, 0x41, 0x01, 0x6a, 0x21, 0x01,
    0x0c, 0x00,             // br 0 (continue)
    0x0b,                   // end loop
    0x0b,                   // end block
    0x20, 0x02,             // return acc
    0x0b,                   // end func
  ];

  // Func 1: sum_sq_diff_f64(len: local 0, mean: local 1) -> f64
  // locals: i32 i (local 2), f64 acc (local 3), f64 diff (local 4)
  const func1 = [
    0x02, 0x01, 0x7f, 0x02, 0x7c,
    ...f64Zero, 0x21, 0x03, // acc = 0.0
    0x41, 0x00, 0x21, 0x02, // i = 0
    0x02, 0x40,             // block void
    0x03, 0x40,             // loop void
    0x20, 0x02, 0x20, 0x00, 0x4e, // i >= len
    0x0d, 0x01,             // br_if 1
    // diff = f64.load(i << 3) - mean
    0x20, 0x02, 0x41, 0x03, 0x74,
    0x2b, 0x03, 0x00,
    0x20, 0x01, 0xa1,       // f64.sub
    0x22, 0x04,             // tee diff
    0x20, 0x04, 0xa2,       // diff * diff
    0x20, 0x03, 0xa0,       // + acc
    0x21, 0x03,             // set acc
    // i = i + 1
    0x20, 0x02, 0x41, 0x01, 0x6a, 0x21, 0x02,
    0x0c, 0x00,
    0x0b,
    0x0b,
    0x20, 0x03,
    0x0b,
  ];

  // Func 2: binomial_z(count: 0, n: 1, p: 2) -> f64
  // denom = sqrt(n * p * (1.0 - p)); if denom <= 0 return 0 else (count - n*p)/denom
  // local 3: f64 denom
  const func2 = [
    0x01, 0x01, 0x7c,
    // denom = sqrt(n * p * (1.0 - p))
    0x20, 0x01, 0x20, 0x02, 0xa2, // n * p
    ...f64One, 0x20, 0x02, 0xa1,  // 1.0 - p
    0xa2,                         // *
    0x9f,                         // f64.sqrt
    0x22, 0x03,                   // tee denom
    ...f64Zero, 0x65,             // denom <= 0.0 (f64.le)
    0x04, 0x7c,                   // if -> f64
    ...f64Zero,
    0x05,                         // else
    0x20, 0x00,                   // count
    0x20, 0x01, 0x20, 0x02, 0xa2, // n * p
    0xa1,                         // count - n*p
    0x20, 0x03, 0xa3,             // / denom
    0x0b,                         // end if
    0x0b,                         // end func
  ];

  const codeBody: number[] = [0x03];
  for (const fn of [func0, func1, func2]) {
    const tmp: number[] = [];
    let v = fn.length;
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v !== 0) b |= 0x80;
      tmp.push(b);
    } while (v !== 0);
    codeBody.push(...tmp, ...fn);
  }
  // Remove unused helper pushStr lint warning cleanly if needed
  void pushStr;
  pushSection(10, codeBody);

  return new Uint8Array(new Uint8Array(bytes).buffer);
}

let wasmExports: WasmQuantExports | null = null;
let wasmView: Float64Array | null = null;
let wasmInitialized = false;

function ensureWasmKernel(): WasmQuantExports | null {
  if (wasmInitialized) return wasmExports;
  wasmInitialized = true;
  try {
    if (typeof WebAssembly === 'undefined') return null;
    const bin = buildWasmBinary();
    const arrBuf = bin.buffer as ArrayBuffer;
    if (!WebAssembly.validate(arrBuf)) return null;
    const mod = new WebAssembly.Module(arrBuf);
    const inst = new WebAssembly.Instance(mod);
    const exports = inst.exports as unknown as WasmQuantExports;
    wasmExports = exports;
    wasmView = new Float64Array(exports.mem.buffer);
    return wasmExports;
  } catch {
    wasmExports = null;
    wasmView = null;
    return null;
  }
}

// Eagerly compile at module import so runtime calls are instant
ensureWasmKernel();

export function isWasmQuantActive(): boolean {
  return Boolean(ensureWasmKernel());
}

export interface SeriesStatsResult {
  mean: number;
  variance: number;
  stdDev: number;
  slope: number;
  slopeRatio: number;
  engine: 'wasm' | 'js';
}

export function computeSeriesStatsWasm(values: number[]): SeriesStatsResult {
  const n = values.length;
  if (n === 0) {
    return {
      mean: 0,
      variance: 0,
      stdDev: 0,
      slope: 0,
      slopeRatio: 0,
      engine: ensureWasmKernel() ? 'wasm' : 'js',
    };
  }

  const slope = values[n - 1] - values[0];
  const kernel = ensureWasmKernel();

  // Max capacity of 1 WASM page (65536 bytes / 8 bytes per f64 = 8192 doubles)
  if (kernel && wasmView && n <= wasmView.length) {
    for (let i = 0; i < n; i++) {
      wasmView[i] = values[i];
    }
    const mean = kernel.sum_f64(n) / n;
    const sumSq = kernel.sum_sq_diff_f64(n, mean);
    const variance = sumSq / n;
    const stdDev = Math.sqrt(variance);
    const slopeRatio = stdDev > 0 ? Math.abs(slope) / stdDev : 0;
    return {
      mean,
      variance,
      stdDev,
      slope,
      slopeRatio,
      engine: 'wasm',
    };
  }

  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const mean = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - mean;
    sq += d * d;
  }
  const variance = sq / n;
  const stdDev = Math.sqrt(variance);
  const slopeRatio = stdDev > 0 ? Math.abs(slope) / stdDev : 0;
  return { mean, variance, stdDev, slope, slopeRatio, engine: 'js' };
}

export function computeBinomialZScoreWasm(
  count: number,
  n: number,
  p = 0.1,
): number {
  if (n <= 0 || p <= 0 || p >= 1) return 0;
  const kernel = ensureWasmKernel();
  if (kernel) {
    return kernel.binomial_z(count, n, p);
  }
  const denom = Math.sqrt(n * p * (1 - p));
  return denom > 0 ? (count - n * p) / denom : 0;
}
