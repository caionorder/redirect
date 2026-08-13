import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    isExplorationRequest,
    explorationPoolIndex,
    rankIndex,
    decideServingSource,
} from './exploration-math';

const MOD = 10;

/** Roda `n` iterações de `visitIndex` a partir de `start`, chamando `fn(visitIndex)`. */
function simulate(start: number, n: number, fn: (visitIndex: number) => void): void {
    for (let v = start; v < start + n; v++) fn(v);
}

test('isExplorationRequest: exatamente 1/mod dos índices caem em exploração', () => {
    const N = 100_000;
    let count = 0;
    simulate(0, N, v => { if (isExplorationRequest(v, MOD)) count++; });
    assert.equal(count, N / MOD);
});

test('rankIndex: nenhuma starvation e distribuição uniforme, para vários tamanhos de ranking', () => {
    // Inclui tamanhos múltiplos de MOD (50, 10) e não-múltiplos (47, 7, 3, 1) — a fórmula
    // precisa valer nos dois casos, não só quando rankingLength é múltiplo de mod.
    const rankLens = [50, 47, 10, 7, 3, 1];
    for (const rankLen of rankLens) {
        const N = 100_000;
        const hits = new Array(rankLen).fill(0);
        simulate(0, N, v => {
            if (isExplorationRequest(v, MOD)) return;
            hits[rankIndex(v, MOD, rankLen)]++;
        });
        const min = Math.min(...hits);
        const max = Math.max(...hits);
        assert.ok(min > 0, `rankLen=${rankLen}: existe slot do ranking com 0 hits (hits=${JSON.stringify(hits)})`);
        assert.ok(max - min <= 1, `rankLen=${rankLen}: distribuição não uniforme (min=${min}, max=${max})`);
    }
});

test('explorationPoolIndex: round-robin completo sobre o pool, para vários tamanhos', () => {
    const poolLens = [300, 37, 10, 5, 1];
    for (const poolLen of poolLens) {
        const N = 100_000;
        const hits = new Array(poolLen).fill(0);
        simulate(0, N, v => {
            if (!isExplorationRequest(v, MOD)) return;
            hits[explorationPoolIndex(v, MOD, poolLen)]++;
        });
        const min = Math.min(...hits);
        const max = Math.max(...hits);
        assert.ok(min > 0, `poolLen=${poolLen}: existe slot do pool com 0 hits (hits=${JSON.stringify(hits)})`);
        assert.ok(max - min <= 1, `poolLen=${poolLen}: distribuição não uniforme (min=${min}, max=${max})`);
    }
});

test('rankIndex: offset de counter arbitrário (contagem em curso, não iniciando do zero)', () => {
    const rankLen = 50;
    const hits = new Array(rankLen).fill(0);
    simulate(12_345, 100_000, v => {
        if (isExplorationRequest(v, MOD)) return;
        hits[rankIndex(v, MOD, rankLen)]++;
    });
    const min = Math.min(...hits);
    const max = Math.max(...hits);
    assert.ok(min > 0, 'existe slot com 0 hits com offset de counter arbitrário');
    assert.ok(max - min <= 1, `distribuição não uniforme com offset (min=${min}, max=${max})`);
});

test('decideServingSource: pool vazio (length 0) -> tudo cai no ranking, sem starvation', () => {
    const rankLen = 50;
    const hits = new Array(rankLen).fill(0);
    let poolPicks = 0;
    simulate(0, 100_000, v => {
        const decision = decideServingSource(v, MOD, rankLen, 0);
        if (decision.source === 'pool') { poolPicks++; return; }
        hits[decision.index]++;
    });
    assert.equal(poolPicks, 0, 'pool vazio nunca deveria ser escolhido como source');
    const min = Math.min(...hits);
    const max = Math.max(...hits);
    assert.ok(min > 0, `existe slot do ranking com 0 hits quando o pool está vazio (hits=${JSON.stringify(hits)})`);
    assert.ok(max - min <= 1, `distribuição não uniforme com pool vazio (min=${min}, max=${max})`);
});

test('decideServingSource: pool com itens -> exatamente 1/mod das requests vai pro pool, resto pro ranking uniforme', () => {
    const rankLen = 50;
    const poolLen = 37;
    const rankHits = new Array(rankLen).fill(0);
    const poolHits = new Array(poolLen).fill(0);
    const N = 100_000;
    simulate(0, N, v => {
        const decision = decideServingSource(v, MOD, rankLen, poolLen);
        if (decision.source === 'pool') poolHits[decision.index]++;
        else rankHits[decision.index]++;
    });

    const totalPool = poolHits.reduce((a, b) => a + b, 0);
    const totalRank = rankHits.reduce((a, b) => a + b, 0);
    assert.equal(totalPool, N / MOD);
    assert.equal(totalRank, N - N / MOD);

    assert.ok(Math.min(...rankHits) > 0, 'existe slot do ranking com 0 hits');
    assert.ok(Math.max(...rankHits) - Math.min(...rankHits) <= 1, 'ranking não uniforme');
    assert.ok(Math.min(...poolHits) > 0, 'existe slot do pool com 0 hits');
    assert.ok(Math.max(...poolHits) - Math.min(...poolHits) <= 1, 'pool não uniforme');
});
