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
import { verifyFHIR } from "./verify/fhir.js";
import { inspectFHIR } from "./fhir/inspect.js";
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

  clinical-receipt fhir inspect <receipt.json>          [--json]
  clinical-receipt fhir verify <receipt.json>           [--key <jwk.json>...] [--resource <ref>=<path>...] [--json]
  clinical-receipt fhir diff <a.json> <b.json>          [--json]

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

function commandFhirInspect(args: ParsedArgs): never {
  // Subcommand form: `fhir inspect <path>` — positional[0] is "inspect".
  const target = args.positional[1];
  if (target === undefined) {
    process.stderr.write("fhir inspect: missing path to receipt\n");
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
  const trace = inspectFHIR(parsed);
  if (args.bool.has("json")) {
    process.stdout.write(JSON.stringify(trace) + "\n");
    process.exit(0);
  }
  const lines: string[] = [];
  lines.push(`receipt: ${parsed.receipt.id}`);
  lines.push(`servers: ${trace.servers.length}`);
  for (const server of trace.servers) {
    lines.push(`  · ${server.id}${server.baseUrl !== undefined ? ` (${server.baseUrl})` : ""}`);
  }
  lines.push(`reads: ${trace.reads.length}`);
  for (const read of trace.reads) {
    const version = read.resource.versionId !== undefined ? `/_history/${read.resource.versionId}` : "";
    const idStr = read.resource.id ?? read.resource.idCommitment ?? "?";
    lines.push(`  ${read.operation} · ${read.resource.type}/${idStr}${version}`);
  }
  lines.push(`searches: ${trace.searches.length}`);
  for (const search of trace.searches) {
    lines.push(
      `  ${search.resourceType} · ${search.resources.length} resources · pagination=${search.pagination}${
        search.total !== undefined ? ` · total=${search.total}` : ""
      }`,
    );
  }
  lines.push(`writes: ${trace.writes.length}`);
  for (const write of trace.writes) {
    const persisted = write.persisted;
    const version = persisted?.versionId !== undefined ? `/_history/${persisted.versionId}` : "";
    const idStr = persisted?.id ?? persisted?.idCommitment ?? "?";
    lines.push(`  ${write.operation} · ${write.target.type}${persisted !== undefined ? `/${idStr}${version}` : ""}`);
  }
  lines.push(`transactions: ${trace.transactions.length}`);
  for (const tx of trace.transactions) {
    lines.push(`  ${tx.operation} · ${tx.entryCount} entries`);
  }
  lines.push(`errors: ${trace.errors.length}`);
  for (const err of trace.errors) {
    lines.push(
      `  ${err.target.method} ${err.target.path} · reason=${err.reason}${
        err.httpStatus !== undefined ? ` · http=${err.httpStatus}` : ""
      }`,
    );
  }
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(0);
}

async function commandFhirVerify(args: ParsedArgs): Promise<never> {
  const target = args.positional[1];
  if (target === undefined) {
    process.stderr.write("fhir verify: missing path to receipt\n");
    process.exit(2);
  }
  const keys = await loadKeys(args.flags);
  const suppliedResources: Record<string, unknown> = {};
  for (const spec of args.flags.get("resource") ?? []) {
    const eq = spec.indexOf("=");
    if (eq === -1) {
      process.stderr.write(
        `fhir verify: --resource must be <ref>=<path>, got ${JSON.stringify(spec)}\n`,
      );
      process.exit(2);
    }
    const ref = spec.slice(0, eq);
    const path = spec.slice(eq + 1);
    suppliedResources[ref] = readJson(path);
  }
  const raw = readJson(target);
  try {
    const report = await verifyFHIR(raw as ClinicalReceipt, {
      keys,
      resources: suppliedResources,
    });
    if (args.bool.has("json")) {
      process.stdout.write(JSON.stringify(report) + "\n");
      process.exit(report.ok ? 0 : 1);
    }
    const lines: string[] = [];
    lines.push(reportSummary(report).trimEnd());
    lines.push(
      `fhir.commitments: ${report.fhir.commitments} (${report.fhir.resources.length} resources)`,
    );
    lines.push(`fhir.understood: ${report.fhir.understood}`);
    for (const check of report.fhir.resources) {
      lines.push(`  ${check.reference}: ${check.commitment}`);
    }
    process.stdout.write(lines.join("\n") + "\n");
    process.exit(report.ok ? 0 : 1);
  } catch (error) {
    if (isReceiptError(error)) {
      process.stderr.write(
        `fhir verify failed: ${error.code} — ${error.message}\n`,
      );
      process.exit(1);
    }
    throw error;
  }
}

function commandFhirDiff(args: ParsedArgs): never {
  const [, pathA, pathB] = args.positional;
  if (pathA === undefined || pathB === undefined) {
    process.stderr.write("fhir diff: needs two receipt paths\n");
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
  const traceA = inspectFHIR(a);
  const traceB = inspectFHIR(b);

  function keyForResource(r: {
    type: string;
    id?: string;
    idCommitment?: string;
    versionId?: string;
  }): string {
    const idPart = r.id ?? r.idCommitment ?? "?";
    return r.versionId !== undefined
      ? `${r.type}/${idPart}/_history/${r.versionId}`
      : `${r.type}/${idPart}`;
  }
  const readsA = new Set(traceA.reads.map((r) => keyForResource(r.resource)));
  const readsB = new Set(traceB.reads.map((r) => keyForResource(r.resource)));
  const writesA = new Set(traceA.writes.map((w) => keyForResource({ ...w.target, ...w.persisted })));
  const writesB = new Set(traceB.writes.map((w) => keyForResource({ ...w.target, ...w.persisted })));

  const diff = {
    readsOnlyInA: [...readsA].filter((r) => !readsB.has(r)),
    readsOnlyInB: [...readsB].filter((r) => !readsA.has(r)),
    writesOnlyInA: [...writesA].filter((w) => !writesB.has(w)),
    writesOnlyInB: [...writesB].filter((w) => !writesA.has(w)),
    searchCountA: traceA.searches.length,
    searchCountB: traceB.searches.length,
  };
  if (args.bool.has("json")) {
    process.stdout.write(JSON.stringify(diff) + "\n");
    process.exit(0);
  }
  const lines: string[] = [];
  lines.push(`reads only in A: ${diff.readsOnlyInA.length}`);
  for (const r of diff.readsOnlyInA) lines.push(`  A: ${r}`);
  lines.push(`reads only in B: ${diff.readsOnlyInB.length}`);
  for (const r of diff.readsOnlyInB) lines.push(`  B: ${r}`);
  lines.push(`writes only in A: ${diff.writesOnlyInA.length}`);
  for (const w of diff.writesOnlyInA) lines.push(`  A: ${w}`);
  lines.push(`writes only in B: ${diff.writesOnlyInB.length}`);
  for (const w of diff.writesOnlyInB) lines.push(`  B: ${w}`);
  lines.push(`searches: A=${diff.searchCountA} B=${diff.searchCountB}`);
  process.stdout.write(lines.join("\n") + "\n");
  process.exit(0);
}

async function commandFhir(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];
  switch (sub) {
    case "inspect":
      commandFhirInspect(args);
      return;
    case "verify":
      await commandFhirVerify(args);
      return;
    case "diff":
      commandFhirDiff(args);
      return;
    default:
      process.stderr.write(
        `fhir: unknown subcommand ${JSON.stringify(sub ?? "")}\n\n${USAGE}`,
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
    case "fhir":
      await commandFhir(args);
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
