import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

test("Docker image copies imported deadline source before typecheck", () => {
  const dockerfile = fs.readFileSync("Dockerfile", "utf8");
  assert.match(dockerfile, /^COPY \. \.\/$/m, "Dockerfile copies allowlisted sources from context");
  const included = new Set(fs.readFileSync(".dockerignore", "utf8").split(/\r?\n/).filter((rule) => rule.startsWith("!")));
  for (const source of ["deadline.ts", "auth-session.ts", "req-details.ts"]) {
    assert.ok(included.has(`!${source}`), `${source} must be in the image`);
  }
  assert.match(dockerfile, /RUN .*pnpm typecheck/);
});

test("Docker context contains image inputs but excludes credentials and HAR captures", () => {
  const dockerfile = fs.readFileSync("Dockerfile", "utf8");
  const rules = fs.readFileSync(".dockerignore", "utf8").split(/\r?\n/).filter(Boolean);
  assert.equal(rules[0], "*", "Docker context must default to denied");
  const included = new Set(rules.filter((rule) => rule.startsWith("!")).map((rule) => rule.slice(1)));
  const copies = [...dockerfile.matchAll(/^COPY\s+([^\n]+?)\s+\.\/?$/gm)].flatMap((match) => match[1].split(/\s+/));
  for (const source of copies.filter((source) => source !== ".")) {
    assert.ok(included.has(source), `Docker COPY input ${source} must be allowed`);
  }
  for (const source of ["README.md", "tsconfig.json", "check-req.ts", "deadline.ts", "monitor-req.ts", "monitor-api.ts", "auth-session.ts", "req-details.ts", "web", "web/app.js", "web/index.html", "web/styles.css"]) {
    assert.ok(included.has(source), `${source} must reach image`);
  }
  assert.ok(!included.has("web/**"), "new web files must not enter the image by default");
  for (const secret of [".env", ".env.example", ".git", "playwright/.auth", "artifacts", "runtime", "capture.har"]) {
    assert.ok(!included.has(secret), `${secret} must stay outside Docker context`);
  }
  for (const rule of ["**/.env*", "**/.git/**", "**/playwright/.auth/**", "**/artifacts/**", "**/runtime/**"]) {
    assert.ok(rules.includes(rule), `${rule} must override broad web inclusion`);
  }
  assert.ok(rules.includes("*.har"), "HAR must be explicitly excluded");
  assert.match(fs.readFileSync(".gitignore", "utf8"), /^\*\.har$/m);
});

test("Compose loads optional .env and publishes API on host loopback", () => {
  const compose = fs.readFileSync("compose.yaml", "utf8");
  assert.match(compose, /env_file:\s*\n\s*- path: \.env\s*\n\s*required: false\b/);
  assert.match(compose, /- ["']127\.0\.0\.1:\$\{MONITOR_API_PORT:-8787\}:8787["']/);
  assert.match(compose, /MONITOR_INTERVAL_MINUTES: \$\{MONITOR_INTERVAL_MINUTES:-15\}/);
  assert.match(compose, /- \.\/runtime:\/data/);
  assert.match(compose, /- \.\/artifacts:\/app\/artifacts/);
  assert.match(compose, /- \.\/playwright\/\.auth:\/app\/playwright\/\.auth/);
});
