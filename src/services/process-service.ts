export class ProcessService {
  /**
   * Processa cada item dos dados, formatando-os individualmente
   *
   * @param {Array<Object>} data - Lista de objetos com os dados a serem processados
   * @returns {Array<Object>} - Lista de dados formatados
   */
  uniqueData(data) {
    return data.map(item => this.formatDataItem(item));
  }

  /**
   * Processa dados agrupados por chaves específicas
   *
   * @param {Array<Object>} data - Lista de objetos com os dados a serem processados
   * @param {Array<string>} groupKeys - Lista de chaves para agrupar os dados
   * @returns {Array<Object>} - Lista de dados agrupados e formatados
   */
  groupData(data, groupKeys) {
    // Criando um mapa para agrupar os dados
    const groups = new Map();

    // Agrupando os dados
    data.forEach(item => {
      // Criando a chave de agrupamento
      const groupKey = groupKeys
        .map(key => {
          const value = item[key];
          return value !== null && value !== undefined ? String(value) : 'None';
        })
        .join('#');

      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey).push(item);
    });

    // Processando cada grupo
    const result = [];
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
      const fields = {};
      keepFields.forEach(key => {
        if (key in baseFields) {
          fields[key] = baseFields[key];
        }
      });

      result.push(fields);
    });

    return result;
  }

  /**
   * Formata um item de dados individual ou um grupo de itens
   *
   * @param {Object} item - Objeto com o item a ser formatado
   * @param {Array<Object>} group - Lista de objetos representando um grupo (opcional)
   * @returns {Object} - Objeto formatado
   */
  formatDataItem(item, group = null) {
    const isGroup = group !== null;

    let impressions, elegibleAdRequest, requestsServed, revenue, pmr,
        unfilledImpressions, clicks, revenueClient, activeView;

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
      revshare: item.revshare,
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
   *
   * @param {Array<Object>} array - Array de objetos
   * @param {string} field - Nome do campo a somar
   * @returns {number} - Soma dos valores
   */
  sumField(array, field) {
    return array.reduce((sum, item) => {
      const value = item[field];
      return sum + (value !== null && value !== undefined ? Number(value) : 0);
    }, 0);
  }

  /**
   * Arredonda um número para um número específico de casas decimais
   *
   * @param {number} value - Valor a arredondar
   * @param {number} decimals - Número de casas decimais
   * @returns {number} - Valor arredondado
   */
  round(value, decimals) {
    return Math.round(value * Math.pow(10, decimals)) / Math.pow(10, decimals);
  }
}

module.exports = ProcessService;
