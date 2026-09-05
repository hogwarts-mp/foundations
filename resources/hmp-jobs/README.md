# hmp-jobs

`hmp-jobs` is Foundations's persistent employment layer. It provides code-registered jobs, grades,
permissions, multiple employments with one selected job, runtime duty state, a management menu,
audited changes, and optional payroll through `hmp-banking`.

Jobs do not replace `hmp-core` groups. Every current employment is projected to a character group
(by default `job:<job-id>`), so banking and any other Foundations resource can use the same grade.
Employment remains in MySQL when a defining resource stops; its runtime integrations and group
projection are removed until that resource registers the job again.

## Register a job

```ts
const Jobs = Imports.get("hmp-jobs");

const unregister = Jobs.jobs.register({
    id: "auror",
    resource: "hmp-ministry",
    label: "Auror Office",
    grades: [
        {
            level: 0,
            label: "Trainee",
            salary: 15,
            permissions: ["cases.view"],
            bankPermissions: ["view", "deposit"],
        },
        {
            level: 5,
            label: "Auror",
            salary: 30,
            permissions: ["cases.manage"],
            bankPermissions: ["withdraw", "transfer"],
        },
        {
            level: 10,
            label: "Head Auror",
            salary: 50,
            permissions: ["employees.manage"],
            bankPermissions: ["manage"],
        },
    ],
    banking: {
        organizationId: "ministry-aurors",
        currency: "galleons",
    },
    payroll: {
        intervalMs: 60 * 60 * 1000,
        requireDuty: true,
        source: "organization",
    },
    dutyPoints: [
        {
            id: "office",
            label: "Toggle Auror duty",
            position: { x: 12345, y: 67890, z: 250 },
            areaId: "Hogwarts",
            radius: 250,
        },
    ],
});
```

Grade permissions are cumulative: grade 5 receives permissions declared at grades 0 and 5. Banking
permissions become grade-aware rules on the registered organization account. The first call also
reconnects the organization to its existing balance and creates server-authoritative duty
interactions through `hmp-interact`.

`canDuty(context)` can add a server-side eligibility rule. Return `true` to allow duty, `false` for
the default denial, or a string to show a specific reason.

## Employment and permissions

```ts
await Jobs.employment.hire(characterId, "auror", 0, {
    resource: "hmp-ministry",
    actor: supervisorPlayer,
    reason: "Academy intake",
});

await Jobs.employment.setGrade(characterId, "auror", 5, {
    resource: "hmp-ministry",
    actor: supervisorPlayer,
    reason: "Completed field training",
});

await Jobs.employment.setActive(player, "auror", {
    resource: "hmp-ministry",
    actor: player,
});

if (await Jobs.permissions.has(player, "cases.manage", "auror")) {
    // Trusted server-side action.
}
```

A character may hold several current employments, but only one is selected at a time. Passing no
job ID to `permissions.has/list` checks the selected job. Passing a job ID checks that specific
current employment. Firing an employee retains their row and audit history but removes the core
group projection immediately.

Use `employees.manage` to grant access to the bundled management menu:

```ts
await Jobs.ui.open(player);                 // personal employment menu
await Jobs.ui.manage(player, "auror");      // requires employees.manage
```

The management UI accepts character IDs for hiring because characters can be offline. Names,
grades, permissions, and job definitions are resolved on the server.

### Rank

Every hire, grade change, and dismissal that names an `actor` is capped at that actor's own grade in
the job. The actor must hold current employment there and may only:

- hire at a grade strictly below their own;
- change the grade of an employee below them to another grade below them;
- dismiss an employee below them.

Ties are refused, so two Managers cannot fire each other and nobody can promote themselves. Calls
that pass no `actor`, and calls owned by `hmp-admin` (`resource: "hmp-admin"`), bypass the cap; that
is how an admin seats the first Head of a business. A refused attempt throws `HMP_JOBS_RANK` and is
written to the ledger as a `denied` row, so a Manager probing the boundary is visible to admins. The
management menu applies the same rule up front: grades at or above the manager's own are not
offered, and employees who match or outrank them are greyed out.

## Duty and payroll

```ts
await Jobs.duty.set(player, "auror", true);
await Jobs.duty.toggle(player, "auror");

const payment = await Jobs.payroll.pay(characterId, "auror", {
    reference: `auror-pay:${payPeriod}:${characterId}`,
});
```

Duty is runtime session state and is intentionally not restored after reconnecting or changing
characters. Switching characters, unloading, disconnecting, or stopping the defining resource
clocks the player out. Every duty transition is audited.

Organization-funded payroll transfers Galleons from the job account to the employee's personal bank
account and fails if the employer lacks funds. `source: "system"` explicitly issues new currency
instead. New hires start their first pay interval at hire time; the scheduler checks due payroll once
per minute. Set `requireDuty: false` for jobs that should pay offline employees.

Payroll uses stable bank transaction references, but the final bank transfer and employment pay
timestamp live in separate resources and cannot share one database transaction. The bank ledger
prevents duplicate money movement; job audit history makes recovery reviewable if the process stops
between those two commits.

## Audit and events

```ts
const history = await Jobs.audit.history(characterId, "auror", 50);
```

The ledger records hiring, dismissal, grade changes, selected-job changes, duty transitions, salary
payments, and rank-capped refusals (`denied`) with the acting character, owning resource, reason,
and metadata. A `denied` row names the target character, the grade that was attempted, and the
actor's own grade in its metadata.

Events emitted after successful changes:

- `hmp:jobs:hired`
- `hmp:jobs:fired`
- `hmp:jobs:grade`
- `hmp:jobs:active`
- `hmp:jobs:duty`
- `hmp:jobs:paid`

## Exports

- `jobs`
- `employment`
- `duty`
- `permissions`
- `payroll`
- `ui`
- `audit`
- `status`
