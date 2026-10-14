// Loads pi-hermes-memory under Kimchi with the minion's own memory.
// Kimchi points PI_CODING_AGENT_DIR at its own folder before extensions load,
// and keeps the minion's folder in KIMCHI_ORIGINAL_PI_CODING_AGENT_DIR.
// pi-hermes-memory reads PI_CODING_AGENT_DIR once, when it is first loaded,
// so the minion's folder is put back just for that load.
// usage: kimchi -e <this file>, with MINION_HERMES set to the package folder.
const pkg = process.env.MINION_HERMES
const original = process.env.KIMCHI_ORIGINAL_PI_CODING_AGENT_DIR
if (!pkg || !original) throw new Error("hermes-memory: MINION_HERMES and KIMCHI_ORIGINAL_PI_CODING_AGENT_DIR must be set")

const kimchiDir = process.env.PI_CODING_AGENT_DIR
process.env.PI_CODING_AGENT_DIR = original
let hermes: { default: (pi: unknown) => unknown }
try {
	hermes = require(`${pkg}/src/index.ts`)
} finally {
	process.env.PI_CODING_AGENT_DIR = kimchiDir
}

export default hermes.default
