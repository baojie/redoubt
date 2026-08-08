#!/usr/bin/env node
/**
 * Server entry point.
 *
 *   pnpm --filter @redoubt/server start -- --port 8787 --seed 42
 */

import { GameServer } from "./gameServer.js";

const DEFAULT_PORT = 8787;
const DEFAULT_SEED = 42;

interface Args {
  port: number;
  seed: number;
  playersPerTeam?: number;
  laneName?: string;
  invulnerableHumans?: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { port: DEFAULT_PORT, seed: DEFAULT_SEED };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--":
        break;
      case "--port":
        args.port = Number(value);
        i++;
        break;
      case "--seed":
        args.seed = Number(value);
        i++;
        break;
      case "--players":
        args.playersPerTeam = Number(value);
        i++;
        break;
      case "--lane":
        args.laneName = value;
        i++;
        break;
      // Playtest only. Takes no value, so it does not consume the next argv.
      case "--invulnerable":
        args.invulnerableHumans = true;
        break;
      case "--help":
      case "-h":
        process.stdout.write(
          [
            "redoubt server",
            "",
            "  --port <n>      listen port (default 8787)",
            "  --seed <n>      match seed (default 42)",
            "  --players <n>   players per team",
            "  --lane <name>   force a RAAS lane",
            "  --invulnerable  playtest: human-held soldiers take no damage",
            "",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        if (flag !== undefined && flag.startsWith("--")) {
          process.stderr.write(`unknown flag ${flag}\n`);
          process.exit(2);
        }
    }
  }
  if (!Number.isFinite(args.port) || args.port <= 0) {
    process.stderr.write("--port must be a positive number\n");
    process.exit(2);
  }
  if (!Number.isFinite(args.seed)) {
    process.stderr.write("--seed must be a number\n");
    process.exit(2);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const server = new GameServer(args);
server.listen();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    process.stdout.write("\nshutting down\n");
    server.close();
    process.exit(0);
  });
}
