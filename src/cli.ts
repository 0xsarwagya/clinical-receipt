#!/usr/bin/env node
/**
 * clinical-receipt CLI.
 *
 * Exit codes:
 *   0 — succeeded (verify: `ok: true`; other commands: normal completion)
 *   1 — verification failed (bad root, bad signature, bad proof, tamper)
 *   2 — could not run the command (bad args, malformed input, IO error)
 *
 * Every command supports `--json` for structured output. Human-readable
 * output NEVER echoes payload values — PHI-safety is a compile-time
 * property here.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { parseReceipt } from "./verify/parse.js";
import { verifyReceipt } from "./verify/receipt.js";
import { verifyDisclosure } from "./verify/disclosure.js";
import { importVerificationKey, type VerificationKey } from "./signing/webcrypto.js";
import { disclose, type DisclosurePackage } from "./disclosure/disclose.js";
import { SPEC_VERSION } from "./core/constants.js";
import { isReceiptError, ReceiptError } from "./errors.js";
import type { ClinicalReceipt } from "./recorder/receipt.js";
import type { VerificationReport } from "./verify/report.js";

const USAGE = `clinical-receipt ${SPEC_VERSION}

usage:
  clinical-receipt verify <receipt.json>     [--key <jwk.json>...] [--json]
  clinical-receipt verify --disclosure <pkg> [--key <jwk.json>...] [--json]
  clinical-receipt inspect <receipt.json>    [--json]
  clinical-receipt diff <a.json> <b.json>    [--json]
  clinical-receipt disclose <receipt.json>   --event <pattern>... [--redact <pattern>...] [--out <path>]

Exit codes:
  0  ok
  1  verification failed (integrity, signature, disclosure)
  2  bad arguments, malformed input, or IO error
`;

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string[]>;
  bool: Set<string>;
}

// Flags that never take a value — treat as booleans regardless of what
// follows. This keeps `verify --disclosure path/to/file.json` from
// treating the path as the flag's value.
const BOOLEAN_FLAGS = new Set(["disclosure", "json"]);

function parseArgs(argv: string[]): ParsedArgs {
  const [, , commandRaw, ...rest] = argv;
  if (commandRaw === undefined || commandRaw === "-h" || commandRaw === "--help") {
    process.stdout.write(USAGE);
    process.exit(commandRaw === undefined ? 2 : 0);
  }
  const flags = new Map<string, string[]>();
  const bool = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      bool.add(name);
      continue;
    }
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      bool.add(name);
      continue;
    }
    const list = flags.get(name) ?? [];
    list.push(next);
    flags.set(name, list);
    i += 1;
  }
  return { command: commandRaw, positional, flags, bool };
}

function readJson(pathArg: string): unknown {
  try {
    return JSON.parse(readFileSync(pathArg, "utf8"));
  } catch (error) {
    process.stderr.write(
      `could not read ${pathArg}: ${(error as Error).message}\n`,
    );
    process.exit(2);
  }
}

async function loadKeys(flags: Map<string, string[]>): Promise<VerificationKey[]> {
  const keyPaths = flags.get("key") ?? [];
  const keys: VerificationKey[] = [];
  for (const p of keyPaths) {
    const jwk = readJson(p) as JsonWebKey;
    try {
      keys.push(await importVerificationKey(jwk));
    } catch (error) {
      process.stderr.write(
        `could not import key ${p}: ${(error as Error).message}\n`,
      );
      process.exit(2);
    }
  }
  return keys;
}

function reportSummary(report: VerificationReport): string {
  const lines: string[] = [];
  lines.push(`ok: ${report.ok}`);
  lines.push(`spec: ${report.specification.name} ${report.specification.version}`);
  lines.push(
    `integrity.root: ${report.integrity.root} (${report.integrity.events.verified}/${report.integrity.events.total} events)`,
  );
  for (const failure of report.integrity.events.failed) {
    lines.push(`  - event ${failure.index} (${failure.eventId}): ${failure.reason}`);
  }
  for (const sig of report.signatures) {
    lines.push(`signature ${sig.keyId} [${sig.algorithm}]: ${sig.status}`);
  }
  if (report.disclosures.applicable) {
    lines.push(
      `disclosure.complete: ${report.disclosures.complete} · cryptographicallyConsistent: ${report.disclosures.cryptographicallyConsistent}`,
    );
  }
  lines.push(
    `timeline: internallyConsistent=${report.timeline.internallyConsistent} externallyTimestamped=${report.timeline.externallyTimestamped}`,
  );
  for (const warning of report.warnings) {
    lines.push(`! ${warning.code}: ${warning.message}`);
  }
  return lines.join("\n") + "\n";
}

async function commandVerify(args: ParsedArgs): Promise<never> {
  const target = args.positional[0];
  if (target === undefined) {
    process.stderr.write("verify: missing path to receipt or disclosure\n");
    process.exit(2);
  }
  const raw = readJson(target);
  const isDisclosure = args.bool.has("disclosure");
  const keys = await loadKeys(args.flags);
  let report: VerificationReport;
  try {
    report = isDisclosure
      ? await verifyDisclosure(raw as DisclosurePackage, { keys })
      : await verifyReceipt(raw as ClinicalReceipt, { keys });
  } catch (error) {
    if (isReceiptError(error)) {
      const shape = { ok: false, error: { code: error.code, message: error.message } };
      if (args.bool.has("json")) {
        process.stdout.write(JSON.stringify(shape) + "\n");
      } else {
        process.stderr.write(`verification failed: ${error.code} — ${error.message}\n`);
      }
      process.exit(1);
    }
    throw error;
  }
  if (args.bool.has("json")) {
    process.stdout.write(JSON.stringify(report) + "\n");
  } else {
    process.stdout.write(reportSummary(report));
  }
  process.exit(report.ok ? 0 : 1);
}

function receiptStats(receipt: ClinicalReceipt): Record<string, unknown> {
  const types = new Map<string, number>();
  for (const event of receipt.events) {
    types.set(event.type, (types.get(event.type) ?? 0) + 1);
  }
  return {
    id: receipt.receipt.id,
    workflow: receipt.workflow,
    createdAt: receipt.receipt.createdAt,
    finalizedAt: receipt.receipt.finalizedAt,
    eventCount: receipt.events.length,
    eventTypeCounts: Object.fromEntries(types),
    root: receipt.commitments.root,
    signatureKeyIds: receipt.signatures.map((s) => s.keyId),
  };
}

function commandInspect(args: ParsedArgs): never {
  const target = args.positional[0];
  if (target === undefined) {
    process.stderr.write("inspect: missing path to receipt\n");
    process.exit(2);
  }
  let parsed: ClinicalReceipt;
  try {
    parsed = parseReceipt(readJson(target), "parse");
  } catch (error) {
    process.stderr.write(
      `not a valid receipt: ${isReceiptError(error) ? error.code : String(error)}\n`,
    );
    process.exit(2);
  }
  const stats = receiptStats(parsed);
  if (args.bool.has("json")) {
    process.stdout.write(JSON.stringify(stats) + "\n");
  } else {
    process.stdout.write(
      `${stats.id}\n` +
        `workflow: ${(stats.workflow as { id: string; version: string }).id}@${(stats.workflow as { id: string; version: string }).version}\n` +
        `events: ${stats.eventCount}\n` +
        `signatures: ${(stats.signatureKeyIds as string[]).length}\n` +
        `root: ${(stats.root as { digest: string }).digest}\n`,
    );
  }
  process.exit(0);
}

function commandDiff(args: ParsedArgs): never {
  const [pathA, pathB] = args.positional;
  if (pathA === undefined || pathB === undefined) {
    process.stderr.write("diff: needs two receipt paths\n");
    process.exit(2);
  }
  let a: ClinicalReceipt;
  let b: ClinicalReceipt;
  try {
    a = parseReceipt(readJson(pathA), "parse");
    b = parseReceipt(readJson(pathB), "parse");
  } catch (error) {
    process.stderr.write(
      `could not parse: ${isReceiptError(error) ? error.code : String(error)}\n`,
    );
    process.exit(2);
  }
  const diff = {
    rootsEqual: a.commitments.root.digest === b.commitments.root.digest,
    aRoot: a.commitments.root.digest,
    bRoot: b.commitments.root.digest,
    onlyInA: a.events
      .filter((e) => !b.events.some((f) => f.id === e.id))
      .map((e) => ({ sequence: e.sequence, type: e.type, id: e.id })),
    onlyInB: b.events
      .filter((e) => !a.events.some((f) => f.id === e.id))
      .map((e) => ({ sequence: e.sequence, type: e.type, id: e.id })),
  };
  if (args.bool.has("json")) {
    process.stdout.write(JSON.stringify(diff) + "\n");
  } else {
    process.stdout.write(
      `rootsEqual: ${diff.rootsEqual}\n` +
        `only in A: ${diff.onlyInA.length}\n` +
        `only in B: ${diff.onlyInB.length}\n`,
    );
    for (const e of diff.onlyInA)
      process.stdout.write(`  A: ${e.sequence} ${e.type} ${e.id}\n`);
    for (const e of diff.onlyInB)
      process.stdout.write(`  B: ${e.sequence} ${e.type} ${e.id}\n`);
  }
  process.exit(0);
}

async function commandDisclose(args: ParsedArgs): Promise<never> {
  const target = args.positional[0];
  if (target === undefined) {
    process.stderr.write("disclose: missing path to receipt\n");
    process.exit(2);
  }
  const events = args.flags.get("event") ?? [];
  const redact = args.flags.get("redact") ?? [];
  if (events.length === 0) {
    process.stderr.write("disclose: needs at least one --event <pattern>\n");
    process.exit(2);
  }
  let parsed: ClinicalReceipt;
  try {
    parsed = parseReceipt(readJson(target), "parse");
  } catch (error) {
    process.stderr.write(
      `not a valid receipt: ${isReceiptError(error) ? error.code : String(error)}\n`,
    );
    process.exit(2);
  }
  try {
    const pkg = await disclose(parsed, { events, redact });
    const serialized = JSON.stringify(pkg, null, 2);
    const out = args.flags.get("out")?.[0];
    if (out === undefined) {
      process.stdout.write(serialized + "\n");
    } else {
      writeFileSync(out, serialized + "\n");
      process.stderr.write(`wrote disclosure to ${out}\n`);
    }
    process.exit(0);
  } catch (error) {
    process.stderr.write(
      `disclose failed: ${error instanceof ReceiptError ? `${error.code} — ${error.message}` : String(error)}\n`,
    );
    process.exit(2);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case "verify":
      await commandVerify(args);
      break;
    case "inspect":
      commandInspect(args);
      break;
    case "diff":
      commandDiff(args);
      break;
    case "disclose":
      await commandDisclose(args);
      break;
    default:
      process.stderr.write(`unknown command: ${args.command}\n\n${USAGE}`);
      process.exit(2);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`unexpected: ${String(error)}\n`);
  process.exit(2);
});
