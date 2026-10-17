/* Cast and navigation for the Kestrel Market (e-commerce) example. Loaded before ../assets/app.js. */
window.SDLC_CAST = {
  tenant: 'kestrel · single-tenant',
  users: {
    nadia:  { n: 'Nadia Rahman',  r: 'Product Owner',           i: 'NR' },
    owen:   { n: 'Owen Brooks',   r: 'Architect · Tech Lead',   i: 'OB' },
    lena:   { n: 'Lena Fischer',  r: 'Backend Engineer',        i: 'LF' },
    marcus: { n: 'Marcus Webb',   r: 'Frontend Engineer',       i: 'MW' },
    chloe:  { n: 'Chloe Tan',     r: 'QA Lead',                 i: 'CT' },
    victor: { n: 'Victor Santos', r: 'Security Engineer',       i: 'VS' },
    dmitri: { n: 'Dmitri Volkov', r: 'Release Manager',         i: 'DV' },
    aisha:  { n: 'Aisha Khan',    r: 'Operations · SRE',        i: 'AK' }
  },
  nav: [
    ['portfolio', 'Portfolio',           'portfolio.html',               '▤', ['nadia', 'owen', 'lena', 'marcus', 'chloe', 'victor', 'dmitri', 'aisha']],
    ['map',       'Initiatives & map',   'map.html',                     '◈', ['nadia', 'owen', 'lena', 'marcus', 'chloe', 'victor', 'dmitri', 'aisha']],
    ['controls',  'Product controls',    'controls.html?i=303',          '⚖', ['nadia', 'owen', 'chloe', 'victor']],
    ['release',   'Releases & incidents', 'r-1-release-readiness.html',  '⬆', ['nadia', 'owen', 'chloe', 'victor', 'dmitri', 'aisha']]
  ],
  switch: [
    ['nadia',  'Nadia · Product Owner',      'portfolio.html'],
    ['victor', 'Victor · Security',          'c1-2-pr.html'],
    ['marcus', 'Marcus · Frontend',          'c2-1-agent-runs.html'],
    ['lena',   'Lena · Backend',             'e1-1-merch-agent.html'],
    ['chloe',  'Chloe · QA Lead',            'c2-2-verification.html'],
    ['owen',   'Owen · Architect',           'e2-1-change-request.html'],
    ['dmitri', 'Dmitri · Release Manager',   'r-1-release-readiness.html'],
    ['aisha',  'Aisha · Ops / SRE',          'r-2-incident.html']
  ]
};
