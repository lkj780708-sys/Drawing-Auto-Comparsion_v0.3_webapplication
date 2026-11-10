// 검증 전용: "@/..." 경로와 next/* 모듈을 Node 에서 풀기 위한 require 훅
const Module = require("module");
const path = require("path");
const React = require("react");
const orig = Module._resolveFilename;
const BUILD = path.resolve(__dirname, "../build");
const shims = {
  "next/link": path.join(__dirname, "link.js"),
  "next/navigation": path.join(__dirname, "navigation.js"),
};
Module._resolveFilename = function (req, parent, ...rest) {
  if (req.startsWith("@/")) return orig.call(this, path.join(BUILD, req.slice(2)), parent, ...rest);
  if (shims[req]) return shims[req];
  if (req.endsWith(".css")) return path.join(__dirname, "empty.js");
  return orig.call(this, req, parent, ...rest);
};
