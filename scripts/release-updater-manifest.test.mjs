import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertProductionFrontend, buildUpdaterManifest, verifyInstallerSignature } from "./release-updater-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let directory;
let options;
let result;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), "epub-updater-test-"));
  const key = join(directory, "one-use.key");
  const generated = spawnSync(process.execPath, [join(root, "node_modules/@tauri-apps/cli/tauri.js"),
    "signer", "generate", "--ci", "--password", "", "--write-keys", key],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
  assert.equal(generated.status, 0, "one-use test key generation must succeed");
  const installer = join(directory, "EPUB.Reader_0.3.98_x64-setup.exe");
  await writeFile(installer, "synthetic installer bytes, never executed");
  const passwordFile = join(directory, "password");
  await writeFile(passwordFile, "", { mode: 0o600 });
  const frontendDirectory = join(directory, "frontend");
  await mkdir(frontendDirectory);
  await writeFile(join(frontendDirectory, "app-update-source.json"), JSON.stringify({ schemaVersion: 1,
    checkUrl: "https://api.github.com/repos/herenfor/epub-read/releases/latest",
    manifestUrl: "https://github.com/herenfor/epub-read/releases/latest/download/latest.json", testMode: false }));
  await writeFile(join(frontendDirectory, "app.js"), 'const endpoint="https://api.github.com/repos/herenfor/epub-read/releases/latest";');
  options = { installer, version: "0.3.98", privateKeyPath: key, passwordFile,
    publicKeyPath: `${key}.pub`, frontendDirectory, outputDirectory: join(directory, "out") };
});
after(async () => { await rm(directory, { recursive: true, force: true }); });

test("signs with a one-use key, verifies the real installer and atomically creates only latest.json", async () => {
  result = await buildUpdaterManifest(options);
  assert.equal(result.manifest.version, "0.3.98");
  assert.equal(result.manifest.platforms["windows-x86_64"].url,
    "https://github.com/herenfor/epub-read/releases/download/v0.3.98/EPUB.Reader_0.3.98_x64-setup.exe");
  assert.deepEqual(await readdir(options.outputDirectory), ["latest.json"]);
  assert.deepEqual(JSON.parse(await readFile(result.path, "utf8")), result.manifest);
});

test("refuses mismatched versions and refuses to overwrite a previously verified manifest", async () => {
  await assert.rejects(buildUpdaterManifest({ ...options, version: "0.3.99" }), /filename/u);
  const previous = await readFile(result.path, "utf8");
  await assert.rejects(buildUpdaterManifest(options), /EEXIST/u);
  assert.equal(await readFile(result.path, "utf8"), previous);
});

test("rejects changed file bytes, changed signatures and modified trusted comments", async () => {
  const signature = result.manifest.platforms["windows-x86_64"].signature;
  const key = (await readFile(options.publicKeyPath, "utf8")).trim();
  const text = Buffer.from(signature, "base64").toString("utf8").trimEnd().split("\n");
  const raw = Buffer.from(text[1], "base64"); raw[20] ^= 1; text[1] = raw.toString("base64");
  await assert.rejects(verifyInstallerSignature(options.installer, Buffer.from(text.join("\n")).toString("base64"), key), /verification/u);
  const changedComment = Buffer.from(signature, "base64").toString("utf8").replace("timestamp:", "timestamp:0");
  await assert.rejects(verifyInstallerSignature(options.installer, Buffer.from(changedComment).toString("base64"), key), /verification/u);
  await writeFile(options.installer, "changed bytes");
  await assert.rejects(verifyInstallerSignature(options.installer, signature, key), /verification/u);
});

test("rejects a test-source build even when a production URL also remains in its bundle", async () => {
  await writeFile(join(options.frontendDirectory, "test.js"), 'const override="http://127.0.0.1:9443/latest.json";');
  await assert.rejects(assertProductionFrontend(options.frontendDirectory), /non-production/u);
  await rm(join(options.frontendDirectory, "test.js"));
  await writeFile(join(options.frontendDirectory, "app-update-source.json"), JSON.stringify({ schemaVersion: 1,
    checkUrl: "http://127.0.0.1:9443/latest.json", testMode: true }));
  await assert.rejects(assertProductionFrontend(options.frontendDirectory), /production source/u);
});
