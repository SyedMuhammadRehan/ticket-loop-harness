'use strict';
const http = require('http');
const { createApp } = require('./app.js');
const { seedStore } = require('../store.js');

const MAX_BODY_BYTES = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) reject(Object.assign(new Error('body too large'), { status: 413 }));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('body is not JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function start({ port = 0, secret = process.env.DEPOT_SECRET } = {}) {
  if (!secret) throw new Error('DEPOT_SECRET is required to start the server');
  const handle = createApp(seedStore(), { secret });
  const server = http.createServer(async (req, res) => {
    let result;
    try {
      const body = await readBody(req);
      result = handle({ method: req.method, url: req.url, headers: req.headers, body });
    } catch (err) {
      result = { status: err.status || 500, body: { error: err.status ? err.message : 'INTERNAL' } };
    }
    res.writeHead(result.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result.body));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (require.main === module) {
  start({ port: Number(process.env.PORT) || 8080 }).then((server) => {
    process.stdout.write(`depot listening on 127.0.0.1:${server.address().port}\n`);
  });
}

module.exports = { start };
