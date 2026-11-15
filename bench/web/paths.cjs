// Shared paths for the web bench scripts. Scratch goes to
// $BENCH_WORK/web (default <repo>/local-setup/bench/web); Playwright is the
// copy installed for packages/e2e.
const path = require('path');
const fs = require('fs');
const REPO = path.resolve(__dirname, '../..');
const WORK = path.join(process.env.BENCH_WORK || path.join(REPO, 'local-setup', 'bench'), 'web');
const OUT = path.join(WORK, 'out');
fs.mkdirSync(OUT, { recursive: true });
const playwright = () => require(path.join(REPO, 'packages', 'e2e', 'node_modules', '@playwright', 'test'));
module.exports = { REPO, WORK, OUT, HERE: __dirname, playwright };
