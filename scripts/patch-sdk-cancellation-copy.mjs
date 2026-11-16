#!/usr/bin/env node
/**
 * Rewrites the Claude Agent SDK's cancellation copy in place.
 *
 * Background: the bundled CLI has one string constant (`zCH`) that it emits as
 * the tool_result whenever a tool call is cancelled before it ran — either
 * because its AbortSignal fired, or because a PreToolUse hook returned "stop".
 * Its wording ("The user doesn't want to take this action right now...") is the
 * language of a deliberate refusal, so agents that hit it conclude they were
 * denied and stop working.
 *
 * This bites background subagents hardest: when the turn that spawned them
 * ends, the CLI aborts their in-flight tool calls, and every one of them comes
 * back wearing this copy. Agents then report "the user blocked me" in their
 * completion summaries, which propagates the false diagnosis to the parent.
 *
 * Genuine user denials are NOT affected — those use different constants
 * (`XIH`, and `x$$` when the user supplies a reason).
 *
 * The replacement is padded to the original byte length so the surrounding
 * bundle stays byte-aligned; nothing but the string content changes.
 *
 * Idempotent. Runs from both `postinstall` and `prebuild` — the former covers a
 * fresh install or an SDK version bump, the latter covers deploys, which reuse
 * an existing node_modules and so never trigger postinstall.
 *
 *   node scripts/patch-sdk-cancellation-copy.mjs          # apply
 *   node scripts/patch-sdk-cancellation-copy.mjs --check  # report only
 *   node scripts/patch-sdk-cancellation-copy.mjs --revert # restore original
 *
 * Applying is best-effort by design: a missing SDK, an unreadable binary, or a
 * future build whose copy no longer matches is reported and skipped, never
 * fatal, so it cannot wedge an install or a deploy. Only --check exits non-zero
 * (for CI), and only to report that the patch is absent.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGINAL =
  "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";

const REPLACEMENT =
  'This tool call did not run: it was cancelled (its parent turn ended) or blocked by a hook. The user did NOT deny it.';

if (REPLACEMENT.length > ORIGINAL.length) {
  throw new Error('Replacement copy must not be longer than the original literal.');
}
const PADDED = REPLACEMENT.padEnd(ORIGINAL.length, ' ');

const mode = process.argv.includes('--check')
  ? 'check'
  : process.argv.includes('--revert') ? 'revert' : 'apply';

const from = Buffer.from(mode === 'revert' ? PADDED : ORIGINAL, 'utf8');
const to = Buffer.from(mode === 'revert' ? ORIGINAL : PADDED, 'utf8');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sdkDir = path.join(root, 'node_modules', '@anthropic-ai');

// `check` is the only mode that reports absence as a failure; apply/revert stay
// quiet-and-successful so an install or build on a machine without the SDK
// (or mid-install, before optional deps land) still succeeds.
const bail = (message) => {
  console.log(`patch-sdk-cancellation-copy: ${message}`);
  process.exit(mode === 'check' ? 1 : 0);
};

if (!existsSync(sdkDir)) {
  bail(`no ${path.relative(root, sdkDir)} directory — skipping`);
}

// Only the binary for the running platform is normally installed, but musl and
// glibc variants can both be present; patch every one we find.
const binaries = readdirSync(sdkDir)
  .filter((name) => name.startsWith('claude-agent-sdk-'))
  .map((name) => path.join(sdkDir, name, 'claude'))
  .filter((file) => existsSync(file));

if (binaries.length === 0) {
  bail('no claude-agent-sdk native binaries found — skipping');
}

let changedAny = false;

for (const file of binaries) {
  const rel0 = path.relative(root, file);
  let buf;
  try {
    buf = readFileSync(file);
  } catch (error) {
    // A binary we cannot read is not a reason to fail the whole install.
    console.log(`patch-sdk-cancellation-copy: ${rel0}: unreadable (${error.code || error.message}) — skipping`);
    continue;
  }
  const offsets = [];
  for (let i = buf.indexOf(from); i !== -1; i = buf.indexOf(from, i + 1)) {
    offsets.push(i);
  }

  const rel = rel0;
  if (offsets.length === 0) {
    console.log(`${rel}: nothing to do (already ${mode === 'revert' ? 'reverted' : 'patched'}, or unknown build)`);
    continue;
  }

  if (mode === 'check') {
    console.log(`${rel}: ${offsets.length} unpatched occurrence(s) at ${offsets.join(', ')}`);
    changedAny = true;
    continue;
  }

  for (const offset of offsets) {
    to.copy(buf, offset);
  }
  try {
    writeFileSync(file, buf);
  } catch (error) {
    // Read-only node_modules (e.g. a container image layer) — report, don't fail.
    console.log(`patch-sdk-cancellation-copy: ${rel}: not writable (${error.code || error.message}) — skipping`);
    continue;
  }
  console.log(`${rel}: ${mode === 'revert' ? 'reverted' : 'patched'} ${offsets.length} occurrence(s)`);
  changedAny = true;
}

if (mode === 'check') {
  process.exit(changedAny ? 1 : 0);
}
