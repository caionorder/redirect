import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interleaveByDomain, dropRandomPlaceholders, LinkInfo } from './interleave-by-domain';

function link(domain: string, postId: string, ecpm: number, revenue: number): LinkInfo {
    return { url: `https://${domain}/?p=${postId}`, domain, postId, ecpm, revenue, uniqueVisitors: 0, rps: 0 };
}

test('interleaveByDomain: round-robin básico intercala domínios em vez de agrupar por domínio', () => {
    const ranking: LinkInfo[] = [
        link('a.com', '1', 10, 1),
        link('a.com', '2', 9, 1),
        link('b.com', '1', 8, 1),
        link('b.com', '2', 7, 1),
    ];
    const result = interleaveByDomain(ranking, ['a.com', 'b.com']);
    assert.deepEqual(result.map(r => `${r.domain}:${r.postId}`), [
        'a.com:1', 'b.com:1', 'a.com:2', 'b.com:2',
    ]);
});

test('interleaveByDomain: domínio sem dados não gera slot (sem padding)', () => {
    const ranking: LinkInfo[] = [
        link('a.com', '1', 10, 1),
    ];
    const result = interleaveByDomain(ranking, ['a.com', 'empty.com']);
    assert.equal(result.length, 1);
    assert.equal(result[0].domain, 'a.com');
    assert.equal(result[0].postId, '1');
});

test('interleaveByDomain: empate de eCPM entre domínios desempata pela ordem do ranking recebido (revenue desc), não pela ordem de cadastro', () => {
    // a.com e b.com empatados em eCPM 5.00, mas b.com tem revenue maior — o ranking de entrada
    // (já ordenado por ecpm desc, revenue desc, como o controller produz) traz b.com antes de
    // a.com. allDomains lista a.com primeiro (ordem de cadastro) — o resultado deve seguir a
    // posição no ranking, não allDomains.
    const ranking: LinkInfo[] = [
        link('b.com', '1', 5, 90),
        link('a.com', '1', 5, 10),
        link('c.com', '1', 1, 1),
    ];
    const result = interleaveByDomain(ranking, ['a.com', 'b.com', 'c.com']);
    assert.deepEqual(result.map(r => r.domain), ['b.com', 'a.com', 'c.com']);
});

test('interleaveByDomain: ordem RPS é preservada (critério-agnóstico — não depende de eCPM)', () => {
    // Ranking já reordenado por RPS (não por eCPM) — c.com tem o RPS mais alto apesar do eCPM
    // mais baixo, simulando o que sortRpsWithEcpmFallback produziria antes do interleave.
    const ranking: LinkInfo[] = [
        link('c.com', '1', 1, 1),
        link('a.com', '1', 10, 1),
        link('b.com', '1', 5, 1),
    ];
    const result = interleaveByDomain(ranking, ['a.com', 'b.com', 'c.com']);
    assert.deepEqual(result.map(r => r.domain), ['c.com', 'a.com', 'b.com']);
});

test('interleaveByDomain: ranking vazio produz resultado vazio', () => {
    const result = interleaveByDomain([], ['a.com', 'b.com']);
    assert.deepEqual(result, []);
});

test('interleaveByDomain: domínio que esgota antes dos outros é pulado nas rodadas seguintes', () => {
    const ranking: LinkInfo[] = [
        link('a.com', '1', 10, 1),
        link('a.com', '2', 5, 1),
        link('b.com', '1', 8, 1),
    ];
    const result = interleaveByDomain(ranking, ['a.com', 'b.com']);
    assert.deepEqual(result.map(r => `${r.domain}:${r.postId}`), [
        'a.com:1', 'b.com:1', 'a.com:2',
    ]);
});

test('interleaveByDomain: domínios com quantidades diferentes de links (3/1/2)', () => {
    const ranking: LinkInfo[] = [
        link('a.com', '1', 10, 1),
        link('a.com', '2', 9, 1),
        link('b.com', '1', 8, 1),
        link('c.com', '1', 7, 1),
        link('a.com', '3', 6, 1),
        link('c.com', '2', 5, 1),
    ];
    const result = interleaveByDomain(ranking, ['a.com', 'b.com', 'c.com', 'empty.com']);
    assert.deepEqual(result.map(r => `${r.domain}:${r.postId}`), [
        'a.com:1', 'b.com:1', 'c.com:1',
        'a.com:2', 'c.com:2',
        'a.com:3',
    ]);
});

test('interleaveByDomain: nunca emite item random nem URL /random', () => {
    const ranking: LinkInfo[] = [
        link('a.com', '1', 10, 1),
        link('b.com', '1', 8, 1),
        link('b.com', '2', 7, 1),
    ];
    for (const all of [['a.com', 'b.com'], ['a.com', 'b.com', 'x.com', 'y.com'], []]) {
        const result = interleaveByDomain(ranking, all);
        assert.ok(result.every(r => r.postId !== 'random' && !r.url.includes('/random')));
    }
    assert.ok(interleaveByDomain([], ['a.com']).every(r => r.postId !== 'random'));
});

test('dropRandomPlaceholders: remove itens random legados e preserva a ordem dos reais', () => {
    const ranking: LinkInfo[] = [
        link('a.com', '1', 10, 1),
        { ...link('es.com', 'random', 0, 0), url: 'https://es.com/random' },
        link('a.com', '2', 5, 1),
    ];
    assert.deepEqual(dropRandomPlaceholders(ranking).map(r => r.postId), ['1', '2']);
    assert.deepEqual(dropRandomPlaceholders([{ ...link('x.com', 'random', 0, 0) }]), []);
});
