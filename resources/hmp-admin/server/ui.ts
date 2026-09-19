import type { HmpBankTransaction } from "../../hmp-banking/types";
import type { HmpUiContextOption, HmpUiInputField, HmpUiSelectOption } from "../../hmp-ui/types";
import type { HmpAdmin, HmpAdminBan, HmpAdminCapability, HmpAdminPlayerSummary } from "../types";
import type { Banking, Inventory, Player, Spells, Ui } from "./internal";

type AdminService = Pick<HmpAdmin<Player>, "permissions" | "players" | "actions" | "moderation" | "audit" | "status">;

const MAX_INVENTORY_CHOICES = 32;
const MAX_SPELL_CHOICES = 32;
type SpellOperation = "grant" | "revoke";

function inventoryOptions(inventory: Inventory, rawQuery = ""): HmpUiSelectOption[] {
    const query = String(rawQuery || "").trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    return inventory.items.list()
        .flatMap((item) => {
            const label = item.label || item.nativeId || item.name;
            const names = [label, item.name, item.nativeId, ...(item.aliases || [])].filter(Boolean).map((value) => String(value).toLowerCase());
            const haystack = [...names, item.category, item.holder].filter(Boolean).join(" ").toLowerCase();
            if (terms.some((term) => !haystack.includes(term))) return [];
            const rank = !query ? 2 : names.includes(query) ? 0 : names.some((value) => value.startsWith(query)) ? 1 : 2;
            return [{
                label: item.nativeId ? `${label} · ${item.nativeId}` : `${label} · ${item.name}`,
                value: item.name,
                description: [item.native ? "Native" : "Custom", item.category, item.holder].filter(Boolean).join(" · "),
                rank,
            }];
        })
        .sort((left, right) => left.rank - right.rank || left.label.localeCompare(right.label))
        .map(({ rank: _rank, ...option }) => option);
}

function inventoryItemField(items: HmpUiSelectOption[], query: string): HmpUiInputField {
    return {
        name: "item", label: "Item", type: "select", searchable: true, required: true,
        default: items[0]?.value,
        placeholder: "Filter matching items…",
        description: `${items.length} match${items.length === 1 ? "" : "es"} for '${query}'. Best match selected.`,
        options: items,
    };
}

function spellOptions(spells: Spells, rawQuery = "", granted: ReadonlyArray<string> = [], operation: SpellOperation = "grant"): HmpUiSelectOption[] {
    const query = String(rawQuery || "").trim().toLowerCase();
    const terms = query.split(/\s+/).filter(Boolean);
    const current = new Set(granted);
    const definitions = operation === "revoke"
        ? [...current].flatMap((spell) => { const definition = spells.catalog.get(spell); return definition ? [definition] : []; })
        : spells.catalog.list(query);
    const seen = new Set<string>();
    return definitions.flatMap((definition) => {
        if (seen.has(definition.lockId)) return [];
        if (operation === "grant" && current.has(definition.lockId)) return [];
        const haystack = `${definition.name} ${definition.lockId}`.toLowerCase();
        if (terms.some((term) => !haystack.includes(term))) return [];
        seen.add(definition.lockId);
        return [{
            label: definition.name,
            value: definition.lockId,
            description: operation === "revoke" ? `${definition.lockId} · Personally granted` : definition.lockId,
        }];
    }).sort((left, right) => left.label.localeCompare(right.label));
}

function createAdminUi(options: { admin: AdminService; ui: Ui; banking: Banking; inventory: Inventory; spells: Spells }) {
    const { admin, ui, banking, inventory, spells } = options;
    const openMenus = new Set<number>();

    const text = (value: unknown): string => String(value ?? "").trim();
    const number = (value: unknown): number => Number(value) || 0;
    const date = (value: string | Date | null): string => value ? new Date(value).toLocaleString() : "Never";
    const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
    const allowed = (capabilities: HmpAdminCapability[], capability: HmpAdminCapability): boolean => capabilities.includes(capability);

    function notifyError(player: Player, error: unknown): void {
        ui.notify(player, { title: "Admin action failed", description: errorMessage(error), tone: "error", duration: 7000 });
    }

    async function authenticate(player: Player): Promise<boolean> {
        if (await admin.permissions.has(player, "admin.view")) return true;
        if (!admin.status().bootstrapEnabled) {
            ui.notify(player, { title: "Access denied", description: "Your verified identity does not have an administrative role.", tone: "error" });
            return false;
        }
        const result = await ui.input(player, {
            title: "Closed-test administrator access",
            fields: [{
                name: "secret", label: "Bootstrap secret", type: "password", required: true,
                description: "Temporary access for this connected session only. The value is never stored.",
            }],
            submitLabel: "Authenticate",
        });
        if (!result || !await admin.permissions.authenticate(player, text(result.secret))) {
            ui.notify(player, { title: "Access denied", description: "The bootstrap secret was not accepted.", tone: "error" });
            return false;
        }
        ui.notify(player, { title: "Temporary access granted", description: "This access ends when you disconnect or the resource restarts.", tone: "warning", duration: 8000 });
        return true;
    }

    async function reason(player: Player, title: string, fallback: string): Promise<string | null> {
        const result = await ui.input(player, { title, fields: [{ name: "reason", label: "Reason", type: "textarea", required: true, default: fallback }], submitLabel: "Continue" });
        return result ? text(result.reason) : null;
    }

    async function run(player: Player, work: () => Promise<unknown>, success: string): Promise<void> {
        try {
            await work();
            ui.notify(player, { description: success, tone: "success" });
        } catch (error) { notifyError(player, error); }
    }

    function playerMetadata(target: HmpAdminPlayerSummary) {
        return [
            { label: "Account", value: `#${target.account.id} ${target.account.displayName}` },
            { label: "Character", value: target.character ? `#${target.character.id} ${target.character.name}` : "None" },
            { label: "Identity", value: `${target.principal.provider}:${target.principal.subject} (${target.principal.trust})` },
            { label: "World / ping", value: `${target.virtualWorld} / ${target.ping}ms` },
            { label: "Area / region", value: target.location ? `${target.location.areaId} / ${target.location.regionId || "—"}` : "Loading / unavailable" },
            { label: "Position", value: `${target.position.x.toFixed(1)}, ${target.position.y.toFixed(1)}, ${target.position.z.toFixed(1)}` },
            { label: "Yaw", value: target.location ? `${target.location.yaw.toFixed(1)}°` : "—" },
            { label: "Groups", value: target.groups.length ? target.groups.map((group) => `${group.key}:${group.grade}`).join(", ") : "None" },
        ];
    }

    async function inventoryMenu(player: Player, target: HmpAdminPlayerSummary): Promise<void> {
        while (openMenus.has(player.id)) {
            const search = await ui.input(player, {
                title: `Search inventory catalog · ${target.nickname}`,
                fields: [{
                    name: "query", label: "Item search", required: true,
                    placeholder: "BroomHouse, broom, Wiggenweld, native:galleons…",
                    description: "Searches friendly names, Foundations names, native IDs, aliases, categories, and holders.",
                }],
                submitLabel: "Find items",
            });
            if (!search) return;
            const query = text(search.query);
            const items = inventoryOptions(inventory, query);
            if (!items.length) {
                ui.notify(player, { title: "No matching items", description: `Nothing in the registered catalog matches '${query}'.`, tone: "warning" });
                continue;
            }
            if (items.length > MAX_INVENTORY_CHOICES) {
                ui.notify(player, {
                    title: "Refine item search",
                    description: `${items.length} items match '${query}'. Narrow the search to ${MAX_INVENTORY_CHOICES} or fewer results.`,
                    tone: "warning",
                    duration: 7000,
                });
                continue;
            }
            const result = await ui.input(player, {
                title: `Inventory · ${target.nickname}`,
                fields: [
                    { name: "operation", label: "Operation", type: "select", options: [{ label: "Give", value: "give" }, { label: "Remove", value: "remove" }] },
                    inventoryItemField(items, query),
                    { name: "amount", label: "Amount", type: "number", min: 1, max: 100000, default: 1, required: true },
                    { name: "reason", label: "Reason (optional)", type: "textarea", placeholder: "Add a note for the audit log…" },
                ],
                submitLabel: "Apply",
            });
            if (!result) return;
            await run(player, () => admin.actions.inventory(player, target.playerId, text(result.operation) as "give" | "remove", text(result.item), number(result.amount), text(result.reason)), "Inventory updated.");
            return;
        }
    }

    async function groupMenu(player: Player, target: HmpAdminPlayerSummary): Promise<void> {
        const result = await ui.input(player, {
            title: `Groups · ${target.nickname}`,
            fields: [
                { name: "operation", label: "Operation", type: "select", options: [{ label: "Set grade", value: "set" }, { label: "Remove", value: "remove" }] },
                { name: "scope", label: "Scope", type: "select", options: [{ label: "Character", value: "character" }, { label: "Account", value: "account" }] },
                { name: "group", label: "Group key", required: true },
                { name: "grade", label: "Grade", type: "number", min: 0, max: 1000, default: 0 },
                { name: "reason", label: "Reason", type: "textarea", required: true },
            ],
            submitLabel: "Apply",
        });
        if (!result) return;
        await run(player, () => admin.actions.group(player, target.playerId, text(result.operation) as "set" | "remove", text(result.scope) as "account" | "character", text(result.group), number(result.grade), text(result.reason)), "Group membership updated.");
    }

    async function spellMenu(player: Player, target: HmpAdminPlayerSummary): Promise<void> {
        while (openMenus.has(player.id)) {
            let granted: string[];
            try { granted = await admin.actions.spellGrants(player, target.playerId); }
            catch (error) { notifyError(player, error); return; }
            const search = await ui.input(player, {
                title: `Search spells · ${target.nickname}`,
                fields: [
                    { name: "operation", label: "Operation", type: "select", options: [{ label: "Grant", value: "grant" }, { label: "Revoke personal grant", value: "revoke" }] },
                    { name: "query", label: "Spell search", placeholder: "Incendio, lev, Spell_Accio…", description: "Searches spell names and native lock IDs." },
                ],
                submitLabel: "Find spells",
            });
            if (!search) return;
            const operation = text(search.operation) as SpellOperation;
            const query = text(search.query);
            const choices = spellOptions(spells, query, granted, operation);
            if (!choices.length) {
                ui.notify(player, {
                    title: operation === "revoke" ? "No matching personal grants" : "No matching spells",
                    description: operation === "revoke" ? `This character has no personal spell grant matching '${query || "all spells"}'.` : `No ungranted catalog spell matches '${query || "all spells"}'.`,
                    tone: "warning",
                });
                continue;
            }
            if (choices.length > MAX_SPELL_CHOICES) {
                ui.notify(player, { title: "Refine spell search", description: `${choices.length} spells match. Narrow the search to ${MAX_SPELL_CHOICES} or fewer results.`, tone: "warning", duration: 7000 });
                continue;
            }
            const result = await ui.input(player, {
                title: `Spells · ${target.nickname}`,
                fields: [
                    { name: "spell", label: "Spell", type: "select", searchable: true, required: true, options: choices },
                    { name: "reason", label: "Reason", type: "textarea", required: true },
                ],
                submitLabel: operation === "grant" ? "Grant spell" : "Revoke grant",
            });
            if (!result) return;
            try {
                const changed = await admin.actions.spell(player, target.playerId, operation, text(result.spell), text(result.reason));
                ui.notify(player, {
                    description: changed ? `Personal spell grant ${operation === "grant" ? "added" : "revoked"}.` : `The personal spell grant was already ${operation === "grant" ? "present" : "absent"}.`,
                    tone: changed ? "success" : "inform",
                });
            } catch (error) { notifyError(player, error); }
            return;
        }
    }

    async function jobMenu(player: Player, target: HmpAdminPlayerSummary): Promise<void> {
        const result = await ui.input(player, {
            title: `Employment · ${target.nickname}`,
            fields: [
                { name: "operation", label: "Operation", type: "select", options: [{ label: "Hire", value: "hire" }, { label: "Set grade", value: "grade" }, { label: "Fire", value: "fire" }] },
                { name: "job", label: "Job ID", required: true },
                { name: "grade", label: "Grade", type: "number", min: 0, max: 1000, default: 0 },
                { name: "reason", label: "Reason", type: "textarea", required: true },
            ],
            submitLabel: "Apply",
        });
        if (!result) return;
        await run(player, () => admin.actions.job(player, target.playerId, text(result.operation) as "hire" | "fire" | "grade", text(result.job), number(result.grade), text(result.reason)), "Employment updated.");
    }

    async function bankingMenu(player: Player, target: HmpAdminPlayerSummary): Promise<void> {
        const result = await ui.input(player, {
            title: `Banking · ${target.nickname}`,
            fields: [
                { name: "operation", label: "Operation", type: "select", options: [{ label: "Credit", value: "credit" }, { label: "Debit", value: "debit" }] },
                { name: "amount", label: "Amount", type: "number", min: 1, max: 100000000, required: true },
                { name: "currency", label: "Currency", default: "galleons", required: true },
                { name: "reason", label: "Reason", type: "textarea", required: true },
            ],
            submitLabel: "Apply",
        });
        if (!result) return;
        await run(player, () => admin.actions.banking(player, target.playerId, text(result.operation) as "credit" | "debit", number(result.amount), text(result.currency), text(result.reason)), "Bank balance updated.");
    }

    async function banMenu(player: Player, target: HmpAdminPlayerSummary): Promise<void> {
        const result = await ui.input(player, {
            title: `Ban · ${target.nickname}`,
            fields: [
                { name: "hours", label: "Duration in hours (0 = permanent)", type: "number", min: 0, max: 87600, default: 0 },
                { name: "reason", label: "Reason", type: "textarea", required: true },
            ],
            submitLabel: "Ban player",
        });
        if (!result) return;
        await run(player, () => admin.moderation.ban(player, target.playerId, text(result.reason), number(result.hours)), "Player banned.");
    }

    async function warningHistory(player: Player, target: HmpAdminPlayerSummary): Promise<void> {
        try {
            const warnings = await admin.moderation.warnings(player, target.playerId);
            await ui.context(player, {
                title: `Warnings · ${target.nickname}`,
                description: warnings.length ? `${warnings.length} most recent warning(s).` : "No warnings recorded.",
                options: warnings.length ? warnings.slice(0, 32).map((warning) => ({ id: `warning:${warning.id}`, title: `#${warning.id} · ${date(warning.createdAt)}`, description: warning.reason, metadata: [{ label: "Actor account", value: String(warning.actorAccountId ?? "System") }] })) : [{ id: "empty", title: "No warnings", disabled: true }],
            });
        } catch (error) { notifyError(player, error); }
    }

    async function playerMenu(player: Player, playerId: number, capabilities: HmpAdminCapability[]): Promise<void> {
        while (openMenus.has(player.id)) {
            let target: HmpAdminPlayerSummary;
            try { target = await admin.players.get(player, playerId); }
            catch (error) { notifyError(player, error); return; }
            const actions: HmpUiContextOption[] = [{ id: "details", title: `${target.nickname} · #${target.playerId}`, description: target.frozen ? "Currently frozen by hmp-admin" : "Connected", disabled: true, metadata: playerMetadata(target) }];
            if (allowed(capabilities, "admin.teleport")) actions.push({ id: "goto", title: "Go to player", description: "Stream your character near this player." }, { id: "bring", title: "Bring player", description: "Stream this player near your character." });
            if (allowed(capabilities, "admin.freeze")) actions.push({ id: target.frozen ? "release" : "freeze", title: target.frozen ? "Release player" : "Freeze player", description: "Uses the Framework's authoritative movement hold." });
            if (allowed(capabilities, "admin.warn")) actions.push({ id: "warn", title: "Issue warning", description: "Record and deliver a staff warning." }, { id: "warnings", title: "Warning history", description: "Review prior warnings." });
            if (allowed(capabilities, "admin.inventory")) actions.push({ id: "inventory", title: "Inventory", description: "Give or remove a registered custom or native item." });
            if (allowed(capabilities, "admin.spells")) actions.push({ id: "spells", title: "Spells", description: "Grant or revoke this character's persistent personal spell entitlements." });
            if (allowed(capabilities, "admin.groups")) actions.push({ id: "groups", title: "Groups", description: "Change account or character roles." });
            if (allowed(capabilities, "admin.jobs")) actions.push({ id: "jobs", title: "Employment", description: "Hire, fire, or change a job grade." });
            if (allowed(capabilities, "admin.banking")) actions.push({ id: "banking", title: "Banking", description: "Apply an audited credit or debit." });
            if (allowed(capabilities, "admin.kick")) actions.push({ id: "kick", title: "Kick player", description: "Disconnect this player with a recorded reason.", tone: "warning" });
            if (allowed(capabilities, "admin.ban")) actions.push({ id: "ban", title: "Ban player", description: target.principal.trust === "verified" ? "Create a verified identity ban." : "Unavailable unless asserted bans are explicitly enabled.", tone: "error" });
            const choice = await ui.context(player, { title: "Player administration", options: actions });
            if (!choice || choice === "details") return;
            if (choice === "goto" || choice === "bring" || choice === "freeze" || choice === "release") await run(player, () => admin.actions[choice](player, target.playerId), `${choice[0].toUpperCase()}${choice.slice(1)} completed.`);
            else if (choice === "warn" || choice === "kick") {
                const why = await reason(player, `${choice === "warn" ? "Warn" : "Kick"} · ${target.nickname}`, choice === "warn" ? "Staff warning" : "Removed by an administrator");
                if (why) await run(player, () => choice === "warn" ? admin.moderation.warn(player, target.playerId, why) : admin.actions.kick(player, target.playerId, why), choice === "warn" ? "Warning recorded and delivered." : "Player kicked.");
                if (choice === "kick") return;
            } else if (choice === "warnings") await warningHistory(player, target);
            else if (choice === "inventory") await inventoryMenu(player, target);
            else if (choice === "spells") await spellMenu(player, target);
            else if (choice === "groups") await groupMenu(player, target);
            else if (choice === "jobs") await jobMenu(player, target);
            else if (choice === "banking") await bankingMenu(player, target);
            else if (choice === "ban") { await banMenu(player, target); return; }
        }
    }

    async function playersMenu(player: Player, capabilities: HmpAdminCapability[]): Promise<void> {
        try {
            const players = await admin.players.list(player);
            const choice = await ui.context(player, {
                title: "Connected players",
                description: `${players.length} account session(s) ready.`,
                options: players.length ? players.slice(0, 32).map((target) => ({
                    id: `player:${target.playerId}`, title: `${target.nickname} · #${target.playerId}`,
                    description: `${target.character?.name || "No character"} · ${target.principal.trust} identity`,
                    metadata: [{ label: "Account", value: `#${target.account.id}` }, { label: "World", value: String(target.virtualWorld) }, { label: "Ping", value: `${target.ping}ms` }],
                })) : [{ id: "empty", title: "No ready players", disabled: true }],
            });
            if (choice?.startsWith("player:")) await playerMenu(player, Number(choice.slice(7)), capabilities);
        } catch (error) { notifyError(player, error); }
    }

    async function reconcileMenu(player: Player): Promise<void> {
        try {
            const pending = await banking.transactions.pending(32);
            const choice = await ui.context(player, {
                title: "Pending bank transactions",
                description: "Recovery is permanent and always audited. Inspect application state before resolving.",
                options: pending.length ? pending.map((entry) => ({ id: `tx:${entry.id}`, title: entry.reference, description: `${entry.type} ${entry.amount} ${entry.currency}`, metadata: [{ label: "Created", value: date(entry.createdAt) }, { label: "Error", value: entry.error || "None" }] })) : [{ id: "empty", title: "No pending transactions", disabled: true }],
            });
            if (!choice?.startsWith("tx:")) return;
            const transaction = pending.find((entry) => entry.id === Number(choice.slice(3)));
            if (!transaction) return;
            await reconcileTransaction(player, transaction);
        } catch (error) { notifyError(player, error); }
    }

    async function reconcileTransaction(player: Player, transaction: HmpBankTransaction): Promise<void> {
        const result = await ui.input(player, {
            title: `Reconcile · ${transaction.reference}`,
            fields: [
                { name: "resolution", label: "Resolution", type: "select", options: [{ label: "Mark complete", value: "complete" }, { label: "Compensate", value: "compensate" }, { label: "Mark failed", value: "fail" }] },
                { name: "reason", label: "Recovery notes", type: "textarea", required: true },
            ],
            submitLabel: "Resolve permanently",
        });
        if (!result) return;
        await run(player, () => admin.actions.reconcile(player, transaction.reference, text(result.resolution) as "complete" | "compensate" | "fail", text(result.reason)), "Transaction reconciled.");
    }

    async function auditMenu(player: Player): Promise<void> {
        try {
            const entries = await admin.audit.history(player, 32);
            await ui.context(player, {
                title: "Recent administrative audit",
                options: entries.length ? entries.map((entry) => ({ id: `audit:${entry.id}`, title: `#${entry.id} · ${entry.action}`, description: entry.reason, tone: entry.status === "failed" ? "error" : entry.status === "pending" ? "warning" : "success", metadata: [{ label: "Status", value: entry.status }, { label: "Actor", value: String(entry.actorAccountId ?? "System") }, { label: "Target", value: String(entry.targetAccountId ?? "None") }, { label: "Time", value: date(entry.createdAt) }, ...(entry.error ? [{ label: "Error", value: entry.error }] : [])] })) : [{ id: "empty", title: "No audit entries", disabled: true }],
            });
        } catch (error) { notifyError(player, error); }
    }

    async function unbanMenu(player: Player, ban: HmpAdminBan): Promise<void> {
        const why = await reason(player, `Revoke ban #${ban.id}`, "Ban revoked after staff review");
        if (why) await run(player, () => admin.moderation.unban(player, ban.id, why), "Ban revoked.");
    }

    async function bansMenu(player: Player): Promise<void> {
        try {
            const bans = await admin.moderation.bans(player, 32);
            const choice = await ui.context(player, {
                title: "Recent bans",
                description: "Select an active ban to revoke it.",
                options: bans.length ? bans.map((ban) => ({ id: `ban:${ban.id}`, title: `#${ban.id} · Account ${ban.accountId}`, description: ban.reason, disabled: Boolean(ban.revokedAt), tone: ban.revokedAt ? "inform" : "error", metadata: [{ label: "Identity", value: `${ban.provider}:${ban.subject}` }, { label: "Expires", value: date(ban.expiresAt) }, { label: "Revoked", value: date(ban.revokedAt) }] })) : [{ id: "empty", title: "No bans recorded", disabled: true }],
            });
            if (!choice?.startsWith("ban:")) return;
            const ban = bans.find((entry) => entry.id === Number(choice.slice(4)));
            if (ban && !ban.revokedAt) await unbanMenu(player, ban);
        } catch (error) { notifyError(player, error); }
    }

    async function open(player: Player): Promise<boolean> {
        if (openMenus.has(player.id)) return false;
        openMenus.add(player.id);
        try {
            if (!await authenticate(player)) return false;
            while (openMenus.has(player.id)) {
                const capabilities = await admin.permissions.capabilities(player);
                const menu = [{ id: "players", title: "Connected players", description: "Inspect, moderate, and correct a connected account." }];
                if (allowed(capabilities, "admin.noclip")) menu.push({ id: "noclip", title: "Toggle no-clip", description: "Fly through geometry with WASD, Space/Ctrl, and Shift to boost." });
                if (allowed(capabilities, "admin.reconcile")) menu.push({ id: "reconcile", title: "Pending banking recovery", description: "Resolve transactions left in a pending state." });
                if (allowed(capabilities, "admin.ban")) menu.push({ id: "bans", title: "Ban records", description: "Review and revoke identity bans." });
                if (allowed(capabilities, "admin.audit")) menu.push({ id: "audit", title: "Administrative audit", description: "Review recent successful, failed, and pending actions." });
                const choice = await ui.context(player, { title: "HMP Administration", description: "Closed-test moderation and recovery tools", options: menu });
                if (!choice) break;
                if (choice === "players") await playersMenu(player, capabilities);
                else if (choice === "noclip") {
                    try {
                        const enabled = await admin.actions.noclip(player);
                        ui.notify(player, { title: `No-clip ${enabled ? "enabled" : "disabled"}`, description: enabled ? "WASD to move, Space/Ctrl for height, Shift to boost. Reopen /admin to turn it off." : "Collision restored; fall protection remains until landing.", tone: enabled ? "success" : "inform", duration: 7000 });
                        if (enabled) break;
                    } catch (error) { notifyError(player, error); }
                }
                else if (choice === "reconcile") await reconcileMenu(player);
                else if (choice === "bans") await bansMenu(player);
                else if (choice === "audit") await auditMenu(player);
            }
            return true;
        } catch (error) {
            notifyError(player, error);
            return false;
        } finally { openMenus.delete(player.id); }
    }

    return Object.freeze({ open, close: (player: Player) => { openMenus.delete(player.id); return ui.close(player, "Admin menu closed"); }, status: () => ({ openMenus: openMenus.size }) });
}

export = { createAdminUi, inventoryOptions, inventoryItemField, spellOptions };
