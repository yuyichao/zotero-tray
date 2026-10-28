/* global ChromeUtils, ChromeWorker, Services, Zotero */
// js-ctypes bindings for the parts of GLib's GDBus that the tray item uses.
//
// js-ctypes callbacks can only be called while JS is already running on the
// thread: one that GLib calls straight from Gecko's event loop crashes. So
// GDBus is not attached to the main context Gecko's event loop iterates.
// Everything is set up with a private GMainContext as the thread-default
// context, so GDBus delivers incoming method calls, signals and async replies
// there, and that context is only ever dispatched from JS (see Pump below).
// A ChromeWorker (poll-worker.js) waits for the context's file descriptors,
// so the main thread never blocks.
//
// This also means GLib can never call a closure once its context is no longer
// being dispatched, so nothing needs to be kept alive after shutdown.

var GDBus = (function () {
  let { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
  let abi = ctypes.default_abi;
  let ptr = ctypes.voidptr_t;
  let str = ctypes.char.ptr;
  let gboolean = ctypes.int;
  let guint = ctypes.unsigned_int;
  let GError = new ctypes.StructType("GError", [
    { domain: ctypes.uint32_t },
    { code: ctypes.int },
    { message: str },
  ]);
  let GErrorPP = GError.ptr.ptr;

  let AsyncReadyCallback = ctypes.FunctionType(abi, ctypes.void_t, [ptr, ptr, ptr]);
  let MethodCallFunc = ctypes.FunctionType(abi, ctypes.void_t,
    [ptr, str, str, str, str, ptr, ptr, ptr]);
  let GetPropertyFunc = ctypes.FunctionType(abi, ptr, [ptr, str, str, str, str, GErrorPP, ptr]);
  let SignalCallback = ctypes.FunctionType(abi, ctypes.void_t, [ptr, str, str, str, str, ptr, ptr]);
  // GBusNameAcquiredCallback, GBusNameLostCallback, GBusNameVanishedCallback
  let NameCallback = ctypes.FunctionType(abi, ctypes.void_t, [ptr, str, ptr]);
  let NameAppearedCallback = ctypes.FunctionType(abi, ctypes.void_t, [ptr, str, str, ptr]);
  // GDBusConnection::closed
  let ClosedCallback = ctypes.FunctionType(abi, ctypes.void_t, [ptr, gboolean, ptr, ptr]);
  let GPollFD = new ctypes.StructType("GPollFD", [
    { fd: ctypes.int },
    { events: ctypes.unsigned_short },
    { revents: ctypes.unsigned_short },
  ]);
  let InterfaceVTable = new ctypes.StructType("GDBusInterfaceVTable", [
    { method_call: MethodCallFunc.ptr },
    { get_property: GetPropertyFunc.ptr },
    { set_property: ptr },
    { padding: ptr.array(8) },
  ]);

  let gio = ctypes.open("libgio-2.0.so.0");
  let lib = {};
  let declare = (name, ret, ...args) => {
    lib[name] = gio.declare(name, abi, ret, ...args);
  };
  declare("g_free", ctypes.void_t, ptr);
  declare("g_error_free", ctypes.void_t, GError.ptr);
  declare("g_set_error_literal", ctypes.void_t, GErrorPP, ctypes.uint32_t, ctypes.int, str);
  declare("g_object_unref", ctypes.void_t, ptr);
  declare("g_signal_connect_data", ctypes.unsigned_long, ptr, str, ptr, ptr, ptr, ctypes.int);
  declare("g_signal_handler_disconnect", ctypes.void_t, ptr, ctypes.unsigned_long);
  declare("g_cancellable_new", ptr);
  declare("g_main_context_new", ptr);
  declare("g_main_context_unref", ctypes.void_t, ptr);
  declare("g_main_context_acquire", gboolean, ptr);
  declare("g_main_context_release", ctypes.void_t, ptr);
  declare("g_main_context_push_thread_default", ctypes.void_t, ptr);
  declare("g_main_context_pop_thread_default", ctypes.void_t, ptr);
  declare("g_main_context_wakeup", ctypes.void_t, ptr);
  declare("g_main_context_prepare", gboolean, ptr, ctypes.int.ptr);
  declare("g_main_context_query", ctypes.int, ptr, ctypes.int, ctypes.int.ptr, GPollFD.ptr, ctypes.int);
  declare("g_main_context_check", gboolean, ptr, ctypes.int, GPollFD.ptr, ctypes.int);
  declare("g_main_context_dispatch", ctypes.void_t, ptr);
  declare("g_poll", ctypes.int, GPollFD.ptr, guint, ctypes.int);
  declare("g_cancellable_cancel", ctypes.void_t, ptr);

  declare("g_variant_type_new", ptr, str);
  declare("g_variant_type_free", ctypes.void_t, ptr);
  declare("g_variant_new_string", ptr, str);
  declare("g_variant_new_object_path", ptr, str);
  declare("g_variant_new_boolean", ptr, gboolean);
  declare("g_variant_new_int32", ptr, ctypes.int32_t);
  declare("g_variant_new_uint32", ptr, ctypes.uint32_t);
  declare("g_variant_new_variant", ptr, ptr);
  declare("g_variant_new_tuple", ptr, ptr.ptr, ctypes.size_t);
  declare("g_variant_new_array", ptr, ptr, ptr.ptr, ctypes.size_t);
  declare("g_variant_new_dict_entry", ptr, ptr, ptr);
  declare("g_variant_new_fixed_array", ptr, ptr, ptr, ctypes.size_t, ctypes.size_t);
  declare("g_variant_ref", ptr, ptr);
  declare("g_variant_ref_sink", ptr, ptr);
  declare("g_variant_unref", ctypes.void_t, ptr);
  declare("g_variant_get_type_string", str, ptr);
  declare("g_variant_n_children", ctypes.size_t, ptr);
  declare("g_variant_get_child_value", ptr, ptr, ctypes.size_t);
  declare("g_variant_get_variant", ptr, ptr);
  declare("g_variant_get_string", str, ptr, ptr);
  declare("g_variant_get_boolean", gboolean, ptr);
  declare("g_variant_get_byte", ctypes.uint8_t, ptr);
  declare("g_variant_get_int16", ctypes.int16_t, ptr);
  declare("g_variant_get_uint16", ctypes.uint16_t, ptr);
  declare("g_variant_get_int32", ctypes.int32_t, ptr);
  declare("g_variant_get_uint32", ctypes.uint32_t, ptr);
  declare("g_variant_get_int64", ctypes.int64_t, ptr);
  declare("g_variant_get_uint64", ctypes.uint64_t, ptr);
  declare("g_variant_get_double", ctypes.double, ptr);

  declare("g_dbus_error_quark", ctypes.uint32_t);
  declare("g_dbus_address_get_for_bus_sync", str, ctypes.int, ptr, GErrorPP);
  declare("g_dbus_connection_new_for_address", ctypes.void_t,
    str, ctypes.int, ptr, ptr, AsyncReadyCallback.ptr, ptr);
  declare("g_dbus_connection_new_for_address_finish", ptr, ptr, GErrorPP);
  declare("g_dbus_connection_close", ctypes.void_t, ptr, ptr, ptr, ptr);
  declare("g_dbus_node_info_new_for_xml", ptr, str, GErrorPP);
  declare("g_dbus_node_info_lookup_interface", ptr, ptr, str);
  declare("g_dbus_node_info_unref", ctypes.void_t, ptr);
  declare("g_dbus_connection_register_object", guint,
    ptr, str, ptr, InterfaceVTable.ptr, ptr, ptr, GErrorPP);
  declare("g_dbus_connection_unregister_object", gboolean, ptr, guint);
  declare("g_dbus_method_invocation_return_value", ctypes.void_t, ptr, ptr);
  declare("g_dbus_method_invocation_return_dbus_error", ctypes.void_t, ptr, str, str);
  declare("g_dbus_connection_emit_signal", gboolean, ptr, str, str, str, str, ptr, GErrorPP);
  declare("g_dbus_connection_call", ctypes.void_t,
    ptr, str, str, str, str, ptr, ptr, ctypes.int, ctypes.int, ptr, AsyncReadyCallback.ptr, ptr);
  declare("g_dbus_connection_call_finish", ptr, ptr, ptr, GErrorPP);
  declare("g_dbus_connection_signal_subscribe", guint,
    ptr, str, str, str, str, str, ctypes.int, SignalCallback.ptr, ptr, ptr);
  declare("g_dbus_connection_signal_unsubscribe", ctypes.void_t, ptr, guint);
  declare("g_bus_own_name_on_connection", guint,
    ptr, str, ctypes.int, NameCallback.ptr, NameCallback.ptr, ptr, ptr);
  declare("g_bus_unown_name", ctypes.void_t, guint);
  declare("g_bus_watch_name_on_connection", guint,
    ptr, str, ctypes.int, NameAppearedCallback.ptr, NameCallback.ptr, ptr, ptr);
  declare("g_bus_unwatch_name", ctypes.void_t, guint);

  let G_BUS_TYPE_SESSION = 2;
  let G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT = 1 << 0;
  let G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION = 1 << 3;
  let G_DBUS_ERROR_FAILED = 0;

  // --- Errors and strings ------------------------------------------------

  let readString = p => (p.isNull() ? null : p.readString());

  function takeError(errPtr) {
    if (errPtr.isNull()) return new Error("unknown GLib error");
    let error = new Error(readString(errPtr.contents.message));
    lib.g_error_free(errPtr);
    return error;
  }

  // --- GVariant ----------------------------------------------------------
  //
  // The constructors return floating references, which the container or
  // GDBus function they are passed to takes over.

  let V = {
    s: s => lib.g_variant_new_string(s),
    o: s => lib.g_variant_new_object_path(s),
    b: b => lib.g_variant_new_boolean(b ? 1 : 0),
    i: n => lib.g_variant_new_int32(n),
    u: n => lib.g_variant_new_uint32(n),
    v: value => lib.g_variant_new_variant(value),
    tuple(items) {
      return lib.g_variant_new_tuple(items.length ? ptr.array()(items) : null, items.length);
    },
    array(childType, items) {
      let type = lib.g_variant_type_new(childType);
      try {
        return lib.g_variant_new_array(type, items.length ? ptr.array()(items) : null, items.length);
      }
      finally {
        lib.g_variant_type_free(type);
      }
    },
    // a{sv} from an object of variants
    vardict(obj) {
      return this.array("{sv}", Object.entries(obj).map(
        ([key, value]) => lib.g_variant_new_dict_entry(this.s(key), this.v(value))));
    },
    // ay from a Uint8Array
    bytes(data) {
      let type = lib.g_variant_type_new("y");
      try {
        let buf = ctypes.uint8_t.array(data.length)();
        for (let i = 0; i < data.length; i++) buf[i] = data[i];
        return lib.g_variant_new_fixed_array(type, buf.address(), data.length, 1);
      }
      finally {
        lib.g_variant_type_free(type);
      }
    },
    // Takes ownership of a floating variant so it can be handed out repeatedly.
    keep: value => lib.g_variant_ref_sink(value),
    ref: value => lib.g_variant_ref(value),
    unref: value => lib.g_variant_unref(value),
  };

  // Convert a GVariant to JS: containers become arrays (a dict entry is a
  // [key, value] array), maybe-types become the value or null.
  function unpack(value) {
    let type = lib.g_variant_get_type_string(value).readString();
    switch (type[0]) {
      case "s": case "o": case "g":
        return lib.g_variant_get_string(value, null).readString();
      case "b": return !!lib.g_variant_get_boolean(value);
      case "y": return lib.g_variant_get_byte(value);
      case "n": return lib.g_variant_get_int16(value);
      case "q": return lib.g_variant_get_uint16(value);
      case "i": case "h": return lib.g_variant_get_int32(value);
      case "u": return lib.g_variant_get_uint32(value);
      case "x": return Number(lib.g_variant_get_int64(value).toString());
      case "t": return Number(lib.g_variant_get_uint64(value).toString());
      case "d": return lib.g_variant_get_double(value);
      case "v": {
        let inner = lib.g_variant_get_variant(value);
        try {
          return unpack(inner);
        }
        finally {
          lib.g_variant_unref(inner);
        }
      }
    }
    let items = [];
    let n = Number(lib.g_variant_n_children(value).toString());
    for (let i = 0; i < n; i++) {
      let child = lib.g_variant_get_child_value(value, i);
      try {
        items.push(unpack(child));
      }
      finally {
        lib.g_variant_unref(child);
      }
    }
    if (type[0] == "m") return items.length ? items[0] : null;
    return items;
  }

  // --- Callback dispatch ---------------------------------------------------

  let handlers = new Map();
  let nextKey = 1;

  let addHandler = (handler) => {
    let key = nextKey++;
    handlers.set(key, handler);
    return key;
  };
  let keyPtr = key => ptr(key);
  let handlerFor = ud => handlers.get(Number(ctypes.cast(ud, ctypes.uintptr_t).value.toString()));

  let guard = (what, fn) => function (...args) {
    try {
      return fn(...args);
    }
    catch (e) {
      Zotero.debug(`Zotero Tray: error in GDBus ${what} callback`);
      Zotero.logError(e);
      return undefined;
    }
  };

  // The js-ctypes closures GLib calls, all created once; they find their JS
  // handler by the integer passed as user_data.
  let cb = {
    // For async calls the handler is { pump, done(source, res) }.
    asyncReady: AsyncReadyCallback.ptr(guard("async reply", (source, res, ud) => {
      let key = Number(ctypes.cast(ud, ctypes.uintptr_t).value.toString());
      let handler = handlers.get(key);
      handlers.delete(key);
      if (!handler) return;
      handler.pump.pending--;
      handler.done(source, res);
    })),
    methodCall: MethodCallFunc.ptr(
      (conn, sender, path, iface, method, params, invocation, ud) => {
        let ret = null;
        try {
          let handler = handlerFor(ud);
          if (!handler) throw new Error("object is gone");
          ret = handler.methodCall(readString(iface), readString(method), unpack(params));
        }
        catch (e) {
          if (!e.dbusName) Zotero.logError(e);
          lib.g_dbus_method_invocation_return_dbus_error(invocation,
            e.dbusName || "org.freedesktop.DBus.Error.Failed", String(e.message || e));
          return;
        }
        lib.g_dbus_method_invocation_return_value(invocation, ret);
      }),
    // GDBus asserts that an error is set whenever this returns NULL, so
    // this must never throw.
    getProperty: GetPropertyFunc.ptr(
      (conn, sender, path, iface, name, errorOut, ud) => {
        let value = null;
        let message = "unknown property";
        try {
          value = handlerFor(ud)?.getProperty(readString(iface), readString(name)) ?? null;
        }
        catch (e) {
          Zotero.logError(e);
          message = String(e.message || e);
        }
        if (value) return value;
        lib.g_set_error_literal(errorOut, lib.g_dbus_error_quark(), G_DBUS_ERROR_FAILED, message);
        return ptr(0);
      }, null, ptr(0)),
    signal: SignalCallback.ptr(guard("signal",
      (conn, sender, path, iface, member, params, ud) => {
        handlerFor(ud)?.(unpack(params), readString(sender));
      })),
    nameAcquired: NameCallback.ptr(guard("name acquired",
      (conn, name, ud) => handlerFor(ud)?.acquired())),
    nameLost: NameCallback.ptr(guard("name lost",
      (conn, name, ud) => handlerFor(ud)?.lost())),
    nameAppeared: NameAppearedCallback.ptr(guard("name appeared",
      (conn, name, owner, ud) => handlerFor(ud)?.appeared(readString(owner)))),
    nameVanished: NameCallback.ptr(guard("name vanished",
      (conn, name, ud) => handlerFor(ud)?.vanished())),
    closed: ClosedCallback.ptr(guard("closed",
      (conn, remoteVanished, error, ud) => handlerFor(ud)?.())),
  };

  // --- Main context pump -----------------------------------------------------
  //
  // One GLib main loop iteration (prepare, query, poll, check, dispatch) at a
  // time, split across the main thread and the poll worker: the main thread
  // first polls without waiting; if nothing is ready, the worker waits for
  // the file descriptors and posts back which are ready.
  //
  // GLib does not wake a context's poll when the thread that owns it attaches
  // a source, so the main thread wakes it itself after each GDBus operation
  // (run()), to have the new source (e.g. a call's timeout) taken into account.

  // Upper bound for one wait in the worker, so it never blocks for long if
  // nothing wakes it (e.g. at shutdown).
  let MAX_WAIT_MS = 10000;
  // How long to keep dispatching after shutdown for pending calls to finish.
  let DRAIN_MS = 2000;

  class Pump {
    constructor() {
      this.ctx = lib.g_main_context_new();
      lib.g_main_context_acquire(this.ctx);
      this.fds = GPollFD.array(8)();
      this.nfds = 0;
      this.maxPriority = ctypes.int();
      // idle, scheduled, iterating or waiting (on the worker)
      this.state = "idle";
      this.stopping = false;
      this.drainUntil = 0;
      // Async calls whose callback has not run yet
      this.pending = 0;
      this.worker = new ChromeWorker(workerURL);
      this.worker.onmessage = ({ data }) => this.onWaited(data);
      this.worker.onerror = (e) => {
        Zotero.debug("Zotero Tray: poll worker error: " + e.message);
      };
      this.schedule();
    }

    // Run a GDBus operation with the private context as thread-default, so
    // its callbacks are delivered there.
    // Start an async call; `done(source, res)` is called with its result.
    startAsync(done, fn) {
      let key = addHandler({ pump: this, done });
      this.pending++;
      this.run(() => fn(cb.asyncReady, keyPtr(key)));
    }

    run(fn) {
      lib.g_main_context_push_thread_default(this.ctx);
      try {
        return fn();
      }
      finally {
        lib.g_main_context_pop_thread_default(this.ctx);
        this.kick();
      }
    }

    kick() {
      if (this.state == "waiting") lib.g_main_context_wakeup(this.ctx);
      else this.schedule();
    }

    schedule() {
      if (this.state != "idle" || !this.ctx) return;
      this.state = "scheduled";
      Services.tm.dispatchToMainThread(() => {
        if (this.state != "scheduled") return;
        this.state = "idle";
        this.iterate();
      });
    }

    iterate() {
      if (this.state != "idle" || !this.ctx) return;
      if (this.stopping && (this.pending <= 0 || Date.now() > this.drainUntil)) {
        this.destroy();
        return;
      }
      this.state = "iterating";
      lib.g_main_context_prepare(this.ctx, this.maxPriority.address());
      let timeout = ctypes.int();
      for (;;) {
        this.nfds = lib.g_main_context_query(this.ctx, this.maxPriority.value, timeout.address(),
          this.fds.addressOfElement(0), this.fds.length);
        if (this.nfds <= this.fds.length) break;
        this.fds = GPollFD.array(this.nfds)();
      }
      let ready = lib.g_poll(this.fds.addressOfElement(0), this.nfds, 0) > 0;
      if (ready || timeout.value == 0) {
        this.finishIteration();
        return;
      }
      let wait = timeout.value < 0 ? MAX_WAIT_MS : Math.min(timeout.value, MAX_WAIT_MS);
      if (this.stopping) wait = Math.min(wait, Math.max(0, this.drainUntil - Date.now()));
      let fds = [];
      for (let i = 0; i < this.nfds; i++) {
        fds.push([this.fds[i].fd, this.fds[i].events]);
      }
      this.state = "waiting";
      this.worker.postMessage({ fds, timeout: wait });
    }

    onWaited(revents) {
      if (this.state != "waiting") return;
      revents.forEach((value, i) => {
        if (i < this.nfds) this.fds[i].revents = value;
      });
      this.state = "iterating";
      this.finishIteration();
    }

    finishIteration() {
      try {
        if (lib.g_main_context_check(this.ctx, this.maxPriority.value,
          this.fds.addressOfElement(0), this.nfds)) {
          lib.g_main_context_dispatch(this.ctx);
        }
      }
      finally {
        this.state = "idle";
        // Next iteration from a fresh event loop turn, so a busy context
        // cannot starve Zotero.
        this.schedule();
      }
    }

    // Keep dispatching until pending calls have finished (or DRAIN_MS has
    // passed), then free the context.
    stop() {
      if (this.stopping) return;
      this.stopping = true;
      this.drainUntil = Date.now() + DRAIN_MS;
      this.kick();
    }

    destroy() {
      this.worker.terminate();
      lib.g_main_context_release(this.ctx);
      lib.g_main_context_unref(this.ctx);
      this.ctx = null;
      this.state = "stopped";
    }
  }

  let workerURL = null;

  // --- Connection ----------------------------------------------------------

  class Connection {
    constructor(conn, pump) {
      this.ptr = conn;
      this.pump = pump;
      this.cancellable = lib.g_cancellable_new();
      this.keys = [];
      this.objects = [];
      this.nodes = [];
      this.subscriptions = [];
      this.owners = [];
      this.watchers = [];
      this.vtable = new InterfaceVTable();
      this.vtable.method_call = cb.methodCall;
      this.vtable.get_property = cb.getProperty;
      this.onClosed = null;
      let key = this.persist(() => {
        if (this.ptr) this.onClosed?.();
      });
      this.closedHandler = lib.g_signal_connect_data(conn, "closed",
        ctypes.cast(cb.closed, ptr), keyPtr(key), null, 0);
    }

    persist(handler) {
      let key = addHandler(handler);
      this.keys.push(key);
      return key;
    }

    // Resolves with the reply's arguments as an array.
    call(dest, path, iface, method, params = null, timeout = 5000) {
      if (!this.ptr) return Promise.reject(new Error("connection is closed"));
      return new Promise((resolve, reject) => {
        this.pump.startAsync((source, res) => {
          let err = GError.ptr();
          let reply = lib.g_dbus_connection_call_finish(source, res, err.address());
          if (reply.isNull()) {
            reject(takeError(err));
            return;
          }
          try {
            resolve(unpack(reply));
          }
          finally {
            lib.g_variant_unref(reply);
          }
        }, (callback, userData) => lib.g_dbus_connection_call(this.ptr, dest, path, iface, method,
          params, null, 0, timeout, this.cancellable, callback, userData));
      });
    }

    // Method call without waiting for (or asking for) a reply.
    send(dest, path, iface, method, params = null) {
      if (!this.ptr) return;
      this.pump.run(() => lib.g_dbus_connection_call(this.ptr, dest, path, iface, method, params,
        null, 0, -1, null, null, null));
    }

    emitSignal(path, iface, name, params = null) {
      if (!this.ptr) return;
      let err = GError.ptr();
      if (!lib.g_dbus_connection_emit_signal(this.ptr, null, path, iface, name, params, err.address())) {
        Zotero.logError(takeError(err));
      }
    }

    // `impl.methodCall(iface, method, args)` returns the reply tuple (or
    // null) or throws, with `dbusName` set for a D-Bus error reply;
    // `impl.getProperty(iface, name)` returns a variant.
    registerObject(path, xml, impl) {
      this.pump.run(() => this._registerObject(path, xml, impl));
    }

    _registerObject(path, xml, impl) {
      let err = GError.ptr();
      let node = lib.g_dbus_node_info_new_for_xml(xml, err.address());
      if (node.isNull()) throw takeError(err);
      this.nodes.push(node);
      let key = this.persist(impl);
      for (let iface of impl.interfaces) {
        let info = lib.g_dbus_node_info_lookup_interface(node, iface);
        let id = lib.g_dbus_connection_register_object(this.ptr, path, info, this.vtable.address(),
          keyPtr(key), null, err.address());
        if (!id) throw takeError(err);
        this.objects.push(id);
      }
    }

    subscribe(sender, iface, member, path, handler) {
      let id = this.pump.run(() => lib.g_dbus_connection_signal_subscribe(this.ptr, sender, iface,
        member, path, null, 0, cb.signal, keyPtr(this.persist(handler)), null));
      this.subscriptions.push(id);
      return id;
    }

    unsubscribe(id) {
      let i = this.subscriptions.indexOf(id);
      if (i < 0) return;
      this.subscriptions.splice(i, 1);
      lib.g_dbus_connection_signal_unsubscribe(this.ptr, id);
    }

    ownName(name, acquired, lost) {
      this.owners.push(this.pump.run(() => lib.g_bus_own_name_on_connection(this.ptr, name, 0,
        cb.nameAcquired, cb.nameLost, keyPtr(this.persist({ acquired, lost })), null)));
    }

    watchName(name, appeared, vanished) {
      this.watchers.push(this.pump.run(() => lib.g_bus_watch_name_on_connection(this.ptr, name, 0,
        cb.nameAppeared, cb.nameVanished, keyPtr(this.persist({ appeared, vanished })), null)));
    }

    close() {
      let conn = this.ptr;
      if (!conn) return;
      // None of these call back after they return.
      this.pump.run(() => this._close(conn));
      // Pending calls finish with an error; dispatch until they have.
      this.pump.stop();
    }

    _close(conn) {
      lib.g_signal_handler_disconnect(conn, this.closedHandler);
      this.watchers.forEach(id => lib.g_bus_unwatch_name(id));
      this.owners.forEach(id => lib.g_bus_unown_name(id));
      this.subscriptions.forEach(id => lib.g_dbus_connection_signal_unsubscribe(conn, id));
      this.objects.forEach(id => lib.g_dbus_connection_unregister_object(conn, id));
      this.nodes.forEach(node => lib.g_dbus_node_info_unref(node));
      this.keys.forEach(key => handlers.delete(key));
      this.watchers = this.owners = this.subscriptions = this.objects = this.nodes = this.keys = [];
      this.ptr = null;
      lib.g_cancellable_cancel(this.cancellable);
      lib.g_object_unref(this.cancellable);
      // Messages already sent are written before the connection is closed.
      lib.g_dbus_connection_close(conn, null, null, null);
      lib.g_object_unref(conn);
    }
  }

  // Opens a private connection to the session bus, so that closing it drops
  // everything this plugin exported at once.
  function connectSession() {
    let err = GError.ptr();
    let address = lib.g_dbus_address_get_for_bus_sync(G_BUS_TYPE_SESSION, null, err.address());
    if (address.isNull()) return Promise.reject(takeError(err));
    let addressString = address.readString();
    lib.g_free(ctypes.cast(address, ptr));
    let pump = new Pump();
    return new Promise((resolve, reject) => {
      pump.startAsync((source, res) => {
        let err = GError.ptr();
        let conn = lib.g_dbus_connection_new_for_address_finish(res, err.address());
        if (conn.isNull()) {
          pump.stop();
          reject(takeError(err));
        }
        else {
          resolve(new Connection(conn, pump));
        }
      }, (callback, userData) => lib.g_dbus_connection_new_for_address(addressString,
        G_DBUS_CONNECTION_FLAGS_AUTHENTICATION_CLIENT | G_DBUS_CONNECTION_FLAGS_MESSAGE_BUS_CONNECTION,
        null, null, callback, userData));
    });
  }

  // `url` is the URL of poll-worker.js.
  let init = (url) => {
    workerURL = url;
  };

  return { V, unpack, init, connectSession };
})();
