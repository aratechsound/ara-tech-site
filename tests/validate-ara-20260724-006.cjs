const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const worksAdmin = read("admin.html");
const paAdmin = read("pa-admin.html");
const navigationCss = read("admin-navigation.css");

assert.match(worksAdmin, /admin-navigation\.css\?v=ara-20260724-004/);
assert.match(paAdmin, /admin-navigation\.css\?v=ara-20260724-004/);

assert.match(
    worksAdmin,
    /<nav class="admin-nav" aria-label="管理画面">\s*<a class="admin-nav__link--works" href="admin\.html" aria-current="page">WORKS管理<\/a>\s*<a class="admin-nav__link--pa" href="pa-admin\.html">PA案件管理<\/a>\s*<\/nav>/
);
assert.match(
    paAdmin,
    /<nav class="admin-nav" aria-label="管理画面">\s*<a class="admin-nav__link--works" href="admin\.html">WORKS管理<\/a>\s*<a class="admin-nav__link--pa" href="pa-admin\.html" aria-current="page">PA案件管理<\/a>\s*<\/nav>/
);

assert.match(navigationCss, /\.admin-nav a\s*\{/);
assert.match(navigationCss, /\.admin-nav a:hover\s*\{/);
assert.match(navigationCss, /\.admin-nav a:active\s*\{/);
assert.match(navigationCss, /\.admin-nav a:focus-visible\s*\{/);
assert.match(
    navigationCss,
    /\.admin-nav a\s*\{[\s\S]*?background:\s*#005bb9;[\s\S]*?color:\s*white;/
);
assert.match(
    navigationCss,
    /\.admin-nav a\[aria-current="page"\]\s*\{[\s\S]*?background:\s*white;[\s\S]*?color:\s*#005bb9;/
);
assert.match(navigationCss, /\.admin-nav a\[aria-current="page"\]:hover\s*\{/);
assert.match(navigationCss, /\.admin-nav a\[aria-current="page"\]:active\s*\{/);
assert.match(navigationCss, /border-radius:\s*999px/);
assert.match(navigationCss, /text-decoration:\s*none/);
assert.match(navigationCss, /@media \(max-width:\s*700px\)/);
assert.doesNotMatch(navigationCss, /text-decoration:\s*underline/);
assert.doesNotMatch(navigationCss, /border-bottom/);
assert.doesNotMatch(navigationCss, /transform\s*:/);

assert.match(worksAdmin, /<a class="brand" href="\.\/">/);
assert.match(paAdmin, /<a class="brand" href="\.\/">/);
assert.doesNotMatch(worksAdmin, /PA予約管理|公開ページを見る/);
assert.doesNotMatch(paAdmin, /PA予約管理|公開ページを見る/);

console.log("validate-ara-20260724-006: admin current-page color swap and responsive structure checks passed");
