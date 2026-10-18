// Some engines (the Copilot CLI, through its Anthropic provider) send no prompt-cache markers, so every call pays for
// the whole prompt again. For a request that has no marker anywhere, the gateway adds them. A client that marks its
// own prompt (Claude Code) is left as it is.

type Block = Record<string, unknown>;
const MARK = { type: 'ephemeral' };

const hasMarker = (v: unknown): boolean =>
  Array.isArray(v)
    ? v.some(hasMarker)
    : v !== null && typeof v === 'object'
      ? 'cache_control' in v || Object.values(v).some(hasMarker)
      : false;

/** Blocks that cannot carry a marker. */
const UNMARKABLE = new Set(['thinking', 'redacted_thinking']);

function markLast(blocks: Block[]): void {
  const last = blocks.at(-1);
  if (last && !UNMARKABLE.has(String(last.type))) last.cache_control = MARK;
}

/**
 * Marks the end of the tools, the end of the system prompt, and the end of the last message. The first two stay the
 * same from call to call. The last one moves forward, so each call reads what the one before wrote.
 * Returns true when it changed the body.
 */
export function addCacheBreakpoints(body: Record<string, unknown>): boolean {
  if (hasMarker(body)) return false;
  let changed = false;

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    markLast(body.tools as Block[]);
    changed = true;
  }

  if (typeof body.system === 'string' && body.system) {
    body.system = [{ type: 'text', text: body.system }];
  }
  if (Array.isArray(body.system) && body.system.length > 0) {
    markLast(body.system as Block[]);
    changed = true;
  }

  const messages = Array.isArray(body.messages) ? (body.messages as Block[]) : [];
  const lastMessage = messages.at(-1);
  if (lastMessage) {
    if (typeof lastMessage.content === 'string' && lastMessage.content) {
      lastMessage.content = [{ type: 'text', text: lastMessage.content }];
    }
    if (Array.isArray(lastMessage.content) && lastMessage.content.length > 0) {
      markLast(lastMessage.content as Block[]);
      changed = true;
    }
  }
  return changed;
}
