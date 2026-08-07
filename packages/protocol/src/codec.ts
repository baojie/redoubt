/**
 * Encoding.
 *
 * JSON for now. It is the wrong format eventually — PLAN §4 budgets under
 * 30 KB/s per client and a binary encoding would cut this several-fold — but
 * it is the right format while the message shapes are still moving, because
 * every frame is readable in devtools. `measure()` exists so the moment JSON
 * stops fitting the budget shows up as a number in the diagnostics HUD rather
 * than as a hunch.
 *
 * Positions are quantised to centimetres before encoding. A float64 position
 * costs ~18 characters of JSON and carries about fifteen digits of precision
 * that no renderer and no rule can observe.
 */

import type { ClientMessage, ServerMessage } from "./messages.js";

/** Centimetre precision: far finer than any radius in the rules. */
const POSITION_DECIMALS = 2;

export function quantise(value: number): number {
  return Number(value.toFixed(POSITION_DECIMALS));
}

export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}

/**
 * Parse an untrusted frame.
 *
 * Returns null rather than throwing: a malformed frame is a connection to
 * drop, not a server to crash. Callers must treat the result as unvalidated
 * shape — the server validates every intent against authoritative state
 * anyway, so structural sanity is all that is needed here.
 */
export function decodeClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_CLIENT_FRAME_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const t = (parsed as { t?: unknown }).t;
  if (t !== "join" && t !== "input" && t !== "ping") return null;
  return parsed as ClientMessage;
}

export function decodeServerMessage(raw: string): ServerMessage | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as ServerMessage;
  } catch {
    return null;
  }
}

/**
 * A client frame larger than this is not a legitimate input frame. Capping the
 * size before parsing keeps a hostile peer from making the server allocate.
 */
export const MAX_CLIENT_FRAME_BYTES = 16 * 1024;

/**
 * Byte length of an encoded frame, for the bandwidth budget.
 *
 * TextEncoder rather than Buffer: this module is imported by the browser
 * client as well as the server, and the client is the side that displays the
 * number.
 */
const encoder = new TextEncoder();

export function measure(encoded: string): number {
  return encoder.encode(encoded).length;
}
