import { createDb } from '@sdlc/db';
import { gatewayConfigSchema, parseEnv } from '@sdlc/schemas';
import { createGatewayServer } from './app.js';

const config = parseEnv(gatewayConfigSchema, process.env);
const { db, pool } = createDb(config.DATABASE_URL, { caFile: config.DATABASE_CA_FILE });
const server = createGatewayServer({ db, config });

const stop = () => {
  server.close(() => void pool.end().then(() => process.exit(0)));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

server.listen(config.GATEWAY_PORT, config.GATEWAY_HOST, () => {
  console.log(`gateway listening on ${config.GATEWAY_PORT}`);
});
