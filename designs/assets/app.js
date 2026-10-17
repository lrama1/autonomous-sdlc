/* Shared shell + tiny helpers for the design mockups. No build step, no dependencies. */
(function () {
  // A scenario folder can define window.SDLC_CAST (users, nav, switch, tenant) before loading this file.
  const CAST = window.SDLC_CAST || {};
  const USERS = CAST.users || {
    priya:  { n: 'Priya Nair',   r: 'Product Owner',        i: 'PN' },
    ethan:  { n: 'Ethan Brooks', r: 'Backend Engineer',     i: 'EB' },
    dana:   { n: 'Dana Okafor',  r: 'Backend Engineer',     i: 'DO' },
    lee:    { n: 'Lee Alvarez',  r: 'QA / Tester',          i: 'LA' },
    sam:    { n: 'Sam Ivanova',  r: 'Quality & Regulatory', i: 'SI' },
    rita:   { n: 'Rita Haddad',  r: 'Release Approver',     i: 'RH' },
    alex:   { n: 'Alex Morgan',  r: 'Auditor (read-only)',  i: 'AM' },
    jordan: { n: 'Jordan Lee',   r: 'Platform Admin',       i: 'JL' }
  };

  const NAV = CAST.nav || [
    ['inbox',   'Inbox',             '03-inbox.html',                 '▣', ['priya', 'ethan', 'dana', 'lee', 'sam', 'rita']],
    ['map',     'Initiatives & map', '06-sdlc-map.html',              '◈', ['priya', 'ethan', 'dana', 'lee', 'sam', 'rita', 'alex']],
    ['trace',   'Traceability',      '09-traceability.html',          '⇄', ['priya', 'ethan', 'dana', 'lee', 'sam', 'rita', 'alex']],
    ['release', 'Releases',          '10-release-authorization.html', '⬆', ['sam', 'rita', 'lee', 'alex']],
    ['audit',   'Audit & evidence',  '12-audit-mode.html',            '⌕', ['sam', 'rita', 'alex']],
    ['agents',  'Agent governance',  '13-agent-governance.html',      '⚙', ['sam', 'lee', 'jordan']],
    ['admin',   'Roles & SoD',       '14-roles-and-sod.html',         '⚖', ['jordan', 'sam']],
    ['strict',  'Strictness & repos', '16-strictness-and-repos.html', '☰', ['jordan', 'sam']]
  ];

  const SWITCH = CAST.switch || [
    ['priya',  'Priya · Product Owner',     '03-inbox.html'],
    ['dana',   'Dana · Backend Eng (sponsor)', '07-agent-session.html'],
    ['ethan',  'Ethan · Backend Eng (reviewer)', '08-review-g3-pull-request.html'],
    ['lee',    'Lee · QA / Tester',         '09-traceability.html'],
    ['sam',    'Sam · Quality & Regulatory', '13-agent-governance.html'],
    ['rita',   'Rita · Release Approver',   '10-release-authorization.html'],
    ['alex',   'Alex · Auditor',            '12-audit-mode.html'],
    ['jordan', 'Jordan · Platform Admin',   '14-roles-and-sod.html']
  ];

  function shell() {
    const b = document.body;
    if (b.dataset.shell === 'none') return;
    const content = document.getElementById('content');
    if (!content) return;
    const key = b.dataset.user || 'priya';
    const u = USERS[key];
    const nav = NAV.filter(n => n[4].includes(key))
      .map(n => `<a href="${n[2]}" class="${b.dataset.nav === n[0] ? 'active' : ''}"><span class="ic">${n[3]}</span>${n[1]}</a>`)
      .join('');
    const opts = SWITCH.map(s => `<option value="${s[2]}" ${s[0] === key ? 'selected' : ''}>${s[1]}</option>`).join('');
    const story = b.dataset.story ? `<span class="story" title="Position in the example story">Story · ${b.dataset.story}</span>` : '';

    const app = document.createElement('div');
    app.className = 'app';
    app.innerHTML = `
      <aside class="sidebar">
        <div class="brand"><div class="logo">◆</div><div>SDLC Platform<div class="small" style="font-weight:400;color:#8c97b2">${CAST.tenant || 'acme-med · single-tenant'}</div></div></div>
        <nav class="nav">${nav}</nav>
        <div class="side-foot">Role-scoped. Notifications only link here. <b>Signing happens in this app.</b></div>
      </aside>
      <div class="main">
        <header class="topbar">
          <div class="crumb">${b.dataset.crumb || ''}</div>
          <div class="right row">
            ${story}
            <select id="persona" title="Jump to another persona's screen">${opts}</select>
            <div class="avatar" title="${u.n}">${u.i}</div>
            <div class="who"><b>${u.n}</b><small>${u.r}</small></div>
          </div>
        </header>
        <div class="page"></div>
      </div>`;
    app.querySelector('.page').appendChild(content);
    b.prepend(app);
    app.querySelector('#persona').addEventListener('change', e => { location.href = e.target.value; });
  }

  function tag() {
    if (document.body.dataset.tag === 'none') return;
    const t = document.createElement('div');
    t.className = 'mock-tag';
    t.textContent = 'Design mockup · sample data · not functional';
    document.body.appendChild(t);
  }

  document.addEventListener('click', e => {
    const t = e.target.closest('[data-tab]');
    if (!t) return;
    const g = t.closest('[data-tabgroup]') || document;
    g.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('active', x === t));
    g.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== t.dataset.tab; });
  });

  document.addEventListener('DOMContentLoaded', () => { shell(); tag(); });
})();
