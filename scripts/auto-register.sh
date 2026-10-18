#!/usr/bin/env bash
# ========================================
# Dsh Webds Bridge - Auto Register (Linux/macOS)
# ========================================
# Usage: ./scripts/auto-register.sh
# ========================================
# Delegates to the cross-platform Node master script so every entry point
# shares one logic incl. the idempotent client patch entry writing.
# ========================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check if node is available
if ! command -v node &> /dev/null; then
    echo "[ERROR] node not found, please install Node.js"
    exit 1
fi

# Delegate to the cross-platform Node master script
node "$SCRIPT_DIR/auto-register.js"
