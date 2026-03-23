#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(cd .. && pwd)"
if [[ ! -f public/icon.png ]] && [[ -f "$ROOT/icon.png" ]]; then
  cp -f "$ROOT/icon.png" public/icon.png
fi
if [[ ! -f public/icon.png ]]; then
  echo "Missing public/icon.png — place icon.png in the repo root or website/public/" >&2
  exit 1
fi
npm ci
npm run generate
# Static SPA output — no Node SSR at the edge.
# Create the Pages project once in the dashboard, or Wrangler will prompt.
# Attach custom domain yaaia.online under: Workers & Pages → yaaia-website → Custom domains
#
# Wrangler defaults --branch to the current git branch when omitted, which can create a
# preview deployment. Pin the production branch so this script always targets production.
: "${CF_PAGES_PRODUCTION_BRANCH:=main}"
exec npx wrangler pages deploy .output/public \
  --project-name=yaaia-website \
  --branch="${CF_PAGES_PRODUCTION_BRANCH}"
