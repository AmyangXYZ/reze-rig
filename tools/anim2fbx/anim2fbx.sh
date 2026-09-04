#!/usr/bin/env bash
#
# anim2fbx — convert Unity Humanoid .anim clips to FBX.
#
# A .anim holds muscle values, not bone rotations: normalised numbers against
# each joint's limits, meaningless without an Avatar to read them with. This
# stages the clips into a bundled Unity project, samples them onto a Mixamo
# X Bot rig that ships with the tool, and exports the resulting bone motion as
# FBX — which reze-rig, or anything else, can then read.
#
#   ./anim2fbx.sh out/ clip.anim [more.anim ...]
#
# Env:
#   UNITY      path to the Unity binary (default: newest under Unity Hub)
#   BAKE_FPS   sample rate, default 30
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project="$here/project"
staging="$project/Assets/Clips"

if [ $# -lt 2 ]; then
	sed -n '3,16p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
	exit 1
fi

out="$1"; shift
mkdir -p "$out"
out="$(cd "$out" && pwd)"

if [ -z "${UNITY:-}" ]; then
	UNITY="$(ls -d /Applications/Unity/Hub/Editor/*/Unity.app/Contents/MacOS/Unity 2>/dev/null | sort -V | tail -1 || true)"
fi
if [ ! -x "${UNITY:-}" ]; then
	echo "anim2fbx: no Unity editor found — install one via Unity Hub, or set UNITY=/path/to/Unity" >&2
	exit 1
fi

# Stage the clips. Unity only sees assets inside the project, and only clears
# out cleanly if we take the same ones back out afterwards.
rm -rf "$staging"
mkdir -p "$staging"
staged=0
for clip in "$@"; do
	if [ ! -f "$clip" ]; then
		echo "anim2fbx: no such clip: $clip" >&2
		exit 1
	fi
	case "$clip" in
		*.anim) ;;
		*) echo "anim2fbx: not a .anim file: $clip" >&2; exit 1 ;;
	esac
	# Unity derives the clip's asset name — and so the output filename — from this.
	cp "$clip" "$staging/$(basename "$clip")"
	staged=$((staged + 1))
done
trap 'rm -rf "$staging"' EXIT

echo "anim2fbx: baking $staged clip(s) with Unity $(basename "$(dirname "$(dirname "$(dirname "$(dirname "$UNITY")")")")")"

log="$(mktemp -t anim2fbx)"
set +e
BAKE_OUT="$out" BAKE_FPS="${BAKE_FPS:-30}" "$UNITY" \
	-batchmode -quit -projectPath "$project" \
	-executeMethod BakeHumanoid.Run -logFile "$log"
status=$?
set -e

grep -E '^\[bake\]' "$log" || true
if [ $status -ne 0 ]; then
	echo "anim2fbx: bake failed (exit $status) — full log at $log" >&2
	exit $status
fi
rm -f "$log"
echo "anim2fbx: wrote to $out"
