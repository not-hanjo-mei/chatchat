/* 測試用的 Firebase 替身：只在記憶體裡模擬 RTDB 的行為 */
const shared = (globalThis.__fbStubState ??= { tree: {}, listeners: [], disconnectQueue: [] });
const tree = shared.tree;
const listeners = shared.listeners;

function parts(path) {
    return String(path).split("/").filter(Boolean);
}

function walk(path, create = false) {
    let node = tree;
    for (const part of parts(path)) {
        if (node[part] === undefined) {
            if (!create) return undefined;
            node[part] = {};
        }
        node = node[part];
    }
    return node;
}

function snapshot(path) {
    const value = walk(path);
    const key = parts(path).pop() ?? null;
    return {
        key,
        val: () => (value === undefined ? null : JSON.parse(JSON.stringify(value))),
        exists: () => value !== undefined,
    };
}

function withoutMeta(value) {
    if (value === null || typeof value !== "object") return value;
    return JSON.parse(JSON.stringify(value));
}

function notify(changedPath) {
    for (const listener of [...listeners]) {
        const listenerParts = parts(listener.path);
        const changedParts = parts(changedPath);

        if (listener.kind === "value") {
            const related =
                changedPath === listener.path ||
                changedPath.startsWith(`${listener.path}/`) ||
                listener.path.startsWith(`${changedPath}/`);
            if (related) listener.callback(snapshot(listener.path));
            continue;
        }

        if (changedParts.length <= listenerParts.length) continue;
        const childKey = changedParts[listenerParts.length];
        const childPath = [...listenerParts, childKey].join("/");

        if (listener.kind === "child_added" && changedParts.length === listenerParts.length + 1) {
            listener.callback(snapshot(childPath));
        }
        if (listener.kind === "child_changed" && listener.seen.has(childKey)) {
            listener.callback(snapshot(childPath));
        }
        if (listener.kind === "child_added" || listener.kind === "child_changed") {
            listener.seen.add(childKey);
        }
    }
}

export function initializeApp() {
    return { name: "stub" };
}

export function getDatabase() {
    return { __stub: true };
}

export function ref(_db, path) {
    return { path: String(path).replace(/^\/+/, "") };
}

export async function get(target) {
    return snapshot(target.path);
}

export async function set(target, value) {
    const node = walk(target.path, true);
    const parent = walk(parts(target.path).slice(0, -1).join("/"), true);
    const key = parts(target.path).pop();
    parent[key] = withoutMeta(value);
    void node;
    notify(target.path);
}

export async function update(target, patch) {
    const node = walk(target.path, true);
    Object.assign(node, patch);
    notify(target.path);
}

export async function remove(target) {
    const parent = walk(parts(target.path).slice(0, -1).join("/"));
    const key = parts(target.path).pop();
    if (parent && key in parent) delete parent[key];
    notify(target.path);
}

export async function push(target, value) {
    const key = `-stub${String(Math.random()).slice(2, 12)}`;
    await set(ref(null, `${target.path}/${key}`), value);
    return { key };
}

function subscribe(kind, target, callback) {
    const listener = { kind, path: target.path, callback, seen: new Set() };
    listeners.push(listener);

    if (kind === "value") callback(snapshot(target.path));
    if (kind === "child_added") {
        const node = walk(target.path);
        for (const [key, value] of Object.entries(node ?? {})) {
            listener.seen.add(key);
            void value;
            callback(snapshot(`${target.path}/${key}`));
        }
    }

    return () => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
    };
}

export const onValue = (target, callback) => subscribe("value", target, callback);
export const onChildAdded = (target, callback) => subscribe("child_added", target, callback);
export const onChildChanged = (target, callback) => subscribe("child_changed", target, callback);

export function onDisconnect(target) {
    /* 真實的 Firebase 是「連線斷掉時才刪」，不是立刻刪。測試裡不模擬斷線，
       所以這裡不做事（想模擬就呼叫 __disconnect()）。 */
    const pending = { target, action: null };
    disconnectQueue.push(pending);
    return {
        remove: async () => {
            pending.action = "remove";
        },
        cancel: async () => {
            pending.action = null;
        },
    };
}

const disconnectQueue = [];

export async function __disconnect() {
    for (const entry of disconnectQueue) {
        if (entry.action === "remove") await remove(entry.target);
    }
}

export function query(target) {
    return target;
}

export const orderByChild = () => {};
export const limitToLast = () => {};
export const serverTimestamp = () => Date.now();

/** 給測試用的觀察窗 */
export function __dump(path) {
    return JSON.parse(JSON.stringify(walk(path) ?? null));
}

globalThis.__fbStub = { __dump, __disconnect };

globalThis.__fbStub = { __dump, __disconnect };
