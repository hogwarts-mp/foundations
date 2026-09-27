import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { createRoot } from "react-dom/client";

declare global {
    interface Window {
        callEvent?: (name: string, payload: string) => void;
    }
}

interface CreatorCategory { options: string[]; count: number }
interface CreatorSchema { version: number; gender: number; categories: Record<string, CreatorCategory> }
interface CreatorState {
    gender: number;
    selections: Record<string, string>;
    faceGear: string;
    voice?: { tone: number; pitch: number };
    name?: { first: string; last: string };
}
interface CreatorSnapshot { schema: CreatorSchema; state: CreatorState }
interface CameraFrame { dist: number; height: number; pitch: number; fov: number; shift: number }
interface Section { key: string; label: string; fallbackMax: number }
interface Tab { id: string; title: string; numeral: string; finalise?: boolean; sections: Section[]; camera: CameraFrame }

const T = {
    bg: "#0a0805", panel: "#0e0b07", panelAlt: "#100d08",
    gold: "#d8b56b", goldBright: "#dcb96e", goldSoft: "#cdbb93",
    goldLine: "rgba(201,162,90,.26)", goldLineSoft: "rgba(201,162,90,.12)", goldGlow: "rgba(201,162,90,.4)",
    ink: "#d5c8a9", inkBright: "#f0e3c2", inkInput: "#ecdcb7",
    muted: "#8a7b5f", mutedDim: "#5e553f", label: "#b89a64", dotOff: "#3f3829", error: "#cf7a5e",
    display: "'Cinzel', serif", body: "'Spectral', Georgia, serif", mono: "ui-monospace, monospace",
} as const;

const TABS: Tab[] = [
    { id: "presets", title: "Presets", numeral: "I", sections: [{ key: "preset", label: "Preset", fallbackMax: 30 }], camera: { dist: 290, height: 80, pitch: -5, fov: 36, shift: 0 } },
    { id: "facewear", title: "Facewear", numeral: "II", sections: [
        { key: "faceShape", label: "Face Shape", fallbackMax: 15 }, { key: "skin", label: "Skin Tone", fallbackMax: 24 },
        { key: "eyeColour", label: "Eye Colour", fallbackMax: 25 }, { key: "glasses", label: "Glasses", fallbackMax: 6 },
    ], camera: { dist: 160, height: 77, pitch: -2, fov: 36, shift: 0 } },
    { id: "hair", title: "Hairstyles", numeral: "III", sections: [
        { key: "hairStyle", label: "Hair Style", fallbackMax: 52 }, { key: "hairColour", label: "Hair Colour", fallbackMax: 32 },
    ], camera: { dist: 170, height: 80, pitch: -3, fov: 26, shift: 0 } },
    { id: "complexion", title: "Complexion", numeral: "IV", sections: [
        { key: "marking1", label: "Complexion", fallbackMax: 16 }, { key: "marking0", label: "Freckles and Moles", fallbackMax: 13 },
        { key: "marking2", label: "Scars and Markings", fallbackMax: 14 },
    ], camera: { dist: 170, height: 75, pitch: -2, fov: 26, shift: 0 } },
    { id: "eyebrows", title: "Eyebrows", numeral: "V", sections: [
        { key: "browShape", label: "Brow Shape", fallbackMax: 20 }, { key: "browColour", label: "Brow Colour", fallbackMax: 32 },
    ], camera: { dist: 170, height: 75, pitch: -2, fov: 26, shift: 0 } },
    { id: "finalise", title: "Finalise", numeral: "VI", finalise: true, sections: [], camera: { dist: 405, height: 65, pitch: -4, fov: 36, shift: 0 } },
];

const DEFAULTS: Record<string, number> = {
    preset: 11, faceShape: 7, eyeColour: 12, glasses: 1, hairStyle: 23, hairColour: 9,
    skin: 5, marking0: 3, marking1: 1, marking2: 2, browShape: 6, browColour: 8,
};
const PANEL_W = 460;
const PITCH_MID = 3;
const isHost = typeof window.callEvent === "function";

function emit(name: string, payload: unknown = {}): void {
    if (window.callEvent) window.callEvent(name, JSON.stringify(payload));
    else console.info(`[foundations-creator] ${name}`, payload);
}

function hostEvent<T>(name: string, listener: (detail: T) => void): () => void {
    const handler = (event: Event) => listener((event as CustomEvent<T>).detail);
    window.addEventListener(name, handler);
    return () => window.removeEventListener(name, handler);
}

const bridge = {
    cancel: () => emit("creator:cancel"),
    confirm: (first: string, last: string, dorm: string) => emit("creator:confirm", { first, last, dorm }),
    option: (category: string, index: number) => emit("creator:option", { category, index }),
    camera: (frame: CameraFrame) => emit("creator:camera", frame),
    rotate: (yaw: number) => emit("creator:rotate", { yaw }),
    freeze: (frozen: boolean) => emit("creator:freeze", { frozen }),
    voice: (tone: number, pitch: number) => emit("creator:voice", { tone, pitch }),
    name: (first: string, last: string) => emit("creator:name", { first, last }),
    importLook: (look: unknown) => emit("creator:import", { look }),
    exportLook: () => emit("creator:export"),
};

function Slider({ value, max, onChange }: { value: number; max: number; onChange: (value: number) => void }) {
    const track = useRef<HTMLDivElement>(null);
    const dragging = useRef(false);
    const clamp = (value: number) => Math.min(max, Math.max(1, value));
    const dotCount = Math.min(max, 21);
    const activeDot = max <= 1 ? 0 : Math.round(((value - 1) / (max - 1)) * (dotCount - 1));
    const jump = (clientX: number) => {
        const bounds = track.current?.getBoundingClientRect();
        if (!bounds) return;
        const fraction = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
        onChange(clamp(Math.round(fraction * (max - 1)) + 1));
    };
    const onDown = (event: ReactPointerEvent) => { dragging.current = true; track.current?.setPointerCapture(event.pointerId); jump(event.clientX); };
    const onMove = (event: ReactPointerEvent) => { if (dragging.current) jump(event.clientX); };
    const onUp = (event: ReactPointerEvent) => { dragging.current = false; track.current?.releasePointerCapture(event.pointerId); };
    const arrow: CSSProperties = { flex: "none", width: 30, height: 30, borderRadius: "50%", border: `1px solid ${T.goldLine}`, display: "grid", placeItems: "center", color: T.goldSoft, fontSize: 18, cursor: "pointer", userSelect: "none" };
    return <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <button className="hmp-hover" type="button" style={{ ...arrow, background: "transparent" }} onClick={() => onChange(clamp(value - 1))}>&#8249;</button>
        <div ref={track} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} style={{ flex: 1, position: "relative", height: 26, cursor: "pointer", touchAction: "none" }}>
            <div style={{ position: "absolute", left: 2, right: 2, top: "50%", height: 1, background: "rgba(201,162,90,.16)" }} />
            <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", height: "100%" }}>
                {Array.from({ length: dotCount }, (_, index) => <span key={index} style={index === activeDot
                    ? { width: 14, height: 14, borderRadius: "50%", background: T.goldBright, boxShadow: `0 0 0 3px rgba(201,162,90,.2), 0 0 10px ${T.goldGlow}` }
                    : { width: 5, height: 5, borderRadius: "50%", background: T.dotOff }} />)}
            </div>
        </div>
        <button className="hmp-hover" type="button" style={{ ...arrow, background: "transparent" }} onClick={() => onChange(clamp(value + 1))}>&#8250;</button>
        <div style={{ flex: "none", width: 58, textAlign: "right", fontFamily: T.mono, fontSize: 12, color: "#c2b291" }}>{value} / {max}</div>
    </div>;
}

const buttonStyle: CSSProperties = { padding: "10px 14px", border: `1px solid ${T.goldLine}`, borderRadius: 4, background: T.panelAlt, color: T.ink, fontFamily: T.display, fontSize: 10, letterSpacing: ".14em", cursor: "pointer" };

function ImportDialog({ busy, error, onClose, onImport }: { busy: boolean; error: string; onClose: () => void; onImport: (look: unknown) => void }) {
    const [text, setText] = useState("");
    const [localError, setLocalError] = useState("");
    const input = useRef<HTMLTextAreaElement>(null);
    const file = useRef<HTMLInputElement>(null);
    useEffect(() => { requestAnimationFrame(() => input.current?.focus()); }, []);
    const submit = () => {
        let look: unknown;
        try { look = JSON.parse(text.trim()); }
        catch (_) { setLocalError("That is not valid JSON."); return; }
        if (!look || typeof look !== "object" || Array.isArray(look)) { setLocalError("Look JSON must contain one object."); return; }
        setLocalError("");
        onImport(look);
    };
    return <div role="dialog" aria-modal="true" aria-labelledby="import-title" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }} style={{ position: "fixed", zIndex: 50, inset: 0, display: "grid", placeItems: "center", padding: 28, background: "rgba(4,3,2,.82)", backdropFilter: "blur(5px)" }}>
        <div style={{ width: "min(680px,92vw)", padding: 24, border: `1px solid ${T.goldLine}`, borderRadius: 7, background: T.bg, boxShadow: "0 26px 80px rgba(0,0,0,.72)" }}>
            <div style={{ fontFamily: T.display, fontSize: 10, letterSpacing: ".3em", color: T.label }}>PORTABLE CHARACTER LOOK</div>
            <div id="import-title" style={{ marginTop: 8, fontFamily: T.display, fontSize: 22, color: T.inkBright }}>Import JSON</div>
            <p style={{ color: T.muted, fontSize: 13 }}>Paste an exported look or choose a JSON file. You can keep editing before confirming.</p>
            <textarea ref={input} value={text} onChange={(event) => setText(event.target.value)} readOnly={busy} spellCheck={false} placeholder={'{\n  "format": "hogwartsmp-look",\n  ...\n}'} style={{ width: "100%", minHeight: 310, resize: "vertical", padding: 14, border: `1px solid ${T.goldLine}`, borderRadius: 4, outline: "none", background: "#080604", color: T.inkInput, font: "12px/1.5 ui-monospace, monospace" }} />
            <div style={{ minHeight: 20, marginTop: 8, color: T.error, fontSize: 12 }}>{error || localError}</div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 8 }}>
                <input ref={file} type="file" accept="application/json,.json" hidden onChange={async (event) => { const selected = event.target.files?.[0]; if (selected) setText(await selected.text()); event.currentTarget.value = ""; }} />
                <button className="hmp-hover" type="button" disabled={busy} style={buttonStyle} onClick={() => file.current?.click()}>Choose File</button>
                <button className="hmp-hover" type="button" disabled={busy} style={buttonStyle} onClick={onClose}>Cancel</button>
                <button className="hmp-hover" type="button" disabled={busy} style={{ ...buttonStyle, minWidth: 128, color: "#1a1306", background: T.goldBright, borderColor: T.goldBright, fontWeight: 700 }} onClick={submit}>{busy ? "Importing…" : "Import Look"}</button>
            </div>
        </div>
    </div>;
}

function App() {
    const [open, setOpen] = useState(false);
    const [tabId, setTabId] = useState(TABS[0].id);
    const [schema, setSchema] = useState<CreatorSchema | null>(null);
    const [opts, setOpts] = useState<Record<string, number>>(DEFAULTS);
    const [voice, setVoice] = useState(1);
    const [pitch, setPitch] = useState(PITCH_MID);
    const [first, setFirst] = useState("");
    const [last, setLast] = useState("");
    const [dorm, setDorm] = useState<"witch" | "wizard" | null>(null);
    const [importOpen, setImportOpen] = useState(false);
    const [importBusy, setImportBusy] = useState(false);
    const [importError, setImportError] = useState("");
    const [notice, setNotice] = useState("");
    const importPending = useRef(false);
    const tab = TABS.find((candidate) => candidate.id === tabId) || TABS[0];
    const isFinalise = tab.finalise === true;

    const applySnapshot = (snapshot: CreatorSnapshot) => {
        if (!snapshot?.schema || !snapshot?.state) return;
        setSchema(snapshot.schema);
        const next: Record<string, number> = {};
        for (const section of TABS.flatMap((entry) => entry.sections)) {
            const options = snapshot.schema.categories[section.key]?.options || [];
            if (section.key === "glasses") {
                const index = snapshot.state.faceGear ? options.indexOf(snapshot.state.faceGear) : -1;
                next.glasses = index >= 0 ? index + 2 : 1;
            } else {
                const index = options.indexOf(snapshot.state.selections?.[section.key] || "");
                if (index >= 0) next[section.key] = index + 1;
            }
        }
        setOpts((current) => ({ ...current, ...next }));
        if (snapshot.state.voice) {
            setVoice(Math.max(1, Math.min(2, snapshot.state.voice.tone + 1)));
            setPitch(Math.max(1, Math.min(5, snapshot.state.voice.pitch + PITCH_MID)));
        }
        if (snapshot.state.name) {
            setFirst(snapshot.state.name.first || "");
            setLast(snapshot.state.name.last || "");
        }
    };

    useEffect(() => {
        const removeOpen = hostEvent<CreatorSnapshot>("hmp-creator:open", (snapshot) => { applySnapshot(snapshot); setOpen(true); setNotice(""); });
        const removeSnapshot = hostEvent<CreatorSnapshot>("hmp-creator:snapshot", (snapshot) => {
            applySnapshot(snapshot);
            if (importPending.current) {
                importPending.current = false;
                setImportBusy(false);
                setImportOpen(false);
                setImportError("");
                setNotice("Look imported. Review it, then confirm or copy it when ready.");
            }
        });
        const removeError = hostEvent<{ message?: string }>("hmp-creator:error", (detail) => {
            const message = detail?.message || "The creator action could not be completed.";
            if (importPending.current) { importPending.current = false; setImportBusy(false); setImportError(message); }
            else setNotice(message);
        });
        const removeExport = hostEvent<{ json?: string }>("hmp-creator:export", async (detail) => {
            const text = detail?.json || "";
            let copied = false;
            try { await navigator.clipboard.writeText(text); copied = true; }
            catch (_) {
                const area = document.createElement("textarea"); area.value = text; area.style.position = "fixed"; area.style.opacity = "0";
                document.body.appendChild(area); area.select();
                try { copied = document.execCommand("copy"); } catch (_) { copied = false; }
                area.remove();
            }
            setNotice(copied ? "Character look copied as JSON. You can cancel without creating it." : "Could not copy automatically.");
        });
        emit("creator:ready");
        if (!isHost) {
            const categories = Object.fromEntries(TABS.flatMap((entry) => entry.sections).map((section) => {
                const count = section.key === "glasses" ? section.fallbackMax - 1 : section.fallbackMax;
                return [section.key, { count, options: Array.from({ length: count }, (_, index) => `${section.key}-${index + 1}`) }];
            }));
            applySnapshot({
                schema: { version: 1, gender: 1, categories },
                state: { gender: 1, selections: Object.fromEntries(Object.entries(categories).filter(([key]) => key !== "glasses").map(([key, category]) => [key, category.options[0] || ""])), faceGear: "", voice: { tone: 0, pitch: 0 }, name: { first: "", last: "" } },
            });
            setOpen(true);
        }
        return () => { removeOpen(); removeSnapshot(); removeError(); removeExport(); };
    }, []);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                if (importOpen && !importBusy) setImportOpen(false);
                else { setOpen(false); bridge.cancel(); }
                return;
            }
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
            if (event.key.toLowerCase() === "a") { bridge.rotate(-2.5); event.preventDefault(); }
            if (event.key.toLowerCase() === "d") { bridge.rotate(2.5); event.preventDefault(); }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [importOpen, importBusy]);

    useEffect(() => {
        if (!open) return;
        const push = () => {
            const fraction = Math.min(.6, PANEL_W / Math.max(1, window.innerWidth));
            const autoShift = fraction * tab.camera.dist * Math.tan((tab.camera.fov * Math.PI) / 360);
            bridge.camera({ ...tab.camera, shift: autoShift + tab.camera.shift });
        };
        bridge.freeze(true); push();
        window.addEventListener("resize", push);
        return () => window.removeEventListener("resize", push);
    }, [open, tabId]);

    if (!open) return null;
    const cycle = (direction: number) => { const index = TABS.findIndex((entry) => entry.id === tabId); setTabId(TABS[(index + direction + TABS.length) % TABS.length].id); };
    const sectionMax = (section: Section) => {
        const count = schema?.categories?.[section.key]?.options?.length || section.fallbackMax;
        return section.key === "glasses" ? count + 1 : count;
    };
    const setOption = (key: string, value: number) => { setOpts((current) => ({ ...current, [key]: value })); setNotice(""); bridge.option(key, value); };
    const canConfirm = Boolean(first.trim() && last.trim() && dorm);
    const field: CSSProperties = { padding: "12px 14px", background: T.panel, border: `1px solid ${T.goldLine}`, borderRadius: 4, fontSize: 14, color: T.inkInput, outline: "none" };
    const label = (text: string) => <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}><div style={{ fontFamily: T.display, fontSize: 11, letterSpacing: ".24em", color: T.label }}>{text}</div><div style={{ flex: 1, height: 1, background: "linear-gradient(90deg,rgba(201,162,90,.28),transparent)" }} /></div>;
    const choice = (text: string, active: boolean, action: () => void) => <button className="hmp-hover" type="button" onClick={action} style={{ position: "relative", padding: "14px 0", border: `1px solid ${active ? T.gold : T.goldLine}`, borderRadius: 5, background: active ? "rgba(201,162,90,.15)" : T.panel, color: T.ink, fontFamily: T.display, letterSpacing: ".14em", cursor: "pointer", boxShadow: active ? `0 0 14px ${T.goldGlow}` : "none" }}>{text}</button>;

    return <div style={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden", background: "transparent", fontFamily: T.body, color: T.ink }}>
        <header style={{ flex: "none", padding: "20px 30px 14px", borderBottom: `1px solid ${T.goldLineSoft}`, background: "rgba(10,8,5,.94)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 12 }}>
                <span style={{ width: 10, height: 10, background: T.gold, transform: "rotate(45deg)" }} />
                <span style={{ fontFamily: T.display, fontWeight: 700, fontSize: 15, letterSpacing: ".3em", color: T.goldSoft }}>HogwartsMP</span>
                <span style={{ fontFamily: T.display, fontSize: 10, letterSpacing: ".34em", color: "#7c7263" }}>CHARACTER CREATION</span>
                <button className="hmp-hover" type="button" onClick={() => { setImportError(""); setImportOpen(true); }} style={{ ...buttonStyle, marginLeft: "auto" }}>IMPORT JSON</button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 18, marginBottom: 16 }}><h1 style={{ margin: 0, fontFamily: T.display, fontSize: 25, letterSpacing: ".1em", color: T.inkBright }}>{tab.title}</h1><div style={{ flex: 1, height: 1, background: "linear-gradient(90deg,rgba(201,162,90,.32),transparent)" }} /></div>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <button className="hmp-hover" type="button" style={{ ...buttonStyle, borderRadius: "50%", padding: 0, width: 34, height: 34 }} onClick={() => cycle(-1)}>&#8249;</button>
                {TABS.map((entry) => <button className="hmp-hover" type="button" key={entry.id} onClick={() => setTabId(entry.id)} style={{ position: "relative", width: 46, height: 46, borderRadius: "50%", border: `1px solid ${entry.id === tabId ? T.gold : T.goldLine}`, background: entry.id === tabId ? "rgba(201,162,90,.14)" : T.panelAlt, color: T.goldSoft, fontFamily: T.display, cursor: "pointer", boxShadow: entry.id === tabId ? `0 0 16px ${T.goldGlow}` : "none" }}>{entry.numeral}</button>)}
                <button className="hmp-hover" type="button" style={{ ...buttonStyle, borderRadius: "50%", padding: 0, width: 34, height: 34 }} onClick={() => cycle(1)}>&#8250;</button>
            </div>
        </header>

        {notice && <div role="status" style={{ position: "fixed", zIndex: 30, top: 18, right: 28, maxWidth: 470, padding: "10px 14px", border: `1px solid ${T.goldLine}`, borderRadius: 4, background: "rgba(14,11,7,.97)", color: T.goldSoft, fontSize: 12 }}>{notice}</div>}

        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
            <aside style={{ flex: "none", width: PANEL_W, padding: "26px 30px", overflowY: "auto", background: `radial-gradient(700px 520px at 30% -10%,rgba(201,162,90,.06),transparent 60%),${T.bg}` }}>
                {isFinalise ? <>
                    {label("VOICE · TONE")}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 26 }}>{choice("VOICE ONE", voice === 1, () => { setVoice(1); bridge.voice(0, pitch - PITCH_MID); })}{choice("VOICE TWO", voice === 2, () => { setVoice(2); bridge.voice(1, pitch - PITCH_MID); })}</div>
                    {label("PITCH")}
                    <div style={{ marginBottom: 28 }}><Slider value={pitch} max={5} onChange={(value) => { setPitch(value); bridge.voice(voice - 1, value - PITCH_MID); }} /></div>
                    {label("NAME YOUR CHARACTER")}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 26 }}>
                        <input value={first} onChange={(event) => { setFirst(event.target.value); bridge.name(event.target.value, last); }} placeholder="First Name" style={field} />
                        <input value={last} onChange={(event) => { setLast(event.target.value); bridge.name(first, event.target.value); }} placeholder="Last Name" style={field} />
                    </div>
                    {label("DORMITORY")}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>{choice("WITCH", dorm === "witch", () => setDorm("witch"))}{choice("WIZARD", dorm === "wizard", () => setDorm("wizard"))}</div>
                </> : tab.sections.map((section) => <div key={section.key} style={{ marginBottom: 26 }}>{label(section.label.toUpperCase())}<Slider value={Math.min(opts[section.key] || 1, sectionMax(section))} max={sectionMax(section)} onChange={(value) => setOption(section.key, value)} /></div>)}
            </aside>

            <main style={{ flex: 1, position: "relative", overflow: "hidden", borderLeft: `1px solid ${T.goldLineSoft}`, background: isHost ? "transparent" : "radial-gradient(120% 86% at 64% 4%,rgba(58,72,86,.3),transparent 56%),linear-gradient(180deg,#0d0b08,#070504)" }}>
                <div style={{ position: "absolute", inset: 0, background: "radial-gradient(74% 70% at 56% 42%,transparent 40%,rgba(0,0,0,.5) 100%)", pointerEvents: "none" }} />
                {[{ left: "38%", top: "62%", delay: "0s" }, { left: "66%", top: "54%", delay: ".8s" }, { left: "54%", top: "70%", delay: "1.6s" }].map((speck, index) => <span key={index} style={{ position: "absolute", left: speck.left, top: speck.top, width: 3, height: 3, borderRadius: "50%", background: T.gold, animation: `specks ${6 + index}s ease-in-out ${speck.delay} infinite` }} />)}
                <div style={{ position: "absolute", left: 22, top: 20 }}><div style={{ fontFamily: T.display, fontSize: 12, letterSpacing: ".18em", color: T.goldSoft }}>{tab.title}</div><div style={{ marginTop: 7, fontFamily: T.mono, fontSize: 10, color: "#7c7263" }}>HAIR {opts.hairStyle} · EYES {opts.eyeColour} · SKIN {opts.skin}</div></div>
                {isFinalise && <div style={{ position: "absolute", left: "50%", bottom: 52, transform: "translateX(-50%)", width: "min(380px,76%)", display: "grid", gap: 10 }}>
                    <button className="hmp-hover" type="button" onClick={bridge.exportLook} style={{ ...buttonStyle, padding: "12px 0", background: "rgba(12,9,6,.9)", color: T.goldSoft }}>COPY LOOK JSON</button>
                    <button className="hmp-hover" type="button" disabled={!canConfirm} onClick={() => { setOpen(false); bridge.confirm(first, last, dorm || ""); }} style={{ ...buttonStyle, padding: "15px 0", background: canConfirm ? `linear-gradient(180deg,${T.goldBright},#bf9a4d)` : "#15120c", color: canConfirm ? "#1a1306" : T.mutedDim, fontSize: 15, fontWeight: 700 }}>CONFIRM</button>
                    {!canConfirm && <div style={{ textAlign: "center", color: T.error, fontSize: 11 }}>NAME YOUR CHARACTER AND CHOOSE A DORMITORY TO CONFIRM.</div>}
                </div>}
            </main>
        </div>

        <footer style={{ flex: "none", height: 44, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 26px", borderTop: `1px solid ${T.goldLineSoft}`, background: "#0c0906", fontFamily: T.mono, fontSize: 10, color: T.mutedDim }}><span>HogwartsMP</span><span>A / D · ROTATE &nbsp;&nbsp; ESC · CANCEL</span></footer>
        {importOpen && <ImportDialog busy={importBusy} error={importError} onClose={() => { if (!importBusy) setImportOpen(false); }} onImport={(look) => { importPending.current = true; setImportBusy(true); setImportError(""); bridge.importLook(look); }} />}
    </div>;
}

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
createRoot(root).render(<App />);
