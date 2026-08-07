#!/usr/bin/env node
/**
 * audit-triage.mjs
 *
 * WHY THIS EXISTS (issue #218, epic #214):
 *   `npm audit` reports one row per PACKAGE, but a single root advisory is
 *   frequently reachable through several packages/paths at once, so the raw
 *   row count wildly overstates the number of distinct problems. 50 rows
 *   from `npm audit` does NOT mean 50 problems -- it might mean 8 real root
 *   advisories, several of which fan out across multiple transitive paths.
 *
 *   This script runs `npm audit --package-lock-only --json`, groups the
 *   reported vulnerabilities by their distinct root advisory (deduped on the
 *   advisory URL / GHSA id, not the package name), and prints a compact
 *   summary: total rows vs. distinct root advisories, then per advisory the
 *   package, severity, vulnerable range, title, advisory URL, and which
 *   `npm audit` rows (package names) it accounts for.
 *
 *   Accepted/documented exceptions for the root advisories currently open in
 *   this repo live in docs/security/dependency-exceptions.md -- read that
 *   file for the "why not fixed" / "why not reachable" reasoning and the
 *   fact-based revisit trigger for each one. This script does not read or
 *   write that file; it only reports what `npm audit` currently sees, so you
 *   can eyeball whether the accepted-risk record is still in sync with
 *   reality.
 *
 * USAGE:
 *   node scripts/audit-triage.mjs
 *
 * EXIT CODE:
 *   Always 0. This is a reporting tool, not a CI gate -- issue #218 puts a
 *   CI-blocking audit gate explicitly out of scope for this repo. `npm
 *   audit` itself exits non-zero whenever vulnerabilities are found; this
 *   script deliberately does not propagate that exit code.
 *
 * DEPENDENCIES: Node.js built-ins only (child_process). No npm packages.
 */

import { execFileSync } from 'node:child_process';

const SEVERITY_ORDER = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };

function runNpmAudit() {
  try {
    // npm audit exits non-zero whenever it finds vulnerabilities -- that is
    // expected and not an error condition for this tool, so we always read
    // stdout regardless of exit status.
    const stdout = execFileSync(
      'npm',
      ['audit', '--package-lock-only', '--json'],
      {
        cwd: new URL('..', import.meta.url).pathname,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return stdout;
  } catch (err) {
    // execFileSync throws when the child exits non-zero, but npm still
    // writes the JSON report to stdout in that case -- recover it from the
    // error object rather than treating this as a failure.
    if (err.stdout) return err.stdout.toString('utf8');
    throw new Error(`npm audit failed to run and produced no output: ${err.message}`);
  }
}

function groupByRootAdvisory(auditJson) {
  const roots = new Map();

  const vulnerabilities = auditJson.vulnerabilities || {};
  for (const [name, v] of Object.entries(vulnerabilities)) {
    const via = v.via || [];
    for (const entry of via) {
      // String entries are indirect "via <pkg-name>" pointers to another
      // package in the dependency chain, not an advisory -- skip them. Only
      // object entries carry the actual advisory (url/title/severity/range).
      if (typeof entry !== 'object' || entry === null) continue;

      const key = entry.url || `${entry.source ?? 'unknown'}:${entry.name}:${entry.title}`;
      if (!roots.has(key)) {
        roots.set(key, {
          url: entry.url || null,
          title: entry.title,
          severity: entry.severity,
          pkg: entry.name,
          range: entry.range,
          rows: new Set(),
        });
      }
      roots.get(key).rows.add(name);
    }
  }

  return roots;
}

function main() {
  const raw = runNpmAudit();

  let auditJson;
  try {
    auditJson = JSON.parse(raw);
  } catch (err) {
    console.error('Failed to parse `npm audit --json` output as JSON.');
    console.error(err.message);
    console.error('--- raw output (first 2000 chars) ---');
    console.error(raw.slice(0, 2000));
    process.exit(0); // reporting tool -- never fail the caller
    return;
  }

  const totalRows = Object.keys(auditJson.vulnerabilities || {}).length;
  const roots = groupByRootAdvisory(auditJson);
  const rootsSorted = [...roots.values()].sort((a, b) => {
    const sevDiff = (SEVERITY_ORDER[a.severity] ?? 99) - (SEVERITY_ORDER[b.severity] ?? 99);
    if (sevDiff !== 0) return sevDiff;
    return (a.pkg || '').localeCompare(b.pkg || '');
  });

  console.log('='.repeat(72));
  console.log('npm audit triage — root-cause summary');
  console.log('='.repeat(72));
  console.log();
  console.log(`  Raw npm audit rows (packages flagged): ${totalRows}`);
  console.log(`  Distinct root advisories:               ${rootsSorted.length}`);
  console.log();
  console.log(
    '  Reminder: N raw rows does NOT mean N problems -- one advisory can',
  );
  console.log(
    '  fan out across many packages/paths. The number above right is the',
  );
  console.log('  honest count. See docs/security/dependency-exceptions.md');
  console.log('  for the accepted-risk disposition of each open advisory.');
  console.log();

  if (rootsSorted.length === 0) {
    console.log('  No vulnerabilities reported by npm audit. Nothing to triage.');
    console.log();
    process.exit(0);
    return;
  }

  console.log('-'.repeat(72));
  for (const [i, r] of rootsSorted.entries()) {
    const rows = [...r.rows].sort();
    console.log(`${i + 1}. [${(r.severity || 'unknown').toUpperCase()}] ${r.pkg} ${r.range || ''}`);
    console.log(`   ${r.title || '(no title)'}`);
    if (r.url) console.log(`   ${r.url}`);
    console.log(`   Accounts for ${rows.length} audit row(s): ${rows.join(', ')}`);
    console.log();
  }
  console.log('-'.repeat(72));
  console.log(
    `Total: ${totalRows} raw row(s) collapse to ${rootsSorted.length} distinct root advisory(ies).`,
  );
  console.log();

  // Always exit 0 -- this is a reporting tool, not a gate (issue #218 /
  // epic #214 explicitly puts a CI-blocking audit gate out of scope).
  process.exit(0);
}

main();
