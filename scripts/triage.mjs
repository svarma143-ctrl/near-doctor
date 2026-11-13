import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RULES_DIR, loadRules, matchSymptoms, redact, validateRule } from "../src/index.mjs";
import { renderSteps } from "../src/report.mjs";

/** Parse a GitHub issue-form body ("### Heading" sections) into { heading: text }. */
export function parseIssueBody(body) {
  const out = {};
  let key = null;
  for (const line of String(body || "").split("\n")) {
    const m = /^###\s+(.+?)\s*$/.exec(line);
    if (m) {
      key = m[1].toLowerCase();
      out[key] = "";
    } else if (key) out[key] += line + "\n";
  }
  for (const k of Object.keys(out)) out[k] = out[k].replace(/^\s*```[a-z]*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Build a draft rule from the first error-looking line. Deterministic; needs a human to confirm. */
export function draftRule(errorText, { nextId, issue }) {
  const line = String(errorText || "")
    .split("\n")
    .map((l) => l.replace(/^[\s│|]+/, "").trim())
    .find((l) => /error|failed|panicked|cannot|unresolved|unexpected|refused|denied/i.test(l) && l.length >= 12);
  if (!line) return null;
  let pattern = escapeRe(line.slice(0, 160))
    .replace(/`[^`]+`/g, "`[^`]+`")
    .replace(/\d+/g, "\\d+");
  pattern = pattern.replace(/(?:\\d\+){2,}/g, "\\d+");
  return {
    id: nextId,
    severity: "info",
    tier: "hypothesis",
    status: "active",
    title: `Draft: ${line.slice(0, 80)}`,
    summary: "User-reported and not yet reproduced. A maintainer must confirm the cause and fix before this becomes a warning.",
    symptoms: [{ pattern }],
    fix: { steps: ["TODO: add a verified fix."] },
    refs: [],
    evidence: { observed: `Unreproduced user report${issue ? ` (issue #${issue})` : ""}.` },
  };
}

export function nextRuleId(rules) {
  const n = Math.max(0, ...rules.filter((r) => r.id.startsWith("F-")).map((r) => Number(r.id.slice(2))));
  return `F-${String(n + 1).padStart(3, "0")}`;
}

export function triage(body, rules, { issue } = {}) {
  const s = parseIssueBody(body);
  const text = [s["error output"], s["command"]].filter(Boolean).join("\n");
  if (!text.trim() || /^\(none provided/.test(s["error output"] || "")) {
    return {
      action: "needs-info",
      matches: [],
      comment: "Thanks for the report. There is no error output yet. Run `npx near-doctor submit --from <saved-output>` and paste the result so this can be matched against the friction log.",
    };
  }
  const matches = matchSymptoms(text, rules);
  if (matches.length) {
    const body = matches
      .map((m) => `**${m.rule.id}: ${m.rule.title}** (${m.rule.tier}${m.rule.status === "historical" ? ", historical" : ""})\n\nWhy: ${m.rule.summary}\n\nFix:\n${renderSteps(m.rule, m.vars).map((x, i) => `${i + 1}. ${x}`).join("\n") || "See the friction log entry."}`)
      .join("\n\n---\n\n");
    return {
      action: "known",
      matches: matches.map((m) => m.rule.id),
      comment: `This matches known friction in the log:\n\n${body}\n\nIf this does not solve it, reply with what you tried and a maintainer will take another look.`,
    };
  }
  const draft = draftRule(redact(text), { nextId: nextRuleId(rules), issue });
  if (!draft) return { action: "needs-info", matches: [], comment: "No known match, and the output has no recognisable error line. Please include the full error output." };
  const problems = validateRule(draft);
  return {
    action: "draft",
    matches: [],
    draft,
    problems,
    comment:
      "No existing rule matches this report. A **draft rule** was generated from the first error line (below). It is a hypothesis only: a maintainer must reproduce it, add `repro.txt` and `control.txt` fixtures, and set the evidence tier before it can ship. CI will not merge a rule whose fixtures do not pass.\n\n```json\n" +
      JSON.stringify(draft, null, 2) +
      "\n```",
  };
}

async function cli() {
  const args = process.argv.slice(2);
  const get = (k) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  let body;
  let issue;
  if (get("--event")) {
    const ev = JSON.parse(fs.readFileSync(get("--event"), "utf8"));
    body = ev.issue?.body;
    issue = ev.issue?.number;
  } else if (get("--body-file")) body = fs.readFileSync(get("--body-file"), "utf8");
  else {
    process.stderr.write("usage: triage.mjs (--event FILE | --body-file FILE) [--comment-file OUT] [--draft-dir DIR]\n");
    process.exit(2);
  }
  const rules = loadRules(get("--rules") || DEFAULT_RULES_DIR);
  const result = triage(body, rules, { issue });
  if (get("--comment-file")) fs.writeFileSync(get("--comment-file"), result.comment + "\n");
  if (get("--draft-dir") && result.draft) {
    fs.mkdirSync(get("--draft-dir"), { recursive: true });
    fs.writeFileSync(path.join(get("--draft-dir"), `${result.draft.id}.json`), JSON.stringify(result.draft, null, 2) + "\n");
  }
  process.stdout.write(JSON.stringify({ action: result.action, matches: result.matches, problems: result.problems || [] }) + "\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) cli();
