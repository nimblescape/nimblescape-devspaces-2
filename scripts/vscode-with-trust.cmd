@echo off
rem SPDX-License-Identifier: MIT
rem © 2026 Hannes Stauss (scalarion@nimblescape.com)
rem Licensed under the MIT License. See LICENSE in the repository root for details.

rem The VS Code of the configuration untrusted of .vscode-test.mjs on Windows: see vscode-with-trust.mjs.
node "%~dp0vscode-with-trust.mjs" %*
