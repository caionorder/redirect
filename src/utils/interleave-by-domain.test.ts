import { test } from 'node:test';
import assert from 'node:assert/strict';
import { interleaveByDomain, LinkInfo } from './interleave-by-domain';

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

test('interleaveByDomain: domínio sem dados entra como /random no fim de cada rodada', () => {
    const ranking: LinkInfo[] = [
        link('a.com', '1', 10, 1),
    ];
    const result = interleaveByDomain(ranking, ['a.com', 'empty.com']);
    assert.equal(result.length, 2);
    assert.equal(result[0].domain, 'a.com');
    assert.equal(result[0].postId, '1');
    assert.equal(result[1].domain, 'empty.com');
    assert.equal(result[1].postId, 'random');
    assert.equal(result[1].ecpm, 0);
    assert.equal(result[1].revenue, 0);
    assert.match(result[1].url, /^https:\/\/empty\.com\//);
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

test('interleaveByDomain: array de ranking vazio produz apenas /random para todos os domínios', () => {
    const result = interleaveByDomain([], ['a.com', 'b.com']);
    assert.equal(result.length, 2);
    assert.ok(result.every(r => r.postId === 'random'));
});

test('interleaveByDomain: domínio que esgota antes dos outros vira /random na rodada seguinte', () => {
    // a.com tem 2 links, b.com tem 1 — na rodada 1 (índice 1) b.com já esgotou e deve virar
    // /random, não sumir do resultado nem repetir o último link real.
    const ranking: LinkInfo[] = [
        link('a.com', '1', 10, 1),
        link('a.com', '2', 5, 1),
        link('b.com', '1', 8, 1),
    ];
    const result = interleaveByDomain(ranking, ['a.com', 'b.com']);
    assert.deepEqual(result.map(r => `${r.domain}:${r.postId}`), [
        'a.com:1', 'b.com:1', 'a.com:2', 'b.com:random',
    ]);
});
