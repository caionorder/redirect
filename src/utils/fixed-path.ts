export type FixedPathValidation = { ok: true; value: string } | { ok: false; error: string };

const FIXED_PATH_MIN_LENGTH = 2;
const FIXED_PATH_MAX_LENGTH = 200;

// Forma nao ambigua (sem quantificador aninhado) para evitar ReDoS.
// Apenas caracteres "unreserved" (RFC 3986) separados por uma unica "/".
const FIXED_PATH_REGEX = /^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*\/?$/;

const FIXED_PATH_ERROR =
    'fixedPath must be a path like "/my-path/" (2-200 chars, letters, numbers, ".", "_", "~", "-" and "/" only, no "." or ".." segments)';

/**
 * Valida o fixedPath de um grupo. Sem normalizacao silenciosa: o valor
 * armazenado e exatamente o que passou na validacao.
 */
export function validateFixedPath(input: unknown): FixedPathValidation {
    if (typeof input !== 'string') {
        return { ok: false, error: 'fixedPath must be a string' };
    }
    // Checa o tamanho ANTES da regex (limita o custo em entradas publicas)
    if (input.length < FIXED_PATH_MIN_LENGTH || input.length > FIXED_PATH_MAX_LENGTH) {
        return { ok: false, error: `fixedPath length must be between ${FIXED_PATH_MIN_LENGTH} and ${FIXED_PATH_MAX_LENGTH} characters` };
    }
    if (!FIXED_PATH_REGEX.test(input)) {
        return { ok: false, error: FIXED_PATH_ERROR };
    }
    if (input.split('/').some((segment) => segment === '.' || segment === '..')) {
        return { ok: false, error: FIXED_PATH_ERROR };
    }
    return { ok: true, value: input };
}

export function buildFixedPathUrl(domain: string, fixedPath: string): string {
    return `https://${domain}${fixedPath}`;
}

/**
 * Escolhe o dominio de um grupo fixedPath: aleatorio uniforme entre os nao
 * visitados; se todos ja foram visitados (exhausted), aleatorio entre todos.
 * Retorna null se o grupo nao tem dominios. `rand` injetavel para teste.
 */
export function pickFixedPathDomain(
    domains: string[],
    visited: Set<string>,
    rand: () => number = Math.random
): { domain: string; exhausted: boolean } | null {
    if (domains.length === 0) return null;

    const unvisited = domains.filter((d) => !visited.has(d));
    const exhausted = unvisited.length === 0;
    const pool = exhausted ? domains : unvisited;
    const index = Math.min(pool.length - 1, Math.floor(rand() * pool.length));
    return { domain: pool[index], exhausted };
}

export const FIXED_PATH_MAIN_ERROR = 'fixedPath is not supported for the main group';

/**
 * Monta o linkId de um grupo fixedPath (formatos legados de atribuicao de cliques):
 * bestRpsMode -> `bestrps_<slug>_<dominio>_fixed` (ou `bestrps_exhausted_<slug>_<dominio>` se exhausted);
 * sem bestRpsMode -> `fixed_<slug>_<dominio>`.
 */
export function buildFixedPathLinkId(slug: string, domain: string, exhausted: boolean, bestRpsMode: boolean): string {
    if (bestRpsMode) {
        return exhausted ? `bestrps_exhausted_${slug}_${domain}` : `bestrps_${slug}_${domain}_fixed`;
    }
    return `fixed_${slug}_${domain}`;
}

/**
 * fixedPath efetivo na leitura: so vale se o slug nao e 'main' e o valor armazenado
 * passa na validacao. Pura (sem I/O). `invalid` = havia valor mas foi rejeitado.
 */
export function resolveEffectiveFixedPath(slug: string, stored: unknown): { path: string | null; invalid: boolean } {
    if (stored === undefined || stored === null || stored === '') return { path: null, invalid: false };
    if (slug === 'main') return { path: null, invalid: true };
    const v = validateFixedPath(stored);
    return v.ok ? { path: v.value, invalid: false } : { path: null, invalid: true };
}
