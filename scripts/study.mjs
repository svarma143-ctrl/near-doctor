// Prevalence and false-positive study: run near-doctor's STATIC rules over public hackathon repos.
//
//   node scripts/study.mjs --out /path/to/private/dir [--per-language 50]
//
// Safety and politeness:
//  - Read-only. Downloads public source tarballs (codeload) and scans them statically. No repo code is
//    executed (near-doctor never runs project code unless --allow-exec; this script does not pass it).
//  - Unauthenticated GitHub search (<= 10 requests/min) and one tarball per repo with a pause between them.
//  - Raw per-repo results (which contain repo names) stay in --out. Only aggregates are meant to be published.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DEFAULT_RULES_DIR, loadRules, runChecks } from "../src/index.mjs";

const args = process.argv.slice(2);
const get = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const outDir = get("--out");
if (!outDir) {
  console.error("usage: study.mjs --out DIR [--per-language N]");
  process.exit(2);
}
const perLanguage = Number(get("--per-language", 50));
const reposFrom = get("--repos-from"); // re-scan exactly the repos of an earlier run (to compare rule versions)
const MAX_BYTES = 40 * 1024 * 1024;
const UA = "near-doctor-study (read-only; aggregate statistics only)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(outDir, { recursive: true });
const resultsFile = path.join(outDir, "results.jsonl");
const done = new Set(fs.existsSync(resultsFile) ? fs.readFileSync(resultsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).repo) : []);
const rules = loadRules(DEFAULT_RULES_DIR);

async function search(language) {
  const q = `"NEAR HACKATHON" in:readme created:>2026-10-19 language:${language}`;
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&per_page=${Math.min(100, perLanguage * 2)}&sort=updated`;
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`search ${language}: HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  const j = await res.json();
  return j.items.filter((i) => !i.fork && !i.archived && i.size < 30000).slice(0, perLanguage).map((i) => ({ repo: i.full_name, language }));
}

async function scan(repo) {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "nd-study-"));
  try {
    const res = await fetch(`https://codeload.github.com/${repo}/tar.gz/HEAD`, { headers: { "user-agent": UA } });
    if (!res.ok) return { repo, error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return { repo, error: "too large" };
    const tarball = path.join(tmp, "r.tgz");
    fs.writeFileSync(tarball, buf);
    const src = path.join(tmp, "src");
    fs.mkdirSync(src);
    const t = spawnSync("tar", ["-xzf", tarball, "-C", src, "--strip-components=1"], { encoding: "utf8" });
    if (t.status !== 0) return { repo, error: "extract failed" };
    const r = await runChecks({ root: src, rules, mock: { __strict: true }, historical: true });
    return {
      repo,
      nearProject: r.nearProject,
      findings: r.findings.map((f) => ({ id: f.id, file: f.file, line: f.line, name: f.vars.name ?? null, severity: f.severity })),
      skipped: r.skipped.map((s) => s.id),
    };
  } catch (e) {
    return { repo, error: String(e.message).slice(0, 120) };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const targets = [];
if (reposFrom) {
  for (const l of fs.readFileSync(reposFrom, "utf8").split("\n").filter(Boolean)) {
    const { repo, language } = JSON.parse(l);
    targets.push({ repo, language });
  }
}
for (const lang of reposFrom ? [] : ["Rust", "TypeScript", "JavaScript"]) {
  try {
    targets.push(...(await search(lang)));
  } catch (e) {
    console.error(String(e.message));
  }
  await sleep(8000);
}
console.log(`selected ${targets.length} repos`);
let n = 0;
for (const t of targets) {
  if (done.has(t.repo)) continue;
  const r = { ...t, ...(await scan(t.repo)) };
  fs.appendFileSync(resultsFile, JSON.stringify(r) + "\n");
  if (++n % 10 === 0) console.log(`scanned ${n}/${targets.length - done.size}`);
  await sleep(1200);
}
console.log("study complete");
