import { cp, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist", { recursive: true });
await build({
    entryPoints: ["server/main.js"],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outfile: "dist/server.js",
    legalComments: "inline",
});
await build({
    entryPoints: ["client/main.js"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    outfile: "dist/client.js",
    legalComments: "inline",
});
for (const name of ["banner.html", "scoreboard.html", "results.html", "lobby.html"]) {
    await cp(`client/${name}`, `dist/${name}`);
}
