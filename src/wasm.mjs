const POST_MVP = new Set([
  "bulk-memory",
  "bulk-memory-opt",
  "reference-types",
  "multivalue",
  "sign-ext",
  "nontrapping-fptoint",
  "call-indirect-overlong",
  "simd128",
  "exception-handling",
  "tail-call",
  "extended-const",
  "atomics",
]);

/** Read section layout and the `target_features` custom section of a wasm module. */
export function inspectWasm(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x0061736d) throw new Error("not a wasm module (bad magic)");
  let i = 8;
  const leb = () => {
    let r = 0;
    let s = 0;
    let b;
    do {
      if (i >= buf.length) throw new Error("truncated wasm module");
      b = buf[i++];
      r += (b & 0x7f) * 2 ** s;
      s += 7;
    } while (b & 0x80);
    return r;
  };
  const sections = [];
  let features = null;
  while (i < buf.length) {
    const id = buf[i++];
    const len = leb();
    const end = i + len;
    let name = null;
    if (id === 0) {
      const nl = leb();
      name = buf.subarray(i, i + nl).toString("latin1");
      i += nl;
      if (name === "target_features") {
        const count = leb();
        features = { enabled: [], disabled: [], required: [] };
        for (let k = 0; k < count; k++) {
          const prefix = buf[i++];
          const l = leb();
          const f = buf.subarray(i, i + l).toString("latin1");
          i += l;
          if (prefix === 0x2b) features.enabled.push(f);
          else if (prefix === 0x2d) features.disabled.push(f);
          else features.required.push(f);
        }
      }
    }
    sections.push({ id, name, size: len });
    i = end;
  }
  return {
    size: buf.length,
    sections,
    targetFeatures: features,
    postMvp: features ? features.enabled.filter((f) => POST_MVP.has(f)) : null,
  };
}
