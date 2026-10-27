import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { interleaveByDomain, dropRandomPlaceholders, LinkInfo } from './interleave-by-domain';
import { pickExhaustedLink } from './exhausted-link';

// PRNG determinístico (mulberry32) — fuzz reprodutível, sem flakiness.
function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function mk(domain: string, postId: string): LinkInfo {
    return { url: `https://${domain}/${postId}`, domain, postId, ecpm: 1, revenue: 1, uniqueVisitors: 1, rps: 1 };
}

/** Ranking embaralhado: até 7 domínios x 0..12 links; ordem global aleatória. */
function genRanking(rand: () => number): { ranking: LinkInfo[]; perDomain: Map<string, string[]> } {
    const nDomains = 1 + Math.floor(rand() * 7);
    const all: LinkInfo[] = [];
    for (let d = 0; d < nDomains; d++) {
        const n = Math.floor(rand() * 13);
        for (let i = 0; i < n; i++) all.push(mk(`d${d}.com`, `p${d}_${i}`));
    }
    // embaralhamento Fisher-Yates, depois a ordem relativa por domínio é a da lista resultante
    for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [all[i], all[j]] = [all[j], all[i]];
    }
    const perDomain = new Map<string, string[]>();
    for (const l of all) {
        if (!perDomain.has(l.domain)) perDomain.set(l.domain, []);
        perDomain.get(l.domain)!.push(l.postId);
    }
    return { ranking: all, perDomain };
}

test('interleave (fuzz): nunca emite random, preserva tamanho e ordem relativa por domínio, 1ª rodada = melhor de cada domínio', () => {
    const rand = rng(20261026);
    for (let iter = 0; iter < 500; iter++) {
        const { ranking, perDomain } = genRanking(rand);
        // groupDomains com extras sem dados (+ algumas vezes vazio)
        const extras = ['extra1.com', 'extra2.com'];
        const groupDomains = iter % 5 === 0 ? [] : [...perDomain.keys(), ...extras];
        const out = interleaveByDomain(ranking, groupDomains);

        assert.equal(out.length, ranking.length, `iter ${iter}: tamanho`);
        assert.ok(out.every(l => l.postId !== 'random' && !l.url.includes('/random')), `iter ${iter}: random`);
        assert.ok(out.every(l => !extras.includes(l.domain)), `iter ${iter}: domínio sem dados gerou slot`);

        for (const [domain, ids] of perDomain) {
            const got = out.filter(l => l.domain === domain).map(l => l.postId);
            assert.deepEqual(got, ids, `iter ${iter}: ordem de ${domain}`);
        }

        // 1ª rodada: melhor de cada domínio, na ordem de primeira aparição
        const firstOrder = [...perDomain.keys()];
        const firstRound = out.slice(0, firstOrder.length).map(l => l.postId);
        assert.deepEqual(firstRound, firstOrder.map(d => perDomain.get(d)![0]), `iter ${iter}: 1ª rodada`);

        // Round-robin: nenhum domínio consecutivo repetido enquanto houver >1 domínio com itens restantes
        // (checado via contagem: item k do domínio d aparece na rodada k)
        let round = 0, seenInRound = new Set<string>();
        for (const l of out) {
            if (seenInRound.has(l.domain)) { round++; seenInRound = new Set(); }
            seenInRound.add(l.domain);
        }
        const maxLen = Math.max(0, ...[...perDomain.values()].map(v => v.length));
        assert.ok(out.length === 0 || round + 1 <= maxLen, `iter ${iter}: rodadas`);
    }
});

test('interleave: ranking vazio -> [] mesmo com groupDomains populado', () => {
    assert.deepEqual(interleaveByDomain([], ['a.com', 'b.com']), []);
    assert.deepEqual(interleaveByDomain([], []), []);
});

test('interleave: groupDomains vazio não altera o resultado (ordem vem do ranking)', () => {
    const r = [mk('a.com', '1'), mk('b.com', '2'), mk('a.com', '3')];
    assert.deepEqual(interleaveByDomain(r, []).map(l => l.postId), ['1', '2', '3']);
});

test('interleave: domínio do ranking fora de groupDomains é mantido (comportamento atual: _allDomains ignorado)', () => {
    const r = [mk('fora.com', 'x1'), mk('a.com', 'a1'), mk('fora.com', 'x2')];
    const out = interleaveByDomain(r, ['a.com']);
    assert.deepEqual(out.map(l => l.postId), ['x1', 'a1', 'x2']);
});

test('interleave: não muta o ranking de entrada', () => {
    const r = [mk('a.com', '1'), mk('b.com', '2'), mk('a.com', '3')];
    const snap = JSON.stringify(r);
    interleaveByDomain(r, ['a.com', 'b.com', 'c.com']);
    assert.equal(JSON.stringify(r), snap);
});

test('dropRandomPlaceholders: remove random legado, mantém reais; tudo random -> []', () => {
    assert.deepEqual(dropRandomPlaceholders([mk('a.com', 'random'), mk('a.com', '1'), mk('b.com', 'random')]).map(l => l.postId), ['1']);
    assert.deepEqual(dropRandomPlaceholders([mk('a.com', 'random')]), []);
    assert.deepEqual(dropRandomPlaceholders([]), []);
});

test('pickExhaustedLink: índices-chave (0, n-1, n, 2n+3, grande) e ranking de 1 item', () => {
    const r = [mk('a.com', '0'), mk('b.com', '1'), mk('c.com', '2'), mk('d.com', '3'), mk('e.com', '4')];
    const n = r.length;
    for (const v of [0, n - 1, n, 2 * n + 3, Number.MAX_SAFE_INTEGER, 1e12 + 7]) {
        const p = pickExhaustedLink(r, v)!;
        assert.equal(p.index, v % n);
        assert.equal(p.link, r[v % n]);
    }
    assert.equal(pickExhaustedLink(r, 0)!.link.postId, '0');
    assert.equal(pickExhaustedLink(r, n - 1)!.link.postId, '4');
    assert.equal(pickExhaustedLink(r, n)!.link.postId, '0');
    assert.equal(pickExhaustedLink(r, 2 * n + 3)!.link.postId, '3');
    const one = [mk('solo.com', 's')];
    for (const v of [0, 1, 99]) assert.equal(pickExhaustedLink(one, v)!.link.postId, 's');
    assert.equal(pickExhaustedLink([], 5), null);
});

test('pickExhaustedLink (fuzz): resultado sempre item do ranking; linkId termina em <dominio>_<postId>; rotação cobre todo o ranking', () => {
    const rand = rng(7);
    for (let iter = 0; iter < 300; iter++) {
        const { ranking } = genRanking(rand);
        if (ranking.length === 0) { assert.equal(pickExhaustedLink(ranking, 3), null); continue; }
        const v = Math.floor(rand() * 1e9);
        const p = pickExhaustedLink(ranking, v)!;
        assert.ok(ranking.includes(p.link));
        assert.notEqual(p.link.postId, 'random');
        // mesmo formato montado no controller
        const linkId = `bestrps_exhausted_slug_${p.link.domain}_${p.link.postId}`;
        assert.match(linkId, /^bestrps_exhausted_slug_.+_.+$/);
        assert.ok(linkId.endsWith(`${p.link.domain}_${p.link.postId}`));
        // n visitas consecutivas cobrem cada item exatamente uma vez
        const seen = new Set<LinkInfo>();
        for (let k = 0; k < ranking.length; k++) seen.add(pickExhaustedLink(ranking, v + k)!.link);
        assert.equal(seen.size, ranking.length);
    }
});

// ---- Guard de regressão: regra absoluta "nunca redirecionar para /random" ----
function listSourceFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) listSourceFiles(p, out);
        else if (/\.(ts|js)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
    }
    return out;
}

test('guard: src/ (fora de *.test.ts) não contém "/random" nem "postId: \'random\'" nem generateRandomPath', () => {
    const root = resolve(__dirname, '..'); // src/
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
        const lines = readFileSync(file, 'utf8').split('\n');
        lines.forEach((line, i) => {
            if (/\/random\b/.test(line) || /postId:\s*['"`]random['"`]/.test(line) || /generateRandomPath/.test(line)) {
                offenders.push(`${file.replace(root, 'src')}:${i + 1}: ${line.trim()}`);
            }
        });
    }
    assert.deepEqual(offenders, [], `Referências a /random em código de produção:\n${offenders.join('\n')}`);
});

test('guard: index.ts e docs/openapi.yaml não prometem /random (só negação)', () => {
    const base = resolve(__dirname, '..', '..');
    for (const f of ['index.ts', 'docs/openapi.yaml']) {
        let txt = '';
        try { txt = readFileSync(join(base, f), 'utf8'); } catch { continue; }
        // docs podem citar /random apenas para negá-lo ("Nunca redireciona para /random")
        const bad = txt.split('\n').filter(l => /\/random\b/.test(l) && !/nunca|never/i.test(l));
        assert.deepEqual(bad, [], `${f} promete /random`);
    }
});
