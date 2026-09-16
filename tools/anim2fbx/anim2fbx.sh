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
#   BAKE_ROOT  flatten (default) replaces the root with a fixed heading; keep
#              preserves a root that turns, for spins and step-arounds
#   BAKE_CHECK 1 (default) reads each exported file back and fails on a bad one;
#              0 skips it
#
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project="$here/project"
staging="$project/Assets/Clips"

if [ $# -lt 2 ]; then
	sed -n '3,19p' "${BASH_SOURCE[0]}" | sed 's/^#[[:space:]]\{0,1\}//'
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

# Validate up front, so a typo doesn't surface three clips into a long bake.
for clip in "$@"; do
	if [ ! -f "$clip" ]; then
		echo "anim2fbx: no such clip: $clip" >&2
		exit 1
	fi
	case "$clip" in
		*.anim) ;;
		*) echo "anim2fbx: not a .anim file: $clip" >&2; exit 1 ;;
	esac
done

trap 'rm -rf "$staging"' EXIT

echo "anim2fbx: baking $# clip(s) with Unity $(basename "$(dirname "$(dirname "$(dirname "$(dirname "$UNITY")")")")")"

# One editor per clip. The FBX SDK's manager leaks across exports inside a
# single process — the third FbxManager.Create aborts the editor outright
# (std::overflow_error from its own hash table) — so each clip gets a fresh one.
# Unity costs ~20s to start, which is the price of finishing at all.
failed=0
for clip in "$@"; do
	name="$(basename "$clip")"

	# Unity only sees assets inside the project, and derives the clip's asset
	# name — and so the output filename — from what we stage.
	rm -rf "$staging"
	mkdir -p "$staging"
	cp "$clip" "$staging/$name"

	log="$(mktemp -t anim2fbx)"
	set +e
	BAKE_OUT="$out" BAKE_FPS="${BAKE_FPS:-30}" BAKE_ROOT="${BAKE_ROOT:-flatten}" "$UNITY" \
		-batchmode -quit -projectPath "$project" \
		-executeMethod BakeHumanoid.Run -logFile "$log"
	status=$?
	set -e

	grep -E '^\[bake\]' "$log" || true
	if [ $status -ne 0 ]; then
		echo "anim2fbx: $name failed (exit $status) — full log at $log" >&2
		failed=$((failed + 1))
		continue
	fi
	rm -f "$log"

	# Read the file back. The bake reports what it meant to do; a correction can
	# be computed correctly and still land somewhere nothing downstream reads,
	# and the log looks identical either way.
	if [ "${BAKE_CHECK:-1}" != "0" ]; then
		baked="$out/$(basename "$name" .anim).fbx"
		# Only keep folds the heading into the hips, so only keep can be asserted
		# on it. flatten leaves its correction on the scene root by design.
		facing=""
		[ "${BAKE_ROOT:-flatten}" = "keep" ] && facing="--facing 0"
		if ! "$here/../fbx-inspect/fbx-inspect.sh" "$baked" --check --quiet $facing; then
			echo "anim2fbx: $name exported, but the file does not check out" >&2
			failed=$((failed + 1))
		fi
	fi
done

if [ $failed -ne 0 ]; then
	echo "anim2fbx: $failed clip(s) failed" >&2
	exit 1
fi
echo "anim2fbx: wrote to $out"
