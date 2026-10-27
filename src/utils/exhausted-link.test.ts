import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickExhaustedLink } from './exhausted-link';
import { LinkInfo } from './interleave-by-domain';

function link(domain: string, postId: string): LinkInfo {
    return { url: `https://${domain}/?p=${postId}`, domain, postId, ecpm: 1, revenue: 1, uniqueVisitors: 0, rps: 0 };
}

const ranking: LinkInfo[] = [link('a.com', '1'), link('b.com', '1'), link('a.com', '2')];

test('pickExhaustedLink: rotaciona pelo visitIndex módulo tamanho do ranking', () => {
    assert.equal(pickExhaustedLink(ranking, 0).index, 0);
    assert.equal(pickExhaustedLink(ranking, 1).link, ranking[1]);
    assert.equal(pickExhaustedLink(ranking, 2).index, 2);
    assert.equal(pickExhaustedLink(ranking, 3).index, 0);
    assert.equal(pickExhaustedLink(ranking, 7).index, 1);
});

test('pickExhaustedLink: visitIndex grande permanece dentro do ranking', () => {
    const big = Number.MAX_SAFE_INTEGER;
    const r = pickExhaustedLink(ranking, big);
    assert.equal(r.index, big % ranking.length);
    assert.equal(r.link, ranking[r.index]);
});

test('pickExhaustedLink: ranking de 1 item sempre devolve esse item', () => {
    const one = [link('a.com', '9')];
    for (const v of [0, 1, 5, 1_000_000]) {
        assert.equal(pickExhaustedLink(one, v).link, one[0]);
    }
});

test('pickExhaustedLink: nunca devolve postId random em rankings válidos', () => {
    for (let v = 0; v < 50; v++) {
        assert.notEqual(pickExhaustedLink(ranking, v).link.postId, 'random');
    }
});

test('pickExhaustedLink: ranking vazio devolve null', () => {
    assert.equal(pickExhaustedLink([], 3), null);
});
