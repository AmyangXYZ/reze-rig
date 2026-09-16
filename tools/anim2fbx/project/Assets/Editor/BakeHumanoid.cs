using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.Formats.Fbx.Exporter;
using UnityEngine;

/// <summary>
/// Bakes Unity Humanoid .anim clips onto a rig and exports them as FBX.
///
/// A humanoid clip stores muscle values, not bone rotations: normalised numbers
/// against each joint's limits, meaningless without an Avatar to interpret them.
/// So the clip is sampled onto a real humanoid rig — which is where the Avatar
/// lives — and what the bones actually do is recorded as ordinary transform
/// curves. That is what the FBX exporter can write, and what any other tool can
/// then read.
///
/// Driven by anim2fbx.sh: clips are staged in Assets/Clips, output goes to
/// $BAKE_OUT, frame rate comes from $BAKE_FPS, root handling from $BAKE_ROOT.
/// </summary>
public static class BakeHumanoid
{
    const string RigPath = "Assets/XBot.fbx";
    const string ClipDir = "Assets/Clips";

    /// <summary>
    /// What to do with the root the capture was authored against.
    ///
    /// Sampling has no host to hand root motion to, so whatever the capture put
    /// in the root stays in the body. Which of the two answers is right depends
    /// on what the root is carrying.
    /// </summary>
    enum RootMode
    {
        /// Replace the root with a fixed heading and an even de-drift ramp. For
        /// a cycle whose root carries only the heading it was captured along and
        /// the travel a host was meant to consume — a run, a walk.
        Flatten,

        /// Read the heading off the body at frame 0 and fold the root into the
        /// hips, leaving an identity root. For a performance that turns — a
        /// spin, a step-around — and for anything authored with Root Transform
        /// Rotation baked into pose, where the root is inert and the heading
        /// lives in the body.
        Keep,
    }

    public static void Run()
    {
        var outDir = System.Environment.GetEnvironmentVariable("BAKE_OUT");
        if (string.IsNullOrEmpty(outDir)) outDir = "out";
        Directory.CreateDirectory(outDir);

        var fps = 30f;
        var fpsEnv = System.Environment.GetEnvironmentVariable("BAKE_FPS");
        if (!string.IsNullOrEmpty(fpsEnv)) float.TryParse(fpsEnv, out fps);
        if (fps <= 0f) fps = 30f;

        var rootEnv = System.Environment.GetEnvironmentVariable("BAKE_ROOT");
        var rootMode = RootMode.Flatten;
        if (!string.IsNullOrEmpty(rootEnv))
        {
            switch (rootEnv.Trim().ToLowerInvariant())
            {
                case "flatten": rootMode = RootMode.Flatten; break;
                case "keep": rootMode = RootMode.Keep; break;
                default:
                    Debug.LogError("[bake] BAKE_ROOT must be 'flatten' or 'keep', got: " + rootEnv);
                    EditorApplication.Exit(5);
                    return;
            }
        }

        // The rig must be Humanoid, or there is no Avatar to read the muscles with.
        var importer = AssetImporter.GetAtPath(RigPath) as ModelImporter;
        if (importer == null)
        {
            Debug.LogError("[bake] no importer for " + RigPath);
            EditorApplication.Exit(2);
            return;
        }
        if (importer.animationType != ModelImporterAnimationType.Human)
        {
            importer.animationType = ModelImporterAnimationType.Human;
            importer.SaveAndReimport();
        }

        var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(RigPath);
        var sourceAvatar = prefab != null ? prefab.GetComponent<Animator>() : null;
        if (prefab == null || sourceAvatar == null || sourceAvatar.avatar == null || !sourceAvatar.avatar.isValid)
        {
            Debug.LogError("[bake] the bundled rig has no valid humanoid avatar");
            EditorApplication.Exit(3);
            return;
        }
        Debug.Log("[bake] rig=" + RigPath + " avatar=" + sourceAvatar.avatar.name
            + " fps=" + fps + " root=" + rootMode.ToString().ToLowerInvariant());

        var clipPaths = new List<string>();
        foreach (var guid in AssetDatabase.FindAssets("t:AnimationClip", new[] { ClipDir }))
            clipPaths.Add(AssetDatabase.GUIDToAssetPath(guid));
        clipPaths.Sort();
        if (clipPaths.Count == 0)
        {
            Debug.LogError("[bake] no .anim clips staged in " + ClipDir);
            EditorApplication.Exit(4);
            return;
        }

        var failed = 0;
        foreach (var clipPath in clipPaths)
        {
            var clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(clipPath);
            if (clip == null)
            {
                Debug.LogError("[bake] could not load " + clipPath);
                failed++;
                continue;
            }
            if (!clip.isHumanMotion)
            {
                Debug.LogError("[bake] " + Path.GetFileName(clipPath) + " is not a Humanoid clip — "
                    + "reimport its source with Animation Type set to Humanoid, or bake it yourself.");
                failed++;
                continue;
            }

            var go = Object.Instantiate(prefab);
            go.name = Path.GetFileNameWithoutExtension(clipPath);
            var animator = go.GetComponent<Animator>();
            if (animator == null) animator = go.AddComponent<Animator>();
            animator.avatar = sourceAvatar.avatar;
            // Clips like these ship for in-place use: they keep travel as root
            // motion (m_LoopBlendPositionXZ: 0) for a host to consume. Applying it
            // here would walk the body forward while the legs cycle on the spot,
            // dragging the feet through the floor.
            animator.applyRootMotion = false;

            var frames = Mathf.Max(1, Mathf.RoundToInt(clip.length * fps));
            var hipBone = animator.GetBoneTransform(HumanBodyBones.Hips);
            var leftLeg = animator.GetBoneTransform(HumanBodyBones.LeftUpperLeg);
            var rightLeg = animator.GetBoneTransform(HumanBodyBones.RightUpperLeg);

            // PASS 1 — measure what the root was carrying.
            //
            // Sampling has no host to hand root motion to, so whatever the capture
            // put in the root stays in the body: the runner slides forward across a
            // cycle authored to run on the spot, and comes out facing the heading it
            // was captured along. Measure both, then correct in pass 2 — the
            // per-frame sway and bob that belong to the performance survive.
            var rootRot = new Quaternion[frames + 1];
            var rootPos = new Vector3[frames + 1];
            var driftStart = Vector3.zero;
            var driftEnd = Vector3.zero;
            var facingSum = Vector3.zero;
            var facingStart = Vector3.zero;
            var turn = 0f;            // unwrapped root yaw, so a full spin reads as 360 not 0
            var prevYaw = 0f;
            AnimationMode.StartAnimationMode();
            for (var i = 0; i <= frames; i++)
            {
                AnimationMode.BeginSampling();
                AnimationMode.SampleAnimationClip(go, clip, i / fps);
                AnimationMode.EndSampling();
                rootRot[i] = go.transform.rotation;
                rootPos[i] = go.transform.position;
                var y = go.transform.rotation.eulerAngles.y;
                if (i > 0) turn += Mathf.DeltaAngle(prevYaw, y);
                prevYaw = y;
                if (leftLeg != null && rightLeg != null)
                {
                    // Which way the body points, read off the hip axis. The pelvis
                    // sways every step, so sum the whole cycle and let it cancel.
                    var axis = leftLeg.position - rightLeg.position;
                    var forward = new Vector3(axis.z, 0f, -axis.x);
                    facingSum += forward;
                    if (i == 0) facingStart = forward;
                }
                if (hipBone == null) continue;
                if (i == 0) driftStart = hipBone.position;
                if (i == frames) driftEnd = hipBone.position;
            }
            AnimationMode.StopAnimationMode();

            Quaternion straighten;
            Vector3 drift;
            var origin = Vector3.zero;   // where the root starts, once straightened
            if (rootMode == RootMode.Keep)
            {
                // Read the heading off the BODY at frame 0, not the root. A clip
                // authored with Root Transform Rotation baked into pose leaves the
                // root inert and puts the capture heading in the body, so asking
                // the root which way the figure faces answers zero and straightens
                // nothing — it comes out facing the direction it was captured
                // along. Frame 0 only: summing a spin cancels to noise.
                var yaw = facingStart.sqrMagnitude > 1e-8f
                    ? Mathf.Atan2(facingStart.x, facingStart.z) * Mathf.Rad2Deg
                    : 0f;
                straighten = Quaternion.Euler(0f, -yaw, 0f);
                origin = straighten * rootPos[0];
                var end = straighten * rootPos[frames];
                drift = new Vector3(end.x - origin.x, 0f, end.z - origin.z);
                var check = straighten * facingStart;
                Debug.Log("[bake] " + go.name + ": faced " + yaw.ToString("F1")
                    + " deg at frame 0 — straightened to " + (Mathf.Atan2(check.x, check.z) * Mathf.Rad2Deg).ToString("F1")
                    + " deg; root turns " + turn.ToString("F1") + " deg — kept; net travel "
                    + drift.magnitude.ToString("F2") + "m removed");
            }
            else
            {
                var yaw = facingSum.sqrMagnitude > 1e-8f
                    ? Mathf.Atan2(facingSum.x, facingSum.z) * Mathf.Rad2Deg
                    : 0f;
                straighten = Quaternion.Euler(0f, -yaw, 0f);
                drift = straighten * new Vector3(driftEnd.x - driftStart.x, 0f, driftEnd.z - driftStart.z);
                Debug.Log("[bake] " + go.name + ": heading " + yaw.ToString("F1") + " deg, net travel "
                    + drift.magnitude.ToString("F2") + "m — both removed"
                    + (Mathf.Abs(turn) > 45f
                        ? "  *** WARNING: the root turns " + turn.ToString("F0")
                          + " deg across this clip and flatten will discard that. BAKE_ROOT=keep preserves it. ***"
                        : ""));
            }

            // PASS 2 — record the corrected pose as plain transform curves.
            var recorder = new GameObjectRecorder(go);
            recorder.BindComponentsOfType<Transform>(go, true);
            AnimationMode.StartAnimationMode();
            for (var i = 0; i <= frames; i++)
            {
                AnimationMode.BeginSampling();
                AnimationMode.SampleAnimationClip(go, clip, i / fps);
                AnimationMode.EndSampling();
                var ramp = drift * ((float)i / frames);
                if (rootMode == RootMode.Keep && hipBone != null)
                {
                    // Fold the root into the hips and hand back an identity root.
                    // A correction parked on the scene root only shows up in tools
                    // that animate that node; rigging services generally read the
                    // skeleton and drop everything above it, so the figure arrives
                    // facing its capture heading again. In the hips it is part of
                    // the skeleton, and travels.
                    var hipRot = hipBone.rotation;
                    var hipPos = hipBone.position;
                    go.transform.rotation = Quaternion.identity;
                    go.transform.position = Vector3.zero;
                    hipBone.rotation = straighten * hipRot;
                    var p = straighten * hipPos;
                    hipBone.position = new Vector3(p.x - origin.x - ramp.x, p.y, p.z - origin.z - ramp.z);
                }
                else
                {
                    go.transform.rotation = straighten;
                    go.transform.position = -ramp;
                }
                recorder.TakeSnapshot(1f / fps);
            }
            AnimationMode.StopAnimationMode();

            var baked = new AnimationClip { name = go.name, frameRate = fps };
            recorder.SaveToClip(baked, fps);
            // The recorder writes quaternion curves, and neighbouring keys are free
            // to differ in sign — q and -q are the same rotation, so nothing
            // complains until the exporter converts them to Euler angles, where a
            // sign flip reads as taking the long way round.
            baked.EnsureQuaternionContinuity();

            baked.legacy = true;                       // the exporter reads clips off an Animation component
            var legacy = go.AddComponent<Animation>();
            legacy.AddClip(baked, baked.name);
            legacy.clip = baked;

            var options = new ExportModelOptions
            {
                ExportFormat = ExportFormat.Binary,
                ModelAnimIncludeOption = Include.ModelAndAnim,
                AnimateSkinnedMesh = true,
                ExportUnrendered = true,
            };
            var outPath = Path.Combine(outDir, go.name + ".fbx");
            var written = ModelExporter.ExportObjects(outPath, new Object[] { go }, options);
            if (string.IsNullOrEmpty(written))
            {
                Debug.LogError("[bake] export failed for " + go.name);
                failed++;
            }
            else
            {
                Debug.Log("[bake] wrote " + written + " (" + (frames + 1) + " frames)");
            }

            Object.DestroyImmediate(go);
        }

        Debug.Log("[bake] done");
        EditorApplication.Exit(failed > 0 ? 1 : 0);
    }
}
