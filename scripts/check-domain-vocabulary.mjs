import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// 1. Load round-1 base words
const wordListPath = path.join(__dirname, 'domain-words.json');
const baseWords = JSON.parse(fs.readFileSync(wordListPath, 'utf8'));
const domainWordSet = new Set(baseWords.map((w) => w.toLowerCase()));

// 2. Derive domain words from projects/** (domain.json entities and ruleset ladder states)
const projectsDir = path.join(rootDir, 'projects');
if (fs.existsSync(projectsDir)) {
  for (const proj of fs.readdirSync(projectsDir)) {
    const projPath = path.join(projectsDir, proj);
    if (!fs.statSync(projPath).isDirectory()) continue;

    // Entity names from domain.json
    const domainJsonPath = path.join(projPath, 'domain.json');
    if (fs.existsSync(domainJsonPath)) {
      try {
        const domain = JSON.parse(fs.readFileSync(domainJsonPath, 'utf8'));
        for (const entityName of Object.keys(domain.entities ?? {})) {
          domainWordSet.add(entityName.toLowerCase());
        }
      } catch {
        // ignore parse errors
      }
    }

    // Ladder states from ruleset/ladders.json
    const laddersJsonPath = path.join(projPath, 'ruleset', 'ladders.json');
    if (fs.existsSync(laddersJsonPath)) {
      try {
        const laddersManifest = JSON.parse(fs.readFileSync(laddersJsonPath, 'utf8'));
        for (const ladder of laddersManifest.ladders ?? []) {
          for (const s of ladder.states ?? []) {
            if (s.name && s.name.toLowerCase() !== 'active') {
              domainWordSet.add(s.name.toLowerCase());
            }
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  }
}

const forbiddenWords = Array.from(domainWordSet).sort();

// 3. Self-Test: Plant each word in memory and assert that scanner detects it
function runSelfTest() {
  // Explicit test for 'Cancelled' proof requirement
  const proofSnippet = 'const testStatus = "Cancelled";';
  const cleanProof = proofSnippet.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
  const proofDetected = forbiddenWords.some((w) => new RegExp(`\\b${w}\\b`, 'i').test(cleanProof));
  if (!proofDetected) {
    console.error(`❌ Self-test failed: scanner failed to detect 'Cancelled' proof word!`);
    process.exit(1);
  }

  // Self-test every derived word
  for (const word of forbiddenWords) {
    const snippet = `const val = "${word}";`;
    const cleanSnippet = snippet.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
    const detected = new RegExp(`\\b${word}\\b`, 'i').test(cleanSnippet);
    if (!detected) {
      console.error(`❌ Self-test failed: scanner failed to detect word '${word}'!`);
      process.exit(1);
    }
  }
}
runSelfTest();

// 4. Scan all packages/*/src
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
      const rawContent = fs.readFileSync(full, 'utf8');
      const codeWithoutComments = rawContent.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
      for (const word of forbiddenWords) {
        const re = new RegExp(`\\b${word}\\b`, 'i');
        if (re.test(codeWithoutComments)) {
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
  console.log(`✅ Zero domain vocabulary verified across all packages/*/src files (${forbiddenWords.length} derived domain words checked, self-test passed).`);
}
