import type { HmpLibServer } from "../../hmp-lib/types";
import type { InteractConfig } from "./internal";

function loadConfig(Hmp: Pick<HmpLibServer, "config" | "text">, options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): InteractConfig {
    const env = options.env || process.env;
    // The closed-test command is opt-in: a server that never configures it gets no /interact.
    const defaults: InteractConfig = { enableCommands: false, command: "interact" };
    const loaded = Hmp.config.load<InteractConfig & Record<string, unknown>>(env.HMP_INTERACT_CONFIG || "data/hmp-interact.json", {
        cwd: options.cwd || process.cwd(),
        defaults: defaults as InteractConfig & Record<string, unknown>,
    });
    const command = Hmp.text.clean(env.HMP_INTERACT_COMMAND || loaded.command || "interact", 32).toLowerCase();
    if (!/^[a-z0-9_-]+$/.test(command)) throw new TypeError("hmp-interact command contains unsupported characters");
    return {
        enableCommands: env.HMP_INTERACT_COMMANDS === undefined ? loaded.enableCommands === true : Hmp.config.env.boolean(env.HMP_INTERACT_COMMANDS, false),
        command,
    };
}

export = { loadConfig };
