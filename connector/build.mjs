#!/usr/bin/env node
// Packages the agent connector for one hosting site: a Claude Desktop extension (.mcpb), a versioned
// tarball for `npx -y <url>`, the skill, and a setup page for agents. The site's name and addresses are
// stamped into brand.json, so this repository stays free of any deployment's branding.
//
//   node connector/build.mjs --name "Example Spaces" --url https://app.example.com \
//     --site https://example.com --slug example --out ./dist/agents [--doc ./dist/agents.md] [--icon icon.png]
//
// The files are served from `<site>/agents/`. `--validate` checks the extension manifest with the
// official MCPB tool (downloaded by npx).
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1] && !all[index + 1].startsWith('--') ? all[index + 1] : true]);
  return pairs;
}, []));
for (const required of ['name', 'url', 'site', 'slug', 'out']) {
  if (typeof args[required] !== 'string') { console.error(`Missing --${required}. See the usage at the top of this file.`); process.exit(2); }
}
if (!/^[a-z][a-z0-9-]{1,30}$/.test(args.slug)) { console.error('--slug must be lowercase letters, digits and hyphens.'); process.exit(2); }
const brand = { name: args.name, url: args.url.replace(/\/+$/, ''), slug: args.slug };
const site = args.site.replace(/\/+$/, '');
const out = path.resolve(args.out);
const packageJson = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'));
const { version } = packageJson;
const tarball = `${brand.slug}-${version}.tgz`;
const packageUrl = `${site}/agents/${tarball}`;
const fill = text => text.replaceAll('{{name}}', brand.name).replaceAll('{{slug}}', brand.slug).replaceAll('{{url}}', brand.url)
  .replaceAll('{{site}}', site).replaceAll('{{package}}', packageUrl);

mkdirSync(out, { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), 'sphr-connector-build-'));
try {
  // The npm package, run with `npx -y <site>/agents/<tarball>`.
  const npm = path.join(work, 'npm');
  mkdirSync(npm);
  copyFileSync(path.join(here, 'server.mjs'), path.join(npm, 'server.mjs'));
  writeFileSync(path.join(npm, 'brand.json'), `${JSON.stringify(brand, null, 2)}\n`);
  writeFileSync(path.join(npm, 'SKILL.md'), fill(readFileSync(path.join(here, 'SKILL.md'), 'utf8')));
  writeFileSync(path.join(npm, 'package.json'), `${JSON.stringify({ ...packageJson, name: `${brand.slug}-connector`,
    description: `Lets your own agent publish 3D captures from this computer to ${brand.name}`, homepage: site,
    bin: { [`${brand.slug}-connector`]: 'server.mjs' } }, null, 2)}\n`);
  const packed = execFileSync('npm', ['pack', '--silent', '--pack-destination', work], { cwd: npm, encoding: 'utf8' }).trim().split('\n').pop();
  copyFileSync(path.join(work, packed), path.join(out, tarball));

  // The Claude Desktop extension: a zip with manifest.json at its root. Claude Desktop supplies Node.
  const bundle = path.join(work, 'mcpb');
  mkdirSync(bundle);
  for (const file of ['server.mjs', 'brand.json', 'package.json', 'SKILL.md']) copyFileSync(path.join(npm, file), path.join(bundle, file));
  const icon = typeof args.icon === 'string' && existsSync(args.icon);
  if (icon) copyFileSync(args.icon, path.join(bundle, 'icon.png'));
  const tools = [
    ['link_account', `Links this agent to your ${brand.name} account through a code you approve in the browser`],
    ['check_files', 'Looks at capture files and folders on this computer'],
    ['list_plans', 'Shows the ways to pay for hosting'],
    ['create_space', 'Creates a space and opens Stripe Checkout when hosting needs payment'],
    ['wait_for_payment', 'Waits for Checkout to finish'],
    ['upload_files', 'Uploads a capture in the background and submits it for processing'],
    ['space_status', 'Shows upload and processing progress'],
    ['set_visibility', 'Makes a ready space public or private'],
    ['unlink_account', 'Unlinks this agent'],
    ['find_tour_spaces', 'Finds your spaces and public spaces to build a guided tour or scavenger hunt on'],
    ['list_tours', 'Lists your tours and scavenger hunts with their links'],
    ['create_tour', 'Starts a guided tour or scavenger hunt on a space'],
    ['draft_tour', `Asks ${brand.name}'s tour agent to write the tour, with models, effects, sound and looks`],
    ['wait_for_tour', 'Waits for a draft and summarizes the tour'],
    ['get_tour', 'Shows a tour with every look, effect and sound it can use'],
    ['save_tour', 'Saves a tour edited by hand'],
    ['search_models', 'Searches the library of ready-made 3D models'],
    ['upload_model', 'Adds a .glb model from this computer, for example one made in Blender, to a tour'],
    ['share_tour', 'Shares a tour by link, or makes it private again']
  ].map(([name, description]) => ({ name, description }));
  const manifest = {
    manifest_version: '0.3', name: brand.slug, display_name: brand.name, version,
    description: `Publish 3D captures from this computer as ${brand.name} spaces, and build tours and scavenger hunts in them`,
    long_description: `${brand.name} hosts 3D captures as virtual spaces with guided tours, shared with a link. Ask Claude to publish an E57 or other laser scan, a Matterport export, a Gaussian splat, 360 photos or video, or a mesh. Claude checks the files, links your account through a code you approve in your browser, opens Stripe Checkout when hosting needs payment and uploads in the background, resuming after interruptions. ${brand.name} emails you when the space is ready. Claude can also build guided tours and scavenger hunts in your spaces or ${brand.name}'s public ones, with 3D models from the library or your own (made in Blender, for example), effects, sound and looks such as a line drawing or a blueprint.`,
    author: { name: brand.name, url: site }, homepage: site, support: site, license: 'MIT',
    ...(icon ? { icon: 'icon.png' } : {}),
    server: { type: 'node', entry_point: 'server.mjs', mcp_config: { command: 'node', args: ['${__dirname}/server.mjs'], env: {} } },
    tools, prompts: [{ name: 'publish_capture', description: `Publish a 3D capture from this computer as a ${brand.name} space`, arguments: ['path'],
      text: `Publish my 3D capture at \${arguments.path} as a ${brand.name} space.` }],
    keywords: ['3d', 'e57', 'lidar', 'gaussian splat', '360', 'virtual tour', 'upload', 'scavenger hunt', 'guided tour'],
    privacy_policies: [`${brand.url}/privacy`],
    compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=18.0.0' } }
  };
  writeFileSync(path.join(bundle, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (args.validate) execFileSync('npx', ['-y', '@anthropic-ai/mcpb', 'validate', path.join(bundle, 'manifest.json')], { stdio: 'inherit' });
  rmSync(path.join(out, `${brand.slug}.mcpb`), { force: true });
  execFileSync('zip', ['-X', '-q', '-r', path.join(out, `${brand.slug}.mcpb`), '.'], { cwd: bundle });

  writeFileSync(path.join(out, 'SKILL.md'), fill(readFileSync(path.join(here, 'SKILL.md'), 'utf8')));
  const doc = typeof args.doc === 'string' ? path.resolve(args.doc) : path.join(out, 'agents.md');
  writeFileSync(doc, fill(readFileSync(path.join(here, 'agents.md'), 'utf8')));
  console.log(`Built ${brand.slug}.mcpb, ${tarball} and SKILL.md in ${out}, and ${path.relative(process.cwd(), doc)}.`);
  console.log(`Install command: npx -y ${packageUrl}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
