import assert = require("node:assert/strict");
import serviceModule = require("../server/service");
import type { HmpManagedTalent, HmpProgressionProfile, HmpProgressionRewardTransaction } from "../types";
import type { Player, ProgressionRepository, RewardDraft, TalentMutation } from "../server/internal";

const { createProgressionService } = serviceModule;
const playerEvents: Array<{ name: string; payload: string }> = [];
const player = { id: 7, nickname: "Kingsley", emitEvents: playerEvents, emit(name: string, payload: string) { playerEvents.push({ name, payload }); } } as unknown as Player & { emitEvents: Array<{ name: string; payload: string }> };
const character = { id: 42, accountId: 1, slot: 1, name: "Kingsley Chang" };
const profiles = new Map<number, HmpProgressionProfile>();
const rewards = new Map<string, HmpProgressionRewardTransaction>();
const managed = new Map<string, HmpManagedTalent>();
let rewardId = 0;
const freshProfile = (id: number): HmpProgressionProfile => ({ characterId: id, experiencePoints: 0, level: 1, talentPoints: 0, revision: 0, appliedRevision: 0, createdAt: "now", updatedAt: "now" });
const getProfile = (id: number) => { if (!profiles.has(id)) profiles.set(id, freshProfile(id)); return profiles.get(id)!; };

const repository: ProgressionRepository = {
    migrate: async () => ({}),
    profile: async (id) => ({ ...getProfile(id) }),
    reward: async (reference) => rewards.get(reference) || null,
    beginReward: async (draft: RewardDraft) => {
        const existing = rewards.get(draft.reference);
        if (existing) return { created: false, transaction: existing };
        const transaction: HmpProgressionRewardTransaction = {
            id: ++rewardId, reference: draft.reference, characterId: draft.characterId, operation: draft.operation, amount: draft.amount,
            balanceBefore: null, balanceAfter: null, actorCharacterId: draft.actorCharacterId, resource: draft.resource,
            reason: draft.reason, metadata: draft.metadata, status: "pending", error: "", createdAt: "now", completedAt: null,
        };
        rewards.set(draft.reference, transaction);
        return { created: true, transaction };
    },
    applyReward: async (reference, maximum) => {
        const transaction = rewards.get(reference)!;
        if (transaction.status === "completed") return transaction;
        const profile = getProfile(transaction.characterId);
        const next = transaction.operation === "set" ? transaction.amount : profile.experiencePoints + transaction.amount;
        if (next < 0 || next > maximum) throw new Error("experience out of range");
        transaction.balanceBefore = profile.experiencePoints; transaction.balanceAfter = next; transaction.status = "completed"; transaction.completedAt = "now";
        profile.experiencePoints = next; profile.revision++;
        return transaction;
    },
    failReward: async (reference, error) => { const transaction = rewards.get(reference)!; transaction.status = "failed"; transaction.error = error; return transaction; },
    rewardHistory: async (id) => [...rewards.values()].filter((entry) => entry.characterId === id),
    pendingRewards: async () => [...rewards.values()].filter((entry) => entry.status === "pending"),
    acknowledge: async (id, revision, level, talentPoints) => { const profile = getProfile(id); if (profile.revision === revision) { profile.level = level; profile.talentPoints = talentPoints; profile.appliedRevision = revision; } return { ...profile }; },
    talents: async (id, includeRevoked) => [...managed.values()].filter((entry) => entry.characterId === id && (includeRevoked || entry.status === "owned")),
    talent: async (id, talentId) => managed.get(`${id}:${talentId}`) || null,
    mutateTalent: async (mutation: TalentMutation) => {
        const key = `${mutation.characterId}:${mutation.talentId}`;
        const value: HmpManagedTalent = { ...mutation, createdAt: "now", updatedAt: "now" };
        managed.set(key, value); getProfile(mutation.characterId).revision++; return value;
    },
    purchaseTalent: async (mutation) => { const profile = getProfile(mutation.characterId); if (!profile.talentPoints) throw new Error("no points"); profile.talentPoints--; profile.revision++; const value = { ...mutation, status: "owned" as const, acquisition: "purchase" as const, createdAt: "now", updatedAt: "now" }; managed.set(`${mutation.characterId}:${mutation.talentId}`, value); return value; },
    resetTalents: async (id) => { let count = 0; for (const talent of managed.values()) if (talent.characterId === id && talent.status === "owned") { talent.status = "revoked"; count++; } if (count) getProfile(id).revision++; return count; },
    setTalentPoints: async (id, points) => { const profile = getProfile(id); if (profile.talentPoints !== points) { profile.talentPoints = points; profile.revision++; } return { ...profile }; },
};

const emitted: Array<{ name: string; args: unknown[] }> = [];
const warnings: string[] = [];
let online = true;
let rejectEmits = false;
const service = createProgressionService({
    repository,
    core: {
        characters: { active: (candidate: Player) => candidate === player ? character as never : null },
        sessions: { all: () => (online ? [{ player, character }] : []) as never },
    } as never,
    events: {
        emit: (name, ...args) => {
            emitted.push({ name, args });
            return rejectEmits ? Promise.reject(new AggregateError([new Error("Entity handle '7' is not valid!")], "One or more event handlers failed")) : undefined;
        },
    },
    logger: { info() {}, warn(message: string) { warnings.push(message); }, error() {} } as never,
    config: { enableCommands: true, command: "progression", adminGroups: [], maximumExperience: 1000, maximumTalentPoints: 10, nativeRequestTimeoutMs: 1000 },
    migrations: [],
});

async function run(): Promise<void> {
    await service.start();
    const options = { reference: "quest:first", resource: "hmp-activities", reason: "quest reward" };
    const first = await service.progression.add(player, 100, options);
    assert.equal(first.balanceAfter, 100);
    assert.equal((await service.progression.add(player, 100, options)).id, first.id, "same reference replays safely");
    await assert.rejects(service.progression.add(player, 50, options), /reused for a different operation/);
    const sync = JSON.parse(player.emitEvents.at(-1)!.payload);
    assert.equal(sync.experiencePoints, 100);
    assert.equal(sync.preserveTalentPoints, false);

    await service.nativeReport(player, { characterId: 42, revision: 1, experiencePoints: 999, level: 40, talentPoints: 10 });
    assert.equal((await service.progression.get(player)).appliedRevision, 0, "a mismatched native balance cannot acknowledge the revision");
    await service.nativeReport(player, { characterId: 42, revision: 1, experiencePoints: 100, level: 3, talentPoints: 2 });
    assert.deepEqual(await service.progression.get(player), { ...getProfile(42) });
    assert.equal((await service.progression.get(player)).level, 3);

    // A player who disconnects while the report awaits the database is not handed to listeners.
    const acknowledge = repository.acknowledge;
    repository.acknowledge = async (...args: Parameters<typeof acknowledge>) => { online = false; return acknowledge(...args); };
    const before = emitted.length;
    await service.nativeReport(player, { characterId: 42, revision: 1, experiencePoints: 100, level: 3, talentPoints: 2 });
    assert.equal(emitted.slice(before).some((entry) => entry.name === "hmp:progression:synchronized"), false);
    repository.acknowledge = acknowledge;
    online = true;

    // A listener that throws is logged here, not left as an unhandled rejection charged to this resource.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    rejectEmits = true;
    await service.nativeReport(player, { characterId: 42, revision: 1, experiencePoints: 100, level: 3, talentPoints: 2 });
    await new Promise((resolve) => setImmediate(resolve));
    rejectEmits = false;
    process.off("unhandledRejection", onUnhandled);
    assert.deepEqual(unhandled, []);
    assert.ok(warnings.some((message) => message.includes("hmp:progression:synchronized") && message.includes("Entity handle '7' is not valid!")));

    const talent = await service.talents.grant(player, "Talent_Spell_Accio", 2, { resource: "test" });
    assert.equal(talent.level, 2);
    assert.equal((await service.talents.list(player)).length, 1);
    await service.talents.revoke(player, talent.talentId, { resource: "test" });
    assert.equal((await service.talents.list(player)).length, 0);
    assert.equal((await service.talents.list(player, true))[0].status, "revoked");

    const set = await service.progression.set(42, 250, { reference: "admin:set", resource: "test" });
    assert.equal(set.balanceAfter, 250);
    assert.ok(emitted.some((entry) => entry.name === "hmp:progression:changed"));
    await service.stop();
    assert.equal(service.status().state, "stopped");
    console.log("hmp-progression service tests passed");
}

void run();
