import type { ReactNode } from 'react';
import type { InteractionDto } from '@sdlc/schemas';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';

export interface Option {
  id: string;
  label: string;
  impact?: string;
}

export const optionsOf = (i: InteractionDto): Option[] =>
  Array.isArray(i.options)
    ? (i.options as Option[]).filter((o) => o && typeof o.id === 'string')
    : [];

export const card = (i: InteractionDto) =>
  i.contextCard as {
    context?: string | null;
    whyNow?: string | null;
    summary?: string;
    kind?: string;
    prUrl?: string;
    prNumber?: number;
    triggers?: Array<{ id: string; description?: string }>;
    autoMerge?: { auto: boolean; reason: string };
    verify?: { passed?: boolean; attempts?: number };
    diff?: { files?: number; additions?: number; deletions?: number };
  };

/** One check on a pull request (preview, smoke test, security review): a title, where it stands, and what can be done. */
export function CheckPanel({
  title,
  testId,
  state,
  status,
  children,
}: {
  title: string;
  testId: string;
  state: string;
  status?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Paper data-testid={testId} data-state={state} sx={{ p: 1.5 }}>
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}
      >
        <Typography variant="subtitle2" component="b">
          {title}
        </Typography>
        {status}
      </Stack>
      {children && <Box sx={{ mt: 1 }}>{children}</Box>}
    </Paper>
  );
}
