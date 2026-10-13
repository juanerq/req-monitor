import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { saveAuthSession, readSavedUsername, localAuthStatus, validateUsername, authFilePath, loadAuthEnvironment } from "../auth-session.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth-session-test-"));
  dirs.push(dir);
  return dir;
}

test("local availability never claims validated portal access or exposes browser state", async () => {
  const dir = fixture();
  const file = path.join(dir, "state.json");
  assert.deepEqual(localAuthStatus(file), { localSessionAvailable: false, username: null });
  await saveAuthSession({ storageState: async () => ({ cookies: [{ value: "synthetic-secret" }], origins: [] }) }, "entered.user", file);
  assert.deepEqual(localAuthStatus(file), { localSessionAvailable: true, username: "entered.user" });
  fs.rmSync(path.join(dir, "username.json"));
  assert.deepEqual(localAuthStatus(file), { localSessionAvailable: true, username: null });
  fs.rmSync(file);
  fs.symlinkSync(path.join(dir, "missing.json"), file);
  assert.deepEqual(localAuthStatus(file), { localSessionAvailable: false, username: null });
});

test("API reports only synthetic local availability and user-entered label", async () => {
  const dir = fixture();
  const file = path.join(dir, "state.json");
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const child = spawn(process.execPath, ["--import", "tsx", "monitor-api.ts"], {
    cwd: path.join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      MONITOR_API_HOST: "127.0.0.1", MONITOR_API_PORT: String(port),
      MONITOR_RUN_ON_START: "false", MONITOR_INTERVAL_MINUTES: "0",
      AUTH_FILE: file, REQ_FILE: path.join(dir, "reqs.txt"),
      MONITOR_SETTINGS_FILE: path.join(dir, "settings.json"), ARTIFACTS_DIR: path.join(dir, "artifacts"),
    },
    stdio: "ignore",
  });
  try {
    const endpoint = `http://127.0.0.1:${port}/api/auth/status`;
    let response: Response | undefined;
    for (let attempt = 0; attempt < 80; attempt++) {
      try { response = await fetch(endpoint); break; } catch { await delay(50); }
    }
    assert.ok(response, "local API must start without running monitor");
    assert.deepEqual(await response.json(), { localSessionAvailable: false, username: null });
    await saveAuthSession({ storageState: async () => ({ cookies: [{ value: "synthetic-secret" }], origins: [] }) }, "entered.user", file);
    const status = await (await fetch(endpoint)).json();
    assert.deepEqual(status, { localSessionAvailable: true, username: "entered.user" });
    assert.deepEqual((await (await fetch(`http://127.0.0.1:${port}/api/dashboard`)).json()).auth, status);
    assert.doesNotMatch(JSON.stringify(status), /synthetic-secret|authenticated|password/i);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill();
      await exited;
    }
  }
});

test("stores synthetic browser state and username privately without a password", async () => {
  const dir = fixture();
  const file = path.join(dir, "private", "state.json");
  const state = { cookies: [{ name: "synthetic", value: "not-a-token" }], origins: [] };
  await saveAuthSession({ storageState: async () => state }, " alice@example.test ", file);

  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), state);
  assert.equal(readSavedUsername(file), "alice@example.test");
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(dir, "private", "username.json")).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, "utf8").includes("password"), false);
  assert.equal(fs.readFileSync(path.join(dir, "private", "username.json"), "utf8").includes("password"), false);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ["state.json", "username.json"]);
});

test("username is only returned for the exact saved session bytes", async () => {
  const dir = fixture();
  const file = path.join(dir, "state.json");
  const state = { cookies: [], origins: [] };
  await saveAuthSession({ storageState: async () => state }, "old.user", file);
  assert.equal(readSavedUsername(file), "old.user");
  fs.writeFileSync(file, JSON.stringify({ cookies: ["synthetic-change"], origins: [] }));
  assert.equal(readSavedUsername(file), null);
});

test("legacy or corrupt username metadata cannot claim an identity", async () => {
  const dir = fixture();
  const file = path.join(dir, "state.json");
  const metadata = path.join(dir, "username.json");
  await saveAuthSession({ storageState: async () => ({ cookies: [] }) }, "old.user", file);
  fs.writeFileSync(metadata, JSON.stringify({ username: "legacy.user" }));
  assert.equal(readSavedUsername(file), null);
  fs.writeFileSync(metadata, "invalid json");
  assert.equal(readSavedUsername(file), null);
  fs.rmSync(metadata);
  assert.equal(readSavedUsername(file), null);
  fs.writeFileSync(metadata, "{}");
  fs.rmSync(file);
  assert.equal(readSavedUsername(file), null);
});

test("corrupt state and symlinked metadata fail closed", async () => {
  const dir = fixture();
  const file = path.join(dir, "state.json");
  const metadata = path.join(dir, "username.json");
  await saveAuthSession({ storageState: async () => ({ cookies: [] }) }, "old.user", file);
  const originalState = fs.readFileSync(file);
  fs.writeFileSync(file, "not json");
  assert.equal(readSavedUsername(file), null);
  fs.writeFileSync(file, originalState);
  const copy = path.join(dir, "copy.json");
  fs.renameSync(metadata, copy);
  fs.symlinkSync(copy, metadata);
  assert.equal(readSavedUsername(file), null);
});

test("failed username replacement leaves new state without an old identity", async () => {
  const dir = fixture();
  const file = path.join(dir, "state.json");
  await saveAuthSession({ storageState: async () => ({ cookies: [] }) }, "old.user", file);
  const rename = fs.renameSync;
  let metadataWrites = 0;
  fs.renameSync = ((source: string, destination: string) => {
    if (destination === path.join(dir, "username.json") && ++metadataWrites === 2) {
      throw new Error("metadata replacement failed");
    }
    return rename(source, destination);
  }) as typeof fs.renameSync;
  try {
    await assert.rejects(
      saveAuthSession({ storageState: async () => ({ cookies: ["new-synthetic"] }) }, "new.user", file),
      /metadata replacement failed/,
    );
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(readSavedUsername(file), null);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["state.json", "username.json"]);
});

test("failed replacement cannot retain an old identity when saved bytes are unchanged", async () => {
  const dir = fixture();
  const file = path.join(dir, "state.json");
  const state = { cookies: [], origins: [] };
  await saveAuthSession({ storageState: async () => state }, "old.user", file);
  const rename = fs.renameSync;
  let metadataWrites = 0;
  fs.renameSync = ((source: string, destination: string) => {
    if (destination === path.join(dir, "username.json") && ++metadataWrites === 2) {
      throw new Error("metadata replacement failed");
    }
    return rename(source, destination);
  }) as typeof fs.renameSync;
  try {
    await assert.rejects(saveAuthSession({ storageState: async () => state }, "new.user", file), /metadata replacement failed/);
  } finally {
    fs.renameSync = rename;
  }
  assert.equal(readSavedUsername(file), null);
});

test("failed state capture leaves previous session and username intact", async () => {
  const dir = fixture();
  const file = path.join(dir, "state.json");
  await saveAuthSession({ storageState: async () => ({ cookies: [], origins: [] }) }, "old.user", file);
  const previousState = fs.readFileSync(file, "utf8");
  const previousUsername = fs.readFileSync(path.join(dir, "username.json"), "utf8");

  await assert.rejects(saveAuthSession({ storageState: async () => {
    throw new Error("capture failed");
  } }, "new.user", file), /capture failed/);
  assert.equal(fs.readFileSync(file, "utf8"), previousState);
  assert.equal(fs.readFileSync(path.join(dir, "username.json"), "utf8"), previousUsername);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["state.json", "username.json"]);
});

test("rejects malformed usernames before changing stored state", async () => {
  const dir = fixture();
  const file = path.join(dir, "state.json");
  await saveAuthSession({ storageState: async () => ({ cookies: [], origins: [] }) }, "old.user", file);
  for (const value of ["", "  ", "a\npassword=secret", "a\u0000b", "a".repeat(257)]) {
    assert.throws(() => validateUsername(value), /Usuario inválido/);
    await assert.rejects(saveAuthSession({ storageState: async () => ({ cookies: [1] }) }, value, file), /Usuario inválido/);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { cookies: [], origins: [] });
});

test("rejects symlinked auth directory or state destination", async () => {
  const dir = fixture();
  const outside = path.join(dir, "outside.json");
  fs.writeFileSync(outside, "untouched");
  const link = path.join(dir, "link");
  fs.symlinkSync(dir, link);
  await assert.rejects(saveAuthSession({ storageState: async () => ({ cookies: [] }) }, "user", path.join(link, "state.json")));
  const stateFile = path.join(dir, "state.json");
  fs.symlinkSync(outside, stateFile);
  await assert.rejects(saveAuthSession({ storageState: async () => ({ cookies: [] }) }, "user", stateFile));
  assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
});

test("protects legacy state and rejects unsafe username destination before saving state", async () => {
  const dir = fixture();
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "old state", { mode: 0o644 });
  const outside = path.join(dir, "outside.json");
  fs.writeFileSync(outside, "untouched");
  fs.symlinkSync(outside, path.join(dir, "username.json"));
  await assert.rejects(saveAuthSession({ storageState: async () => ({ cookies: [] }) }, "user", file));
  assert.equal(fs.readFileSync(file, "utf8"), "old state");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(outside, "utf8"), "untouched");
});

test("resolves AUTH_FILE override consistently", () => {
  assert.equal(authFilePath("custom/state.json"), path.resolve("custom/state.json"));
  assert.equal(authFilePath(undefined), path.resolve("playwright/.auth/miasistencia.json"));
});

test("normalizes only the existing canonical default auth directory before saving", async () => {
  const dir = fixture();
  const previousCwd = process.cwd();
  const previousAuthFile = process.env.AUTH_FILE;
  const authDir = path.join(dir, "playwright", ".auth");
  fs.mkdirSync(authDir, { recursive: true });
  fs.chmodSync(authDir, 0o755);
  try {
    process.chdir(dir);
    delete process.env.AUTH_FILE;
    await saveAuthSession({ storageState: async () => ({ cookies: [], origins: [] }) }, "user");
    assert.equal(fs.statSync(authDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(authDir, "miasistencia.json")).mode & 0o777, 0o600);
    assert.deepEqual(localAuthStatus(), { localSessionAvailable: true, username: "user" });
  } finally {
    process.chdir(previousCwd);
    if (previousAuthFile === undefined) delete process.env.AUTH_FILE;
    else process.env.AUTH_FILE = previousAuthFile;
  }
});

test("refuses a permissive AUTH_FILE override directory without changing its mode", async () => {
  const dir = fixture();
  const authDir = path.join(dir, "playwright", ".auth");
  fs.mkdirSync(authDir, { recursive: true });
  fs.chmodSync(authDir, 0o755);
  await assert.rejects(
    saveAuthSession({ storageState: async () => ({ cookies: [], origins: [] }) }, "user", path.join(authDir, "state.json")),
    /Ruta de autenticación no segura/,
  );
  assert.equal(fs.statSync(authDir).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(authDir), []);
});

test("never normalizes a default path reached through a symlink", async () => {
  const dir = fixture();
  const previousCwd = process.cwd();
  const previousAuthFile = process.env.AUTH_FILE;
  const real = path.join(dir, "real-auth");
  fs.mkdirSync(real, { mode: 0o755 });
  fs.chmodSync(real, 0o755);
  fs.mkdirSync(path.join(dir, "playwright"));
  fs.symlinkSync(real, path.join(dir, "playwright", ".auth"));
  try {
    process.chdir(dir);
    delete process.env.AUTH_FILE;
    await assert.rejects(
      saveAuthSession({ storageState: async () => ({ cookies: [], origins: [] }) }, "user"),
      /Ruta de autenticación no segura/,
    );
    assert.equal(fs.statSync(real).mode & 0o777, 0o755);
    assert.deepEqual(fs.readdirSync(real), []);
    assert.deepEqual(localAuthStatus(), { localSessionAvailable: false, username: null });
  } finally {
    process.chdir(previousCwd);
    if (previousAuthFile === undefined) delete process.env.AUTH_FILE;
    else process.env.AUTH_FILE = previousAuthFile;
  }
});

test("malformed, invalid, and unsafe local state never report availability or a username", async () => {
  const dir = fixture();
  const file = path.join(dir, "state.json");
  await saveAuthSession({ storageState: async () => ({ cookies: [], origins: [] }) }, "user", file);
  for (const state of ["not json", "{}", '{"cookies":[]}', '{"cookies":{},"origins":[]}']) {
    fs.writeFileSync(file, state);
    assert.deepEqual(localAuthStatus(file), { localSessionAvailable: false, username: null });
  }
  fs.writeFileSync(file, JSON.stringify({ cookies: [], origins: [] }));
  fs.chmodSync(file, 0o644);
  assert.deepEqual(localAuthStatus(file), { localSessionAvailable: false, username: null });
  fs.chmodSync(file, 0o600);
  assert.deepEqual(localAuthStatus(file), { localSessionAvailable: true, username: "user" });
});

test("rejects an existing shared auth parent without changing its permissions or creating files", async () => {
  const dir = fixture();
  const shared = path.join(dir, "shared");
  fs.mkdirSync(shared, { mode: 0o777 });
  fs.chmodSync(shared, 0o777);
  const before = fs.statSync(shared).mode & 0o777;
  await assert.rejects(
    saveAuthSession({ storageState: async () => ({ cookies: [] }) }, "user", path.join(shared, "state.json")),
    /Ruta de autenticación no segura/,
  );
  assert.equal(fs.statSync(shared).mode & 0o777, before);
  assert.deepEqual(fs.readdirSync(shared), []);
});

test("accepts an existing private auth directory without changing its mode", async () => {
  const dir = fixture();
  const authDir = path.join(dir, "playwright", ".auth");
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 });
  const file = path.join(authDir, "state.json");
  await saveAuthSession({ storageState: async () => ({ cookies: [], origins: [] }) }, "user", file);
  assert.equal(fs.statSync(authDir).mode & 0o777, 0o700);
  assert.equal(readSavedUsername(file), "user");
});

test("loads synthetic dotenv before CLI and API resolve AUTH_FILE", () => {
  const dir = fixture();
  const envFile = path.join(dir, "synthetic.env");
  fs.writeFileSync(envFile, "AUTH_FILE=synthetic/private/state.json\n");
  const previous = process.env.AUTH_FILE;
  try {
    delete process.env.AUTH_FILE;
    loadAuthEnvironment(envFile);
    assert.equal(authFilePath(), path.resolve("synthetic/private/state.json"));
  } finally {
    if (previous === undefined) delete process.env.AUTH_FILE;
    else process.env.AUTH_FILE = previous;
  }
  for (const source of ["check-req.ts", "monitor-api.ts"]) {
    const code = fs.readFileSync(path.join(import.meta.dirname, "..", source), "utf8");
    assert.ok(code.includes("loadAuthEnvironment()"), `${source} must load dotenv`);
    assert.ok(code.indexOf("loadAuthEnvironment()") < code.indexOf("const AUTH_FILE = authFilePath()"));
  }
});
