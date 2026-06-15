import { AiToolDef } from '../../ai/providers/ai-provider.interface';
import { SEARCHABLE_FIELDS } from '../searchable-fields.registry';

type JsonSchemaProperty =
  | { type: 'string'; description: string; enum?: string[] }
  | { type: 'boolean'; description: string }
  | {
      type: 'object';
      description: string;
      properties: {
        from: { type: 'string'; description: string };
        to: { type: 'string'; description: string };
      };
    };

/**
 * Build the `search_media` tool definition from the SEARCHABLE_FIELDS registry.
 *
 * Each field type maps to a JSON Schema property:
 *   - 'string' → { type: 'string' }
 *   - 'enum'   → { type: 'string', enum: field.enumValues }
 *   - 'boolean'→ { type: 'boolean' }
 *   - 'date-range' → { type: 'object', properties: { from, to } }
 *   - 'geo'    → { type: 'string' }
 *
 * Adding a new SearchableField to the registry automatically extends this tool schema.
 */
export function buildSearchMediaToolDef(): AiToolDef {
  const properties: Record<string, JsonSchemaProperty> = {};

  for (const field of SEARCHABLE_FIELDS) {
    switch (field.type) {
      case 'enum':
        properties[field.key] = {
          type: 'string',
          description: field.description,
          ...(field.enumValues ? { enum: field.enumValues } : {}),
        };
        break;

      case 'boolean':
        properties[field.key] = {
          type: 'boolean',
          description: field.description,
        };
        break;

      case 'date-range':
        properties[field.key] = {
          type: 'object',
          description: field.description,
          properties: {
            from: { type: 'string', description: 'ISO 8601 date-time' },
            to: { type: 'string', description: 'ISO 8601 date-time' },
          },
        };
        break;

      case 'geo':
      case 'string':
      default:
        properties[field.key] = {
          type: 'string',
          description: field.description,
        };
        break;
    }
  }

  return {
    name: 'search_media',
    description:
      'Search media items within the current circle using structured filters. ' +
      'Apply as many filters as relevant based on the user request. ' +
      'circleId is always fixed to the current conversation context — do NOT pass it. ' +
      'All filters are optional; omit them to return unfiltered results.',
    inputSchema: {
      type: 'object',
      properties,
      required: [],
    },
  };
}
