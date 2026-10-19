// Stand-in for the platform API in the spike. It answers the runner, serves the proxy's allowlist, and tries to reach a
// port the runner opens (what a preview proxy would do).
const http = require('http'), net = require('net');
const allow = new Set(['github.com']);
let preview = 'not tried';
const s = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  const send = (o) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(o)); };
  if (u.pathname === '/ping') return r.end('pong');
  if (u.pathname === '/egress-allow') return send({ hosts: [...allow] });
  if (u.pathname === '/admin/allow') { allow.add(u.searchParams.get('host')); return send({ hosts: [...allow] }); }
  if (u.pathname === '/register') {
    const ip = q.socket.remoteAddress.replace('::ffff:', ''), port = Number(u.searchParams.get('port'));
    const c = net.connect(port, ip, () => { preview = 'reached ' + ip + ':' + port; c.destroy(); });
    c.setTimeout(8000, () => { preview = 'timeout ' + ip + ':' + port; c.destroy(); });
    c.on('error', (e) => { preview = 'error ' + e.code + ' ' + ip + ':' + port; });
    return send({ ip });
  }
  if (u.pathname === '/preview-result') return send({ preview });
  r.statusCode = 404; r.end('no');
});
s.listen(8080, () => process.stdout.write('stub api up\n'));
