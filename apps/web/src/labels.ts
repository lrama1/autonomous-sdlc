export const ROLE_LABEL: Record<string, string> = {
  product_owner: 'Product Owner',
  architect: 'Architect',
  frontend_engineer: 'Frontend Engineer',
  backend_engineer: 'Backend Engineer',
  qa: 'QA',
  devops_release: 'DevOps / Release',
  security: 'Security',
  platform_admin: 'Platform Admin',
};

/** "backend_engineer" becomes "Backend Engineer". */
export const roleLabel = (role: string | null | undefined): string =>
  role ? (ROLE_LABEL[role] ?? role.replace(/_/g, ' ')) : 'Agent';

const MIN = 60_000;

/** "5 h 40 m", "12 m", "2 d 3 h". */
export function formatSpan(ms: number): string {
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 1) return 'under 1 m';
  if (m < 60) return `${m} m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} m` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

export const percent = (share: number | null): string =>
  share === null ? 'n/a' : `${Math.round(share * 100)}%`;

export const TYPE_LABEL: Record<string, string> = {
  question: 'Question',
  decision: 'Decision request',
  review: 'Review',
  checkpoint: 'Checkpoint',
  notice: 'Notice',
};
