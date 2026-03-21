#!/bin/bash
# lore: incremental indexing on session stop
# Runs in background to avoid blocking session exit

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(dirname "$(dirname "$0")")}"
node "$PLUGIN_ROOT/dist/index.js" index --mode incremental &>/dev/null &
