// JSONC editor for opencode-family members whose host config is JSONC
// (registry entries with jsonc: true — today only mimocode).
//
// The JSON path in opencode-family-install.js round-trips through
// JSON.parse/JSON.stringify, which would DESTROY user comments and trailing
// commas in a JSONC file. This module performs element-level edits with
// jsonc-parser (modify/applyEdits) so everything the user wrote survives;
// only the "plugin" array entry we manage is touched (plan §4.1).
//
// MERGED-CONFIG SEMANTICS (verified against MiMo Code v0.1.6 —
// config.ts:588-590, paths.ts:63-65, plugin/install.ts:349-355): the host
// merges EVERY file in cfg.configCandidates (lowest priority first at load,
// so the list here is highest-priority first), and array fields like
// "plugin" are REPLACED by the later file, not concatenated. Consequences
// (#607 review):
//   - register must edit the file whose "plugin" actually wins — writing a
//     fresh plugin array into a higher-priority file would silently mask
//     every plugin the user declared in a lower one;
//   - unregister must sweep ALL candidates, or a managed entry masked today
//     could resurrect when the user deletes the higher-priority file.
//
// Deliberately a SEPARATE module, lazy-required by the shared installer only
// when cfg.jsonc is set: hooks/json-utils.js is deployed to remote SSH hosts
// without node_modules and must stay dependency-free, so jsonc-parser must
// never be required from it (locked by a remote-closure guard test).
//
// Contract parity: registerJsonc/unregisterJsonc return the same shapes and
// print the same console lines as the JSON branch in makeFamilyInstaller —
// callers cannot tell the two apart. `configPath` in the return names the
// file actually edited.

const path = require("path");
const { parse, parseTree, findNodeAtLocation, modify, applyEdits } = require("jsonc-parser");
const {
  readTextFileStripBom,
  writeTextAtomic,
  writeTextAtomicWithBackup,
} = require("./json-utils");

// Match the repo's 2-space JSON style for inserted elements.
const FORMATTING = { formattingOptions: { insertSpaces: true, tabSize: 2 } };

const PARSE_OPTIONS = { allowTrailingComma: true, disallowComments: false };

function normalizePluginEntry(value) {
  return String(value || "").replace(/\\/g, "/");
}

function entryIsExactManagedPlugin(entry, pluginDir) {
  return typeof entry === "string" && normalizePluginEntry(entry) === normalizePluginEntry(pluginDir);
}

function parseJsoncStrict(text, configPath) {
  const errors = [];
  const tree = parse(text, errors, PARSE_OPTIONS);
  if (errors.length) {
    // Do not clobber a config we cannot fully understand — same stance as the
    // JSON branch on a JSON.parse failure.
    throw new Error(`Failed to read ${configPath}: invalid JSONC (${errors.length} parse error${errors.length === 1 ? "" : "s"})`);
  }
  return tree;
}

function freshConfigText(cfg, pluginDir) {
  const settings = cfg.schema ? { $schema: cfg.schema, plugin: [pluginDir] } : { plugin: [pluginDir] };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

// Candidate files in HIGHEST-priority-first order. configPath is the
// create-default (join(configDir, cfg.configFileName)); its directory hosts
// the sibling candidates. A test override with a custom basename is
// prepended so single-file fixtures keep working.
function candidatePaths(cfg, configPath) {
  const dir = path.dirname(configPath);
  const names = Array.isArray(cfg.configCandidates) && cfg.configCandidates.length
    ? cfg.configCandidates
    : [cfg.configFileName];
  const paths = names.map((name) => path.join(dir, name));
  if (!paths.includes(configPath)) paths.unshift(configPath);
  return paths;
}

// Read every candidate: { path, exists, text, tree }. Throws on a candidate
// that exists but cannot be parsed — editing around a file we cannot fully
// understand risks masking or clobbering user content.
function readCandidates(cfg, configPath) {
  return candidatePaths(cfg, configPath).map((candidate) => {
    let text = null;
    try {
      text = readTextFileStripBom(candidate, "utf-8");
    } catch (err) {
      if (err.code === "ENOENT") return { path: candidate, exists: false, text: null, tree: null };
      throw new Error(`Failed to read ${candidate}: ${err.message}`);
    }
    return { path: candidate, exists: true, text, tree: parseJsoncStrict(text, candidate) };
  });
}

function isObjectRoot(tree) {
  return !!tree && typeof tree === "object" && !Array.isArray(tree);
}

function declaresPlugin(state) {
  return state.exists && isObjectRoot(state.tree) && Object.prototype.hasOwnProperty.call(state.tree, "plugin");
}

// Same idempotency rule as the JSON branch: match by exact path OR by
// directory basename on an ABSOLUTE-path entry (stale installs at another
// location get updated in place; npm package specifiers — which can also
// live in the plugin array — are never touched because they aren't absolute).
function findManagedIndex(pluginArray, pluginDir, pluginDirName) {
  for (let i = 0; i < pluginArray.length; i++) {
    const entry = pluginArray[i];
    if (typeof entry !== "string") continue;
    if (entry === pluginDir) return i;
    const normalized = entry.replace(/\\/g, "/");
    const isAbsolute = path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized);
    if (isAbsolute && path.posix.basename(normalized) === pluginDirName) return i;
  }
  return -1;
}

// jsonc-parser 3.3.1 emits a CORRUPT edit (dangling quote) when removing an
// element from a SINGLE-LINE array (probed; latest stable at time of
// writing). Per-element removal is only safe when the array spans multiple
// lines; single-line arrays are rewritten wholesale instead.
function pluginArrayIsMultiline(text) {
  const root = parseTree(text, [], PARSE_OPTIONS);
  const node = root ? findNodeAtLocation(root, ["plugin"]) : null;
  if (!node) return true;
  return text.slice(node.offset, node.offset + node.length).includes("\n");
}

function removeEntriesFromText(text, tree, matches) {
  if (pluginArrayIsMultiline(text)) {
    // Per-element removal, highest index down (keeps indices valid and
    // preserves comments between the surviving elements).
    let out = text;
    for (let k = matches.length - 1; k >= 0; k--) {
      out = applyEdits(out, modify(out, ["plugin", matches[k]], undefined, FORMATTING));
    }
    return out;
  }
  // Single-line array: replace the whole value (upstream removal bug).
  // Known limit: inline /* */ comments inside the one-line array are lost;
  // line comments cannot legally exist there.
  const matchSet = new Set(matches);
  const remaining = tree.plugin.filter((_, i) => !matchSet.has(i));
  return applyEdits(text, modify(text, ["plugin"], remaining, FORMATTING));
}

function registerJsonc({ cfg, agentId, configPath, pluginDir, options = {} }) {
  const states = readCandidates(cfg, configPath);

  // Write target: the file whose "plugin" is effectively live (highest
  // priority declaring it) → else the highest-priority existing file →
  // else create the default file fresh.
  const target = states.find(declaresPlugin) || states.find((s) => s.exists) || null;

  let added = false;
  let skipped = false;
  let created = false;
  let editedPath = configPath;

  if (!target) {
    writeTextAtomic(configPath, freshConfigText(cfg, pluginDir));
    created = true;
    added = true;
  } else {
    editedPath = target.path;
    let text = target.text;
    if (!isObjectRoot(target.tree)) {
      // Non-object root ("null", a bare number…). The JSON branch tolerates
      // this by starting over from {}; there are no meaningful comments to
      // preserve in a config with no object root, so we do the same.
      writeTextAtomic(target.path, freshConfigText(cfg, pluginDir));
      added = true;
    } else if (!Array.isArray(target.tree.plugin)) {
      // Missing or non-array "plugin" — (re)write just that property.
      text = applyEdits(text, modify(text, ["plugin"], [pluginDir], FORMATTING));
      writeTextAtomic(target.path, text);
      added = true;
    } else {
      const matchIndex = findManagedIndex(target.tree.plugin, pluginDir, cfg.pluginDirName);
      if (matchIndex === -1) {
        text = applyEdits(text, modify(text, ["plugin", -1], pluginDir, { ...FORMATTING, isArrayInsertion: true }));
        writeTextAtomic(target.path, text);
        added = true;
      } else if (target.tree.plugin[matchIndex] !== pluginDir) {
        // Stale path (e.g. old install location) — update the element in place
        text = applyEdits(text, modify(text, ["plugin", matchIndex], pluginDir, FORMATTING));
        writeTextAtomic(target.path, text);
        added = true;
      } else {
        skipped = true;
      }
    }
  }

  if (!options.silent) {
    console.log(`Clawd ${agentId} plugin → ${editedPath}`);
    if (created) console.log(`  Created ${cfg.configFileName}`);
    if (added) console.log(`  Registered: ${pluginDir}`);
    if (skipped) console.log(`  Already registered: ${pluginDir}`);
  }

  return { added, skipped, created, configPath: editedPath, pluginDir };
}

function unregisterJsonc({ cfg, agentId, configPath, pluginDir, options = {} }) {
  const states = readCandidates(cfg, configPath);

  // Sweep EVERY candidate: an exact managed entry left in a lower-priority
  // file is masked today but becomes live the moment the higher-priority
  // file goes away.
  let removed = 0;
  const backupPaths = [];
  for (const state of states) {
    if (!state.exists || !isObjectRoot(state.tree) || !Array.isArray(state.tree.plugin)) continue;

    const matches = [];
    for (let i = 0; i < state.tree.plugin.length; i++) {
      if (entryIsExactManagedPlugin(state.tree.plugin[i], pluginDir)) matches.push(i);
    }
    if (!matches.length) continue;

    const text = removeEntriesFromText(state.text, state.tree, matches);
    const backupPath = writeTextAtomicWithBackup(state.path, text, options);
    if (backupPath) backupPaths.push(backupPath);
    removed += matches.length;
  }

  const changed = removed > 0;
  if (!options.silent) console.log(`Clawd ${agentId} plugin entries removed: ${removed}`);
  const result = { removed, changed, skipped: !changed, configPath, pluginDir };
  if (options.backup === true) {
    result.backupPath = backupPaths[0] || null;
    result.backupPaths = backupPaths;
  }
  return result;
}

module.exports = {
  registerJsonc,
  unregisterJsonc,
  __test: { parseJsoncStrict, findManagedIndex, entryIsExactManagedPlugin, freshConfigText, candidatePaths },
};
