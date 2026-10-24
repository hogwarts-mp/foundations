import type { HmpDoorGateKind } from "../types";

const GATE_KINDS: ReadonlyArray<HmpDoorGateKind> = ["portcullis", "runeGate", "swingGate", "crawlGrate"];

// The host's Gates.setPolicy throws on a kind it does not know, so both ends check against the same list.
function isGateKind(value: unknown): value is HmpDoorGateKind {
    return GATE_KINDS.includes(value as HmpDoorGateKind);
}

export = { GATE_KINDS, isGateKind };
