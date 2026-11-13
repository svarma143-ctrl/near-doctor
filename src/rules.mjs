import fs from "node:fs";
import path from "node:path";
import { DETECTORS } from "./detectors.mjs";

export const SEVERITIES = ["error", "warn", "info"];
export const TIERS = ["verified-here", "reported", "hypothesis"];
export const STATUSES = ["active", "historical", "log-only"];
export const AUTOFIX_TYPES = ["rust-crate-attr", "cargo-dev-dep", "rustup-target-add"];
const FORBIDDEN_KEYS = new Set(["shell", "exec", "command", "script", "eval", "run"]);

export function loadRules(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return files.map((f) => {
    const rule = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    rule.__file = f;
    return rule;
  });
}

function checkRegex(src, flags, where, errors) {
  if (typeof src !== "string") return errors.push(`${where}: regex must be a string`);
  if (/[gy]/.test(flags || "")) errors.push(`${where}: flags g/y are not allowed (stateful)`);
  try {
    new RegExp(src, flags || "");
  } catch (e) {
    errors.push(`${where}: invalid regex (${e.message})`);
  }
}

function scanForbidden(obj, where, errors) {
  if (Array.isArray(obj)) return obj.forEach((x, i) => scanForbidden(x, `${where}[${i}]`, errors));
  if (obj && typeof obj === "object") {
    for (const [k, v] of Object.entries(obj)) {
      if (FORBIDDEN_KEYS.has(k)) errors.push(`${where}.${k}: rules are data-only; key "${k}" is not allowed`);
      scanForbidden(v, `${where}.${k}`, errors);
    }
  }
}

/** Returns a list of error strings (empty when the rule is valid). */
export function validateRule(rule) {
  const e = [];
  const id = rule.id;
  const w = `${id ?? rule.__file ?? "rule"}`;
  if (!/^(F|R|E)-\d{3}$/.test(id || "")) e.push(`${w}: id must look like F-001, R-001 or E-001`);
  if (rule.__file && rule.__file !== `${id}.json`) e.push(`${w}: file name must be ${id}.json`);
  for (const k of ["title", "summary"]) if (typeof rule[k] !== "string" || !rule[k].trim()) e.push(`${w}: ${k} is required`);
  if (!SEVERITIES.includes(rule.severity)) e.push(`${w}: severity must be one of ${SEVERITIES.join(", ")}`);
  if (!TIERS.includes(rule.tier)) e.push(`${w}: tier must be one of ${TIERS.join(", ")}`);
  if (!STATUSES.includes(rule.status)) e.push(`${w}: status must be one of ${STATUSES.join(", ")}`);
  scanForbidden(rule, w, e);

  const hasDetect = rule.detect != null;
  const hasSymptoms = Array.isArray(rule.symptoms) && rule.symptoms.length > 0;
  if (rule.status === "log-only" && (hasDetect || hasSymptoms)) e.push(`${w}: log-only rules must not have detect or symptoms`);
  if (rule.status !== "log-only" && !hasDetect && !hasSymptoms) e.push(`${w}: needs detect and/or symptoms (or status log-only)`);
  if (rule.tier === "hypothesis" && rule.status === "active" && rule.severity !== "info") {
    e.push(`${w}: hypothesis rules must not warn (use severity info or status log-only)`);
  }

  if (hasDetect) {
    const d = rule.detect;
    if (d.kind === "file-regex") {
      if (!Array.isArray(d.globs) || !d.globs.length) e.push(`${w}: file-regex needs globs`);
      if (!(d.all?.length || d.any?.length)) e.push(`${w}: file-regex needs all and/or any`);
      for (const k of ["all", "any", "unless"]) (d[k] || []).forEach((r, i) => checkRegex(r, d.flags, `${w}.detect.${k}[${i}]`, e));
    } else if (d.kind === "detector") {
      if (!DETECTORS[d.name]) e.push(`${w}: unknown detector "${d.name}"`);
    } else e.push(`${w}: detect.kind must be file-regex or detector`);
  }
  if (hasSymptoms) {
    rule.symptoms.forEach((s, i) => {
      checkRegex(s.pattern, s.flags, `${w}.symptoms[${i}].pattern`, e);
      (s.all || []).forEach((r, j) => checkRegex(r, s.flags, `${w}.symptoms[${i}].all[${j}]`, e));
      (s.extract || []).forEach((x, j) => {
        if (!x.var) e.push(`${w}.symptoms[${i}].extract[${j}]: var required`);
        (x.patterns || []).forEach((p, k) => checkRegex(p, "", `${w}.symptoms[${i}].extract[${j}].patterns[${k}]`, e));
      });
    });
  }

  if (rule.status !== "log-only" || rule.fix) {
    if (!rule.fix || !Array.isArray(rule.fix.steps) || !rule.fix.steps.length) e.push(`${w}: fix.steps is required`);
  }
  const af = rule.fix?.autofix;
  if (af) {
    if (!AUTOFIX_TYPES.includes(af.type)) e.push(`${w}: autofix.type must be one of ${AUTOFIX_TYPES.join(", ")}`);
    if (af.type === "rustup-target-add" && !/^[a-z0-9_-]+$/.test(af.target || "")) e.push(`${w}: autofix.target invalid`);
    if (af.type === "cargo-dev-dep" && !(/^[a-z0-9_-]+$/.test(af.crate || "") && /^[0-9][0-9A-Za-z.*^~<>=, -]*$/.test(af.version || ""))) {
      e.push(`${w}: autofix crate/version invalid`);
    }
    if (af.type === "rust-crate-attr" && !/^#!\[allow\([a-z_:]+\)\]$/.test(af.attr || "")) e.push(`${w}: autofix.attr must be #![allow(lint)]`);
    if (typeof af.description !== "string") e.push(`${w}: autofix.description required`);
  }

  for (const r of rule.refs || []) if (!/^https?:\/\//.test(r)) e.push(`${w}: refs must be http(s) URLs`);
  if (rule.tier === "verified-here" && !(rule.evidence && rule.evidence.observed)) e.push(`${w}: verified-here needs evidence.observed`);
  if (rule.tier === "reported" && !(rule.refs && rule.refs.length)) e.push(`${w}: reported rules need at least one ref`);
  if (rule.status === "historical" && !(rule.evidence && rule.evidence.reproduction)) e.push(`${w}: historical rules need evidence.reproduction`);
  return e;
}

/** Validates all rules, id uniqueness, and that every runnable rule has its fixtures on disk. */
export function validateRules(rules, { fixturesDir } = {}) {
  const errors = [];
  const seen = new Set();
  for (const r of rules) {
    errors.push(...validateRule(r));
    if (seen.has(r.id)) errors.push(`${r.id}: duplicate id`);
    seen.add(r.id);
    if (fixturesDir && r.status !== "log-only") {
      const base = path.join(fixturesDir, r.id);
      if (r.detect) {
        for (const d of ["repro", "control"]) {
          if (!fs.existsSync(path.join(base, d))) errors.push(`${r.id}: missing fixtures/${r.id}/${d}/`);
        }
      }
      if (r.symptoms?.length) {
        for (const f of ["repro.txt", "control.txt"]) {
          if (!fs.existsSync(path.join(base, f))) errors.push(`${r.id}: missing fixtures/${r.id}/${f}`);
        }
      }
    }
  }
  return errors;
}
