import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRps, sortRpsWithEcpmFallback, RpsRankable } from './rps-ranking';

const MIN_UNIQUES = 10;

test('computeRps: null quando uniques é undefined, 0 ou abaixo do mínimo', () => {
    assert.equal(computeRps(100, undefined, MIN_UNIQUES), null);
    assert.equal(computeRps(100, 0, MIN_UNIQUES), null);
    assert.equal(computeRps(100, 9, MIN_UNIQUES), null);
});

test('computeRps: calcula revenue/uniques quando uniques >= minUniques', () => {
    assert.equal(computeRps(100, 10, MIN_UNIQUES), 10);
    assert.equal(computeRps(50, 25, MIN_UNIQUES), 2);
});

test('computeRps: revenue 0 com uniques válido é RPS 0 válido (não null)', () => {
    assert.equal(computeRps(0, 10, MIN_UNIQUES), 0);
});

test('sortRpsWithEcpmFallback: itens com RPS válido vêm antes dos itens sem RPS', () => {
    const items: RpsRankable[] = [
        { rps: null, ecpm: 50, revenue: 10 },
        { rps: 1, ecpm: 1, revenue: 1 },
    ];
    const sorted = sortRpsWithEcpmFallback(items);
    assert.equal(sorted[0].rps, 1);
    assert.equal(sorted[1].rps, null);
});

test('sortRpsWithEcpmFallback: entre itens com RPS válido, ordena por rps desc', () => {
    const items: RpsRankable[] = [
        { rps: 2, ecpm: 1, revenue: 1 },
        { rps: 5, ecpm: 1, revenue: 1 },
        { rps: 3, ecpm: 1, revenue: 1 },
    ];
    const sorted = sortRpsWithEcpmFallback(items);
    assert.deepEqual(sorted.map(i => i.rps), [5, 3, 2]);
});

test('sortRpsWithEcpmFallback: desempate de RPS igual por ecpm desc, depois revenue desc', () => {
    const items: RpsRankable[] = [
        { rps: 5, ecpm: 1, revenue: 10 },
        { rps: 5, ecpm: 3, revenue: 1 },
        { rps: 5, ecpm: 3, revenue: 5 },
    ];
    const sorted = sortRpsWithEcpmFallback(items);
    assert.deepEqual(sorted.map(i => [i.ecpm, i.revenue]), [[3, 5], [3, 1], [1, 10]]);
});

test('sortRpsWithEcpmFallback: itens sem RPS válido ordenam por ecpm desc, depois revenue desc', () => {
    const items: RpsRankable[] = [
        { rps: null, ecpm: 1, revenue: 10 },
        { rps: null, ecpm: 5, revenue: 1 },
        { rps: null, ecpm: 5, revenue: 9 },
    ];
    const sorted = sortRpsWithEcpmFallback(items);
    assert.deepEqual(sorted.map(i => [i.ecpm, i.revenue]), [[5, 9], [5, 1], [1, 10]]);
});

test('sortRpsWithEcpmFallback: todos-null produz a mesma ordem do ranking eCPM puro', () => {
    const items: RpsRankable[] = [
        { rps: null, ecpm: 2, revenue: 1 },
        { rps: null, ecpm: 9, revenue: 1 },
        { rps: null, ecpm: 4, revenue: 1 },
    ];
    const sorted = sortRpsWithEcpmFallback(items);
    const ecpmOnlySort = [...items].sort((a, b) => (b.ecpm - a.ecpm) || (b.revenue - a.revenue));
    assert.deepEqual(sorted, ecpmOnlySort);
});

test('sortRpsWithEcpmFallback: array vazio retorna array vazio', () => {
    assert.deepEqual(sortRpsWithEcpmFallback([]), []);
});

test('sortRpsWithEcpmFallback: não muta o array de entrada', () => {
    const items: RpsRankable[] = [
        { rps: null, ecpm: 1, revenue: 1 },
        { rps: 5, ecpm: 1, revenue: 1 },
    ];
    const original = [...items];
    sortRpsWithEcpmFallback(items);
    assert.deepEqual(items, original);
});

test('computeRps: uniques negativo (dado sujo) é tratado como abaixo do mínimo → null', () => {
    assert.equal(computeRps(100, -5, MIN_UNIQUES), null);
});

test('computeRps: uniques exatamente no mínimo (10) é válido; 9 continua null (boundary)', () => {
    assert.equal(computeRps(30, 10, MIN_UNIQUES), 3);
    assert.equal(computeRps(30, 9, MIN_UNIQUES), null);
});

test('computeRps: revenue negativo com uniques válido produz RPS negativo (não é tratado como inválido)', () => {
    assert.equal(computeRps(-50, 10, MIN_UNIQUES), -5);
});

// Fechamento do finding de Argus/Hera (MIN-1/MIN-2): revenue não-finito (NaN vindo de dado sujo
// upstream, ex.: parse ruim no ranking eCPM) agora cai no guard de computeRps e retorna null —
// nunca propaga NaN como "RPS válido" para sortRpsWithEcpmFallback.
test('computeRps: revenue NaN com uniques válido retorna null (guardado, cai no fallback eCPM)', () => {
    assert.equal(computeRps(NaN, 10, MIN_UNIQUES), null);
});

test('computeRps: uniques 0 exatamente (não apenas negativo) retorna null mesmo com minUniques 0', () => {
    assert.equal(computeRps(100, 0, 0), null);
});

// Fechamento do finding N1 (Hera, round 3): o guard cobria revenue não-finito mas não uniques
// não-finito — computeRps(100, NaN, 10) propagava NaN, e computeRps(100, Infinity, 10) devolvia
// 0 como "RPS válido" (100/Infinity = 0), driblando o piso de MIN_UNIQUES_FOR_RPS.
test('computeRps: uniques NaN retorna null (não propaga NaN)', () => {
    assert.equal(computeRps(100, NaN, MIN_UNIQUES), null);
});

test('computeRps: uniques Infinity retorna null (não produz RPS 0 "válido" driblando o piso)', () => {
    assert.equal(computeRps(100, Infinity, MIN_UNIQUES), null);
});

test('sortRpsWithEcpmFallback: item com rps NaN não lança exceção e não descarta nenhum item da lista', () => {
    const items: RpsRankable[] = [
        { rps: NaN, ecpm: 5, revenue: 5 },
        { rps: 3, ecpm: 1, revenue: 1 },
        { rps: null, ecpm: 2, revenue: 2 },
    ];
    const sorted = sortRpsWithEcpmFallback(items);
    assert.equal(sorted.length, 3);
    // O item null continua sempre depois de qualquer item com rps !== null (inclusive NaN).
    assert.equal(sorted[sorted.length - 1].rps, null);
});

test('sortRpsWithEcpmFallback: lista com 1 item retorna o mesmo item', () => {
    const items: RpsRankable[] = [{ rps: 5, ecpm: 1, revenue: 1 }];
    assert.deepEqual(sortRpsWithEcpmFallback(items), items);

    const withoutRps: RpsRankable[] = [{ rps: null, ecpm: 1, revenue: 1 }];
    assert.deepEqual(sortRpsWithEcpmFallback(withoutRps), withoutRps);
});

test('sortRpsWithEcpmFallback: estabilidade — empate total (rps, ecpm, revenue iguais) preserva a ordem original de entrada', () => {
    const a: RpsRankable = { rps: 5, ecpm: 1, revenue: 1 };
    const b: RpsRankable = { rps: 5, ecpm: 1, revenue: 1 };
    const c: RpsRankable = { rps: 5, ecpm: 1, revenue: 1 };
    const sorted = sortRpsWithEcpmFallback([a, b, c]);
    assert.deepEqual(sorted, [a, b, c]);

    const x: RpsRankable = { rps: null, ecpm: 2, revenue: 2 };
    const y: RpsRankable = { rps: null, ecpm: 2, revenue: 2 };
    const sortedNulls = sortRpsWithEcpmFallback([x, y]);
    assert.deepEqual(sortedNulls, [x, y]);
});
