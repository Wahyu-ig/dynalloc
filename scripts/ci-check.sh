#!/usr/bin/env bash
# ci-check.sh — single-entry aggregator that runs every Phase 0 validation gate locally.
#
# This mirrors what the GitHub Actions workflow (.github/workflows/ci.yml) runs,
# so a developer can verify "would CI pass?" before pushing.
#
# Usage:
#   ./scripts/ci-check.sh            # run all checks, exit non-zero on any failure
#   ./scripts/ci-check.sh --quiet    # only print failures + summary
#
# Exit codes:
#   0  all checks passed
#   1  one or more checks failed
#
# This script is safe to run on a fresh checkout — no system dependencies beyond
# Node.js itself.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

QUIET=0
if [ "${1:-}" = "--quiet" ]; then
  QUIET=1
fi

log() {
  if [ "$QUIET" = "0" ]; then
    echo "$@"
  fi
}

fail_count=0
check_count=0

run_check() {
  local name="$1"
  local cmd="$2"
  check_count=$((check_count + 1))
  log "::group::$name"
  # Run in a subshell so `exit` inside the cmd doesn't kill this script.
  if ( eval "$cmd" ) >"/tmp/ci-check-$check_count.log" 2>&1; then
    log "  PASS  $name"
  else
    fail_count=$((fail_count + 1))
    echo "  FAIL  $name"
    cat "/tmp/ci-check-$check_count.log"
  fi
  log "::endgroup::"
}

log "=== Dynalloc Phase 0 CI Check ==="
log "Root: $ROOT_DIR"
log ""

# 1. Syntax check all JS files
JS_FILES=""
for f in *.js policy-engine/*.js plugins/*.js detectors/*.js profiles/*.js adaptive/*.js recognition/*.js monitoring/*.js sdk/*.js lib/*.js lib/controllers/*.js scripts/*.js test/unit/*.js test/integration/*.js; do
  if [ -f "$f" ]; then
    JS_FILES="$JS_FILES $f"
  fi
done

run_check "Syntax: node --check all JS" \
  "fail=0; for f in $JS_FILES; do node --check \"\$f\" || fail=1; done; exit \$fail"

# 2. Unit tests
run_check "Unit tests (test-all.js)" \
  "node --test test/unit/test-all.js"

run_check "Unit tests (test-policy-engine.js)" \
  "node --test test/unit/test-policy-engine.js"

run_check "Unit tests (test-network-controller.js)" \
  "node --test test/unit/test-network-controller.js"

run_check "Unit tests (test-detector-layer.js)" \
  "node --test test/unit/test-detector-layer.js"

run_check "Unit tests (test-resource-controller-layer.js)" \
  "node --test test/unit/test-resource-controller-layer.js"

run_check "Unit tests (test-profile-manager.js)" \
  "node --test test/unit/test-profile-manager.js"

run_check "Unit tests (test-adaptive-switching.js)" \
  "node --test test/unit/test-adaptive-switching.js"

run_check "Unit tests (test-workload-recognition.js)" \
  "node --test test/unit/test-workload-recognition.js"

run_check "Unit tests (test-monitoring-framework.js)" \
  "node --test test/unit/test-monitoring-framework.js"

run_check "Unit tests (test-plugin-sdk.js)" \
  "node --test test/unit/test-plugin-sdk.js"

run_check "Unit tests (test-system-plugin.js)" \
  "node --test test/unit/test-system-plugin.js"

run_check "Unit tests (test-learning-logger.js)" \
  "node --test test/unit/test-learning-logger.js"

run_check "Unit tests (test-per-app-profiles.js)" \
  "node --test test/unit/test-per-app-profiles.js"

run_check "Unit tests (test-kde-wayland-plugin.js)" \
  "node --test test/unit/test-kde-wayland-plugin.js"

# 3. Integration tests
run_check "Integration tests (test-integration.js)" \
  "node --test test/integration/test-integration.js"

run_check "Integration tests (test-policy-integration.js)" \
  "node --test test/integration/test-policy-integration.js"

# 4. Verify scripts (skip CLI + packaging which need live daemon / dpkg tools)
for s in verify-fixes verify-foreground verify-medium-features verify-memory-cgroup verify-pid-reuse verify-ppd verify-thermal verify-actuator-api verify-controller-isolation verify-network-qos verify-detector-layer verify-resource-controller-layer verify-profile-manager verify-adaptive-switching verify-workload-recognition verify-monitoring-framework verify-plugin-sdk; do
  if [ -f "scripts/$s.js" ]; then
    run_check "Verify: $s" "node scripts/$s.js"
  fi
done

# 5. Config & package validation
run_check "package.json parses" \
  "node -e \"require('./package.json'); console.log('OK')\""

run_check "Example configs parse" \
  "node -e \"JSON.parse(require('fs').readFileSync('dynalloc.config.example.json','utf8')); JSON.parse(require('fs').readFileSync('dynalloc.config.clean.json','utf8')); JSON.parse(require('fs').readFileSync('policies.example.json','utf8')); console.log('OK')\""

# 6. Dry-run daemon boot (must self-check then exit on SIGTERM)
run_check "Daemon boots in DRY_RUN" \
  "DYNALLOC_DRY_RUN=1 timeout 5 node dynalloc-daemon.js > /tmp/ci-check-daemon.log 2>&1; code=\$?; if [ \"\$code\" = \"124\" ]; then exit 0; fi; exit \$code"

# Summary
echo ""
echo "=== Summary ==="
echo "  Checks run:    $check_count"
echo "  Checks passed: $((check_count - fail_count))"
echo "  Checks failed: $fail_count"
echo ""

if [ "$fail_count" -gt 0 ]; then
  echo "FAIL: $fail_count check(s) failed"
  exit 1
fi

echo "PASS: All Phase 0 validation gates green"
exit 0
