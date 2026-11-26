import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EventKind } from './types.ts';

export interface Normal {
  kind: EventKind;
  data: Record<string, unknown>;
}

const MAX_TEXT = 20_000;

// Heartbeats and progress ticks that carry nothing a person would look back at.
const NOISE = new Set([
  'status',
  'thinking_tokens',
  'session_state_changed',
  'commands_changed',
  'hook_started',
  'hook_progress',
  'hook_response',
  'tool_progress',
  'control_request_progress',
  'background_tasks_changed',
  'command_lifecycle',
]);

export function clip(text: string): { text: string; clipped: boolean } {
  return text.length > MAX_TEXT ? { text: text.slice(0, MAX_TEXT), clipped: true } : { text, clipped: false };
}

/** Turns one SDK message into the history rows the window shows. */
export function normalize(msg: SDKMessage): Normal[] {
  switch (msg.type) {
    case 'assistant':
      return fromAssistant(msg as never);
    case 'user':
      return fromUser(msg as never);
    case 'result':
      return [fromResult(msg as never)];
    case 'rate_limit_event':
      return [{ kind: 'limit', data: { ...(msg as { rate_limit_info: object }).rate_limit_info } }];
    case 'stream_event':
      return [];
    case 'system': {
      const sys = msg as { subtype: string } & Record<string, unknown>;
      if (sys.subtype === 'init') {
        return [
          {
            kind: 'session',
            data: {
              sessionId: sys.session_id,
              model: sys.model,
              tools: sys.tools,
              apiKeySource: sys.apiKeySource,
              version: sys.claude_code_version,
              mcp: sys.mcp_servers,
            },
          },
        ];
      }
      if (NOISE.has(sys.subtype)) return [];
      return [{ kind: 'other', data: { type: 'system', subtype: sys.subtype } }];
    }
    default: {
      const type = (msg as { type: string }).type;
      return NOISE.has(type) ? [] : [{ kind: 'other', data: { type } }];
    }
  }
}

/** Live text while the bee is typing. Shown, not stored. */
export function typingDelta(msg: SDKMessage): string | null {
  if (msg.type !== 'stream_event') return null;
  const ev = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
  return ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' ? (ev.delta.text ?? null) : null;
}

interface Block {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

function fromAssistant(msg: { message: { content: Block[] }; error?: string; parent_tool_use_id?: string | null }): Normal[] {
  const helper = msg.parent_tool_use_id ? { helper: true } : {};
  const out: Normal[] = [];
  for (const b of msg.message.content) {
    if (b.type === 'text' && b.text?.trim()) out.push({ kind: 'say', data: { ...clip(b.text), ...helper } });
    else if (b.type === 'thinking' && b.thinking?.trim()) out.push({ kind: 'think', data: { ...clip(b.thinking), ...helper } });
    else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
      out.push({ kind: 'action', data: { toolUseId: b.id, tool: b.name, input: b.input ?? {}, ...helper } });
    }
  }
  if (msg.error) out.push({ kind: 'error', data: { text: msg.error } });
  return out;
}

function fromUser(msg: { message: { content: string | Block[] } }): Normal[] {
  if (typeof msg.message.content === 'string') return [];
  return msg.message.content
    .filter((b) => b.type === 'tool_result')
    .map((b) => ({
      kind: 'result' as const,
      data: { toolUseId: b.tool_use_id, ok: !b.is_error, ...clip(flatten(b.content)) },
    }));
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content);
  return content.map((c: Block) => (c.type === 'text' ? (c.text ?? '') : `[${c.type}]`)).join('\n');
}

interface ResultLike {
  subtype: string;
  is_error: boolean;
  duration_ms: number;
  num_turns: number;
  total_cost_usd: number;
  usage?: Record<string, number>;
  result?: string;
  errors?: string[];
}

function fromResult(msg: ResultLike): Normal {
  const u = msg.usage ?? {};
  return {
    kind: 'turn',
    data: {
      ok: !msg.is_error && msg.subtype === 'success',
      subtype: msg.subtype,
      ms: msg.duration_ms,
      steps: msg.num_turns,
      tokensIn: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      tokensOut: u.output_tokens ?? 0,
      errors: msg.errors ?? (msg.is_error && msg.result ? [msg.result] : []),
    },
  };
}
