const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

for (const file of ["pa-case-portal-management.cjs", "pa-event-portal-organizer.cjs"]) {
  const result = spawnSync(process.execPath, [path.join(__dirname, "browser", file)], {
    stdio: "inherit",
    timeout: 90_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${file} did not pass`);
}
