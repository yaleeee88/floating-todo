import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectUrl = new URL("../", import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, projectUrl), "utf8"));
}

test("Windows releases keep the stable data identity and use overwrite upgrades", async () => {
  const config = await readJson("src-tauri/tauri.conf.json");

  assert.equal(config.identifier, "com.gaopengfei.floating-todo");
  assert.equal(config.bundle.windows.allowDowngrades, false);
  assert.equal(config.bundle.windows.nsis.installMode, "currentUser");
  assert.equal(config.bundle.windows.nsis.template, "windows/installer-overwrite.nsi");

  const installer = await readFile(
    new URL("src-tauri/windows/installer-overwrite.nsi", projectUrl),
    "utf8",
  );
  assert.match(installer, /vendored from Tauri CLI 2\.11\.2/);
  assert.match(
    installer,
    /; Upgrading[\s\S]*?\$WixMode = 0[\s\S]*?StrCpy \$UpdateMode 1[\s\S]*?Abort/,
  );
});

test("the CLI version stays aligned with the vendored NSIS template", async () => {
  const packageJson = await readJson("package.json");
  const lockfile = await readJson("package-lock.json");

  assert.equal(packageJson.devDependencies["@tauri-apps/cli"], "2.11.2");
  assert.equal(lockfile.packages[""].devDependencies["@tauri-apps/cli"], "2.11.2");
  assert.equal(lockfile.packages["node_modules/@tauri-apps/cli"].version, "2.11.2");
});

test("all packaged app versions stay aligned", async () => {
  const packageJson = await readJson("package.json");
  const lockfile = await readJson("package-lock.json");
  const config = await readJson("src-tauri/tauri.conf.json");
  const cargoToml = await readFile(new URL("src-tauri/Cargo.toml", projectUrl), "utf8");
  const cargoLock = await readFile(new URL("src-tauri/Cargo.lock", projectUrl), "utf8");
  const version = packageJson.version;

  assert.equal(lockfile.version, version);
  assert.equal(lockfile.packages[""].version, version);
  assert.equal(config.version, version);
  assert.match(cargoToml, new RegExp(`^version = "${version.replaceAll(".", "\\.")}"$`, "m"));
  assert.match(
    cargoLock,
    new RegExp(`\\[\\[package\\]\\]\\r?\\nname = "floating-todo"\\r?\\nversion = "${version.replaceAll(".", "\\.")}"`),
  );
});

test("the release workflow tests the exact tagged version before publishing", async () => {
  const workflow = await readFile(new URL(".github/workflows/release.yml", projectUrl), "utf8");

  assert.match(workflow, /run: npm ci/);
  assert.match(workflow, /run: npm test/);
  assert.match(workflow, /GITHUB_REF_NAME/);
  assert.match(workflow, /'v' \+ require\('\.\/package\.json'\)\.version/);
});
