import { timingSafeEqual } from "node:crypto";
import type { HmpAdminCapability } from "../types";
import type { AdminConfig, AdminPermissions, Core, Player } from "./internal";

const CAPABILITIES: HmpAdminCapability[] = [
    "admin.view", "admin.kick", "admin.teleport", "admin.freeze", "admin.warn", "admin.ban",
    "admin.groups", "admin.jobs", "admin.inventory", "admin.appearance", "admin.spells", "admin.banking", "admin.treasury", "admin.reconcile", "admin.audit",
    "admin.environment", "admin.noclip",
];

function createPermissions(options: { core: Core; config: AdminConfig }): AdminPermissions {
    const { core, config } = options;
    const bootstrapped = new Set<number>();

    function sameSecret(left: string, right: string): boolean {
        const expected = Buffer.from(right, "utf8");
        const supplied = Buffer.from(left, "utf8");
        return expected.length > 0 && expected.length === supplied.length && timingSafeEqual(expected, supplied);
    }

    async function granted(player: Player): Promise<Set<HmpAdminCapability>> {
        if (!player || !core.sessions.get(player)) return new Set();
        if (bootstrapped.has(player.id)) return new Set(CAPABILITIES);
        const session = core.sessions.get(player);
        if (!session || (config.requireVerifiedIdentity && session.principal.trust !== "verified")) return new Set();
        const groups = await core.groups.effective(player);
        const capabilities = new Set<HmpAdminCapability>();
        for (const rule of config.roleRules) {
            const group = groups.find((entry) => entry.key === String(rule.group).trim().toLowerCase() && entry.grade >= Math.max(0, Number(rule.minimumGrade) || 0));
            if (!group) continue;
            for (const capability of rule.capabilities || []) {
                if (capability === "*") for (const name of CAPABILITIES) capabilities.add(name);
                else capabilities.add(capability);
            }
        }
        return capabilities;
    }

    async function has(player: Player, capability: HmpAdminCapability): Promise<boolean> {
        return (await granted(player)).has(capability);
    }

    async function requireCapability(player: Player, capability: HmpAdminCapability): Promise<true> {
        if (await has(player, capability)) return true;
        throw Object.assign(new Error("You do not have permission to perform that administrative action."), { code: "HMP_ADMIN_FORBIDDEN", capability });
    }

    async function authenticate(player: Player, secret: string): Promise<boolean> {
        if (!config.bootstrapSecret || !sameSecret(String(secret || ""), config.bootstrapSecret)) return false;
        if (!core.sessions.get(player)) return false;
        bootstrapped.add(player.id);
        return true;
    }

    return Object.freeze({
        has,
        require: requireCapability,
        capabilities: async (player: Player) => [...await granted(player)].sort(),
        authenticate,
        revoke: (player: Player) => Boolean(player) && bootstrapped.delete(player.id),
        isBootstrapped: (player: Player) => Boolean(player && bootstrapped.has(player.id)),
        status: () => ({ bootstrapEnabled: Boolean(config.bootstrapSecret), bootstrapSessions: bootstrapped.size }),
    });
}

export = { createPermissions, CAPABILITIES };
