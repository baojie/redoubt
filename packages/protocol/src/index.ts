/**
 * @redoubt/protocol — what crosses the socket.
 *
 * Depends on `core` for entity id and enum types, and on nothing else. Both
 * the server and the browser client import it, so it must stay free of Node
 * APIs and of anything either side considers private.
 */

export * from "./messages.js";
export * from "./codec.js";
export { intentToCommand } from "./intents.js";
