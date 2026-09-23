import type { HmpLibServer } from "../../hmp-lib/types";
import type { CoreConfig, Player } from "./internal";

function loadConfig(Hmp: HmpLibServer<Player>, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): CoreConfig {
    const env = options.env || process.env;
    const cwd = options.cwd || process.cwd();
    const defaults: CoreConfig = {
        maxCharacters: 4,
        autoSelectSingleCharacter: false,
        duplicateSession: "reject-new",
        duplicateSessionGroup: "admin",
        duplicateSessionMinimumGrade: 1,
        kickDuplicateSession: false,
        identityOrder: ["steamId", "discordId", "hardwareId"],
    };
    const config = Hmp.config.load<CoreConfig>(env.HMP_CORE_CONFIG || "data/hmp-core.json", { cwd, defaults });
    if (env.HMP_CORE_MAX_CHARACTERS) {
        config.maxCharacters = Hmp.config.env.number(env.HMP_CORE_MAX_CHARACTERS, config.maxCharacters, { integer: true, min: 1, max: 32 }) ?? config.maxCharacters;
    }
    if (env.HMP_CORE_AUTO_SELECT_SINGLE) config.autoSelectSingleCharacter = Hmp.config.env.boolean(env.HMP_CORE_AUTO_SELECT_SINGLE);
    if (env.HMP_CORE_DUPLICATE_SESSION) config.duplicateSession = env.HMP_CORE_DUPLICATE_SESSION.trim().toLowerCase() as CoreConfig["duplicateSession"];
    if (env.HMP_CORE_DUPLICATE_GROUP) config.duplicateSessionGroup = env.HMP_CORE_DUPLICATE_GROUP.trim().toLowerCase();
    if (env.HMP_CORE_DUPLICATE_MIN_GRADE) {
        config.duplicateSessionMinimumGrade = Hmp.config.env.number(env.HMP_CORE_DUPLICATE_MIN_GRADE, config.duplicateSessionMinimumGrade, { integer: true, min: 0, max: 1000 }) ?? config.duplicateSessionMinimumGrade;
    }
    if (env.HMP_CORE_KICK_DUPLICATE) config.kickDuplicateSession = Hmp.config.env.boolean(env.HMP_CORE_KICK_DUPLICATE);
    if (env.HMP_CORE_IDENTITY_ORDER) config.identityOrder = env.HMP_CORE_IDENTITY_ORDER.split(",").map((value) => value.trim()).filter(Boolean);
    config.duplicateSessionGroup = String(config.duplicateSessionGroup || "").trim().toLowerCase();
    if (!Array.isArray(config.identityOrder) || !config.identityOrder.length) throw new TypeError("hmp-core identityOrder must not be empty");
    if (!["reject-new", "replace-old", "allow-group"].includes(config.duplicateSession)) throw new TypeError("hmp-core duplicateSession must be reject-new, replace-old or allow-group");
    if (!/^[a-z0-9][a-z0-9_.:-]{0,63}$/.test(config.duplicateSessionGroup)) throw new TypeError("hmp-core duplicateSessionGroup must be a valid group key");
    if (!Number.isSafeInteger(config.duplicateSessionMinimumGrade) || config.duplicateSessionMinimumGrade < 0) throw new TypeError("hmp-core duplicateSessionMinimumGrade must be a non-negative integer");
    return config;
}

export = { loadConfig };
// TypeScript source.
