import { FBXLoader } from "../lib/fbx";
import * as fs from "fs";
import * as pathLib from "path";

const fileName = process.argv[2] || "AM_Attack01.fbx";
const path = pathLib.resolve(process.cwd(), fileName);

async function checkBones() {
  if (!fs.existsSync(path)) {
    console.error(`File not found: ${path}`);
    return;
  }

  const loader = new FBXLoader();
  const clips = await new Promise<any[]>((resolve, reject) => {
    loader.load(path, resolve, undefined, reject);
  });
  const clip = clips[0];

  if (!clip) {
    console.log("No clips found");
    return;
  }

  const bones = new Map<string, number>();
  for (const t of clip.tracks) {
    const name = t.name.replace(/^mixamorig\d*:/i, '').trim();
    bones.set(name, (bones.get(name) ?? 0) + 1);
  }

  console.log(`\n=== Bone names in "${clip.name}" ===\n`);
  const sorted = Array.from(bones.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [name, count] of sorted) {
    console.log(`  ${name}`);
  }

  console.log(`\nTotal unique bones: ${bones.size}`);
  console.log(`Total tracks: ${clip.tracks.length}`);
}

checkBones().catch(console.error);
