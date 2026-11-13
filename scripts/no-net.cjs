// Fails loudly if anything tries to open a network connection. Used by scripts/verify.mjs to prove that
// near-doctor makes no network calls unless --net is passed:  node --require ./scripts/no-net.cjs ...
const net = require("node:net");
net.Socket.prototype.connect = function () {
  throw new Error("NETWORK ACCESS ATTEMPTED");
};
globalThis.fetch = () => {
  throw new Error("NETWORK ACCESS ATTEMPTED");
};
