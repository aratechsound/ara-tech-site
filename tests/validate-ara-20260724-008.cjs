const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const home = fs.readFileSync(path.join(root, "index.html"), "utf8");
const heroTypography = fs.readFileSync(path.join(root, "hero-typography.css"), "utf8");

assert.match(
    heroTypography,
    /--hero-title-size: clamp\(1\.9rem, 2vw \+ 0\.95rem, 2\.75rem\);/u
);
assert.match(
    heroTypography,
    /--hero-title-size-home: var\(--hero-title-size\);/u
);
assert.match(
    home,
    /<h1 class="hero-title site-hero__title site-hero__title--home">[\s\S]*?<span class="hero-tagline site-hero__label">THE ART OF SOUND<\/span><\/h1>/u
);
assert.match(
    heroTypography,
    /\.site-hero--home \.container \.site-hero__title \.site-hero__label \{[\s\S]*?font-size: inherit !important;/u
);
assert.equal((home.match(/<h1\b/gu) || []).length, 1, "HOME must retain exactly one H1");

console.log("ARA-20260724-008 HOME hero philosophy size regression validation passed");
