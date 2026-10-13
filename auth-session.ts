import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export function loadAuthEnvironment(file = ".env"): void {
  if (fs.existsSync(file)) process.loadEnvFile(file);
}

export function authFilePath(configured = process.env.AUTH_FILE): string {
  return path.resolve(configured ?? "playwright/.auth/miasistencia.json");
}

export function validateUsername(value: string): string {
  const username = value.trim();
  if (!username || username.length > 256 || !/^[\p{L}\p{N}._@+-]+$/u.test(username)) {
    throw new Error("Usuario inválido");
  }
  return username;
}

function privateDirectory(directory: string, normalizeDefault: boolean): void {
  const absolute = path.resolve(directory);
  const parts = absolute.split(path.sep).filter(Boolean);
  let current = path.parse(absolute).root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("Ruta de autenticación no segura");
      }
      if (current === absolute && (stat.mode & 0o077) !== 0) {
        if (!normalizeDefault || stat.uid !== process.getuid?.()) {
          throw new Error("Ruta de autenticación no segura");
        }
        const handle = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try {
          const opened = fs.fstatSync(handle);
          if (!opened.isDirectory() || opened.dev !== stat.dev || opened.ino !== stat.ino ||
            opened.uid !== process.getuid?.()) {
            throw new Error("Ruta de autenticación no segura");
          }
          fs.fchmodSync(handle, 0o700);
        } finally {
          fs.closeSync(handle);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.mkdirSync(current, { mode: 0o700 });
    }
  }
}

function protectDestination(file: string): void {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
      throw new Error("Destino de autenticación no seguro");
    }
    fs.chmodSync(file, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function atomicPrivateWrite(file: string, data: string): void {
  protectDestination(file);
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(handle, data, "utf8");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    protectDestination(file);
    fs.renameSync(temporary, file);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function stateDigest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readPrivateState(file: string): Buffer {
  const directory = path.dirname(path.resolve(file));
  let current = path.parse(directory).root;
  for (const part of directory.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (current === directory && (stat.mode & 0o077) !== 0)) {
      throw new Error("Unsafe authentication directory");
    }
  }
  const handle = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()) {
      throw new Error("Unsafe authentication file");
    }
    const state = fs.readFileSync(handle);
    const parsed: unknown = JSON.parse(state.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      !Array.isArray((parsed as Record<string, unknown>).cookies) ||
      !Array.isArray((parsed as Record<string, unknown>).origins)) {
      throw new Error("Invalid authentication state");
    }
    return state;
  } finally {
    fs.closeSync(handle);
  }
}

/** Metadata binds a user-entered label to session bytes, not a verified portal identity. */
export function readSavedUsername(file = authFilePath()): string | null {
  const authFile = path.resolve(file);
  const directory = path.dirname(authFile);
  const usernameFile = path.join(directory, "username.json");
  if (usernameFile === authFile) return null;
  try {
    let current = path.parse(directory).root;
    for (const part of directory.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    }
    const readPrivateFile = (filename: string): Buffer => {
      const handle = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(handle);
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
          throw new Error("Unsafe authentication file");
        }
        return fs.readFileSync(handle);
      } finally {
        fs.closeSync(handle);
      }
    };
    const state = readPrivateState(authFile);
    const metadata: unknown = JSON.parse(readPrivateFile(usernameFile).toString("utf8"));
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const { username, stateSha256 } = metadata as Record<string, unknown>;
    if (typeof username !== "string" || typeof stateSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(stateSha256) || stateDigest(state) !== stateSha256) return null;
    return validateUsername(username) === username ? username : null;
  } catch {
    return null;
  }
}

/** Valid local browser state is not evidence of portal authentication. */
export function localAuthStatus(file = authFilePath()): { localSessionAvailable: boolean; username: string | null } {
  try {
    readPrivateState(file);
    return { localSessionAvailable: true, username: readSavedUsername(file) };
  } catch {
    // Missing or inaccessible state cannot be offered for reuse.
  }
  return { localSessionAvailable: false, username: null };
}

/** The files are replaced individually; the digest prevents stale identity after a partial write. */
export async function saveAuthSession(
  context: { storageState(): Promise<unknown> },
  usernameValue: string | null,
  file = authFilePath(),
): Promise<void> {
  const username = usernameValue === null ? null : validateUsername(usernameValue);
  const authFile = path.resolve(file);
  const directory = path.dirname(authFile);
  privateDirectory(directory, authFile === path.resolve("playwright/.auth/miasistencia.json") &&
    process.env.AUTH_FILE === undefined);
  const usernameFile = path.join(directory, "username.json");
  if (usernameFile === authFile) throw new Error("Ruta de autenticación no segura");
  protectDestination(authFile);
  protectDestination(usernameFile);
  const state = await context.storageState();
  const stateBytes = JSON.stringify(state);
  // Invalidate the previous identity first, including when a new session has identical bytes.
  atomicPrivateWrite(usernameFile, JSON.stringify({ username: null }));
  atomicPrivateWrite(authFile, stateBytes);
  atomicPrivateWrite(usernameFile, JSON.stringify({ username, stateSha256: stateDigest(stateBytes) }));
}
