/* Cast and navigation for the Harbor Retirement example (loaded before ../assets/app.js). */
window.SDLC_CAST = {
  tenant: 'harbor-ret · single-tenant',
  users: {
    maya:   { n: 'Maya Patel',   r: 'Product Owner',               i: 'MP' },
    carlos: { n: 'Carlos Diaz',  r: 'Backend Engineer',            i: 'CD' },
    hannah: { n: 'Hannah Wright', r: 'Backend Engineer',           i: 'HW' },
    tessa:  { n: 'Tessa Moore',  r: 'QA / Tester',                 i: 'TM' },
    elena:  { n: 'Elena Rossi',  r: 'Compliance & Risk',           i: 'ER' },
    tariq:  { n: 'Tariq Ahmed',  r: 'Security',                    i: 'TA' },
    grace:  { n: 'Grace Lin',    r: 'Release Approver',            i: 'GL' },
    rachel: { n: 'Rachel Stone', r: 'Internal Audit (read-only)',  i: 'RS' },
    kevin:  { n: 'Kevin Park',   r: 'Platform Admin',              i: 'KP' }
  },
  nav: [
    ['map',     'Initiatives & map',  'map.html',                        '◈', ['maya', 'carlos', 'hannah', 'tessa', 'elena', 'tariq', 'grace', 'rachel']],
    ['trace',   'Traceability',       'j3-1-traceability.html',          '⇄', ['maya', 'carlos', 'hannah', 'tessa', 'elena', 'tariq', 'grace', 'rachel']],
    ['release', 'Releases',           'j4-2-release.html',               '⬆', ['tariq', 'grace', 'elena', 'tessa', 'rachel']],
    ['audit',   'Audit & evidence',   'j5-2-audit.html',                 '⌕', ['elena', 'grace', 'rachel']],
    ['strict',  'Strictness & repos', 'j5-1-strictness-promotion.html',  '☰', ['kevin', 'elena']]
  ],
  switch: [
    ['maya',   'Maya · Product Owner',            'j1-2-review-g1.html'],
    ['carlos', 'Carlos · Backend Eng (sponsor)',  'j2-1-agent-session.html'],
    ['hannah', 'Hannah · Backend Eng (reviewer)', 'j2-2-review-pr.html'],
    ['tessa',  'Tessa · QA / Tester',             'j3-1-traceability.html'],
    ['tariq',  'Tariq · Security',                'j4-1-security-review.html'],
    ['grace',  'Grace · Release Approver',        'j4-2-release.html'],
    ['elena',  'Elena · Compliance & Risk',       'j4-3-emergency.html'],
    ['kevin',  'Kevin · Platform Admin',          'j5-1-strictness-promotion.html'],
    ['rachel', 'Rachel · Internal Audit',         'j5-2-audit.html']
  ]
};
