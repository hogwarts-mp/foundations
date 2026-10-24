import type { HmpSpellCatalogApi, HmpSpellDefinition } from "../types";

const SPELLS: ReadonlyArray<HmpSpellDefinition> = Object.freeze([
    ["Accio", "Spell_Accio"], ["Aguamenti", "Spell_Aguamenti"], ["AimMode", "Spell_AimMode"],
    ["Alohomora", "Spell_Alohomora"], ["Alohomora_L2", "Spell_Alohomora_L2"], ["Alohomora_L3", "Spell_Alohomora_L3"],
    ["AMPushAOE", "Spell_AMPushAOE"], ["AnimagusForm", "Spell_AnimagusForm"], ["Apparition", "Spell_Apparition"],
    ["ArrestoMomentum", "Spell_ArrestoMomentum"], ["AvadaKedavra", "Spell_AvadaKedavra"],
    ["Bombarda", "Spell_Expulso"], ["Confringo", "Spell_Confringo"], ["Confundo", "Spell_Confundo"],
    ["Conjuration", "Spell_Conjuration"], ["Crucio", "Spell_Crucio"], ["Depulso", "Spell_Depulso"],
    ["Descendo", "Spell_Descendo"], ["Diffindo", "Spell_Diffindo"], ["Disillusionment", "Spell_Disillusionment"],
    ["Engorgio", "Spell_Engorgio"], ["Episkey", "Spell_Episkey"], ["ExpectoPatronum", "Spell_ExpectoPatronum"],
    ["Expelliarmus", "Spell_Expelliarmus"], ["Expulso", "Spell_Expulso"], ["FiendFyre", "Spell_FiendFyre"],
    ["FinisherAMBossKiller", "Spell_FinisherAMBossKiller"],
    ["FinisherBlackParticleExplode", "Spell_FinisherBlackParticleExplode"],
    ["FinisherDeepFreeze", "Spell_FinisherDeepFreeze"], ["FinisherFierySend", "Spell_FinisherFierySend"],
    ["FinisherFireStorm", "Spell_FinisherFireStorm"], ["FinisherLightningStorm", "Spell_FinisherLightningStorm"],
    ["Finishers", "Spell_Finishers"], ["FinisherScarabBurst", "Spell_FinisherScarabBurst"],
    ["FinisherSuperSlams", "Spell_FinisherSuperSlams"], ["Finite", "Spell_Finite"],
    ["Flipendo", "Spell_Flipendo"], ["Glacius", "Spell_Glacius"], ["Imperius", "Spell_Imperius"],
    ["Incarcerous", "Spell_Incarcerous"], ["Incendio", "Spell_Incendio"], ["Levioso", "Spell_Levioso"],
    ["Lumos", "Spell_Lumos"], ["Mechanic_ApparateBlink", "Spell_Mechanic_ApparateBlink"],
    ["Obliviate", "Spell_Obliviate"], ["Oppugno", "Spell_Oppugno"], ["ParryCounter", "Spell_ParryCounter"],
    ["Petrificus", "Spell_Petrificus"], ["Protego", "Spell_Protego"], ["Reducio", "Spell_Reducio"],
    ["Reparo", "Spell_Reparo"], ["Revelio", "Spell_Revelio"], ["Silencio", "Spell_Silencio"],
    ["Stupefy", "Spell_Stupefy"], ["Transformation", "Spell_Transformation"],
    ["TransformationOverland", "Spell_TransformationOverland"], ["Vanishment", "Spell_Vanishment"],
    ["Wingardium", "Spell_Wingardium"],
].map(([name, lockId]) => Object.freeze({ name, lockId })));

const byName = new Map(SPELLS.map((spell) => [spell.name.toLowerCase(), spell]));
const byLock = new Map<string, HmpSpellDefinition>();
for (const spell of SPELLS) if (!byLock.has(spell.lockId.toLowerCase())) byLock.set(spell.lockId.toLowerCase(), spell);

function clean(value: unknown): string {
    return String(value || "").trim();
}

function resolve(spell: string): string | null {
    const value = clean(spell);
    if (!value) return null;
    const known = byName.get(value.toLowerCase()) || byLock.get(value.toLowerCase());
    if (known) return known.lockId;
    return /^Spell_[A-Za-z0-9_]+$/.test(value) ? value : null;
}

// Server-defined spells join by id, each locking as Spell_<id>; a game spell's own name wins a clash.
function createCatalog(defined: () => ReadonlyArray<HmpSpellDefinition> = () => []): HmpSpellCatalogApi {
    function find(spell: string): HmpSpellDefinition | null {
        const value = clean(spell).toLowerCase();
        return byName.get(value) || byLock.get(value)
            || defined().find((entry) => entry.name.toLowerCase() === value || entry.lockId.toLowerCase() === value) || null;
    }

    function get(spell: string): HmpSpellDefinition | null {
        const known = find(spell);
        if (known) return { ...known };
        const lockId = resolve(spell);
        return lockId ? { name: lockId.slice("Spell_".length), lockId } : null;
    }

    function list(search = ""): HmpSpellDefinition[] {
        const query = clean(search).toLowerCase();
        return [...SPELLS, ...defined()].filter((spell) => !query || spell.name.toLowerCase().includes(query) || spell.lockId.toLowerCase().includes(query)).map((spell) => ({ ...spell }));
    }

    return Object.freeze({ resolve: (spell: string) => find(spell)?.lockId ?? resolve(spell), get, list });
}

const catalog = createCatalog();
export = { catalog, createCatalog, SPELLS, resolveSpell: resolve };
