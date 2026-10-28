#!/usr/bin/env bash
# Shared local/CI entry point. A failed sync must never publish unvalidated data.
set -euo pipefail
cd "$(dirname "$0")/.."

run_tests() {
  npm ci --ignore-scripts
  python -m unittest discover -s tests -v
  node --test tests/*.mjs
  ruff format --check tools tests
  ruff check tools tests
  node --check web/app.js
  node --check dist/site.js
  node --check src/worker.mjs
}

case "${1:-}" in
  schedule) python tools/sync_schedule.py ;;
  competitions) python tools/sync_competitions.py ;;
  china) python tools/sync_china.py ;;
  predictions) python tools/sync_predictions.py ;;
  build) python tools/build.py ;;
  test) run_tests ;;
  all)
    python -m pip install -r requirements.txt
    # An unexpected error aborts publication. Safe source refusals exit 0 and
    # keep the previous trusted version of the affected source.
    python tools/sync_schedule.py
    python tools/sync_competitions.py
    python tools/sync_china.py
    python tools/sync_predictions.py
    python tools/build.py
    run_tests
    ;;
  *)
    echo "Usage: bash tools/ci_run.sh {schedule|competitions|china|predictions|build|test|all}" >&2
    exit 2
    ;;
esac
