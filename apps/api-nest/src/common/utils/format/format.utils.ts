/**
 * Format aggregated results into standardized structures
 * Handles common formatting patterns across services
 */

/**
 * Format raw database results into a structured time series format
 * @param timeSeriesData - Raw time series data
 * @param dateField - Name of the date field
 * @param metricFields - Array of metric field names to extract
 * @param transformer - Optional transform function for each data point
 * @returns Formatted time series data
 */
export const formatTimeSeriesData = (
  timeSeriesData: any[],
  dateField: string = 'date',
  metricFields: string[] = [],
  transformer: ((formattedItem: any, data: any) => any) | null = null,
): any[] => {
  return timeSeriesData
    .map((item) => {
      const data = item;

      const formattedItem: any = {
        [dateField]: data[dateField],
      };

      metricFields.forEach((field) => {
        if (field.includes('.')) {
          const parts = field.split('.');
          let value = data;
          for (const part of parts) {
            value = value?.[part];
          }
          formattedItem[field.replace('.', '_')] = parseNumericValue(value);
        } else {
          formattedItem[field] = parseNumericValue(data[field]);
        }
      });

      return transformer ? transformer(formattedItem, data) : formattedItem;
    })
    .sort((a, b) => new Date(a[dateField]).getTime() - new Date(b[dateField]).getTime());
};

/**
 * Parse numeric values safely from strings or objects
 * @param value - Value to parse
 * @param defaultValue - Default value if parsing fails
 * @returns Parsed number
 */
export const parseNumericValue = (value: any, defaultValue: number = 0): number => {
  if (value === null || value === undefined) return defaultValue;

  if (typeof value === 'number') return value;

  try {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? defaultValue : parsed;
  } catch (e) {
    return defaultValue;
  }
};

/**
 * Calculate totals from an array of objects
 * @param data - Array of objects containing numeric fields
 * @param fields - Fields to sum
 * @returns Object with field totals
 */
export const calculateTotals = (data: any[], fields: string[]): Record<string, number> => {
  return fields.reduce(
    (totals, field) => {
      totals[field] = data.reduce((sum, item) => sum + parseNumericValue(item[field]), 0);
      return totals;
    },
    {} as Record<string, number>,
  );
};

/**
 * Calculate percentages for a dimension relative to a total
 * @param dimensionData - Array of dimension items
 * @param valueField - Field to use for percentage
 * @param total - Total value to calculate percentage against
 * @returns Data with percentage added
 */
export const addPercentages = (dimensionData: any[], valueField: string, total: number): any[] => {
  return dimensionData.map((item) => ({
    ...item,
    percentage: total > 0 ? (parseNumericValue(item[valueField]) / total) * 100 : 0,
  }));
};

/**
 * Extract metadata from data for referenced entities
 * @param data - Array of data objects
 * @param metadataConfig - Configuration for metadata extraction
 * @returns Extracted metadata by entity type
 */
export const extractMetadata = (
  data: any[],
  metadataConfig: Record<
    string,
    {
      idField: string;
      dataField?: string;
      attributes: string[];
    }
  >,
): Record<string, any[]> => {
  const metadata: Record<string, Record<string, any>> = {};

  Object.entries(metadataConfig).forEach(([entityType, config]) => {
    const { idField, dataField, attributes } = config;
    metadata[entityType] = {};

    data.forEach((item) => {
      const entityData = dataField ? item[dataField] : item;
      if (!entityData || !entityData[idField]) return;

      const entityId = entityData[idField];
      if (!metadata[entityType][entityId]) {
        metadata[entityType][entityId] = attributes.reduce((obj, attr) => {
          obj[attr] = entityData[attr];
          return obj;
        }, {} as any);
      }
    });
  });

  const result: Record<string, any[]> = {};
  Object.entries(metadata).forEach(([entityType, entities]) => {
    result[entityType] = Object.values(entities);
  });

  return result;
};

/**
 * Group time series data by dimension
 * @param data - Raw data array
 * @param dateField - Field containing dates
 * @param dimensionField - Field to group by
 * @param metricFields - Fields to aggregate
 * @returns Grouped time series data
 */
export const groupTimeSeriesByDimension = (
  data: any[],
  dateField: string,
  dimensionField: string,
  metricFields: string[],
): any[] => {
  const dateGroups: Record<string, Record<string, any>> = {};

  data.forEach((item) => {
    const date = item[dateField];
    const dimensionValue = getDimensionValue(item, dimensionField);

    if (!dateGroups[date]) {
      dateGroups[date] = {};
    }

    if (!dateGroups[date][dimensionValue]) {
      dateGroups[date][dimensionValue] = metricFields.reduce((obj, field) => {
        obj[field] = 0;
        return obj;
      }, {} as any);
    }

    metricFields.forEach((field) => {
      dateGroups[date][dimensionValue][field] += parseNumericValue(item[field]);
    });
  });

  return Object.entries(dateGroups)
    .map(([date, dimensions]) => ({
      date,
      dimensions: Object.entries(dimensions).map(([dimValue, metrics]) => ({
        dimension: dimValue,
        ...metrics,
      })),
    }))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
};

/**
 * Get dimension value from a data item, handling nested fields
 * @param item - Data item
 * @param dimensionField - Dimension field path
 * @returns Dimension value
 */
export const getDimensionValue = (item: any, dimensionField: string): any => {
  if (dimensionField.includes('.')) {
    const parts = dimensionField.split('.');
    let value = item;
    for (const part of parts) {
      value = value?.[part];
    }
    return value;
  }
  return item[dimensionField];
};
