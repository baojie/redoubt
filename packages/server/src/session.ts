/**
 * One connected client.
 *
 * Holds the input queue, the acknowledgement cursor that drives client-side
 * reconciliation, and the per-client view state that makes delta snapshots
 * possible.
 *
 * The input queue is the subtle part. A client sends input frames at its own
 * frame rate, which is not the server's tick rate and is not steady. Frames
 * are buffered and drained one per tick, so a client that briefly sends faster
 * than 20 Hz does not get to act more often than anyone else, and a client
 * that stutters keeps acting from what it last sent rather than freezing.
 */

import type { Command, PlayerId } from "@redoubt/core";
import { intentToCommand, type Intent } from "@redoubt/protocol";
import { ClientView } from "./snapshot.js";

interface InputFrame {
  seq: number;
  intents: Intent[];
}

/**
 * Cap on buffered frames. A client that floods is not given unbounded server
 * memory; the oldest frames are dropped, since stale input is worthless.
 */
const MAX_QUEUED_FRAMES = 8;

export class Session {
  readonly id: number;
  name = "";
  playerId: PlayerId | null = null;
  joined = false;

  readonly view = new ClientView();

  /** Highest sequence number consumed. Echoed in every snapshot. */
  ackSeq = 0;

  private queue: InputFrame[] = [];
  private highestSeqSeen = 0;

  /** Rolling byte counters, for the bandwidth budget. */
  bytesSent = 0;
  bytesReceived = 0;

  constructor(id: number) {
    this.id = id;
  }

  /**
   * Accept an input frame.
   *
   * Frames that arrive out of order or repeat a sequence already seen are
   * dropped: with ordered transport they should not happen, and accepting them
   * would let a client replay an old action.
   */
  enqueue(seq: number, intents: Intent[]): void {
    if (!Number.isInteger(seq) || seq <= this.highestSeqSeen) return;
    if (!Array.isArray(intents)) return;
    this.highestSeqSeen = seq;
    this.queue.push({ seq, intents });
    while (this.queue.length > MAX_QUEUED_FRAMES) this.queue.shift();
  }

  /**
   * Take the next frame's commands for this tick.
   *
   * If the queue is empty the client has not sent anything new — that is
   * normal and not an error. Their held state (steering direction, standing
   * orders) persists in `core`, which is exactly why those commands are
   * modelled as held state rather than per-tick impulses.
   */
  drain(): Command[] {
    const frame = this.queue.shift();
    if (frame === undefined || this.playerId === null) return [];
    this.ackSeq = frame.seq;

    const commands: Command[] = [];
    for (const intent of frame.intents) {
      const command = intentToCommand(this.playerId, intent);
      // A malformed intent is dropped on its own. One bad field during a
      // reconnect should not cost the client the rest of the frame.
      if (command !== null) commands.push(command);
    }
    return commands;
  }

  /** Drop buffered input — used when the match restarts under the client. */
  clearInput(): void {
    this.queue = [];
    this.ackSeq = 0;
    this.highestSeqSeen = 0;
  }
}
