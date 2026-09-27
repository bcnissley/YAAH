import { useEffect, useRef } from 'react';
import { createVizEngine, type VizEngine } from './engine';
import type { VizAdapter } from './adapter';
import { submitAnswer } from '../api';

interface VizMeshProps {
  /** Live adapter for this conversation's current (or last) turn. */
  adapter: VizAdapter;
  /** YAAH conversation id — used to route gate answers to the backend. */
  conversationId: number;
  /** Called when a deliverable (OUT-layer final) node is clicked. */
  onDeliverableClick?: () => void;
}

/**
 * VizMesh — the turn-mesh visualizer as a React component.
 *
 * Owns one engine instance per (adapter, conversationId). On mount it
 * replays the adapter's history (so opening the tab mid-turn shows the full
 * turn so far), then subscribes for live events. Gate answers are posted
 * straight to YAAH's existing answer endpoint — no new backend needed.
 */
export function VizMesh({ adapter, conversationId, onDeliverableClick }: VizMeshProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const deliverCb = useRef(onDeliverableClick);
  deliverCb.current = onDeliverableClick;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let engine: VizEngine | null = null;
    try {
      engine = createVizEngine(host, {
        onGateAnswer: (callId, choice) => {
          submitAnswer(conversationId, callId, choice).catch(() => {
            /* the chat's own error surfaces handle failures */
          });
        },
        onDeliverableClick: () => deliverCb.current?.(),
      });
    } catch {
      return;
    }
    const eng: VizEngine = engine;
    const unsub = adapter.subscribe((ev) => eng.applyEvent(ev), { replay: true });
    return () => {
      unsub();
      eng.destroy();
    };
  }, [adapter, conversationId]);

  return (
    <div
      ref={hostRef}
      style={{ height: '100%', minHeight: 480, minWidth: 0 }}
      aria-label="Agent logic mesh"
    />
  );
}
