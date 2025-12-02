export const domains = [
    "useuapp.com",
    "dopeaaps.com",
    "odiahoje.com",
    "esportesblog.com"
];

export interface IFallbackDomain {
    url: string;
    weight?: number;
    active: boolean;
}

export const fallbackDomains: IFallbackDomain[] = domains.map(domain => ({
    url: `https://${domain}`,
    weight: 1,
    active: true
}));

/**
 * Mapeamento de hora do dia (0-23) para domínio
 * Rotaciona os 4 domínios ao longo das 24 horas
 */
export const hourToDomainMap: Record<number, string> = {
    0: "useuapp.com",
    1: "dopeaaps.com",
    2: "odiahoje.com",
    3: "esportesblog.com",
    4: "useuapp.com",
    5: "dopeaaps.com",
    6: "odiahoje.com",
    7: "esportesblog.com",
    8: "useuapp.com",
    9: "dopeaaps.com",
    10: "odiahoje.com",
    11: "esportesblog.com",
    12: "useuapp.com",
    13: "dopeaaps.com",
    14: "odiahoje.com",
    15: "esportesblog.com",
    16: "useuapp.com",
    17: "dopeaaps.com",
    18: "odiahoje.com",
    19: "esportesblog.com",
    20: "useuapp.com",
    21: "dopeaaps.com",
    22: "odiahoje.com",
    23: "esportesblog.com"
};

/**
 * Retorna o domínio para a hora atual
 */
export function getDomainForCurrentHour(): string {
    const currentHour = new Date().getHours();
    return hourToDomainMap[currentHour] || domains[0];
}

/**
 * Retorna o domínio para a próxima hora (usado no cron do minuto 59)
 */
export function getDomainForNextHour(): string {
    const nextHour = (new Date().getHours() + 1) % 24;
    return hourToDomainMap[nextHour] || domains[0];
}

export function getActiveFallbackDomains(): IFallbackDomain[] {
    return fallbackDomains.filter(domain => domain.active);
}

export function getRandomFallbackDomain(): string | null {
    const activeDomains = getActiveFallbackDomains();
    if (activeDomains.length === 0) return null;

    const randomIndex = Math.floor(Math.random() * activeDomains.length);
    return activeDomains[randomIndex].url;
}

export function generateRandomPath(): string {
    return `/random`;
}
