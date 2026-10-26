// A step-by-step "how to deploy Autonomous SDLC to your own AWS account" video for people who want to adopt it.
// Pieces: terminal panels (real commands, real output shapes, with every private value replaced by a placeholder),
// recreated GitHub and AWS screens that carry placeholder values only, and real pages (the platform's GitHub setup page,
// and a public run of the deploy workflow). Placeholders are not blurred: only an email address on a real page is.
//   SDLC_USER=... SDLC_PASSWORD=... node demo/howto/make.mjs [out.mp4]
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freshAuth, sleep } from '../guided/record.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('@playwright/test');
const here = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.resolve(here, '..', '_work', 'howto');
fs.mkdirSync(path.join(WORK, 'audio'), { recursive: true });
const SIZE = { width: 1280, height: 720 };
const VOICE = process.env.HOWTO_VOICE ?? 'en-US-AriaNeural';
const run = (cmd, a, o = {}) => execFileSync(cmd, a, { stdio: 'pipe', ...o });
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** {{value}} marks a placeholder value. */
const blur = (s) => esc(s).replace(/\{\{(.*?)\}\}/g, '<span class="bl">$1</span>');

function narrate(id, text) {
  const hash = crypto.createHash('sha1').update(VOICE + text).digest('hex').slice(0, 8);
  const mp3 = path.join(WORK, 'audio', `${id}-${hash}.mp3`);
  if (!fs.existsSync(mp3) || fs.statSync(mp3).size < 1000) {
    const txt = mp3.replace('.mp3', '.txt');
    fs.writeFileSync(txt, text, 'utf8');
    run('edge-tts', ['--voice', VOICE, '--rate=+2%', '--file', txt, '--write-media', mp3]);
  }
  const sec = Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp3]).toString().trim());
  return { mp3, sec };
}

const FONT = "font-family:Roboto,'Segoe UI',Arial,sans-serif;";
const MONO = "font-family:'Cascadia Mono',Consolas,'Courier New',monospace;";

/** One page: a step badge, the screen, a caption bar, a fake cursor with callouts, and the timing script. */
function pageHtml({ step, stepTitle, dark = false, body, targets = [], captions, D, typing = [] }) {
  const sentences = captions.match(/[^.!?]+[.!?]+(\s|$)/g)?.map((s) => s.trim()) ?? [captions];
  const total = sentences.reduce((n, s) => n + s.length, 0);
  let acc = 0;
  const caps = sentences.map((s) => {
    const at = (acc / total) * 0.97;
    acc += s.length;
    return { s, at };
  });
  return `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box}
html,body{margin:0;width:1280px;height:720px;overflow:hidden;${FONT};background:${dark ? '#0b1020' : '#e9eef6'}}
.bl{display:inline}
.badge{position:absolute;left:28px;top:20px;z-index:50;display:flex;align-items:center;gap:12px}
.badge b{background:#ffb000;color:#0a1020;font-weight:800;letter-spacing:2px;font-size:17px;padding:6px 12px;border-radius:8px}
.badge span{font-size:22px;font-weight:700;color:${dark ? '#fff' : '#101828'}}
.screen{position:absolute;left:28px;right:28px;top:68px;bottom:96px}
.cap{position:absolute;left:0;right:0;bottom:0;height:84px;display:flex;align-items:center;justify-content:center;padding:0 60px;background:#0a1020ee;color:#fff;font-size:25px;line-height:1.3;text-align:center;z-index:60}
.cap i{font-style:normal;display:none}.cap i.on{display:block}
#cursor{position:absolute;left:0;top:0;width:26px;height:26px;margin:-4px 0 0 -4px;z-index:70;transition:transform .9s cubic-bezier(.3,.7,.3,1);transform:translate(1200px,640px);pointer-events:none}
#cursor svg{filter:drop-shadow(0 2px 4px #0008)}
#tip{position:absolute;z-index:65;max-width:420px;background:#101828f2;color:#fff;border-radius:10px;padding:8px 14px;font-size:20px;box-shadow:0 4px 18px #000b;opacity:0;transition:opacity .3s;pointer-events:none}
#tip em{background:#ffb000;color:#0a1020;font-style:normal;font-weight:800;font-size:14px;letter-spacing:1px;border-radius:5px;padding:1px 7px;margin-right:8px}
#ring{position:absolute;z-index:55;border:4px solid #ffb000;border-radius:10px;opacity:0;pointer-events:none;box-shadow:0 0 0 4px #ffb00033;transition:opacity .25s}
.ripple{position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:4px solid #ffd000;z-index:68;animation:rp .7s ease-out forwards;pointer-events:none}
@keyframes rp{from{transform:scale(.3);opacity:1}to{transform:scale(1.7);opacity:0}}
.term .l{white-space:pre-wrap;word-break:break-all}
#menu{display:none}#menu.on{display:block}
</style>
<div class="badge"><b>${esc(step)}</b><span>${esc(stepTitle)}</span></div>
<div class="screen">${body}</div>
<div class="cap">${caps.map((c, i) => `<i data-at="${c.at}"${i === 0 ? ' class="on"' : ''}>${esc(c.s)}</i>`).join('')}</div>
<div id="ring"></div><div id="tip"></div>
<div id="cursor"><svg width="26" height="26" viewBox="0 0 24 24"><path d="M3 2l7 18 2.6-7.4L20 10z" fill="#fff" stroke="#111" stroke-width="1.5"/></svg></div>
<script>
const D=${D}*1000;
const caps=[...document.querySelectorAll('.cap i')];
caps.forEach((c)=>{const at=+c.dataset.at*D;setTimeout(()=>{caps.forEach(x=>x.classList.remove('on'));c.classList.add('on')},at)});
const targets=${JSON.stringify(targets)};
const cur=document.getElementById('cursor'),tip=document.getElementById('tip'),ring=document.getElementById('ring');
targets.forEach(t=>setTimeout(()=>{
  const el=document.querySelector(t.sel); if(!el) return;
  const r=el.getBoundingClientRect(); const x=r.x+r.width/2, y=r.y+Math.min(r.height/2,26);
  cur.style.transform='translate('+x+'px,'+y+'px)';
  ring.style.left=(r.x-6)+'px';ring.style.top=(r.y-6)+'px';ring.style.width=(r.width+12)+'px';ring.style.height=(r.height+12)+'px';ring.style.opacity=1;
  tip.innerHTML='<em>'+(t.kind||'CLICK')+'</em>'+t.text;
  const tx=Math.min(Math.max(r.x,20),1280-440), ty=(r.bottom+14+70>640)?Math.max(r.y-70,70):r.bottom+14;
  tip.style.left=tx+'px';tip.style.top=ty+'px';tip.style.opacity=1;
  if(t.click!==false)setTimeout(()=>{const p=document.createElement('div');p.className='ripple';p.style.left=x+'px';p.style.top=y+'px';document.body.appendChild(p);setTimeout(()=>p.remove(),800);if(t.reveal)document.querySelector(t.reveal)?.classList.add('on')},1000);
  setTimeout(()=>{ring.style.opacity=0;tip.style.opacity=0},t.hold?t.hold*1000:3200);
}, t.f*D));
const typing=${JSON.stringify(typing)};
const eh=(s)=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
typing.forEach(tp=>{
  const root=document.getElementById(tp.id); if(!root) return;
  let t=tp.start*D;
  tp.lines.forEach(l=>{
    const el=document.createElement('div'); el.className='l '+(l.k||'out'); root.appendChild(el); el.style.display='none';
    if(l.k==='cmd'){
      const text=l.t; const perChar=Math.max(8,Math.min(38,(l.dur||900)/text.length));
      const ps='<span class="ps">'+(tp.prompt||'$')+'</span> ';
      setTimeout(()=>{el.style.display='block';let i=0;const iv=setInterval(()=>{i++;el.innerHTML=ps+eh(text.slice(0,i)).replace(/\\{\\{|\\}\\}/g,'');if(i>=text.length){clearInterval(iv);el.innerHTML=ps+eh(text).replace(/\\{\\{(.*?)\\}\\}/g,'<span class="bl">$1</span>')}},perChar)},t);
      t+=perChar*text.length+450;
    } else {
      setTimeout(()=>{el.style.display='block';el.innerHTML=l.h},t);
      t+=l.gap??140;
    }
  });
});
</script>`;
}

const termCss = `<style>
.term{border-radius:12px;background:#0d1117;border:1px solid #30363d;color:#e6edf3;${MONO}font-size:18px;line-height:1.38;padding:0;overflow:hidden;display:flex;flex-direction:column;height:100%}
.term .bar{background:#161b22;color:#8b949e;padding:7px 14px;font-size:15px;letter-spacing:1px;${FONT}border-bottom:1px solid #30363d}
.term .in{padding:14px 18px;flex:1;overflow:hidden}
.term .ps{color:#7ee787}.term .cmd{color:#fff}.term .out{color:#a9b4c0}.term .ok{color:#7ee787}.term .note{color:#ffb000;${FONT};font-size:16px}
.panes{display:flex;gap:16px;height:100%}.panes .term{flex:1}.panes .term{font-size:15.5px}
</style>`;

/** A terminal screen with one or two panes. */
const terminal = (panes) =>
  termCss +
  `<div class="${panes.length > 1 ? 'panes' : ''}" style="height:100%">${panes
    .map((p, i) => `<div class="term"><div class="bar">${esc(p.title)}</div><div class="in" id="t${i}"></div></div>`)
    .join('')}</div>`;
const typingFor = (panes, start = 0.04) =>
  panes.map((p, i) => ({
    id: `t${i}`,
    start,
    prompt: p.prompt ?? '$',
    lines: p.lines.map((l) =>
      l.cmd !== undefined
        ? { k: 'cmd', t: l.cmd, dur: l.dur ?? 1100 }
        : { k: l.k ?? 'out', h: l.note ? `<span class="note">${esc(l.note)}</span>` : blur(l.out), gap: l.gap },
    ),
  }));

// ---- recreated screens (GitHub-style and AWS-style), with placeholder values only -----------------------------------------
const lightCss = `<style>
.win{border-radius:12px;background:#fff;border:1px solid #cdd5e0;box-shadow:0 10px 30px #0003;height:100%;display:flex;flex-direction:column;overflow:hidden;color:#1f2328}
.addr{background:#eef1f6;border-bottom:1px solid #d5dbe4;padding:9px 16px;display:flex;gap:12px;align-items:center;font-size:16px;color:#57606a}
.addr .u{flex:1;background:#fff;border:1px solid #d5dbe4;border-radius:20px;padding:5px 14px}
.ctn{padding:22px 34px;flex:1;overflow:hidden}
h1{font-size:28px;margin:0 0 6px}h3{margin:0 0 6px}
.btn{display:inline-block;border-radius:7px;padding:8px 16px;font-weight:600;font-size:17px;border:1px solid #d0d7de;background:#f6f8fa;color:#24292f}
.btn.g{background:#1f883d;color:#fff;border-color:#1f883d}.btn.r{background:#cf222e;color:#fff;border-color:#cf222e}
.tabs{display:flex;gap:22px;border-bottom:1px solid #d0d7de;margin:12px 0 18px;font-size:17px}.tabs span{padding:8px 2px}.tabs .a{border-bottom:3px solid #fd8c73;font-weight:700}
.row{display:flex;gap:16px;align-items:center;margin:10px 0;font-size:18px}
.f{border:1px solid #d0d7de;border-radius:7px;padding:8px 12px;min-width:260px;background:#fff;font-size:17px}
.muted{color:#57606a;font-size:16px}
table{border-collapse:collapse;width:100%;font-size:17px}td,th{border-bottom:1px solid #d8dee4;padding:9px 10px;text-align:left}
.tag{display:inline-block;border:1px solid #d0d7de;border-radius:20px;padding:1px 10px;font-size:14px;color:#57606a;margin-left:8px}
.card{border:1px solid #d0d7de;border-radius:10px;padding:16px 20px;margin:10px 0;background:#fff}
.aws{background:#232f3e;color:#fff;padding:9px 16px;font-weight:700;display:flex;gap:14px;align-items:center}
.aws b{color:#ff9900}
.steps{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.st{border:1px solid #d0d7de;border-radius:12px;padding:16px 20px;background:#fff}.st h3{font-size:22px}.st p{margin:6px 0 0;color:#444;font-size:18px;line-height:1.35}
.n{display:inline-block;width:30px;height:30px;border-radius:50%;background:#ff9900;color:#111;text-align:center;line-height:30px;font-weight:800;margin-right:10px}
.tick{color:#1a7f37;font-weight:800}
.dlg{border:1px solid #d0d7de;border-radius:12px;padding:18px 22px;background:#fff;box-shadow:0 8px 28px #0003;width:560px}
.sw{display:inline-block;width:44px;height:24px;border-radius:12px;background:#d0d7de;vertical-align:middle;position:relative}.sw::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff}
</style>`;
const win = (url, inner, aws = false) =>
  lightCss +
  `<div class="win"><div class="addr"><span>&#9664; &#9654;</span><span class="u">${esc(url)}</span></div>${aws ? '<div class="aws"><b>aws</b> Console</div>' : ''}<div class="ctn">${inner}</div></div>`;
const bl = (s) => s.replace(/\{\{(.*?)\}\}/g, '<span class="bl">$1</span>');

// ---- the terminals ------------------------------------------------------------------------------------------------------------
const stsPane = {
  title: 'Terminal (the same in bash and PowerShell)',
  lines: [
    { cmd: 'aws sts get-caller-identity' },
    { out: '{' },
    { out: '    "UserId": "{{AIDAEXAMPLEEXAMPLE12}}",' },
    { out: '    "Account": "{{123456789012}}",' },
    { out: '    "Arn": "arn:aws:iam::{{123456789012}}:user/{{your-admin-user}}"' },
    { out: '}' },
  ],
};
const subPane = (title, prompt) => ({
  title,
  prompt,
  lines: [
    { cmd: 'gh api repos/OWNER/REPO/actions/oidc/customization/sub --jq .sub_claim_prefix', dur: 1700 },
    { out: 'repo:OWNER@{{1111111}}/REPO@{{2222222}}' },
    { cmd: 'gh api users/OWNER --jq .id' },
    { out: '{{1111111}}' },
  ],
});
const bootstrapPanes = [
  {
    title: 'bash / macOS / Linux',
    lines: [
      { cmd: 'cd infra/bootstrap && terraform init' },
      { out: '- Installed hashicorp/aws v5.100.0 (signed by HashiCorp)' },
      { out: 'Terraform has been successfully initialized!', k: 'ok' },
      { cmd: 'terraform apply \\\n  -var repository=repo:OWNER@{{1111111}}/REPO@{{2222222}} \\\n  -var actor_id={{1111111}} \\\n  -var workflow_ref=OWNER/REPO/.github/workflows/deploy.yml@refs/heads/main', dur: 3000 },
      { out: 'Plan: 8 to add, 0 to change, 0 to destroy.' },
      { cmd: 'yes', dur: 250 },
      { out: 'Apply complete! Resources: 8 added.', k: 'ok' },
      { out: 'deploy_role_arn = "arn:aws:iam::{{123456789012}}:role/sdlc-github-deploy"' },
      { out: 'state_bucket    = "sdlc-tfstate-{{123456789012}}"' },
    ],
  },
  {
    title: 'PowerShell',
    prompt: 'PS>',
    lines: [
      { cmd: 'cd infra/bootstrap; terraform init' },
      { out: '- Installed hashicorp/aws v5.100.0 (signed by HashiCorp)' },
      { out: 'Terraform has been successfully initialized!', k: 'ok' },
      { cmd: 'terraform apply `\n  -var repository=repo:OWNER@{{1111111}}/REPO@{{2222222}} `\n  -var actor_id={{1111111}} `\n  -var workflow_ref=OWNER/REPO/.github/workflows/deploy.yml@refs/heads/main', dur: 3000 },
      { out: 'Plan: 8 to add, 0 to change, 0 to destroy.' },
      { cmd: 'yes', dur: 250 },
      { out: 'Apply complete! Resources: 8 added.', k: 'ok' },
      { out: 'deploy_role_arn = "arn:aws:iam::{{123456789012}}:role/sdlc-github-deploy"' },
      { out: 'state_bucket    = "sdlc-tfstate-{{123456789012}}"' },
      { note: 'Already have the GitHub provider in this account? terraform import aws_iam_openid_connect_provider.github arn:aws:iam::ACCOUNT:oidc-provider/token.actions.githubusercontent.com' },
    ],
  },
];
const varPanes = [
  {
    title: 'bash / macOS / Linux / PowerShell (the same commands)',
    lines: [
      { cmd: 'gh variable set AWS_DEPLOY_ROLE_ARN --body "arn:aws:iam::{{123456789012}}:role/sdlc-github-deploy"', dur: 1800 },
      { out: '✓ Created variable AWS_DEPLOY_ROLE_ARN for OWNER/REPO', k: 'ok' },
      { cmd: 'gh variable set TF_STATE_BUCKET --body "sdlc-tfstate-{{123456789012}}"', dur: 1500 },
      { cmd: 'gh variable set BOOTSTRAP_ADMIN_EMAIL --body "{{first.admin@example.com}}"', dur: 1500 },
      { cmd: 'gh secret set OPENROUTER_KEY_AGENTS', dur: 1100 },
      { out: '? Paste your secret: ****************' },
      { out: '✓ Set Actions secret OPENROUTER_KEY_AGENTS for OWNER/REPO', k: 'ok' },
    ],
  },
];
const userPanes = [
  {
    title: 'bash / macOS / Linux',
    lines: [
      { cmd: 'POOL_ID=$(aws cognito-idp list-user-pools --max-results 20 --region us-east-1 \\\n  --query "UserPools[?Name==\'sdlc-dev\'].Id" --output text)', dur: 2200 },
      { cmd: 'aws cognito-idp admin-create-user --region us-east-1 --user-pool-id "$POOL_ID" \\\n  --username {{first.admin@example.com}} \\\n  --user-attributes Name=email,Value={{first.admin@example.com}} \\\n  Name=email_verified,Value=true --message-action SUPPRESS', dur: 3200 },
      { cmd: 'aws cognito-idp admin-set-user-password --region us-east-1 \\\n  --user-pool-id "$POOL_ID" --username {{first.admin@example.com}} \\\n  --password {{12-or-more-characters}} --permanent', dur: 2600 },
    ],
  },
  {
    title: 'PowerShell',
    prompt: 'PS>',
    lines: [
      { cmd: '$POOL_ID = aws cognito-idp list-user-pools --max-results 20 --region us-east-1 `\n  --query "UserPools[?Name==\'sdlc-dev\'].Id" --output text', dur: 2200 },
      { cmd: 'aws cognito-idp admin-create-user --region us-east-1 --user-pool-id $POOL_ID `\n  --username {{first.admin@example.com}} `\n  --user-attributes Name=email,Value={{first.admin@example.com}} `\n  Name=email_verified,Value=true --message-action SUPPRESS', dur: 3200 },
      { cmd: 'aws cognito-idp admin-set-user-password --region us-east-1 `\n  --user-pool-id $POOL_ID --username {{first.admin@example.com}} `\n  --password {{12-or-more-characters}} --permanent', dur: 2600 },
    ],
  },
];

const darkCard = (inner) => `<div style="height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;text-align:center;background:radial-gradient(900px 500px at 70% 20%,#17366b 0%,#0b1020 70%);border-radius:14px">${inner}</div>`;

// ---- the beats ----------------------------------------------------------------------------------------------------------------
const beats = [
  {
    id: 'title',
    step: 'START',
    stepTitle: 'Deploy Autonomous SDLC to your own AWS account',
    dark: true,
    say: 'This is a step by step guide to running Autonomous S D L C in your own AWS account. You will make your own copy of the repository, prepare AWS, and start the deploy from GitHub Actions. Plan on one to two hours of work, plus about twenty minutes of waiting for the first deploy. Once it is up, it costs around three dollars thirty a day, plus model fees for every agent run.',
    body: () =>
      darkCard(`<div style="letter-spacing:8px;color:#ffb000;font-weight:700;font-size:22px">STEP BY STEP</div>
<div style="font-size:74px;font-weight:900;margin:10px 0 6px;letter-spacing:-1px">Deploy it to your AWS account</div>
<div style="font-size:30px;color:#b8c7e6">From a copy of the repository to a running platform</div>
<div style="display:flex;gap:18px;margin-top:34px;font-size:26px;font-weight:700"><span style="background:#17366b;padding:10px 20px;border-radius:12px">1 to 2 hours</span><span style="background:#1f5a3a;padding:10px 20px;border-radius:12px">~20 min first deploy</span><span style="background:#7a4a08;padding:10px 20px;border-radius:12px">~$3.30 a day while up</span></div>`),
  },
  {
    id: 'need',
    step: 'BEFORE YOU START',
    stepTitle: 'What you need',
    say: 'You need an AWS account where you are an administrator, a GitHub account, and the AWS command line, Terraform, Git and the GitHub command line installed. You also need an OpenRouter API key for the agents model calls, and a separate GitHub repository for the agents to work on. A domain in Route 53 is optional. Everything on screen uses placeholder values, and on the real pages anything private is blurred.',
    body: () =>
      win(
        'Checklist',
        `<h1>Before you start</h1><div class="steps" style="margin-top:14px">
<div class="st" id="c1"><h3><span class="tick">&#10003;</span> AWS account</h3><p>You are an administrator. Region us-east-1.</p></div>
<div class="st" id="c2"><h3><span class="tick">&#10003;</span> GitHub account</h3><p>For your copy of the platform, and a second repo for the agents to work on.</p></div>
<div class="st" id="c3"><h3><span class="tick">&#10003;</span> Tools</h3><p>AWS CLI, Terraform 1.6+, Git, GitHub CLI (gh), signed in.</p></div>
<div class="st" id="c4"><h3><span class="tick">&#10003;</span> OpenRouter API key</h3><p>For the agents' model calls. Give it a daily credit limit.</p></div>
<div class="st" id="c5" style="grid-column:span 2"><h3><span class="tick">&#10003;</span> Optional: a domain in a Route 53 hosted zone</h3><p>For names like app.example.com and previews.example.com. Without it, you get CloudFront addresses.</p></div></div>`,
      ),
    targets: [
      { sel: '#c1', f: 0.12, text: 'AWS admin access', kind: 'NEED', click: false, hold: 2.6 },
      { sel: '#c3', f: 0.34, text: 'Install these tools', kind: 'NEED', click: false, hold: 2.6 },
      { sel: '#c4', f: 0.52, text: 'Get a key at openrouter.ai', kind: 'NEED', click: false, hold: 2.6 },
    ],
  },
  {
    id: 'aws-account',
    step: 'STEP 1',
    stepTitle: 'An AWS account',
    say: 'Step one, an AWS account. Go to aws dot amazon dot com and create an account. You will give an email, a card and a phone number for verification. Then protect the root user with multi factor authentication, and create an administrator user for everyday work, either with IAM Identity Center, or a plain IAM user. Sign the AWS command line in as that user. Never deploy as the root user.',
    body: () =>
      win(
        'aws.amazon.com',
        `<h1>Set up AWS once</h1><div class="steps" style="margin-top:12px">
<div class="st" id="a1"><h3><span class="n">1</span>Create the account</h3><p>aws.amazon.com, Create an AWS account. Email, card, phone check.</p></div>
<div class="st" id="a2"><h3><span class="n">2</span>Protect the root user</h3><p>Turn on multi-factor authentication. Then stop using root.</p></div>
<div class="st" id="a3"><h3><span class="n">3</span>Create an admin user</h3><p>IAM Identity Center, or an IAM user with the AdministratorAccess policy.</p></div>
<div class="st" id="a4"><h3><span class="n">4</span>Sign the CLI in</h3><p><span style="${MONO}">aws configure sso</span> or <span style="${MONO}">aws configure</span></p></div></div>`,
        true,
      ),
    targets: [
      { sel: '#a1', f: 0.2, text: 'Sign up at aws.amazon.com', kind: 'STEP', click: false, hold: 3 },
      { sel: '#a2', f: 0.4, text: 'MFA on the root user', kind: 'STEP', click: false, hold: 3 },
      { sel: '#a3', f: 0.58, text: 'An admin user for daily work', kind: 'STEP', click: false, hold: 3 },
      { sel: '#a4', f: 0.78, text: 'Sign the CLI in as that user', kind: 'STEP', click: false, hold: 3 },
    ],
  },
  {
    id: 'aws-check',
    step: 'STEP 1',
    stepTitle: 'Check the CLI is signed in',
    dark: true,
    say: 'Check that the command line is signed in to the account you intend to use. The account id and user name are placeholders here, and yours will show your own. Use this same account for everything that follows.',
    body: () => terminal([stsPane]),
    typing: () => typingFor([stsPane]),
  },
  {
    id: 'template',
    step: 'STEP 2',
    stepTitle: 'Make your own copy',
    say: 'Step two, make your own copy. Open the repository on GitHub and press Use this template, then Create a new repository. A fork works too, but a fork of a public repository is public. On a free GitHub plan, a private copy cannot enforce the protections in steps three and five, so use a public copy, or a paid plan.',
    body: () =>
      win(
        'github.com/lrama1/autonomous-sdlc',
        `<h1>lrama1 / autonomous-sdlc <span class="tag">Public template</span></h1><div class="tabs"><span class="a">Code</span><span>Issues</span><span>Pull requests</span><span>Actions</span><span>Settings</span></div>
<div class="row"><span class="btn" id="fork">Fork</span><span class="btn g" id="use">Use this template &#9662;</span></div>
<div id="menu" class="card" style="width:340px;margin-top:6px"><div id="create" style="font-size:18px;padding:6px 0">Create a new repository</div><div class="muted" style="padding:4px 0">Open in a codespace</div></div>
<p class="muted" style="margin-top:20px">AI agents build. People decide. A semi-autonomous software delivery platform that runs in your own AWS account.</p>`,
      ),
    targets: [
      { sel: '#use', f: 0.42, text: 'Click "Use this template"', reveal: '#menu' },
      { sel: '#create', f: 0.68, text: 'Choose "Create a new repository"' },
    ],
  },
  {
    id: 'template2',
    step: 'STEP 2',
    stepTitle: 'Name it and create it',
    say: 'Pick your account, give the repository a name, and choose private if you want it private. Then create the repository, and clone it to your machine.',
    body: () =>
      win(
        'github.com/new',
        `<h1>Create a new repository</h1><p class="muted">Template: lrama1/autonomous-sdlc</p>
<div class="row"><div><div class="muted">Owner</div><div class="f" id="own">YOUR-ACCOUNT</div></div><div><div class="muted">Repository name</div><div class="f" id="nm">my-autonomous-sdlc</div></div></div>
<div class="row" id="vis"><span>&#9673; <b>Private</b></span><span>&#9675; Public</span><span class="muted">Private needs a paid plan for the protections in steps 3 and 5.</span></div>
<div class="row"><span class="btn g" id="mk">Create repository</span></div>
<div class="card" style="${MONO};margin-top:26px"><span class="muted" style="${FONT}">Then, on your machine:</span><br>git clone https://github.com/YOUR-ACCOUNT/my-autonomous-sdlc.git<br>cd my-autonomous-sdlc</div>`,
      ),
    targets: [
      { sel: '#nm', f: 0.2, text: 'Name your copy', kind: 'TYPE', click: false, hold: 2.5 },
      { sel: '#vis', f: 0.4, text: 'Private or public', kind: 'CHOOSE', click: false, hold: 2.8 },
      { sel: '#mk', f: 0.64, text: 'Create repository' },
    ],
  },
  {
    id: 'protect',
    step: 'STEP 3',
    stepTitle: 'Protect main in your copy',
    say: 'Step three, protect main. The deploy role is an AWS administrator, so anyone who can push to main and run the workflow can administer your AWS account. In Settings, Rules, Rulesets, create a ruleset for the main branch. Require a pull request, require the verify status check, block force pushes and deletion, and allow no bypass. Keep the list of people with write access short.',
    body: () =>
      win(
        'github.com/YOUR-ACCOUNT/my-autonomous-sdlc/settings/rules/new',
        `<h1>New branch ruleset</h1>
<div class="row"><div class="f" id="rn" style="min-width:380px">protect-main</div><span class="btn">Enforcement: Active</span></div>
<div class="row"><span class="muted">Target branches:</span><span class="f" id="tg">main</span></div>
<div class="card" id="rules"><div class="row">&#9745; Restrict deletions</div><div class="row">&#9745; Block force pushes</div><div class="row" id="pr">&#9745; Require a pull request before merging</div><div class="row" id="vc">&#9745; Require status checks to pass: <span class="f" style="min-width:90px;padding:3px 10px">verify</span></div></div>
<div class="row"><span class="muted" id="by">Bypass list: empty</span></div><div class="row"><span class="btn g" id="cr">Create</span></div>`,
      ),
    targets: [
      { sel: '#tg', f: 0.3, text: 'Target the main branch', kind: 'SET', click: false, hold: 2.5 },
      { sel: '#pr', f: 0.42, text: 'Require a pull request', kind: 'TICK', click: false, hold: 2.6 },
      { sel: '#vc', f: 0.54, text: 'Require the "verify" check', kind: 'TICK', click: false, hold: 2.6 },
      { sel: '#by', f: 0.7, text: 'No one can bypass', kind: 'CHECK', click: false, hold: 2.4 },
      { sel: '#cr', f: 0.86, text: 'Create the ruleset' },
    ],
  },
  {
    id: 'values',
    step: 'STEP 4',
    stepTitle: 'Bootstrap AWS: read two values',
    dark: true,
    say: 'Step four, bootstrap AWS, once. First read two values. The sign in subject that GitHub puts into tokens for your repository, and your numeric GitHub user id. The role you are about to create will trust only this repository, and only your user. Replace owner and repo with yours.',
    body: () => terminal([subPane('bash / macOS / Linux', '$'), subPane('PowerShell (the same commands)', 'PS>')]),
    typing: () => typingFor([subPane('', '$'), subPane('', 'PS>')]),
  },
  {
    id: 'bootstrap',
    step: 'STEP 4',
    stepTitle: 'Bootstrap AWS: terraform apply',
    dark: true,
    say: 'Now apply the bootstrap. Initialise Terraform, then apply with your values. Terraform plans eight resources: a state bucket, and the deploy role with the GitHub sign in provider. Type yes. The last two options pin the role to your user and to the one deploy workflow file, which I recommend. If your account already has a GitHub sign in provider, import it first. When it finishes, write down the two outputs.',
    body: () => terminal(bootstrapPanes),
    typing: () => typingFor(bootstrapPanes),
  },
  {
    id: 'variables',
    step: 'STEP 5',
    stepTitle: 'Set the repository variables and secret',
    say: 'Step five, in your copy, open Settings, Secrets and variables, Actions. Add the role ARN, the state bucket, and the email of the first person to sign in, as variables. Add your OpenRouter key as a secret. Optionally, set the three domain variables together, or none of them. The values shown are placeholders.',
    body: () =>
      win(
        'github.com/YOUR-ACCOUNT/my-autonomous-sdlc/settings/secrets/actions',
        bl(`<h1>Actions secrets and variables</h1><div class="tabs"><span>Secrets</span><span class="a">Variables</span></div>
<table id="vt"><tr><th>Name</th><th>Value</th></tr>
<tr><td>AWS_DEPLOY_ROLE_ARN</td><td>arn:aws:iam::{{123456789012}}:role/sdlc-github-deploy</td></tr>
<tr><td>TF_STATE_BUCKET</td><td>sdlc-tfstate-{{123456789012}}</td></tr>
<tr><td>BOOTSTRAP_ADMIN_EMAIL</td><td>{{first.admin@example.com}}</td></tr>
<tr id="od"><td>APP_DOMAIN, PREVIEW_DOMAIN, HOSTED_ZONE_ID</td><td class="muted">optional: all three, or none</td></tr></table>
<div class="row" style="margin-top:18px"><span class="btn g" id="nv">New repository variable</span><span class="btn" id="ns">Secrets: OPENROUTER_KEY_AGENTS</span></div>`),
      ),
    targets: [
      { sel: '#vt tr:nth-child(2)', f: 0.22, text: 'The role ARN from the bootstrap', kind: 'VARIABLE', click: false, hold: 2.8 },
      { sel: '#vt tr:nth-child(3)', f: 0.36, text: 'The state bucket', kind: 'VARIABLE', click: false, hold: 2.5 },
      { sel: '#vt tr:nth-child(4)', f: 0.48, text: 'Who signs in first', kind: 'VARIABLE', click: false, hold: 2.5 },
      { sel: '#ns', f: 0.68, text: 'Your OpenRouter key goes in as a secret', kind: 'SECRET', click: false, hold: 3 },
      { sel: '#od', f: 0.86, text: 'Domain variables are optional', kind: 'OPTIONAL', click: false, hold: 3 },
    ],
  },
  {
    id: 'variables-cli',
    step: 'STEP 5',
    stepTitle: 'The same, from the command line',
    dark: true,
    say: 'You can also set them from the command line. The commands are the same in bash and PowerShell. The secret is read from a prompt, so it never appears on screen or in your shell history.',
    body: () => terminal(varPanes),
    typing: () => typingFor(varPanes),
  },
  {
    id: 'environment',
    step: 'STEP 5',
    stepTitle: 'Create the production environment',
    say: 'Create an environment named exactly production. In Settings, Environments, New environment. Add yourself as a required reviewer and allow deployments from the main branch only. The deploy job runs in this environment, and the AWS role trusts only it, so every deploy needs your approval click. Required reviewers on a private repository need a paid GitHub plan.',
    body: () =>
      win(
        'github.com/YOUR-ACCOUNT/my-autonomous-sdlc/settings/environments/new',
        `<h1>production</h1><p class="muted">Configure environment</p>
<div class="card"><div class="row" id="rr">&#9745; <b>Required reviewers</b><span class="f" style="min-width:200px">YOUR-ACCOUNT</span></div></div>
<div class="card"><div class="row" id="db"><b>Deployment branches and tags</b><span class="f" style="min-width:300px">Selected branches: main</span></div></div>
<div class="row"><span class="btn g" id="sv">Save protection rules</span></div>`,
      ),
    targets: [
      { sel: '#rr', f: 0.36, text: 'Add yourself as the reviewer', kind: 'SET', click: false, hold: 3 },
      { sel: '#db', f: 0.54, text: 'Only the main branch may deploy', kind: 'SET', click: false, hold: 3 },
      { sel: '#sv', f: 0.8, text: 'Save protection rules' },
    ],
  },
  {
    id: 'run',
    step: 'STEP 6',
    stepTitle: 'Run the deploy workflow',
    say: 'Step six, deploy. Open the Actions tab, choose deploy, and press Run workflow, on the main branch. Choose action deploy. Turn independent review off if one person will approve everything, and leave the security review on. Press Run workflow.',
    body: () =>
      win(
        'github.com/YOUR-ACCOUNT/my-autonomous-sdlc/actions/workflows/deploy.yml',
        `<h1>deploy</h1><div class="tabs"><span class="a">All workflows</span></div>
<div class="row"><span class="btn" id="rw">Run workflow &#9662;</span></div>
<div class="dlg" id="dlg" style="margin-left:300px;margin-top:-6px">
<div class="muted">Use workflow from: <b>Branch: main</b></div>
<div class="row"><div style="width:260px">action</div><span class="f" style="min-width:150px">deploy</span></div>
<div class="row"><div style="width:260px">independent_review</div><span class="sw"></span><span class="muted">off: work alone</span></div>
<div class="row"><div style="width:260px">security_review</div><span class="f" style="min-width:150px">on</span></div>
<div class="row"><span class="btn g" id="go">Run workflow</span></div></div>`,
      ),
    targets: [
      { sel: '#rw', f: 0.42, text: 'Open "Run workflow"' },
      { sel: '#go', f: 0.78, text: 'Run workflow, on main' },
    ],
  },
  {
    id: 'approve',
    step: 'STEP 6',
    stepTitle: 'Approve, and wait',
    live: 'https://github.com/lrama1/autonomous-sdlc/actions/runs/40142347095',
    scroll: 520,
    say: 'This is a real run of the deploy workflow. It pauses and waits for the reviewer of the production environment. Open the run, press Review deployments, tick production, and approve. Here you can see the approval recorded in the run. The workflow then builds the images, applies the infrastructure, and waits for the platform to answer. It took about twelve minutes.',
  },
  {
    id: 'user',
    step: 'STEP 7',
    stepTitle: 'Create the first sign-in',
    dark: true,
    say: 'Step seven, the first sign in. People cannot sign themselves up, so an admin creates each sign in in Amazon Cognito. Find the user pool, create the user with the email you gave as the bootstrap admin, and set a permanent password of twelve or more characters. In PowerShell, only the first line differs.',
    body: () => terminal(userPanes),
    typing: () => typingFor(userPanes),
  },
  {
    id: 'signin',
    step: 'STEP 8',
    stepTitle: 'Sign in',
    live: 'https://app.agentonomous.com/',
    say: 'Open the platform address, printed in the deploy run summary, or your own domain, and sign in with the email and password you just created. The first admin gets the Platform Admin hat on first sign in, which can make every decision.',
  },
  {
    id: 'apps',
    step: 'STEP 9',
    stepTitle: 'Register the two GitHub Apps',
    live: 'https://app.agentonomous.com/admin/github',
    authed: true,
    blurEmail: true,
    say: 'Step nine, register the two GitHub apps. As the admin, open slash admin slash github on the platform. Register the Agent app, then the Gate app, signed in to GitHub as the account that should own them. Install each one on only the repositories the agents may use. This is the page afterwards: both apps, each installed on one repository. The platform keeps the app keys in Secrets Manager.',
  },
  {
    id: 'repo',
    step: 'STEP 10',
    stepTitle: 'Register the repository the agents will work on',
    say: 'Step ten, prepare the repository the agents will work on. It needs a verify script, a workflow with a job named verify, and a protected main branch that requires that check and one approving review. Then register it in the platform. There is no page for this yet, so, signed in as the admin, paste this into the browser console.',
    body: () =>
      win(
        'Browser console on the platform',
        `<h1>Register the repository</h1><div class="card" id="snip" style="${MONO};font-size:16px;line-height:1.4;background:#0d1117;color:#e6edf3;border-color:#30363d">await fetch('/api/repositories', {<br>&nbsp;&nbsp;method: 'POST',<br>&nbsp;&nbsp;headers: { 'content-type': 'application/json' },<br>&nbsp;&nbsp;body: JSON.stringify({ fullName: 'OWNER/REPO' }),<br>}).then((r) =&gt; r.json());</div>
<div class="card" id="chk"><b>On that repository</b><div class="row">&#9745; npm run verify</div><div class="row">&#9745; a workflow with a job named <span style="${MONO}">verify</span></div><div class="row">&#9745; protected main: require verify and one approving review</div><div class="row">&#9745; both GitHub Apps installed on it</div></div>`,
      ),
    targets: [
      { sel: '#chk', f: 0.3, text: 'Prepare the repository first', kind: 'DO', click: false, hold: 3.5 },
      { sel: '#snip', f: 0.66, text: 'Paste into the console, with your OWNER/REPO', kind: 'PASTE', click: false, hold: 3.5 },
    ],
  },
  {
    id: 'build',
    step: 'STEP 11',
    stepTitle: 'Build something',
    live: 'https://app.agentonomous.com/#/map',
    authed: true,
    blurEmail: true,
    fill: [['Title', 'Harbor Goods online shop'], ['Goal', 'An online shop with a catalog, a cart and checkout, all stored in Amazon DynamoDB.']],
    say: 'Now build something. Open the Map tab, and fill in the new initiative form at the bottom: a title, your registered repository, how much runs on its own, a goal in plain words, and links to any API documentation. Create it, and start the spec. Approve the spec, then the design, then start the build. Expect a few hard stops the first time, where an agent asks you to allow a protected file or a new outside system. That is by design.',
  },
  {
    id: 'destroy',
    step: 'STEP 12',
    stepTitle: 'Stop paying for it',
    say: 'When you are done, run the deploy workflow again with action destroy, and type destroy in the confirmation box. It removes the cluster, the database, the network, and every secret the stack made. Redeploying later starts fresh, so you create the user and register the apps again. The state bucket and the deploy role stay, and you remove them with terraform destroy in the bootstrap folder.',
    body: () =>
      win(
        'github.com/YOUR-ACCOUNT/my-autonomous-sdlc/actions/workflows/deploy.yml',
        `<h1>Run workflow</h1><div class="dlg" style="width:640px">
<div class="row"><div style="width:230px">action</div><span class="f" id="ac" style="min-width:150px">destroy</span></div>
<div class="row"><div style="width:230px">confirm_destroy</div><span class="f" id="cf" style="min-width:150px">destroy</span></div>
<div class="row"><span class="btn r" id="dg">Run workflow</span></div></div>
<div class="card" style="margin-top:22px"><b>Left behind by destroy</b><div class="row">State bucket and deploy role: <span style="${MONO}">terraform destroy</span> in infra/bootstrap</div><div class="row">Your Route 53 hosted zone, if you no longer need it</div></div>`,
      ),
    targets: [
      { sel: '#ac', f: 0.32, text: 'action: destroy', kind: 'CHOOSE', click: false, hold: 2.4 },
      { sel: '#cf', f: 0.48, text: 'Type destroy to confirm', kind: 'TYPE', click: false, hold: 2.6 },
      { sel: '#dg', f: 0.66, text: 'Run workflow, then approve it' },
    ],
  },
  {
    id: 'end',
    step: 'DONE',
    stepTitle: 'You are running Autonomous SDLC',
    dark: true,
    say: 'That is the whole path: a copy of the repository, a prepared AWS account, a protected main branch, and a deploy from GitHub Actions. The README has the same steps in writing, and docs slash ADOPTING has them as a checklist. Thanks for watching.',
    body: () =>
      darkCard(`<div style="font-size:64px;font-weight:900">Autonomous SDLC</div><div style="font-size:30px;color:#b8c7e6;margin-top:10px">github.com/lrama1/autonomous-sdlc</div><div style="font-size:26px;color:#ffb000;margin-top:26px">README and docs/ADOPTING.md have every step in writing</div>`),
  },
];

// ---- recording and assembly ---------------------------------------------------------------------------------------------------
async function record(browser, id, seconds, setup, state) {
  const dir = path.join(WORK, 'rec', id);
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir, size: SIZE }, storageState: state });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await setup(page);
  const left = seconds * 1000 - (Date.now() - t0);
  if (left > 0) await sleep(left);
  const video = page.video();
  await ctx.close();
  const out = path.join(WORK, `${id}.webm`);
  fs.copyFileSync(await video.path(), out);
  return out;
}

/** A real page, with a step badge, captions, and any email address on it blurred. */
async function liveSetup(page, b, D) {
  await page.goto(b.live, { waitUntil: 'domcontentloaded' });
  await sleep(1800);
  await page.addStyleTag({
    content: `html{scroll-padding-top:70px}body{padding-top:62px !important}.__w{position:fixed;z-index:2147483647}
#__b{top:14px;left:20px;display:flex;gap:12px;align-items:center}
#__b b{background:#ffb000;color:#0a1020;font:800 17px Roboto,Arial;letter-spacing:2px;padding:6px 12px;border-radius:8px}
#__b span{font:700 22px Roboto,Arial;color:#fff;background:#0a1020d0;padding:6px 12px;border-radius:8px}
#__c{left:0;right:0;bottom:0;height:84px;display:flex;align-items:center;justify-content:center;padding:0 60px;background:#0a1020ee;color:#fff;font:25px/1.3 Roboto,Arial;text-align:center}`,
  });
  const sentences = b.say.match(/[^.!?]+[.!?]+(\s|$)/g)?.map((s) => s.trim()) ?? [b.say];
  await page.evaluate(
    ([step, title, sents, Dm, blurEmail]) => {
      const badge = document.createElement('div');
      badge.id = '__b';
      badge.className = '__w';
      badge.style.cssText = 'position:fixed;top:14px;left:20px;z-index:2147483647;display:flex;gap:12px;align-items:center;margin:0;padding:6px 10px;background:#0a1020;border-radius:12px;box-shadow:0 4px 16px #000a';
      badge.innerHTML = `<div style="background:#ffb000;color:#0a1020;font:800 17px Roboto,Arial,sans-serif;letter-spacing:2px;padding:6px 12px;border-radius:8px;margin:0;line-height:1.2">${step}</div><div style="font:700 22px Roboto,Arial,sans-serif;color:#fff;background:#0a1020d0;padding:6px 12px;border-radius:8px;margin:0;line-height:1.2">${title}</div>`;
      document.body.appendChild(badge);
      const cap = document.createElement('div');
      cap.id = '__c';
      cap.className = '__w';
      document.body.appendChild(cap);
      const total = sents.reduce((n, s) => n + s.length, 0);
      let acc = 0;
      sents.forEach((s) => {
        const at = (acc / total) * 0.97 * Dm;
        acc += s.length;
        setTimeout(() => (cap.textContent = s), at);
      });
      if (blurEmail) {
        const doBlur = () =>
          document.querySelectorAll('body *').forEach((el) => {
            if (el.children.length === 0 && /[\w.+-]+@[\w-]+\.[\w.]+/.test(el.textContent || '') && !el.closest('#__c')) el.style.filter = 'blur(7px)';
          });
        doBlur();
        setInterval(doBlur, 700);
      }
    },
    [b.step, b.stepTitle, sentences, D * 1000, Boolean(b.blurEmail)],
  );
  for (const [label, text] of b.fill ?? []) {
    const box = page.getByLabel(label).first();
    await box.scrollIntoViewIfNeeded().catch(() => {});
    await box.click().catch(() => {});
    await box.pressSequentially(text, { delay: 45 }).catch(() => {});
    await sleep(600);
  }
  if (b.scroll) {
    const steps = Math.round((D * 1000 * 0.7) / 80);
    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(0, b.scroll / steps);
      await sleep(80);
    }
  }
}

async function main() {
  const outName = process.argv[2] ?? 'howto.mp4';
  const only = process.argv.slice(3);
  const browser = await chromium.launch();
  const state = await freshAuth(browser);
  const parts = [];
  let total = 0;
  for (const b of beats) {
    if (only.length && !only.includes(b.id)) continue;
    const { mp3, sec } = narrate(`h-${b.id}`, b.say);
    const D = sec + 1.2;
    const file = await record(
      browser,
      b.id,
      D + 1,
      async (p) => {
        if (b.live) return liveSetup(p, b, D);
        const html = pageHtml({ step: b.step, stepTitle: b.stepTitle, dark: b.dark, body: b.body(), targets: b.targets ?? [], captions: b.say, D, typing: b.typing ? b.typing() : [] });
        await p.setContent(html);
      },
      b.authed ? state : undefined,
    );
    const seg = path.join(WORK, `${b.id}.mp4`);
    run(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-i', file, '-i', mp3, '-filter_complex', `[0:v]fps=25,scale=1280:720,fade=t=in:st=0:d=0.2,fade=t=out:st=${(D - 0.2).toFixed(2)}:d=0.2[v];[1:a]adelay=500|500,apad[a]`, '-map', '[v]', '-map', '[a]', '-t', D.toFixed(2), '-c:v', 'libx264', '-preset', 'fast', '-crf', '21', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', seg],
      { cwd: WORK },
    );
    console.log(`${b.id}: ${D.toFixed(1)} s`);
    parts.push(seg);
    total += D;
  }
  await browser.close();
  const list = path.join(WORK, 'list.txt');
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'));
  const final = path.join(WORK, outName);
  run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', final]);
  console.log(`${final}: ${total.toFixed(0)} s, ${(fs.statSync(final).size / 1e6).toFixed(1)} MB`);
}

await main();
