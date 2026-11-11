#!/usr/bin/env bash
# Runs every technical check of the MCP server and prints one PASS/FAIL/SKIP line per step. Never deploys, never touches production.
#
#   GitHub Codespaces (free quota) or any machine with Node 22:   bash scripts/validate-all.sh
#   End-to-end against the real V2 backend (optional): clone AiWorkPay-SASU/Aiworkpay-v2 (default branch) next to this repo,
#   have a local PostgreSQL 16 (see that repo's scripts/validate-all.sh) and run:  BACKEND_DIR=../Aiworkpay-v2 bash scripts/validate-all.sh
# The report is written to validation-report.txt (git-ignored). No secret is needed or printed.
set -u
cd "$(dirname "$0")/.."
REPORT=validation-report.txt; : > "$REPORT"; PASS=0; FAIL=0; SKIP=0
step() { local name="$1"; shift; local out; out="$(mktemp)"
  if "$@" >"$out" 2>&1; then echo "PASS  $name"; PASS=$((PASS+1)); echo "PASS  $name :: $*" >>"$REPORT"
  else local code=$?; echo "FAIL  $name (exit $code)"; FAIL=$((FAIL+1)); { echo "FAIL  $name :: $* (exit $code)"; tail -n 25 "$out" | sed -E 's/(sk|rk|whsec|awp)_[A-Za-z0-9_]{12,}/\1_[redacted]/g'; } >>"$REPORT"; fi
  rm -f "$out"; }
skip() { echo "SKIP  $1 ($2)"; SKIP=$((SKIP+1)); echo "SKIP  $1 :: $2" >>"$REPORT"; }

echo "Node $(node -v) — $(date -u +%FT%TZ) — commit $(git rev-parse --short HEAD 2>/dev/null)" | tee -a "$REPORT"
step "Install dependencies (npm ci)"       npm ci --no-audit --no-fund
step "TypeScript (tsc --noEmit)"           npm run typecheck
step "Vitest (unit and contract tests)"    npx vitest run --exclude 'test/e2e/**'
step "Production build"                    npm run build
step "Production dependencies: no high/critical advisory" npm audit --omit=dev --audit-level=high
if [ -n "${BACKEND_DIR:-}" ] && [ -d "$BACKEND_DIR" ]; then
  export AUTH_SECRET=ci-placeholder-secret-min-32-chars-ok STRIPE_SECRET_KEY=sk_test_placeholder STRIPE_WEBHOOK_SECRET=whsec_placeholder
  export NEXT_PUBLIC_APP_URL=http://127.0.0.1:3300 E2E_CONTROL_URL=http://127.0.0.1:4100
  export DATABASE_URL="${DATABASE_URL:-postgresql://postgres:postgres@localhost:5432/aw_e2e}"
  (cd "$BACKEND_DIR" && npm ci --no-audit --no-fund && npx prisma generate && npm run build && nohup npm run e2e:harness > "$OLDPWD/harness.log" 2>&1 &)
  for i in $(seq 1 90); do grep -q E2E_HARNESS_READY harness.log 2>/dev/null && break; sleep 2; done
  if grep -q E2E_HARNESS_READY harness.log 2>/dev/null; then step "End-to-end against the isolated V2 backend" npm run test:e2e; else FAIL=$((FAIL+1)); echo "FAIL  isolated backend did not start (see harness.log)"; fi
  pkill -f e2e/harness.cjs 2>/dev/null || true
else
  skip "End-to-end against the V2 backend" "set BACKEND_DIR to a checkout of Aiworkpay-v2 (default branch)"
fi
echo "---- $PASS passed, $FAIL failed, $SKIP skipped — details in $REPORT"
[ "$FAIL" -eq 0 ]
