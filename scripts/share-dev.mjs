/**
 * Local harness for the /api functions (share, product) — no Vercel account needed.
 * Bundles the handlers with esbuild (already present via Vite), serves them
 * on :5177, and stores blobs in .share-dev-store/ on disk.
 *
 * Run: node scripts/share-dev.mjs
 */
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outDir = join(root, '.share-dev-build');
const PORT = 5177;
/** Plans are capped at 400 KB by the handlers; nothing legitimate is bigger than this. */
const MAX_BODY = 1024 * 1024;
const NAMES = ['share', 'shared', 'comment', 'propose', 'proposal', 'resolve', 'product'];

// Bundle handlers (resolves ./_lib.js → _lib.ts the same way Vercel's builder does)
const esbuild = join(root, 'node_modules', '.bin', 'esbuild');
const build = spawnSync(
  esbuild,
  [
    ...NAMES.map((n) => join(root, 'api', `${n}.ts`)),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--packages=external',
    `--outdir=${outDir}`,
  ],
  { stdio: 'inherit' },
);
if (build.status !== 0) {
  console.error('esbuild failed');
  process.exit(1);
}

const routes = {};
for (const name of NAMES) {
  const mod = await import(join(outDir, `${name}.js`) + `?v=${Date.now()}`);
  routes[`/api/${name}`] = mod.default;
}

/** Minimal VercelRequest/VercelResponse shim. */
function wrap(req, res, body, query) {
  req.body = body;
  req.query = query;
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
    return res;
  };
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const handler = routes[url.pathname];
  if (!handler) {
    res.statusCode = 404;
    return res.end('not found');
  }
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) {
      res.statusCode = 413;
      return res.end(JSON.stringify({ error: 'too large' }));
    }
    chunks.push(c);
  }
  let body;
  if (chunks.length) {
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      body = undefined;
    }
  }
  wrap(req, res, body, Object.fromEntries(url.searchParams));
  try {
    await handler(req, res);
  } catch (e) {
    console.error(e);
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: 'internal' }));
    }
  }
}).listen(PORT, '127.0.0.1', () => console.log(`share-dev api on http://localhost:${PORT}`));
