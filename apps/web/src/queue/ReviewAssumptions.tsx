import { useState } from 'react';
import type { AssumptionDto } from '@sdlc/schemas';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { ApiProblem, decideAssumption } from '../api';

/** The note under the approve button when assumptions behind the work are still undecided. Never a block. */
export function undecidedNote(n: number): string | null {
  if (n === 0) return null;
  return n === 1
    ? '1 assumption the agent made in this work is still undecided. Approving does not accept it. Decide above if it matters.'
    : `${n} assumptions the agent made in this work are still undecided. Approving does not accept them. Decide above if it matters.`;
}

/**
 * The calls the agent made without asking while it produced this change, with Accept and Reject right here. Approving the
 * change does not decide them, and the reviewer should see them first.
 */
export function ReviewAssumptions({
  assumptions,
  onChanged,
}: {
  assumptions: AssumptionDto[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  if (assumptions.length === 0) return null;
  const decide = async (a: AssumptionDto, verb: 'accept' | 'reject') => {
    setBusy(a.id);
    setProblem(null);
    try {
      await decideAssumption(a.id, verb);
      onChanged();
    } catch (e) {
      setProblem(e instanceof ApiProblem ? e.message : 'Could not record your decision.');
    } finally {
      setBusy(null);
    }
  };
  return (
    <Box data-testid="review-assumptions">
      <Typography
        variant="overline"
        color="text.secondary"
        sx={{ display: 'block', lineHeight: 1.6 }}
      >
        Assumptions made in this work ({assumptions.length} undecided)
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
        The agent chose these without asking. Accepting records that you agree, and later runs on
        this initiative are told. Rejecting asks whoever started the run what to redo.
      </Typography>
      <Stack spacing={0.75} component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {assumptions.map((a) => (
          <Stack
            component="li"
            key={a.id}
            direction="row"
            spacing={1}
            data-testid="review-assumption"
            sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 0.5 }}
          >
            <Typography variant="body2" sx={{ flex: 1, minWidth: 220 }}>
              {a.text}
            </Typography>
            <Button
              size="small"
              variant="outlined"
              disabled={busy === a.id}
              onClick={() => void decide(a, 'accept')}
            >
              Accept
            </Button>
            <Button
              size="small"
              variant="outlined"
              disabled={busy === a.id}
              onClick={() => void decide(a, 'reject')}
            >
              Reject
            </Button>
          </Stack>
        ))}
      </Stack>
      {problem && (
        <Typography variant="body2" color="error" sx={{ mt: 0.5 }}>
          {problem}
        </Typography>
      )}
    </Box>
  );
}
