import type { HmpLogger } from "../../hmp-lib/types";
import type { HmpMySQL, HmpMySQLMigration } from "../../hmp-mysql/types";
import type {
    HmpCoreAccount,
    HmpCoreCharacter,
    HmpCoreGroup,
    HmpCoreIdentityProvider,
    HmpCorePrincipal,
} from "../types";

export type Player = HogwartsMpPlayer;
export type Database = HmpMySQL;
export type Scope = "account" | "character";

export interface CoreConfig extends Record<string, unknown> {
    maxCharacters: number;
    autoSelectSingleCharacter: boolean;
    duplicateSession: "reject-new" | "replace-old" | "allow-group";
    duplicateSessionGroup: string;
    duplicateSessionMinimumGrade: number;
    kickDuplicateSession: boolean;
    identityOrder: string[];
}

export interface IdentityResult {
    account: HmpCoreAccount;
    principal: HmpCorePrincipal;
}

export interface Repository {
    findIdentity(provider: string, subject: string): Promise<IdentityResult | null>;
    findOrCreateAccount(principal: HmpCorePrincipal, displayName: string): Promise<HmpCoreAccount>;
    linkIdentity(accountId: number, principal: HmpCorePrincipal): Promise<boolean>;
    findAccountById(id: number): Promise<HmpCoreAccount | null>;
    touchAccount(id: number, displayName: string): Promise<number>;
    listCharacters(accountId: number): Promise<HmpCoreCharacter[]>;
    findCharacterById(id: number): Promise<HmpCoreCharacter | null>;
    createCharacter(accountId: number, data: { name: string; slot: number }): Promise<HmpCoreCharacter>;
    deleteCharacter(id: number): Promise<boolean>;
    listAccountGroups(accountId: number): Promise<HmpCoreGroup[]>;
    listCharacterGroups(characterId: number): Promise<HmpCoreGroup[]>;
    setGroup(scope: Scope, ownerId: number, key: string, grade: number, metadata: Record<string, unknown>): Promise<HmpCoreGroup>;
    removeGroup(scope: Scope, ownerId: number, key: string): Promise<boolean>;
    getMetadata(scope: Scope, ownerId: number, key: string): Promise<unknown | undefined>;
    setMetadata<T>(scope: Scope, ownerId: number, key: string, value: T): Promise<T>;
    deleteMetadata(scope: Scope, ownerId: number, key: string): Promise<boolean>;
}

export interface CoreEvents {
    emit(eventName: string, payload: unknown): unknown;
}

export interface CoreOptions {
    repository: Repository;
    database: Database;
    migrations?: HmpMySQLMigration[];
    events?: CoreEvents | null;
    listPlayers?: () => Player[];
    logger?: Pick<HmpLogger, "error">;
    config?: Partial<CoreConfig>;
}

export interface ProviderEntry extends HmpCoreIdentityProvider<Player> {
    priority: number;
    trust: string;
}
