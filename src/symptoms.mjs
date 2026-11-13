/**
 * Match pasted tool output against the `symptoms` of each rule.
 * Returns [{rule, vars, matched}]; `vars` come from named groups and `extract` patterns.
 */
export function matchSymptoms(text, rules, { only, ignore } = {}) {
  const out = [];
  for (const rule of rules) {
    if (!rule.symptoms) continue;
    if (only && !only.includes(rule.id)) continue;
    if (ignore && ignore.includes(rule.id)) continue;
    for (const s of rule.symptoms) {
      const flags = s.flags || "";
      const m = new RegExp(s.pattern, flags).exec(text);
      if (!m) continue;
      if (s.all && !s.all.every((p) => new RegExp(p, flags).test(text))) continue;
      const vars = { ...(m.groups || {}) };
      for (const ex of s.extract || []) {
        for (const p of ex.patterns) {
          const em = new RegExp(p, "m").exec(text);
          if (em) {
            vars[ex.var] = em[0].replace(/^[\s│|]+/, "").trim();
            break;
          }
        }
      }
      out.push({ rule, vars, matched: m[0].slice(0, 200) });
      break;
    }
  }
  return out;
}
