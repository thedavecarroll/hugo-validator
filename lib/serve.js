#!/usr/bin/env node
// Minimal static file server for the built site. Used as the Playwright
// test server so validation needs nothing beyond Node.
//
// Behaves like a static host, not like a dev tool:
// - folders serve their index.html
// - a folder without index.html is a 404 (never a directory listing)
// - missing paths return 404, with the site's 404.html as the body if present
const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Resolve a request path to a file inside root.
 * Returns { file } | { redirect } | { notFound: true }
 */
function resolveRequest(root, requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
  } catch {
    return { notFound: true };
  }

  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, `.${pathname}`);

  // Never serve anything outside the site root
  if (target !== absoluteRoot && !target.startsWith(absoluteRoot + path.sep)) {
    return { notFound: true };
  }

  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return { notFound: true };
  }

  if (stat.isDirectory()) {
    if (!pathname.endsWith('/')) return { redirect: `${pathname}/` };
    const index = path.join(target, 'index.html');
    return fs.existsSync(index) ? { file: index } : { notFound: true };
  }

  return stat.isFile() ? { file: target } : { notFound: true };
}

function createServer(root) {
  return http.createServer((req, res) => {
    const result = resolveRequest(root, req.url || '/');

    if (result.redirect) {
      res.writeHead(301, { Location: result.redirect });
      res.end();
      return;
    }

    if (result.file) {
      const type = MIME_TYPES[path.extname(result.file).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        fs.createReadStream(result.file).pipe(res);
      }
      return;
    }

    const notFoundPage = path.join(path.resolve(root), '404.html');
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    if (req.method !== 'HEAD' && fs.existsSync(notFoundPage)) {
      fs.createReadStream(notFoundPage).pipe(res);
    } else {
      res.end(req.method === 'HEAD' ? undefined : '<!doctype html><title>404</title><h1>404 Not Found</h1>');
    }
  });
}

function parseArgs(argv) {
  const options = { port: 3000, dir: 'public', host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') options.port = parseInt(argv[++i], 10);
    else if (argv[i] === '--dir') options.dir = argv[++i];
    else if (argv[i] === '--host') options.host = argv[++i];
  }
  return options;
}

if (require.main === module) {
  const { port, dir, host } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(dir)) {
    console.error(`hugo-validator serve: folder not found: ${dir}`);
    process.exit(1);
  }
  createServer(dir).listen(port, host, () => {
    console.log(`Serving ${path.resolve(dir)} at http://${host}:${port}`);
  });
}

module.exports = { createServer, resolveRequest, MIME_TYPES };
