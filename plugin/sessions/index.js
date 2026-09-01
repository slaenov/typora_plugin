// ./plugin/sessions/index.js
//
// Kate-style sessions for Typora.
//
// The feature Typora is missing: a scratch buffer that survives a restart without
// ever creating a file. Typora autosaves every file-backed document, so "unsaved
// changes" only really exist for documents that have no path yet - and those are
// exactly the ones that are lost today.
//
// The model is Kate's: a session owns an ordered list of documents; documents
// without a path keep their body in a stash directory that belongs to the session;
// on startup the bodies are popped back into untitled buffers. All rules live in
// ./core.js, which is pure and unit-tested; this file is the Typora-facing shell.
//
// Runtime constraints (AGENTS.md): Chrome 84 / Node 12 syntax only.

const core = require("./core")

class Sessions extends BasePlugin {
  // ==================== storage ====================
  // Everything the session needs lives in files under the user's config directory.
  //
  // AGENTS.md prefers utils.getStorage for small plugin data, and that is the right
  // default - but not here. getStorage is localStorage, and Chromium only flushes it
  // to disk on a clean shutdown: kill the process and every write of the session is
  // gone. The whole point of this plugin is that unsaved work survives, so the index
  // has to be as durable as the bodies it points at. Both go to
  // ~/.config/typora_plugin/sessions, not to user_space, which is not writable on
  // system-wide installs.
  _statePath = () => this.utils.Package.Path.join(this._dataDir(), "state.json")

  _sessionPath = (name) => this.utils.Package.Path.join(this._dataDir(), name + ".json")

  _dataDir = () => {
    const Path = this.utils.Package.Path
    return Path.join(this.utils.getHomeDir(), ".config", "typora_plugin", "sessions")
  }

  _stashDir = (sessionName) => this.utils.Package.Path.join(this._dataDir(), "stash", sessionName)

  _stashPath = (sessionName, entry) => this.utils.Package.Path.join(this._stashDir(sessionName), entry)

  // ==================== state ====================
  // _buffers holds the live text of every untitled tab, including the one on screen.
  // The editor can only ever hold one document, so the other buffers exist nowhere else.
  _buffers = new Map()   // untitled key -> { text, stashedAs }
  _activeKey = ""        // path of the current tab, or an untitled:// key
  _wt = null             // window_tab plugin instance
  _restoring = false     // guards hooks while we rebuild the tab bar on startup

  _log = (...args) => {
    if (this.config.DEBUG) console.log("[" + this.fixedName + "]", ...args)
  }

  /** Name of the session in use. An implicit "default" exists from the first run. */
  _currentName = () => {
    try {
      const raw = this.utils.Package.FsExtra.readFileSync(this._statePath(), "utf-8")
      const parsed = JSON.parse(raw)
      return (parsed && parsed.current) || "default"
    } catch (e) {
      return "default"
    }
  }

  _readSession = (name) => {
    try {
      const raw = this.utils.Package.FsExtra.readFileSync(this._sessionPath(name), "utf-8")
      const parsed = core.parseSession(raw)
      if (parsed) {
        parsed.name = name
        return parsed
      }
    } catch (e) {
      // A missing or corrupt session must not block startup: fall through to an empty one.
    }
    const empty = core.buildSession({ name: name })
    empty.name = name
    return empty
  }

  _writeSession = (session, sync) => {
    const fs = this.utils.Package.FsExtra
    const text = core.serializeSession(session)
    const state = JSON.stringify({ current: session.name })
    if (sync) {
      fs.ensureDirSync(this._dataDir())
      fs.writeFileSync(this._sessionPath(session.name), text)
      fs.writeFileSync(this._statePath(), state)
      return Promise.resolve()
    }
    return fs.ensureDir(this._dataDir())
      .then(() => fs.writeFile(this._sessionPath(session.name), text))
      .then(() => fs.writeFile(this._statePath(), state))
  }

  _session = () => this._readSession(this._currentName())

  // ==================== lifecycle ====================
  prepare = async () => {
    this._buffers = new Map()
  }

  hotkey = () => [
    { hotkey: this.config.NEW_UNTITLED_HOTKEY, callback: this._newUntitled },
  ]

  getDynamicActions = () => this.i18n.fillActions([
    { act_value: "new_untitled", act_hotkey: this.config.NEW_UNTITLED_HOTKEY },
  ])

  call = (action) => {
    if (action === "new_untitled") this._newUntitled()
  }

  process = () => {
    this.utils.eventHub.addEventListener(this.utils.eventHub.eventType.allPluginsHadInjected, this._onReady)
  }

  _onReady = async () => {
    this._wt = this.utils.getPlugin("window_tab")
    if (!this._wt) {
      console.error("[" + this.fixedName + "] window_tab is required but not enabled")
      return
    }
    this._hookExistPath()
    this._hookTabNames()
    this._hookSwitch()
    this._hookClose()
    this._hookAutoStash()
    this._hookFlushOnExit()
    await this._restoreSession()
  }

  // ==================== hooks ====================

  // TabManager polls the filesystem and drops every tab whose path is gone
  // (TabManager.checkExist, driven by TabMonitor on a timer and on window focus).
  // An untitled key is not a path and would always fail that check, so the tab
  // would silently vanish a second after it was created.
  //
  // Reporting untitled keys as existing is a no-op for every other caller: the
  // scheme belongs to this plugin and nothing else ever passes such a string.
  _hookExistPath = () => {
    this.utils.decorator.decorate(() => this.utils, "existPath", {
      modifyResult: true,
      after: (result, path) => core.isUntitledKey(path) ? true : result,
    })
  }

  // Tab labels: TabManager derives showName from the file name, which is meaningless
  // for an untitled key. Rewrite those labels after the manager formatted the rest.
  _hookTabNames = () => {
    this.utils.decorator.afterCall(() => this._wt.tab, "_formatShowNames", () => {
      for (const tab of this._wt.tab.tabs) {
        if (core.isUntitledKey(tab.path)) {
          tab.showName = this.config.UNTITLED_NAME_PREFIX + core.untitledIdOf(tab.path)
        }
      }
    })
  }

  // Switching tabs. TabManager.switch() ends in utils.openFile(), which would ask
  // Typora to open a file named "untitled://1". Two things happen here:
  // whatever is leaving the screen is captured first, and untitled targets are
  // served by swapping the buffer instead of opening anything.
  _hookSwitch = () => {
    const getTab = () => this._wt.tab
    this.utils.decorator.preventCallIf(getTab, "switch", (idx) => {
      if (this._restoring) return false
      const tab = getTab().getByIdx(idx)
      if (!tab) return false
      this._captureCurrent()
      if (!core.isUntitledKey(tab.path)) return false   // a real file: let Typora do its job
      getTab()._activeIdx = idx
      this._showUntitled(tab.path)
      this._repaint()
      return true
    })
    // A file opened by any other route (sidebar, quick open, drag) also means the
    // previous buffer is leaving the screen.
    this.utils.eventHub.addEventListener(this.utils.eventHub.eventType.fileOpened, (path) => {
      if (this._restoring) return
      // The event is asynchronous and can arrive after the user already moved on.
      // Accept it only while it still describes the active tab, otherwise a late
      // notification would overwrite the untitled buffer we have just shown.
      const current = this._wt && this._wt.tab.current
      if (current && current.path === path) this._activeKey = path
    })
  }

  // Closing a tab. Kate asks about any modified document here and does not consult
  // the stash (katedocmanager.cpp:closeDocumentList), so an untitled buffer with
  // text always gets Save / Don't Save / Cancel.
  _hookClose = () => {
    const getTab = () => this._wt.tab
    this.utils.decorator.preventCallIf(getTab, "close", (idx) => {
      if (this._closing) return false
      const tab = getTab().getByIdx(idx)
      if (!tab || !core.isUntitledKey(tab.path)) return false
      this._captureCurrent()
      const doc = this._describe(tab.path)
      if (!core.shouldPromptOnCloseTab(doc)) {
        this._forgetUntitled(tab.path)
        return false        // empty scratch: let the normal close run, nothing to ask
      }
      this._confirmClose(idx, tab.path)
      return true           // block the close; we finish it ourselves after the dialog
    })
  }

  // Bodies are synced on a timer, the same way Kate syncs its swap files, so a
  // power cut costs at most one interval.
  _hookAutoStash = () => {
    const interval = Math.max(1, Number(this.config.STASH_SYNC_INTERVAL) || 15) * 1000
    const sync = this.utils.debounce(() => {
      this._captureCurrent()
      this._stashAll()
    }, interval)
    this.utils.eventHub.addEventListener(this.utils.eventHub.eventType.fileEdited, sync)
  }

  // The plugin API has no "about to quit" event, so hook the DOM one. Everything
  // here must be synchronous: the renderer is already going away.
  _hookFlushOnExit = () => {
    window.addEventListener("beforeunload", () => {
      try {
        this._captureCurrent()
        this._stashAll(true)
      } catch (e) {
        console.error("[" + this.fixedName + "] flush on exit failed", e)
      }
    })
  }

  // ==================== buffers ====================

  /** Shape core.js expects, derived from what is currently in the editor. */
  _describe = (key) => {
    const text = core.isUntitledKey(key)
      ? (this._buffers.get(key) || {}).text || ""
      : ""
    return {
      key: key,
      path: core.isUntitledKey(key) ? "" : key,
      isEmpty: text.trim() === "",
      isModified: core.isUntitledKey(key),   // an untitled buffer is by definition unsaved
      isTemp: false,
    }
  }

  /**
   * Pull the on-screen text of an untitled buffer into memory before it leaves.
   *
   * The reset() afterwards is not cosmetic. Typora refuses to replace an untitled
   * document that carries unsaved changes: library.openFile() silently does nothing
   * while isDiscardableUntitled() is false, and the tab switch dies without an error.
   * Once the text is safe in our own buffer the editor may let go of it, and reset()
   * is how we say so.
   */
  _captureCurrent = () => {
    if (!core.isUntitledKey(this._activeKey)) return
    const entry = this._buffers.get(this._activeKey) || {}
    entry.text = this.utils.getCurrentFileContent()
    this._buffers.set(this._activeKey, entry)
    if (File.changeCounter && File.changeCounter.reset) {
      File.changeCounter.reset()
    }
  }

  /**
   * Put an untitled buffer on screen.
   * Building File.bundle by hand is how window_tab's own onEmpty hook creates a
   * blank document (window_tab.js), and reloadContent is how the rest of the
   * project replaces editor content without touching the disk.
   */
  _showUntitled = (key) => {
    const entry = this._buffers.get(key) || { text: "" }
    File.bundle = {
      filePath: "", originalPath: null, untitledId: Number(core.untitledIdOf(key)) || Date.now(),
      fileName: null, fileEncode: null, removed: false,
      useCRLF: File.useCRLF || false, unsupported: "",
      hasModified: false, modifiedDate: null, lastSnapDate: null,
      savedContent: null, isLocked: false, oversize: false,
      fileMissingWhenOpen: false, bundleFile: null, zip: null,
    }
    File.filePath = ""
    File.reloadContent(entry.text || "", {
      fromDiskChange: false, skipChangeCount: true, skipUndo: true, skipStore: true,
    })
    const title = document.getElementById("title-text")
    if (title) title.textContent = this.config.UNTITLED_NAME_PREFIX + core.untitledIdOf(key)
    if (File.changeCounter && File.changeCounter.reset) {
      File.changeCounter.reset()
    }
    this._activeKey = key
    this._buffers.set(key, entry)
  }

  _forgetUntitled = (key) => {
    this._buffers.delete(key)
    if (this._activeKey === key) this._activeKey = ""
  }

  /** Repaint the tab bar without reopening anything. */
  _repaint = () => {
    const tab = this._wt.tab
    const path = tab.current && tab.current.path
    if (!path) return
    const render = tab.hooks && tab.hooks.onRender
    if (render) render(path)
  }

  // ==================== commands ====================

  _newUntitled = () => {
    if (!this._wt) return
    const keys = this._wt.tab.tabs.map((tab) => tab.path)
    const key = core.makeUntitledKey(core.nextUntitledId(keys))
    this._captureCurrent()
    this._buffers.set(key, { text: "" })
    this._wt.tab.open(key)      // inserts the tab and renders; it does not open a file
    this._showUntitled(key)
    this._log("new untitled buffer", key)
  }

  _confirmClose = async (idx, key) => {
    const entry = this._buffers.get(key) || { text: "" }
    const name = this.config.UNTITLED_NAME_PREFIX + core.untitledIdOf(key)
    const box = await this.utils.showMessageBox({
      type: "warning",
      title: this.pluginName,
      message: this.i18n.t("modal.saveChanges", { name: name }),
      detail: this.i18n.t("modal.saveDetail"),
      buttons: [this.i18n.t("modal.save"), this.i18n.t("modal.dontSave"), this.i18n.t("modal.cancel")],
      defaultId: 0,
      cancelId: 2,
    })
    if (box.response === 2) return                       // Cancel: the tab stays
    if (box.response === 0) {
      const saved = await this._saveAs(key, entry.text || "")
      if (!saved) return                                 // save dialog cancelled: keep the tab
    }
    this._closeQuietly(idx)
    this._forgetUntitled(key)
    await this._stashAll()
  }

  /** Turn an untitled buffer into a real file; the stash entry stops being needed. */
  _saveAs = async (key, text) => {
    const Path = this.utils.Package.Path
    const name = this.config.UNTITLED_NAME_PREFIX + core.untitledIdOf(key) + ".md"
    const dir = this.utils.getMountFolder() || this.utils.getHomeDir()
    const result = await JSBridge.invoke("dialog.showSaveDialog", {
      title: this.i18n.t("modal.saveDialogTitle"),
      defaultPath: Path.join(dir, name),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    })
    if (result.canceled || !result.filePath) return false
    const ok = await this.utils.writeFile(result.filePath, text)
    if (!ok) return false
    this.utils.openFile(result.filePath, true)
    return true
  }

  _closeQuietly = (idx) => {
    this._closing = true
    try {
      this._wt.tab.close(idx)
    } finally {
      this._closing = false
    }
  }

  // ==================== stash ====================

  _stashAll = async (sync) => {
    const session = this._session()
    const tabs = this._wt ? this._wt.tab.tabs : []
    const documents = tabs.map((tab) => this._describe(tab.path))
    const plan = core.planStash({ session: session, config: this.config, documents: documents })

    const fs = this.utils.Package.FsExtra
    const dir = this._stashDir(session.name)
    const stashedBy = new Map()
    try {
      fs.ensureDirSync(dir)
      for (const item of plan) {
        const entry = this._buffers.get(item.key)
        if (!entry) continue
        const target = this._stashPath(session.name, item.entry)
        if (sync) {
          fs.writeFileSync(target, entry.text || "")
        } else {
          await fs.writeFile(target, entry.text || "")
        }
        stashedBy.set(item.key, item.entry)
      }
    } catch (e) {
      console.error("[" + this.fixedName + "] could not write the stash", e)
    }

    const next = core.buildSession({
      name: session.name,
      activeIndex: this._wt ? this._wt.tab.activeIdx : 0,
      documents: tabs.map((tab) => ({
        key: tab.path,
        path: core.isUntitledKey(tab.path) ? "" : tab.path,
        stash: stashedBy.get(tab.path) || "",
        scrollTop: tab.scrollTop || 0,
      })),
    })
    next.name = session.name
    try {
      await this._writeSession(next, sync)
    } catch (e) {
      console.error("[" + this.fixedName + "] could not write the session", e)
    }
  }

  // ==================== restore ====================

  _restoreSession = async () => {
    // Wait until Typora settled on a document, exactly like window_tab does before
    // reopening tabs: acting earlier makes Typora treat the request as a second
    // window and spawn one.
    await this.utils.waitUntil(this.utils.isDiscardableUntitled, 50, 2000).catch(() => {})

    const openedPath = this.utils.getFilePath() || ""
    const session = this._session()
    if (!session.documents.length) {
      this._activeKey = openedPath
      return
    }

    const existingPaths = new Set()
    for (const doc of session.documents) {
      if (doc.path && await this.utils.existPath(doc.path)) existingPaths.add(doc.path)
    }
    const existingStash = new Set()
    for (const doc of session.documents) {
      if (doc.stash && await this.utils.existPath(this._stashPath(session.name, doc.stash))) {
        existingStash.add(doc.stash)
      }
    }

    const plan = core.planRestore({
      session: session,
      existingPaths: existingPaths,
      existingStash: existingStash,
    })
    const documents = plan.documents.slice()
    let activeIndex = plan.activeIndex

    // A file passed on the command line joins the session as its own tab.
    if (openedPath && !documents.some((doc) => doc.key === openedPath)) {
      documents.push({ key: openedPath, path: openedPath, scrollTop: 0 })
      activeIndex = documents.length - 1
    }
    if (!documents.length) {
      this._activeKey = openedPath
      return
    }

    // Pop the stashed bodies into memory. Kate removes the stash file once it has
    // been popped; we re-stash immediately below, so nothing is left unprotected.
    const fs = this.utils.Package.FsExtra
    for (const doc of documents) {
      if (!core.isUntitledKey(doc.key) || !doc.stash) continue
      const source = this._stashPath(session.name, doc.stash)
      try {
        const text = await fs.readFile(source, "utf-8")
        this._buffers.set(doc.key, { text: text })
        await fs.remove(source)
      } catch (e) {
        console.error("[" + this.fixedName + "] could not pop the stash entry " + doc.stash, e)
      }
    }

    this._restoring = true
    try {
      this._wt.tab.reset(documents.map((doc) => ({ path: doc.key, scrollTop: doc.scrollTop || 0 })))
      const target = documents[activeIndex] || documents[0]
      this._wt.tab._activeIdx = documents.indexOf(target)
      if (core.isUntitledKey(target.key)) {
        this._showUntitled(target.key)
        this._repaint()
      } else if (target.key === openedPath) {
        this._activeKey = openedPath      // already on screen, only the tab bar needs it
        this._repaint()
      } else {
        this._activeKey = target.key
        this._repaint()
        this.utils.openFile(target.key, true)
      }
    } finally {
      this._restoring = false
    }

    this._log("restored", documents.length, "tabs, dropped", plan.dropped.length)
    await this._stashAll()
  }
}

module.exports = {
  plugin: Sessions,
}
