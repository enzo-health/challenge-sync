// Starts the plaza room (plaza/, a Rust Durable Object) under `wrangler dev` for tests, and signs
// plaza passes with the checked-in DEV-ONLY key. Imported by scripts/test-plaza-room.mjs and
// scripts/test-plaza-browser.mjs; several rooms can run at once (each test its own).
//
// Exports:
//
//   startRoom({ log?, vars? }) -> Promise<{ httpUrl, wsUrl, port, stop(), output() }>
//     Builds the room if its sources changed (once, under a lock shared by concurrent callers),
//     then starts `wrangler dev` on a free port with its own inspector port and its own state
//     directory, and resolves once GET /health answers.
//       log:   function(line) receiving wrangler's output lines (default: kept, not printed)
//       vars:  extra/overriding env vars for the room, e.g. { PLAZA_HELLO_TIMEOUT_MS: "1500" };
//              the rest come from plaza/.dev.vars (dev public key, allowed origins, any-port switch)
//     httpUrl: "http://127.0.0.1:<port>", wsUrl: "ws://127.0.0.1:<port>/room"
//     stop():  kills wrangler and its workerd children (process group), removes the state dir;
//              safe to call twice. Also runs automatically when this process exits.
//     output(): everything wrangler printed so far (for failure messages)
//
//   ensureRoomBuilt({ log? }) -> Promise<void>
//     Just the build step: runs plaza/build.sh (worker-build --release) unless plaza/build/ is
//     current for the room's inputs (hash in plaza/build/.inputs-sha256). Holds a lock directory
//     (plaza/.build-lock) so concurrent callers build once, and never rewrites build/ when nothing
//     changed (a running wrangler would otherwise reload and drop its sockets).
//
//   signPass(memberId, expiresAtUnix, { seed? }) -> string
//     A pass in the room's format, signed with node's own Ed25519 (an independent implementation of
//     plaza-protocol's pass::sign): base64url(payload) "." base64url(signature), payload
//     {"m":<id>,"exp":<unix s>}. seed: 32-byte Buffer or standard base64 (default: the dev seed).
//
//   DEV_PRIVATE_SEED, DEV_PUBLIC_KEY: the dev pair from plaza/dev-keys.env (standard base64).
//
// Needs: `npm ci` in plaza/ (wrangler + ws), cargo with the 1.96.0 toolchain and its wasm32 target,
// and network once on a fresh machine (build.sh installs the pinned worker-build into plaza/.tools,
// and worker-build downloads its wasm-bindgen/esbuild once).
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, sign as edSign } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const plazaDir = join(root, "plaza");
const protocolDir = join(root, "plaza-protocol");

function readEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2];
  }
  return out;
}

const devKeys = readEnvFile(join(plazaDir, "dev-keys.env"));
export const DEV_PRIVATE_SEED = devKeys.PLAZA_PASS_PRIVATE_KEY;
export const DEV_PUBLIC_KEY = devKeys.PLAZA_PASS_PUBLIC_KEY;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function signPass(memberId, expiresAtUnix, { seed = DEV_PRIVATE_SEED } = {}) {
  const raw = typeof seed === "string" ? Buffer.from(seed, "base64") : Buffer.from(seed);
  if (raw.length !== 32) throw new Error(`signPass: seed is ${raw.length} bytes, expected 32`);
  // PKCS#8 wrapping of a raw Ed25519 seed (RFC 8410).
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), raw]);
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const payload = Buffer.from(`{"m":${BigInt(memberId)},"exp":${BigInt(expiresAtUnix)}}`);
  return `${b64url(payload)}.${b64url(edSign(null, payload, key))}`;
}

// --- build -----------------------------------------------------------------------------------------

function walk(dir, out) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function inputsHash() {
  const files = [
    ...walk(join(plazaDir, "src"), []),
    ...walk(join(protocolDir, "src"), []),
    ...["Cargo.toml", "Cargo.lock", "build.sh", "rust-toolchain.toml"].map((f) => join(plazaDir, f)),
    ...["Cargo.toml", "rust-toolchain.toml"].map((f) => join(protocolDir, f)),
  ].filter(existsSync);
  const h = createHash("sha256");
  for (const f of files) h.update(relative(root, f)).update("\0").update(readFileSync(f)).update("\0");
  return h.digest("hex");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lockDir = join(plazaDir, ".build-lock");
const stampFile = join(plazaDir, "build", ".inputs-sha256");

async function withBuildLock(fn) {
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      writeFileSync(join(lockDir, "pid"), String(process.pid));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      // A lock left by a process that died is taken over.
      let holder = NaN;
      try { holder = Number(readFileSync(join(lockDir, "pid"), "utf8")); } catch {}
      let alive = false;
      if (Number.isInteger(holder) && holder > 0) {
        try { process.kill(holder, 0); alive = true; } catch (err) { alive = err.code === "EPERM"; }
      } else {
        // pid not written yet: give the holder a moment unless the lock is old.
        try { alive = Date.now() - statSync(lockDir).mtimeMs < 10_000; } catch {}
      }
      if (!alive) { rmSync(lockDir, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`plaza build lock ${lockDir} held by pid ${holder} for over 10 minutes`);
      await sleep(200);
    }
  }
  try { return await fn(); } finally { rmSync(lockDir, { recursive: true, force: true }); }
}

export async function ensureRoomBuilt({ log = () => {} } = {}) {
  await withBuildLock(async () => {
    const want = inputsHash();
    const have = existsSync(stampFile) ? readFileSync(stampFile, "utf8").trim() : "";
    if (have === want && existsSync(join(plazaDir, "build", "index.js"))) return;
    log(`building the room (plaza/build.sh)`);
    let out = "";
    const code = await new Promise((resolve, reject) => {
      const p = spawn("sh", ["./build.sh"], { cwd: plazaDir, stdio: ["ignore", "pipe", "pipe"] });
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("error", reject);
      p.on("exit", (c, sig) => resolve(sig ? sig : c));
    });
    if (code !== 0) throw new Error(`plaza/build.sh failed (exit ${code}):\n${out.slice(-4000)}`);
    writeFileSync(stampFile, want + "\n");
  });
}

// --- wrangler dev ------------------------------------------------------------------------------------

const live = new Set();
process.on("exit", () => { for (const r of live) r.killNow(); });
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, () => { for (const r of live) r.killNow(); process.exit(130); });
}

const toml = (s) => JSON.stringify(String(s)); // TOML basic strings accept JSON string escapes

export async function startRoom({ log = null, vars = {} } = {}) {
  const wrangler = join(plazaDir, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!existsSync(wrangler)) throw new Error(`${wrangler} is missing: run \`npm ci\` in plaza/ first`);
  await ensureRoomBuilt({ log: log ?? (() => {}) });

  // A private config dir per room: no [build] (built above, so concurrent rooms never rebuild into
  // the shared build/), vars inline, and wrangler's .wrangler/ state and temp files kept apart.
  const id = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(plazaDir, ".wrangler", "harness", id);
  mkdirSync(dir, { recursive: true });
  const allVars = { ...readEnvFile(join(plazaDir, ".dev.vars")), ...vars };
  writeFileSync(
    join(dir, "wrangler.toml"),
    [
      `name = "plaza-room"`,
      `main = ${toml(join(plazaDir, "build", "index.js"))}`,
      `compatibility_date = ${toml(readFileSync(join(plazaDir, "wrangler.toml"), "utf8").match(/^compatibility_date\s*=\s*"([^"]+)"/m)[1])}`,
      `[[durable_objects.bindings]]`, `name = "ROOM"`, `class_name = "Room"`,
      `[[migrations]]`, `tag = "v1"`, `new_sqlite_classes = ["Room"]`,
      `[vars]`, ...Object.entries(allVars).map(([k, v]) => `${k} = ${toml(v)}`),
      ``,
    ].join("\n"),
  );

  let output = "";
  const child = spawn(
    process.execPath,
    [wrangler, "dev", "--config", join(dir, "wrangler.toml"), "--ip", "127.0.0.1", "--port", "0",
      "--inspector-port", "0", "--persist-to", join(dir, "state"), "--show-interactive-dev-session=false",
      "--log-level", "info"],
    {
      cwd: dir,
      detached: true, // own process group, so stop() reaches workerd too
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1", NO_COLOR: "1", FORCE_COLOR: "0",
        WRANGLER_LOG_PATH: join(dir, "logs"), // not ~/.config/.wrangler/logs
      },
    },
  );
  let exited = null;
  const onData = (d) => {
    const s = d.toString();
    output += s;
    if (log) for (const line of s.split("\n")) if (line.trim()) log(line);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const exitP = new Promise((r) => child.on("exit", (code, sig) => { exited = sig ?? code; r(); }));

  const room = {
    killNow() {
      if (exited === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
      rmSync(dir, { recursive: true, force: true });
      live.delete(room);
    },
  };
  live.add(room);
  const stop = async () => {
    if (!live.has(room)) return;
    if (exited === null) {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      await Promise.race([exitP, sleep(3000)]);
    }
    // Whatever is left of the group (workerd ignores SIGTERM at times) is killed outright.
    try { process.kill(-child.pid, "SIGKILL"); } catch {}
    rmSync(dir, { recursive: true, force: true });
    live.delete(room);
  };

  // Wait for "Ready on http://127.0.0.1:<port>", then for /health.
  const deadline = Date.now() + 60_000;
  let port = null;
  while (port === null) {
    const m = /Ready on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
    if (m) port = Number(m[1]);
    else if (exited !== null) { await stop(); throw new Error(`wrangler dev exited (${exited}) before it was ready:\n${output.slice(-4000)}`); }
    else if (Date.now() > deadline) { await stop(); throw new Error(`wrangler dev not ready after 60s:\n${output.slice(-4000)}`); }
    else await sleep(50);
  }
  const httpUrl = `http://127.0.0.1:${port}`;
  for (;;) {
    try {
      const res = await fetch(`${httpUrl}/health`);
      if (res.ok) break;
    } catch {}
    if (exited !== null || Date.now() > deadline) {
      await stop();
      throw new Error(`room /health never answered on ${httpUrl}:\n${output.slice(-4000)}`);
    }
    await sleep(50);
  }
  return { httpUrl, wsUrl: `ws://127.0.0.1:${port}/room`, port, stop, output: () => output };
}
