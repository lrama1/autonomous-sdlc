// Drives the spike: applies the stack, pushes the real runner image, runs the probe as a Fargate task, prints the results.
//   node run.mjs up        build the stack and push the image
//   node run.mjs probe     run the probe task (can be repeated; the second run shows a warm image pull)
//   node run.mjs down      destroy everything
import { execFileSync } from 'node:child_process';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const sh = (cmd, args, o = {}) => {
  const r = execFileSync(cmd, args, { encoding: 'utf8', stdio: o.show ? 'inherit' : ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 });
  return r ? r.trim() : '';
};
const tf = (...a) => sh('terraform', a, { show: true });
const out = (k) => sh('terraform', ['output', '-raw', k]);
const aws = (...a) => sh('aws', [...a, '--region', 'us-east-1']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cmd = process.argv[2];

if (cmd === 'up') {
  tf('init', '-input=false');
  tf('apply', '-input=false', '-auto-approve', '-target=aws_ecr_repository.runner', '-target=random_id.suffix');
  const repo = out('repository');
  sh('aws', ['ecr', 'get-login-password', '--region', 'us-east-1'], {});
  const pw = sh('aws', ['ecr', 'get-login-password', '--region', 'us-east-1']);
  execFileSync('docker', ['login', '--username', 'AWS', '--password-stdin', repo.split('/')[0]], { input: pw, stdio: ['pipe', 'inherit', 'inherit'] });
  sh('docker', ['tag', 'sdlc-runner:dev', `${repo}:spike`]);
  const t = Date.now();
  sh('docker', ['push', `${repo}:spike`], { show: true });
  console.log(`pushed the image in ${Math.round((Date.now() - t) / 1000)} s`);
  tf('apply', '-input=false', '-auto-approve');
  console.log('waiting for the stand-in API and the proxy to run and register...');
  for (let i = 0; i < 40; i++) {
    const n = aws('ecs', 'describe-services', '--cluster', out('cluster'), '--services', 'api', 'proxy', '--query', 'services[].runningCount', '--output', 'text');
    if (n.split(/\s+/).every((x) => x === '1')) break;
    await sleep(10_000);
  }
  await sleep(20_000);
  console.log('up');
} else if (cmd === 'probe') {
  const bucket = out('state_bucket'), other = out('other_bucket'), cluster = out('cluster');
  const s3 = new S3Client({ region: 'us-east-1' });
  await s3.send(new PutObjectCommand({ Bucket: other, Key: 'hello.txt', Body: 'private' }));
  const key = `runs/test-${Date.now()}/state.tgz`;
  const env = [
    { name: 'STATE_PUT_URL', value: await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 900 }) },
    { name: 'STATE_GET_URL', value: await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: 900 }) },
    { name: 'OTHER_GET_URL', value: await getSignedUrl(s3, new GetObjectCommand({ Bucket: other, Key: 'hello.txt' }), { expiresIn: 900 }) },
  ];
  const started = Date.now();
  const run = JSON.parse(aws('ecs', 'run-task', '--cluster', cluster, '--launch-type', 'FARGATE', '--task-definition', out('runner_td'),
    '--network-configuration', `awsvpcConfiguration={subnets=[${out('isolated_subnet')}],securityGroups=[${out('runner_sg')}],assignPublicIp=DISABLED}`,
    '--overrides', JSON.stringify({ containerOverrides: [{ name: 'runner', environment: env }] })));
  if (run.failures?.length) throw new Error(JSON.stringify(run.failures));
  const arn = run.tasks[0].taskArn, id = arn.split('/').pop();
  console.log('task', id);
  let task;
  for (;;) {
    task = JSON.parse(aws('ecs', 'describe-tasks', '--cluster', cluster, '--tasks', arn)).tasks[0];
    if (task.lastStatus === 'STOPPED') break;
    await sleep(5000);
  }
  const t = (x) => (x ? new Date(x).getTime() : null);
  const secs = (a, b) => (a && b ? Math.round((b - a) / 1000) : '?');
  console.log(`stopped: ${task.stopCode} ${task.stoppedReason ?? ''}; exit code ${task.containers[0].exitCode}`);
  console.log(`timeline: image pull ${secs(t(task.pullStartedAt), t(task.pullStoppedAt))} s; created to running ${secs(t(task.createdAt), t(task.startedAt))} s; whole task ${secs(started, Date.now())} s`);
  await sleep(8000);
  const logs = JSON.parse(aws('logs', 'get-log-events', '--log-group-name', out('log_group'), '--log-stream-name', `runner/runner/${id}`, '--output', 'json'));
  for (const e of logs.events) {
    if (!e.message.startsWith('RESULT ')) { console.log('  log:', e.message.slice(0, 200)); continue; }
    const r = JSON.parse(e.message.slice(7));
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}: ${r.detail}`);
  }
} else if (cmd === 'proxylog') {
  const streams = JSON.parse(aws('logs', 'describe-log-streams', '--log-group-name', out('log_group'), '--log-stream-name-prefix', 'proxy/', '--output', 'json')).logStreams;
  for (const s of streams) {
    const ev = JSON.parse(aws('logs', 'get-log-events', '--log-group-name', out('log_group'), '--log-stream-name', s.logStreamName, '--output', 'json')).events;
    for (const e of ev) console.log(e.message);
  }
} else if (cmd === 'down') {
  try { sh('aws', ['ecs', 'update-service', '--cluster', out('cluster'), '--service', 'api', '--desired-count', '0', '--region', 'us-east-1']); sh('aws', ['ecs', 'update-service', '--cluster', out('cluster'), '--service', 'proxy', '--desired-count', '0', '--region', 'us-east-1']); await sleep(15_000); } catch {}
  tf('destroy', '-input=false', '-auto-approve');
  console.log('destroyed');
} else {
  console.log('usage: node run.mjs up | probe | proxylog | down');
}
