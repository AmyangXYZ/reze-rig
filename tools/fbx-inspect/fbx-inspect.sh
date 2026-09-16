#!/usr/bin/env bash
#
# fbx-inspect — read what a clip actually does, out of the exported file.
#
#   ./fbx-inspect.sh out/*.fbx
#   ./fbx-inspect.sh out/*.fbx --check --facing 0 --max-step 25
#
# Prints duration, rig profile, how the body faces at frame 0, how far it turns,
# and the largest single-frame rotation on any bone. --check asserts those and
# exits non-zero, so a bake script can refuse to install a bad file.
#
# The bundle is cached and rebuilt when the source changes.
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
src="$here/fbx-inspect.ts"
bundle="${TMPDIR:-/tmp}/fbx-inspect.mjs"

if [ ! -f "$bundle" ] || [ "$src" -nt "$bundle" ] || [ "$repo/lib/fbx.ts" -nt "$bundle" ] || [ "$repo/lib/retarget.ts" -nt "$bundle" ]; then
	(cd "$repo" && npx esbuild "$src" --bundle --platform=node --format=esm --outfile="$bundle" --log-level=error)
fi

exec node "$bundle" "$@"
