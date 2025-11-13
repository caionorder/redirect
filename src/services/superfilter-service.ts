import { BuilderService } from './builder-service';
import { ProcessService } from './process-service';

export class SuperFilterService {
  /**
   * Inicializa o serviço de filtro super.
   */
  constructor() {
    this.builderService = new BuilderService();
    this.processService = new ProcessService();
  }

  /**
   * Execute the super filter service.
   *
   * @param {Object} request - Objeto com os parâmetros da requisição
   * @param {Object} repository - Repositório MongoDB
   * @returns {Promise<Array|Object>} - Dados processados ou objeto de resposta
   */
  async execute(request, repository) {
    // Verifica se os parâmetros obrigatórios estão presentes
    const requireParams = ['start', 'end'];
    const missingParams = requireParams.filter(param => !(param in request));

    if (missingParams.length > 0) {
      throw new Error(`Missing required parameters: ${missingParams.join(', ')}`);
    }

    // Prepara os parâmetros de filtro
    const filterParams = this.prepare(request);

    // Executa o build
    const build = await this.builderService.build(repository, filterParams);

    // Verifica se retornou dados
    if (!build || build.length === 0) {
      return {
        status: "success",
        data: [],
        message: "Nenhum dado encontrado."
      };
    }

    // Ordena os dados por revenue
    const sortedData = build.sort((a, b) => {
      const revenueA = parseFloat(a.revenue || 0);
      const revenueB = parseFloat(b.revenue || 0);
      return revenueB - revenueA; // Ordem decrescente
    });

    // Processa os dados
    let processedData;
    if (filterParams.group && filterParams.group.length > 0) {
      processedData = this.processService.groupData(sortedData, filterParams.group);
    } else {
      processedData = this.processService.uniqueData(sortedData);
    }

    // Pré-processa os dados para adicionar campos calculados
    processedData = this.preResultApi(processedData);

    // Ordena os dados processados por receita
    const resultData = processedData.sort((a, b) => {
      const revenueA = parseFloat(a.revenue || 0);
      const revenueB = parseFloat(b.revenue || 0);
      return revenueB - revenueA; // Ordem decrescente
    });

    // Retorna os dados processados
    return resultData;
  }

  /**
   * Prepara os parâmetros de filtro da requisição
   *
   * @param {Object} request - Objeto com os parâmetros da requisição
   * @returns {Object} - Parâmetros formatados para o BuilderService
   */
  prepare(request) {
    const response = {
      network: request.network || null,
      start: request.start || null,
      end: request.end || null,
      country: request.country || null,
      ad_unit_name: request.ad_unit_name || null,
      custom_key: request.custom_key || null,
      custom_value: request.custom_value || null,
      group: request.group || null
    };

    if ('domain' in request) {
      response.domain = request.domain;
    }

    return response;
  }

  /**
   * Pré-processa dados de relatório, adicionando campos calculados
   *
   * @param {Array<Object>} data - Lista de dados a processar
   * @returns {Array<Object>} - Lista de dados com campos calculados
   */
  preResultApi(data) {
    const newData = [];

    for (const item of data) {
      // Cria uma cópia do item para não modificar o original
      const processedItem = { ...item };

      // Extrai os valores necessários para os cálculos
      const revenue = parseFloat(item.revenue || 0);
      const impressions = parseFloat(item.impressions || 0);
      const clicks = parseFloat(item.clicks || 0);
      const revshare = parseFloat(item.revshare || 0);

      // Calcula eCPM
      const ecpm = revenue > 0 && impressions > 0
        ? Math.round((revenue / impressions) * 1000 * 100) / 100
        : 0;

      // Calcula CTR
      const ctr = clicks > 0 && impressions > 0
        ? Math.round((clicks / impressions) * 100 * 100) / 100
        : 0;

      // Se tem revshare, calcula revenue_client e ecpm_client
      if (item.revshare !== null && item.revshare !== undefined) {
        // Calcula revenue_client baseado na revshare
        const revenueClient = revenue * (100 - revshare) / 100;
        const ecpmClient = revenueClient > 0 && impressions > 0
          ? Math.round((revenueClient / impressions) * 1000 * 100) / 100
          : 0;

        processedItem.revenue_client = Math.round(revenueClient * 100) / 100;
        processedItem.ecpm_client = ecpmClient;
      }

      // Adiciona os campos calculados ao item processado
      processedItem.ecpm = ecpm;
      processedItem.ctr = ctr;

      // Adiciona o item processado à nova lista
      newData.push(processedItem);
    }

    return newData;
  }
}
