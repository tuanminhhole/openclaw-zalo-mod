import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const packageJsonPath = path.join(__dirname, 'package.json');
  const pluginJsonPath = path.join(__dirname, 'openclaw.plugin.json');
  const indexJsPath = path.join(__dirname, 'index.js');

  const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  const version = pkg.version;

  const pluginJson = JSON.parse(await fs.readFile(pluginJsonPath, 'utf8'));
  pluginJson.version = version;
  await fs.writeFile(pluginJsonPath, JSON.stringify(pluginJson, null, 2) + '\n', 'utf8');

  let indexJs = await fs.readFile(indexJsPath, 'utf8');
  indexJs = indexJs.replace(/@version \d+\.\d+\.\d+/, `@version ${version}`);
  await fs.writeFile(indexJsPath, indexJs, 'utf8');

  console.log(`✅ Bumped version across files to ${version}`);
}

main();
