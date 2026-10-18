import { parseForwards, startEgress } from './egress.js';

const allow = (process.env.EGRESS_ALLOW ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const egress = await startEgress({
  allowHosts: allow,
  forwards: parseForwards(process.env.EGRESS_FORWARDS ?? ''),
  proxyPort: Number(process.env.EGRESS_PROXY_PORT ?? 3128),
});

const stop = () => void egress.stop().then(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
