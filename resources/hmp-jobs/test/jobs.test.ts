import assert = require("node:assert");
import { test } from "node:test";
import normalizeModule = require("../shared/normalize");
import schemaModule = require("../server/schema");
import serviceModule = require("../server/service");
import type { HmpBankAccount, HmpBankTransaction } from "../../hmp-banking/types";
import type { HmpEmployment, HmpJobAuditEntry } from "../types";
import type { AuditDraft, EmploymentMutation, JobsRepository, Player } from "../server/internal";

const { normalizeJob } = normalizeModule;
const { migrations } = schemaModule;
const { createJobsService } = serviceModule;

function definition() {
    return {
        id: "professor",
        resource: "hmp-school",
        label: "Hogwarts Faculty",
        grades: [
            { level: 0, label: "Assistant", salary: 10, permissions: ["class.attend"], bankPermissions: ["view"] },
            { level: 5, label: "Professor", salary: 25, permissions: ["class.teach"] },
            { level: 10, label: "Headmaster", salary: 50, permissions: ["employees.manage"], bankPermissions: ["manage"] },
        ],
        banking: { organizationId: "hogwarts", currency: "galleons" },
        payroll: { intervalMs: 60_000, requireDuty: true },
        dutyPoints: [{ id: "hall", position: { x: 1, y: 2, z: 3 } }],
    } as const;
}

/** Same job, but the middle grade may manage employees: the Manager-below-Head shape from the shop design. */
function managed() {
    const base = definition();
    return { ...base, grades: [base.grades[0], { ...base.grades[1], permissions: ["employees.manage"] }, base.grades[2]] };
}

test("keeps generated active-job uniqueness compatible with MySQL foreign keys", () => {
    const employmentSchema = migrations[0].statements[0];
    assert.match(employmentSchema, /active_character_id BIGINT UNSIGNED GENERATED ALWAYS/);
    assert.match(employmentSchema, /fk_hmp_job_employment_character[\s\S]+ON DELETE RESTRICT/);
    assert.doesNotMatch(employmentSchema, /fk_hmp_job_employment_character[\s\S]+ON DELETE CASCADE/);
});

function setup() {
    let clock = 100_000;
    let nextAudit = 1;
    let nextTransaction = 1;
    const player = { id: 7, nickname: "Minerva", position: { x: 0, y: 0, z: 0 }, emit() {}, teleport: () => 0 } as Player;
    const activeCharacters = new Map<number, { id: number; name: string }>([[7, { id: 12, name: "Minerva McGonagall" }]]);
    const employments = new Map<string, HmpEmployment>();
    const audit: HmpJobAuditEntry[] = [];
    const groups = new Map<string, number>();
    const interactions = new Map<string, { handler?: (context: { player: Player }) => unknown }>();
    const organizations = new Map<string, unknown>();
    const emitted: Array<{ name: string; payload: unknown }> = [];
    const notifications: unknown[] = [];
    const uiRequests: unknown[] = [];
    const uiAnswers: unknown[] = [];
    const answer = async (_player: Player, request: unknown) => { uiRequests.push(request); return uiAnswers.shift() ?? null; };
    const accounts = new Map<string, HmpBankAccount>();
    const transactions: HmpBankTransaction[] = [];
    const key = (characterId: number, jobId: string) => `${characterId}:${jobId}`;
    const copy = (employment: HmpEmployment) => ({ ...employment });

    function appendAudit(draft: AuditDraft): HmpJobAuditEntry {
        const entry: HmpJobAuditEntry = { id: nextAudit++, characterId: draft.characterId, jobId: draft.jobId, action: draft.action, actorCharacterId: draft.actorCharacterId ?? null, fromGrade: draft.fromGrade ?? null, toGrade: draft.toGrade ?? null, resource: draft.resource || "hmp-jobs", reason: draft.reason || "", metadata: draft.metadata || {}, createdAt: new Date(clock) };
        audit.push(entry);
        return entry;
    }

    const repository: JobsRepository = {
        async migrate() {},
        async get(characterId, jobId) { const value = employments.get(key(characterId, jobId)); return value ? copy(value) : null; },
        async list(characterId) { return [...employments.values()].filter((entry) => entry.characterId === characterId).map(copy); },
        async employees(jobId, includeTerminated = false) { return [...employments.values()].filter((entry) => entry.jobId === jobId && (includeTerminated || entry.status === "employed")).map(copy); },
        async hire(mutation: EmploymentMutation) {
            const hasActive = [...employments.values()].some((entry) => entry.characterId === mutation.characterId && entry.active && entry.status === "employed");
            const employment: HmpEmployment = { characterId: mutation.characterId, characterName: mutation.characterId === 12 ? "Minerva McGonagall" : `Character ${mutation.characterId}`, jobId: mutation.jobId, grade: mutation.grade!, status: "employed", active: !hasActive, hiredBy: mutation.actorCharacterId, hiredAt: new Date(clock), updatedAt: new Date(clock), terminatedAt: null, lastPaidAt: new Date(clock) };
            employments.set(key(mutation.characterId, mutation.jobId), employment);
            appendAudit({ ...mutation, action: "hired", toGrade: mutation.grade });
            return copy(employment);
        },
        async fire(mutation) {
            const employment = employments.get(key(mutation.characterId, mutation.jobId))!;
            employment.status = "terminated"; employment.active = false; employment.terminatedAt = new Date(clock);
            appendAudit({ ...mutation, action: "fired", fromGrade: employment.grade });
            return copy(employment);
        },
        async setGrade(mutation) {
            const employment = employments.get(key(mutation.characterId, mutation.jobId))!;
            const previous = employment.grade; employment.grade = mutation.grade!; employment.updatedAt = new Date(clock);
            appendAudit({ ...mutation, action: "grade", fromGrade: previous, toGrade: mutation.grade });
            return copy(employment);
        },
        async setActive(mutation) {
            for (const entry of employments.values()) if (entry.characterId === mutation.characterId) entry.active = false;
            const employment = employments.get(key(mutation.characterId, mutation.jobId))!; employment.active = true;
            appendAudit({ ...mutation, action: "active", fromGrade: employment.grade, toGrade: employment.grade });
            return copy(employment);
        },
        async markPaid(characterId, jobId, resource, metadata) {
            const employment = employments.get(key(characterId, jobId))!; employment.lastPaidAt = new Date(clock);
            appendAudit({ characterId, jobId, action: "paid", resource, metadata });
            return copy(employment);
        },
        async audit(draft) { return appendAudit(draft); },
        async history(characterId, jobId, limit) { return audit.filter((entry) => entry.characterId === characterId && (!jobId || entry.jobId === jobId)).slice(-limit).reverse(); },
    };

    function account(id: number, type: "personal" | "organization", owner: number | string, balance: number): HmpBankAccount {
        return { id, number: `HMP-${id}`, type, characterId: type === "personal" ? Number(owner) : null, organizationId: type === "organization" ? String(owner) : null, label: String(owner), currency: "galleons", balance, status: "active", createdAt: new Date(0), updatedAt: new Date(0) };
    }
    accounts.set("organization:hogwarts", account(1, "organization", "hogwarts", 500));

    const banking = {
        organizations: {
            register(value: { id: string }) { organizations.set(value.id, value); return () => organizations.delete(value.id); },
        },
        accounts: {
            async organization(id: string) { return accounts.get(`organization:${id}`) || null; },
            async personal(characterId: number) {
                const accountKey = `personal:${characterId}`;
                if (!accounts.has(accountKey)) accounts.set(accountKey, account(accounts.size + 1, "personal", characterId, 0));
                return accounts.get(accountKey)!;
            },
        },
        transactions: {
            async transfer(from: HmpBankAccount, to: HmpBankAccount, amount: number, options: { reference: string; resource: string; memo: string; metadata: Record<string, unknown> }) {
                from.balance -= amount; to.balance += amount;
                const transaction: HmpBankTransaction = { id: nextTransaction++, reference: options.reference, type: "transfer", actorCharacterId: null, fromAccountId: from.id, toAccountId: to.id, currency: "galleons", amount, memo: options.memo, metadata: options.metadata, resource: options.resource, status: "completed", error: "", createdAt: new Date(clock), appliedAt: new Date(clock), completedAt: new Date(clock) };
                transactions.push(transaction); return transaction;
            },
            async credit(to: HmpBankAccount, amount: number, options: { reference: string; resource: string; memo: string; metadata: Record<string, unknown> }) {
                to.balance += amount;
                const transaction: HmpBankTransaction = { id: nextTransaction++, reference: options.reference, type: "credit", actorCharacterId: null, fromAccountId: null, toAccountId: to.id, currency: "galleons", amount, memo: options.memo, metadata: options.metadata, resource: options.resource, status: "completed", error: "", createdAt: new Date(clock), appliedAt: new Date(clock), completedAt: new Date(clock) };
                transactions.push(transaction); return transaction;
            },
        },
    };

    const service = createJobsService({
        repository,
        core: {
            characters: { active: (value: Player) => activeCharacters.get(value.id) || null },
            groups: {
                async setCharacter(characterId: number, group: string, grade: number) { groups.set(`${characterId}:${group}`, grade); return { scope: "character", key: group, grade, metadata: {} }; },
                async removeCharacter(characterId: number, group: string) { return groups.delete(`${characterId}:${group}`); },
            },
        } as never,
        banking: banking as never,
        interact: { register(value: { id: string; handler?: (context: { player: Player }) => unknown }) { interactions.set(value.id, value); return () => interactions.delete(value.id); } } as never,
        ui: { notify(_player: Player, value: unknown) { notifications.push(value); return true; }, context: answer, input: answer, alert: answer, close() { return true; } } as never,
        events: { emit(name, payload) { emitted.push({ name, payload }); } },
        logger: { info: () => true, warn: () => true, error: () => true },
        migrations: [], now: () => clock,
        setInterval: (() => ({ unref() {} })) as never,
        clearInterval: (() => undefined) as never,
    });

    return { service, player, employments, audit, groups, interactions, organizations, emitted, accounts, transactions, uiRequests, uiAnswers, advance(milliseconds: number) { clock += milliseconds; } };
}

test("normalizes jobs, cumulative grades, payroll and duty points", () => {
    const job = normalizeJob(definition());
    assert.strictEqual(job.group, "job:professor");
    assert.strictEqual(job.payroll?.source, "organization");
    assert.strictEqual(job.dutyPoints?.[0].radius, 250);
    assert.throws(() => normalizeJob({ ...definition(), grades: [definition().grades[0], definition().grades[0]] }), /duplicated/);
    assert.strictEqual(normalizeJob({ ...definition(), banking: false, payroll: { intervalMs: 60_000, source: "system" } }).payroll?.source, "system");
    assert.throws(() => normalizeJob({ ...definition(), banking: false, payroll: { intervalMs: 60_000, source: "organization" } }), /needs banking/);
});

test("registers banking and duty integrations and cleans them by owner", async () => {
    const state = setup();
    await state.service.start();
    const dispose = state.service.jobs.register(definition());
    assert.ok(state.organizations.has("hogwarts"));
    assert.ok(state.interactions.has("job:professor:duty:hall"));
    assert.strictEqual(dispose(), true);
    assert.strictEqual(dispose(), false);
    assert.strictEqual(state.organizations.size, 0);
    assert.strictEqual(state.interactions.size, 0);
});

test("persists employment, mirrors core groups and inherits permissions", async () => {
    const state = setup();
    await state.service.start();
    state.service.jobs.register(definition());
    const hired = await state.service.employment.hire(state.player, "professor", 5, { resource: "test" });
    assert.strictEqual(hired.active, true);
    assert.strictEqual(state.groups.get("12:job:professor"), 5);
    assert.strictEqual(await state.service.permissions.has(state.player, "class.attend"), true);
    assert.strictEqual(await state.service.permissions.has(state.player, "class.teach"), true);
    assert.strictEqual(await state.service.permissions.has(state.player, "employees.manage"), false);
    await state.service.employment.setGrade(12, "professor", 10, { resource: "test" });
    assert.strictEqual(state.groups.get("12:job:professor"), 10);
    assert.strictEqual(await state.service.permissions.has(12, "employees.manage", "professor"), true);
    const fired = await state.service.employment.fire(12, "professor", { resource: "test" });
    assert.strictEqual(fired.status, "terminated");
    assert.strictEqual(state.groups.has("12:job:professor"), false);
});

test("tracks one duty job, audits transitions and clocks out for switches", async () => {
    const state = setup();
    await state.service.start();
    state.service.jobs.register(definition());
    await state.service.employment.hire(state.player, "professor", 5, { resource: "test" });
    const duty = await state.service.duty.set(state.player, "professor", true);
    assert.strictEqual(duty?.characterId, 12);
    assert.strictEqual(state.service.duty.isOnDuty(state.player, "professor"), true);
    await state.service.maySwitch({ player: state.player, allow: true });
    assert.strictEqual(state.service.duty.get(state.player), null);
    assert.ok(state.audit.some((entry) => entry.action === "duty_on"));
    assert.ok(state.audit.some((entry) => entry.action === "duty_off"));
});

test("pays funded salaries only when due and on duty", async () => {
    const state = setup();
    await state.service.start();
    state.service.jobs.register(definition());
    await state.service.employment.hire(state.player, "professor", 5, { resource: "test" });
    await assert.rejects(state.service.payroll.pay(12, "professor"), /on duty/);
    await state.service.duty.set(state.player, "professor", true);
    state.advance(60_000);
    const paid = await state.service.payroll.run("professor");
    assert.strictEqual(paid.length, 1);
    assert.strictEqual(paid[0].transaction.amount, 25);
    assert.strictEqual(state.accounts.get("organization:hogwarts")?.balance, 475);
    assert.strictEqual(state.accounts.get("personal:12")?.balance, 25);
    assert.ok(state.audit.some((entry) => entry.action === "paid"));
    assert.strictEqual((await state.service.payroll.run("professor")).length, 0);
});

test("caps hiring, grade changes and dismissal below the actor's own grade", async () => {
    const state = setup();
    await state.service.start();
    state.service.jobs.register(managed());
    const employment = state.service.employment;

    // hmp-admin seats the Head; a resource passing no actor seats the Manager.
    assert.strictEqual((await employment.hire(10, "professor", 10, { resource: "hmp-admin", actor: 99, reason: "Seat the Head" })).grade, 10);
    assert.strictEqual((await employment.hire(20, "professor", 5, { resource: "test" })).grade, 5);

    // Manager hires at 0 (ok), at 5 and 10 (refused).
    assert.strictEqual((await employment.hire(30, "professor", 0, { resource: "test", actor: 20 })).grade, 0);
    await assert.rejects(employment.hire(31, "professor", 5, { resource: "test", actor: 20 }), { code: "HMP_JOBS_RANK", message: /appoint a grade at or above your own/ });
    await assert.rejects(employment.hire(31, "professor", 10, { resource: "test", actor: 20 }), /appoint a grade at or above your own/);
    assert.strictEqual(await employment.get(31, "professor"), null);

    // Manager fires the Assistant (ok) but not the Head, and cannot promote themselves.
    assert.strictEqual((await employment.fire(30, "professor", { resource: "test", actor: 20 })).status, "terminated");
    await assert.rejects(employment.fire(10, "professor", { resource: "test", actor: 20 }), /dismiss an employee at or above your own grade/);
    await assert.rejects(employment.setGrade(20, "professor", 10, { resource: "test", actor: 20 }), /manage an employee at or above your own grade/);
    assert.strictEqual((await employment.get(10, "professor"))?.status, "employed");
    assert.strictEqual((await employment.get(20, "professor"))?.grade, 5);

    // Head promotes the Manager to 10 (refused, ties) but may demote them.
    await assert.rejects(employment.setGrade(20, "professor", 10, { resource: "test", actor: 10 }), /appoint a grade at or above your own/);
    assert.strictEqual((await employment.setGrade(20, "professor", 0, { resource: "test", actor: 10 })).grade, 0);

    // Non-employees have no rank to act from; hmp-admin bypasses the cap entirely.
    await assert.rejects(employment.setGrade(20, "professor", 5, { resource: "test", actor: 40 }), /not employed by/);
    assert.strictEqual((await employment.setGrade(20, "professor", 5, { resource: "hmp-admin", actor: 40 })).grade, 5);

    // Every refusal is a denied ledger row against the target naming the probing actor.
    const denied = state.audit.filter((entry) => entry.action === "denied");
    assert.deepStrictEqual(denied.map((entry) => [entry.actorCharacterId, entry.characterId, entry.metadata.attempted]), [[20, 31, "hire"], [20, 31, "hire"], [20, 10, "fire"], [20, 20, "grade"], [10, 20, "grade"], [40, 20, "grade"]]);
    assert.strictEqual(denied[0].toGrade, 5);
    assert.strictEqual(denied[0].fromGrade, null);
    assert.strictEqual(denied[0].metadata.actorGrade, 5);
    assert.strictEqual(denied[0].resource, "test");
    assert.match(denied[0].reason, /appoint a grade at or above your own/);
    assert.strictEqual(denied[2].fromGrade, 10);
    assert.strictEqual(denied[4].fromGrade, 5);
    assert.strictEqual(denied[4].toGrade, 10);
    assert.strictEqual(denied[5].metadata.actorGrade, null);
    assert.strictEqual(state.groups.get("10:job:professor"), 10);
});

test("management menu hides grades and greys out employees at or above the manager's own", async () => {
    const state = setup();
    await state.service.start();
    state.service.jobs.register(managed());
    const employment = state.service.employment;
    await employment.hire(10, "professor", 10, { resource: "test" });
    await employment.hire(12, "professor", 5, { resource: "test" });
    await employment.hire(30, "professor", 0, { resource: "test" });

    state.uiAnswers.push("hire", { characterId: 31, grade: "0", reason: "Intake" });
    const hired = await state.service.ui.manage(state.player, "professor") as HmpEmployment;
    assert.strictEqual(hired.characterId, 31);
    assert.strictEqual(hired.grade, 0);
    assert.strictEqual(hired.hiredBy, 12);

    const [staff, form] = state.uiRequests as [{ options: Array<{ id: string; disabled?: boolean }> }, { fields: Array<{ name: string; default?: string; options?: Array<{ value: string }> }> }];
    const option = (id: string) => staff.options.find((entry) => entry.id === id)!;
    assert.strictEqual(option("hire").disabled, false);
    assert.strictEqual(option("employee:10").disabled, true);
    assert.strictEqual(option("employee:12").disabled, true);
    assert.strictEqual(option("employee:30").disabled, false);
    const gradeField = form.fields.find((field) => field.name === "grade")!;
    assert.deepStrictEqual(gradeField.options!.map((entry) => entry.value), ["0"]);
    assert.strictEqual(gradeField.default, "0");

    // Selecting an outranked employee is refused even when a client ignores `disabled`.
    state.uiAnswers.push("employee:10");
    await assert.rejects(state.service.ui.manage(state.player, "professor"), { code: "HMP_JOBS_RANK" });
    assert.strictEqual((await employment.get(10, "professor"))?.status, "employed");
});
