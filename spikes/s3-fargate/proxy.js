// Allowlist CONNECT proxy used as the shared egress proxy in the spike.
const http = require('http'), net = require('net');
const allow = (process.env.ALLOW || '').split(',').filter(Boolean);
const ok = (h) => allow.some((a) => h === a || h.endsWith('.' + a));
const s = http.createServer((q, r) => { console.log('DENY plain-http', q.url); r.writeHead(403); r.end('plain http denied'); });
s.on('connect', (q, c, head) => {
  const [h, p] = q.url.split(':');
  if (!ok(h) || p !== '443') { console.log('DENY', q.url); c.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const u = net.connect(443, h, () => {
    console.log('ALLOW', q.url);
    c.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    u.write(head); u.pipe(c); c.pipe(u);
  });
  u.on('error', () => c.destroy()); c.on('error', () => u.destroy());
});
s.listen(3128, () => console.log('proxy up, allow=' + allow.join(',')));
