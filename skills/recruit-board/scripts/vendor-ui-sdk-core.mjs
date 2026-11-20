import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const boardRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(boardRoot, '..', '..');

function parseDistArg(args) {
  let distArg = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dist') {
      if (i + 1 >= args.length || !args[i + 1] || args[i + 1].startsWith('--')) {
        throw new Error('用法：vendor-ui-sdk-core.mjs [--dist <path> | <distPath>]');
      }
      if (distArg !== null) throw new Error('不能重复指定 dist 路径');
      distArg = args[++i];
    } else if (arg.startsWith('--dist=')) {
      const value = arg.slice('--dist='.length);
      if (!value) throw new Error('用法：vendor-ui-sdk-core.mjs [--dist <path> | <distPath>]');
      if (distArg !== null) throw new Error('不能重复指定 dist 路径');
      distArg = value;
    } else if (arg.startsWith('--')) {
      throw new Error(`未知参数：${arg}`);
    } else {
      if (distArg !== null) throw new Error('只能指定一个 dist 路径');
      distArg = arg;
    }
  }
  return distArg ? path.resolve(distArg) : path.join(repoRoot, 'node_modules', '@ui-sdk', 'core', 'dist');
}

const distRoot = parseDistArg(process.argv.slice(2));
if (!fs.existsSync(distRoot) || !fs.statSync(distRoot).isDirectory()) {
  throw new Error(`未找到 @ui-sdk/core dist 目录：${distRoot}`);
}

const pkgImports = {
  '#dev': path.join(distRoot, 'foundation', 'kernel', 'dev-stub.js'),
  '#name-check': path.join(distRoot, 'foundation', 'text', 'name-check-stub.js')
};

const entryRelPaths = [
  'foundation/text/text-match.js',
  'foundation/selection/selection-model.js',
  'foundation/platform/bind-layer.js',
  'foundation/focus/keep-focus.js',
  'foundation/focus/roving-focus.js',
  'foundation/drag-and-drop/reorder.js',
  'foundation/kernel/primitive.js',
  'foundation/kernel/input-source.js',
  'foundation/kernel/live.js',
  'foundation/kernel/part.js',
  'page/shortcuts/shortcuts.js'
];

const visited = new Set();
const collected = [];

function visit(filePath) {
  const resolved = path.resolve(filePath);
  if (visited.has(resolved)) return;
  visited.add(resolved);

  let src = fs.readFileSync(resolved, 'utf8').replace(/\r\n/g, '\n');
  for (const [spec, targetAbs] of Object.entries(pkgImports)) {
    if (src.includes(spec)) {
      visit(targetAbs);
      let relTarget = path.relative(path.dirname(resolved), targetAbs).replace(/\\/g, '/');
      if (!relTarget.startsWith('.')) relTarget = './' + relTarget;
      src = src.replaceAll(`"${spec}"`, `"${relTarget}"`).replaceAll(`'${spec}'`, `'${relTarget}'`);
    }
  }

  const importRegex = /(?:import|export)\s+(?:[^;"']*\s+from\s+)?["'](\.[^"']+)["']/g;
  for (const match of src.matchAll(importRegex)) {
    visit(path.resolve(path.dirname(resolved), match[1]));
  }

  collected.push({
    rel: path.relative(distRoot, resolved).replace(/\\/g, '/'),
    src
  });
}

for (const rel of entryRelPaths) visit(path.join(distRoot, rel));
collected.sort((a, b) => a.rel.localeCompare(b.rel));

const vendorDir = path.join(boardRoot, 'public', 'vendor', 'ui-sdk-core');
fs.rmSync(vendorDir, { recursive: true, force: true });

let totalBytes = 0;
for (const mod of collected) {
  const dest = path.join(vendorDir, mod.rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, mod.src, 'utf8');
  totalBytes += Buffer.byteLength(mod.src, 'utf8');
}

const barrel = `import { applyAttrs } from './foundation/kernel/live.js';
import { attrs, bind, subscribe } from './foundation/kernel/part.js';

export { fuzzyScore, matchRanges, matchSegments } from './foundation/text/text-match.js';
export { createKeySelection, createSelection } from './foundation/selection/selection-model.js';
export { bindLayer } from './foundation/platform/bind-layer.js';
export { keepFocus } from './foundation/focus/keep-focus.js';
export { createRovingFocus } from './foundation/focus/roving-focus.js';
export { createReorder, reorderMessage } from './foundation/drag-and-drop/reorder.js';
export { definePrimitive } from './foundation/kernel/primitive.js';
export { createChange, createCommit, dispatch } from './foundation/kernel/input-source.js';
export { applyAttrs };
export { attrs, bind, subscribe };
export { ariaKeyshortcuts, formatShortcut, matchesShortcut, registerShortcut } from './page/shortcuts/shortcuts.js';

export function bindPart(instance, slot, el, props) {
  const part = instance.part(slot, props);
  const sync = () => applyAttrs(el, attrs(part));
  sync();
  const unbind = bind(part, el);
  const unsub = subscribe(part, sync);
  return () => {
    unsub();
    unbind?.();
  };
}
`;

const indexDest = path.join(vendorDir, 'index.js');
fs.writeFileSync(indexDest, barrel, 'utf8');
totalBytes += Buffer.byteLength(barrel, 'utf8');

process.stdout.write(`${JSON.stringify({
  moduleCount: collected.length + 1,
  totalBytes,
  totalKB: +(totalBytes / 1024).toFixed(1),
  entry: indexDest
}, null, 2)}\n`);
