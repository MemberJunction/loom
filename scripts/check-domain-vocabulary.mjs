import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const wordListPath = path.join(__dirname, 'domain-words.json');
const forbiddenWords = JSON.parse(fs.readFileSync(wordListPath, 'utf8'));

const packagesDir = path.join(rootDir, 'packages');
const packages = fs.readdirSync(packagesDir);

let violations = 0;

function scanDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scanDir(full);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
      const content = fs.readFileSync(full, 'utf8').toLowerCase();
      for (const word of forbiddenWords) {
        if (content.includes(word.toLowerCase())) {
          console.error(`❌ Domain vocabulary violation in ${path.relative(rootDir, full)}: contains forbidden word '${word}'`);
          violations++;
        }
      }
    }
  }
}

for (const pkg of packages) {
  const srcDir = path.join(packagesDir, pkg, 'src');
  if (fs.existsSync(srcDir)) {
    scanDir(srcDir);
  }
}

if (violations > 0) {
  console.error(`\n❌ Found ${violations} domain vocabulary violation(s) in packages/*/src.`);
  process.exit(1);
} else {
  console.log(`✅ Zero domain vocabulary verified across all packages/*/src files.`);
}
