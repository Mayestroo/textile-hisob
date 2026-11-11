'use strict';
// Static literal-import inventory. No module execution. Not a dead-code detector:
// IPC/HTTP/DOM, Python imports and computed require paths need manual tracing.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const slash = value => value.split(path.sep).join('/');
function inventory() {
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const name = slash(path.join(directory, entry.name));
      if (entry.isDirectory() && !['node_modules', 'tests', '__pycache__'].includes(entry.name)) visit(name);
      else if (entry.isFile() && /\.(?:cjs|mjs|js|ts|tsx|py)$/.test(name) && !/\.(?:test|d)\.[^.]+$/.test(name)) files.push(name);
    }
  };
  for (const directory of ['apps', 'packages', 'ops', 'scripts']) visit(directory);
  const nodes = new Set(files);
  const edges = [];
  const unresolved = [];
  const externals = new Set();
  const hashes = {};
  for (const file of files) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    hashes[file] = crypto.createHash('sha256').update(source).digest('hex');
    if (file.endsWith('.py')) continue;
    const pattern = /\brequire\(\s*['"]([^'"]+)['"]\s*\)|\bimport\(\s*['"]([^'"]+)['"]\s*\)|\b(?:import|export)\s+(type\s+)?[^;]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1] || match[2] || match[4] || match[5];
      if (!specifier.startsWith('.')) { externals.add(specifier); continue; }
      const base = slash(path.normalize(path.join(path.dirname(file), specifier)));
      const target = [base, ...['.ts', '.tsx', '.cjs', '.mjs', '.js'].map(ext => base + ext),
        ...['.ts', '.tsx', '.cjs', '.js'].map(ext => base + '/index' + ext)].find(candidate => nodes.has(candidate));
      if (target) edges.push({ from: file, to: target, typeOnly: Boolean(match[3]) });
      else if (!/\.(css|png|svg|ico|woff2?|ttf|json)$/.test(specifier)) unresolved.push({ from: file, specifier });
    }
  }
  const links = new Map(files.map(file => [file, []]));
  for (const edge of edges.filter(edge => !edge.typeOnly)) links.get(edge.from).push(edge.to);
  let ordinal = 0;
  const index = new Map(), low = new Map(), stack = [], active = new Set(), cycles = [];
  function strong(node) {
    index.set(node, ordinal); low.set(node, ordinal++); stack.push(node); active.add(node);
    for (const target of links.get(node)) {
      if (!index.has(target)) { strong(target); low.set(node, Math.min(low.get(node), low.get(target))); }
      else if (active.has(target)) low.set(node, Math.min(low.get(node), index.get(target)));
    }
    if (low.get(node) === index.get(node)) {
      const component = []; let value;
      do { value = stack.pop(); active.delete(value); component.push(value); } while (value !== node);
      if (component.length > 1 || links.get(node).includes(node)) cycles.push(component.sort());
    }
  }
  for (const file of files) if (!index.has(file)) strong(file);
  const fanIn = new Map(files.map(file => [file, 0]));
  for (const edge of edges) fanIn.set(edge.to, fanIn.get(edge.to) + 1);
  return { methodology: 'Literal-import heuristic; type-only import declarations excluded from cycle graph; mixed inline type imports may overapproximate. Runtime/IPC/HTTP/Python edges require manual ownership map.',
    files: files.length, edges, unresolved, cycles, externals: [...externals].sort(), sourceHashes: hashes,
    largestModules: files.map(file => ({ file, lines: fs.readFileSync(path.join(root, file), 'utf8').split('\n').length,
      fanIn: fanIn.get(file), fanOut: links.get(file).length })).sort((a, b) => b.lines - a.lines).slice(0, 20) };
}
if (require.main === module) {
  const result = inventory();
  fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ files: result.files, edges: result.edges.length, cycles: result.cycles, unresolved: result.unresolved }));
}
module.exports = { inventory };
