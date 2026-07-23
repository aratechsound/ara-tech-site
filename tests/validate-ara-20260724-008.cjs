const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const home = fs.readFileSync(path.join(root, "index.html"), "utf8");

assert.match(
    home,
    /\.hero-content h1\.hero-title \{ font-size: clamp\(1\.8rem, 5\.2vw, 3\.4rem\); letter-spacing: \.03em; line-height: 1\.3; \}/u
);
assert.match(
    home,
    /\.hero-content h1\.hero-title \.hero-tagline \{ font-size: inherit; line-height: inherit; \}/u
);
assert.match(
    home,
    /<h1 class="hero-title"><span class="d-block">広島の音響・PAレンタル・ステージ制作<\/span><span class="d-block hero-tagline mt-3">THE ART OF SOUND<\/span><\/h1>/u
);
assert.doesNotMatch(
    home,
    /<h1 class="hero-title">[\s\S]*?<span class="[^"]*\bfs-6\b[^"]*">THE ART OF SOUND<\/span>/u
);
assert.equal((home.match(/<h1\b/gu) || []).length, 1, "HOME must retain exactly one H1");

console.log("ARA-20260724-008 HOME hero tagline size regression validation passed");
