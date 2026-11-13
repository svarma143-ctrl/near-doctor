import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RULES_DIR, loadRules } from "../src/index.mjs";
import { rulesMarkdown } from "../src/report.mjs";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "FRICTION_LOG.md");
const generated = rulesMarkdown(loadRules(DEFAULT_RULES_DIR));

if (process.argv.includes("--check")) {
  const current = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  if (current !== generated) {
    process.stderr.write("docs/FRICTION_LOG.md is out of date. Run: npm run log\n");
    process.exit(1);
  }
  process.stdout.write("docs/FRICTION_LOG.md is up to date\n");
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, generated);
  process.stdout.write(`wrote ${path.relative(process.cwd(), out)}\n`);
}
