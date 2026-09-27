/**
 * VizAdapter — translates YAAH's live NDJSON agent stream into the
 * visualizer's event model.
 *
 * The backend already emits everything the mesh needs
 * (POST /api/agent/{conversation_id}, application/x-ndjson):
 *
 *   YAAH event            ->  viz event
 *   thinking {text}       ->  reasoning.start/delta/end  (source: 'provider' — real model reasoning)
 *   text {text}           ->  reasoning.start/delta/end  (source: 'provider', channel: 'text')
 *   tool_start            ->  tool.start                 (span keyed by tool_call_id)
 *   tool_progress         ->  tool.delta
 *   tool_result           ->  tool.end                   (status ok/error)
 *   approval_request      ->  ask_user.start             (question "Allow <tool>?")
 *   approval_decision     ->  ask_user.answer
 *   tool_start(spawn_agent) -> delegate.spawn
 *   sub_agent_progress    ->  unwrapped inner event, routed to that sub-agent's chain
 *   sub_agent_done        ->  delegate.end
 *   usage                 ->  authoritative token total, attached to turn.end
 *   done / stopped / error -> turn.end
 *
 * The one thing the stream does NOT carry is parentage: reasoning spans have
 * no IDs and tool calls don't name their parent thought. The adapter
 * reconstructs it from stream order, which is the same order the agent loop
 * actually executed in:
 *   - a tool's parent is whatever thought was open when it started
 *   - a new thought's parent is the last finished tool (or the turn root)
 *   - each sub-agent gets its own parent chain, keyed by agent_id
 *
 * Honesty notes:
 *   - Per-thought token counts are ESTIMATES (text length / 4). The only
 *     authoritative number is the turn-level `usage` event, which the
 *     dashboard treats as the source of truth.
 *   - With YAAH's stream, `text` deltas are genuine provider output, so the
 *     visualizer never needs "inferred" (dashed) reasoning nodes here. The
 *     dashed style stays in the engine for providers that don't stream
 *     reasoning at all.
 */

import type { AgentEvent } from '../api';

export interface VizEvent {
  t: number; // seconds since turn start
  kind: string;
  span: string;
  parent?: string;
  agent?: string; // 'root' or 'sub_<agent_id>'
  payload?: Record<string, any>;
}

type Listener = (ev: VizEvent) => void;

interface Chain {
  last: string | null;
  thought: string | null;
  thoughtCh: string | null;
}

const trunc = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n - 1) + '…' : s;

function labelFor(tool: string, args: any): string {
  try {
    if ((tool === 'shell' || tool === 'run') && args?.cmd)
      return trunc(String(args.cmd), 34);
    if (args?.path) return trunc(String(args.path), 34);
    if ((tool === 'web_search' || tool === 'search') && args?.q)
      return trunc(String(args.q), 34);
  } catch {
    /* fall through */
  }
  return tool;
}

function summarize(result: any): string {
  if (result == null) return 'ok';
  if (typeof result === 'string') return trunc(result, 60);
  if (typeof result === 'object') {
    const r = result as Record<string, any>;
    if (r.error != null) return trunc('error: ' + String(r.error), 60);
    if (r.summary != null) return trunc(String(r.summary), 60);
    try {
      return trunc(JSON.stringify(r), 60);
    } catch {
      return 'ok';
    }
  }
  return trunc(String(result), 60);
}

function isError(result: any): boolean {
  return (
    !!result &&
    typeof result === 'object' &&
    (result as Record<string, any>).error != null
  );
}

export class VizAdapter {
  private t0 = 0;
  private n = 0;
  private listeners = new Set<Listener>();
  private history: VizEvent[] = [];
  private chains = new Map<string, Chain>();
  private tools = new Map<string, { span: string; agent: string }>();
  private delegates = new Map<string, { span: string; agent: string }>();
  private approvals = new Map<string, { span: string; agent: string }>();
  private thoughtText = new Map<string, string>();
  private usage = 0;
  private live = true;

  /**
   * Subscribe to viz events. With {replay:true} the full history so far is
   * synchronously re-emitted to the subscriber first — atomic, so a
   * component mounting mid-turn can never miss or double-apply an event.
   */
  subscribe(fn: Listener, opts?: { replay?: boolean }): () => void {
    if (opts?.replay) {
      for (const ev of this.history) fn(ev);
    }
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  snapshot(): VizEvent[] {
    return this.history.slice();
  }

  isLive(): boolean {
    return this.live;
  }

  startTurn(prompt: string): void {
    this.t0 = performance.now();
    this.emit('turn.start', { span: 'turn', payload: { prompt } });
    this.chain('root').last = 'turn';
  }

  onEvent(raw: AgentEvent): void {
    // Unwrap sub-agent progress: the inner `kind` becomes the event type and
    // everything routes into that sub-agent's own parent chain.
    let agent = 'root';
    let e: AgentEvent = raw;
    if (raw.type === 'sub_agent_progress') {
      const r = raw as unknown as Record<string, any>;
      agent = 'sub_' + String(r.agent_id ?? 'x');
      e = { ...(r as object), type: r.kind } as AgentEvent;
    }
    const ev = e as unknown as Record<string, any>;
    const ch = this.chain(agent);

    switch (e.type) {
      case 'thinking':
      case 'text': {
        const text: string = ev.text ?? '';
        if (!text) break;
        if (ch.thought && ch.thoughtCh === e.type) {
          this.thoughtText.set(
            ch.thought,
            (this.thoughtText.get(ch.thought) ?? '') + text,
          );
          this.emit('reasoning.delta', {
            span: ch.thought,
            agent,
            payload: { text },
          });
        } else {
          this.closeThought(agent);
          const span = `th${++this.n}`;
          this.emit('reasoning.start', {
            span,
            parent: ch.last ?? undefined,
            agent,
            payload: { source: 'provider', channel: e.type },
          });
          ch.thought = span;
          ch.thoughtCh = e.type;
          ch.last = span;
          this.thoughtText.set(span, text);
          this.emit('reasoning.delta', {
            span,
            agent,
            payload: { text },
          });
        }
        break;
      }

      case 'tool_start': {
        const tc = String(ev.tool_call_id ?? ev.call_id ?? `t${++this.n}`);
        const name: string = ev.name ?? 'tool';
        this.closeThought(agent);
        if (name === 'spawn_agent') {
          const span = `dl_${tc}`;
          this.delegates.set(tc, { span, agent });
          const a = ev.args ?? {};
          this.emit('delegate.spawn', {
            span,
            parent: ch.last ?? undefined,
            agent,
            payload: {
              task: trunc(String(a.prompt ?? a.agent_type ?? 'subagent'), 44),
            },
          });
          ch.last = span;
        } else {
          const span = `tc_${tc}`;
          this.tools.set(tc, { span, agent });
          this.emit('tool.start', {
            span,
            parent: ch.last ?? undefined,
            agent,
            payload: {
              tool: name,
              label: labelFor(name, ev.args),
              args: ev.args ?? {},
            },
          });
          ch.last = span;
        }
        break;
      }

      case 'tool_progress': {
        const id = String(ev.tool_call_id ?? ev.call_id ?? '');
        const rec = this.tools.get(id);
        if (rec && ev.chunk) {
          this.emit('tool.delta', {
            span: rec.span,
            agent: rec.agent,
            payload: { stream: 'stdout', text: String(ev.chunk) },
          });
        }
        break;
      }

      case 'tool_result': {
        const tc = String(ev.tool_call_id ?? ev.call_id ?? '');
        const rec = this.tools.get(tc);
        if (!rec) break;
        const res = ev.result;
        this.emit('tool.end', {
          span: rec.span,
          agent: rec.agent,
          payload: {
            status: isError(res) ? 'error' : 'ok',
            summary: summarize(res),
          },
        });
        this.chain(rec.agent).last = rec.span;
        this.tools.delete(tc);
        break;
      }

      case 'approval_request': {
        const cid = String(ev.call_id ?? `a${++this.n}`);
        const name: string = ev.name ?? 'tool';
        this.closeThought(agent);
        const span = `ask_${cid}`;
        this.approvals.set(cid, { span, agent });
        this.emit('ask_user.start', {
          span,
          parent: ch.last ?? undefined,
          agent,
          payload: {
            question: `Allow ${name}?`,
            options: ['Allow', 'Deny'],
            call_id: cid,
            tool: name,
            args: ev.args ?? {},
          },
        });
        ch.last = span;
        break;
      }

      case 'approval_decision': {
        const cid = String(ev.call_id ?? '');
        const rec = this.approvals.get(cid);
        if (!rec) break;
        this.emit('ask_user.answer', {
          span: rec.span,
          agent: rec.agent,
          payload: { selected: ev.approved ? 'Allow' : 'Deny' },
        });
        this.chain(rec.agent).last = rec.span;
        this.approvals.delete(cid);
        break;
      }

      case 'sub_agent_spawned':
        // The delegate node was already created by the spawn_agent tool_start.
        break;

      case 'sub_agent_done': {
        const cid = String(ev.call_id ?? '');
        const rec = this.delegates.get(cid);
        if (!rec) break;
        this.emit('delegate.end', {
          span: rec.span,
          agent: rec.agent,
          payload: {
            status: ev.status ?? 'ok',
            summary:
              ev.note ?? (ev.turns != null ? `${ev.turns} turns` : 'done'),
          },
        });
        this.chain(rec.agent).last = rec.span;
        this.delegates.delete(cid);
        break;
      }

      case 'usage': {
        if (typeof ev.usage_tokens === 'number') this.usage = ev.usage_tokens;
        break;
      }

      case 'done':
      case 'stopped': {
        this.closeThought('root');
        this.endOpenTools('error');
        const rch = this.chain('root');
        this.live = false;
        this.emit('turn.end', {
          span: 'final',
          parent: rch.last ?? undefined,
          agent: 'root',
          payload: {
            status: e.type === 'done' ? 'ok' : 'stopped',
            summary: e.type === 'done' ? 'turn complete' : 'stopped by user',
            usage: { reasoning: this.usage },
          },
        });
        break;
      }

      case 'error': {
        this.closeThought('root');
        this.endOpenTools('error');
        const rch = this.chain('root');
        this.live = false;
        this.emit('turn.end', {
          span: 'final',
          parent: rch.last ?? undefined,
          agent: 'root',
          payload: {
            status: 'error',
            summary: String(ev.message ?? 'error'),
            usage: { reasoning: this.usage },
          },
        });
        break;
      }

      default:
        // model_call, title, say, user_injected, queued_autosend, worktree_*,
        // file_changes, git_activity, compacted, compaction_failed — the chat
        // UI owns these; the mesh doesn't need them.
        break;
    }
  }

  // ---- internals ----

  private chain(agent: string): Chain {
    let c = this.chains.get(agent);
    if (!c) {
      c = { last: null, thought: null, thoughtCh: null };
      this.chains.set(agent, c);
    }
    return c;
  }

  private closeThought(agent: string): void {
    const ch = this.chain(agent);
    if (!ch.thought) return;
    const text = this.thoughtText.get(ch.thought) ?? '';
    this.emit('reasoning.end', {
      span: ch.thought,
      agent,
      payload: { token_count: Math.max(1, Math.round(text.length / 4)) },
    });
    this.thoughtText.delete(ch.thought);
    ch.thought = null;
    ch.thoughtCh = null;
  }

  private endOpenTools(status: 'error' | 'ok'): void {
    for (const [tc, rec] of this.tools) {
      this.emit('tool.end', {
        span: rec.span,
        agent: rec.agent,
        payload: { status, summary: status === 'error' ? 'interrupted' : 'ok' },
      });
      this.chain(rec.agent).last = rec.span;
      this.tools.delete(tc);
    }
  }

  private now(): number {
    return this.t0 ? (performance.now() - this.t0) / 1000 : 0;
  }

  private emit(
    kind: string,
    o: { span: string; parent?: string; agent?: string; payload?: any },
  ): VizEvent {
    const ev: VizEvent = { t: this.now(), kind, agent: 'root', ...o };
    this.history.push(ev);
    if (this.history.length > 4000) this.history.shift();
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        /* a dead subscriber must never kill the stream */
      }
    }
    return ev;
  }
}
