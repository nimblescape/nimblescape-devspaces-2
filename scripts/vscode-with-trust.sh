#!/bin/sh
# SPDX-License-Identifier: MIT
# © 2026 Hannes Stauss (scalarion@nimblescape.com)
# Licensed under the MIT License. See LICENSE in the repository root for details.

# The VS Code of the configuration `untrusted` of .vscode-test.mjs on Linux and macOS: see vscode-with-trust.mjs.
exec node "$(dirname "$0")/vscode-with-trust.mjs" "$@"
