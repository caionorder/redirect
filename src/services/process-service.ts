import { IDataItem, IProcessedData } from '../interfaces/filter-interfaces';

export class ProcessService {
  /**
   * Processa cada item dos dados, formatando-os individualmente
   */
  uniqueData(data: IDataItem[]): IProcessedData[] {
    return data.map(item => this.formatDataItem(item));
  }

  /**
   * Processa dados agrupados por chaves específicas
   */
  groupData(data: IDataItem[], groupKeys: string[]): IProcessedData[] {
    // Criando um mapa para agrupar os dados
    const groups = new Map<string, IDataItem[]>();

    // Agrupando os dados
    data.forEach(item => {
      // Criando a chave de agrupamento
      const groupKey = groupKeys
        .map(key => {
          const value = (item as any)[key];
          return value !== null && value !== undefined ? String(value) : 'None';
        })
        .join('#');

      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(item);
    });

    // Processando cada grupo
    const result: IProcessedData[] = [];
    groups.forEach(group => {
      // Obtendo o primeiro item para os campos de identificação
      const baseFields = this.formatDataItem(group[0], group);

      // Campos que queremos manter
      const keepFields = [
        ...groupKeys,
        'revshare', 'impressions', 'clicks', 'revenue', 'revenue_client',
        'ecpm', 'active_view', 'pmr', 'unfilled_impressions',
        'requests_served', 'elegible_ad_request'
      ];

      // Filtrando apenas os campos desejados
      const fields: any = {};
      keepFields.forEach(key => {
        if (key in baseFields) {
          fields[key] = (baseFields as any)[key];
        }
      });

      result.push(fields as IProcessedData);
    });

    return result;
  }

  /**
   * Formata um item de dados individual ou um grupo de itens
   */
  private formatDataItem(item: IDataItem, group: IDataItem[] | null = null): IProcessedData {
    const isGroup = group !== null;

    let impressions: number;
    let elegibleAdRequest: number;
    let requestsServed: number;
    let revenue: number;
    let pmr: number;
    let unfilledImpressions: number | null;
    let clicks: number;
    let revenueClient: number;
    let activeView: number;

    if (isGroup) {
      // Calcular estatísticas do grupo
      impressions = Math.floor(this.sumField(group, 'impressions'));
      elegibleAdRequest = Math.floor(this.sumField(group, 'elegible_ad_request'));
      requestsServed = Math.floor(this.sumField(group, 'requests_served'));

      // Formatando o valor de revenue com precisão de 2 casas decimais
      revenue = this.round(this.sumField(group, 'revenue'), 2);

      // Calculando média do PMR
      pmr = group.length > 0 ? this.sumField(group, 'pmr') / group.length : 0;

      // Processando unfilled_impressions
      const unfilledSum = group.reduce((sum, d) => {
        const value = d.unfilled_impressions;
        return value !== null && value !== undefined ? sum + Number(value) : sum;
      }, 0);
      unfilledImpressions = unfilledSum > 0 ? Math.floor(unfilledSum) : null;

      // Calculando a soma dos clicks
      clicks = Math.floor(this.sumField(group, 'clicks'));

      // Calculando a soma de revenue_client
      revenueClient = this.round(this.sumField(group, 'revenue_client'), 2);

      // Calculando a média de active_view
      const activeViewValues = group
        .map(d => d.active_view)
        .filter(v => v !== null && v !== undefined)
        .map(v => Number(v));

      if (activeViewValues.length > 0) {
        const avgActiveView = activeViewValues.reduce((a, b) => a + b, 0) / activeViewValues.length;
        activeView = this.round(avgActiveView * 100, 4);
      } else {
        activeView = 0;
      }

    } else {
      // Processando item individual
      impressions = Math.floor(Number(item.impressions || 0));
      elegibleAdRequest = Math.floor(Number(item.elegible_ad_request || 0));
      requestsServed = Math.floor(Number(item.requests_served || 0));
      revenue = this.round(Number(item.revenue || 0), 2);
      pmr = Math.floor(Number(item.pmr || 0));

      // Processando unfilled_impressions
      unfilledImpressions = item.unfilled_impressions !== null && item.unfilled_impressions !== undefined
        ? Math.floor(Number(item.unfilled_impressions))
        : null;

      // Processando clicks
      clicks = Math.floor(Number(item.clicks || 0));

      // Processando revenue_client
      revenueClient = this.round(Number(item.revenue_client || 0), 2);

      // Processando active_view
      activeView = this.round(Number(item.active_view || 0) * 100, 4);
    }

    // Calculando o eCPM
    const ecpm = impressions > 0
      ? this.round((revenue / impressions) * 1000, 2)
      : 0;

    // Calculando o PMR final
    const finalPmr = elegibleAdRequest > 0
      ? this.round((requestsServed / elegibleAdRequest) * 100, 2)
      : pmr;

    // Retornando o objeto formatado
    return {
      ad_unit_name: item.ad_unit_name,
      domain: item.domain,
      domain_id: item.domain_id,
      network: item.network,
      revshare: item.revshare ? Number(item.revshare) : undefined,
      hour: item.hour,
      impressions: impressions,
      clicks: clicks,
      revenue: revenue,
      revenue_client: revenueClient,
      ecpm: ecpm,
      active_view: activeView,
      unfilled_impressions: unfilledImpressions,
      requests_served: requestsServed,
      elegible_ad_request: elegibleAdRequest,
      pmr: finalPmr,
      custom_key: item.custom_key,
      custom_value: item.custom_value,
      date: item.date,
      country: item.country,
      brand_name: item.brand_name,
      advertiser_name: item.advertiser_name
    };
  }

  /**
   * Soma valores de um campo específico em um array de objetos
   */
  private sumField(array: IDataItem[], field: keyof IDataItem): number {
    return array.reduce((sum, item) => {
      const value = item[field];
      return sum + (value !== null && value !== undefined ? Number(value) : 0);
    }, 0);
  }

  /**
   * Arredonda um número para um número específico de casas decimais
   */
  private round(value: number, decimals: number): number {
    return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
  }
}