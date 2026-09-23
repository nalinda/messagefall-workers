#!/usr/bin/env bash
# Packs the library exactly as it is released (a tarball on a GitHub Release) and proves a
# consumer can install it with Bun and import every entry point with no build step.
#
# Usage: scripts/pack-smoke.sh [out-dir]
# Leaves the tarball in out-dir (default: ./release) and prints its path on the last line.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-$root/release}"
mkdir -p "$out"

cd "$root"
bun run build
# --ignore-scripts: `prepare` installs git hooks, which a pack must not run.
tarball="$(npm pack --ignore-scripts --silent --pack-destination "$out" | tail -n 1)"
tarball="$out/$tarball"

consumer="$(mktemp -d)"
trap 'rm -rf "$consumer"' EXIT
cd "$consumer"
cat > package.json <<'JSON'
{ "name": "pack-smoke", "private": true, "type": "module" }
JSON
bun add "$tarball" hono@^4 >/dev/null

cat > smoke.ts <<'TS'
const entries = [
  'messagefall-workers',
  'messagefall-workers/app',
  'messagefall-workers/client',
  'messagefall-workers/durable',
  'messagefall-workers/providers/console',
  'messagefall-workers/providers/http-sms',
  'messagefall-workers/providers/meta-whatsapp',
  'messagefall-workers/providers/gmail',
];
for (const entry of entries) {
  const mod = await import(entry);
  if (Object.keys(mod).length === 0) throw new Error(`${entry} exports nothing`);
}
const root = await import('messagefall-workers');
if (typeof root.createMessaging !== 'function') throw new Error('createMessaging missing');
console.log(`imported ${entries.length} entry points`);
TS
bun run smoke.ts
echo "$tarball"
