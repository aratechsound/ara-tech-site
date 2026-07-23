const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const navigationCss = read("site-navigation.css");
const workDetailCss = read("work-detail.css");
const workApi = read("api/work.js");

const publicPages = [
    "index.html",
    "pa-rental.html",
    "stage-production.html",
    "tour-pa.html",
    "installation.html",
    "works.html",
    "contact.html",
    "general-inquiry.html",
    "pa-inquiry.html",
    "thanks.html",
    "privacy.html"
];

for (const file of publicPages) {
    assert.match(read(file), /site-navigation\.css\?v=ara-20260724-007/, `${file} must load shared public header CSS`);
}

const currentPageChecks = new Map([
    ["index.html", /href="\.\/" aria-current="page">HOME<\/a>/],
    ["pa-rental.html", /href="pa-rental\.html" aria-current="page">PA RENTAL<\/a>/],
    ["stage-production.html", /href="stage-production\.html" aria-current="page">STAGE<\/a>/],
    ["tour-pa.html", /href="tour-pa\.html" aria-current="page">TOUR PA<\/a>/],
    ["installation.html", /href="installation\.html" aria-current="page">INSTALLATION<\/a>/],
    ["works.html", /href="works\.html" aria-current="page">WORKS<\/a>/],
    ["contact.html", /href="contact\.html" aria-current="page">CONTACT<\/a>/],
    ["general-inquiry.html", /href="contact\.html" aria-current="page">CONTACT<\/a>/],
    ["pa-inquiry.html", /href="contact\.html" aria-current="page">CONTACT<\/a>/],
    ["thanks.html", /href="contact\.html" aria-current="page">CONTACT<\/a>/]
]);

for (const [file, pattern] of currentPageChecks) {
    const html = read(file);
    const headerNavigation = html.match(/<nav class="navbar[\s\S]*?<\/nav>/)?.[0] || "";
    assert.match(headerNavigation, pattern, `${file} must mark its related public navigation item current`);
    assert.equal((headerNavigation.match(/aria-current="page"/g) || []).length, 1, `${file} must expose exactly one current public menu item`);
}

assert.match(navigationCss, /\.navbar \.nav-link,[\s\S]*?background:\s*#007bff/);
assert.match(navigationCss, /\[aria-current="page"\][\s\S]*?background:\s*white/);
assert.match(navigationCss, /border-radius:\s*999px/);
assert.match(navigationCss, /@media \(max-width:\s*991px\)/);
assert.match(navigationCss, /width:\s*min\(100%,\s*220px\)/);
assert.doesNotMatch(navigationCss, /text-decoration:\s*underline/);
assert.doesNotMatch(navigationCss, /transform\s*:/);

assert.match(workApi, /site-navigation\.css\?v=ara-20260724-007/);
assert.match(workApi, /href="\/works\.html" aria-current="page">WORKS<\/a>/);
assert.match(workDetailCss, /\.nav-link\[aria-current='page'\] \{ text-decoration: none/);

const headingPages = [
    "pa-rental.html",
    "stage-production.html",
    "tour-pa.html",
    "installation.html",
    "works.html",
    "contact.html",
    "general-inquiry.html",
    "pa-inquiry.html",
    "thanks.html",
    "privacy.html"
];

for (const file of headingPages) {
    assert.match(read(file), /<h1[^>]*class="[^"]*public-page-heading[^"]*"/, `${file} must use the shared top-heading class`);
}

const home = read("index.html");
assert.match(home, /\.hero-content h1\.hero-title \{ font-size: clamp\(1\.8rem, 5\.2vw, 3\.4rem\); letter-spacing: \.03em; line-height: 1\.3; \}/);
assert.doesNotMatch(home, /<h1[^>]*public-page-heading/);
assert.match(navigationCss, /\.public-page-heading\s*\{[\s\S]*?font-size:\s*clamp\(1\.8rem,\s*5\.2vw,\s*3\.4rem\)[\s\S]*?font-weight:\s*900[\s\S]*?letter-spacing:\s*\.03em[\s\S]*?line-height:\s*1\.3[\s\S]*?text-align:\s*center/);
assert.match(navigationCss, /\.public-page-heading \.phrase-lock\s*\{[\s\S]*?white-space:\s*normal/);
assert.match(navigationCss, /\.public-page-heading \.fs-6\s*\{[\s\S]*?font-size:\s*1rem !important[\s\S]*?line-height:\s*1\.5 !important/);
assert.match(navigationCss, /\.page-header > \.container,[\s\S]*?text-align:\s*center !important/);
assert.match(navigationCss, /\.page-header \.eyebrow,[\s\S]*?font-size:\s*\.78rem !important[\s\S]*?text-align:\s*center !important/);
assert.match(navigationCss, /\.page-header \.lead,[\s\S]*?font-size:\s*clamp\(\.95rem,\s*1\.8vw,\s*1\.05rem\) !important[\s\S]*?font-weight:\s*700 !important[\s\S]*?line-height:\s*1\.75 !important[\s\S]*?text-align:\s*center !important/);

console.log("validate-ara-20260724-005: public current-page navigation and HOME-based top headings passed");
