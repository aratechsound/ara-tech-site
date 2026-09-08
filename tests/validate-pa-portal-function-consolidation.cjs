const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const apiDirectory = path.join(root, "api");
const functionFiles = fs.readdirSync(apiDirectory).filter((name) => name.endsWith(".js")).sort();
assert.equal(functionFiles.length, 12);
assert.equal(functionFiles.includes("event-portal.js"), false);
assert.equal(fs.existsSync(path.join(apiDirectory, "_pa-portal-organizer-handler.cjs")), true);

const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
assert(vercel.rewrites.some((route) => route.source === "/api/event-portal" && route.destination === "/api/pa-portal?surface=organizer"));

const portalApiPath = require.resolve("../api/pa-portal.js");
const organizerHandlerPath = require.resolve("../api/_pa-portal-organizer-handler.cjs");
const originalHandler = require.cache[organizerHandlerPath];
let organizerDispatches = 0;
require.cache[organizerHandlerPath] = {
  id: organizerHandlerPath,
  filename: organizerHandlerPath,
  loaded: true,
  exports: { handleOrganizerPortal: async () => { organizerDispatches += 1; return "organizer"; } }
};
delete require.cache[portalApiPath];
const handler = require(portalApiPath);

const response = () => ({
  headers: {},
  statusCode: null,
  setHeader(name, value) { this.headers[name] = value; },
  status(code) { this.statusCode = code; return this; },
  json(value) { this.body = value; return value; }
});

(async () => {
  assert.equal(await handler({ query: { surface: "organizer" }, method: "POST" }, response()), "organizer");
  assert.equal(organizerDispatches, 1);
  const adminResponse = response();
  await handler({ query: {}, method: "GET" }, adminResponse);
  assert.equal(organizerDispatches, 1);
  assert.equal(adminResponse.statusCode, 405);
  console.log("PA portal Function consolidation: PASS (12 Functions, rewrite, immediate organizer/admin dispatch)");
})().finally(() => {
  delete require.cache[portalApiPath];
  if (originalHandler) require.cache[organizerHandlerPath] = originalHandler;
  else delete require.cache[organizerHandlerPath];
}).catch((error) => { console.error(error); process.exitCode = 1; });
