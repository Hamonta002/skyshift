import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script = fileURLToPath(new URL('./read-flags.py', import.meta.url));
const cache = new Map();
let running = 0;
let cachedPython;
export function resolvePython() {
  if (process.env.SKYSHIFT_PYTHON) return process.env.SKYSHIFT_PYTHON;
  if (cachedPython) return cachedPython;
  const candidates = process.platform === 'win32' ? ['python', 'python3'] : ['python3', 'python'];
  for (const cmd of candidates) {
    if (spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0) {
      cachedPython = cmd;
      return cmd;
    }
  }
  cachedPython = candidates[0];
  return cachedPython;
}
export function validateQuality(params) {
  const key = params.get('key') ?? '', xs = params.get('x'), ys = params.get('y');
  if (!/^[a-z0-9_]+\/level2\/[A-Za-z0-9_./-]+\.fits$/.test(key) || key.includes('..')) throw Error('Invalid product key.');
  if (!/^\d+$/.test(xs ?? '') || !/^\d+$/.test(ys ?? '')) throw Error('Invalid detector pixel.');
  const x = Number(xs), y = Number(ys);
  if (x >= 2040 || y >= 2040) throw Error('Detector pixel is outside the image.');
  return {key, x, y};
}
function execute({key, x, y}) {
  return new Promise((resolve, reject) => {
    const child = spawn(resolvePython(), [script, key, String(x), String(y)], {stdio:['ignore','pipe','pipe']});
    let output = '', errors = '';
    const timer = setTimeout(() => { child.kill(); reject(Error('Flag inspection timed out.')); }, 45000);
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 20000) child.kill(); });
    child.stderr.on('data', chunk => { errors += chunk; if (errors.length > 20000) child.kill(); });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      let data;
      try { data = JSON.parse(output); }
      catch { reject(Error('Flag inspection returned an invalid response.')); return; }
      if (data.error === 'archive-unreachable') {
        // Keep library and TLS details in the server log, not in the interface.
        console.error(`[quality] ${key}: ${data.detail}`);
        const error = Error('Could not read the quality flags from the SPHEREx archive right now. Try again in a minute.');
        error.status = 502;
        reject(error);
      } else if (code !== 0 || data.error) reject(Error(data.error || 'Flag inspection failed.'));
      else resolve(data);
    });
  });
}
export async function handleQuality(params, runner = execute) {
  const args = validateQuality(params), id = JSON.stringify(args), found = cache.get(id);
  if (found && found.expires > Date.now()) return found.value;
  if (running >= 2) { const error = Error('Flag inspection is busy. Try again shortly.'); error.status = 503; throw error; }
  running++;
  try {
    const value = await runner(args);
    cache.set(id, {value, expires: Date.now() + 86400000});
    if (cache.size > 100) cache.delete(cache.keys().next().value);
    return value;
  } finally { running--; }
}
