// Run explicitly during release preparation. Never downloads, installs or publishes anything.
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK_URL = "https://api.github.com/repos/herenfor/epub-read/releases/latest";
const MANIFEST_URL = "https://github.com/herenfor/epub-read/releases/latest/download/latest.json";
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

function base64(value) {
  if (typeof value !== "string" || !/^[A-Za-z\d+/]+={0,2}$/u.test(value)) throw Error("Invalid signature encoding");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw Error("Invalid signature encoding");
  return bytes;
}

function envelope(value, lines) {
  const decoded = base64(value.trim()).toString("utf8").trimEnd().split(/\r?\n/u);
  if (decoded.length !== lines || !decoded[0].startsWith("untrusted comment: ")) throw Error("Invalid minisign envelope");
  return decoded;
}

/** Tauri wraps minisign text in base64. Require the modern streamed/prehashed format.
 * Format: https://jedisct1.github.io/minisign/#signature-format
 */
export async function verifyInstallerSignature(installer, signature, publicKey) {
  const key = base64(envelope(publicKey, 2)[1]);
  const lines = envelope(signature, 4);
  const signed = base64(lines[1]);
  const global = base64(lines[3]);
  if (key.length !== 42 || key.subarray(0, 2).toString() !== "Ed" || signed.length !== 74 ||
      signed.subarray(0, 2).toString() !== "ED" || !key.subarray(2, 10).equals(signed.subarray(2, 10)) ||
      global.length !== 64 || !lines[2].startsWith("trusted comment: ")) throw Error("Invalid minisign signature or key");
  const cryptoKey = createPublicKey({ format: "der", type: "spki", key: Buffer.concat([ED25519_SPKI, key.subarray(10)]) });
  const rawSignature = signed.subarray(10);
  if (!verify(null, Buffer.concat([rawSignature, Buffer.from(lines[2].slice(17))]), cryptoKey, global)) {
    throw Error("Updater signature verification failed");
  }
  const hash = createHash("blake2b512");
  for await (const bytes of createReadStream(installer)) hash.update(bytes);
  if (!verify(null, hash.digest(), cryptoKey, rawSignature)) throw Error("Updater signature verification failed");
}

/** The frontend build must emit this from the same source configuration used by its runtime.
 * URL text alone cannot prove that a test override was disabled. Fail closed until it is wired.
 */
export async function assertProductionFrontend(directory) {
  const policy = JSON.parse(await readFile(join(directory, "app-update-source.json"), "utf8"));
  if (policy.schemaVersion !== 1 || policy.checkUrl !== CHECK_URL || policy.manifestUrl !== MANIFEST_URL ||
      policy.testMode !== false) throw Error("Frontend update source is not the production source");
  let hasRuntimeCheckUrl = false;
  async function inspect(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) await inspect(path);
      else if (entry.isFile() && /\.(?:js|html)$/u.test(entry.name)) {
        const text = await readFile(path, "utf8");
        if (text.includes(CHECK_URL)) hasRuntimeCheckUrl = true;
        const endpoints = text.match(/https?:\/\/[^\s"'`<>\\]+(?:releases\/latest(?:\/download\/latest\.json)?|latest\.json)/gu) ?? [];
        if (endpoints.some(url => url !== CHECK_URL && url !== MANIFEST_URL)) {
          throw Error("A non-production update endpoint remains in the frontend build");
        }
      }
    }
  }
  await inspect(directory);
  if (!hasRuntimeCheckUrl) throw Error("Production update check URL is missing from the frontend runtime");
}

export async function buildUpdaterManifest({ installer, version, privateKeyPath, passwordFile,
  publicKeyPath, frontendDirectory, outputDirectory = dirname(installer), notes = "", publishedAt = new Date().toISOString() }) {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) throw Error("A stable x.y.z version is required");
  const name = `EPUB.Reader_${version}_x64-setup.exe`;
  if (basename(installer) !== name) throw Error("Installer filename and release version do not match");
  if (!Number.isFinite(Date.parse(publishedAt))) throw Error("Invalid release date");
  if (!(await stat(installer)).isFile() || (await stat(installer)).size === 0) throw Error("Installer is empty or not a regular file");
  if (!frontendDirectory) throw Error("A production frontend build directory is required");
  await assertProductionFrontend(frontendDirectory);
  const publicKey = publicKeyPath ? (await readFile(publicKeyPath, "utf8")).trim()
    : JSON.parse(await readFile(join(ROOT, "src-tauri/tauri.conf.json"), "utf8")).plugins?.updater?.pubkey;
  if (!publicKey) throw Error("Updater public key is missing");
  const password = (await readFile(passwordFile, "utf8")).replace(/\r?\n$/u, "");
  if (/[\r\n]/u.test(password)) throw Error("Password file must contain a single line");
  await mkdir(outputDirectory, { recursive: true });
  const workspace = await mkdtemp(join(resolve(outputDirectory), ".updater-sign-"));
  try {
    const snapshot = join(workspace, name);
    await copyFile(installer, snapshot);
    const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password };
    delete env.TAURI_SIGNING_PRIVATE_KEY;
    delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
    const child = spawnSync(process.execPath, [join(ROOT, "node_modules/@tauri-apps/cli/tauri.js"),
      "signer", "sign", "--private-key-path", resolve(privateKeyPath), snapshot],
    { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 120_000 });
    // Signer output is deliberately not relayed: release tools must never echo secrets.
    if (child.error || child.status !== 0) throw Error("Tauri updater signing failed; no manifest was published");
    const signature = (await readFile(`${snapshot}.sig`, "utf8")).trim();
    // Verify the actual artifact, not only our snapshot: it may have changed during signing.
    await verifyInstallerSignature(installer, signature, publicKey);
    const manifest = { version, notes, pub_date: publishedAt,
      platforms: { "windows-x86_64": { signature,
        url: `https://github.com/herenfor/epub-read/releases/download/v${version}/${name}` } } };
    const temporary = join(workspace, `${randomUUID()}.json`);
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    const destination = join(resolve(outputDirectory), "latest.json");
    // Atomic and refuses to overwrite an existing manifest. Only this job's files are removed.
    await link(temporary, destination);
    return { path: destination, manifest };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function main() {
  const options = {};
  const names = { "--installer": "installer", "--version": "version", "--private-key": "privateKeyPath",
    "--password-file": "passwordFile", "--public-key": "publicKeyPath", "--frontend-dir": "frontendDirectory",
    "--output-dir": "outputDirectory", "--notes": "notes" };
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 2) {
    const name = names[args[i]];
    if (!name || args[i + 1] === undefined || Object.hasOwn(options, name)) throw Error("Invalid or duplicate updater manifest argument");
    options[name] = args[i + 1];
  }
  for (const name of ["installer", "version", "privateKeyPath", "passwordFile", "frontendDirectory"]) {
    if (!options[name]) throw Error(`Missing updater manifest argument: ${name}`);
  }
  const result = await buildUpdaterManifest(options);
  console.log(`Updater manifest verified and written: ${result.path}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
