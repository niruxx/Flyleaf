#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  printf '%s\n' 'Set up the virtual environment first. See desktop/README.md.' >&2
  exit 1
fi
exec .venv/bin/python run.py "$@"
