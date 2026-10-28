import type { ReactNode } from 'react';
import type { InteractionDto } from '@sdlc/schemas';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
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
    failures?: Array<{ attempt: number; why: string }>;
    dependencies?: { added: string[]; namedInDesign: string[]; planned: boolean };
    attempts?: number;
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
  required = false,
  children,
}: {
  title: string;
  testId: string;
  state: string;
  status?: ReactNode;
  /** This check must be dealt with before the change can be approved. */
  required?: boolean;
  children?: ReactNode;
}) {
  return (
    <Paper
      data-testid={testId}
      data-state={state}
      data-required={required}
      tabIndex={-1}
      sx={{
        p: 1.5,
        // A check that stands in the way of approving is marked, so it is not mistaken for an optional one.
        ...(required && {
          borderLeft: 4,
          borderLeftStyle: 'solid',
          borderLeftColor: 'warning.main',
          outline: 0,
        }),
      }}
    >
      <Stack
        direction="row"
        spacing={1}
        sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}
      >
        <Typography variant="subtitle2" component="b">
          {title}
        </Typography>
        {status}
        {required && (
          <Chip
            size="small"
            color="warning"
            label="Required before you can approve"
            data-testid="required-chip"
          />
        )}
      </Stack>
      {children && <Box sx={{ mt: 1 }}>{children}</Box>}
    </Paper>
  );
}
