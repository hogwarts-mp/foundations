import type { HmpBankPermission, HmpBankTransaction } from "../hmp-banking/types";
import type { HmpInteractionWorldObject, HmpInteractVector3 } from "../hmp-interact/types";

export interface HmpJobPlayer {
    id: number;
    nickname?: string;
    connected?: boolean;
    position: HmpInteractVector3;
    virtualWorld?: number;
    emit(eventName: string, payload?: unknown): void;
}

export interface HmpJobGrade {
    level: number;
    label: string;
    salary?: number;
    permissions?: ReadonlyArray<string>;
    bankPermissions?: ReadonlyArray<HmpBankPermission>;
}

export interface HmpJobDutyPoint {
    id: string;
    label?: string;
    description?: string;
    position: HmpInteractVector3;
    areaId?: string;
    regionId?: string;
    radius?: number;
    promptDistance?: number;
    promptOffsetZ?: number;
    virtualWorld?: number;
    object?: HmpInteractionWorldObject;
}

export interface HmpJobBanking {
    organizationId?: string;
    currency?: string;
}

export interface HmpJobPayroll {
    /** Pay period; minimum one minute. */
    intervalMs: number;
    /** Defaults true. */
    requireDuty?: boolean;
    /** Organization transfers preserve a funded employer account; system credits mint salary. Defaults to organization when banking is configured, otherwise system. */
    source?: "organization" | "system";
}

export interface HmpJobDutyContext<P = HmpJobPlayer> {
    player: P;
    character: { id: number };
    job: HmpJobDefinition<P>;
    employment: HmpEmployment;
    onDuty: boolean;
}

export interface HmpJobDefinition<P = HmpJobPlayer> {
    id: string;
    resource: string;
    label: string;
    description?: string;
    /** hmp-core character group projection. Defaults to job:<id>. */
    group?: string;
    defaultGrade?: number;
    grades: ReadonlyArray<HmpJobGrade>;
    banking?: false | HmpJobBanking;
    payroll?: HmpJobPayroll;
    dutyPoints?: ReadonlyArray<HmpJobDutyPoint>;
    canDuty?(context: HmpJobDutyContext<P>): boolean | string | Promise<boolean | string>;
}

export interface HmpEmployment {
    characterId: number;
    characterName: string;
    jobId: string;
    grade: number;
    status: "employed" | "terminated";
    active: boolean;
    hiredBy: number | null;
    hiredAt: string | Date;
    updatedAt: string | Date;
    terminatedAt: string | Date | null;
    lastPaidAt: string | Date | null;
}

export interface HmpDutyState {
    playerId: number;
    characterId: number;
    jobId: string;
    since: string | Date;
}

export interface HmpJobMutationOptions<P = HmpJobPlayer> {
    /** Owning resource written to the audit ledger. Defaults to hmp-jobs. `hmp-admin` bypasses the grade cap. */
    resource?: string;
    /**
     * Character acting through their own employment in the job. Hire, setGrade, and fire are capped
     * strictly below the actor's grade and refused with `HMP_JOBS_RANK` otherwise. Omit for
     * system-originated changes, which are exempt.
     */
    actor?: P | number | null;
    reason?: string;
    metadata?: Record<string, unknown>;
}

export interface HmpJobPayrollOptions {
    reference?: string;
}

export interface HmpJobPayrollResult {
    employment: HmpEmployment;
    transaction: HmpBankTransaction;
}

export interface HmpJobAuditEntry {
    id: number;
    characterId: number;
    jobId: string;
    /** `denied` records a hire, grade change, or dismissal refused by the grade cap. */
    action: "hired" | "fired" | "grade" | "active" | "duty_on" | "duty_off" | "paid" | "denied" | string;
    actorCharacterId: number | null;
    fromGrade: number | null;
    toGrade: number | null;
    resource: string;
    reason: string;
    metadata: Record<string, unknown>;
    createdAt: string | Date;
}

export interface HmpJobsRegistryApi<P = HmpJobPlayer> {
    register(definition: HmpJobDefinition<P>): () => boolean;
    unregister(id: string, resource?: string): boolean;
    get(id: string): HmpJobDefinition<P> | null;
    list(resource?: string): HmpJobDefinition<P>[];
}

export interface HmpEmploymentApi<P = HmpJobPlayer> {
    hire(target: P | number, jobId: string, grade?: number, options?: HmpJobMutationOptions<P>): Promise<HmpEmployment>;
    fire(target: P | number, jobId: string, options?: HmpJobMutationOptions<P>): Promise<HmpEmployment>;
    setGrade(target: P | number, jobId: string, grade: number, options?: HmpJobMutationOptions<P>): Promise<HmpEmployment>;
    setActive(target: P | number, jobId: string, options?: HmpJobMutationOptions<P>): Promise<HmpEmployment>;
    get(target: P | number, jobId: string): Promise<HmpEmployment | null>;
    list(target: P | number): Promise<HmpEmployment[]>;
    employees(jobId: string, includeTerminated?: boolean): Promise<HmpEmployment[]>;
}

export interface HmpDutyApi<P = HmpJobPlayer> {
    set(player: P, jobId: string, onDuty: boolean): Promise<HmpDutyState | null>;
    toggle(player: P, jobId: string): Promise<HmpDutyState | null>;
    get(player: P | number): HmpDutyState | null;
    isOnDuty(player: P | number, jobId?: string): boolean;
    list(jobId?: string): HmpDutyState[];
}

export interface HmpJobPermissionsApi<P = HmpJobPlayer> {
    has(target: P | number, permission: string, jobId?: string): Promise<boolean>;
    list(target: P | number, jobId?: string): Promise<string[]>;
}

export interface HmpJobPayrollApi {
    pay(characterId: number, jobId: string, options?: HmpJobPayrollOptions): Promise<HmpJobPayrollResult>;
    run(jobId?: string): Promise<HmpJobPayrollResult[]>;
}

export interface HmpJobsUiApi<P = HmpJobPlayer> {
    open(player: P): Promise<unknown>;
    manage(player: P, jobId: string): Promise<unknown>;
    close(player: P): boolean;
}

export interface HmpJobsAuditApi {
    history(characterId: number, jobId?: string, limit?: number): Promise<HmpJobAuditEntry[]>;
}

export interface HmpJobsStatus {
    state: "starting" | "ready" | "degraded" | "stopped";
    lastError: string;
    jobs: number;
    onDuty: number;
    openMenus: number;
    payrollRunning: boolean;
    uptimeMs: number;
}

export interface HmpJobs<P = HmpJobPlayer> {
    jobs: HmpJobsRegistryApi<P>;
    employment: HmpEmploymentApi<P>;
    duty: HmpDutyApi<P>;
    permissions: HmpJobPermissionsApi<P>;
    payroll: HmpJobPayrollApi;
    ui: HmpJobsUiApi<P>;
    audit: HmpJobsAuditApi;
    status(): HmpJobsStatus;
}
