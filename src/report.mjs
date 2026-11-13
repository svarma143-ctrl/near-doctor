const PAL = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
const PLAIN = Object.fromEntries(Object.keys(PAL).map((k) => [k, (s) => s]));
export const palette = (color) => (color ? PAL : PLAIN);

function plural(n, w) {
  return `${n} ${w}${n === 1 ? "" : "s"}`;
}

export function formatFinding(f, c) {
  const sev = { error: c.red("ERROR"), warn: c.yellow("WARN "), info: c.cyan("INFO ") }[f.severity];
  const lines = [`${sev} ${c.bold(f.id)}  ${f.title}`];
  if (f.file) lines.push(c.dim(`      ${f.file}${f.line ? ":" + f.line : ""}`));
  lines.push(`      ${f.message}`);
  lines.push(`      Why:  ${f.why}`);
  f.fix.steps.forEach((s, i) => lines.push(`      ${i === 0 ? "Fix:  " : "      "}${s}`));
  if (f.fix.autofix) lines.push(`      Auto: ${c.green("near-doctor fix --safe")}  (${f.fix.autofix.description})`);
  const refs = f.refs.length ? ` · ${f.refs[0]}` : "";
  lines.push(c.dim(`      Evidence: ${f.tier}${refs}`));
  return lines.join("\n");
}

export function formatCheck(result, { color = false } = {}) {
  const c = palette(color);
  const s = result.summary;
  const total = s.error + s.warn + s.info;
  const out = [];
  out.push(c.bold(`near-doctor ${result.version}`) + c.dim(`  ${result.root}`));
  for (const n of result.notes) out.push(c.dim(`note: ${n}`));
  if (!total) {
    out.push(c.green("No known friction found."));
  } else {
    out.push(`${plural(total, "finding")}: ${s.error} error, ${s.warn} warning, ${s.info} info (${result.durationMs} ms)`);
    out.push("");
    for (const f of result.findings) out.push(formatFinding(f, c), "");
  }
  if (result.skipped.length) {
    out.push(c.dim("Skipped:"));
    for (const k of result.skipped) out.push(c.dim(`  ${k.id}: ${k.reason}`));
  }
  const fixable = result.findings.filter((f) => f.fix.autofix).length;
  if (fixable) out.push(`${plural(fixable, "finding")} can be fixed automatically: near-doctor fix --safe`);
  return out.join("\n").replace(/\n+$/, "") + "\n";
}

export function formatExplain(matches, { color = false } = {}) {
  const c = palette(color);
  const out = [];
  for (const m of matches) {
    const r = m.rule;
    out.push(`${c.bold(r.id)}  ${r.title}  ${c.dim(`[${r.tier}${r.status === "historical" ? ", historical" : ""}]`)}`);
    if (m.vars.realError) out.push(`  Real cause in the output: ${m.vars.realError}`);
    out.push(`  Why: ${r.summary}`);
    r.fix.steps.forEach((s, i) => out.push(`  ${i === 0 ? "Fix:" : "    "} ${s.replace(/\{(\w+)\}/g, (_, k) => m.vars[k] ?? "")}`));
    if (r.refs?.length) out.push(c.dim(`  See: ${r.refs.join(" ")}`));
    out.push("");
  }
  return out.join("\n");
}

const detectKind = (r) => (r.status === "log-only" ? "log only" : [r.detect ? "scan" : null, r.symptoms ? "explain" : null].filter(Boolean).join("+"));

export function formatRulesList(rules) {
  const rows = rules.map((r) => [r.id, r.status, r.tier, r.severity, detectKind(r), r.title]);
  const w = [0, 1, 2, 3, 4].map((i) => Math.max(...rows.map((r) => r[i].length)));
  return (
    rows.map((r) => [0, 1, 2, 3, 4].map((i) => r[i].padEnd(w[i])).join("  ") + "  " + r[5]).join("\n") + "\n"
  );
}

/** docs/FRICTION_LOG.md, generated from the rule files so the two cannot drift. */
export function rulesMarkdown(rules) {
  const L = [];
  L.push("# NEAR friction log");
  L.push("");
  L.push("Generated from `rules/*.json` by `npm run log`. Do not edit by hand.");
  L.push("");
  L.push("Evidence tiers: **verified-here** = reproduced by the maintainers; **reported** = found in public issues or forums, not reproduced by us; **hypothesis** = plausible, untested (never warns).");
  L.push("");
  L.push("| ID | Status | Tier | Severity | How it is used | Friction |");
  L.push("| --- | --- | --- | --- | --- | --- |");
  for (const r of rules) L.push(`| ${r.id} | ${r.status} | ${r.tier} | ${r.severity} | ${detectKind(r)} | ${r.title} |`);
  L.push("");
  for (const r of rules) {
    L.push(`## ${r.id}: ${r.title}`);
    L.push("");
    L.push(`- Status: ${r.status}; tier: ${r.tier}; severity: ${r.severity}`);
    L.push("");
    L.push(r.summary);
    L.push("");
    if (r.evidence) {
      L.push("Evidence:");
      for (const [k, v] of Object.entries(r.evidence)) L.push(`- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
      L.push("");
    }
    if (r.fix?.steps?.length) {
      L.push("Fix:");
      r.fix.steps.forEach((s, i) => L.push(`${i + 1}. ${s}`));
      L.push("");
    }
    if (r.fix?.autofix) L.push(`Auto-fix: \`${r.fix.autofix.type}\`: ${r.fix.autofix.description}`, "");
    if (r.refs?.length) {
      L.push("References:");
      r.refs.forEach((u) => L.push(`- ${u}`));
      L.push("");
    }
  }
  return L.join("\n").replace(/\n+$/, "\n");
}
