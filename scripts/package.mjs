import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resourcesRoot = path.join(root, "resources");
const outputRoot = path.join(root, "build", "hmp-foundations");
const outputResources = path.join(outputRoot, "resources");
const pack = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const releaseFiles = ["README.md", "INSTALL.md", "DATABASE.md", "COMPATIBILITY.md", "CHANGELOG.md", "BETA_TESTING.md", "LICENSE"];

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputResources, { recursive: true });

const packaged = [];
for (const entry of await readdir(resourcesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("hmp-")) continue;
    const source = path.join(resourcesRoot, entry.name);
    const manifestPath = path.join(source, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!manifest.mafiahub || !manifest.name) throw new Error(`${entry.name} has no resource manifest`);
    if (manifest.version !== pack.version) {
        throw new Error(`${entry.name} is ${manifest.version}; official pack resources must match ${pack.version}`);
    }

    const destination = path.join(outputResources, entry.name);
    await mkdir(destination, { recursive: true });
    const runtimeManifest = {
        name: manifest.name,
        version: manifest.version,
        author: manifest.author,
        description: manifest.description,
        license: manifest.license,
        mafiahub: manifest.mafiahub,
    };
    await writeFile(path.join(destination, "package.json"), JSON.stringify(runtimeManifest, null, 2) + "\n");
    for (const name of ["LICENSE", "README.md", "types.d.ts"]) {
        try { await cp(path.join(source, name), path.join(destination, name)); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    await cp(path.join(source, "dist"), path.join(destination, "dist"), { recursive: true });
    packaged.push({ name: manifest.name, version: manifest.version });
}

if (!packaged.length) throw new Error("No hmp-* resources were packaged");
await writeFile(path.join(outputRoot, "foundations.json"), JSON.stringify({
    schemaVersion: 1,
    name: pack.name,
    version: pack.version,
    versionPolicy: "pack-locked",
    compatibility: "COMPATIBILITY.md",
    resources: packaged,
}, null, 2) + "\n");
for (const name of releaseFiles) await cp(path.join(root, name), path.join(outputRoot, name));
await mkdir(path.join(outputRoot, "examples"), { recursive: true });
await cp(path.join(root, "examples", "config"), path.join(outputRoot, "examples", "config"), { recursive: true });

console.log(`Packaged ${packaged.length} resource(s) in ${path.relative(root, outputRoot)}`);
