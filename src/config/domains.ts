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
