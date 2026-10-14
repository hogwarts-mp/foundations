import { cp, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });
await build({
    entryPoints: ["server/main.ts"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: "dist/server.js",
    legalComments: "inline",
});
await build({
    entryPoints: ["client/main.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    outfile: "dist/client.js",
    legalComments: "inline",
});
for (const name of ["config.html", "hud.html"]) {
    await cp(`client/${name}`, `dist/${name}`);
}
