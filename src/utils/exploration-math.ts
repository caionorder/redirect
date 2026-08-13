/**
 * Aritmética pura por trás da fatia de exploração do redirect controller (posts fora do top
 * do ranking, servidos a 1/N do tráfego). Extraída de `RedirectController` para poder ser
 * testada isoladamente e compartilhada pelos dois handlers de serving (`redirect()` e
 * `redirectByGroup()`) sem duplicar as expressões — uma mudança futura em `EXPLORATION_MOD`
 * ou no tamanho do ranking não deve reintroduzir starvation silenciosamente.
 */

/**
 * Decide se um request cai na fatia de exploração: 1 a cada `mod` (ex.: mod=10 -> 1/10 do
 * tráfego). Convenção: o último valor de cada ciclo (`mod - 1`) é o slot de exploração.
 */
export function isExplorationRequest(visitIndex: number, mod: number): boolean {
    return visitIndex % mod === mod - 1;
}

/**
 * Índice determinístico no pool de exploração para o slot de exploração corrente —
 * round-robin completo sobre `poolLength` conforme o counter avança.
 */
export function explorationPoolIndex(visitIndex: number, mod: number, poolLength: number): number {
    return Math.floor(visitIndex / mod) % poolLength;
}

/**
 * Índice no ranking para requests NÃO-exploração.
 *
 * Sem esta correção, usar `visitIndex % rankingLength` deixaria alguns slots do ranking sem
 * tráfego sempre que um slot de exploração "roubasse" exatamente o visitIndex que mapearia
 * para aquele slot — não é só quando `rankingLength` é múltiplo de `mod` (ex.: 50 e 10), a
 * fórmula abaixo é necessária e correta para QUALQUER `rankingLength`.
 *
 * `rankCounter` é a contagem de requests não-exploração vistos até `visitIndex` (inclusive):
 * decrementa 1 a cada ciclo completo de `mod` já percorrido, o que produz uma sequência de
 * inteiros consecutivos sem buracos sobre os requests não-exploração. `rankCounter % rankingLength`
 * é então um ciclo perfeito, com distribuição uniforme entre os slots.
 */
export function rankIndex(visitIndex: number, mod: number, rankingLength: number): number {
    const rankCounter = visitIndex - Math.floor((visitIndex + 1) / mod);
    return rankCounter % rankingLength;
}

export interface ServingDecision {
    source: 'pool' | 'rank';
    index: number;
}

/**
 * Decide de onde servir o link para este `visitIndex`: do pool de exploração (quando o request
 * cai na fatia de exploração E o pool tem itens) ou do ranking (fatia normal, ou fallback
 * transparente quando o pool está vazio/ausente — ex.: antes do primeiro ciclo do cron rodar).
 */
export function decideServingSource(
    visitIndex: number,
    mod: number,
    rankingLength: number,
    poolLength: number
): ServingDecision {
    if (poolLength > 0 && isExplorationRequest(visitIndex, mod)) {
        return { source: 'pool', index: explorationPoolIndex(visitIndex, mod, poolLength) };
    }
    return { source: 'rank', index: rankIndex(visitIndex, mod, rankingLength) };
}
