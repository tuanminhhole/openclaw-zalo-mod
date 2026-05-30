import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const packageJsonPath = path.join(__dirname, 'package.json');
  const pluginJsonPath = path.join(__dirname, 'openclaw.plugin.json');
  const indexJsPath = path.join(__dirname, 'index.js');
  const dashboardHtmlPath = path.join(__dirname, 'ZALO_OWNER_DASHBOARD.html');

  const pkg = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  const version = pkg.version;

  const pluginJson = JSON.parse(await fs.readFile(pluginJsonPath, 'utf8'));
  pluginJson.version = version;
  await fs.writeFile(pluginJsonPath, JSON.stringify(pluginJson, null, 2) + '\n', 'utf8');

  let indexJs = await fs.readFile(indexJsPath, 'utf8');
  indexJs = indexJs.replace(/@version \d+\.\d+\.\d+/, `@version ${version}`);
  await fs.writeFile(indexJsPath, indexJs, 'utf8');

  let dashboardHtml = await fs.readFile(dashboardHtmlPath, 'utf8');
  dashboardHtml = dashboardHtml.replace(/const pluginVersion = '\d+\.\d+\.\d+';/, `const pluginVersion = '${version}';`);
  dashboardHtml = dashboardHtml.replace(/<span id="pluginVersion">v\d+\.\d+\.\d+<\/span>/, `<span id="pluginVersion">v${version}</span>`);
  await fs.writeFile(dashboardHtmlPath, dashboardHtml, 'utf8');

  console.log(`✅ Bumped version across files to ${version}`);
}

main();
