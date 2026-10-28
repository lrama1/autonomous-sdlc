import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  AssistantConversationDto,
  AssistantMessageDto,
  AssistantProposalDto,
  AssistantUsageDto,
  BugCreate,
} from '@sdlc/schemas';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import CloseIcon from '@mui/icons-material/Close';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import SendIcon from '@mui/icons-material/Send';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Drawer from '@mui/material/Drawer';
import Fab from '@mui/material/Fab';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Stack from '@mui/material/Stack';
import TextField from '@mui/material/TextField';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import {
  ApiProblem,
  askAssistant,
  createAssistantConversation,
  deleteAssistantConversation,
  getAssistantConversation,
  getAssistantUsage,
  listAssistantConversations,
  reportBug,
  retryBuildTask,
  setAssistantProposal,
  startMainPreview,
} from '../api';
import { contextOf } from './context';

const STARTERS = [
  'What is this screen for?',
  'Explain each element on this screen.',
  'What should I do next here?',
  'Why is something disabled or blocked?',
];

/** Plain text with the little markdown a short answer uses: **bold**, `code`, and lists. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4)
      return <b key={i}>{part.slice(2, -2)}</b>;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2)
      return (
        <Box
          key={i}
          component="code"
          sx={{ fontSize: '0.9em', px: 0.5, bgcolor: 'action.hover', borderRadius: 0.5 }}
        >
          {part.slice(1, -1)}
        </Box>
      );
    return part;
  });
}

export function Rich({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length === 0) return;
    blocks.push(
      <Box component="ul" key={`l${blocks.length}`} sx={{ m: 0, pl: 2.5 }}>
        {list.map((li, i) => (
          <li key={i}>{inline(li)}</li>
        ))}
      </Box>,
    );
    list = [];
  };
  for (const line of text.split('\n')) {
    const item = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item) list.push(item[1]!);
    else {
      flush();
      if (line.trim()) blocks.push(<Box key={`p${blocks.length}`}>{inline(line)}</Box>);
    }
  }
  flush();
  return (
    <Stack spacing={0.75} sx={{ wordBreak: 'break-word' }}>
      {blocks}
    </Stack>
  );
}

function money(micros: number) {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

function Proposal({
  messageId,
  p,
  onChanged,
}: {
  messageId: string;
  p: AssistantProposalDto;
  onChanged: (next: AssistantProposalDto) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const settle = async (state: 'done' | 'dismissed') => {
    await setAssistantProposal(messageId, p.id, state).catch(() => {});
    onChanged({ ...p, state });
  };

  // Each button does what its page would do, as the person, so the usual role checks apply.
  const confirm = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const a = p.params;
      if (p.kind === 'retry_task') await retryBuildTask(String(a.planId), String(a.key));
      else if (p.kind === 'start_preview') await startMainPreview(String(a.initiativeId));
      else if (p.kind === 'file_bug')
        await reportBug(String(a.initiativeId), {
          title: String(a.title ?? ''),
          description: String(a.description ?? ''),
          steps: a.steps ? String(a.steps) : undefined,
          severity: (['low', 'medium', 'high'].includes(String(a.severity))
            ? a.severity
            : 'medium') as BugCreate['severity'],
        });
      else if (p.kind === 'open_screen') window.location.hash = String(a.href);
      await settle('done');
    } catch (e) {
      setProblem(e instanceof ApiProblem ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card variant="outlined" data-testid="assistant-proposal" data-state={p.state}>
      <CardContent sx={{ py: 1.25, '&:last-child': { pb: 1.25 } }}>
        <Typography variant="subtitle2">{p.label}</Typography>
        {p.why && (
          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.75 }}>
            {p.why}
          </Typography>
        )}
        {p.kind === 'file_bug' && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
            {String(p.params.title ?? '')}
          </Typography>
        )}
        {p.state === 'proposed' ? (
          <Stack direction="row" spacing={1}>
            <Button size="small" variant="contained" disabled={busy} onClick={() => void confirm()}>
              {p.kind === 'open_screen' ? 'Open it' : 'Do it'}
            </Button>
            <Button size="small" disabled={busy} onClick={() => void settle('dismissed')}>
              Not now
            </Button>
          </Stack>
        ) : (
          <Chip
            size="small"
            label={p.state === 'done' ? 'Done' : 'Put away'}
            color={p.state === 'done' ? 'success' : 'default'}
          />
        )}
        {problem && (
          <Alert severity="warning" sx={{ mt: 1, py: 0 }}>
            {problem}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

function Message({
  m,
  onProposal,
}: {
  m: AssistantMessageDto;
  onProposal: (messageId: string, next: AssistantProposalDto) => void;
}) {
  const mine = m.role === 'user';
  return (
    <Stack
      spacing={0.75}
      sx={{ alignItems: mine ? 'flex-end' : 'flex-start' }}
      data-testid={`assistant-${m.role}`}
    >
      <Box
        sx={{
          maxWidth: '92%',
          px: 1.5,
          py: 1,
          borderRadius: 2,
          bgcolor: mine ? 'primary.main' : 'action.hover',
          color: mine ? 'primary.contrastText' : 'text.primary',
          fontSize: 14,
        }}
      >
        {mine ? (
          <Box sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.content}</Box>
        ) : (
          <Rich text={m.content} />
        )}
      </Box>
      {m.steps.length > 0 && (
        <Box
          component="details"
          sx={{ maxWidth: '92%', fontSize: 12, color: 'text.secondary' }}
          data-testid="assistant-steps"
        >
          <summary>What I looked at ({m.steps.length})</summary>
          <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
            {m.steps.map((s, i) => (
              <li key={i}>{s.summary}</li>
            ))}
          </Box>
        </Box>
      )}
      {m.proposals.map((p) => (
        <Box key={p.id} sx={{ width: '92%' }}>
          <Proposal messageId={m.id} p={p} onChanged={(next) => onProposal(m.id, next)} />
        </Box>
      ))}
    </Stack>
  );
}

/**
 * The assistant: a button on every page that opens a side panel. It knows which screen the person is on and what it shows,
 * answers about the platform and the initiatives they can see, looks at the built app, and suggests actions that the person
 * confirms with a click. It only reads.
 */
export function AssistantPanel() {
  const [open, setOpen] = useState(false);
  const [usage, setUsage] = useState<AssistantUsageDto | null>(null);
  const [convos, setConvos] = useState<AssistantConversationDto[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [messages, setMessages] = useState<AssistantMessageDto[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const end = useRef<HTMLDivElement | null>(null);
  const skipLoad = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [u, c] = await Promise.all([getAssistantUsage(), listAssistantConversations()]);
      setUsage(u);
      setConvos(c);
      return c;
    } catch {
      return [];
    }
  }, []);

  useEffect(() => {
    void getAssistantUsage()
      .then(setUsage)
      .catch(() => setUsage(null));
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!current) return;
    if (skipLoad.current === current) {
      skipLoad.current = null;
      return;
    }
    void getAssistantConversation(current)
      .then((r) => setMessages(r.messages))
      .catch(() => setMessages([]));
  }, [current]);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [messages, busy, open]);

  if (!usage || !usage.available) return null;

  const send = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      let id = current;
      if (!id) {
        id = (await createAssistantConversation()).id;
        // The messages below are already on screen, so loading the new conversation must not wipe them.
        skipLoad.current = id;
        setCurrent(id);
      }
      // Shown at once, so the person sees it was taken.
      setText('');
      setMessages((m) => [
        ...m,
        {
          id: 'pending',
          role: 'user',
          content: q,
          steps: [],
          proposals: [],
          createdAt: new Date().toISOString(),
        },
      ]);
      const reply = await askAssistant(id, { text: q, context: contextOf() });
      setMessages((m) => [...m.filter((x) => x.id !== 'pending'), reply.user, reply.assistant]);
      setUsage(reply.usage);
      void refresh();
    } catch (e) {
      setMessages((m) => m.filter((x) => x.id !== 'pending'));
      setText(q);
      setProblem(e instanceof ApiProblem ? e.message : 'Could not reach the assistant.');
    } finally {
      setBusy(false);
    }
  };

  const fresh = () => {
    setCurrent(null);
    setMessages([]);
    setProblem(null);
  };

  const remove = async () => {
    if (!current) return;
    await deleteAssistantConversation(current).catch(() => {});
    fresh();
    void refresh();
  };

  const pick = (id: string) => {
    if (!id) return fresh();
    setCurrent(id);
  };

  const onProposal = (messageId: string, next: AssistantProposalDto) =>
    setMessages((all) =>
      all.map((m) =>
        m.id === messageId
          ? { ...m, proposals: m.proposals.map((p) => (p.id === next.id ? next : p)) }
          : m,
      ),
    );

  const left = Math.max(0, usage.capMicros - usage.spentMicros);

  return (
    <>
      <Tooltip title="Open the assistant">
        <Fab
          color="primary"
          aria-label="Open the assistant"
          data-testid="assistant-fab"
          onClick={() => setOpen(true)}
          sx={{ position: 'fixed', right: 24, bottom: 24, zIndex: (t) => t.zIndex.drawer - 1 }}
        >
          <AutoAwesomeOutlinedIcon />
        </Fab>
      </Tooltip>
      <Drawer
        anchor="right"
        open={open}
        onClose={() => setOpen(false)}
        slotProps={{
          paper: {
            sx: { width: { xs: '100%', sm: 440 }, display: 'flex', flexDirection: 'column' },
          },
        }}
      >
        <Stack
          direction="row"
          spacing={1}
          sx={{ alignItems: 'center', p: 1.5, borderBottom: 1, borderColor: 'divider' }}
        >
          <AutoAwesomeOutlinedIcon fontSize="small" />
          <Typography variant="h3" component="h2" sx={{ flexGrow: 1 }}>
            Assistant
          </Typography>
          {convos.length > 0 && (
            <TextField
              select
              size="small"
              value={current ?? ''}
              onChange={(e) => pick(e.target.value)}
              slotProps={{ select: { native: true }, htmlInput: { 'aria-label': 'Conversation' } }}
              sx={{ maxWidth: 150 }}
            >
              <option value="">New chat</option>
              {convos.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title.slice(0, 28)}
                </option>
              ))}
            </TextField>
          )}
          <Button size="small" onClick={fresh} data-testid="assistant-new">
            New chat
          </Button>
          {current && (
            <Tooltip title="Delete this conversation">
              <IconButton
                size="small"
                aria-label="Delete this conversation"
                onClick={() => void remove()}
              >
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <IconButton size="small" aria-label="Close the assistant" onClick={() => setOpen(false)}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>

        <Stack
          spacing={1.5}
          sx={{ flexGrow: 1, overflow: 'auto', p: 1.5 }}
          data-testid="assistant-messages"
        >
          {messages.length === 0 && (
            <Stack spacing={1}>
              <Typography variant="body2" color="text.secondary">
                I know which screen you are on. Ask me what it is for, what a button does, how the
                platform works, or about any initiative you can see. I can also look at the app a
                build produced. I only read: when an action would help, I suggest it and you decide.
              </Typography>
              <Stack direction="row" sx={{ flexWrap: 'wrap', gap: 0.75 }}>
                {STARTERS.map((s) => (
                  <Chip
                    key={s}
                    label={s}
                    variant="outlined"
                    onClick={() => void send(s)}
                    disabled={busy}
                  />
                ))}
              </Stack>
            </Stack>
          )}
          {messages.map((m) => (
            <Message key={m.id} m={m} onProposal={onProposal} />
          ))}
          {busy && (
            <Box data-testid="assistant-working">
              <LinearProgress />
              <Typography variant="caption" color="text.secondary">
                Looking into it. This can take up to a minute.
              </Typography>
            </Box>
          )}
          <div ref={end} />
        </Stack>

        <Box sx={{ p: 1.5, borderTop: 1, borderColor: 'divider' }}>
          {problem && (
            <Alert severity="warning" sx={{ mb: 1 }} data-testid="assistant-problem">
              {problem}
            </Alert>
          )}
          <Stack direction="row" spacing={1} sx={{ alignItems: 'flex-end' }}>
            <TextField
              multiline
              maxRows={5}
              fullWidth
              size="small"
              placeholder="Ask about this screen, the platform, or an initiative"
              slotProps={{ htmlInput: { 'aria-label': 'Ask the assistant' } }}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(text);
                }
              }}
              disabled={busy}
            />
            <IconButton
              color="primary"
              aria-label="Send"
              disabled={busy || !text.trim()}
              onClick={() => void send(text)}
            >
              <SendIcon />
            </IconButton>
          </Stack>
          <Typography
            variant="caption"
            color="text.secondary"
            data-testid="assistant-usage"
            sx={{ display: 'block', mt: 0.5 }}
          >
            An AI can be wrong. Check what matters. {money(left)} of {money(usage.capMicros)} left
            today.
          </Typography>
        </Box>
      </Drawer>
    </>
  );
}
