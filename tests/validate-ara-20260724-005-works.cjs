const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const worksJs = fs.readFileSync(path.join(root, 'js', 'works.js'), 'utf8');
const worksHtml = fs.readFileSync(path.join(root, 'works.html'), 'utf8');

assert.match(worksJs, /\/storage\/v1\/render\/image\/public\//);
assert.match(worksJs, /\[320, 480, 640\]/);
assert.match(worksJs, /quality', '72'/);
assert.match(worksJs, /resize', 'contain'/);
assert.match(worksJs, /image\.srcset =/);
assert.match(worksJs, /image\.sizes = workImageSizes/);
assert.match(worksJs, /image\.width = 3/);
assert.match(worksJs, /image\.height = 4/);

assert.match(worksJs, /min-width: 1200px[\s\S]*return 5/);
assert.match(worksJs, /min-width: 992px[\s\S]*return 4/);
assert.match(worksJs, /min-width: 768px[\s\S]*return 3/);
assert.match(worksJs, /min-width: 460px[\s\S]*return 2/);
assert.match(worksJs, /image\.loading = index < eagerCount \? 'eager' : 'lazy'/);
assert.match(worksJs, /image\.decoding = index < eagerCount \? 'sync' : 'async'/);
assert.match(worksJs, /if \(index === 0\) image\.fetchPriority = 'high'/);
assert.doesNotMatch(worksJs, /forEach\([^)]*=>[^;]*fetchPriority/s);

assert.match(worksJs, /removeAttribute\('srcset'\)/);
assert.match(worksJs, /removeAttribute\('sizes'\)/);
assert.match(worksJs, /image\.src = originalImageUrl/);
assert.match(worksJs, /image\.alt = post\.flyer_alt \|\|/);
assert.match(worksJs, /visiblePosts\.forEach\(\(post, index\)/);

assert.match(worksHtml, /#latest-works \{[^}]*min-height: 327px/);
assert.match(worksHtml, /@media \(max-width: 459px\)[^{]*\{[^}]*#latest-works \{[^}]*grid-template-columns: 1fr;[^}]*min-height:/);
assert.match(worksHtml, /\.work-card img \{[^}]*height: auto;/);
assert.match(worksHtml, /\.work-card--link img \{ aspect-ratio: 3 \/ 4;/);

new vm.Script(worksJs.replace(/^import .*$/gm, ''), { filename: 'js/works.js' });

console.log('ARA-20260724-005 WORKS responsive thumbnail and first-row loading validation passed');
