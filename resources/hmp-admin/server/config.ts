import type { HmpLibServer } from "../../hmp-lib/types";
import type { AdminConfig, Player } from "./internal";

function loadConfig(Hmp: HmpLibServer<Player>, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): AdminConfig {
    const env = options.env || process.env;
    const defaults: AdminConfig = {
        command: "admin",
        requireVerifiedIdentity: true,
        allowUnsafeAssertedBans: false,
        teleportTimeoutMs: 120000,
        auditPageSize: 50,
        bootstrapSecret: "",
        noclip: {
            speed: 4500,
            boost: 3,
            tickMs: 11,
            movement: { forward: "w", back: "s", left: "a", right: "d", up: "space", down: "ctrl", boost: "shift" },
        },
        roleRules: [
            { group: "admin", minimumGrade: 1, capabilities: ["admin.view", "admin.kick", "admin.teleport", "admin.freeze", "admin.warn", "admin.announce", "admin.noclip"] },
            { group: "admin", minimumGrade: 2, capabilities: ["admin.groups", "admin.jobs", "admin.inventory", "admin.appearance", "admin.spells", "admin.banking", "admin.audit", "admin.environment"] },
            { group: "admin", minimumGrade: 3, capabilities: ["admin.ban", "admin.reconcile"] },
        ],
    };
    const config = Hmp.config.load<AdminConfig>(env.HMP_ADMIN_CONFIG || "data/hmp-admin.json", { cwd: options.cwd || process.cwd(), defaults });
    config.command = String(env.HMP_ADMIN_COMMAND || config.command || "admin").trim().toLowerCase();
    config.requireVerifiedIdentity = env.HMP_ADMIN_REQUIRE_VERIFIED === undefined ? config.requireVerifiedIdentity !== false : Hmp.config.env.boolean(env.HMP_ADMIN_REQUIRE_VERIFIED, true);
    config.allowUnsafeAssertedBans = env.HMP_ADMIN_UNSAFE_ASSERTED_BANS === undefined ? config.allowUnsafeAssertedBans === true : Hmp.config.env.boolean(env.HMP_ADMIN_UNSAFE_ASSERTED_BANS, false);
    config.bootstrapSecret = String(env.HMP_ADMIN_BOOTSTRAP_SECRET || "");
    if (config.bootstrapSecret && Buffer.byteLength(config.bootstrapSecret, "utf8") < 16) {
        throw new TypeError("HMP_ADMIN_BOOTSTRAP_SECRET must contain at least 16 bytes");
    }
    config.teleportTimeoutMs = Math.max(5000, Math.min(300000, Math.trunc(Number(config.teleportTimeoutMs)) || 120000));
    config.auditPageSize = Math.max(10, Math.min(200, Math.trunc(Number(config.auditPageSize)) || 50));
    const noclip = config.noclip && typeof config.noclip === "object" ? config.noclip : defaults.noclip;
    const movement = noclip.movement && typeof noclip.movement === "object" ? noclip.movement : defaults.noclip.movement;
    config.noclip = {
        speed: Math.max(100, Math.min(50000, Number(noclip.speed) || defaults.noclip.speed)),
        boost: Math.max(1, Math.min(10, Number(noclip.boost) || defaults.noclip.boost)),
        tickMs: Math.max(5, Math.min(100, Math.trunc(Number(noclip.tickMs)) || defaults.noclip.tickMs)),
        movement: {
            forward: String(movement.forward || defaults.noclip.movement.forward),
            back: String(movement.back || defaults.noclip.movement.back),
            left: String(movement.left || defaults.noclip.movement.left),
            right: String(movement.right || defaults.noclip.movement.right),
            up: String(movement.up || defaults.noclip.movement.up),
            down: String(movement.down || defaults.noclip.movement.down),
            boost: String(movement.boost || defaults.noclip.movement.boost),
        },
    };
    if (!Array.isArray(config.roleRules)) throw new TypeError("hmp-admin roleRules must be an array");
    return config;
}

export = { loadConfig };
