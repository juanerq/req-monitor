import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

test("Docker image copies imported deadline source before typecheck", () => {
  const dockerfile = fs.readFileSync("Dockerfile", "utf8");
  const sourceCopy = dockerfile.match(/^COPY (check-req\.ts .+) \.\/$/m)?.[1];
  assert.ok(sourceCopy, "Dockerfile must copy TypeScript sources");
  assert.ok(sourceCopy.split(/\s+/).includes("deadline.ts"), "deadline.ts must be in the image");
  assert.match(dockerfile, /RUN .*pnpm typecheck/);
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
