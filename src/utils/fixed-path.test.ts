import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateFixedPath, buildFixedPathUrl, pickFixedPathDomain, buildFixedPathLinkId, resolveEffectiveFixedPath } from './fixed-path';

const DOMAINS = [
    'in.dopeaaps.com',
    'supertrabalho.com',
    'empregacascavel.com',
    'noticiasexclusivas.net',
    'creditosaibamais.com',
    'dopeaaps.com',
    'appmobile4u.com',
];

// ---- validateFixedPath ----

test('validateFixedPath: aceita paths validos e devolve o valor exato', () => {
    for (const p of ['/first-hello/', '/first-hello', '/a/b/c/', '/last-chance-tonig/', '/A_b.c~d/', '/.well-known', '/a.b']) {
        const r = validateFixedPath(p);
        assert.deepEqual(r, { ok: true, value: p }, `deveria aceitar ${JSON.stringify(p)}`);
    }
});

test('validateFixedPath: rejeita entradas invalidas / maliciosas', () => {
    const invalid: string[] = [
        '',
        '/',
        'first-hello/',
        '//evil.com',
        '//evil.com/x',
        '/a//b',
        'https://evil.com/',
        'javascript:alert(1)',
        '/a b/',
        '/a\tb',
        '/a\r\nLocation: x',
        '/a\nb',
        '/a?x=1',
        '/a#x',
        '/%2f%2fevil.com',
        '/a%0d%0ab',
        '/a\\b',
        '\\\\evil.com',
        '/@evil.com',
        '/a@b',
        '/..',
        '/../x',
        '/a/./b',
        '/a/..',
        '/.',
        '/a:b',
        ' /a',
        '/a ',
    ];
    for (const p of invalid) {
        const r = validateFixedPath(p);
        assert.equal(r.ok, false, `deveria rejeitar ${JSON.stringify(p)}`);
    }
});

test('validateFixedPath: limite de 200 caracteres', () => {
    const ok200 = '/' + 'a'.repeat(199);
    const bad201 = '/' + 'a'.repeat(200);
    assert.equal(ok200.length, 200);
    assert.equal(bad201.length, 201);
    assert.equal(validateFixedPath(ok200).ok, true);
    assert.equal(validateFixedPath(bad201).ok, false);
});

test('validateFixedPath: rejeita nao-string', () => {
    for (const v of [123, null, undefined, {}, [], true, ['/a']]) {
        const r = validateFixedPath(v);
        assert.equal(r.ok, false, `deveria rejeitar ${JSON.stringify(v)}`);
    }
});

test('validateFixedPath: sem ReDoS em entrada longa adversarial', () => {
    const start = Date.now();
    validateFixedPath('/' + 'a'.repeat(198) + '!');
    validateFixedPath('/' + 'a/'.repeat(99) + '!');
    assert.ok(Date.now() - start < 200);
});

test('validateFixedPath: mensagem de erro presente quando invalido', () => {
    const r = validateFixedPath('//evil.com');
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.error.length > 0);
});

// ---- buildFixedPathUrl ----

test('buildFixedPathUrl: monta https://dominio/path', () => {
    assert.equal(buildFixedPathUrl('supertrabalho.com', '/first-hello/'), 'https://supertrabalho.com/first-hello/');
});

test('buildFixedPathUrl: sanity via new URL (host e pathname preservados)', () => {
    for (const d of DOMAINS) {
        const u = new URL(buildFixedPathUrl(d, '/first-hello/'));
        assert.equal(u.protocol, 'https:');
        assert.equal(u.host, d);
        assert.equal(u.pathname, '/first-hello/');
        assert.equal(u.search, '');
    }
});

// ---- pickFixedPathDomain ----

test('pickFixedPathDomain: domains vazio -> null', () => {
    assert.equal(pickFixedPathDomain([], new Set()), null);
    assert.equal(pickFixedPathDomain([], new Set(['x.com'])), null);
});

test('pickFixedPathDomain: nenhum visitado cobre primeiro e ultimo com rand deterministico', () => {
    assert.deepEqual(pickFixedPathDomain(DOMAINS, new Set(), () => 0), { domain: DOMAINS[0], exhausted: false });
    assert.deepEqual(pickFixedPathDomain(DOMAINS, new Set(), () => 0.999), { domain: DOMAINS[6], exhausted: false });
});

test('pickFixedPathDomain: rand=1 (borda) nao estoura o indice', () => {
    assert.deepEqual(pickFixedPathDomain(DOMAINS, new Set(), () => 1), { domain: DOMAINS[6], exhausted: false });
});

test('pickFixedPathDomain: 6 de 7 visitados retorna exatamente o restante', () => {
    for (let missing = 0; missing < DOMAINS.length; missing++) {
        const visited = new Set(DOMAINS.filter((_, i) => i !== missing));
        for (const r of [0, 0.5, 0.999]) {
            assert.deepEqual(pickFixedPathDomain(DOMAINS, visited, () => r), {
                domain: DOMAINS[missing],
                exhausted: false,
            });
        }
    }
});

test('pickFixedPathDomain: todos visitados -> exhausted, dominio pertence ao grupo', () => {
    const visited = new Set(DOMAINS);
    for (const r of [0, 0.3, 0.999]) {
        const pick = pickFixedPathDomain(DOMAINS, visited, () => r);
        assert.ok(pick);
        assert.equal(pick.exhausted, true);
        assert.ok(DOMAINS.includes(pick.domain));
    }
    assert.equal(pickFixedPathDomain(DOMAINS, visited, () => 0)?.domain, DOMAINS[0]);
    assert.equal(pickFixedPathDomain(DOMAINS, visited, () => 0.999)?.domain, DOMAINS[6]);
});

test('pickFixedPathDomain: visited com dominio fora do grupo e ignorado', () => {
    const visited = new Set(['antigo.com', 'outro.net']);
    const pick = pickFixedPathDomain(DOMAINS, visited, () => 0);
    assert.deepEqual(pick, { domain: DOMAINS[0], exhausted: false });

    // fora do grupo + todos do grupo visitados => exhausted
    const all = new Set([...DOMAINS, 'antigo.com']);
    assert.equal(pickFixedPathDomain(DOMAINS, all, () => 0)?.exhausted, true);
});

test('pickFixedPathDomain: 7 iteracoes cobrem os 7 dominios sem repetir (qualquer rand)', () => {
    const rands: Array<() => number> = [() => 0, () => 0.999, () => 0.5, Math.random];
    for (const rand of rands) {
        const visited = new Set<string>();
        const seen: string[] = [];
        for (let i = 0; i < DOMAINS.length; i++) {
            const pick = pickFixedPathDomain(DOMAINS, visited, rand);
            assert.ok(pick);
            assert.equal(pick.exhausted, false);
            visited.add(pick.domain);
            seen.push(pick.domain);
        }
        assert.equal(new Set(seen).size, DOMAINS.length);
        assert.deepEqual([...seen].sort(), [...DOMAINS].sort());
        // 8a iteracao: exhausted
        assert.equal(pickFixedPathDomain(DOMAINS, visited, rand)?.exhausted, true);
    }
});

test('pickFixedPathDomain: distribuicao aproximadamente uniforme no primeiro clique', () => {
    const counts = new Map<string, number>();
    const N = 7000;
    for (let i = 0; i < N; i++) {
        const pick = pickFixedPathDomain(DOMAINS, new Set());
        assert.ok(pick);
        counts.set(pick.domain, (counts.get(pick.domain) ?? 0) + 1);
    }
    assert.equal(counts.size, DOMAINS.length);
    for (const c of counts.values()) {
        assert.ok(c > 700 && c < 1300, `contagem fora do esperado: ${c}`);
    }
});

// =====================================================================
// Casos de borda adicionais (validacao independente - Argus)
// =====================================================================

// ---- validateFixedPath: bordas ----

test('validateFixedPath: tamanho minimo exato (2) aceita, 1 e 0 rejeitam', () => {
    assert.deepEqual(validateFixedPath('/a'), { ok: true, value: '/a' });
    assert.equal(validateFixedPath('/').ok, false); // length 1
    assert.equal(validateFixedPath('').ok, false); // length 0
    assert.equal(validateFixedPath('//').ok, false); // length 2 mas sem segmento
    assert.equal(validateFixedPath('a/').ok, false); // length 2 sem barra inicial
});

test('validateFixedPath: tamanho 200 multi-segmento aceita, 201 rejeita (barra final conta)', () => {
    // 200 chars: '/' + 'a'*197 + '/' + ... montado para fechar exatamente 200
    const seg = 'a'.repeat(98);
    const p200 = `/${seg}/${seg}/`; // 1 + 98 + 1 + 98 + 1 = 199
    assert.equal(p200.length, 199);
    const p200b = `/${seg}/${seg}x/`; // 200
    assert.equal(p200b.length, 200);
    assert.equal(validateFixedPath(p200b).ok, true);
    const p201 = `/${seg}/${seg}xx/`; // 201
    assert.equal(p201.length, 201);
    assert.equal(validateFixedPath(p201).ok, false);
});

test('validateFixedPath: mensagem de tamanho distinta para fora do intervalo', () => {
    const r = validateFixedPath('/' + 'a'.repeat(200));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error, /length/i);
});

test('validateFixedPath: barras duplas em qualquer posicao sao rejeitadas', () => {
    for (const p of ['/a//', '//a', '/a//b/', '/a///b', '///']) {
        assert.equal(validateFixedPath(p).ok, false, `deveria rejeitar ${JSON.stringify(p)}`);
    }
});

test('validateFixedPath: segmentos "." e ".." em qualquer posicao sao rejeitados', () => {
    for (const p of ['/a/.', '/a/./', '/./a', '/a/../b', '/a/..', '/../', '/./', '/a/b/../c/']) {
        assert.equal(validateFixedPath(p).ok, false, `deveria rejeitar ${JSON.stringify(p)}`);
    }
});

test('validateFixedPath: segmentos que apenas CONTEM pontos sao validos (nao sao dot-segments)', () => {
    for (const p of ['/.hidden', '/a/.hidden', '/...', '/a./', '/..a', '/a..b', '/-', '/_', '/~', '/a/-/b']) {
        assert.deepEqual(validateFixedPath(p), { ok: true, value: p }, `deveria aceitar ${JSON.stringify(p)}`);
    }
});

test('validateFixedPath: dot-segments codificados (%2e) rejeitados (sem % permitido)', () => {
    for (const p of ['/%2e%2e/x', '/%2E', '/.%2e', '/a/%2e/b', '/%252e%252e']) {
        assert.equal(validateFixedPath(p).ok, false, `deveria rejeitar ${JSON.stringify(p)}`);
    }
});

test('validateFixedPath: unicode (acentos, homoglifos, fullwidth, emoji) rejeitado', () => {
    const invalid = [
        '/café', // e com acento
        '/á', // combining acute
        '/аbc', // 'a' cirilico (homoglifo)
        '/ο', // omicron grego
        '/／／evil.com', // fullwidth solidus
        '/a／b',
        '/∕x', // division slash
        '/․', // one dot leader
        '/．．/x', // fullwidth full stop
        '/\u{1F600}',
        '/a​b', // zero width space
        '/a b', // nbsp
        '/İ', // I com ponto (case folding)
        '/K', // Kelvin sign (casa com /k/i, nao deve casar na classe)
        '/a b', // line separator
        '/a b',
        '/‮abc', // RTL override
    ];
    for (const p of invalid) {
        assert.equal(validateFixedPath(p).ok, false, `deveria rejeitar ${JSON.stringify(p)}`);
    }
});

test('validateFixedPath: caracteres de controle e NUL rejeitados', () => {
    for (const p of ['/a\u0000b', '/a\u0000', '/\u0001', '/a\u007f', '/a\u000b', '/a\u000c', '/a\u0085']) {
        assert.equal(validateFixedPath(p).ok, false, `deveria rejeitar ${JSON.stringify(p)}`);
    }
});

test('validateFixedPath: quebra de linha FINAL rejeitada ($ nao casa antes de \\n em JS)', () => {
    for (const p of ['/a\n', '/a/\n', '/a\r', '/a\r\n', '/a\n/b', '/a/\n\n']) {
        assert.equal(validateFixedPath(p).ok, false, `deveria rejeitar ${JSON.stringify(p)}`);
    }
});

test('validateFixedPath: caracteres de URL com semantica especial rejeitados', () => {
    for (const p of ['/a;b', '/a,b', '/a=b', '/a&b', '/a+b', '/a!b', "/a'b", '/a(b)', '/a*b', '/a$b', '/a[b]', '/a{b}', '/a|b', '/a^b', '/a`b', '/a"b', '/a<b>', '/a%b', '/a%41']) {
        assert.equal(validateFixedPath(p).ok, false, `deveria rejeitar ${JSON.stringify(p)}`);
    }
});

test('validateFixedPath: schemes e protocol-relative em varias formas', () => {
    for (const p of ['http://evil.com', '//evil.com', '/\\evil.com', '/\\/evil.com', 'data:text/html,x', 'file:///etc/passwd', '/http://evil.com', '/https:/evil.com', 'evil.com/x']) {
        assert.equal(validateFixedPath(p).ok, false, `deveria rejeitar ${JSON.stringify(p)}`);
    }
});

test('validateFixedPath: objetos coercivel/boxed nao passam como string', () => {
    // eslint-disable-next-line no-new-wrappers
    const boxed = new String('/a');
    const coercible = { toString: () => '/a' };
    for (const v of [boxed, coercible, Symbol('x'), 1n, NaN, () => '/a', new Date(0)]) {
        assert.equal(validateFixedPath(v).ok, false);
    }
});

test('validateFixedPath: entradas patologicas curtas nao lancam excecao', () => {
    for (const p of ['/\u0000'.repeat(100), '/.'.repeat(100), '/a/'.repeat(66), '/-'.repeat(100), '/' + '.'.repeat(199)]) {
        assert.doesNotThrow(() => validateFixedPath(p));
    }
});

test('validateFixedPath: string gigante (1MB) e rejeitada rapidamente pelo guard de tamanho', () => {
    const start = process.hrtime.bigint();
    const r = validateFixedPath('/' + 'a/'.repeat(500_000));
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.equal(r.ok, false);
    assert.ok(ms < 50, `levou ${ms}ms`);
});

test('validateFixedPath: nao muta/normaliza - valor retornado e identico (referencia de valor)', () => {
    for (const p of ['/a/', '/a', '/A/B/', '/a.b_c~d-e/']) {
        const r = validateFixedPath(p);
        assert.ok(r.ok);
        if (r.ok) assert.equal(r.value, p); // sem trim, lowercase ou remocao/adicao de barra
    }
});

test('validateFixedPath: propriedade - todo path aceito faz round-trip em new URL e nao injeta host/query/hash (fuzz deterministico)', () => {
    // PRNG deterministico (mulberry32) para evitar flakiness
    let s = 0x9e3779b9;
    const rnd = () => {
        s |= 0; s = (s + 0x6d2b79f5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // alfabeto propositalmente "sujo": inclui permitidos e perigosos
    const alphabet = ['a', 'Z', '0', '9', '.', '_', '~', '-', '/', '/', '/', '?', '#', '%', '\\', '@', ':', ' ', '\n', '\r', 'é', '／', '*', '&', ';'];
    const domain = 'supertrabalho.com';
    let accepted = 0;
    for (let i = 0; i < 20000; i++) {
        const len = 1 + Math.floor(rnd() * 12);
        let p = rnd() < 0.8 ? '/' : '';
        for (let j = 0; j < len; j++) p += alphabet[Math.floor(rnd() * alphabet.length)];
        const r = validateFixedPath(p);
        if (!r.ok) continue;
        accepted++;
        const url = buildFixedPathUrl(domain, r.value);
        const u = new URL(url);
        assert.equal(u.protocol, 'https:', p);
        assert.equal(u.host, domain, `host alterado por ${JSON.stringify(p)}`);
        assert.equal(u.pathname, r.value, `pathname alterado por ${JSON.stringify(p)}`);
        assert.equal(u.search, '', p);
        assert.equal(u.hash, '', p);
        assert.equal(u.username, '', p);
        assert.equal(u.password, '', p);
        assert.ok(url.startsWith(`https://${domain}/`), p);
        assert.ok(!/[\r\n\t ]/.test(url), p);
    }
    assert.ok(accepted > 100, `fuzz aceitou apenas ${accepted} - alfabeto/gerador pouco util`);
});

// ---- buildFixedPathUrl: bordas ----

test('buildFixedPathUrl: dominio com subdominio e sem porta', () => {
    const url = buildFixedPathUrl('in.dopeaaps.com', '/first-hello/');
    assert.equal(url, 'https://in.dopeaaps.com/first-hello/');
    const u = new URL(url);
    assert.equal(u.hostname, 'in.dopeaaps.com');
    assert.equal(u.port, '');
    assert.equal(u.pathname, '/first-hello/');
});

test('buildFixedPathUrl: dominio profundo (multiplos niveis) preserva host', () => {
    const u = new URL(buildFixedPathUrl('a.b.c.example.co.uk', '/x'));
    assert.equal(u.host, 'a.b.c.example.co.uk');
    assert.equal(u.pathname, '/x');
});

test('buildFixedPathUrl: path sem barra final e com barra final sao preservados literalmente', () => {
    assert.equal(buildFixedPathUrl('a.com', '/x'), 'https://a.com/x');
    assert.equal(buildFixedPathUrl('a.com', '/x/'), 'https://a.com/x/');
    assert.equal(new URL(buildFixedPathUrl('a.com', '/x')).pathname, '/x');
    assert.equal(new URL(buildFixedPathUrl('a.com', '/x/')).pathname, '/x/');
});

test('buildFixedPathUrl: path com pontos/til/underscore e profundidade nao e alterado pelo parser de URL', () => {
    for (const p of ['/.well-known', '/a.b', '/A_b.c~d/', '/a/b/c/d/e/', '/...', '/.hidden/x', '/-']) {
        const u = new URL(buildFixedPathUrl('supertrabalho.com', p));
        assert.equal(u.pathname, p);
        assert.equal(u.host, 'supertrabalho.com');
    }
});

test('buildFixedPathUrl: nao adiciona query nem hash (UTMs sao responsabilidade do controller)', () => {
    const u = new URL(buildFixedPathUrl('a.com', '/x/'));
    assert.equal(u.search, '');
    assert.equal(u.hash, '');
});

test('buildFixedPathUrl: documenta contrato - nao sanitiza dominio (host vem de groupDomains)', () => {
    // O builder e uma concatenacao pura. A seguranca depende de fixedPath ter passado
    // por validateFixedPath e de `domain` vir do cadastro do grupo.
    assert.equal(buildFixedPathUrl('a.com', '/x'), 'https://a.com/x');
});

// ---- pickFixedPathDomain: bordas ----

test('pickFixedPathDomain: rand retornando exatamente 1 (clamp) com subconjunto nao visitado', () => {
    const visited = new Set(DOMAINS.slice(0, 4)); // restam 3
    assert.deepEqual(pickFixedPathDomain(DOMAINS, visited, () => 1), { domain: DOMAINS[6], exhausted: false });
    // rand > 1 (defensivo) tambem nao estoura
    assert.deepEqual(pickFixedPathDomain(DOMAINS, visited, () => 1.5), { domain: DOMAINS[6], exhausted: false });
    // exhausted + rand=1
    assert.deepEqual(pickFixedPathDomain(DOMAINS, new Set(DOMAINS), () => 1), { domain: DOMAINS[6], exhausted: true });
});

test('pickFixedPathDomain: rand na fronteira entre indices (i/n) escolhe o indice i', () => {
    const d = ['a.com', 'b.com', 'c.com', 'd.com'];
    assert.equal(pickFixedPathDomain(d, new Set(), () => 0.25)?.domain, 'b.com');
    assert.equal(pickFixedPathDomain(d, new Set(), () => 0.2499999)?.domain, 'a.com');
    assert.equal(pickFixedPathDomain(d, new Set(), () => 0.5)?.domain, 'c.com');
    assert.equal(pickFixedPathDomain(d, new Set(), () => 0.75)?.domain, 'd.com');
});

test('pickFixedPathDomain: um unico dominio - nao visitado e visitado', () => {
    assert.deepEqual(pickFixedPathDomain(['a.com'], new Set(), () => 0.7), { domain: 'a.com', exhausted: false });
    assert.deepEqual(pickFixedPathDomain(['a.com'], new Set(['a.com']), () => 0.7), { domain: 'a.com', exhausted: true });
    assert.deepEqual(pickFixedPathDomain(['a.com'], new Set(), () => 1), { domain: 'a.com', exhausted: false });
});

test('pickFixedPathDomain: domains com duplicatas - visitado remove todas as ocorrencias', () => {
    const d = ['a.com', 'a.com', 'b.com'];
    for (const r of [0, 0.5, 0.999, 1]) {
        assert.deepEqual(pickFixedPathDomain(d, new Set(['a.com']), () => r), { domain: 'b.com', exhausted: false });
    }
    // todos visitados -> exhausted
    assert.equal(pickFixedPathDomain(d, new Set(['a.com', 'b.com']), () => 0)?.exhausted, true);
    // sem visitados: resultado sempre pertence ao grupo
    for (const r of [0, 0.34, 0.67, 0.999]) {
        const pick = pickFixedPathDomain(d, new Set(), () => r);
        assert.ok(pick && d.includes(pick.domain) && pick.exhausted === false);
    }
});

test('pickFixedPathDomain: visited maior que domains (muitos dominios antigos) nao afeta o resultado', () => {
    const visited = new Set<string>(Array.from({ length: 500 }, (_, i) => `old${i}.com`));
    assert.deepEqual(pickFixedPathDomain(DOMAINS, visited, () => 0), { domain: DOMAINS[0], exhausted: false });
    // visited superconjunto de domains -> exhausted
    const superset = new Set<string>([...visited, ...DOMAINS]);
    assert.equal(superset.size > DOMAINS.length, true);
    assert.equal(pickFixedPathDomain(DOMAINS, superset, () => 0)?.exhausted, true);
});

test('pickFixedPathDomain: comparacao de visited e case-sensitive e exata (contrato)', () => {
    // Documenta: 'A.com' != 'a.com'. O chamador deve fornecer dominios ja normalizados (lowercase).
    const pick = pickFixedPathDomain(['a.com', 'b.com'], new Set(['A.com']), () => 0);
    assert.deepEqual(pick, { domain: 'a.com', exhausted: false });
});

test('pickFixedPathDomain: nao muta domains nem visited', () => {
    const domains = [...DOMAINS];
    const visited = new Set([DOMAINS[1], DOMAINS[3]]);
    const visitedSnapshot = [...visited];
    pickFixedPathDomain(domains, visited, () => 0.5);
    pickFixedPathDomain(domains, new Set(domains), () => 0.5);
    assert.deepEqual(domains, DOMAINS);
    assert.deepEqual([...visited], visitedSnapshot);
});

test('pickFixedPathDomain: nunca retorna dominio visitado enquanto houver nao visitado (todas as combinacoes de rand)', () => {
    const n = DOMAINS.length;
    for (let mask = 0; mask < (1 << n) - 1; mask++) {
        const visited = new Set(DOMAINS.filter((_, i) => mask & (1 << i)));
        for (const r of [0, 0.1, 0.33, 0.5, 0.77, 0.9999, 1]) {
            const pick = pickFixedPathDomain(DOMAINS, visited, () => r);
            assert.ok(pick);
            assert.equal(pick.exhausted, false);
            assert.equal(visited.has(pick.domain), false, `mask=${mask} r=${r} retornou visitado ${pick.domain}`);
        }
    }
});

test('pickFixedPathDomain: rand padrao (Math.random) retorna sempre dominio valido em 2000 chamadas', () => {
    for (let i = 0; i < 2000; i++) {
        const visited = new Set(DOMAINS.filter(() => Math.random() < 0.5));
        const pick = pickFixedPathDomain(DOMAINS, visited);
        assert.ok(pick);
        assert.ok(DOMAINS.includes(pick.domain));
        assert.equal(pick.exhausted, visited.size === DOMAINS.length);
    }
});

test('pickFixedPathDomain: com visitas por IP isoladas (Sets distintos) nao ha estado compartilhado', () => {
    const visitedA = new Set<string>();
    const visitedB = new Set<string>();
    const a = pickFixedPathDomain(DOMAINS, visitedA, () => 0);
    assert.ok(a);
    visitedA.add(a.domain);
    const b = pickFixedPathDomain(DOMAINS, visitedB, () => 0);
    assert.equal(b?.domain, a.domain); // B nao e afetado pelas visitas de A
    assert.equal(visitedB.size, 0);
});

test('buildFixedPathLinkId: formatos por combinacao', () => {
    assert.equal(buildFixedPathLinkId('g1', 'a.com', false, true), 'bestrps_g1_a.com_fixed');
    assert.equal(buildFixedPathLinkId('g1', 'a.com', true, true), 'bestrps_exhausted_g1_a.com');
    assert.equal(buildFixedPathLinkId('g1', 'a.com', false, false), 'fixed_g1_a.com');
    assert.equal(buildFixedPathLinkId('g1', 'a.com', true, false), 'fixed_g1_a.com');
});

test('resolveEffectiveFixedPath: main, invalido e valido', () => {
    assert.deepEqual(resolveEffectiveFixedPath('g1', '/ok/'), { path: '/ok/', invalid: false });
    assert.deepEqual(resolveEffectiveFixedPath('g1', undefined), { path: null, invalid: false });
    assert.deepEqual(resolveEffectiveFixedPath('g1', null), { path: null, invalid: false });
    assert.deepEqual(resolveEffectiveFixedPath('g1', '//evil.com'), { path: null, invalid: true });
    assert.deepEqual(resolveEffectiveFixedPath('g1', 42), { path: null, invalid: true });
    assert.deepEqual(resolveEffectiveFixedPath('main', '/ok/'), { path: null, invalid: true });
});
