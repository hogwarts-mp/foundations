import normalizeModule = require("../shared/normalize");
import type { HmpBankPermission } from "../../hmp-banking/types";
import type {
    HmpDutyState,
    HmpEmployment,
    HmpJobDefinition,
    HmpJobMutationOptions,
    HmpJobPayrollOptions,
    HmpJobPayrollResult,
} from "../types";
import type { EmploymentMutation, JobsDependencies, JobsService, Player } from "./internal";

const { clean, id, integer, positiveId, normalizeJob, mutation } = normalizeModule;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
/** Employment mutations owned by this resource bypass the grade cap so an admin can seat the first Head. */
const ADMIN_RESOURCE = "hmp-admin";
const RANK_APPOINT = "You cannot appoint a grade at or above your own.";
const RANK_MANAGE = "You cannot manage an employee at or above your own grade.";
const RANK_DISMISS = "You cannot dismiss an employee at or above your own grade.";

type RankAction = "hire" | "grade" | "fire";

interface JobRecord {
    definition: HmpJobDefinition<Player>;
    disposers: Array<() => boolean>;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function jobsError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

function createJobsService(dependencies: JobsDependencies): JobsService {
    const { repository, core, banking, interact, ui, events, logger, migrations } = dependencies;
    if (!repository || !core?.characters || !core?.groups || !banking?.transactions || !interact?.register || !ui?.context) throw new TypeError("jobs dependencies are required");
    const now = dependencies.now || Date.now;
    const makeInterval = dependencies.setInterval || globalThis.setInterval;
    const clearTimer = dependencies.clearInterval || globalThis.clearInterval;
    const startedAt = now();
    const jobs = new Map<string, JobRecord>();
    const dutyByPlayer = new Map<number, HmpDutyState>();
    const openMenus = new Set<number>();
    const activePayments = new Set<string>();
    let state: "starting" | "ready" | "degraded" | "stopped" = "starting";
    let lastError = "";
    let startPromise: Promise<void> | null = null;
    let payrollRunning = false;
    let payrollTimer: ReturnType<typeof globalThis.setInterval> | null = null;

    const playerId = (player: Player | number): number => positiveId(typeof player === "object" ? player.id : player, "player or character id");
    const emit = (name: string, payload: unknown): void => {
        try { events.emit(name, payload); }
        catch (error) { logger.warn(`[hmp-jobs] listener for '${name}' failed`, error); }
    };

    function jobValue(rawJobId: string): HmpJobDefinition<Player> {
        const jobId = id(rawJobId, "job id");
        const job = jobs.get(jobId)?.definition;
        if (!job) throw jobsError("HMP_JOBS_UNKNOWN", `Job '${jobId}' is not registered.`);
        return job;
    }

    function gradeValue(job: HmpJobDefinition<Player>, rawGrade: number | undefined) {
        const level = rawGrade === undefined ? job.defaultGrade! : integer(rawGrade, job.defaultGrade!, 0, 1000);
        const grade = job.grades.find((entry) => entry.level === level);
        if (!grade) throw jobsError("HMP_JOBS_GRADE", `Grade '${level}' does not exist for ${job.label}.`);
        return grade;
    }

    function characterId(target: Player | number): number {
        if (typeof target === "number") return positiveId(target, "character id");
        const character = core.characters.active(target);
        if (!character) throw jobsError("HMP_JOBS_CHARACTER", "Choose a character before using jobs.");
        return character.id;
    }

    function actorCharacterId(options?: HmpJobMutationOptions<Player>): number | null {
        const actor = options?.actor;
        if (actor === null || actor === undefined) return null;
        return typeof actor === "number" ? positiveId(actor, "actor character id") : characterId(actor);
    }

    function mutationValue(target: Player | number, job: HmpJobDefinition<Player>, grade: number | undefined, options?: HmpJobMutationOptions<Player>): EmploymentMutation {
        const normalized = mutation(options);
        return {
            characterId: characterId(target),
            jobId: job.id,
            grade,
            actorCharacterId: actorCharacterId(options),
            resource: normalized.resource,
            reason: normalized.reason,
            metadata: normalized.metadata,
        };
    }

    function employed(employment: HmpEmployment | null): HmpEmployment | null {
        return employment && employment.status === "employed" ? employment : null;
    }

    async function refuse(job: HmpJobDefinition<Player>, action: RankAction, request: EmploymentMutation, target: HmpEmployment | null, actorGrade: number | null, message: string): Promise<never> {
        try {
            await repository.audit({
                characterId: request.characterId,
                jobId: job.id,
                action: "denied",
                actorCharacterId: request.actorCharacterId,
                fromGrade: target?.grade ?? null,
                toGrade: request.grade ?? null,
                resource: request.resource,
                reason: message,
                metadata: { ...request.metadata, attempted: action, actorGrade, requestReason: request.reason },
            });
        } catch (error) { logger.warn(`[hmp-jobs] could not record denied ${action} for ${job.id}: ${messageOf(error)}`); }
        throw jobsError("HMP_JOBS_RANK", message);
    }

    /**
     * Grade cap. An actor acting through their own employment in the job may only hire below their
     * grade, move an employee below them to another grade below them, or dismiss an employee below
     * them. Ties are refused. Mutations without an actor, or owned by hmp-admin, are exempt.
     */
    async function enforceRank(job: HmpJobDefinition<Player>, action: RankAction, request: EmploymentMutation): Promise<void> {
        if (request.actorCharacterId === null || request.resource === ADMIN_RESOURCE) return;
        const actor = employed(await repository.get(request.actorCharacterId, job.id));
        const target = employed(await repository.get(request.characterId, job.id));
        if (!actor) return refuse(job, action, request, target, null, `You are not employed by ${job.label}.`);
        if (action !== "hire" && target && target.grade >= actor.grade) return refuse(job, action, request, target, actor.grade, action === "fire" ? RANK_DISMISS : RANK_MANAGE);
        if (action !== "fire" && request.grade! >= actor.grade) return refuse(job, action, request, target, actor.grade, RANK_APPOINT);
    }

    async function syncEmployment(employment: HmpEmployment, job?: HmpJobDefinition<Player>): Promise<void> {
        const definition = job || jobs.get(employment.jobId)?.definition;
        if (!definition) return;
        if (employment.status === "employed") {
            await core.groups.setCharacter(employment.characterId, definition.group!, employment.grade, { jobId: definition.id, label: definition.label });
        } else {
            await core.groups.removeCharacter(employment.characterId, definition.group!);
        }
    }

    async function syncCharacter(rawCharacterId: number): Promise<void> {
        const employments = await repository.list(rawCharacterId);
        await Promise.all(employments.map((employment) => syncEmployment(employment)));
    }

    async function start(): Promise<void> {
        if (state === "ready") return;
        if (state === "stopped") throw new Error("hmp-jobs is stopped");
        if (startPromise) return startPromise;
        startPromise = (async () => {
            try {
                await repository.migrate(migrations);
                state = "ready";
                lastError = "";
                if (!payrollTimer) {
                    payrollTimer = makeInterval(() => { runPayroll().catch((error) => logger.error(`[hmp-jobs] payroll cycle failed: ${messageOf(error)}`)); }, 60_000);
                    payrollTimer.unref?.();
                }
            } catch (error) {
                state = "degraded";
                lastError = messageOf(error);
                throw error;
            } finally { startPromise = null; }
        })();
        return startPromise;
    }

    function bankingRules(job: HmpJobDefinition<Player>) {
        const permissions = new Map<HmpBankPermission, number>();
        for (const grade of job.grades) for (const permission of grade.bankPermissions || []) {
            const current = permissions.get(permission);
            if (current === undefined || grade.level < current) permissions.set(permission, grade.level);
        }
        return [...permissions].map(([permission, minimumGrade]) => ({ group: job.group!, minimumGrade, permissions: [permission] }));
    }

    function register(raw: HmpJobDefinition<Player>): () => boolean {
        if (state === "stopped") throw new Error("hmp-jobs is stopped");
        const definition = normalizeJob(raw);
        const existing = jobs.get(definition.id);
        if (existing && existing.definition.resource !== definition.resource) throw new Error(`job '${definition.id}' is already owned by '${existing.definition.resource}'`);
        const sharedGroup = [...jobs.values()].find((record) => record.definition.id !== definition.id && record.definition.group === definition.group);
        if (sharedGroup) throw new Error(`job group '${definition.group}' is already projected by '${sharedGroup.definition.id}'`);
        const record: JobRecord = { definition, disposers: [] };
        jobs.set(definition.id, record);

        try {
            if (definition.banking) record.disposers.push(banking.organizations.register({
                id: definition.banking.organizationId!,
                resource: definition.resource,
                label: definition.label,
                currency: definition.banking.currency,
                rules: bankingRules(definition),
            }));
            for (const point of definition.dutyPoints || []) record.disposers.push(interact.register({
                id: `job:${definition.id}:duty:${point.id}`,
                resource: definition.resource,
                label: point.label || `Toggle ${definition.label} duty`,
                description: point.description,
                position: point.position,
                areaId: point.areaId,
                regionId: point.regionId,
                radius: point.radius,
                promptDistance: point.promptDistance,
                promptOffsetZ: point.promptOffsetZ,
                virtualWorld: point.virtualWorld,
                object: point.object,
                requirements: { character: true, groups: [{ key: definition.group!, minimumGrade: 0 }] },
                handler: ({ player }) => toggleDuty(player, definition.id),
            }));
        } catch (error) {
            for (const dispose of record.disposers.reverse()) dispose();
            if (existing) jobs.set(existing.definition.id, existing); else jobs.delete(definition.id);
            throw error;
        }
        start().then(() => repository.employees(definition.id)).then((entries) => Promise.all(entries.map((entry) => syncEmployment(entry, definition)))).catch((error) => logger.error(`[hmp-jobs] could not project '${definition.id}' employment`, error));
        let registered = true;
        return () => {
            if (!registered || jobs.get(definition.id) !== record) return false;
            registered = false;
            return unregister(definition.id, definition.resource);
        };
    }

    function unregister(rawJobId: string, resource?: string): boolean {
        const jobId = String(rawJobId || "").trim();
        const record = jobs.get(jobId);
        if (!record || (resource && record.definition.resource !== resource)) return false;
        jobs.delete(jobId);
        for (const dispose of record.disposers.reverse()) dispose();
        for (const [owner, duty] of dutyByPlayer) if (duty.jobId === jobId) {
            dutyByPlayer.delete(owner);
            repository.audit({ characterId: duty.characterId, jobId, action: "duty_off", resource: "hmp-jobs", reason: "Defining resource stopped", metadata: { playerId: owner } }).catch((error) => logger.warn(`[hmp-jobs] could not audit '${jobId}' cleanup: ${messageOf(error)}`));
            emit("hmp:jobs:duty", { player: null, job: record.definition, onDuty: false, duty: null });
        }
        repository.employees(jobId).then((entries) => Promise.all(entries.map((entry) => core.groups.removeCharacter(entry.characterId, record.definition.group!)))).catch((error) => logger.error(`[hmp-jobs] could not remove '${jobId}' group projections`, error));
        return true;
    }

    async function hire(target: Player | number, rawJobId: string, rawGrade?: number, options?: HmpJobMutationOptions<Player>): Promise<HmpEmployment> {
        await start();
        const job = jobValue(rawJobId);
        const grade = gradeValue(job, rawGrade);
        const request = mutationValue(target, job, grade.level, options);
        await enforceRank(job, "hire", request);
        const employment = await repository.hire(request);
        await syncEmployment(employment, job);
        emit("hmp:jobs:hired", { employment, job, actor: options?.actor ?? null });
        return employment;
    }

    async function fire(target: Player | number, rawJobId: string, options?: HmpJobMutationOptions<Player>): Promise<HmpEmployment> {
        await start();
        const job = jobValue(rawJobId);
        const targetCharacterId = characterId(target);
        const request = mutationValue(targetCharacterId, job, undefined, options);
        await enforceRank(job, "fire", request);
        const employment = await repository.fire(request);
        await syncEmployment(employment, job);
        for (const [owner, duty] of dutyByPlayer) if (duty.characterId === targetCharacterId && duty.jobId === job.id) {
            dutyByPlayer.delete(owner);
            await repository.audit({ characterId: duty.characterId, jobId: job.id, action: "duty_off", resource: "hmp-jobs", reason: "Employment ended", metadata: { playerId: owner } });
            emit("hmp:jobs:duty", { player: typeof target === "object" ? target : null, job, onDuty: false, duty: null });
        }
        emit("hmp:jobs:fired", { employment, job, actor: options?.actor ?? null });
        return employment;
    }

    async function setGrade(target: Player | number, rawJobId: string, rawGrade: number, options?: HmpJobMutationOptions<Player>): Promise<HmpEmployment> {
        await start();
        const job = jobValue(rawJobId);
        const grade = gradeValue(job, rawGrade);
        const request = mutationValue(target, job, grade.level, options);
        await enforceRank(job, "grade", request);
        const employment = await repository.setGrade(request);
        await syncEmployment(employment, job);
        emit("hmp:jobs:grade", { employment, job, actor: options?.actor ?? null });
        return employment;
    }

    async function setActive(target: Player | number, rawJobId: string, options?: HmpJobMutationOptions<Player>): Promise<HmpEmployment> {
        await start();
        const job = jobValue(rawJobId);
        const targetCharacterId = characterId(target);
        const employment = await repository.setActive(mutationValue(targetCharacterId, job, undefined, options));
        for (const [owner, duty] of dutyByPlayer) if (duty.characterId === targetCharacterId && duty.jobId !== job.id) dutyByPlayer.delete(owner);
        emit("hmp:jobs:active", { employment, job, actor: options?.actor ?? null });
        return employment;
    }

    async function getEmployment(target: Player | number, rawJobId: string): Promise<HmpEmployment | null> {
        return repository.get(characterId(target), id(rawJobId, "job id"));
    }

    async function listEmployment(target: Player | number): Promise<HmpEmployment[]> {
        return repository.list(characterId(target));
    }

    async function employees(rawJobId: string, includeTerminated = false): Promise<HmpEmployment[]> {
        jobValue(rawJobId);
        return repository.employees(rawJobId, includeTerminated === true);
    }

    function permissionsFor(job: HmpJobDefinition<Player>, gradeLevel: number): string[] {
        return [...new Set(job.grades.filter((grade) => grade.level <= gradeLevel).flatMap((grade) => [...(grade.permissions || [])]))];
    }

    async function permissionList(target: Player | number, rawJobId?: string): Promise<string[]> {
        const targetCharacterId = characterId(target);
        const employments = await repository.list(targetCharacterId);
        const employment = rawJobId
            ? employments.find((entry) => entry.jobId === id(rawJobId, "job id") && entry.status === "employed")
            : employments.find((entry) => entry.active && entry.status === "employed");
        if (!employment) return [];
        const job = jobs.get(employment.jobId)?.definition;
        return job ? permissionsFor(job, employment.grade) : [];
    }

    async function hasPermission(target: Player | number, permission: string, jobId?: string): Promise<boolean> {
        const normalized = id(permission, "job permission");
        return (await permissionList(target, jobId)).includes(normalized);
    }

    function dutyGet(player: Player | number): HmpDutyState | null {
        return dutyByPlayer.get(playerId(player)) || null;
    }

    async function setDuty(player: Player, rawJobId: string, onDuty: boolean): Promise<HmpDutyState | null> {
        await start();
        const owner = playerId(player);
        const job = jobValue(rawJobId);
        const character = core.characters.active(player);
        if (!character) throw jobsError("HMP_JOBS_CHARACTER", "Choose a character before changing duty.");
        const current = dutyByPlayer.get(owner);
        if (!onDuty) {
            if (!current || current.jobId !== job.id) return current || null;
            dutyByPlayer.delete(owner);
            await repository.audit({ characterId: character.id, jobId: job.id, action: "duty_off", resource: "hmp-jobs", metadata: { playerId: owner } });
            emit("hmp:jobs:duty", { player, character, job, onDuty: false, duty: null });
            return null;
        }
        const employment = await repository.get(character.id, job.id);
        if (!employment || employment.status !== "employed") throw jobsError("HMP_JOBS_EMPLOYMENT", `You are not employed by ${job.label}.`);
        if (!employment.active) await setActive(character.id, job.id, { resource: "hmp-jobs", actor: player, reason: "Selected when going on duty" });
        if (job.canDuty) {
            const allowed = await job.canDuty({ player, character, job, employment, onDuty: true });
            if (allowed !== true) throw jobsError("HMP_JOBS_DUTY", typeof allowed === "string" ? allowed : `You cannot go on duty for ${job.label}.`);
        }
        if (current?.jobId === job.id) return current;
        if (current) await repository.audit({ characterId: current.characterId, jobId: current.jobId, action: "duty_off", resource: "hmp-jobs", metadata: { playerId: owner, switchedTo: job.id } });
        const duty: HmpDutyState = Object.freeze({ playerId: owner, characterId: character.id, jobId: job.id, since: new Date(now()) });
        dutyByPlayer.set(owner, duty);
        await repository.audit({ characterId: character.id, jobId: job.id, action: "duty_on", resource: "hmp-jobs", metadata: { playerId: owner } });
        emit("hmp:jobs:duty", { player, character, job, onDuty: true, duty });
        return duty;
    }

    async function toggleDuty(player: Player, jobId: string): Promise<HmpDutyState | null> {
        return setDuty(player, jobId, !(dutyByPlayer.get(playerId(player))?.jobId === jobId));
    }

    async function pay(rawCharacterId: number, rawJobId: string, options: HmpJobPayrollOptions = {}): Promise<HmpJobPayrollResult> {
        await start();
        const targetCharacterId = positiveId(rawCharacterId, "payroll character id");
        const job = jobValue(rawJobId);
        if (!job.payroll) throw jobsError("HMP_JOBS_PAYROLL", `${job.label} does not have payroll configured.`);
        const key = `${job.id}:${targetCharacterId}`;
        if (activePayments.has(key)) throw jobsError("HMP_JOBS_PAYROLL_BUSY", "A salary payment is already in progress.");
        activePayments.add(key);
        try {
            const employment = await repository.get(targetCharacterId, job.id);
            if (!employment || employment.status !== "employed") throw jobsError("HMP_JOBS_EMPLOYMENT", "Active employment was not found.");
            const grade = gradeValue(job, employment.grade);
            const amount = integer(grade.salary, 0, 0, MAX_SAFE);
            if (amount < 1) throw jobsError("HMP_JOBS_PAYROLL", `${grade.label} has no salary configured.`);
            if (job.payroll.requireDuty && ![...dutyByPlayer.values()].some((entry) => entry.characterId === targetCharacterId && entry.jobId === job.id)) throw jobsError("HMP_JOBS_DUTY", "This salary requires the employee to be on duty.");
            const destination = await banking.accounts.personal(targetCharacterId, job.banking && job.banking.currency || "galleons");
            const reference = clean(options.reference, 96) || `jobpay:${job.id}:${targetCharacterId}:${now().toString(36)}`;
            const transactionOptions = { resource: "hmp-jobs", reference, memo: `${job.label} salary`, metadata: { jobId: job.id, characterId: targetCharacterId, grade: grade.level } };
            const transaction = job.payroll.source === "system"
                ? await banking.transactions.credit(destination, amount, transactionOptions)
                : await (async () => {
                    const source = await banking.accounts.organization(job.banking && job.banking.organizationId || "");
                    if (!source) throw jobsError("HMP_JOBS_BANK", `${job.label} organization account is unavailable.`);
                    return banking.transactions.transfer(source, destination, amount, transactionOptions);
                })();
            if (transaction.status !== "completed") throw jobsError("HMP_JOBS_PAYROLL", `Salary transaction '${transaction.reference}' is ${transaction.status}.`);
            const paid = await repository.markPaid(targetCharacterId, job.id, "hmp-jobs", { amount, currency: transaction.currency, transactionId: transaction.id, reference: transaction.reference });
            emit("hmp:jobs:paid", { employment: paid, job, transaction });
            return { employment: paid, transaction };
        } finally { activePayments.delete(key); }
    }

    async function runPayroll(rawJobId?: string): Promise<HmpJobPayrollResult[]> {
        if (payrollRunning) return [];
        payrollRunning = true;
        const results: HmpJobPayrollResult[] = [];
        try {
            const definitions = rawJobId ? [jobValue(rawJobId)] : [...jobs.values()].map((record) => record.definition);
            for (const job of definitions) {
                if (!job.payroll) continue;
                const entries = await repository.employees(job.id);
                for (const employment of entries) {
                    const parsedLast = employment.lastPaidAt ? new Date(employment.lastPaidAt).getTime() : 0;
                    const last = Number.isFinite(parsedLast) ? parsedLast : 0;
                    if (last + job.payroll.intervalMs > now()) continue;
                    if (job.payroll.requireDuty && ![...dutyByPlayer.values()].some((entry) => entry.characterId === employment.characterId && entry.jobId === job.id)) continue;
                    try { results.push(await pay(employment.characterId, job.id, { reference: `jobpay:${job.id}:${employment.characterId}:${Math.floor((last + job.payroll.intervalMs) / 1000).toString(36)}` })); }
                    catch (error) { logger.warn(`[hmp-jobs] could not pay ${employment.characterName} for ${job.id}: ${messageOf(error)}`); }
                }
            }
            return results;
        } finally { payrollRunning = false; }
    }

    function gradeLabel(job: HmpJobDefinition<Player>, employment: HmpEmployment): string {
        return job.grades.find((entry) => entry.level === employment.grade)?.label || `Grade ${employment.grade}`;
    }

    async function open(player: Player): Promise<unknown> {
        const owner = playerId(player);
        if (openMenus.has(owner)) return null;
        openMenus.add(owner);
        try {
            const entries = (await listEmployment(player)).filter((entry) => entry.status === "employed" && jobs.has(entry.jobId));
            const selected = await ui.context(player, {
                title: "Employment",
                description: entries.length ? "Choose a job." : "You do not have any current employment.",
                options: entries.length ? entries.map((employment) => {
                    const job = jobValue(employment.jobId);
                    return { id: job.id, title: job.label, description: gradeLabel(job, employment), metadata: [{ label: "Selected", value: employment.active ? "Yes" : "No" }, { label: "Duty", value: dutyGet(player)?.jobId === job.id ? "On duty" : "Off duty" }] };
                }) : [{ id: "empty", title: "No employment", disabled: true }],
                canClose: true,
            });
            if (!selected || !jobs.has(selected)) return null;
            const job = jobValue(selected);
            const employment = await repository.get(characterId(player), job.id);
            if (!employment) return null;
            const action = await ui.context(player, {
                title: job.label,
                description: gradeLabel(job, employment),
                options: [
                    { id: "duty", title: dutyGet(player)?.jobId === job.id ? "Go off duty" : "Go on duty", description: "Update your current duty status" },
                    { id: "active", title: "Select this job", description: employment.active ? "Already selected" : "Use this as your active job", disabled: employment.active },
                    { id: "manage", title: "Manage employees", description: "Hire, promote, demote, or dismiss", disabled: !(await hasPermission(player, "employees.manage", job.id)) },
                ],
                canClose: true,
            });
            if (action === "duty") return toggleDuty(player, job.id);
            if (action === "active") return setActive(player, job.id, { resource: "hmp-jobs", actor: player, reason: "Selected through employment menu" });
            if (action === "manage") return manage(player, job.id);
            return null;
        } catch (error) {
            logger.warn(`[hmp-jobs] employment menu failed for #${owner}: ${messageOf(error)}`);
            ui.notify(player, { description: messageOf(error), tone: "error" });
            return null;
        } finally { openMenus.delete(owner); }
    }

    async function manage(player: Player, rawJobId: string): Promise<unknown> {
        const job = jobValue(rawJobId);
        if (!(await hasPermission(player, "employees.manage", job.id))) throw jobsError("HMP_JOBS_ACCESS", `You cannot manage ${job.label}.`);
        const manager = employed(await repository.get(characterId(player), job.id));
        if (!manager) throw jobsError("HMP_JOBS_ACCESS", `You cannot manage ${job.label}.`);
        // Mirror enforceRank so the cap is visible in the menu instead of a surprise on submit.
        const appointable = job.grades.filter((grade) => grade.level < manager.grade);
        const gradeOptions = appointable.map((grade) => ({ label: grade.label, value: String(grade.level) }));
        const outranked = (employment: HmpEmployment) => employment.grade >= manager.grade;
        const entries = (await repository.employees(job.id)).slice(0, 32);
        const selected = await ui.context(player, {
            title: `${job.label} staff`,
            description: "Choose an employee or hire by character ID.",
            options: [
                { id: "hire", title: "Hire employee", description: appointable.length ? "Enter a character ID" : "No grade below your own", disabled: !appointable.length },
                ...entries.map((employment) => ({ id: `employee:${employment.characterId}`, title: employment.characterName, description: outranked(employment) ? `${gradeLabel(job, employment)} · at or above your grade` : gradeLabel(job, employment), disabled: outranked(employment), metadata: [{ label: "Character ID", value: String(employment.characterId) }] })),
            ],
            canClose: true,
        });
        if (!selected) return null;
        if (selected === "hire") {
            if (!appointable.length) throw jobsError("HMP_JOBS_RANK", RANK_APPOINT);
            const defaultGrade = appointable.some((grade) => grade.level === job.defaultGrade) ? job.defaultGrade! : appointable[0].level;
            const response = await ui.input(player, { title: `Hire for ${job.label}`, fields: [{ name: "characterId", label: "Character ID", type: "number", required: true, min: 1 }, { name: "grade", label: "Starting grade", type: "select", required: true, default: String(defaultGrade), options: gradeOptions }, { name: "reason", label: "Reason", type: "text" }], submitLabel: "Hire", allowCancel: true });
            if (!response) return null;
            return hire(positiveId(response.characterId, "character id"), job.id, Number(response.grade), { resource: "hmp-jobs", actor: player, reason: clean(response.reason, 191) });
        }
        const targetId = positiveId(selected.replace(/^employee:/, ""), "character id");
        const employment = entries.find((entry) => entry.characterId === targetId);
        if (!employment) return null;
        if (outranked(employment)) throw jobsError("HMP_JOBS_RANK", RANK_MANAGE);
        const action = await ui.context(player, { title: employment.characterName, description: gradeLabel(job, employment), options: [{ id: "grade", title: "Change grade", description: appointable.length > 1 ? "Promote or demote this employee" : "No other grade below your own", disabled: appointable.length < 2 }, { id: "fire", title: "Dismiss employee", description: "End this employment", tone: "warning" }], canClose: true });
        if (action === "grade") {
            const response = await ui.input(player, { title: `Set ${employment.characterName}'s grade`, fields: [{ name: "grade", label: "Grade", type: "select", required: true, default: String(employment.grade), options: gradeOptions }, { name: "reason", label: "Reason", type: "text" }], submitLabel: "Save", allowCancel: true });
            if (!response) return null;
            return setGrade(targetId, job.id, Number(response.grade), { resource: "hmp-jobs", actor: player, reason: clean(response.reason, 191) });
        }
        if (action === "fire" && await ui.alert(player, { title: `Dismiss ${employment.characterName}?`, content: `This ends their employment with ${job.label}.`, confirmLabel: "Dismiss", cancel: true }) === "confirm") return fire(targetId, job.id, { resource: "hmp-jobs", actor: player, reason: "Dismissed through management menu" });
        return null;
    }

    async function characterLoaded(player: Player): Promise<void> {
        await start();
        const character = core.characters.active(player);
        if (character) await syncCharacter(character.id);
    }

    async function clockOut(player: Player, reason: string): Promise<boolean> {
        const owner = playerId(player);
        const duty = dutyByPlayer.get(owner);
        dutyByPlayer.delete(owner);
        if (openMenus.delete(owner)) ui.close(player, reason);
        if (duty) {
            await repository.audit({ characterId: duty.characterId, jobId: duty.jobId, action: "duty_off", resource: "hmp-jobs", reason, metadata: { playerId: owner } });
            emit("hmp:jobs:duty", { player, job: jobs.get(duty.jobId)?.definition || null, onDuty: false, duty: null });
        }
        return true;
    }

    async function maySwitch(request: { player: Player; allow: boolean; reason?: string }): Promise<boolean> {
        await clockOut(request.player, "Employment closed for character switch");
        return true;
    }

    function disconnect(player: Player): boolean {
        clockOut(player, "Employment closed").catch((error) => logger.warn(`[hmp-jobs] could not record disconnect duty: ${messageOf(error)}`));
        return true;
    }

    function removeForResource(resource: string): number {
        let removed = 0;
        for (const record of [...jobs.values()]) if (record.definition.resource === resource && unregister(record.definition.id, resource)) removed++;
        return removed;
    }

    async function stop(): Promise<void> {
        if (state === "stopped") return;
        state = "stopped";
        if (payrollTimer) clearTimer(payrollTimer);
        payrollTimer = null;
        for (const [owner, duty] of dutyByPlayer) await repository.audit({ characterId: duty.characterId, jobId: duty.jobId, action: "duty_off", resource: "hmp-jobs", reason: "Jobs resource stopped", metadata: { playerId: owner } });
        for (const record of jobs.values()) for (const dispose of record.disposers.reverse()) dispose();
        jobs.clear();
        dutyByPlayer.clear();
        openMenus.clear();
        activePayments.clear();
    }

    return Object.freeze({
        jobs: Object.freeze({ register, unregister, get: (jobId: string) => jobs.get(String(jobId || "").trim())?.definition || null, list: (resource?: string) => [...jobs.values()].map((record) => record.definition).filter((definition) => !resource || definition.resource === resource) }),
        employment: Object.freeze({ hire, fire, setGrade, setActive, get: getEmployment, list: listEmployment, employees }),
        duty: Object.freeze({ set: setDuty, toggle: toggleDuty, get: dutyGet, isOnDuty: (player: Player | number, jobId?: string) => { const duty = dutyGet(player); return Boolean(duty && (!jobId || duty.jobId === jobId)); }, list: (jobId?: string) => [...dutyByPlayer.values()].filter((duty) => !jobId || duty.jobId === jobId) }),
        permissions: Object.freeze({ has: hasPermission, list: permissionList }),
        payroll: Object.freeze({ pay, run: runPayroll }),
        ui: Object.freeze({ open, manage, close: (player: Player) => { openMenus.delete(playerId(player)); return ui.close(player, "Employment closed"); } }),
        audit: Object.freeze({ history: (characterId: number, jobId?: string, limit = 50) => repository.history(positiveId(characterId, "character id"), jobId ? id(jobId, "job id") : undefined, integer(limit, 50, 1, 200)) }),
        status: () => ({ state, lastError, jobs: jobs.size, onDuty: dutyByPlayer.size, openMenus: openMenus.size, payrollRunning, uptimeMs: Math.min(MAX_SAFE, Math.max(0, now() - startedAt)) }),
        start, removeForResource, characterLoaded, maySwitch, disconnect, stop,
    }) as JobsService;
}

export = { createJobsService, jobsError };
