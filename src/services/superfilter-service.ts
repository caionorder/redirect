import { BuilderService } from './builder-service';
import { ProcessService } from './process-service';
import {
  IFilterRequest,
  IFilterParams,
  IDataItem,
  IProcessedData,
  IErrorResponse,
  IRepository
} from '../interfaces/filter-interfaces';

export class SuperFilterService {
  private builderService: BuilderService;
  private processService: ProcessService;

  /**
   * Inicializa o serviço de filtro super
   */
  constructor() {
    this.builderService = new BuilderService();
    this.processService = new ProcessService();
  }

  /**
   * Execute the super filter service
   */
  async execute(
    request: IFilterRequest,
    repository: IRepository
  ): Promise<IProcessedData[] | IErrorResponse> {
    // Verifica se os parâmetros obrigatórios estão presentes
    const requireParams: (keyof IFilterRequest)[] = ['start', 'end'];
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
      const revenueA = parseFloat(String(a.revenue || 0));
      const revenueB = parseFloat(String(b.revenue || 0));
      return revenueB - revenueA; // Ordem decrescente
    });

    // Processa os dados
    let processedData: IProcessedData[];
    if (filterParams.group && filterParams.group.length > 0) {
      processedData = this.processService.groupData(sortedData, filterParams.group);
    } else {
      processedData = this.processService.uniqueData(sortedData);
    }

    // Pré-processa os dados para adicionar campos calculados
    processedData = this.preResultApi(processedData);

    // Ordena os dados processados por receita
    const resultData = processedData.sort((a, b) => {
      const revenueA = parseFloat(String(a.revenue || 0));
      const revenueB = parseFloat(String(b.revenue || 0));
      return revenueB - revenueA; // Ordem decrescente
    });

    // Retorna os dados processados
    return resultData;
  }

  /**
   * Prepara os parâmetros de filtro da requisição
   */
  private prepare(request: IFilterRequest): IFilterParams {
    const response: IFilterParams = {
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
   */
  private preResultApi(data: IProcessedData[]): IProcessedData[] {
    const newData: IProcessedData[] = [];

    for (const item of data) {
      // Cria uma cópia do item para não modificar o original
      const processedItem = { ...item };

      // Extrai os valores necessários para os cálculos
      const revenue = parseFloat(String(item.revenue || 0));
      const impressions = parseFloat(String(item.impressions || 0));
      const clicks = parseFloat(String(item.clicks || 0));
      const revshare = parseFloat(String(item.revshare || 0));

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