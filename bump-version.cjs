// Run before committing a change meant to be deployed: bumps version.json
// so the header's version tag (vN) reflects the new deploy.
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, 'version.json');
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
data.build += 1;
fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
console.log('version.json bumped to build ' + data.build);
