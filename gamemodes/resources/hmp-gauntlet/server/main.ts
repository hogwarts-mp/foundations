import type { HmpActivities, HmpActivitySession } from "../../../../resources/hmp-activities/types";
import type { HmpCore } from "../../../../resources/hmp-core/types";
import type { HmpInteractServer } from "../../../../resources/hmp-interact/types";
import type { HmpLibServer } from "../../../../resources/hmp-lib/types";
import type { HmpNpcs } from "../../../../resources/hmp-npcs/types";
import type { HmpWorldStateServer } from "../../../../resources/hmp-worldstate/types";
import type {
    ConfigureModel,
    EnemyMenuEntry,
    GauntletPlayer,
    HudState,
    ResolvedRunConfig,
    Vector3Like,
} from "../shared/types";
import type { HmpGauntletBucket, HmpGauntletCompletion } from "../types";
import { normalizeConfig } from "./config";

const RESOURCE = "hmp-gauntlet";
const ACTIVITY_ID = "hmp-gauntlet:survival";
const Hmp = Imports.get<HmpLibServer<GauntletPlayer>>("hmp-lib");
const Core = Imports.get<HmpCore<GauntletPlayer>>("hmp-core");
const Activities = Imports.get<HmpActivities<GauntletPlayer>>("hmp-activities");
const Interact = Imports.get<HmpInteractServer<GauntletPlayer>>("hmp-interact");
const Npcs = Imports.get<HmpNpcs>("hmp-npcs");
const WorldState = Imports.get<HmpWorldStateServer<GauntletPlayer>>("hmp-worldstate");
const logger = Hmp.logger.create(RESOURCE);
const router = Hmp.command.createRouter({ prefix: "[GAUNTLET]", logger });
const rawConfig = Hmp.config.load<Record<string, unknown>>(process.env.HMP_GAUNTLET_CONFIG || "data/hmp-gauntlet.json", { defaults: {} });
const CONFIG = normalizeConfig(rawConfig);

const catalog = Object.fromEntries(Npcs.catalog.list().map((entry) => [entry.id, entry]));
const hidden = new Set(CONFIG.hidden);
const bosses = CONFIG.bosses.filter((boss) => catalog[boss.id]);
const bossIds = new Set(bosses.map((boss) => boss.id));
const fodderIds = Object.keys(catalog).filter((id) => !hidden.has(id) && !bossIds.has(id));

type Bucket = HmpGauntletBucket;
type RunPhase = "forming" | "running";

interface SpawnSpec {
    id: string;
    boss: boolean;
    baseHp?: number;
}

interface RunState {
    host: GauntletPlayer;
    state: RunPhase;
    activitySessionId: string;
    center: Vector3Like;
    cfg: ResolvedRunConfig;
    participants: number[];
    wave: number;
    score: number;
    active: Set<number>;
    all: Set<number>;
    pending: SpawnSpec[];
    remaining: number;
    ownerCursor: number;
    spawnIdx: number;
    down: Set<number>;
    interTimer: ReturnType<typeof setTimeout> | null;
    bucket: Bucket;
    ranked: boolean;
}

interface ScoreRecord {
    score: number;
    wave: number;
    name: string;
    count: number;
    won: boolean;
}

type CharacterBests = Record<string, { score: number; wave: number }>;

// Server records live in hmp-worldstate (MySQL-backed).
// Server-only: broadcast off, since no client reads the board.
const BOARD = "gauntlet-board";
const releaseBoard = WorldState.systems.register(BOARD, { maxEntries: 200, broadcast: false });
const BUCKETS: Record<Bucket, string> = { solo: "Solo", duo: "Duo", party: "4 Party", free: "Free" };
let run: RunState | null = null;
let creating = false;

function asRecord(value: unknown): Record<string, unknown> {
    if (typeof value === "string") {
        try { return asRecord(JSON.parse(value)); }
        catch { return {}; }
    }
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function players(): GauntletPlayer[] {
    return PlayerManager.getAll() as GauntletPlayer[];
}

function connectedParticipantsFor(state: RunState): GauntletPlayer[] {
    const connected = new Map(players().map((player) => [player.id, player]));
    return state.participants.flatMap((id) => {
        const player = connected.get(id);
        return player ? [player] : [];
    });
}

function connectedParticipants(): GauntletPlayer[] {
    return run ? connectedParticipantsFor(run) : [];
}

function groupOf(id: string): string {
    for (const [prefix, label] of CONFIG.groups) if (id.startsWith(prefix)) return label;
    return "Other";
}

function enemyMenu(): EnemyMenuEntry[] {
    return fodderIds.map((id) => ({ id, label: catalog[id]?.label || id, group: groupOf(id) }));
}

function pick<T>(values: readonly T[]): T | undefined {
    return values.length ? values[Math.floor(Math.random() * values.length)] : undefined;
}

function broadcast(message: string): void {
    Chat.sendToAll(message);
}

function bucketOf(count: number): Bucket {
    return count <= 1 ? "solo" : count === 2 ? "duo" : count <= 4 ? "party" : "free";
}

function isStandardConfig(cfg: ResolvedRunConfig): boolean {
    const preset = CONFIG.presets[cfg.preset];
    if (!preset) return false;
    if (cfg.waves !== preset.waves || cfg.baseSpawns !== preset.baseSpawns
        || cfg.spawnGrowth !== preset.spawnGrowth || cfg.bossEvery !== preset.bossEvery) return false;
    if (cfg.pool.length !== fodderIds.length) return false;
    const selected = new Set(cfg.pool);
    return fodderIds.every((id) => selected.has(id));
}

function resolveConfig(value: unknown): ResolvedRunConfig {
    const raw = asRecord(value);
    const requestedPreset = typeof raw.preset === "string" && CONFIG.presets[raw.preset]
        ? raw.preset
        : CONFIG.defaultPreset;
    const preset = CONFIG.presets[requestedPreset];
    const clamp = (candidate: unknown, minimum: number, maximum: number, fallback: number): number => {
        const parsed = Number(candidate);
        return Number.isFinite(parsed)
            ? Math.max(minimum, Math.min(maximum, Math.round(parsed)))
            : fallback;
    };
    let pool = Array.isArray(raw.pool)
        ? raw.pool.filter((id): id is string => typeof id === "string" && fodderIds.includes(id))
        : [];
    if (!pool.length) pool = [...fodderIds];
    return {
        preset: requestedPreset,
        waves: raw.waves !== undefined ? clamp(raw.waves, 0, 50, preset.waves) : preset.waves,
        baseSpawns: raw.baseSpawns !== undefined ? clamp(raw.baseSpawns, 1, 20, preset.baseSpawns) : preset.baseSpawns,
        spawnGrowth: raw.spawnGrowth !== undefined ? clamp(raw.spawnGrowth, 0, 10, preset.spawnGrowth) : preset.spawnGrowth,
        bossEvery: raw.bossEvery !== undefined ? clamp(raw.bossEvery, 0, 20, preset.bossEvery) : preset.bossEvery,
        hpGrowth: preset.hpGrowth,
        scaleStep: preset.scaleStep,
        scaleMax: preset.scaleMax,
        maxAlive: Math.max(1, Math.round(preset.maxAlive)),
        intermission: Math.max(1, Math.round(preset.intermission || CONFIG.arena.intermissionDefault)),
        scaleFodder: CONFIG.players.scaleFodder,
        perPlayerBonus: Math.max(0, CONFIG.players.perPlayerBonus),
        pool,
    };
}

Activities.definitions.register({
    id: ACTIVITY_ID,
    resource: RESOURCE,
    label: "The Gauntlet",
    description: "A cooperative escalating wave challenge",
    minimumPlayers: 1,
    maximumPlayers: Math.max(1, Math.round(CONFIG.players.maxPlayers)),
    requireReady: false,
    requiresCharacter: true,
    exclusive: true,
    disconnectPolicy: "remove",
    defaultVisibility: "public",
    scope: "areaAndVirtualWorld",
    lobbyTtlSeconds: Math.max(60, Math.round(CONFIG.players.lobbyTtlSeconds)),
});

function nextOwner(): number | undefined {
    if (!run) return undefined;
    const participants = connectedParticipants();
    if (!participants.length) return undefined;
    const owner = participants[run.ownerCursor % participants.length];
    run.ownerCursor += 1;
    return owner.id;
}

function ringPosition(center: Vector3Like, index: number, count: number): Vector3Like {
    const radius = CONFIG.arena.ringRadius + (Math.random() * 2 - 1) * CONFIG.arena.ringJitter;
    const angle = (index / Math.max(1, count)) * Math.PI * 2 + Math.random() * 0.35;
    return {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
        z: center.z,
    };
}

function fodderCount(cfg: ResolvedRunConfig, wave: number): number {
    const base = cfg.baseSpawns + cfg.spawnGrowth * (wave - 1);
    const headcount = connectedParticipants().length || 1;
    const factor = cfg.scaleFodder ? 1 + cfg.perPlayerBonus * (headcount - 1) : 1;
    return Math.max(1, Math.round(base * factor));
}

async function startRun(host: GauntletPlayer, rawConfigValue: unknown): Promise<void> {
    if (run) { host.sendChat("[GAUNTLET] a run is already active — /gauntlet stop first"); return; }
    if (creating) { host.sendChat("[GAUNTLET] another lobby is being created"); return; }
    if (!fodderIds.length) { host.sendChat("[GAUNTLET] no spawnable enemies (is hmp-npcs present?)"); return; }
    const cfg = resolveConfig(rawConfigValue);
    creating = true;
    try {
        const activity = await Activities.sessions.create(host, ACTIVITY_ID, {
            title: `${cfg.preset} Gauntlet`,
            metadata: { preset: cfg.preset, waves: cfg.waves },
        });
        if (run) {
            await Activities.sessions.cancel(activity.id, { resource: RESOURCE, reason: "another lobby completed creation first" });
            host.sendChat("[GAUNTLET] a run is already active");
            return;
        }
        run = {
            host,
            state: "forming",
            activitySessionId: activity.id,
            center: { x: host.position.x, y: host.position.y, z: host.position.z },
            cfg,
            participants: activity.participants.map((entry) => entry.playerId),
            wave: 0,
            score: 0,
            active: new Set(),
            all: new Set(),
            pending: [],
            remaining: 0,
            ownerCursor: 0,
            spawnIdx: 0,
            down: new Set(),
            interTimer: null,
            bucket: "solo",
            ranked: isStandardConfig(cfg),
        };
        broadcast(`⚔ ${host.nickname} opened a ${cfg.preset} Gauntlet lobby — /gauntlet join, then the host uses /gauntlet begin.`);
    } finally {
        creating = false;
    }
}

async function beginRun(host: GauntletPlayer): Promise<void> {
    if (!run || run.state !== "forming") { host.sendChat("[GAUNTLET] no forming lobby"); return; }
    if (run.host.id !== host.id) { host.sendChat("[GAUNTLET] only the host can begin"); return; }
    const activity = await Activities.sessions.start(run.activitySessionId, { resource: RESOURCE, actor: host });
    run.state = "running";
    run.participants = activity.participants.map((entry) => entry.playerId);
    run.bucket = bucketOf(run.participants.length);
    const tag = run.ranked ? `ranked · ${BUCKETS[run.bucket]}` : "custom (unranked)";
    broadcast(`⚔ THE GAUNTLET BEGINS — ${run.cfg.waves === 0 ? "endless" : `${run.cfg.waves} waves`} · ${run.cfg.preset} · ${run.participants.length} fighter(s) · ${tag}`);
    pushHud();
    nextWave();
}

async function joinRun(player: GauntletPlayer): Promise<void> {
    if (!run || run.state !== "forming") { player.sendChat("[GAUNTLET] no lobby is accepting fighters"); return; }
    const activity = await Activities.sessions.join(player, run.activitySessionId);
    run.participants = activity.participants.map((entry) => entry.playerId);
    broadcast(`⚔ ${Core.characters.active(player)?.name || player.nickname} joined the Gauntlet (${run.participants.length}).`);
}

function nextWave(): void {
    if (!run || run.state !== "running") return;
    run.wave += 1;
    if (run.cfg.waves > 0 && run.wave > run.cfg.waves) { endRun(true); return; }
    if (!connectedParticipants().length) { endRun(false); return; }

    const bossWave = run.cfg.bossEvery > 0 && run.wave % run.cfg.bossEvery === 0 && bosses.length > 0;
    const count = fodderCount(run.cfg, run.wave);
    run.pending = [];
    if (bossWave) {
        const boss = pick(bosses);
        if (boss) run.pending.push({ id: boss.id, boss: true, baseHp: boss.baseHp });
    }
    for (let index = 0; index < count; index += 1) {
        const id = pick(run.cfg.pool);
        if (id) run.pending.push({ id, boss: false });
    }
    run.remaining = run.pending.length;
    run.spawnIdx = 0;
    broadcast(waveBanner(run.wave, run.pending, bossWave));
    pushHud();
    pumpSpawns();
}

function pumpSpawns(): void {
    if (!run) return;
    while (run.pending.length && run.active.size < run.cfg.maxAlive) {
        const spec = run.pending.shift();
        if (spec && !spawnOne(spec)) run.remaining -= 1;
    }
    if (run.remaining <= 0 && !run.pending.length && !run.active.size) intermission();
}

function spawnOne(spec: SpawnSpec): boolean {
    if (!run) return false;
    const position = ringPosition(run.center, run.spawnIdx++, 8);
    const growth = Math.pow(run.cfg.hpGrowth, run.wave - 1);
    const baseHp = spec.boss ? spec.baseHp || 2000 : CONFIG.arena.baseEnemyHp;
    const scale = spec.boss
        ? Math.min(1.4 + run.cfg.scaleStep * (run.wave - 1), run.cfg.scaleMax + 0.6)
        : Math.min(1 + run.cfg.scaleStep * (run.wave - 1), run.cfg.scaleMax);
    try {
        const npc = Npcs.spawn({
            resource: RESOURCE,
            enemyId: spec.id,
            position,
            disposition: "hostile",
            ownerId: nextOwner(),
            maxHealth: Math.round(baseHp * growth),
            scale,
        });
        run.active.add(npc.id);
        run.all.add(npc.id);
        return true;
    } catch (error) {
        logger.warn(`Could not spawn ${spec.id}: ${errorMessage(error)}`);
        return false;
    }
}

function intermission(): void {
    if (!run) return;
    if (run.cfg.waves > 0 && run.wave >= run.cfg.waves) { endRun(true); return; }
    broadcast(`✅ Wave ${run.wave} cleared! Score ${run.score}. Next wave in ${run.cfg.intermission}s…`);
    pushHud();
    run.interTimer = setTimeout(() => {
        if (!run) return;
        run.interTimer = null;
        nextWave();
    }, run.cfg.intermission * 1000);
}

function destroyEnemies(state: RunState): void {
    for (const id of state.all) Npcs.destroy(id, RESOURCE);
}

function abandonRun(state: RunState): void {
    if (state.interTimer !== null) clearTimeout(state.interTimer);
    destroyEnemies(state);
    pushHudTo(state.participants, { active: false });
}

// Announces a finished run to other resources as hmp-gauntlet:complete (types.d.ts).
// Resolves names while the players are still connected -- after this the run state is gone.
function emitCompletion(finished: RunState, won: boolean, cancelled: boolean): void {
    try {
        const roster = connectedParticipantsFor(finished).map((player) => ({
            playerId: player.id,
            nickname: player.nickname,
            character: Core.characters.active(player)?.name || null,
        }));
        const completion: HmpGauntletCompletion = {
            won,
            cancelled,
            wave: finished.wave,
            waves: finished.cfg.waves,
            endless: finished.cfg.waves === 0,
            score: finished.score,
            preset: finished.cfg.preset,
            bucket: finished.bucket,
            ranked: finished.ranked,
            host: finished.host?.nickname ?? null,
            participants: roster,
            participantCount: finished.participants.length,
            activitySessionId: finished.activitySessionId,
            finishedAt: new Date().toISOString(),
        };
        Events.emit(`${RESOURCE}:complete`, completion);
    } catch (error) {
        logger.warn(`Could not emit completion: ${errorMessage(error)}`);
    }
}

function endRun(won: boolean, cancelled = false): void {
    if (!run) return;
    const finished = run;
    run = null;
    abandonRun(finished);
    broadcast(won
        ? `🏆 GAUNTLET CLEARED! Final score ${finished.score} across ${finished.wave} wave(s).`
        : `💀 GAUNTLET OVER at wave ${finished.wave}. Final score ${finished.score}.`);
    if (!cancelled) void recordScore(finished, won);
    emitCompletion(finished, won, cancelled);
    const terminal = cancelled || finished.state === "forming"
        ? Activities.sessions.cancel(finished.activitySessionId, { resource: RESOURCE, reason: cancelled ? "run stopped" : "lobby closed" })
        : Activities.sessions.complete(
            finished.activitySessionId,
            { won, score: finished.score, wave: finished.wave },
            { resource: RESOURCE, reason: won ? "cleared" : "party defeated" },
        );
    void terminal.catch((error) => logger.warn(`Foundation activity close failed: ${errorMessage(error)}`));
}

function boardKey(preset: string, bucket: Bucket): string {
    return `${preset}:${bucket}`;
}

function parseScoreRecord(value: string | null): ScoreRecord | null {
    if (!value) return null;
    try {
        const parsed = asRecord(JSON.parse(value));
        const score = Number(parsed.score);
        const wave = Number(parsed.wave);
        return Number.isFinite(score) && Number.isFinite(wave)
            ? {
                score,
                wave,
                name: typeof parsed.name === "string" ? parsed.name : "?",
                count: Number(parsed.count) || 0,
                won: parsed.won === true,
            }
            : null;
    } catch {
        return null;
    }
}

async function recordScore(state: RunState, won: boolean): Promise<void> {
    if (!state.ranked) return;
    const key = boardKey(state.cfg.preset, state.bucket);
    const previous = parseScoreRecord(WorldState.state.get(BOARD, key));
    if (!previous || state.score > previous.score) {
        const next: ScoreRecord = {
            score: state.score,
            wave: state.wave,
            // Worldstate values cap at 256 chars; bound the one free-text field.
            name: (state.host.nickname || "?").slice(0, 48),
            count: state.participants.length,
            won,
        };
        try {
            await WorldState.state.set(BOARD, key, JSON.stringify(next));
            broadcast(`🥇 New ${state.cfg.preset} · ${BUCKETS[state.bucket]} record: ${state.score} pts (wave ${state.wave}) by ${next.name}!`);
        } catch (error) {
            logger.warn(`Could not save the ${key} record: ${errorMessage(error)}`);
        }
    }

    for (const player of connectedParticipantsFor(state)) {
        const character = Core.characters.active(player);
        if (!character) continue;
        try {
            const bests = await Core.metadata.getCharacter<CharacterBests>(character.id, `${RESOURCE}:bests`) || {};
            const keyName = `${state.cfg.preset}:${state.bucket}`;
            if (!bests[keyName] || state.score > bests[keyName].score) {
                bests[keyName] = { score: state.score, wave: state.wave };
                await Core.metadata.setCharacter(character.id, `${RESOURCE}:bests`, bests);
            }
        } catch (error) {
            logger.warn(`Could not record ${character.name}'s Gauntlet best: ${errorMessage(error)}`);
        }
    }
}

function hudModel(): HudState {
    return run
        ? { active: true, wave: run.wave, waves: run.cfg.waves, enemies: run.remaining, score: run.score }
        : { active: false };
}

function pushHudTo(ids: readonly number[], model: HudState): void {
    const payload = JSON.stringify(model);
    for (const id of ids) {
        const player = PlayerManager.getById(id) as GauntletPlayer | null;
        player?.emit(`${RESOURCE}:hud`, payload);
    }
}

function pushHud(): void {
    if (run) pushHudTo(run.participants, hudModel());
}

function waveBanner(wave: number, specs: readonly SpawnSpec[], bossWave: boolean): string {
    const counts: Record<string, number> = {};
    for (const spec of specs) {
        const label = catalog[spec.id]?.label || spec.id;
        counts[label] = (counts[label] || 0) + 1;
    }
    const composition = Object.entries(counts)
        .map(([label, count]) => count > 1 ? `${count}× ${label}` : label)
        .join(", ");
    return `${bossWave ? "☠ BOSS WAVE" : "⚔ WAVE"} ${wave} · ${specs.length} enemies — ${composition}`;
}

Events.on("npcDied", (npcId: number) => {
    if (!run || !run.active.has(npcId)) return;
    run.active.delete(npcId);
    run.score += 1;
    run.remaining -= 1;
    pushHud();
    pumpSpawns();
});

function markDown(player: GauntletPlayer): void {
    if (!run || !run.participants.includes(player.id)) return;
    run.down.add(player.id);
    if (!connectedParticipants().some((participant) => !run!.down.has(participant.id))) {
        broadcast("💀 All fighters have fallen!");
        endRun(false);
    }
}

Events.on("playerDied", markDown);
Events.on("playerDowned", markDown);
Events.on("playerDownedEnd", (player: GauntletPlayer) => { run?.down.delete(player.id); });

function openMenu(player: GauntletPlayer): void {
    const model: ConfigureModel = {
        presets: Object.keys(CONFIG.presets),
        presetParams: CONFIG.presets,
        defaultPreset: CONFIG.defaultPreset,
        enemies: enemyMenu(),
        running: Boolean(run),
    };
    player.emit(`${RESOURCE}:configure`, JSON.stringify(model));
}

Events.onClient(`${RESOURCE}:start`, (player: HogwartsMpPlayer, data: unknown) => {
    void startRun(player as GauntletPlayer, data).catch((error) => {
        (player as GauntletPlayer).sendChat(`[GAUNTLET] ${errorMessage(error)}`);
    });
});

function showLeaderboard(player: GauntletPlayer, presetArgument?: string): void {
    const preset = (presetArgument || CONFIG.defaultPreset).toLowerCase();
    if (!CONFIG.presets[preset]) {
        player.sendChat(`[GAUNTLET] unknown preset '${preset}' — ${Object.keys(CONFIG.presets).join(", ")}`);
        return;
    }
    player.sendChat(`[GAUNTLET] ${preset} leaderboards (party size):`);
    for (const bucket of Object.keys(BUCKETS) as Bucket[]) {
        const score = parseScoreRecord(WorldState.state.get(BOARD, boardKey(preset, bucket)));
        player.sendChat(`  ${BUCKETS[bucket].padEnd(7)} — ${score ? `${score.score} pts (wave ${score.wave}) by ${score.name}` : "—"}`);
    }
}

router.register("gauntlet", async ({ player, args }) => {
    const verb = (args[0] || "").toLowerCase();
    if (verb === "top") { showLeaderboard(player, args[1]); return; }
    if (verb === "menu" || !verb) { openMenu(player); return; }
    if (verb === "start") { await startRun(player, {}); return; }
    if (verb === "join") { await joinRun(player); return; }
    if (verb === "begin") { await beginRun(player); return; }
    if (verb === "stop") { if (run) endRun(false, true); else player.sendChat("[GAUNTLET] no run active"); return; }
    if (verb === "status") {
        if (!run) { player.sendChat("[GAUNTLET] idle"); return; }
        player.sendChat(`[GAUNTLET] ${run.state} · wave ${run.wave}${run.cfg.waves ? `/${run.cfg.waves}` : ""} · ${run.active.size} alive · ${run.remaining} left · score ${run.score} · ${run.ranked ? `ranked ${BUCKETS[run.bucket]}` : "custom"}`);
        return;
    }
    player.sendChat("Usage: /gauntlet menu | start | join | begin | stop | status | top [preset]");
});

Events.on("chatCommand", (player: HogwartsMpPlayer, message: string, command: string, args: string[]) => {
    void router.handle(player as GauntletPlayer, message, command, args);
});

function syncActivity({ session }: { session: HmpActivitySession }): void {
    if (!run || session.id !== run.activitySessionId) return;
    run.participants = session.participants.map((entry) => entry.playerId);
    const leader = players().find((player) => player.id === session.leaderPlayerId);
    if (leader) run.host = leader;
    if (run.state === "running" && !run.participants.length) endRun(false);
}

Events.on("hmp:activities:joined", syncActivity);
Events.on("hmp:activities:left", syncActivity);
Events.on("hmp:activities:updated", syncActivity);
Events.on("hmp:activities:cancelled", ({ session }: { session: HmpActivitySession }) => {
    if (!run || session.id !== run.activitySessionId) return;
    const abandoned = run;
    run = null;
    abandonRun(abandoned);
});

const altar = CONFIG.interaction;
if (altar.enabled) {
    Interact.register({
        id: `${RESOURCE}:altar`,
        resource: RESOURCE,
        label: altar.label,
        position: altar.position,
        radius: altar.radius,
        promptDistance: altar.promptDistance,
        promptOffsetZ: altar.promptOffsetZ,
        areaId: altar.areaId || undefined,
        regionId: altar.regionId || undefined,
        requirements: { character: true },
        object: altar.object,
        handler: ({ player }) => openMenu(player),
    });
}

Events.on("resourceStop", (name?: string) => {
    if (name && name !== RESOURCE) return;
    releaseBoard();
    if (run) {
        const abandoned = run;
        run = null;
        abandonRun(abandoned);
    }
});

logger.info(`ready — ${fodderIds.length} fodder type(s), ${bosses.length} boss(es)`);
