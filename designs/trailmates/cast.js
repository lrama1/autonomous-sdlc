/* Cast and navigation for the Trailmates example (loaded before ../assets/app.js). */
window.SDLC_CAST = {
  tenant: 'trailmates · single-tenant',
  users: {
    sofia: { n: 'Sofia Alvarez', r: 'Founder · Product Owner',   i: 'SA' },
    ben:   { n: 'Ben Carter',    r: 'Tech Lead',                 i: 'BC' },
    mina:  { n: 'Mina Park',     r: 'Frontend Engineer · QA',    i: 'MP' }
  },
  nav: [
    ['queue',     'Attention queue',         'n5-1-attention-queue.html',   '▣', ['sofia', 'ben', 'mina']],
    ['map',       'Initiatives & map',       'map.html',                    '◈', ['sofia', 'ben', 'mina']],
    ['assump',    'Assumptions & decisions', 'n5-2-assumptions.html',       '☑', ['sofia', 'ben', 'mina']],
    ['autopilot', 'Autopilot & bugs',        'n3-1-autopilot.html',         '⟳', ['sofia', 'ben', 'mina']],
    ['release',   'Releases',                'n4-1-release.html',           '⬆', ['sofia', 'ben', 'mina']],
    ['metrics',   'Interruptions',           'n5-4-interruptions.html',     '◔', ['sofia', 'ben']],
    ['settings',  'Team settings',           'n4-2-settings.html',          '⚙', ['ben']],
    ['connect',   'Connections',             'n6-1-github-connection.html', '⎇', ['ben']]
  ],
  switch: [
    ['sofia', 'Sofia · Founder, Product Owner', 'n1-2-spec-review.html'],
    ['mina',  'Mina · Frontend Eng, QA',        'n2-1-agent-runs.html'],
    ['ben',   'Ben · Tech Lead',                'n2-2-review-pr.html']
  ]
};
