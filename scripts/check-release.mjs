import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredFiles = [
    "README.md",
    "INSTALL.md",
    "DATABASE.md",
    "COMPATIBILITY.md",
    "CHANGELOG.md",
    "gamemodes/README.md",
    "examples/config/README.md",
    "examples/config/environment.example",
];
const requiredExamples = ["hmp-mysql", "hmp-core", "hmp-houses", "hmp-characters", "hmp-spawn", "hmp-inventory", "hmp-audio", "hmp-blips", "hmp-doors", "hmp-emotes", "hmp-spells", "hmp-progression", "hmp-activities", "hmp-pvp", "hmp-duels", "hmp-npcs", "hmp-admin", "hmp-shops", "hmp-webhooks", "hmp-business", "hmp-worldstate", "hmp-loot", "hmp-beasts"];

async function json(file) {
    return JSON.parse(await readFile(path.join(root, file), "utf8"));
}

function hasClientScripts(manifest) {
    return Boolean(manifest.mafiahub.clientScripts?.length || manifest.mafiahub.sharedScripts?.length);
}

const pack = await json("package.json");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pack.version)) throw new Error(`Invalid pack version '${pack.version}'`);

for (const file of requiredFiles) await readFile(path.join(root, file));
for (const name of requiredExamples) await json(`examples/config/data/${name}.json`);

for (const file of ["README.md", "INSTALL.md", "DATABASE.md", "examples/config/README.md"]) {
    const contents = await readFile(path.join(root, file), "utf8");
    if (/\bpixi\b/i.test(contents)) throw new Error(`${file} must not require the private Pixi workspace tooling`);
}

// The core pack lives in resources/ and the optional gamemodes in gamemodes/resources/. Both release
// on the pack's version; a gamemode may depend on the core, never the other way round.
async function resourceEntries(dir, kind) {
    // Git keeps no empty directories, so a checkout with no gamemodes has no gamemodes/resources at all.
    const found = await readdir(path.join(root, dir), { withFileTypes: true }).catch((error) => {
        if (kind === "gamemode" && error.code === "ENOENT") return [];
        throw error;
    });
    return found.filter((entry) => entry.isDirectory() && entry.name.startsWith("hmp-")).map((entry) => ({ name: entry.name, dir, kind }));
}
const entries = [...await resourceEntries("resources", "core"), ...await resourceEntries("gamemodes/resources", "gamemode")]
    .sort((a, b) => a.name.localeCompare(b.name));
const manifests = new Map();
const locations = new Map();
for (const entry of entries) {
    if (locations.has(entry.name)) throw new Error(`${entry.name} exists in both resources/ and gamemodes/resources/`);
    locations.set(entry.name, entry);
    const manifest = await json(`${entry.dir}/${entry.name}/package.json`);
    if (manifest.name !== entry.name) throw new Error(`${entry.name} manifest name is '${manifest.name}'`);
    if (manifest.version !== pack.version) throw new Error(`${entry.name} is ${manifest.version}; expected ${pack.version}`);
    if (!manifest.mafiahub) throw new Error(`${entry.name} has no mafiahub manifest`);
    const roles = manifest.mafiahub;
    if ("server" in roles || "client" in roles) {
        throw new Error(`${entry.name} must use serverScripts/clientScripts instead of legacy server/client entries`);
    }
    for (const field of ["serverScripts", "clientScripts", "sharedScripts", "files"]) {
        if (field in roles && (!Array.isArray(roles[field]) || roles[field].some((file) => typeof file !== "string" || !file.trim()))) {
            throw new Error(`${entry.name} mafiahub.${field} must be an array of non-empty paths`);
        }
    }
    if (!roles.serverScripts?.length && !hasClientScripts(manifest)) {
        throw new Error(`${entry.name} has no scripts`);
    }
    if (hasClientScripts(manifest) && !Array.isArray(roles.files)) {
        throw new Error(`${entry.name} must declare mafiahub.files to control client asset packaging`);
    }
    manifests.set(entry.name, manifest);
}
if (!manifests.size) throw new Error("No hmp-* resources found");

const dependencies = new Map();
for (const [name, manifest] of manifests) {
    const raw = manifest.mafiahub.resourceDependencies || [];
    if (!Array.isArray(raw)) throw new Error(`${name} resourceDependencies must be an array`);
    const normalized = raw.map((dependency) => {
        if (!dependency || typeof dependency !== "object" || Array.isArray(dependency)) {
            throw new Error(`${name} must declare first-party dependencies with a pinned version`);
        }
        if (dependency.version !== pack.version) {
            throw new Error(`${name} pins ${dependency.name} at '${dependency.version}', expected '${pack.version}'`);
        }
        if (!manifests.has(dependency.name)) throw new Error(`${name} depends on missing ${dependency.name}`);
        if (locations.get(name).kind === "core" && locations.get(dependency.name).kind === "gamemode") {
            throw new Error(`core resource ${name} must not depend on gamemode ${dependency.name}`);
        }
        const dependencyPriority = Number(manifests.get(dependency.name).mafiahub.priority || 0);
        const resourcePriority = Number(manifest.mafiahub.priority || 0);
        if (dependencyPriority >= resourcePriority) {
            throw new Error(`${name} priority ${resourcePriority} must be greater than dependency ${dependency.name} priority ${dependencyPriority}`);
        }
        return dependency.name;
    });
    if (hasClientScripts(manifest)) {
        for (const dependency of normalized) {
            if (!hasClientScripts(manifests.get(dependency))) {
                throw new Error(`${name} has a client entry but dependency ${dependency} does not; the shared Framework dependency graph would reject the client resource set`);
            }
        }
    }
    dependencies.set(name, normalized);
}

const visiting = new Set();
const visited = new Set();
function visit(name) {
    if (visiting.has(name)) throw new Error(`Dependency cycle includes ${name}`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of dependencies.get(name) || []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
}
for (const name of manifests.keys()) visit(name);

const lock = await json("package-lock.json");
for (const name of manifests.keys()) {
    const locked = lock.packages?.[`${locations.get(name).dir}/${name}`]?.version;
    if (locked !== pack.version) throw new Error(`${name} package-lock version is '${locked}', expected '${pack.version}'`);
}

const dockerfile = await readFile(path.join(root, "Dockerfile"), "utf8");
for (const name of manifests.keys()) {
    const dir = locations.get(name).dir;
    if (!dockerfile.includes(`COPY ${dir}/${name}/package.json ${dir}/${name}/package.json`)) {
        throw new Error(`Dockerfile does not stage ${name}/package.json before npm ci`);
    }
}

const mysqlExample = await json("examples/config/data/hmp-mysql.json");
if (!String(mysqlExample.password || "").includes("CHANGE_ME")) throw new Error("Example MySQL password must remain an obvious placeholder");
const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
if (!changelog.includes(`[${pack.version}]`)) throw new Error(`CHANGELOG.md has no ${pack.version} release entry`);

const gamemodes = entries.filter((entry) => entry.kind === "gamemode").length;
console.log(`Release metadata verified for ${manifests.size - gamemodes} resources and ${gamemodes} gamemode(s) at ${pack.version}`);
