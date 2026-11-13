import { lineIndex } from "./util.mjs";

/** Replace comments and string/char literals with spaces (same length, newlines kept). */
export function stripRust(src) {
  const out = src.split("");
  const n = src.length;
  const blank = (a, b) => {
    for (let k = a; k < b && k < n; k++) if (out[k] !== "\n") out[k] = " ";
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "/") {
      let j = i;
      while (j < n && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && d === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === "/" && src[j + 1] === "*") {
          depth++;
          j += 2;
        } else if (src[j] === "*" && src[j + 1] === "/") {
          depth--;
          j += 2;
        } else j++;
      }
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "r" && (d === '"' || d === "#") && (i === 0 || !/[A-Za-z0-9_]/.test(src[i - 1]))) {
      let j = i + 1;
      let h = 0;
      while (src[j] === "#") {
        h++;
        j++;
      }
      if (src[j] === '"') {
        j++;
        const close = '"' + "#".repeat(h);
        const e = src.indexOf(close, j);
        const end = e === -1 ? n : e + close.length;
        blank(i, end);
        i = end;
        continue;
      }
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== '"') {
        if (src[j] === "\\") j++;
        j++;
      }
      blank(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "'") {
      const m = /^'(?:\\[^']*|[^'\\])'/.exec(src.slice(i, i + 12));
      if (m) {
        blank(i, i + m[0].length);
        i += m[0].length;
        continue;
      }
    }
    i++;
  }
  return out.join("");
}

/** Count top-level parameters of the first parenthesised list at/after `from`. */
function parseParams(clean, from) {
  let i = from;
  let angle = 0;
  while (i < clean.length) {
    const c = clean[i];
    if (c === "<") angle++;
    else if (c === ">" && clean[i - 1] !== "-") angle = Math.max(0, angle - 1);
    else if (c === "(" && angle === 0) break;
    else if (c === "{" || c === ";") return null;
    i++;
  }
  if (clean[i] !== "(") return null;
  let depth = 0;
  let a = 0;
  let count = 0;
  let seen = false;
  const start = i;
  for (; i < clean.length; i++) {
    const c = clean[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") {
      depth--;
      if (depth === 0) {
        if (seen) count++;
        return { count, end: i + 1, start };
      }
    } else if (c === "<") a++;
    else if (c === ">" && clean[i - 1] !== "-" && clean[i - 1] !== "=") a = Math.max(0, a - 1);
    else if (c === "," && depth === 1 && a === 0) {
      if (seen) count++;
      seen = false;
      continue;
    }
    if (depth >= 1 && !/\s/.test(c) && i !== start) seen = true;
  }
  return null;
}

/**
 * Lightweight scan of a Rust source file for NEAR contract structure.
 * Returns the public methods of `#[near]`/`#[near_bindgen]` impls, free functions per module,
 * and whether `clippy::too_many_arguments` is allowed at file level.
 */
export function scanNear(src) {
  const clean = stripRust(src);
  const li = lineIndex(src);
  const re = /#!?\[[^\]]*\]|\b(?:mod|impl|fn|struct|enum|trait|union|pub|type|static|use)\b|[{};]/g;
  const stack = [];
  const methods = [];
  const freeFns = [];
  let pendingNear = false;
  let pendingItem = null;
  let pendingName = null;
  let pendingPub = false;
  const top = () => stack[stack.length - 1];
  const reset = () => {
    pendingItem = null;
    pendingNear = false;
    pendingPub = false;
    pendingName = null;
  };
  let m;
  while ((m = re.exec(clean))) {
    const t = m[0];
    if (t[0] === "#") {
      if (/^#\[\s*(near|near_bindgen)\b/.test(t)) pendingNear = true;
      continue;
    }
    if (t === "pub") {
      const after = /^\s*(\()?/.exec(clean.slice(re.lastIndex));
      pendingPub = !(after && after[1]);
      continue;
    }
    if (t === "{") {
      const parent = top();
      const kind = pendingItem === "mod" ? "mod" : pendingItem === "impl" ? "impl" : pendingItem === "fn" ? "fn" : "other";
      const module = kind === "mod" ? [...(parent ? parent.module : []), pendingName] : parent ? parent.module : [];
      stack.push({ kind, module, near: kind === "impl" && pendingNear });
      reset();
      continue;
    }
    if (t === "}") {
      stack.pop();
      reset();
      continue;
    }
    if (t === ";") {
      reset();
      continue;
    }
    if (t === "mod") {
      const nm = /^\s+([A-Za-z_]\w*)/.exec(clean.slice(re.lastIndex));
      if (nm) {
        pendingItem = "mod";
        pendingName = nm[1];
      }
      continue;
    }
    if (t === "impl") {
      if (pendingItem !== "fn") pendingItem = "impl";
      continue;
    }
    if (t === "fn") {
      const rest = clean.slice(re.lastIndex);
      const nm = /^\s+([A-Za-z_]\w*)/.exec(rest);
      if (!nm) continue; // fn pointer type
      const name = nm[1];
      const par = top();
      const namePos = re.lastIndex + rest.indexOf(name);
      const params = parseParams(clean, namePos + name.length);
      if (par && par.kind === "impl" && par.near && pendingPub) {
        methods.push({ name, params: params ? params.count : 0, line: li(namePos), module: par.module.join("::") });
      } else if (!par || par.kind === "mod") {
        freeFns.push({ name, line: li(namePos), module: (par ? par.module : []).join("::") });
      }
      pendingItem = "fn";
      pendingPub = false;
      if (params) re.lastIndex = params.end;
      continue;
    }
    // struct / enum / trait / union / type / static / use
    pendingItem = t;
  }
  return {
    methods,
    freeFns,
    allowsTooManyArgs: /#!\[\s*allow\([^\]]*too_many_arguments/.test(clean),
  };
}
