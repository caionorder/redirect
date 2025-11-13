import { IFilterParams, IMatchStage, IGroupStage, IRepository, IDataItem } from '../interfaces/filter-interfaces';

export class BuilderService {
  /**
   * Constrói e executa uma consulta de agregação complexa baseada nos parâmetros fornecidos
   */
  async build(repository: IRepository, params: IFilterParams): Promise<IDataItem[]> {
    // Validação de parâmetros obrigatórios
    if (!params.start || !params.end) {
      throw new Error("Parâmetros 'start' e 'end' são obrigatórios");
    }

    // Construção do estágio $match dinamicamente
    const matchStage: IMatchStage = {
      date: {
        $gte: params.start,
        $lte: params.end
      }
    };

    // Adiciona filtros condicionais
    if (params.domain) {
      const domainList = Array.isArray(params.domain) ? params.domain : [params.domain];
      matchStage.domain = { $in: domainList };
    }

    if (params.network) {
      matchStage.network = params.network;
    }

    if (params.country) {
      matchStage.country = params.country;
    }

    if (params.custom_key) {
      matchStage.custom_key = params.custom_key;
    }

    if (params.custom_value) {
      let values: string[] = [];
      if (typeof params.custom_value === 'string' && params.custom_value.includes(',')) {
        values = params.custom_value.split(',').map(v => v.trim());
      } else if (Array.isArray(params.custom_value)) {
        values = params.custom_value;
      } else if (params.custom_value) {
        values = [params.custom_value];
      }
      if (values.length > 0) {
        matchStage.custom_value = { $in: values };
      }
    }

    if (params.ad_unit_name) {
      matchStage.ad_unit_name = {
        $regex: params.ad_unit_name,
        $options: 'i'
      };
    }

    // Pipeline inicial
    const pipeline: any[] = [{ $match: matchStage }];

    // Converte campos para numérico com tratamento de null
    pipeline.push({
      $addFields: {
        impressions_int: { $toInt: { $ifNull: ['$impressions', 0] } },
        clicks_int: { $toInt: { $ifNull: ['$clicks', 0] } },
        unfilled_impressions_int: { $toInt: { $ifNull: ['$unfilled_impressions', 0] } },
        requests_served_int: { $toInt: { $ifNull: ['$requests_served', 0] } },
        elegible_ad_request_int: { $toInt: { $ifNull: ['$elegible_ad_request', 0] } },
        revshare_int: { $toDouble: { $ifNull: ['$revshare', 0] } },
        active_view_double: { $toDouble: { $ifNull: ['$active_view', 0] } },
        ecpm_double: { $toDouble: { $ifNull: ['$ecpm', 0] } },
        pmr_double: { $toDouble: { $ifNull: ['$pmr', 0] } },
        ctr_double: { $toDouble: { $ifNull: ['$ctr', 0] } },
        revenue_double: { $toDouble: { $ifNull: ['$revenue', 0] } },
        revenue_client_double: { $toDouble: { $ifNull: ['$revenue_client', 0] } }
      }
    });

    // Constrói o _id do $group
    const groupId: Record<string, string> = {};
    if (params.group && params.group.length > 0) {
      params.group.forEach(field => {
        groupId[field] = `$${field}`;
      });
    }

    // Estágio de agrupamento
    const groupStage: IGroupStage = {
      $group: {
        _id: groupId,
        impressions: { $sum: '$impressions_int' },
        clicks: { $sum: '$clicks_int' },
        revenue: { $sum: '$revenue_double' },
        revenue_client: { $sum: '$revenue_client_double' },
        unfilled_impressions: { $sum: '$unfilled_impressions_int' },
        requests_served: { $sum: '$requests_served_int' },
        elegible_ad_request: { $sum: '$elegible_ad_request_int' },
        ecpm: { $avg: '$ecpm_double' },
        active_view: { $avg: '$active_view_double' },
        pmr: { $avg: '$pmr_double' },
        revshare: { $avg: '$revshare_int' }
      }
    };
    pipeline.push(groupStage);

    // Configurando a projeção
    const projectStage: any = {
      $project: {
        _id: 0,
        impressions: 1,
        clicks: 1,
        revenue: 1,
        revenue_client: 1,
        unfilled_impressions: 1,
        requests_served: 1,
        elegible_ad_request: 1,
        ecpm: 1,
        active_view: 1,
        pmr: 1,
        revshare: 1
      }
    };

    // Adiciona campos do group_id à projeção
    Object.keys(groupId).forEach(key => {
      projectStage.$project[key] = `$_id.${key}`;
    });
    pipeline.push(projectStage);

    // Adiciona campos calculados
    pipeline.push({
      $addFields: {
        ecpm: {
          $cond: {
            if: { $eq: ['$impressions', 0] },
            then: 0,
            else: {
              $multiply: [
                { $divide: ['$revenue', { $divide: ['$impressions', 1000] }] },
                1
              ]
            }
          }
        },
        ecpm_client: {
          $cond: {
            if: { $eq: ['$impressions', 0] },
            then: 0,
            else: {
              $multiply: [
                { $divide: ['$revenue_client', { $divide: ['$impressions', 1000] }] },
                1
              ]
            }
          }
        },
        ctr: {
          $cond: {
            if: { $eq: ['$impressions', 0] },
            then: 0,
            else: {
              $multiply: [
                { $divide: ['$clicks', '$impressions'] },
                100
              ]
            }
          }
        },
        pmr: {
          $cond: {
            if: { $eq: ['$requests_served', 0] },
            then: 0,
            else: {
              $multiply: [
                { $divide: ['$elegible_ad_request', '$requests_served'] },
                100
              ]
            }
          }
        }
      }
    });

    // Ordenação
    let sortField: string;
    if (groupId.date) {
      sortField = '_id.date';
    } else if (Object.keys(groupId).length > 0) {
      sortField = '_id.' + Object.keys(groupId)[0];
    } else {
      sortField = 'revenue';
    }

    pipeline.push({
      $sort: {
        [sortField]: -1
      }
    });

    // Para depuração
    console.log('Pipeline JSON:', JSON.stringify(pipeline, null, 2));

    // Executando a agregação
    try {
      const results = await repository.query().aggregate(pipeline).toArray();
      return results as IDataItem[];
    } catch (error) {
      console.error('Erro na agregação:', error);
      throw error;
    }
  }
}