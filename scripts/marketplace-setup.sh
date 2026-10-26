#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# © 2026 Hannes Stauss (scalarion@nimblescape.com)
# Licensed under the MIT License. See LICENSE in the repository root for details.

# The Marketplace setup of one extension repository (CONTRIBUTING.md,
# "Setup of a repository"): the federated credential of the publishing app
# registration in Microsoft Entra ID, and the GitHub environment `marketplace`
# with its deployment rules. Run it once per repository, in its clone, on a
# computer where the Azure CLI (`az`) and the GitHub CLI (`gh`) are signed in:
#
#   az login --allow-no-subscriptions
#   gh auth login
#   scripts/marketplace-setup.sh
#
# The repository is the GitHub repository of the remote `origin` of the clone
# that holds the script, and the extension ID is publisher.name of its
# package.json; by the naming scheme, name and repository are the same. The
# script shows what it sets up and asks before it changes anything. It changes
# nothing that already exists, so it can run again. The app is the one of the
# variable AZURE_CLIENT_ID, or the app named by APP_NAME (default
# vscode-marketplace-publisher, the app of the publisher nimblescape).
set -euo pipefail

for tool in az gh git node; do
  command -v "$tool" >/dev/null || { echo "$tool is not installed." >&2; exit 1; }
done

# owner/repository from the URL of `origin`: https://github.com/<owner>/<repository>(.git) or
# git@github.com:<owner>/<repository>(.git).
url=$(git -C "$(dirname "$0")" remote get-url origin)
repo="${url#*github.com[:/]}"
repo="${repo%/}"
repo="${repo%.git}"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "The remote origin ($url) is no GitHub repository." >&2; exit 1; }
owner="${repo%%/*}"
name="${repo#*/}"
environment="marketplace"

# The extension ID from package.json; its name must be the name of the repository.
root=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
extension=$(node -p 'const p = require(process.argv[1]); `${p.publisher}.${p.name}`' "$root/package.json")
[ "${extension#*.}" = "$name" ] || { echo "The extension $extension in package.json does not match the repository $repo." >&2; exit 1; }

# The subject of the token that GitHub Actions issues to a job of the
# environment: owner and repository with their IDs, as GitHub writes it for
# repositories created after 15 July 2026.
owner_id=$(gh api "users/$owner" --jq .id)
repo_id=$(gh api "repos/$repo" --jq .id)
subject="repo:${owner}@${owner_id}/${name}@${repo_id}:environment:${environment}"

app_id="${AZURE_CLIENT_ID:-$(az ad app list --display-name "${APP_NAME:-vscode-marketplace-publisher}" --query '[0].appId' --output tsv)}"
[ -n "$app_id" ] || { echo "No app registration found; set AZURE_CLIENT_ID or APP_NAME." >&2; exit 1; }
app_name=$(az ad app show --id "$app_id" --query displayName --output tsv)
account=$(az account show --query user.name --output tsv)

cat <<TEXT
Extension:            $extension
Repository:           $repo
App registration:     $app_name ($app_id)
Azure account:        $account
Federated credential: $subject
Environment:          $environment (tags v*, branch main)
TEXT
read -r -p "Set up the Marketplace publishing of $repo? [y/N] " answer || true
[[ "$answer" =~ ^[Yy]$ ]] || { echo "Nothing changed."; exit 1; }

# Step 4: the federated credential, unless one with this subject exists.
if [ "$(az ad app federated-credential list --id "$app_id" --query "length([?subject=='$subject'])" --output tsv)" = "0" ]; then
  # The Azure CLI may split a JSON string argument at its commas, so it reads the parameters from a file.
  parameters=$(mktemp)
  trap 'rm -f "$parameters"' EXIT
  cat >"$parameters" <<JSON
{
  "name": "$name",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "$subject",
  "audiences": ["api://AzureADTokenExchange"],
  "description": "GitHub Actions of $repo, environment $environment"
}
JSON
  az ad app federated-credential create --id "$app_id" --parameters "$parameters" >/dev/null || {
    echo "The account $account may not change the app registration $app_name: it needs to be one of its owners" >&2
    echo "(Entra admin center, App registrations, $app_name, Owners) or hold the role Application Administrator." >&2
    exit 1
  }
  echo "Federated credential added: $subject"
else
  echo "Federated credential exists: $subject"
fi

# Step 5: the environment, which only the tags v* and the branch main reach.
gh api --method PUT "repos/$repo/environments/$environment" --input - >/dev/null <<JSON
{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
existing=$(gh api "repos/$repo/environments/$environment/deployment-branch-policies" --jq '[.branch_policies[] | "\(.type):\(.name)"] | join(" ")')
for rule in "tag:v*" "branch:main"; do
  case " $existing " in
    *" $rule "*) echo "Deployment rule exists: $rule" ;;
    *)
      gh api --method POST "repos/$repo/environments/$environment/deployment-branch-policies" \
        -f type="${rule%%:*}" -f name="${rule#*:}" >/dev/null
      echo "Deployment rule added: $rule" ;;
  esac
done

echo "Done. Check the sign-in with the workflow \"Marketplace identity\" of $repo."
