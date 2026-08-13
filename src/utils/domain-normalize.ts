/**
 * Normaliza o campo `domain` retornado pelo ETL do GAM.
 *
 * Entre 05-08/08/2026 os ad units do GAM foram renomeados e o `domain` do ETL passou a vir
 * com um ou mais underscores finais (`dopeaaps.com_`, `appcombos.com_`) em vez do domínio limpo
 * (`dopeaaps.com`). O grupo de domínios (`domainGroupService`) e todo o resto do fluxo do
 * ranking — URLs geradas, agrupamento por domínio, `interleaveByDomain`, cache de posts válidos
 * (`validPostsCache`), pool de exploração — usam o domínio limpo; sem normalizar, o filtro por
 * domínio exato deixava de casar e os posts desses domínios sumiam do ranking inteiro.
 *
 * Remove apenas underscores no FINAL da string — um domínio legítimo com underscore no meio
 * (ex.: `meu_site.com`) não é alterado, só o sufixo.
 */
export function normalizeGamDomain(domain: string): string {
    return domain.replace(/_+$/, '');
}
