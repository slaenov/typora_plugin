const { describe, it } = require("node:test")
const assert = require("node:assert")
const core = require("../../plugin/sessions/core.js")

// Config shorthands matching Kate's two independent stash switches.
const STASH_UNTITLED = { STASH_NEW_UNSAVED_FILES: true, STASH_UNSAVED_FILE_CHANGES: false }
const STASH_NOTHING = { STASH_NEW_UNSAVED_FILES: false, STASH_UNSAVED_FILE_CHANGES: false }
const STASH_EVERYTHING = { STASH_NEW_UNSAVED_FILES: true, STASH_UNSAVED_FILE_CHANGES: true }

const named = { name: "june", anonymous: false }
const anonymous = { name: "", anonymous: true }

const untitled = (id, over) => Object.assign(
  { key: core.makeUntitledKey(id), path: "", isEmpty: false, isModified: true, isTemp: false },
  over,
)
const file = (path, over) => Object.assign(
  { key: path, path: path, isEmpty: false, isModified: false, isTemp: false },
  over,
)

describe("Untitled keys", () => {
  it("round-trips id through the key", () => {
    const key = core.makeUntitledKey(7)
    assert.strictEqual(key, "untitled://7")
    assert.strictEqual(core.isUntitledKey(key), true)
    assert.strictEqual(core.untitledIdOf(key), "7")
  })

  it("does not mistake a path for an untitled key", () => {
    assert.strictEqual(core.isUntitledKey("/home/u/untitled://x.md"), false)
    assert.strictEqual(core.isUntitledKey(undefined), false)
    assert.strictEqual(core.untitledIdOf("/a.md"), "")
  })

  it("reuses the smallest free id instead of always incrementing", () => {
    assert.strictEqual(core.nextUntitledId([]), 1)
    assert.strictEqual(core.nextUntitledId(["untitled://1", "untitled://3"]), 2)
    assert.strictEqual(core.nextUntitledId(["untitled://1", "untitled://2", "/a.md"]), 3)
  })
})

describe("willStash - KateStashManager::willStashDoc", () => {
  it("never stashes an empty buffer", () => {
    assert.strictEqual(core.willStash(untitled(1, { isEmpty: true }), STASH_EVERYTHING), false)
  })

  it("stashes an untitled buffer only when STASH_NEW_UNSAVED_FILES is on", () => {
    assert.strictEqual(core.willStash(untitled(1), STASH_UNTITLED), true)
    assert.strictEqual(core.willStash(untitled(1), STASH_NOTHING), false)
  })

  it("stashes a modified file only when STASH_UNSAVED_FILE_CHANGES is on", () => {
    const dirty = file("/a.md", { isModified: true })
    assert.strictEqual(core.willStash(dirty, STASH_UNTITLED), false)
    assert.strictEqual(core.willStash(dirty, STASH_EVERYTHING), true)
  })

  it("never stashes a file living in a temporary directory", () => {
    const tmp = file("/tmp/a.md", { isModified: true, isTemp: true })
    assert.strictEqual(core.willStash(tmp, STASH_EVERYTHING), false)
  })

  it("never stashes a saved, unmodified file", () => {
    assert.strictEqual(core.willStash(file("/a.md"), STASH_EVERYTHING), false)
  })
})

describe("canStash - stash belongs to a named session", () => {
  it("requires a named session", () => {
    assert.strictEqual(core.canStash(named), true)
    assert.strictEqual(core.canStash(anonymous), false)
    assert.strictEqual(core.canStash(null), false)
    assert.strictEqual(core.canStash({ name: "x", anonymous: true }), false)
  })
})

describe("Session (de)serialization", () => {
  it("normalizes on build and survives a round trip", () => {
    const raw = core.serializeSession({
      name: "june",
      activeIndex: 99,
      documents: [file("/a.md"), untitled(1)],
    })
    const back = core.parseSession(raw)
    assert.strictEqual(back.name, "june")
    assert.strictEqual(back.activeIndex, 1, "active index is clamped to the last document")
    assert.strictEqual(back.documents.length, 2)
    assert.strictEqual(back.documents[1].path, "")
  })

  it("returns null on garbage instead of throwing", () => {
    assert.strictEqual(core.parseSession("{ not json"), null)
    assert.strictEqual(core.parseSession("null"), null)
    assert.strictEqual(core.parseSession(JSON.stringify({ version: 999 })), null)
  })

  it("strips characters that filesystems reject from session names", () => {
    assert.strictEqual(core.sanitizeSessionName(' a/b:c*d?e"f<g>h|i '), "a_b_c_d_e_f_g_h_i")
    assert.strictEqual(core.sanitizeSessionName(null), "")
  })
})

describe("planRestore", () => {
  const session = {
    name: "june",
    activeIndex: 2,
    documents: [
      { key: "/gone.md", path: "/gone.md" },
      { key: "untitled://1", path: "", stash: "Document 1" },
      { key: "/alive.md", path: "/alive.md" },
      { key: "untitled://2", path: "", stash: "Document 3" },
    ],
  }

  it("drops files that vanished and untitled buffers whose stash is gone", () => {
    const plan = core.planRestore({
      session: session,
      existingPaths: new Set(["/alive.md"]),
      existingStash: new Set(["Document 1"]),
    })
    assert.deepStrictEqual(plan.documents.map((d) => d.key), ["untitled://1", "/alive.md"])
    assert.deepStrictEqual(plan.dropped.map((d) => d.key), ["/gone.md", "untitled://2"])
  })

  it("keeps pointing at the same document after others were dropped", () => {
    const plan = core.planRestore({
      session: session,
      existingPaths: new Set(["/alive.md"]),
      existingStash: new Set(["Document 1"]),
    })
    assert.strictEqual(plan.documents[plan.activeIndex].key, "/alive.md")
  })

  it("falls back to the first document when the active one is gone", () => {
    const plan = core.planRestore({
      session: session,
      existingPaths: new Set(),
      existingStash: new Set(["Document 1"]),
    })
    assert.strictEqual(plan.activeIndex, 0)
    assert.strictEqual(plan.documents.length, 1)
  })

  it("an untitled document without a stash entry is not restorable", () => {
    const plan = core.planRestore({
      session: { name: "s", documents: [{ key: "untitled://9", path: "" }] },
      existingPaths: new Set(),
      existingStash: new Set(["Document 0"]),
    })
    assert.strictEqual(plan.documents.length, 0)
  })
})

describe("planStash", () => {
  it("names entries by tab position, like Kate", () => {
    const plan = core.planStash({
      session: named,
      config: STASH_UNTITLED,
      documents: [file("/a.md"), untitled(1), untitled(2, { isEmpty: true }), untitled(3)],
    })
    assert.deepStrictEqual(plan, [
      { index: 1, key: "untitled://1", entry: "Document 1" },
      { index: 3, key: "untitled://3", entry: "Document 3" },
    ])
  })

  it("stashes nothing in the anonymous session", () => {
    const plan = core.planStash({
      session: anonymous,
      config: STASH_EVERYTHING,
      documents: [untitled(1)],
    })
    assert.deepStrictEqual(plan, [])
  })
})

describe("Save prompts - the two different Kate rules", () => {
  it("closing a tab asks about any modified document", () => {
    assert.strictEqual(core.shouldPromptOnCloseTab(untitled(1)), true)
    assert.strictEqual(core.shouldPromptOnCloseTab(untitled(1, { isEmpty: true })), false)
    assert.strictEqual(core.shouldPromptOnCloseTab(file("/a.md")), false)
    assert.strictEqual(core.shouldPromptOnCloseTab(file("/a.md", { isModified: true })), true)
  })

  it("quitting stays silent about everything the stash will keep", () => {
    const documents = [untitled(1), untitled(2, { isEmpty: true }), file("/a.md", { isModified: true })]
    const prompt = core.documentsToPromptOnQuit({
      documents: documents,
      config: STASH_UNTITLED,
      session: named,
    })
    // untitled(1) -> stashed, empty untitled -> discarded, dirty file -> not covered by this config
    assert.deepStrictEqual(prompt.map((d) => d.key), ["/a.md"])
  })

  it("quitting asks about untitled buffers when the session cannot stash", () => {
    const prompt = core.documentsToPromptOnQuit({
      documents: [untitled(1)],
      config: STASH_UNTITLED,
      session: anonymous,
    })
    assert.deepStrictEqual(prompt.map((d) => d.key), ["untitled://1"])
  })

  it("quitting is fully silent when the stash covers everything", () => {
    const prompt = core.documentsToPromptOnQuit({
      documents: [untitled(1), file("/a.md", { isModified: true })],
      config: STASH_EVERYTHING,
      session: named,
    })
    assert.deepStrictEqual(prompt, [])
  })
})

describe("resolveStartupSession", () => {
  it("opens the last session when it still exists", () => {
    const r = core.resolveStartupSession({ mode: "last", lastSession: "june", sessions: ["june", "may"] })
    assert.deepStrictEqual(r, { action: "open", name: "june" })
  })

  it("falls back to a new session when the last one was deleted", () => {
    const r = core.resolveStartupSession({ mode: "last", lastSession: "gone", sessions: ["june"] })
    assert.deepStrictEqual(r, { action: "new", name: "" })
  })

  it("honours new and manual", () => {
    assert.strictEqual(core.resolveStartupSession({ mode: "new", lastSession: "june", sessions: ["june"] }).action, "new")
    assert.strictEqual(core.resolveStartupSession({ mode: "manual", lastSession: "june", sessions: ["june"] }).action, "ask")
  })
})

describe("Per-file metadata", () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = 1000 * DAY

  it("drops entries past the TTL and keeps the rest", () => {
    const meta = {
      "/fresh.md": { time: now - 5 * DAY },
      "/stale.md": { time: now - 31 * DAY },
      "/broken.md": {},
    }
    assert.deepStrictEqual(Object.keys(core.pruneMetaInfos(meta, now, 30)), ["/fresh.md"])
  })

  it("a TTL of zero clears everything", () => {
    assert.deepStrictEqual(core.pruneMetaInfos({ "/a.md": { time: now } }, now, 0), {})
  })

  it("metadata is invalid once the file checksum changed", () => {
    assert.strictEqual(core.isMetaValid({ checksum: "abc" }, "abc"), true)
    assert.strictEqual(core.isMetaValid({ checksum: "abc" }, "def"), false)
    assert.strictEqual(core.isMetaValid({}, "abc"), false)
  })
})
