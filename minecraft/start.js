/**
 * start.js — downloads and runs a Minecraft server (Paper) next to the snake game.
 *
 *   npm run minecraft     → resolves the newest STABLE Paper build, verifies its SHA-256,
 *                           checks the Java version and starts the server in minecraft/data/.
 *
 * Everything the server writes (jar, world, logs, plugins) stays in minecraft/data/ (gitignored).
 * Environment (MC_EULA is required, the rest is optional): see `.env.example`.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

try {
  process.loadEnvFile?.(path.join(ROOT, '.env'));
} catch {
  /* no .env — fine */
}

const API = 'https://fill.papermc.io/v3/projects/paper';
// PaperMC asks every API client to identify itself.
const USER_AGENT = 'tiktok-snake-live/1.0 (https://github.com/amthedev/tiktok-snake-live)';
const DATA_DIR = process.env.MC_DATA_DIR ? path.resolve(process.env.MC_DATA_DIR) : path.join(HERE, 'data');
const STATE_PATH = path.join(DATA_DIR, 'launcher.json');
const VERSION = (process.env.MC_VERSION || 'latest').trim();
const MEMORY = (process.env.MC_MEMORY || '2G').trim();
const PORT = (process.env.MC_PORT || '').trim();
const JAVA = (process.env.JAVA_BIN || 'java').trim();
const EULA = /^(1|true|yes)$/i.test(process.env.MC_EULA || '');

const log = (...a) => console.log('[minecraft]', ...a);
const fail = (msg) => {
  console.error('[minecraft] ✖', msg);
  process.exit(1);
};

/* ------------------------------------------------------------------------------------------------
 * PaperMC API (Fill v3)
 * ---------------------------------------------------------------------------------------------- */

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

const isRelease = (v) => /^\d+(\.\d+)*$/.test(v);
const compareVersions = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

async function stableBuild(version) {
  const builds = await getJson(`${API}/versions/${version}/builds?channel=STABLE`);
  return builds.length ? builds.reduce((a, b) => (b.id > a.id ? b : a)) : null;
}

/** Picks the Minecraft version + Paper build to run: MC_VERSION, or the newest one with a STABLE build. */
async function resolveBuild() {
  if (VERSION !== 'latest') {
    const build = (await stableBuild(VERSION)) ?? (await getJson(`${API}/versions/${VERSION}/builds/latest`));
    if (build.channel !== 'STABLE') log(`⚠ ${VERSION} ainda não tem build STABLE — usando ${build.channel} #${build.id}.`);
    return { version: VERSION, build };
  }
  const { versions } = await getJson(API);
  const candidates = Object.values(versions).flat().filter(isRelease).sort(compareVersions).reverse();
  for (const version of candidates) {
    const build = await stableBuild(version);
    if (build) return { version, build };
  }
  throw new Error('nenhuma versão do Paper com build STABLE');
}

async function resolve() {
  const { version, build } = await resolveBuild();
  const info = await getJson(`${API}/versions/${version}`);
  const download = build.downloads['server:default'];
  return {
    version,
    build: build.id,
    jar: download.name,
    url: download.url,
    sha256: download.checksums.sha256,
    javaMin: info.version.java?.version?.minimum ?? 21,
    flags: info.version.java?.flags?.recommended ?? [],
  };
}

/* ------------------------------------------------------------------------------------------------
 * Download (verified)
 * ---------------------------------------------------------------------------------------------- */

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function download(target) {
  const file = path.join(DATA_DIR, target.jar);
  if (fs.existsSync(file) && sha256File(file) === target.sha256) return file;

  log(`baixando ${target.jar}…`);
  const res = await fetch(target.url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`${target.url} → HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  if (hash !== target.sha256) throw new Error(`SHA-256 não confere para ${target.jar} (${hash})`);

  fs.writeFileSync(`${file}.part`, bytes);
  fs.renameSync(`${file}.part`, file);
  // Old Paper jars are dead weight once the new one is verified.
  for (const old of fs.readdirSync(DATA_DIR)) {
    if (/^paper-.*\.jar$/.test(old) && old !== target.jar) fs.rmSync(path.join(DATA_DIR, old));
  }
  return file;
}

/* ------------------------------------------------------------------------------------------------
 * Java + server files
 * ---------------------------------------------------------------------------------------------- */

function javaMajor() {
  const out = spawnSync(JAVA, ['-version'], { encoding: 'utf8' });
  if (out.error) return 0;
  const m = /version "(\d+)(?:\.(\d+))?/.exec(`${out.stderr}${out.stdout}`);
  if (!m) return 0;
  // Java 8 and older report "1.8.0_…".
  return m[1] === '1' ? Number(m[2]) : Number(m[1]);
}

function prepareServerDir() {
  const eula = path.join(DATA_DIR, 'eula.txt');
  if (EULA) {
    fs.writeFileSync(eula, '# Aceito via MC_EULA=true (https://aka.ms/MinecraftEULA)\neula=true\n');
  } else if (!/^eula=true$/m.test(fs.existsSync(eula) ? fs.readFileSync(eula, 'utf8') : '')) {
    fail(
      'Para rodar o servidor você precisa aceitar a EULA do Minecraft (https://aka.ms/MinecraftEULA).\n' +
        '  Leia e, se concordar, coloque MC_EULA=true no .env (ou rode: MC_EULA=true npm run minecraft).',
    );
  }
  const props = path.join(DATA_DIR, 'server.properties');
  if (!fs.existsSync(props)) fs.copyFileSync(path.join(HERE, 'server.properties'), props);
}

/* ------------------------------------------------------------------------------------------------
 * Main
 * ---------------------------------------------------------------------------------------------- */

fs.mkdirSync(DATA_DIR, { recursive: true });

let target;
let jarPath;
try {
  target = await resolve();
  jarPath = await download(target);
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(target, null, 2)}\n`);
} catch (err) {
  // Offline (or API down): reuse the last jar that was downloaded and verified.
  const saved = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : null;
  if (!saved || !fs.existsSync(path.join(DATA_DIR, saved.jar))) fail(`não deu para baixar o Paper: ${err.message}`);
  log(`⚠ sem acesso à API do Paper (${err.message}) — usando ${saved.jar} já baixado.`);
  target = saved;
  jarPath = path.join(DATA_DIR, saved.jar);
}

const major = javaMajor();
if (major < target.javaMin) {
  fail(
    (major ? `Java ${major} encontrado` : `Java não encontrado (${JAVA})`) +
      `, mas o Minecraft ${target.version} precisa do Java ${target.javaMin} ou mais novo.\n` +
      `  Instale em https://adoptium.net (Temurin ${target.javaMin}) ou aponte JAVA_BIN para ele no .env.`,
  );
}

prepareServerDir();

const args = [`-Xms${MEMORY}`, `-Xmx${MEMORY}`, ...target.flags, '-jar', jarPath, '--nogui'];
if (PORT) args.push('--port', PORT);

log(`Paper ${target.version} #${target.build} · Java ${major} · ${MEMORY} RAM · pasta ${path.relative(ROOT, DATA_DIR) || '.'}`);
log(`conecte em localhost:${PORT || 25565} — digite "stop" aqui para desligar salvando o mundo.`);

const child = spawn(JAVA, args, { cwd: DATA_DIR, stdio: 'inherit' });
// Ctrl+C already reaches the server through the terminal: stay alive until it has saved the world.
process.on('SIGINT', () => {});
// A plain `kill` only hits this process — pass it on so the server still shuts down cleanly.
// (Not on Windows: there child.kill() means TerminateProcess, which would skip the save.)
if (process.platform !== 'win32') {
  for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
}
child.on('exit', (code) => process.exit(code ?? 1));
