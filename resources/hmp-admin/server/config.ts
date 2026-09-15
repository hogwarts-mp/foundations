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
        roleRules: [
            { group: "admin", minimumGrade: 1, capabilities: ["admin.view", "admin.kick", "admin.teleport", "admin.freeze", "admin.warn", "admin.announce"] },
            { group: "admin", minimumGrade: 2, capabilities: ["admin.groups", "admin.jobs", "admin.inventory", "admin.spells", "admin.banking", "admin.audit", "admin.environment"] },
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
    if (!Array.isArray(config.roleRules)) throw new TypeError("hmp-admin roleRules must be an array");
    return config;
}

export = { loadConfig };
