import type { RealtimeClientConnection } from '@/shared/types.js';

/**
 * Numeric readyState for an open WebSocket connection.
 *
 * We keep this in module state so services that broadcast updates do not need
 * to import `ws` directly just to compare open/closed state.
 */
export const WS_OPEN_STATE = 1;

/**
 * Shared registry of active chat WebSocket connections.
 *
 * Project/session services publish realtime updates by iterating this set.
 */
export const connectedClients = new Set<RealtimeClientConnection>();

/**
 * Sends `payload` (JSON-stringified) only to open connections whose `userId`
 * matches the given `userId`.
 *
 * This is additive alongside unscoped broadcast helpers (e.g.
 * `broadcastCanonicalSessionUpsert`) — those keep sending to every open
 * connection regardless of user. Connections with no resolvable `userId`
 * (unauthenticated, or established on a differently-authed path) simply never
 * match and are skipped, no error is thrown.
 */
export function broadcastToUser(userId: string | number, payload: unknown): void {
  const message = JSON.stringify(payload);

  connectedClients.forEach((client) => {
    if (client.userId === null || client.userId === undefined) {
      return;
    }

    // Ids may be resolved as either string or number depending on auth path
    // (see readRequestUserId in chat-websocket.service.ts); compare loosely
    // by string form so callers don't need to know which type a given
    // connection resolved to.
    if (String(client.userId) !== String(userId)) {
      return;
    }

    if (client.readyState === WS_OPEN_STATE) {
      client.send(message);
    }
  });
}
