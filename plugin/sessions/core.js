// ./plugin/sessions/core.js
//
// Pure logic of the sessions plugin: no Typora globals, no DOM, no filesystem.
// Every export here is a plain data transformation, so the behaviour can be
// unit-tested with `node --test` without booting the editor.
//
// The model deliberately mirrors Kate's sessions/stash design. Where a function
// reproduces a specific Kate rule, the corresponding source location is quoted,
// so the two implementations can be diffed later.
//
// Runtime constraints (see AGENTS.md): Chrome 84 / Node 12 syntax only.
// No String.replaceAll, no Array.prototype.at, no logical assignment operators.

/** Tab keys of documents that have no file behind them. */
const UNTITLED_SCHEME = "untitled://"

const makeUntitledKey = (id) => UNTITLED_SCHEME + id

const isUntitledKey = (key) => typeof key === "string" && key.indexOf(UNTITLED_SCHEME) === 0

const untitledIdOf = (key) => isUntitledKey(key) ? key.slice(UNTITLED_SCHEME.length) : ""

/**
 * Smallest positive integer id not present in `keys`.
 * Ids are reused once freed, which keeps "Untitled-1" stable across a work day
 * instead of drifting to "Untitled-137".
 */
const nextUntitledId = (keys) => {
  const taken = new Set()
  for (const key of keys || []) {
    const id = parseInt(untitledIdOf(key), 10)
    if (!isNaN(id)) taken.add(id)
  }
  let id = 1
  while (taken.has(id)) id++
  return id
}

/**
 * Should this document's buffer be written to the stash on exit?
 * Mirrors KateStashManager::willStashDoc (apps/lib/katestashmanager.cpp).
 *
 * doc:    { path, isEmpty, isModified, isTemp }
 * config: { STASH_NEW_UNSAVED_FILES, STASH_UNSAVED_FILE_CHANGES }
 */
const willStash = (doc, config) => {
  if (!doc || doc.isEmpty) return false          // an empty buffer is never stashed
  if (!doc.path) return Boolean(config.STASH_NEW_UNSAVED_FILES)
  if (doc.isModified && !doc.isTemp) return Boolean(config.STASH_UNSAVED_FILE_CHANGES)
  return false                                   // saved and unmodified: nothing to keep
}

/**
 * Stashing requires a named session to own the stash directory.
 * Mirrors KateStashManager::canStash: the anonymous session never stashes.
 */
const canStash = (session) => Boolean(session && session.name && !session.anonymous)

/**
 * Stash file name for the document at `index`.
 * Kate names them by position in the document list, not by id, and reuses the
 * same string as the config group name (katestashmanager.cpp:stashDocuments).
 */
const stashEntryName = (index) => "Document " + index

/** Bumped whenever the on-disk session shape changes in a non-additive way. */
const SESSION_FORMAT_VERSION = 1

const sanitizeSessionName = (name) => String(name == null ? "" : name)
  .replace(/[\\/:*?"<>|]/g, "_")     // characters no filesystem we support accepts
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 64)

const buildSession = (input) => {
  const src = input || {}
  const documents = Array.isArray(src.documents) ? src.documents : []
  const activeIndex = Number.isInteger(src.activeIndex) ? src.activeIndex : 0
  return {
    version: SESSION_FORMAT_VERSION,
    name: sanitizeSessionName(src.name),
    anonymous: Boolean(src.anonymous),
    activeIndex: Math.min(Math.max(0, activeIndex), Math.max(0, documents.length - 1)),
    documents: documents.map((doc) => ({
      key: doc.key,                                  // path, or untitled:// key
      path: doc.path || "",                          // empty for untitled documents
      stash: doc.stash || "",                        // stash entry name, if a body was kept
      checksum: doc.checksum || "",                  // of the file at stash time; empty for untitled
      scrollTop: Number(doc.scrollTop) || 0,
      cursor: doc.cursor || null,
    })),
  }
}

const serializeSession = (session) => JSON.stringify(buildSession(session), null, 2)

/** Returns null instead of throwing: a corrupt session must not block startup. */
const parseSession = (raw) => {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    if (parsed.version !== SESSION_FORMAT_VERSION) return null
    return buildSession(parsed)
  } catch (e) {
    return null
  }
}

/**
 * Decide what actually gets reopened.
 *
 * existingPaths: Set of file paths that still exist on disk.
 * Untitled documents survive only while their stash body is still present,
 * because without it there is nothing to restore into the buffer.
 */
const planRestore = (input) => {
  const session = buildSession(input.session)
  const existingPaths = input.existingPaths || new Set()
  const existingStash = input.existingStash || new Set()

  const kept = []
  const dropped = []
  for (const doc of session.documents) {
    const alive = isUntitledKey(doc.key)
      ? Boolean(doc.stash) && existingStash.has(doc.stash)
      : existingPaths.has(doc.path)
    if (alive) {
      kept.push(doc)
    } else {
      dropped.push(doc)
    }
  }

  // Keep pointing at the same document when possible; otherwise fall back to the first.
  const wanted = session.documents[session.activeIndex]
  let activeIndex = 0
  if (wanted) {
    const idx = kept.findIndex((doc) => doc.key === wanted.key)
    if (idx >= 0) activeIndex = idx
  }
  return { documents: kept, activeIndex, dropped }
}

/**
 * Which buffers to write to the stash, and under which entry names.
 * The index is the position in the tab list, exactly as Kate does it.
 */
const planStash = (input) => {
  const documents = input.documents || []
  const config = input.config || {}
  if (!canStash(input.session)) return []
  const plan = []
  for (let index = 0; index < documents.length; index++) {
    const doc = documents[index]
    if (willStash(doc, config)) {
      plan.push({ index: index, key: doc.key, entry: stashEntryName(index) })
    }
  }
  return plan
}

/**
 * Closing a single tab always asks about unsaved content.
 * Mirrors KateDocManager::closeDocumentList (apps/lib/katedocmanager.cpp):
 * the stash is not consulted here, only doc->isModified().
 */
const shouldPromptOnCloseTab = (doc) => Boolean(doc && doc.isModified && !doc.isEmpty)

/**
 * Closing the application asks only about what the stash will NOT keep.
 * Mirrors KateMainWindow::queryClose_internal (apps/lib/katemainwindow.cpp):
 * documents the stash manager will take are struck off the prompt list, and so
 * are empty untitled buffers.
 */
const documentsToPromptOnQuit = (input) => {
  const documents = input.documents || []
  const config = input.config || {}
  const stashing = canStash(input.session)
  return documents.filter((doc) => {
    if (!doc.isModified) return false
    if (doc.isEmpty && !doc.path) return false        // empty untitled: discard silently
    if (stashing && willStash(doc, config)) return false
    return true
  })
}

/**
 * Which session to open on startup.
 * Mirrors Kate's `Startup Session` setting: new | last | manual.
 * "manual" means the caller has to ask the user, so it returns no session.
 */
const resolveStartupSession = (input) => {
  const mode = input.mode || "last"
  const names = input.sessions || []
  const last = input.lastSession || ""
  if (mode === "new") return { action: "new", name: "" }
  if (mode === "manual") return { action: "ask", name: "" }
  if (last && names.indexOf(last) >= 0) return { action: "open", name: last }
  return { action: "new", name: "" }
}

/**
 * Drop per-file metadata older than `days`.
 * Mirrors Kate's `Days Meta Infos` (default 30) applied to katemetainfos.
 * meta: { [path]: { time: <ms>, checksum, ... } }
 */
const pruneMetaInfos = (meta, nowMs, days) => {
  const ttl = Number(days) * 24 * 60 * 60 * 1000
  const out = {}
  if (!meta || ttl <= 0) return out
  for (const path of Object.keys(meta)) {
    const entry = meta[path]
    const time = entry && Number(entry.time)
    if (time && nowMs - time <= ttl) {
      out[path] = entry
    }
  }
  return out
}

/**
 * Metadata is only trustworthy while the file is unchanged.
 * Kate stores a checksum with each entry for exactly this reason; a mismatch
 * means cursor positions and folding ranges no longer point where they did.
 */
const isMetaValid = (entry, currentChecksum) => Boolean(
  entry && entry.checksum && currentChecksum && entry.checksum === currentChecksum
)

module.exports = {
  UNTITLED_SCHEME,
  SESSION_FORMAT_VERSION,
  makeUntitledKey,
  isUntitledKey,
  untitledIdOf,
  nextUntitledId,
  willStash,
  canStash,
  stashEntryName,
  sanitizeSessionName,
  buildSession,
  serializeSession,
  parseSession,
  planRestore,
  planStash,
  shouldPromptOnCloseTab,
  documentsToPromptOnQuit,
  resolveStartupSession,
  pruneMetaInfos,
  isMetaValid,
}
