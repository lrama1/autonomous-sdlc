import type { ReactNode } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import { AgentFlow } from './flow/AgentFlow';

const FEATURES: { title: string; body: string }[] = [
  {
    title: 'Agents do the work',
    body: 'Specialised agents write the spec, design the solution, split it into tasks, build each task in an isolated sandbox, and open pull requests.',
  },
  {
    title: 'People decide',
    body: 'Work stops at checkpoints for the right role: product, architecture, engineering. Nothing important ships without a named person approving it.',
  },
  {
    title: 'Checks before merge',
    body: 'Every pull request can get a live preview, smoke checks the design asked for, and a security review. High and critical findings hold the approval until a person answers.',
  },
  {
    title: 'Autopilot, on your terms',
    body: 'Administrators write rules for what may be approved without a person. Everything else keeps waiting in the queue.',
  },
  {
    title: 'Costs you can see',
    body: 'Each run records model spend. Budgets warn administrators early, and the Costs page breaks spend down by initiative.',
  },
  {
    title: 'Assumptions and bugs',
    body: 'Agents write down what they assumed so people can confirm or correct it. Bugs found later can be sent back through the same flow.',
  },
  {
    title: 'Runs where you want',
    body: 'Locally on Docker, or in your own AWS account with Terraform. Your code and secrets stay in your accounts.',
  },
  {
    title: 'Works with your tools',
    body: 'GitHub for code and reviews, an AI gateway for models, and Slack-style notifications when something needs you.',
  },
];

const STEPS: { title: string; body: ReactNode }[] = [
  { title: 'Start an initiative', body: 'Describe the outcome you want in plain words.' },
  {
    title: 'Agree the spec and design',
    body: 'Agents draft; people review, comment, and approve or send back.',
  },
  {
    title: 'Build in tasks',
    body: 'The plan becomes small tasks, each built, tested, and opened as a pull request.',
  },
  {
    title: 'Review and release',
    body: 'Preview, smoke, and security results sit next to the approval. A person approves; the Gate merges when CI passes.',
  },
];

export function Landing({ signIn }: { signIn: ReactNode }) {
  return (
    <Stack spacing={4}>
      <Box
        sx={{
          display: 'grid',
          gap: 3,
          gridTemplateColumns: { xs: '1fr', md: '1.6fr 1fr' },
          alignItems: 'start',
        }}
      >
        <Box>
          <Typography component="h2" variant="h2" sx={{ fontSize: { xs: 26, md: 32 }, mb: 1 }}>
            Ship software with AI agents, and keep people in charge
          </Typography>
          <Typography color="text.secondary" sx={{ mb: 1.5 }}>
            Autonomous SDLC is a platform that takes an idea through specification, design, build,
            review, and release. Agents do the heavy lifting; people make the decisions that matter,
            at clear checkpoints.
          </Typography>
          <Typography color="text.secondary">
            Every step is recorded: who approved what, what it cost, and what the agents assumed.
          </Typography>
        </Box>
        <Box>{signIn}</Box>
      </Box>

      <Box>
        <Typography component="h2" variant="h2" gutterBottom>
          How work flows
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Agents do the work; people decide at the orange steps.
        </Typography>
        <Card>
          <CardContent>
            <AgentFlow />
          </CardContent>
        </Card>
      </Box>

      <Box>
        <Typography component="h2" variant="h2" gutterBottom>
          From idea to release
        </Typography>
        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(4, 1fr)' },
          }}
        >
          {STEPS.map((s, i) => (
            <Card key={s.title} variant="outlined">
              <CardContent>
                <Typography variant="overline" color="primary">
                  Step {i + 1}
                </Typography>
                <Typography component="h3" variant="h3" gutterBottom>
                  {s.title}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {s.body}
                </Typography>
              </CardContent>
            </Card>
          ))}
        </Box>
      </Box>

      <Box>
        <Typography component="h2" variant="h2" gutterBottom>
          What you get
        </Typography>
        <Box
          sx={{
            display: 'grid',
            gap: 2,
            gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(4, 1fr)' },
          }}
        >
          {FEATURES.map((f) => (
            <Card key={f.title} variant="outlined">
              <CardContent>
                <Typography component="h3" variant="h3" gutterBottom>
                  {f.title}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {f.body}
                </Typography>
              </CardContent>
            </Card>
          ))}
        </Box>
      </Box>

      <Typography variant="body2" color="text.secondary">
        Access is by invitation. Ask your platform administrator if you cannot sign in.
      </Typography>
    </Stack>
  );
}

export function SignInCard() {
  return (
    <Card aria-label="Signed out" sx={{ position: { md: 'sticky' }, top: { md: 88 } }}>
      <CardContent>
        <Typography component="h2" variant="h2" gutterBottom>
          Sign in
        </Typography>
        <Typography gutterBottom>You are not signed in.</Typography>
        <Button variant="contained" component="a" href="/auth/login" data-testid="sign-in">
          Sign in
        </Button>
      </CardContent>
    </Card>
  );
}
