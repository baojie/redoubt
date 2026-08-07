#!/usr/bin/env node
/**
 * redoubt headless simulation CLI.
 *
 *   pnpm sim --seed 42          one match, full battle report
 *   pnpm sim --matches 1000     batch balance statistics
 *   pnpm sim --seed 7 --lane Ridge --hash
 */

import { formatBatch, runBatch } from "./batch.js";
import { formatReport } from "./report.js";
import { runMatch } from "./runMatch.js";

interface Args {
  seed: number;
  matches: number;
  lane?: string;
  playersPerTeam?: number;
  hash: boolean;
  quiet: boolean;
}

const DEFAULT_SEED = 42;

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { seed: DEFAULT_SEED, matches: 1, hash: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case "--seed":
        args.seed = Number(value);
        i++;
        break;
      case "--matches":
        args.matches = Number(value);
        i++;
        break;
      case "--lane":
        args.lane = value;
        i++;
        break;
      case "--players":
        args.playersPerTeam = Number(value);
        i++;
        break;
      case "--hash":
        args.hash = true;
        break;
      case "--quiet":
        args.quiet = true;
        break;
      // pnpm inserts a bare `--` when forwarding args through the root script.
      case "--":
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
        break;
      default:
        if (flag !== undefined && flag.startsWith("--")) {
          process.stderr.write(`unknown flag ${flag}\n`);
          printUsage();
          process.exit(2);
        }
    }
  }
  if (!Number.isFinite(args.seed)) {
    process.stderr.write("--seed must be a number\n");
    process.exit(2);
  }
  if (!Number.isFinite(args.matches) || args.matches < 1) {
    process.stderr.write("--matches must be a positive integer\n");
    process.exit(2);
  }
  return args;
}

function printUsage(): void {
  process.stdout.write(
    [
      "redoubt sim",
      "",
      "  --seed <n>      match seed (default 42)",
      "  --matches <n>   run a batch of n matches and print balance stats",
      "  --lane <name>   force a RAAS lane instead of drawing one",
      "  --players <n>   players per team",
      "  --hash          print the per-tick state hash digest",
      "  --quiet         suppress the report, print one summary line",
      "",
    ].join("\n"),
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  if (args.matches > 1) {
    const started = process.hrtime.bigint();
    const summary = runBatch(args.seed, args.matches);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    process.stdout.write(formatBatch(summary));
    process.stdout.write(
      `Wall clock      ${(elapsedMs / 1000).toFixed(1)}s ` +
        `(${(elapsedMs / args.matches).toFixed(0)} ms/match)\n\n`,
    );
    return;
  }

  const result = runMatch({
    seed: args.seed,
    laneName: args.lane,
    playersPerTeam: args.playersPerTeam,
    recordHashes: args.hash,
  });

  if (args.quiet) {
    const s = result.stats;
    const winner = s.winner === null ? "draw" : s.winner === 0 ? "BLUE" : "RED";
    process.stdout.write(
      `seed=${s.seed} lane=${s.lane} winner=${winner} ` +
        `tickets=${s.teams[0].finalTickets}/${s.teams[1].finalTickets} ` +
        `ticks=${s.durationTicks} hash=0x${s.finalHash.toString(16)}\n`,
    );
    return;
  }

  process.stdout.write(formatReport(result.stats));
  if (args.hash) {
    const digest = result.hashes.slice(-1)[0] ?? 0;
    process.stdout.write(
      `Recorded ${result.hashes.length} per-tick hashes, last 0x${digest.toString(16)}\n\n`,
    );
  }
}

main();
