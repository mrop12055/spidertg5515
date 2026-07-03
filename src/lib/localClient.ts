/* eslint-disable @typescript-eslint/no-explicit-any */
// Local client — a thin shim that mimics the subset of the Supabase JS client
// that this app uses. It compiles chainable calls like
//   supabase.from('accounts').select('*').eq('status','active').order('created_at')
// into a single `{ op, table, filters, order, ... }` payload and forwards it
// to Electron via window.localApi.query(). In the Lovable browser preview,
// where window.localApi is undefined, it degrades to an empty-result mock so
// pages still render without crashing.

type Filter = { col: string; op: string; val: any };
type OrderSpec = { col: string; ascending: boolean; nullsFirst?: boolean };

type LocalApi = {
  isDesktop: boolean;
  query: (payload: any) => Promise<{ data: any; error: any; count?: number }>;
  onChange?: (cb: (change: { table: string; eventType: string; new: any; old: any }) => void) => () => void;
  runner: {
    start: () => Promise<{ status: string }>;
    stop: () => Promise<{ status: string }>;
    restart: () => Promise<{ status: string }>;
    status: () => Promise<{ status: string }>;
    onLog: (cb: (line: string) => void) => () => void;
    onStatus: (cb: (s: string) => void) => () => void;
  };
};

declare global {
  interface Window {
    localApi?: LocalApi;
  }
}

// Fallback stub for browser preview.
const stubApi: LocalApi = {
  isDesktop: false,
  query: async (payload) => {
    if (payload.op === 'select') return { data: [], error: null, count: 0 };
    if (payload.op === 'insert' || payload.op === 'upsert') {
      const list = Array.isArray(payload.values) ? payload.values : [payload.values];
      return { data: payload.single ? list[0] : list, error: null };
    }
    return { data: null, error: null };
  },
  runner: {
    start: async () => ({ status: 'stopped' }),
    stop: async () => ({ status: 'stopped' }),
    restart: async () => ({ status: 'stopped' }),
    status: async () => ({ status: 'stopped' }),
    onLog: () => () => {},
    onStatus: () => () => {},
  },
};

export function getLocalApi(): LocalApi {
  return (typeof window !== 'undefined' && window.localApi) || stubApi;
}

// A chainable "select" builder mirroring PostgrestFilterBuilder.
class QueryBuilder<T = any> implements PromiseLike<{ data: T | T[] | null; error: any; count?: number }> {
  private _op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
  private _select: string = '*';
  private _filters: Filter[] = [];
  private _order: OrderSpec[] = [];
  private _limit?: number;
  private _offset?: number;
  private _range?: { from: number; to: number };
  private _single = false;
  private _maybeSingle = false;
  private _count?: 'exact';
  private _values: any = undefined;
  private _returning: 'representation' | 'minimal' = 'representation';
  private _onConflict?: string;

  constructor(private table: string) {}

  select(cols = '*', opts?: { count?: 'exact'; head?: boolean }) {
    this._op = this._op === 'select' ? 'select' : this._op;
    this._select = cols;
    if (opts?.count) this._count = opts.count;
    return this;
  }
  insert(values: any, opts?: { returning?: 'minimal' | 'representation' }) {
    this._op = 'insert';
    this._values = values;
    if (opts?.returning) this._returning = opts.returning;
    return this;
  }
  update(values: any) { this._op = 'update'; this._values = values; return this; }
  delete() { this._op = 'delete'; return this; }
  upsert(values: any, opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    this._op = 'upsert';
    this._values = values;
    if (opts?.onConflict) this._onConflict = opts.onConflict;
    return this;
  }

  eq(col: string, val: any) { this._filters.push({ col, op: 'eq', val }); return this; }
  neq(col: string, val: any) { this._filters.push({ col, op: 'neq', val }); return this; }
  gt(col: string, val: any) { this._filters.push({ col, op: 'gt', val }); return this; }
  gte(col: string, val: any) { this._filters.push({ col, op: 'gte', val }); return this; }
  lt(col: string, val: any) { this._filters.push({ col, op: 'lt', val }); return this; }
  lte(col: string, val: any) { this._filters.push({ col, op: 'lte', val }); return this; }
  like(col: string, val: string) { this._filters.push({ col, op: 'like', val }); return this; }
  ilike(col: string, val: string) { this._filters.push({ col, op: 'ilike', val }); return this; }
  in(col: string, vals: any[]) { this._filters.push({ col, op: 'in', val: vals }); return this; }
  is(col: string, val: any) { this._filters.push({ col, op: 'is', val }); return this; }
  not(col: string, op: string, val: any) { this._filters.push({ col, op: `not.${op}`, val }); return this; }
  or(_expr: string) { this._filters.push({ col: '', op: 'or', val: _expr }); return this; }
  contains(col: string, val: any) { this._filters.push({ col, op: 'eq', val }); return this; }
  match(obj: Record<string, any>) {
    for (const [col, val] of Object.entries(obj)) this._filters.push({ col, op: 'eq', val });
    return this;
  }
  filter(col: string, op: string, val: any) { this._filters.push({ col, op, val }); return this; }

  order(col: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}) {
    this._order.push({ col, ascending: opts.ascending !== false, nullsFirst: opts.nullsFirst });
    return this;
  }
  limit(n: number) { this._limit = n; return this; }
  range(from: number, to: number) { this._range = { from, to }; return this; }
  single() { this._single = true; return this; }
  maybeSingle() { this._maybeSingle = true; return this; }

  private toPayload() {
    return {
      op: this._op,
      table: this.table,
      select: this._select,
      filters: this._filters,
      order: this._order,
      limit: this._limit,
      offset: this._offset,
      range: this._range,
      single: this._single,
      maybeSingle: this._maybeSingle,
      count: this._count,
      values: this._values,
      returning: this._returning,
      onConflict: this._onConflict,
    };
  }

  then<TResult1 = { data: T | T[] | null; error: any; count?: number }, TResult2 = never>(
    onfulfilled?: ((value: { data: T | T[] | null; error: any; count?: number }) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): Promise<TResult1 | TResult2> {
    return getLocalApi().query(this.toPayload()).then(onfulfilled as any, onrejected as any);
  }
}

function from(table: string) { return new QueryBuilder(table); }

// storage.from(bucket).upload(path, blob/file)
const storageFrom = (bucket: string) => ({
  upload: async (path: string, file: Blob | Uint8Array | ArrayBuffer, _opts?: any) => {
    let data: Uint8Array;
    if (file instanceof Blob) data = new Uint8Array(await file.arrayBuffer());
    else if (file instanceof ArrayBuffer) data = new Uint8Array(file);
    else data = file;
    return getLocalApi().query({ op: 'storage.upload', bucket, path, data });
  },
  getPublicUrl: (path: string) => ({ data: { publicUrl: `file://${path}` } }),
  remove: async (_paths: string[]) => ({ data: null, error: null }),
  createSignedUrl: async (path: string) => ({ data: { signedUrl: `file://${path}` }, error: null }),
});

// functions.invoke('name', { body })
const functions = {
  invoke: async (name: string, opts?: { body?: any }) => {
    return getLocalApi().query({ op: 'function', name, body: opts?.body });
  },
};

// Minimal channel stub — real-time not supported in Phase 1. Returns a chainable
// object with .on().subscribe() so existing call sites keep type-checking.
const makeChannel = (_name?: string) => {
  const chan: any = {
    on: (_event?: any, _filter?: any, _cb?: any) => chan,
    subscribe: (_cb?: any) => ({ unsubscribe: () => {} }),
    unsubscribe: () => {},
  };
  return chan;
};
const channel = (name?: string) => makeChannel(name);
const removeChannel = (_chan?: any) => {};


const auth = {
  getSession: async () => ({ data: { session: null }, error: null }),
  getUser: async () => ({ data: { user: null }, error: null }),
  onAuthStateChange: (_cb: any) => ({ data: { subscription: { unsubscribe: () => {} } } }),
  signOut: async () => ({ error: null }),
  signInWithPassword: async () => ({ data: { user: null, session: null }, error: null }),
  signUp: async () => ({ data: { user: null, session: null }, error: null }),
};

export const localClient = {
  from,
  storage: { from: storageFrom },
  functions,
  channel,
  removeChannel,
  auth,
};

export type LocalClient = typeof localClient;
