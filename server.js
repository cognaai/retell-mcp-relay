// Zero-dependency relay: forwards every request to Retell's hosted MCP server
// (https://mcp.retellai.com), swapping in a fixed Retell API key so the
// upstream credential never has to be shared with the caller.
//
// Callers must authenticate to THIS relay with their own bearer token
// (RELAY_AUTH_TOKEN), independent of the Retell API key. This exists so
// multiple Retell accounts can each get their own unique Claude connector
// URL, since Claude only allows one connector per remote MCP server URL.

const http = require('http');
const https = require('https');
const crypto = require('crypto');

const TARGET_HOST = 'mcp.retellai.com';
const RETELL_API_KEY = process.env.RETELL_API_KEY;
const RELAY_AUTH_TOKEN = process.env.RELAY_AUTH_TOKEN;
const PORT = process.env.PORT || 3000;

if (!RETELL_API_KEY || !RELAY_AUTH_TOKEN) {
  console.error('FATAL: RETELL_API_KEY and RELAY_AUTH_TOKEN must both be set.');
  process.exit(1);
}

function safeEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  const authHeader = req.headers['authorization'] || '';
  const expected = `Bearer ${RELAY_AUTH_TOKEN}`;
  if (!safeEqual(authHeader, expected)) {
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer',
    });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const headers = Object.assign({}, req.headers);
  headers['host'] = TARGET_HOST;
  headers['authorization'] = `Bearer ${RETELL_API_KEY}`;

  const proxyReq = https.request(
    {
      hostname: TARGET_HOST,
      port: 443,
      path: req.url,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res, { end: true });
    }
  );

  proxyReq.on('error', (err) => {
    console.error('Upstream error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: 'bad_gateway', message: err.message }));
  });

  req.pipe(proxyReq, { end: true });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Retell MCP relay listening on 0.0.0.0:${PORT}, forwarding to https://${TARGET_HOST}`);
});
