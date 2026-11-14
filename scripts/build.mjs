import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (name) => readFileSync(join(root, name), "utf8");
const require = createRequire(import.meta.url);
const bundledTypeScript = "/usr/lib/code/extensions/node_modules/typescript/lib/typescript.js";
function typeScriptCompiler() {
  if (process.env.SKYSHIFT_TYPESCRIPT) return require(process.env.SKYSHIFT_TYPESCRIPT);
  try {
    return require("typescript");
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND" || !existsSync(bundledTypeScript)) throw error;
    return require(bundledTypeScript);
  }
}
const ts = typeScriptCompiler();
const scratch = mkdtempSync(join(tmpdir(), "skyshift-build-"));
const out = join(root, "dist");

function run(program, args) {
  execFileSync(program, args, { cwd: root, stdio: "inherit" });
}

function hasRustTarget() {
  const target = spawnSync("rustc", ["--target", "wasm32-unknown-unknown", "--print", "target-libdir"], {
    encoding: "utf8",
  });
  return target.status === 0 && existsSync(target.stdout.trim());
}

function compileRust() {
  const source = join(root, "src/kernel.rs");
  const wasm = join(scratch, "skyshift.wasm");
  const optimizations = ["--edition", "2024", "-O", "-C", "panic=abort"];
  if (hasRustTarget()) {
    const panic = join(scratch, "kernel.rs");
    writeFileSync(panic, read("src/kernel.rs") + "\n#[panic_handler]\nfn panic(_: &core::panic::PanicInfo) -> ! { core::arch::wasm32::unreachable() }\n");
    run("rustc", [
      panic, ...optimizations, "--crate-type", "cdylib", "--target", "wasm32-unknown-unknown",
      "-C", "link-arg=--export=__heap_base", "-C", "link-arg=--export-memory",
      "-C", "strip=symbols", "-o", wasm,
    ]);
    return { wasm, toolchain: "rustc wasm32-unknown-unknown" };
  }

  // The kernel needs neither allocation nor target-specific APIs. Preserve
  // Rust's checked arithmetic/accesses and have LLVM emit a wasm32 object.
  const ir = join(scratch, "kernel.ll");
  const portable = join(scratch, "kernel-portable.ll");
  run("rustc", [source, ...optimizations, "--crate-type", "lib", "--emit=llvm-ir", "-o", ir]);
  const code = readFileSync(ir, "utf8");
  if (/\b(?:ptrtoint|inttoptr)\b|\bllvm\.x86\./.test(code)) {
    throw new Error("Kernel IR contains target-dependent operations. Install Rust's wasm32-unknown-unknown target.");
  }
  writeFileSync(portable, code
    .replace(/^target (?:datalayout|triple) = .*$/gm, "")
    .replace(/ "target-(?:cpu|features)"="[^"]*"/g, ""));
  run("clang", [
    "--target=wasm32-unknown-unknown", "-O3", "-nostdlib", "-Wno-override-module",
    "-Wl,--no-entry", "-Wl,--export=align", "-Wl,--export=stack",
    "-Wl,--export=__heap_base", "-Wl,--export-memory",
    "-Wl,--allow-undefined", "-Wl,--strip-all", portable, "-o", wasm,
  ]);
  return { wasm, toolchain: "rustc LLVM IR → Clang wasm32 (offline)" };
}

function fixture() {
  const raw = read("reference/fixtures/wise0855_d6.json");
  const source = JSON.parse(raw);
  const provenance = JSON.parse(read("reference/fixtures/wise0855_d6.manifest.json"));
  if (provenance.exposures.length !== source.exposures.length) throw new Error("Fixture provenance does not match the pixels.");
  const headers = source.exposures.map(({ img, test, ...header }, index) => ({
    ...header,
    productKey: provenance.exposures[index].productKey,
    mjd: provenance.exposures[index].mjdAvg,
    wavelength: provenance.exposures[index].wavelengthMicron,
    bandwidth: provenance.exposures[index].bandwidthMicron,
  }));
  const pixelCount = headers.reduce((sum, header) => sum + header.size ** 2, 0);
  const packed = Buffer.alloc(pixelCount * 4);
  let offset = 0;
  for (const { img } of source.exposures) {
    for (const pixel of img) {
      packed.writeFloatLE(pixel === null ? NaN : pixel, offset);
      offset += 4;
    }
  }
  if (offset !== packed.length) throw new Error("Invalid source fixture.");
  return {
    id: createHash("sha256").update(raw).digest("hex").slice(0, 20),
    ra0: source.ra0, dec0: source.dec0, half: source.oh, scale: source.scale,
    dates: ["May 2025", "Oct–Dec 2025", "Apr–May 2026"],
    visitSizes: source.visit_sizes,
    headers,
    pixels: packed.toString("base64"),
  };
}

function compileTypeScript(files) {
  const output = join(scratch, "js");
  const options = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    rootDir: join(root, "src"),
    outDir: output,
    strict: true,
    noEmitOnError: true,
    skipLibCheck: true,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.webworker.d.ts"],
    types: [],
  };
  const program = ts.createProgram(files.map((file) => resolve(root, file)), options);
  const result = program.emit();
  const errors = ts.getPreEmitDiagnostics(program).concat(result.diagnostics);
  if (errors.length) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: (name) => name,
      getCurrentDirectory: () => root,
      getNewLine: () => "\n",
    }));
  }
  return (names) => names.map((name) => readFileSync(join(output, name + ".js"), "utf8")).join("\n");
}

try {
  const kernel = compileRust();
  const bytes = readFileSync(kernel.wasm);
  const data = fixture();
  const sources = ["science", "wasm", "worker", "coordinates", "archive", "spectrum", "catalogue", "map", "viewer"];
  const assemble = compileTypeScript(sources.map((name) => `src/${name}.ts`));
  const compute = assemble(sources.slice(0, 2));
  const worker = assemble(sources.slice(0, 3)) + "\nSkyShift.installWorker(self);";
  const viewer = assemble(sources);
  const assets = {
    fixture: data,
    wasm: bytes.toString("base64"),
    worker,
    toolchain: kernel.toolchain,
  };
  const html = read("src/index.html")
    .replace("/* BUILD_CSS */", () => read("src/style.css"))
    .replace("/* BUILD_DATA */", () => "const ASSETS = " + JSON.stringify(assets).replaceAll("<", "\\u003c") + ";")
    .replace("/* BUILD_JS */", () => viewer.replaceAll("</script", "<\\/script"));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "index.html"), html);
  writeFileSync(join(out, "kernel.wasm"), bytes);
  writeFileSync(join(out, "core.cjs"), compute + "\nmodule.exports = SkyShift;\n");
  writeFileSync(join(out, "worker.cjs"), assemble(sources.slice(0, 3)) + "\nmodule.exports = SkyShift;\n");
  writeFileSync(join(out, "archive.cjs"), assemble(["science", "coordinates", "archive", "spectrum", "catalogue", "map"]) + "\nmodule.exports = SkyShift;\n");
  writeFileSync(join(out, "fixture.json"), JSON.stringify(data));
  const exampleSource = join(root, "reference/fixtures/examples");
  const exampleOutput = join(out, "examples");
  rmSync(exampleOutput, { recursive: true, force: true });
  if (existsSync(exampleSource)) {
    mkdirSync(exampleOutput, { recursive: true });
    for (const id of ["barnard", "epsindiB", "rwaur", "rdra"]) {
      const source = join(exampleSource, id + ".json");
      if (existsSync(source)) copyFileSync(source, join(exampleOutput, id + ".json"));
    }
  }
  writeFileSync(join(out, "wise0855_d6.manifest.json"), read("reference/fixtures/wise0855_d6.manifest.json"));
  writeFileSync(join(out, "build.json"), JSON.stringify({
    toolchain: kernel.toolchain,
    wasmBytes: bytes.length,
    fixtureBytes: Buffer.byteLength(JSON.stringify(data)),
    htmlBytes: Buffer.byteLength(html),
  }, null, 2));
  console.log(`Built dist/index.html (${Buffer.byteLength(html).toLocaleString()} bytes). Rust/WASM: ${bytes.length.toLocaleString()} bytes, ${kernel.toolchain}.`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
