import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RankingResolver, PersistedRanking, RankingResolverDeps } from './ranking-fallback';
import { LinkInfo } from './interleave-by-domain';

const link = (postId: string, domain = 'a.com'): LinkInfo =>
    ({ url: `https://${domain}/?p=${postId}`, domain, postId, ecpm: 1, revenue: 1, uniqueVisitors: 0, rps: 0 });
const ids = (r: LinkInfo[] | null) => (r ? r.map(l => l.postId) : r);
const tick = () => new Promise<void>(res => setImmediate(res));
const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

interface Harness {
    resolver: RankingResolver;
    t: { now: number };
    calls: { redis: number; mongo: number; seeds: LinkInfo[][] };
    deps: RankingResolverDeps;
}

function harness(over: Partial<RankingResolverDeps> = {}, opts = {}): Harness {
    const t = { now: 1_000_000 };
    const calls = { redis: 0, mongo: 0, seeds: [] as LinkInfo[][] };
    const deps: RankingResolverDeps = {
        getRedis: async () => { calls.redis++; return null; },
        loadMongo: async () => { calls.mongo++; return null; },
        seedRedis: async (_s, r) => { calls.seeds.push(r); },
        now: () => t.now,
        ...over,
    };
    return { resolver: new RankingResolver(deps, opts), t, calls, deps };
}

// Contadores nas dependências sobrescritas
function counted(h: { calls: Harness['calls'] }, kind: 'redis' | 'mongo', fn: () => Promise<any>) {
    return async () => { h.calls[kind]++; return fn(); };
}

const persisted = (...p: string[]): PersistedRanking => ({ ranking: p.map(x => link(x)), at: new Date('2026-10-26T20:00:00Z') });

test('Redis com dado: serve do Redis, não chama Mongo nem seed', async () => {
    const calls = { redis: 0, mongo: 0, seeds: [] as LinkInfo[][] };
    const h = harness({
        getRedis: counted({ calls }, 'redis', async () => JSON.stringify([link('1'), link('2')])),
        loadMongo: counted({ calls }, 'mongo', async () => persisted('9')),
        seedRedis: async (_s, r) => { calls.seeds.push(r); },
    });
    assert.deepEqual(ids(await h.resolver.get('main')), ['1', '2']);
    assert.equal(calls.mongo, 0);
    assert.equal(calls.seeds.length, 0);
});

test('cache em memória válido evita Redis; vencido (>60s) volta ao Redis', async () => {
    const calls = { redis: 0, mongo: 0, seeds: [] as LinkInfo[][] };
    const h = harness({ getRedis: counted({ calls }, 'redis', async () => JSON.stringify([link('1')])) });
    await h.resolver.get('main');
    h.t.now += 59_000;
    await h.resolver.get('main');
    assert.equal(calls.redis, 1);
    h.t.now += 2_000;
    await h.resolver.get('main');
    assert.equal(calls.redis, 2);
});

test('Redis vazio -> Mongo -> semeia o Redis uma vez e popula o cache (2ª chamada não toca Redis/Mongo)', async () => {
    const calls = { redis: 0, mongo: 0, seeds: [] as LinkInfo[][] };
    const h = harness({
        getRedis: counted({ calls }, 'redis', async () => null),
        loadMongo: counted({ calls }, 'mongo', async () => persisted('7', '8')),
        seedRedis: async (_s, r) => { calls.seeds.push(r); },
    });
    assert.deepEqual(ids(await h.resolver.get('main')), ['7', '8']);
    assert.equal(calls.seeds.length, 1);
    assert.deepEqual(ids(calls.seeds[0]), ['7', '8']);
    assert.deepEqual(ids(await h.resolver.get('main')), ['7', '8']);
    assert.equal(calls.redis, 1);
    assert.equal(calls.mongo, 1);
});

test('Redis LANÇA (indisponível) -> Mongo (regra: home só sem dado em lugar nenhum)', async () => {
    const calls = { redis: 0, mongo: 0, seeds: [] as LinkInfo[][] };
    const h = harness({
        getRedis: async () => { throw new Error('Stream isn\'t writeable'); },
        loadMongo: counted({ calls }, 'mongo', async () => persisted('5')),
        seedRedis: async () => { throw new Error('redis still down'); }, // seed falha: não pode derrubar
    });
    assert.deepEqual(ids(await h.resolver.get('main')), ['5']);
    assert.equal(calls.mongo, 1);
});

test('Redis lança e cache em memória vencido existe, Mongo vazio -> devolve o cache vencido (não null)', async () => {
    let redisUp = true;
    const h = harness({
        getRedis: async () => { if (redisUp) return JSON.stringify([link('old')]); throw new Error('down'); },
        loadMongo: async () => null,
    });
    assert.deepEqual(ids(await h.resolver.get('main')), ['old']);
    redisUp = false;
    h.t.now += 120_000;
    assert.deepEqual(ids(await h.resolver.get('main')), ['old']);
});

test('chave Redis só com random legado -> trata como vazio e usa o Mongo', async () => {
    const calls = { redis: 0, mongo: 0, seeds: [] as LinkInfo[][] };
    const h = harness({
        getRedis: async () => JSON.stringify([link('random'), link('random', 'b.com')]),
        loadMongo: counted({ calls }, 'mongo', async () => persisted('3')),
    });
    assert.deepEqual(ids(await h.resolver.get('main')), ['3']);
    assert.equal(calls.mongo, 1);
});

test('Redis com mistura random+real: servidos só os reais, sem Mongo', async () => {
    const calls = { redis: 0, mongo: 0, seeds: [] as LinkInfo[][] };
    const h = harness({
        getRedis: async () => JSON.stringify([link('random'), link('1')]),
        loadMongo: counted({ calls }, 'mongo', async () => persisted('9')),
    });
    assert.deepEqual(ids(await h.resolver.get('main')), ['1']);
    assert.equal(calls.mongo, 0);
});

test('dropRandomPlaceholders aplicado ao ranking vindo do Mongo (e ao seed)', async () => {
    const calls = { redis: 0, mongo: 0, seeds: [] as LinkInfo[][] };
    const h = harness({
        loadMongo: async () => ({ ranking: [link('random'), link('4')], at: null }),
        seedRedis: async (_s, r) => { calls.seeds.push(r); },
    });
    assert.deepEqual(ids(await h.resolver.get('main')), ['4']);
    assert.deepEqual(ids(calls.seeds[0]), ['4']);
});

test('Mongo só com random legado conta como vazio -> null + cache negativo', async () => {
    const calls = { redis: 0, mongo: 0, seeds: [] as LinkInfo[][] };
    const h = harness({ loadMongo: counted({ calls }, 'mongo', async () => ({ ranking: [link('random')], at: null })) });
    assert.equal(await h.resolver.get('main'), null);
    assert.equal(calls.seeds.length, 0);
});

test('Mongo vazio -> null + cache negativo (2ª chamada não consulta Mongo); expira após 60s', async () => {
    const calls = { redis: 0, mongo: 0, seeds: [] as LinkInfo[][] };
    const h = harness({ loadMongo: counted({ calls }, 'mongo', async () => null) });
    assert.equal(await h.resolver.get('sem'), null);
    assert.equal(await h.resolver.get('sem'), null);
    assert.equal(calls.mongo, 1);
    assert.equal(calls.seeds.length, 0);
    h.t.now += 61_000;
    assert.equal(await h.resolver.get('sem'), null);
    assert.equal(calls.mongo, 2);
});

test('cache negativo é por slug', async () => {
    const calls = { redis: 0, mongo: 0, seeds: [] as LinkInfo[][] };
    const h = harness({ loadMongo: counted({ calls }, 'mongo', async () => null) });
    await h.resolver.get('a');
    await h.resolver.get('b');
    assert.equal(calls.mongo, 2);
});

test('Mongo ERRO -> null + backoff de 10s (não reconsulta a cada request) e depois tenta de novo', async () => {
    const calls = { redis: 0, mongo: 0, seeds: [] as LinkInfo[][] };
    const h = harness({ loadMongo: counted({ calls }, 'mongo', async () => { throw new Error('mongo down'); }) });
    assert.equal(await h.resolver.get('main'), null);
    h.t.now += 9_000;
    assert.equal(await h.resolver.get('main'), null);
    assert.equal(calls.mongo, 1);
    h.t.now += 2_000; // 11s desde o erro
    assert.equal(await h.resolver.get('main'), null);
    assert.equal(calls.mongo, 2);
});

test('Mongo recupera após o backoff: passa a servir e a semear', async () => {
    let fail = true;
    const calls = { redis: 0, mongo: 0, seeds: [] as LinkInfo[][] };
    const h = harness({
        loadMongo: async () => { if (fail) throw new Error('x'); return persisted('6'); },
        seedRedis: async (_s, r) => { calls.seeds.push(r); },
    });
    assert.equal(await h.resolver.get('main'), null);
    fail = false;
    h.t.now += 11_000;
    assert.deepEqual(ids(await h.resolver.get('main')), ['6']);
    assert.equal(calls.seeds.length, 1);
});

test('chamadas concorrentes compartilham 1 única leitura do Mongo (single-flight)', async () => {
    const calls = { redis: 0, mongo: 0, seeds: [] as LinkInfo[][] };
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    const h = harness({
        loadMongo: async () => { calls.mongo++; await gate; return persisted('1', '2'); },
        seedRedis: async (_s, r) => { calls.seeds.push(r); },
    });
    const all = Promise.all(Array.from({ length: 25 }, () => h.resolver.get('main')));
    await tick();
    release();
    const results = await all;
    assert.equal(calls.mongo, 1);
    assert.equal(calls.seeds.length, 1);
    for (const r of results) assert.deepEqual(ids(r), ['1', '2']);
});

test('timeout: Mongo lento -> a request recebe o fallback (null) sem esperar; a leitura NÃO é cancelada e popula o cache', async () => {
    const calls = { redis: 0, mongo: 0, seeds: [] as LinkInfo[][] };
    const h = harness({
        loadMongo: async () => { calls.mongo++; await sleep(80); return persisted('late'); },
        seedRedis: async (_s, r) => { calls.seeds.push(r); },
    }, { timeoutMs: 15 });
    const t0 = Date.now();
    assert.equal(await h.resolver.get('main'), null);
    assert.ok(Date.now() - t0 < 70, 'request não pode esperar o Mongo lento');
    assert.equal(calls.mongo, 1);
    await sleep(120); // leitura em voo termina
    assert.equal(calls.seeds.length, 1);
    // próxima request: cache em memória populado pela leitura que terminou
    assert.deepEqual(ids(await h.resolver.get('main')), ['late']);
    assert.equal(calls.mongo, 1);
});

test('timeout com cache em memória vencido: devolve o cache vencido como fallback', async () => {
    let phase: 'redis' | 'down' = 'redis';
    const h = harness({
        getRedis: async () => { if (phase === 'redis') return JSON.stringify([link('stale')]); return null; },
        loadMongo: async () => { await sleep(80); return persisted('new'); },
    }, { timeoutMs: 15 });
    assert.deepEqual(ids(await h.resolver.get('main')), ['stale']);
    phase = 'down';
    h.t.now += 120_000;
    assert.deepEqual(ids(await h.resolver.get('main')), ['stale']);
    await sleep(120);
});

test('Redis volta a ter a chave: o log "Redis vazio" é re-armado (episódio novo)', async () => {
    let redis: string | null = null;
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    try {
        const h = harness({ getRedis: async () => redis, loadMongo: async () => persisted('1') });
        await h.resolver.get('main');
        h.t.now += 61_000;
        await h.resolver.get('main'); // memória vencida, Redis ainda vazio: mesmo episódio, sem 2º log
        redis = JSON.stringify([link('2')]);
        h.t.now += 61_000;
        await h.resolver.get('main'); // Redis voltou -> re-arma
        redis = null;
        h.t.now += 61_000;
        await h.resolver.get('main'); // novo episódio -> loga de novo
    } finally {
        console.log = orig;
    }
    assert.equal(logs.filter(l => l.includes('[RANKING-MAIN] Redis vazio')).length, 2);
});
