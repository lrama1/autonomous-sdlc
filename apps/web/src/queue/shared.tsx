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

/** A review's checks passed: the platform sends `ok`; `passed` is the older name. */
export const checksPassed = (v?: { ok?: boolean; passed?: boolean }) => v?.ok ?? v?.passed ?? null;

export const card = (i: InteractionDto) =>
  i.contextCard as {
    context?: string | null;
    whyNow?: string | null;
    summary?: string;
    kind?: string;
    docs?: string[];
    docsUnknown?: boolean;
    prUrl?: string;
    prNumber?: number;
    triggers?: Array<{ id: string; description?: string }>;
    autoMerge?: { auto: boolean; reason: string };
    verify?: { ok?: boolean; passed?: boolean; attempts?: number };
    diff?: { changedPaths?: string[]; linesChanged?: number };
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
