import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const srcDir = __dirname;
  const buildDir = path.join(srcDir, '..', 'openclaw-zalo-mod-build');

  console.log('🚀 Starting Premium Obfuscated Build Workflow...');

  // 1. Clean up & Create build directory
  try {
    await fs.rm(buildDir, { recursive: true, force: true });
  } catch (e) {}
  await fs.mkdir(buildDir, { recursive: true });

  // 2. Read package.json to get release files & version
  const pkgPath = path.join(srcDir, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  const version = pkg.version;
  console.log(`📦 Packaging openclaw-zalo-mod@${version}...`);

  // 3. Copy release files to build directory
  const filesToCopy = [
    'package.json',
    'openclaw.plugin.json',
    'index.js',
    'README.md',
    'README.vi.md',
    'ZALO_OWNER_DASHBOARD.html',
    'bvbank.jpg',
    'logo.png',
    'LICENSE'
  ];

  for (const file of filesToCopy) {
    const srcFile = path.join(srcDir, file);
    const destFile = path.join(buildDir, file);
    try {
      await fs.copyFile(srcFile, destFile);
      console.log(`  ✓ Copied ${file}`);
    } catch (err) {
      console.error(`  ✗ Error copying ${file}:`, err.message);
    }
  }

  // 4. Obfuscate index.js in build directory
  const buildIndexJs = path.join(buildDir, 'index.js');
  console.log('🔒 Obfuscating index.js for distribution...');
  try {
    execSync(
      `npx -y javascript-obfuscator "${buildIndexJs}" --output "${buildIndexJs}" --compact true --identifier-names-generator hexadecimal --string-array true --string-array-encoding base64 --string-array-threshold 0.8 --transform-object-keys true`,
      { stdio: 'inherit' }
    );
    console.log('  ✓ Obfuscated index.js successfully!');
  } catch (err) {
    console.error('  ✗ Obfuscation failed:', err.message);
    process.exit(1);
  }

  // 5. Get current git commit hash
  let commitHash = 'unknown';
  try {
    commitHash = execSync('git rev-parse HEAD', { cwd: srcDir, encoding: 'utf8' }).trim();
  } catch (e) {
    console.warn('⚠️ Could not get git commit hash, using fallback.');
  }

  // 6. Publish to ClawHub
  console.log('✈️ Publishing obfuscated package to ClawHub...');
  try {
    execSync(
      `npx clawhub package publish "${buildDir}" --source-repo="https://github.com/tuanminhhole/openclaw-zalo-mod" --source-commit="${commitHash}"`,
      { stdio: 'inherit' }
    );
    console.log('✨ ClawHub Publish Completed Successfully!');
  } catch (err) {
    console.error('  ✗ ClawHub Publish Failed:', err.message);
    process.exit(1);
  }

  // 7. Cleanup build directory
  console.log('🧹 Cleaning up build artifacts...');
  try {
    await fs.rm(buildDir, { recursive: true, force: true });
    console.log('  ✓ Cleanup finished!');
  } catch (e) {}

  console.log('🎉 Workflow Finished Successfully!');
}

main();
