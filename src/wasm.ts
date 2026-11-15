/// <reference path="science.ts" />
namespace SkyShift {
  interface NumericalExports {
    memory: WebAssembly.Memory;
    __heap_base: WebAssembly.Global;
    align: (sky: number, wcs: number, pixels: number, out: number, scratch: number,
      count: number, size: number, x: number, y: number) => number;
    stack: (frames: number, out: number, scratch: number, length: number, frameCount: number) => void;
  }

  export async function rustEngine(bytes: Uint8Array<ArrayBuffer>): Promise<Engine> {
    const module = await WebAssembly.compile(bytes);
    const imports: WebAssembly.Imports = {};
    // A normal wasm32 Rust build links core's panic path. The offline build
    // uses the same Rust kernel with panic functions imported as traps.
    for (const item of WebAssembly.Module.imports(module)) {
      if (item.kind !== "function" || !/panic|slice_index_fail/.test(item.name)) {
        throw new Error(`Unexpected Rust/WASM import: ${item.module}.${item.name}`);
      }
      imports[item.module] ??= {};
      imports[item.module][item.name] = () => { throw new Error("Rust numerical kernel bounds check failed."); };
    }
    const { exports } = await WebAssembly.instantiate(module, imports);
    const wasm = exports as unknown as NumericalExports;
    if (!(wasm.memory instanceof WebAssembly.Memory) || !wasm.align || !wasm.stack) {
      throw new Error("Unexpected Rust/WASM exports.");
    }
    const memory = wasm.memory;
    return (grid, exposureCapacity, pixelCapacity) => {
      const length = grid.side ** 2;
      let cursor = Math.ceil(Number(wasm.__heap_base.value) / 8) * 8;
      const sky = cursor;
      cursor += grid.sky.byteLength;
      const wcs = cursor;
      cursor += 55 * 8;
      const pixels = cursor;
      cursor += pixelCapacity * 4;
      const frames = cursor;
      cursor += length * exposureCapacity * 4;
      const result = cursor;
      cursor += length * 4;
      const scratch = cursor;
      cursor += Math.max(length, exposureCapacity) * 4;
      if (cursor > memory.buffer.byteLength) memory.grow(Math.ceil((cursor - memory.buffer.byteLength) / 65536));
      new Float64Array(memory.buffer, sky, grid.sky.length).set(grid.sky);
      const wcsBuffer = new Float64Array(memory.buffer, wcs, 55);
      const pixelBuffer = new Float32Array(memory.buffer, pixels, pixelCapacity);
      return {
        align(exposure, index) {
          wcsBuffer.set(exposure.wcs);
          pixelBuffer.set(exposure.pixels);
          const { size, x0, y0 } = exposure.header;
          return Boolean(wasm.align(sky, wcs, pixels, frames + index * length * 4, scratch, length, size, x0, y0));
        },
        stack(count) {
          wasm.stack(frames, result, scratch, length, count);
          return new Float32Array(memory.buffer, result, length).slice();
        },
      };
    };
  }
}
