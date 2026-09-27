/**
 * VizEngine — the v2 mesh renderer, refactored as an embeddable factory.
 *
 * Renders into a Shadow DOM (styles can't leak in or out of the host app;
 * pass {useShadow:false} for jsdom tests). Feed it viz events:
 *
 *   const eng = createVizEngine(el, { onGateAnswer: (callId, choice) => ... });
 *   eng.applyEvent(vizEvent);   // live: renders immediately
 *   eng.seek(3.2);              // scrub back: enters replay mode
 *   eng.reset(); eng.destroy();
 *
 * Player model:
 *   - live: events apply the moment they arrive.
 *   - scrubbing back (or REPLAY) enters replay mode; the scrubber plays the
 *     recorded history at the chosen speed. New events arriving mid-replay
 *     extend the history but don't disturb the replay.
 *   - LIVE jumps back to the live edge. PAUSE buffers; resume flushes.
 *   - ask_user gates never pause the mesh — the real agent loop is the thing
 *     that's blocked. The gate shows AWAITING HUMAN until ask_user.answer
 *     arrives; the inspector's buttons call onGateAnswer(callId, choice).
 */
import type { VizEvent } from './adapter';

export interface VizEngineOpts {
  onGateAnswer?: (callId: string, choice: string) => void;
  /** Fired when a deliverable (OUT-layer final) node is clicked. */
  onDeliverableClick?: () => void;
  useShadow?: boolean;
}

export interface VizEngine {
  applyEvent(ev: VizEvent): void;
  seek(t: number): void;
  reset(): void;
  destroy(): void;
}

const svgns = 'http://www.w3.org/2000/svg';
const TOOL_COLORS: Record<string, string> = {
  read_file: '#38bdf8', search: '#a78bfa', shell: '#34d399',
  web_search: '#22d3ee', web_fetch: '#22d3ee', image: '#f472b6',
  edit_file: '#fbbf24', delegate: '#e879f9',
};
const LAYERS = [
  { id: 'INPUT', label: 'INPUT', color: '#38bdf8' },
  { id: 'REASON', label: 'REASON · THOUGHT', color: '#a78bfa' },
  { id: 'GATE', label: 'GATE · DECIDE', color: '#fb923c' },
  { id: 'ACT', label: 'ACT · TOOLS', color: '#fbbf24' },
  { id: 'MESH', label: 'MESH · SUBAGENTS', color: '#e879f9' },
  { id: 'OUT', label: 'OUT · DELIVERABLE', color: '#34d399' },
];
const KIND_LAYER: Record<string, string> = {
  prompt: 'INPUT', thought: 'REASON', ask: 'GATE',
  tool: 'ACT', delegate: 'MESH', final: 'OUT',
};
const NODE_W = 264, NODE_H = 134, MINI_W = 264, MINI_H = 134;
const COL_W = 300, COL_GAP = 30, COL_PAD = 24, COL_TOP = 92, NODE_GAP = 30;
const MESH_COL = 4; // LAYERS index of the MESH column

const esc = (s: any): string =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const trunc = (s: any, n: number): string => {
  s = s == null ? '' : String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

const CSS = `
.vz-root{
  --bg:#18181b; --deep:#09090b; --panel:#101012; --raise:#1c1c1f; --line:#3f3f46;
  --ink:#f4f4f5; --mut:#a1a1aa; --faint:#71717a; --ghost:#52525b;
  --amber:#fbbf24; --orange:#fb923c; --violet:#a78bfa; --fuchsia:#e879f9;
  --blue:#38bdf8; --green:#34d399; --red:#ef4444;
  background:var(--bg); color:var(--ink);
  font-family:ui-monospace,'JetBrains Mono',Consolas,monospace; font-size:12px;
  display:grid; grid-template-rows:auto minmax(0,1fr) auto auto;
  height:100%; overflow:hidden; text-align:left;
}
.vz-head{display:flex;align-items:center;gap:14px;padding:8px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap;}
.brand{font-weight:700;letter-spacing:.14em;font-size:12px;}
.tag{font-size:9px;letter-spacing:.1em;color:var(--ghost);border:1px solid var(--line);border-radius:4px;padding:3px 7px;}
.legend{display:flex;gap:10px;align-items:center;font-size:9px;letter-spacing:.08em;color:var(--faint);}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px;vertical-align:-1px;}
.spacer{flex:1;}
.status{display:flex;align-items:center;gap:8px;font-size:10px;letter-spacing:.12em;}
.dot{width:8px;height:8px;border-radius:50%;background:var(--faint);}
.dot.live{background:var(--amber);animation:blink 1.4s ease-in-out infinite;}
.dot.wait{background:var(--orange);animation:blink .8s ease-in-out infinite;}
.dot.end{background:var(--green);}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.25}}
.ctrl{display:flex;gap:6px;align-items:center;}
.ctrl button,.ctrl select{background:var(--raise);border:1px solid var(--line);color:var(--ink);font:inherit;
  font-size:10px;padding:6px 10px;border-radius:4px;cursor:pointer;letter-spacing:.06em;}
.ctrl button:hover{border-color:var(--faint);}
.ctrl button:disabled{opacity:.4;cursor:default;}
.vz-main{display:grid;grid-template-columns:minmax(0,1fr) 320px;min-height:0;}
#stage{position:relative;min-width:0;border-right:1px solid var(--line);overflow:hidden;
  user-select:none;-webkit-user-select:none;
  background:radial-gradient(1200px 700px at 50% 20%,#101014 0%,var(--deep) 70%);}
#world{position:absolute;left:0;top:0;transform-origin:0 0;user-select:none;-webkit-user-select:none;}
#wires{position:absolute;left:0;top:0;overflow:visible;}
.wire{fill:none;stroke:#9c9ca6;stroke-width:1.4;opacity:.65;}
.wire.live{stroke:var(--amber);opacity:.95;stroke-dasharray:5 6;animation:dashmove .7s linear infinite;}
@keyframes dashmove{to{stroke-dashoffset:-11;}}
.pdot{filter:drop-shadow(0 0 9px #fbbf24) drop-shadow(0 0 3px #fbbf24);}
.raillabel{position:absolute;font-size:10px;letter-spacing:.14em;color:var(--mut);white-space:nowrap;
  background:var(--panel);border:1px solid var(--line);border-radius:5px;padding:7px 10px;z-index:1;}
.raillabel b{color:var(--ink);margin-right:8px;}
.raillabel span{color:var(--ghost);font-size:8px;}
.node{position:absolute;width:190px;background:var(--raise);border:1px solid var(--faint);z-index:1;
  border-radius:6px;cursor:pointer;box-shadow:0 4px 18px rgba(0,0,0,.5);}
.node.mini{width:300px;}
.node:hover{border-width:2px;margin:-1px;}
.node.sel{outline:2px solid var(--ink);outline-offset:2px;}
.node.running{animation:nodeglow 1.6s ease-in-out infinite;}
@keyframes nodeglow{0%,100%{box-shadow:0 0 0 rgba(251,191,36,0),0 4px 18px rgba(0,0,0,.5);}
  50%{box-shadow:0 0 22px rgba(251,191,36,.45),0 4px 18px rgba(0,0,0,.5);}}
.node.error{border-color:var(--red);box-shadow:0 0 18px rgba(239,68,68,.5);}
.nhead{display:flex;justify-content:space-between;align-items:center;gap:8px;
  padding:7px 10px;border-bottom:1px solid;border-radius:5px 5px 0 0;
  font-size:10px;font-weight:700;letter-spacing:.1em;}
.nhead .ntag{font-size:8px;font-weight:400;letter-spacing:.14em;}
.nbody{padding:8px 10px;font-size:9.5px;color:var(--mut);line-height:1.65;min-height:34px;overflow:hidden;}
.nsub{font-size:9.5px;color:var(--mut);line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.nprev{font-size:9.5px;line-height:1.5;color:#71717a;white-space:pre-wrap;word-break:break-word;
  max-height:44px;overflow:hidden;margin:3px 0 4px;
  text-decoration:line-through;text-decoration-color:rgba(113,113,122,.55);
  -webkit-mask-image:linear-gradient(to bottom,#000 55%,transparent 98%);
  mask-image:linear-gradient(to bottom,#000 55%,transparent 98%);}
.nprev:empty{display:none;}
.nbody .ns{color:var(--faint);font-size:8.5px;}
.nbody .ns b{color:var(--mut);font-weight:400;}
.clbox{position:absolute;border:1px dashed rgba(232,121,249,.5);border-radius:10px;z-index:0;
  background:rgba(232,121,249,.04);}
.clabel{position:absolute;top:12px;left:14px;font-size:9px;font-weight:700;letter-spacing:.16em;color:var(--fuchsia);}
#viewctl{position:absolute;top:10px;right:10px;display:flex;gap:6px;z-index:5;}
#viewctl button{background:var(--raise);border:1px solid var(--line);color:var(--ink);font:inherit;
  font-size:10px;padding:5px 9px;border-radius:4px;cursor:pointer;}
#viewctl button.on{border-color:var(--amber);color:var(--amber);}
#inspector{padding:14px;overflow-y:auto;background:var(--bg);min-height:0;}
#inspector h3{margin:0 0 4px;font-size:10px;letter-spacing:.14em;color:var(--faint);font-weight:600;}
.insp-title{font-size:13px;font-weight:700;letter-spacing:.05em;margin:6px 0 2px;}
.insp-sub{font-size:10px;color:var(--mut);margin-bottom:12px;word-break:break-word;}
.kv{display:grid;grid-template-columns:86px 1fr;gap:4px 8px;font-size:10px;margin-bottom:12px;}
.kv dt{color:var(--ghost);letter-spacing:.08em;}
.kv dd{margin:0;color:var(--ink);word-break:break-word;}
.detail{background:var(--deep);border:1px solid var(--line);border-radius:4px;padding:10px;
  font-size:10px;line-height:1.6;color:var(--mut);white-space:pre-wrap;word-break:break-word;
  max-height:300px;overflow-y:auto;margin:0 0 12px;font-family:inherit;}
.chip{display:inline-block;font-size:9px;letter-spacing:.1em;padding:3px 8px;border-radius:4px;margin-bottom:4px;}
.opt{display:block;width:100%;text-align:left;background:var(--raise);border:1px solid var(--orange);
  color:var(--ink);font:inherit;font-size:11px;padding:9px 12px;border-radius:4px;margin:6px 0;cursor:pointer;}
.opt:hover{background:#3a2a1a;}
.howto{font-size:10px;line-height:1.7;color:var(--mut);}
.howto b{color:var(--ink);}
.howto code{color:var(--amber);font-size:9.5px;}
#tlrow{display:flex;align-items:center;gap:10px;padding:7px 16px;border-top:1px solid var(--line);background:var(--bg);}
#scrub{flex:1;accent-color:var(--amber);cursor:pointer;}
#tlabel,#phase{font-size:10px;color:var(--faint);white-space:nowrap;letter-spacing:.06em;}
#dash{display:grid;grid-template-columns:1.7fr 1fr .75fr .85fr 1fr 1fr;gap:1px;background:var(--line);
  border-top:1px solid var(--line);max-height:172px;}
.panel{background:var(--panel);padding:9px 12px;overflow:hidden;min-height:120px;}
.panel h4{margin:0 0 7px;font-size:9px;letter-spacing:.18em;color:var(--ghost);font-weight:600;}
.panel h4 em{float:right;font-style:normal;color:var(--faint);letter-spacing:.06em;}
#flowlog{font-size:9.5px;line-height:1.75;color:var(--mut);}
#flowlog div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.lg-t{color:var(--ghost);} .lg-k{color:var(--amber);} .lg-ok{color:var(--green);} .lg-err{color:var(--red);}
.lg-th{color:var(--mut);} .lg-sub{color:var(--fuchsia);} .lg-ask{color:var(--orange);}
.trow{display:grid;grid-template-columns:86px 1fr 34px;gap:8px;align-items:center;font-size:9px;
  color:var(--mut);margin-bottom:5px;}
.trow .bar{background:#26262b;border-radius:2px;height:7px;overflow:hidden;}
.trow .bar i{display:block;height:100%;background:var(--amber);border-radius:2px;transition:width .3s;}
.trow .n{text-align:right;color:var(--faint);}
.bigtok{font-size:34px;font-weight:700;color:var(--ink);letter-spacing:.04em;line-height:1;}
.toksub{font-size:9px;color:var(--faint);letter-spacing:.1em;margin-top:6px;line-height:1.7;}
.vrow{display:flex;justify-content:space-between;font-size:9.5px;color:var(--mut);margin-bottom:6px;letter-spacing:.08em;}
.vrow b{font-weight:400;}
.lrow{display:grid;grid-template-columns:64px 1fr 30px;gap:8px;align-items:center;font-size:9px;
  color:var(--faint);margin-bottom:5px;letter-spacing:.1em;}
.lrow .bar{background:#26262b;border-radius:2px;height:6px;overflow:hidden;}
.lrow .bar i{display:block;height:100%;border-radius:2px;}
.lrow .n{text-align:right;}
#spark{width:100%;height:44px;display:block;}
.eps{font-size:9px;color:var(--faint);letter-spacing:.1em;margin-top:4px;}
.eps b{color:var(--amber);font-weight:400;}
`;

const TEMPLATE = `
<div class="vz-root">
  <div class="vz-head">
    <span class="brand">TURN MESH</span>
    <span class="tag">LIVE · YAAH STREAM</span>
    <span class="legend" id="legend"></span>
    <span class="spacer"></span>
    <span class="status"><span class="dot" id="sdot"></span><span id="slabel">IDLE</span></span>
    <span class="ctrl">
      <button id="bplay">❚❚ PAUSE</button>
      <button id="brestart">↺ REPLAY</button>
      <button id="blive">● LIVE</button>
      <select id="speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select>
    </span>
  </div>
  <div class="vz-main">
    <div id="stage">
      <div id="world"><svg id="wires" role="img" aria-label="Agent logic mesh"></svg></div>
      <div id="viewctl">
        <button id="vfollow" class="on" title="Follow new nodes">FOLLOW</button>
        <button id="vfit" title="Fit to content">FIT</button>
        <button id="vzin" title="Zoom in">+</button>
        <button id="vzout" title="Zoom out">−</button>
      </div>
    </div>
    <aside id="inspector"><div id="inspbody"></div></aside>
  </div>
  <div id="tlrow">
    <span id="tlabel">T+0.0s</span>
    <input type="range" id="scrub" min="0" max="10" step="0.1" value="0">
    <span id="phase">—</span>
  </div>
  <div id="dash">
    <div class="panel"><h4>// EVENT FLOW <em id="floweps"></em></h4><div id="flowlog"></div></div>
    <div class="panel"><h4>// TOOL PICKS <em>per turn</em></h4><div id="toolbars"></div></div>
    <div class="panel"><h4>// REASONING TOKENS <em>to decide</em></h4>
      <div class="bigtok" id="bigtok">0</div>
      <div class="toksub" id="toksub">provider stream · solid nodes<br>turn total from usage event</div></div>
    <div class="panel"><h4>// GATE VERDICTS <em>ask_user</em></h4><div id="gates"></div></div>
    <div class="panel"><h4>// LAYER STATUS <em>nodes</em></h4><div id="layers"></div></div>
    <div class="panel"><h4>// THROUGHPUT <em>events / sec</em></h4>
      <canvas id="spark" width="300" height="44"></canvas>
      <div class="eps"><b id="epsnow">0.0</b> EV/S · WINDOW 4s</div></div>
  </div>
</div>`;

interface VNode {
  span: string; parent: string | null; agent: string; kind: string;
  title: string; sub: string; color: string; dashed?: boolean;
  status: 'running' | 'done' | 'error'; detail: string;
  t0: number; t1?: number; sub2?: string; layer: string;
  mini: boolean; x: number; y: number; w: number; h: number;
  el: HTMLElement | null; wire: SVGPathElement | null;
}
interface EngineState {
  nodes: Map<string, VNode>; order: VNode[];
  agents: { id: string; task: string; el: HTMLElement | null }[];
  history: VizEvent[]; idx: number; simTime: number; duration: number;
  replaying: boolean; paused: boolean; turnOpen: boolean; started: boolean;
  speed: number; selected: string | null; waitingAsk: VizEvent | null;
  tokens: number; turnTitle: string; contentW: number; contentH: number;
  instant: boolean; toolCounts: Record<string, number>;
  gates: { asked: number; answered: number };
  evTimes: number[]; spark: number[];
}

export function createVizEngine(host: HTMLElement, opts: VizEngineOpts = {}): VizEngine {
  const useShadow = opts.useShadow !== false;
  const root: ShadowRoot | HTMLElement = useShadow
    ? host.shadowRoot ?? host.attachShadow({ mode: 'open' })
    : host;
  root.innerHTML = `<style>${CSS}</style>${TEMPLATE}`;
  const $ = <T extends Element = Element>(sel: string): T | null =>
    root.querySelector(sel) as T | null;

  const stage = $('#stage') as HTMLElement;
  const world = $('#world') as HTMLElement;
  const wires = $('#wires') as unknown as SVGSVGElement;
  const flowlog = $('#flowlog') as HTMLElement;
  const scrub = $('#scrub') as HTMLInputElement;
  const sdot = $('#sdot') as HTMLElement;
  const slabel = $('#slabel') as HTMLElement;
  const tlabel = $('#tlabel') as HTMLElement;
  const phaseEl = $('#phase') as HTMLElement;
  const bplay = $('#bplay') as HTMLButtonElement;

  let S: EngineState;
  let pulses: { el: SVGCircleElement; path: SVGPathElement; len: number; d: number; speed: number; dir: number }[] = [];
  let dead = false;
  const view = { tx: 0, ty: 0, k: 1, follow: true };

  function newState(): EngineState {
    return {
      nodes: new Map(), order: [], agents: [],
      history: [], idx: 0, simTime: 0, duration: 0,
      replaying: false, paused: false, turnOpen: true, started: false,
      speed: 1, selected: null, waitingAsk: null,
      tokens: 0, turnTitle: '', contentW: 1500, contentH: 1150,
      instant: false, toolCounts: {}, gates: { asked: 0, answered: 0 },
      evTimes: [], spark: new Array(40).fill(0),
    };
  }

  /* ---------------- state ---------------- */
  function clearView(): void {
    S.nodes.clear(); S.order = []; S.agents = [];
    S.selected = null; S.waitingAsk = null; S.tokens = 0;
    S.toolCounts = {}; S.gates = { asked: 0, answered: 0 };
    S.evTimes = []; S.spark = new Array(40).fill(0);
    pulses.forEach(p => p.el.remove()); pulses = [];
    world.querySelectorAll('.node,.clbox,.raillabel').forEach(e => e.remove());
    wires.innerHTML = ''; flowlog.innerHTML = '';
    ($('#inspbody') as HTMLElement).innerHTML = '';
    ($('#toolbars') as HTMLElement).innerHTML = '';
    ($('#gates') as HTMLElement).innerHTML = '';
    ($('#layers') as HTMLElement).innerHTML = '';
    ($('#bigtok') as HTMLElement).textContent = '0';
    buildRail();
    view.tx = 0; view.ty = 0; view.k = 1; applyView();
  }

  function reset(): void {
    const keepSpeed = S ? S.speed : 1;
    S = newState(); S.speed = keepSpeed;
    clearView();
    scrub.max = '10'; scrub.value = '0';
    bplay.disabled = false;
    renderInspector(); layout(); updateDash(); updateChrome();
  }

  /* ---------------- event application ---------------- */
  function applyEvent(ev: VizEvent): void {
    if (ev.kind === 'turn.start' && S.started) reset();
    S.history.push(ev);
    if (ev.t > S.duration) {
      S.duration = ev.t;
      scrub.max = S.duration.toFixed(1);
    }
    if (!S.replaying && !S.paused) {
      applyNow(ev); S.idx = S.history.length; S.simTime = ev.t;
    }
    updateChrome();
  }

  function applyNow(ev: VizEvent): void {
    const P = ev.payload || {};
    const agent = ev.agent || 'root';
    S.evTimes.push(performance.now());
    switch (ev.kind) {
      case 'turn.start':
        S.started = true; S.turnTitle = P.prompt || '';
        addNode({
          span: ev.span, parent: null, agent, kind: 'prompt',
          title: 'USER_REQUEST', sub: trunc(P.prompt, 30), color: '#38bdf8',
          detail: 'PROMPT\n' + (P.prompt || ''),
        });
        break;
      case 'reasoning.start': {
        const ch = (P as any).channel === 'text' ? 'TEXT' : 'THOUGHT';
        addNode({
          span: ev.span, parent: ev.parent ?? null, agent, kind: 'thought',
          title: ch,
          sub: (P as any).source === 'inferred' ? 'inferred segmentation' : 'model reasoning',
          color: '#a78bfa', dashed: (P as any).source === 'inferred', detail: '',
        });
        break;
      }
      case 'reasoning.delta':
        appendDetail(ev.span, P.text || '');
        break;
      case 'reasoning.end':
        finishNode(ev.span, 'done', (P.token_count || 0) + ' tok');
        S.tokens += P.token_count || 0;
        break;
      case 'tool.start': {
        const tool = P.tool || 'shell';
        S.toolCounts[tool] = (S.toolCounts[tool] || 0) + 1;
        addNode({
          span: ev.span, parent: ev.parent ?? null, agent, kind: 'tool',
          title: 'TOOL · ' + String(tool).toUpperCase(),
          sub: trunc(P.label || tool, 30), color: TOOL_COLORS[tool] || '#a1a1aa',
          detail: 'ARGS\n' + JSON.stringify(P.args || {}, null, 2),
        });
        break;
      }
      case 'tool.delta':
        appendDetail(ev.span, '\n[' + (P.stream || 'out') + '] ' + (P.text || ''));
        break;
      case 'tool.end':
        finishNode(ev.span, P.status === 'error' ? 'error' : 'done', P.summary || P.status);
        appendDetail(ev.span, '\n— ' + String(P.status || '').toUpperCase() + ' · ' + (P.summary || ''));
        break;
      case 'delegate.spawn':
        S.agents.push({ id: agent, task: P.task || '', el: null });
        addNode({
          span: ev.span, parent: ev.parent ?? null, agent: 'root', kind: 'delegate',
          title: 'SPAWN_AGENT', sub: trunc(P.task, 30), color: '#e879f9',
          detail: 'TASK\n' + (P.task || ''),
        });
        break;
      case 'delegate.end':
        finishNode(ev.span, 'done', P.summary || 'done');
        appendDetail(ev.span, '\n— ' + (P.summary || ''));
        break;
      case 'ask_user.start':
        S.gates.asked++;
        addNode({
          span: ev.span, parent: ev.parent ?? null, agent, kind: 'ask',
          title: 'ASK_USER · GATE', sub: trunc(P.question, 30), color: '#fb923c',
          detail: 'QUESTION\n' + (P.question || '') +
            '\n\nOPTIONS\n' + (P.options || []).join('\n') +
            (P.call_id ? '\n\nCALL_ID\n' + P.call_id : ''),
        });
        // The real agent loop is what blocks on the gate — the mesh never
        // pauses. Buttons below hand the verdict back via onGateAnswer.
        onAskStart(ev);
        break;
      case 'ask_user.answer':
        S.waitingAsk = null; S.gates.answered++;
        finishNode(ev.span, 'done', '✓ ' + (P.selected || ''));
        appendDetail(ev.span, '\n— verdict: ' + (P.selected || ''));
        break;
      case 'turn.end': {
        const u = (P.usage || {}) as Record<string, number>;
        if (typeof u.reasoning === 'number' && u.reasoning > 0) {
          // The usage event is authoritative; per-thought counts are estimates.
          S.tokens = u.reasoning;
        }
        addNode({
          span: ev.span, parent: ev.parent ?? null, agent: 'root', kind: 'final',
          title: 'DELIVERABLE', sub: trunc(P.summary, 30), color: '#34d399',
          detail: 'SUMMARY\n' + (P.summary || '') + '\n\nUSAGE\n' + JSON.stringify(P.usage || {}, null, 2),
        });
        finishNode(ev.span, P.status === 'error' ? 'error' : 'done');
        S.turnOpen = false;
        break;
      }
    }
    logLine(ev); updateDash();
  }

  function onAskStart(ev: VizEvent): void {
    S.waitingAsk = ev;
    select(ev.span);
    updateChrome();
  }

  function addNode(o: {
    span: string; parent: string | null; agent: string; kind: string;
    title: string; sub: string; color: string; dashed?: boolean; detail: string;
  }): VNode {
    const n: VNode = {
      status: 'running', t0: S.simTime,
      // Subagent internals live in the MESH column inside their cluster box,
      // no matter their kind — the column shows *where* work happens.
      layer: o.agent !== 'root' ? 'MESH' : KIND_LAYER[o.kind] || 'REASON',
      mini: o.agent !== 'root' && o.kind !== 'delegate',
      x: 0, y: 0, w: 0, h: 0, el: null, wire: null,
      ...o,
    } as VNode;
    S.nodes.set(n.span, n); S.order.push(n);
    drawNode(n);
    if (n.parent && S.nodes.get(n.parent)) drawWire(n);
    layout(); updateChrome(); updateDash();
    return n;
  }

  function appendDetail(span: string, text: string): void {
    const n = S.nodes.get(span); if (!n) return;
    n.detail += text;
    const pv = n.el ? n.el.querySelector('[data-prev]') : null;
    if (pv) pv.textContent = previewText(n);
    if (S.selected === span) renderInspector();
  }

  // Card preview: a few faded lines of the node's live text. The full
  // detail stays one click away in the inspector.
  function previewText(n: VNode): string {
    let d = (n.detail || '').replace(/^\s+/, '')
      .replace(/^(ARGS|PROMPT|SUMMARY|QUESTION|TASK)\n/, '');
    return d.slice(0, 400);
  }

  function finishNode(span: string, status: 'running' | 'done' | 'error', sub?: string): void {
    const n = S.nodes.get(span); if (!n) return;
    n.status = status;
    if (sub !== undefined) n.sub2 = sub;
    n.t1 = S.simTime;
    paintNode(n); paintWire(n); updateChrome(); updateDash();
    if (S.selected === span) renderInspector();
    // Truthful pulse: the result travels back along the wire to the parent
    // that issued the call. No ambient decoration — every pulse is an event.
    if (n.wire && (n.kind === 'tool' || n.kind === 'ask' || n.kind === 'delegate')) {
      spawnPulse(n.wire, '#fbbf24', true);
    }
  }

  /* ---------------- layout: swimlane columns ---------------- */
  function colX(li: number): number { return COL_PAD + li * (COL_W + COL_GAP); }

  function buildRail(): void {
    LAYERS.forEach((L, i) => {
      const d = root.ownerDocument!.createElement('div');
      d.className = 'raillabel';
      d.innerHTML = '<b>' + L.id + '</b><span>' + esc((L.label.split('·')[1] || '').trim()) + '</span>';
      d.style.left = colX(i) + 'px';
      d.style.top = '18px';
      d.style.width = COL_W + 'px';
      d.style.borderLeft = '3px solid ' + L.color;
      world.appendChild(d);
      (L as any)._el = d;
    });
  }

  function layout(): void {
    // One column per pipeline layer; nodes stack in creation (time) order.
    let maxY = COL_TOP;
    LAYERS.forEach((L, li) => {
      const x = colX(li);
      let y = COL_TOP;
      S.order.forEach(n => {
        if (n.layer !== L.id) return;
        n.w = n.mini ? MINI_W : NODE_W;
        n.h = n.mini ? MINI_H : NODE_H;
        n.x = x + (COL_W - n.w) / 2;
        n.y = y;
        y += n.h + NODE_GAP;
      });
      maxY = Math.max(maxY, y);
    });
    // Subagent cluster boxes wrap their members inside the MESH column.
    S.agents.forEach(a => {
      const members = S.order.filter(n => n.agent === a.id);
      if (!members.length) return;
      if (!a.el) {
        const box = root.ownerDocument!.createElement('div');
        box.className = 'clbox'; world.appendChild(box);
        const lb = root.ownerDocument!.createElement('div');
        lb.className = 'clabel'; box.appendChild(lb); a.el = box;
      }
      const first = members[0], last = members[members.length - 1];
      const bx = colX(MESH_COL) - 10, bw = COL_W + 20;
      const by = first.y - 36, bh = (last.y + last.h + 12) - by;
      a.el.style.transform = 'translate(' + bx + 'px,' + by + 'px)';
      a.el.style.width = bw + 'px';
      a.el.style.height = Math.max(bh, 60) + 'px';
      (a.el.querySelector('.clabel') as HTMLElement).textContent =
        'SUBAGENT · ' + trunc(a.task, 34).toUpperCase();
      maxY = Math.max(maxY, by + bh);
    });
    S.contentW = COL_PAD * 2 + LAYERS.length * COL_W + (LAYERS.length - 1) * COL_GAP;
    S.contentH = maxY + 90;
    wires.setAttribute('width', String(S.contentW));
    wires.setAttribute('height', String(S.contentH));
    S.order.forEach(n => {
      if (n.el) n.el.style.transform = 'translate(' + n.x + 'px,' + n.y + 'px)';
      if (n.wire) n.wire.setAttribute('d', edgePath(n));
    });
    if (view.follow && !S.replaying && S.order.length) followLatest();
  }

  function edgePath(n: VNode): string {
    const p = n.parent ? S.nodes.get(n.parent) : undefined;
    if (!p || !p.el) return '';
    const pc = LAYERS.findIndex(L => L.id === p.layer);
    const nc = LAYERS.findIndex(L => L.id === n.layer);
    if (pc === nc || pc < 0 || nc < 0) {
      // Same column: vertical drop from parent bottom to child top.
      const x1 = p.x + p.w / 2, y1 = p.y + p.h, x2 = n.x + n.w / 2, y2 = n.y;
      const dy = Math.max(28, (y2 - y1) / 2);
      return 'M' + x1 + ' ' + y1 + ' C' + x1 + ' ' + (y1 + dy) + ' ' + x2 + ' ' + (y2 - dy) + ' ' + x2 + ' ' + y2;
    }
    // Cross-column: exit the edge facing the child's column.
    const ltr = nc > pc, s = ltr ? 1 : -1;
    const x1 = ltr ? p.x + p.w : p.x, y1 = p.y + p.h / 2;
    const x2 = ltr ? n.x : n.x + n.w, y2 = n.y + n.h / 2;
    const dx = Math.max(36, Math.abs(x2 - x1) / 2);
    return 'M' + x1 + ' ' + y1 + ' C' + (x1 + s * dx) + ' ' + y1 + ' ' +
      (x2 - s * dx) + ' ' + y2 + ' ' + x2 + ' ' + y2;
  }

  /* ---------------- render ---------------- */
  function statusColor(n: VNode): string {
    return n.status === 'running' ? '#fbbf24' : n.status === 'error' ? '#ef4444' : '#34d399';
  }

  function drawNode(n: VNode): void {
    const doc = root.ownerDocument!;
    const d = doc.createElement('div');
    d.className = 'node' + (n.mini ? ' mini' : '');
    d.dataset.span = n.span;
    d.style.width = (n.mini ? MINI_W : NODE_W) + 'px';
    d.style.height = (n.mini ? MINI_H : NODE_H) + 'px';
    if (n.dashed) d.style.borderStyle = 'dashed';
    d.innerHTML =
      '<div class="nhead" style="background:' + n.color + '1f;border-color:' + n.color + '66">' +
      '<span>' + esc(n.title) + '</span><span class="ntag" style="color:' + n.color + '">' + esc(n.layer) + '</span></div>' +
      '<div class="nbody"><div class="nsub">' + esc(n.sub || '') + '</div>' +
      '<div class="nprev" data-prev></div><div class="ns" data-stat></div></div>';
    d.addEventListener('click', e => {
      e.stopPropagation();
      select(n.span);
      // Deliverable node → hand back to chat view.
      if (n.kind === 'final' && opts.onDeliverableClick) opts.onDeliverableClick();
    });
    world.appendChild(d); n.el = d; paintNode(n);
  }

  function paintNode(n: VNode): void {
    if (!n.el) return;
    const sc = statusColor(n);
    n.el.classList.toggle('running', n.status === 'running');
    n.el.classList.toggle('error', n.status === 'error');
    n.el.classList.toggle('sel', S.selected === n.span);
    let stat = '';
    if (n.kind === 'thought') stat = n.status === 'running' ? 'streaming…' : '<b>' + esc(n.sub2 || '') + '</b>';
    else if (n.kind === 'tool') stat = n.status === 'running' ? 'running…' :
      '<b>' + esc(n.sub2 || '') + '</b>' + (n.t1 !== undefined ? ' · ' + Math.max(0.1, n.t1 - n.t0).toFixed(1) + 's' : '');
    else if (n.kind === 'ask') stat = n.status === 'running' ? '<b style="color:#fb923c">AWAITING HUMAN</b>' : '<b>' + esc(n.sub2 || '') + '</b>';
    else if (n.kind === 'delegate') stat = n.status === 'running' ? 'spawning…' : '<b>' + esc(n.sub2 || '') + '</b>';
    else if (n.kind === 'final') stat = '<b>' + esc(n.sub || '') + '</b>';
    const st = n.el.querySelector('[data-stat]');
    if (st) st.innerHTML = stat;
    const pv = n.el.querySelector('[data-prev]');
    if (pv) pv.textContent = previewText(n);
    void sc;
  }

  function drawWire(n: VNode): void {
    const p = root.ownerDocument!.createElementNS(svgns, 'path') as SVGPathElement;
    p.setAttribute('class', 'wire'); p.dataset.span = n.span;
    wires.appendChild(p); n.wire = p; paintWire(n);
    spawnPulse(p, '#fbbf24');
  }

  function paintWire(n: VNode): void {
    if (!n.wire) return;
    n.wire.setAttribute('d', edgePath(n));
    const live = n.status === 'running';
    n.wire.classList.toggle('live', live);
    n.wire.style.stroke = live ? n.color : '';
  }

  function spawnPulse(path: SVGPathElement, color: string, reverse = false): void {
    if (S.instant || !path || pulses.length > 30) return;
    let len = 0;
    try { len = (path as any).getTotalLength(); } catch { return; }
    if (!len) return;
    const c = root.ownerDocument!.createElementNS(svgns, 'circle') as SVGCircleElement;
    c.setAttribute('r', '5'); c.setAttribute('class', 'pdot');
    c.style.color = color; c.style.fill = color;
    wires.appendChild(c);
    pulses.push({ el: c, path, len, d: reverse ? len : 0, speed: len / 1.05, dir: reverse ? -1 : 1 });
  }

  function pulseFrame(): void {
    if (dead) return;
    for (let i = pulses.length - 1; i >= 0; i--) {
      const pu = pulses[i]; pu.d += (pu.dir * pu.speed) / 60;
      if (pu.d >= pu.len || pu.d <= 0) { pu.el.remove(); pulses.splice(i, 1); continue; }
      try {
        const pt = (pu.path as any).getPointAtLength(pu.d);
        pu.el.setAttribute('cx', pt.x); pu.el.setAttribute('cy', pt.y);
      } catch { pu.el.remove(); pulses.splice(i, 1); }
    }
    requestAnimationFrame(pulseFrame);
  }

  /* ---------------- view (pan/zoom) ---------------- */
  function applyView(): void {
    world.style.transform = 'translate(' + view.tx + 'px,' + view.ty + 'px) scale(' + view.k + ')';
  }
  function fitView(): void {
    const r = stage.getBoundingClientRect();
    if (r.width < 10) return;
    const k = Math.min(r.width / S.contentW, r.height / S.contentH, 1.35);
    view.k = k; view.tx = (r.width - S.contentW * k) / 2; view.ty = 12;
    applyView();
  }
  function setFollow(v: boolean): void {
    view.follow = v;
    const b = $('#vfollow') as HTMLButtonElement | null;
    if (b) b.classList.toggle('on', v);
  }
  // Follow mode now only *pans* to keep the newest node in frame — it never
  // touches your zoom. Any manual zoom/pan disengages it (see wireView).
  function followLatest(): void {
    const n = S.order[S.order.length - 1];
    if (!n || !n.el) return;
    const r = stage.getBoundingClientRect();
    if (r.width < 10) return;
    const cx = (n.x + n.w / 2) * view.k + view.tx;
    const cy = (n.y + n.h / 2) * view.k + view.ty;
    const m = 80;
    let dx = 0, dy = 0;
    if (cx < m) dx = m - cx; else if (cx > r.width - m) dx = r.width - m - cx;
    if (cy < m) dy = m - cy; else if (cy > r.height - m) dy = r.height - m - cy;
    if (dx || dy) { view.tx += dx; view.ty += dy; applyView(); }
  }

  /* ---------------- player ---------------- */
  let timer: ReturnType<typeof setInterval> | null = null;

  function setPaused(p: boolean): void {
    S.paused = p;
    bplay.textContent = p ? '▶ RESUME' : '❚❚ PAUSE';
    if (!p && !S.replaying) {
      // flush buffered live events instantly, in order
      while (S.idx < S.history.length) applyNow(S.history[S.idx++]);
      S.simTime = S.duration;
    }
    updateChrome();
  }

  function goLive(): void {
    S.replaying = false; S.paused = false;
    bplay.textContent = '❚❚ PAUSE'; bplay.disabled = false;
    while (S.idx < S.history.length) applyNow(S.history[S.idx++]);
    S.simTime = S.duration;
    layout(); updateChrome(); updateDash(); renderInspector();
  }

  function tick(): void {
    if (dead || S.paused || !S.replaying) return;
    S.simTime += 0.12 * S.speed;
    while (S.idx < S.history.length && S.history[S.idx].t <= S.simTime) {
      applyNow(S.history[S.idx++]);
    }
    if (S.simTime >= S.duration && S.idx >= S.history.length) {
      if (S.turnOpen) goLive();
      else { S.replaying = false; S.paused = false; bplay.textContent = '❚❚ PAUSE'; }
    }
    updateChrome();
  }

  function seek(t: number): void {
    t = Math.max(0, Math.min(t, S.duration));
    const keepSpeed = S.speed;
    clearView();
    S.speed = keepSpeed; S.instant = true;
    S.idx = 0;
    while (S.idx < S.history.length && S.history[S.idx].t <= t) {
      applyNow(S.history[S.idx++]);
    }
    S.instant = false; S.simTime = t;
    S.replaying = t < S.duration - 0.01 || S.turnOpen;
    S.paused = false;
    bplay.textContent = '❚❚ PAUSE';
    bplay.disabled = false;
    layout(); updateChrome(); updateDash(); renderInspector();
  }

  /* ---------------- log / chrome ---------------- */
  const KIND_CLS: Record<string, string> = {
    'turn.start': 'lg-k', 'turn.end': 'lg-ok',
    'reasoning.start': 'lg-th', 'reasoning.delta': 'lg-th', 'reasoning.end': 'lg-th',
    'tool.start': 'lg-k', 'tool.delta': 'lg-k', 'tool.end': 'lg-ok',
    'delegate.spawn': 'lg-sub', 'delegate.end': 'lg-sub',
    'ask_user.start': 'lg-ask', 'ask_user.answer': 'lg-ask',
  };
  function logLine(ev: VizEvent): void {
    const P = ev.payload || {};
    let label = ev.kind;
    if (ev.kind === 'tool.start') label += ' ' + P.tool + ' · ' + (P.label || '');
    if (ev.kind === 'tool.end') label += ' → ' + (P.status || '') + ' · ' + (P.summary || '');
    if (ev.kind === 'reasoning.end') label += ' · ' + (P.token_count || 0) + ' tok';
    if (ev.kind === 'delegate.spawn') label += ' ' + ev.agent + ' · ' + (P.task || '');
    if (ev.kind === 'ask_user.start') label += ' · ' + (P.question || '');
    if (ev.kind === 'ask_user.answer') label += ' → ' + (P.selected || '');
    if (ev.kind === 'turn.start') label += ' · "' + trunc(P.prompt || '', 36) + '"';
    if (ev.kind === 'turn.end') label += ' · ' + (P.summary || '');
    const d = root.ownerDocument!.createElement('div');
    d.innerHTML = '<span class="lg-t">[' + S.simTime.toFixed(1) + 's]</span> <span class="' +
      (KIND_CLS[ev.kind] || 'lg-k') + '">' + esc(label) + '</span>';
    if (ev.kind === 'tool.end' && P.status === 'error')
      (d.querySelector('span:last-child') as HTMLElement).className = 'lg-err';
    flowlog.appendChild(d);
    while (flowlog.children.length > 9) flowlog.removeChild(flowlog.firstChild!);
  }

  function updateChrome(): void {
    let n = 0, edges = 0;
    S.nodes.forEach(x => { n++; if (x.parent) edges++; });
    tlabel.textContent = 'T+' + S.simTime.toFixed(1) + 's · NODES ' + n + ' · EDGES ' + edges;
    const active = root.ownerDocument!.activeElement;
    if (active !== scrub) scrub.value = String(S.simTime);
    phaseEl.textContent = S.turnTitle ? '“' + trunc(S.turnTitle, 44) + '”' : '—';
    let cls = 'dot', txt = 'IDLE';
    if (S.waitingAsk) { cls = 'dot wait'; txt = 'WAITING · AGENT ASKS'; }
    else if (!S.turnOpen && !S.replaying) { cls = 'dot end'; txt = 'ENDED'; }
    else if (S.replaying) { txt = 'REPLAY'; }
    else if (S.paused) { txt = 'PAUSED'; }
    else if (S.started) { cls = 'dot live'; txt = 'LIVE'; }
    sdot.className = cls; slabel.textContent = txt;
  }

  /* ---------------- dashboard ---------------- */
  function dashRow(k: string, v: string | number, c: string): string {
    return '<div class="vrow"><span>' + k + '</span><b style="color:' + c + '">' + v + '</b></div>';
  }
  function updateDash(): void {
    ($('#bigtok') as HTMLElement).textContent = String(S.tokens);
    const tb = $('#toolbars') as HTMLElement;
    const entries = Object.entries(S.toolCounts).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...entries.map(e => e[1]));
    tb.innerHTML = entries.length ? entries.map(([t, c]) =>
      '<div class="trow"><span>' + esc(t) + '</span><span class="bar"><i style="width:' +
      Math.round(c / max * 100) + '%;background:' + (TOOL_COLORS[t] || '#a1a1aa') + '"></i></span><span class="n">' + c + '</span></div>'
    ).join('') : '<div style="font-size:9px;color:var(--ghost)">— no tool calls yet —</div>';
    const g = $('#gates') as HTMLElement;
    const w = S.gates.asked - S.gates.answered;
    g.innerHTML =
      dashRow('ASKED', S.gates.asked, '#fb923c') +
      dashRow('ANSWERED', S.gates.answered, '#34d399') +
      dashRow('WAITING', w, w ? '#fbbf24' : '#52525b') +
      '<div style="font-size:8.5px;color:var(--ghost);margin-top:8px;letter-spacing:.08em">HUMAN-IN-THE-LOOP<br>GATE BEFORE ACT</div>';
    const lr = $('#layers') as HTMLElement;
    const counts: Record<string, number> = {};
    LAYERS.forEach(L => (counts[L.id] = 0));
    S.order.forEach(x => { counts[x.layer] = (counts[x.layer] || 0) + 1; });
    const cmax = Math.max(1, ...Object.values(counts));
    lr.innerHTML = LAYERS.map(L =>
      '<div class="lrow"><span style="color:' + L.color + '">' + L.id + '</span>' +
      '<span class="bar"><i style="width:' + Math.round(counts[L.id] / cmax * 100) + '%;background:' + L.color + '"></i></span>' +
      '<span class="n">' + counts[L.id] + '</span></div>').join('');
  }

  function tickSpark(): void {
    if (dead) return;
    const now = performance.now();
    S.evTimes = S.evTimes.filter(t => now - t < 4000);
    const eps = S.evTimes.length / 4;
    S.spark.push(eps); S.spark.shift();
    ($('#epsnow') as HTMLElement).textContent = eps.toFixed(1);
    ($('#floweps') as HTMLElement).textContent = eps.toFixed(1) + ' ev/s';
    const cv = $('#spark') as HTMLCanvasElement | null;
    if (!cv) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    const W = cv.width, H = cv.height;
    ctx.clearRect(0, 0, W, H);
    const max = Math.max(2, ...S.spark);
    ctx.beginPath();
    S.spark.forEach((v, i) => {
      const x = i / (S.spark.length - 1) * W, y = H - 3 - (v / max) * (H - 8);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    });
    ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1.6; ctx.stroke();
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    ctx.fillStyle = 'rgba(251,191,36,.12)'; ctx.fill();
  }

  /* ---------------- inspector ---------------- */
  function select(span: string | null): void {
    S.selected = span;
    S.order.forEach(n => { if (n.el) n.el.classList.toggle('sel', n.span === span); });
    renderInspector();
  }

  const KIND_LABEL: Record<string, string> = {
    prompt: 'USER PROMPT', thought: 'THOUGHT', tool: 'TOOL CALL',
    delegate: 'SUBAGENT SPAWN', ask: 'AGENT QUESTION', final: 'TURN RESULT',
  };
  function renderInspector(): void {
    const b = $('#inspbody') as HTMLElement;
    const n = S.selected ? S.nodes.get(S.selected) : null;
    if (!n) {
      b.innerHTML = '<h3>INSPECTOR</h3><div class="howto">' +
        '<b>Select any node</b> to inspect its span.<br><br>' +
        'Nodes stack in <b>pipeline layers</b> — INPUT → REASON → GATE → ACT → MESH → OUT.<br><br>' +
        'Built from the live YAAH stream:<br>' +
        '· <code>thinking</code> — the model\'s real reasoning deltas<br>' +
        '· <code>tool_start/result</code> — tool calls, keyed by call id<br>' +
        '· <code>approval_request/decision</code> — human gates<br>' +
        '· <code>sub_agent_*</code> — subagent clusters<br><br>' +
        'One span = one node. Parentage is reconstructed from stream order: ' +
        'a tool hangs off the thought that was open when it started.</div>';
      return;
    }
    const sc = n.status === 'running' ? '#fbbf24' : n.status === 'error' ? '#ef4444' : '#34d399';
    let btns = '';
    if (n.kind === 'ask' && n.status === 'running' && S.waitingAsk && S.waitingAsk.span === n.span) {
      const callId = (S.waitingAsk.payload || {}).call_id;
      const options: string[] = (S.waitingAsk.payload || {}).options || [];
      if (callId && opts.onGateAnswer) {
        btns = '<h3 style="margin-top:12px">ANSWER THE GATE</h3>' + options.map(o =>
          '<button class="opt" data-opt="' + esc(o) + '">' + esc(o) + '</button>').join('');
        setTimeout(() => {
          b.querySelectorAll('.opt').forEach(btn =>
            (btn as HTMLButtonElement).onclick = () =>
              opts.onGateAnswer!(String(callId), (btn as HTMLButtonElement).dataset.opt || ''));
        }, 0);
      }
    }
    b.innerHTML = '<h3>INSPECTOR</h3>' +
      '<span class="chip" style="background:' + n.color + '22;color:' + n.color + ';border:1px solid ' + n.color + '66">' +
      (KIND_LABEL[n.kind] || n.kind) + '</span> ' +
      '<span class="chip" style="background:#27272a;color:' + sc + ';border:1px solid #3f3f46">' +
      n.status.toUpperCase() + '</span>' +
      '<div class="insp-title">' + esc(n.title) + '</div>' +
      '<div class="insp-sub">' + esc(n.sub || '') + '</div>' +
      '<dl class="kv"><dt>SPAN</dt><dd>' + esc(n.span) + '</dd>' +
      '<dt>PARENT</dt><dd>' + esc(n.parent || '—') + '</dd>' +
      '<dt>AGENT</dt><dd>' + esc(n.agent) + '</dd>' +
      '<dt>LAYER</dt><dd>' + esc(n.layer) + '</dd>' +
      '<dt>STARTED</dt><dd>T+' + n.t0.toFixed(1) + 's</dd>' +
      (n.t1 !== undefined ? '<dt>DURATION</dt><dd>' + Math.max(0.1, n.t1 - n.t0).toFixed(1) + 's</dd>' : '') +
      '</dl>' +
      '<h3>DETAIL</h3><pre class="detail">' + esc(n.detail || '(streaming…)') + '</pre>' + btns;
  }

  /* ---------------- wiring ---------------- */
  function wireView(): void {
    let drag: { x: number; y: number; tx: number; ty: number } | null = null;
    let downAt: { x: number; y: number } | null = null;
    let downOnNode = false;
    let swallowClick = false;
    stage.addEventListener('pointerdown', e => {
      if ((e.target as HTMLElement).closest('#viewctl')) return;
      downAt = { x: e.clientX, y: e.clientY };
      downOnNode = !!(e.target as HTMLElement).closest('.node');
      // No pointer capture here: capturing on pointerdown would retarget the
      // click to the stage and break node selection. Capture only on a drag.
    });
    stage.addEventListener('pointermove', e => {
      if (!downAt) return;
      if (!drag) {
        if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 5) return;
        drag = { x: downAt.x, y: downAt.y, tx: view.tx, ty: view.ty };
        stage.style.cursor = 'grabbing';
        setFollow(false); // manual pan takes the camera
        try { stage.setPointerCapture(e.pointerId); } catch { /* noop */ }
        // Don't let the browser start a text selection while panning.
        if (!downOnNode) e.preventDefault();
      }
      view.tx = drag.tx + (e.clientX - drag.x);
      view.ty = drag.ty + (e.clientY - drag.y);
      applyView();
    });
    const endDrag = () => {
      if (drag) swallowClick = true; // don't deselect after a pan
      drag = null; downAt = null; downOnNode = false;
      stage.style.cursor = '';
    };
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('wheel', e => {
      e.preventDefault();
      setFollow(false); // manual zoom takes the camera
      const r = stage.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      const k2 = view.k * (e.deltaY < 0 ? 1.12 : 0.89);
      view.tx = mx - (mx - view.tx) * (k2 / view.k);
      view.ty = my - (my - view.ty) * (k2 / view.k);
      view.k = k2; applyView();
    }, { passive: false });
    stage.addEventListener('click', e => {
      if (swallowClick) { swallowClick = false; return; }
      if (!(e.target as HTMLElement).closest('.node')) select(null);
    });
    ($('#vfit') as HTMLButtonElement).onclick = () => { fitView(); setFollow(true); };
    ($('#vzin') as HTMLButtonElement).onclick = () => { setFollow(false); view.k = view.k * 1.2; applyView(); };
    ($('#vzout') as HTMLButtonElement).onclick = () => { setFollow(false); view.k = view.k / 1.2; applyView(); };
    const vfollow = $('#vfollow') as HTMLButtonElement;
    vfollow.onclick = () => setFollow(!view.follow);

    bplay.onclick = () => {
      if (!S.turnOpen && !S.replaying && S.idx >= S.history.length) { seek(0); return; }
      setPaused(!S.paused);
    };
    ($('#brestart') as HTMLButtonElement).onclick = () => seek(0);
    ($('#blive') as HTMLButtonElement).onclick = () => goLive();
    ($('#speed') as HTMLSelectElement).onchange = e =>
      { S.speed = parseFloat((e.target as HTMLSelectElement).value); };
    scrub.addEventListener('change', () => {
      const t = parseFloat(scrub.value);
      seek(t);
    });
    scrub.addEventListener('input', () => {
      tlabel.textContent = 'T+' + parseFloat(scrub.value).toFixed(1) + 's · SCRUBBING';
    });
  }

  /* ---------------- boot / teardown ---------------- */
  const legend = $('#legend') as HTMLElement;
  legend.innerHTML = [['THOUGHT', '#a78bfa'], ['GATE', '#fb923c'], ['TOOL', '#fbbf24'],
    ['MESH', '#e879f9'], ['I/O', '#34d399']]
    .map(([t, c]) => '<span><i style="background:' + c + '"></i>' + t + '</span>').join('');

  S = newState();
  clearView();
  wireView();
  renderInspector(); layout(); updateDash(); updateChrome();
  timer = setInterval(tick, 120);
  const sparkTimer = setInterval(tickSpark, 500);
  requestAnimationFrame(pulseFrame);

  function destroy(): void {
    dead = true;
    if (timer) clearInterval(timer);
    clearInterval(sparkTimer);
    pulses.forEach(p => p.el.remove()); pulses = [];
    if (useShadow && host.shadowRoot) host.shadowRoot.innerHTML = '';
    else host.innerHTML = '';
  }

  return { applyEvent, seek, reset, destroy };
}
