import { VizAdapter } from './adapter';

/**
 * Module-level registry of live viz adapters, keyed by conversation key
 * (String(conversationId), matching ChatPanel's bufKey convention).
 *
 * The adapter is created when a turn starts (see the stream tap in
 * ChatPanel) and deliberately NOT deleted when the turn ends, so the Mesh
 * tab keeps session-scoped replay. History inside the adapter is capped at
 * 4000 events; a new turn replaces the old adapter for that conversation.
 */
const map = new Map<string, VizAdapter>();

export const vizRegistry = {
  get(key: string): VizAdapter | undefined {
    return map.get(key);
  },
  set(key: string, a: VizAdapter): void {
    map.set(key, a);
  },
  delete(key: string): void {
    map.delete(key);
  },
};
