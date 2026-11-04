/*
 * Quire plugin SDK. Loaded into every plugin's sandboxed frame before
 * the plugin's own script, it exposes the global `ms`. Every call is a
 * message to the app, which checks the plugin's permissions before acting.
 * Plugins cannot reach the app, the file system or the network directly.
 */
(function () {
  "use strict";
  var pending = new Map();
  var nextId = 1;
  var listeners = Object.create(null);
  var info = null;
  var finderHandlers = null; // ms.find.provide's handlers, run when Find asks
  var resolveInit;
  var initP = new Promise(function (r) {
    resolveInit = r;
  });

  function post(msg) {
    window.parent.postMessage(msg, "*");
  }

  function emit(name, payload) {
    (listeners[name] || []).slice().forEach(function (fn) {
      try {
        var r = fn(payload);
        if (r && typeof r.catch === "function") r.catch(report);
      } catch (err) {
        report(err);
      }
    });
  }

  function report(err) {
    call("log", { level: "error", message: String((err && err.stack) || err) }).catch(function () {});
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || typeof m !== "object") return;
    if (m.type === "init") {
      if (info) return;
      info = m.info;
      resolveInit(info);
      emit("ready", info);
    } else if (m.type === "result") {
      var p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value);
      else p.reject(new Error(m.error));
    } else if (m.type === "event") {
      if (m.name === "find.ask") onFindAsk(m.payload || {});
      else emit(m.name, m.payload);
    }
  });

  /** Find asks the platform something: its handler for `op` runs, and its answer goes back. */
  function onFindAsk(q) {
    var answer = function (ok, value) {
      call("find.answer", ok ? { ask: q.ask, ok: true, value: value === undefined ? null : value } : { ask: q.ask, ok: false, error: String((value && value.message) || value) }).catch(function () {});
    };
    var fn = finderHandlers && finderHandlers[q.op];
    if (typeof fn !== "function") return answer(false, "this platform can't " + q.op);
    Promise.resolve()
      .then(function () {
        return fn(q.args || {});
      })
      .then(
        function (v) {
          answer(true, v);
        },
        function (e) {
          answer(false, e);
        },
      );
  }

  window.addEventListener("error", function (e) {
    report(e.error || e.message);
  });
  window.addEventListener("unhandledrejection", function (e) {
    report(e.reason);
  });

  function call(method, args) {
    return initP.then(function () {
      return new Promise(function (resolve, reject) {
        var id = nextId++;
        pending.set(id, { resolve: resolve, reject: reject });
        post({ type: "call", id: id, method: method, args: args === undefined ? null : args });
      });
    });
  }

  function toBase64(buf) {
    var bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    var s = "";
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function fromBase64(b64) {
    var s = atob(b64);
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  /** Decode, downscale so the long edge is at most maxEdge, re-encode as JPEG. */
  function downscale(buf, mime, maxEdge, quality) {
    return createImageBitmap(new Blob([buf], { type: mime }), { imageOrientation: "from-image" }).then(function (bmp) {
      var scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
      var w = Math.max(1, Math.round(bmp.width * scale));
      var h = Math.max(1, Math.round(bmp.height * scale));
      var c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      c.getContext("2d").drawImage(bmp, 0, 0, w, h);
      return new Promise(function (resolve, reject) {
        c.toBlob(
          function (blob) {
            if (!blob) return reject(new Error("could not encode image"));
            blob.arrayBuffer().then(function (ab) {
              resolve({ base64: toBase64(ab), mime: "image/jpeg", width: w, height: h, originalWidth: bmp.width, originalHeight: bmp.height });
            }, reject);
          },
          "image/jpeg",
          quality
        );
      });
    });
  }

  window.ms = {
    /** Manifest, settings, app version, theme and its mode ("light" | "dark"), available after "ready". */
    get info() {
      return info;
    },
    on: function (name, fn) {
      (listeners[name] = listeners[name] || []).push(fn);
      if (name === "ready" && info) fn(info);
      return function () {
        listeners[name] = (listeners[name] || []).filter(function (f) {
          return f !== fn;
        });
      };
    },
    log: function () {
      return call("log", { level: "info", message: Array.prototype.map.call(arguments, String).join(" ") });
    },
    ui: {
      toast: function (text, tone) {
        return call("ui.toast", { text: String(text), tone: tone || "info" });
      },
      /** { id, location: "viewer.toolbar" | "browse.selection" | "album.card", label, tooltip?, icon? (SVG markup) } */
      addButton: function (spec) {
        return call("ui.addButton", spec);
      },
      updateButton: function (id, patch) {
        return call("ui.updateButton", { id: id, patch: patch });
      },
      removeButton: function (id) {
        return call("ui.removeButton", { id: id });
      },
      /**
       * A long job in Activity (the progress ring at the top): task { label, done, total, detail?, item?, pausable? },
       * shown or updated under id; null ends it. item is the key of the item it is on, shown as a
       * thumbnail. Its Stop sends the "cancel" event; with pausable: true its Pause and Resume send
       * "pause" ({ id, paused }) — hold the job before its next step while paused.
       */
      progress: function (id, task) {
        return call("ui.progress", { id: id, task: task || null });
      },
      /**
       * The plugin's panel at the right of the viewer, opened by its button in the viewer bar:
       * { title, icon? (SVG), controls: [...] }, replaced whole each call. Controls:
       *   { type: "heading", label } · { type: "text", text }
       *   { type: "button", id, label, tooltip?, primary?, active?, busy?, disabled? }
       *   { type: "toggle", id, label, value } · { type: "choice", id, label, options: [{ id, label }], value }
       *   { type: "brush", id, modes: [{ id, label }], mode, hint? }  (needs the viewer permission; one per panel)
       *   { type: "colour", id, label, value: "#rrggbb" | null }  (an eyedropper on the image; needs viewer)
       * Buttons, toggles and choices come back as the "panel" event { id, value }; a brush mode
       * change too. The brush paints on the image: after every stroke, undo or clear, the "stroke"
       * event brings { id, itemKey, masks: { modeId: Uint8Array PNG, white where painted }, shapes, count }.
       */
      panel: function (spec) {
        return call("ui.panel", spec);
      },
      /** Change one control: { label, tooltip, hint, text, primary, active, busy, disabled, value, mode }. */
      panelPatch: function (id, patch) {
        return call("ui.panelPatch", { id: id, patch: patch });
      },
      panelOpen: function (open) {
        return call("ui.panelOpen", { open: open !== false });
      },
      /** Forget the brush's strokes (after they were used). */
      brushClear: function () {
        return call("ui.brushClear", {});
      },
    },
    overlay: {
      /**
       * boxes: [{ x, y, w, h (0..1 of the image), text, vertical? }], or with
       * { image: ArrayBuffer | Uint8Array, mime: "image/png" | "image/jpeg" | "image/webp" }
       * in place of text, drawn stretched to the box (at most 4 image boxes).
       */
      set: function (itemKey, boxes) {
        return call("overlay.set", { itemKey: itemKey, boxes: boxes });
      },
      clear: function (itemKey) {
        return call("overlay.clear", { itemKey: itemKey || null });
      },
    },
    viewer: {
      current: function () {
        return call("viewer.current");
      },
      next: function () {
        return call("viewer.next");
      },
      prev: function () {
        return call("viewer.prev");
      },
      /** "ltr" | "rtl"; with albumKey only while that album is shown. */
      /**
       * Ask the reader to mark part of the image in the viewer (permission "viewer"): they draw
       * loose shapes and press Enter. Resolves to { shapes: [[{ x, y }, ...], ...] } in fractions
       * of the image, or null when they cancel or the viewer moves on.
       */
      /** "ltr" | "rtl"; with albumKey only while that album is shown. */
      /**
       * Ask the reader to mark part of the image in the viewer (permission "viewer"): they draw
       * loose shapes and press Enter. Resolves to { shapes: [[{ x, y }, ...], ...] } in fractions
       * of the image, or null when they cancel or the viewer moves on.
       */
      /**
       * Marking mode: the reader paints over the image with a brush (a stroke that circles
       * something fills the circle), with a panel of controls. { prompt, modes?: [{ id, label }]
       * (what a stroke means, up to 4; each gets its own mask), mode?, choices?: [{ id, label }]
       * (such as the bar's colour, up to 4), choice?, actions?: [{ id, label }] (the plugin's own
       * buttons, up to 4; pressing one ends the marking with that `action`) } →
       * { masks: { [modeId]: Uint8Array PNG, white where painted }, shapes (the current mode's
       * strokes as shapes), mode, choice, action } or null if cancelled.
       */
      pickArea: function (opts) {
        opts = opts || {};
        return call("viewer.pickArea", { prompt: opts.prompt || "", choices: opts.choices || [], choice: opts.choice || null, modes: opts.modes || [], mode: opts.mode || null, actions: opts.actions || [] });
      },
      setDirection: function (dir, albumKey) {
        return call("viewer.setDirection", { dir: dir, albumKey: albumKey || null });
      },
    },
    media: {
      /** Items in the viewer's current queue (metadata only). */
      list: function () {
        return call("media.list");
      },
      /** Every album in the opened folder: [{ key, name, count, modified, translation }] (translation: the album it is read as when translated, set in Albums). */
      albums: function () {
        return call("media.albums");
      },
      /** The pages of an album (an album card's `album.key`), in reading order (metadata only). */
      album: function (albumKey) {
        return call("media.album", { albumKey: albumKey });
      },
      /** Raw displayable bytes (ArrayBuffer) of an item: file, or a RAW's preview. */
      readImageBytes: function (itemKey) {
        return call("media.readImage", { itemKey: itemKey });
      },
      /** Downscaled JPEG as base64, ready for an API. opts: { maxEdge = 1568, quality = 0.85 } */
      readImage: function (itemKey, opts) {
        opts = opts || {};
        return call("media.readImage", { itemKey: itemKey }).then(function (r) {
          return downscale(r.bytes, r.mime, opts.maxEdge || 1568, opts.quality || 0.85);
        });
      },
      /**
       * Save a new file next to an item, made from it: the app links the two (Info shows it).
       * data: ArrayBuffer | Uint8Array | base64 string. opts.note: what such a version is called ("cleaned").
       */
      save: function (nextToItemKey, name, data, opts) {
        var b64 = typeof data === "string" ? data : toBase64(data);
        return call("media.save", { itemKey: nextToItemKey, name: name, base64: b64, note: (opts && opts.note) || null, was: (opts && opts.was) || null });
      },
      /**
       * A new version of an item: the app asks the reader whether to keep it in place of the
       * original (under the original's name; the app keeps the original, so Revert brings it
       * back) or as a copy (`name`, next to the item), unless opts.choice is "replace" or "copy"
       * (a plugin whose panel offers both).
       * opts.note: what such a version is called ("cleaned").
       * { name, key, replaced } for what was written, or null if they chose neither.
       */
      keep: function (itemKey, name, data, opts) {
        var b64 = typeof data === "string" ? data : toBase64(data);
        // `was`: { size, modified } of the item the result was made from; refused if the key holds another picture now.
        return call("media.keep", { itemKey: itemKey, name: name, base64: b64, choice: (opts && opts.choice) || null, note: (opts && opts.note) || null, was: (opts && opts.was) || null });
      },
      /**
       * What Quire knows of an item as a version: { madeFrom: { name, note, mine, kept } or
       * null, made: [{ name, note, mine }] } (the versions made from it still in the library).
       * `mine`: this plugin made it; `kept`: the original is kept, so Revert can bring it back.
       */
      versions: function (itemKey) {
        return call("media.versions", { itemKey: itemKey });
      },
      /**
       * A version this plugin made, its original kept (see versions): the original back in its
       * place, as Revert in Info does. { reverted }. Needs media:write.
       */
      revert: function (itemKey) {
        return call("media.revert", { itemKey: itemKey });
      },
    },
    engine: {
      /**
       * The plugin's own pipeline on an image, on this computer (permission "engine"; "engine" in
       * plugin.json names its WebAssembly module, built with Quire's engine SDK, and "models"
       * the models it may run). opts are passed to it as JSON (bytes become base64). Progress comes as
       * "engine" events ({ stage, state, done, total }). Resolves to { bytes: ArrayBuffer (PNG) or null,
       * mime, width, height, result: what the pipeline answered, seconds }.
       */
      run: function (itemKey, opts) {
        return call("engine.run", { itemKey: itemKey, options: opts || {} });
      },
      /**
       * The language model the user chose in Local models, which the engine's text tools translate
       * with when the pipeline names none: { id, name } or null. The "model" event says when it changes.
       */
      languageModel: function () {
        return call("engine.languageModel", {});
      },
    },
    /**
     * Versions of pictures this plugin makes, for the duplicate check (needs media:write): spec
     * { id, label, tooltip?, prefix?, keys?, note }. Shows a toggle on the Duplicates screen; while
     * it is on, a copy named prefix + a picture's name beside it is matched with that picture, and
     * versions (named so, or listed in keys: made in place of their original) are matched with
     * other pictures more loosely. Call again to update it; null removes it.
     */
    dupes: {
      versions: function (spec) {
        return call("dupes.versions", { spec: spec == null ? null : spec });
      },
    },
    /**
     * The Home's shared panels: panels plugins fill together, each its own part, by the panel's name
     * (lowercase words with dashes). share(panel, { title, items: [{ id, title, thumb | image + mime,
     * work }] }) replaces this plugin's part; share(panel, null) takes it away. A click on an item
     * with `work` opens that work in Find; any other comes back as the "home" event { panel, id }.
     */
    home: {
      share: function (panel, spec) {
        return call("home.share", { panel: panel, spec: spec == null ? null : spec });
      },
    },
    storage: {
      get: function (key) {
        return call("storage.all").then(function (all) {
          return all[key];
        });
      },
      all: function () {
        return call("storage.all");
      },
      set: function (key, value) {
        return call("storage.set", { key: key, value: value === undefined ? null : value });
      },
    },
    settings: {
      get: function () {
        return call("settings.get");
      },
    },
    /** Data kept with the library on its drive (needs library:storage): in its vault when it has one. Up to 1 MB. */
    library: {
      get: function (key) {
        return call("library.get", { key: key });
      },
      set: function (key, value) {
        return call("library.set", { key: key, value: value === undefined ? null : value });
      },
    },
    login: {
      /**
       * A platform's sign-in page in a window of its own (needs login:<host>): spec { url, until, name?,
       * cookies?, load? }, `until` the addresses the platform sends the sign-in back to. Gives the address
       * it ended on (or what the user pasted, signing in with their browser instead), or null when they
       * closed it; with `cookies` (addresses on network: hosts), { url, cookies } with the window's
       * cookies for each. It ends as one of `until` is asked for, before it loads (a callback whose code
       * is the plugin's); with `load`, once it has loaded (a site that stores its sign-in on the way).
       */
      open: function (spec) {
        return call("login.open", spec || {});
      },
      /**
       * A site opened in a window of the app's own for the reader to answer what it asks first (its
       * browser check, an age question), then press Done: spec { url, name }. Gives { cookies,
       * userAgent } (requests then send both), or null.
       */
      check: function (spec) {
        return call("login.check", spec || {});
      },
    },
    /** Sites the reader adds (needs sites): each one allowed by them when added, it and its subdomains. */
    sites: {
      list: function () {
        return call("sites.list");
      },
      /** Ask the reader to allow the site at `url`: its domain, or null when they don't. */
      add: function (url) {
        return call("sites.add", { url: url });
      },
      remove: function (domain) {
        return call("sites.remove", { domain: domain });
      },
    },
    find: {
      /**
       * Provide a platform to Find (needs find): info { name, site?, imageHeaders?, sections, artist? }
       * and handlers { account, signIn, signOut, list, work, files, suggest?, follow? }, each given its
       * arguments and returning (a promise of) its answer. See docs/plugins.md.
       */
      provide: function (info, handlers) {
        finderHandlers = handlers || {};
        return call("find.provide", info);
      },
    },
    net: {
      /**
       * A page of a site the plugin may open, fetched by the site's browser session: a hidden window
       * of the app's own that passed its check (login.check), so the request is the browser's own.
       * opts { cookies }: the site's cookies kept from login.check, to open the session again after
       * the app restarted. Gives { status, ok, text() }; refused ("no browser session…") before any.
       */
      browse: function (url, opts) {
        return call("net.browse", { url: url, cookies: (opts && opts.cookies) || null }).then(function (r) {
          return {
            status: r.status,
            ok: r.status >= 200 && r.status < 300,
            text: function () {
              return Promise.resolve(r.body);
            },
          };
        });
      },
      /** fetch-like; only https and only to hosts granted in the manifest. `body`: text, or bytes (ArrayBuffer or typed array). */
      fetch: function (url, opts) {
        opts = opts || {};
        var body = opts.body == null ? null : opts.body;
        var bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength) : null;
        return call("net.fetch", { url: url, method: opts.method || "GET", headers: opts.headers || {}, body: bytes || body == null ? null : String(body), bodyBase64: bytes ? toBase64(bytes) : null }).then(function (r) {
          return {
            status: r.status,
            ok: r.status >= 200 && r.status < 300,
            headers: r.headers,
            text: function () {
              return Promise.resolve(r.body != null ? r.body : atob(r.bodyBase64 || ""));
            },
            json: function () {
              return Promise.resolve(JSON.parse(r.body || "null"));
            },
            bytes: function () {
              return Promise.resolve(r.bodyBase64 ? fromBase64(r.bodyBase64) : new TextEncoder().encode(r.body || ""));
            },
          };
        });
      },
    },
    util: { toBase64: toBase64, fromBase64: fromBase64 },
  };

  post({ type: "hello" });
})();
