const Module = require("module"); const path = require("path");
const orig = Module._resolveFilename; const B = path.resolve(__dirname, "buildall");
Module._resolveFilename = function (req, parent, ...r) {
  if (req.startsWith("@/")) return orig.call(this, path.join(B, req.slice(2)), parent, ...r);
  if (req.endsWith(".css")) return path.join(__dirname, "empty.js");
  return orig.call(this, req, parent, ...r);
};
