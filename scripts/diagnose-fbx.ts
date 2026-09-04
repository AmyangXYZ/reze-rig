import { FBXLoader } from "../lib/fbx";
import { mapsToMmdBone, detectRigProfile } from "../lib/retarget";

const path = process.argv[2] || "/Users/amyang/Projects/Mixamo-MMD/AM_Attack01.fbx";

async function diagnose() {
  const loader = new FBXLoader();
  const clips = await loader.loadAsync(path);
  const clip = clips[0];

  if (!clip) {
    console.log("No clips found");
    return;
  }

  console.log(`\n=== Clip: "${clip.name}" ===`);
  console.log(`Duration: ${clip.duration}s`);
  console.log(`Profile: ${detectRigProfile(clip)}`);
  console.log(`Total tracks: ${clip.tracks.length}`);
  console.log(`Position tracks: ${clip.positionTracks?.length ?? 0}`);

  // Group bones by mapping status
  const mapped = new Map<string, { raw: string; keyframes: number }>();
  const unmapped = new Map<string, { raw: string; keyframes: number }>();

  for (const t of clip.tracks) {
    const isMapped = mapsToMmdBone(t.name);
    const keyframes = t.quats.length;
    const entry = { raw: t.name, keyframes };

    if (isMapped) {
      if (!mapped.has(t.name)) mapped.set(t.name, entry);
    } else {
      if (!unmapped.has(t.name)) unmapped.set(t.name, entry);
    }
  }

  console.log(`\n=== Mapped bones (${mapped.size}) ===`);
  const mappedNames = Array.from(mapped.keys()).sort();
  for (const name of mappedNames) {
    const e = mapped.get(name)!;
    console.log(`  ${name.padEnd(40)} (${e.keyframes} keys)`);
  }

  console.log(`\n=== Unmapped bones (${unmapped.size}) ===`);
  const unmappedNames = Array.from(unmapped.keys()).sort();
  for (const name of unmappedNames) {
    const e = unmapped.get(name)!;
    console.log(`  ${name.padEnd(40)} (${e.keyframes} keys)`);
  }

  // Check upper body presence
  console.log(`\n=== Upper body bone presence ===`);
  const upperBodyTerms = ["Spine", "Neck", "Head", "Arm", "Hand", "Shoulder"];
  for (const term of upperBodyTerms) {
    const found = mappedNames.filter(n => n.includes(term));
    if (found.length > 0) {
      console.log(`  ${term}: ${found.join(", ")}`);
    } else {
      console.log(`  ${term}: NOT FOUND`);
    }
  }
}

diagnose().catch(console.error);
