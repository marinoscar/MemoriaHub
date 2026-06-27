import { AiToolDef } from '../../ai/providers/ai-provider.interface';
import { SEARCHABLE_FIELDS } from '../searchable-fields.registry';

type JsonSchemaProperty =
  | { type: 'string'; description: string; enum?: string[] }
  | { type: 'boolean'; description: string }
  | {
      type: 'object';
      description: string;
      properties: Record<string, { type: string; description: string }>;
    }
  | {
      type: 'array';
      description: string;
      items: { type: 'string' };
    };

/**
 * Build the `search_media` tool definition from the SEARCHABLE_FIELDS registry.
 *
 * Each field type maps to a JSON Schema property:
 *   - 'string'     → { type: 'string' }
 *   - 'enum'       → { type: 'string', enum: field.enumValues }
 *   - 'boolean'    → { type: 'boolean' }
 *   - 'date-range' → { type: 'object', properties: { from, to } }
 *   - 'geo'        → { type: 'string' }
 *   - 'person-set' → two sibling params: `people` (array of names) + `peopleMatch` (enum)
 *
 * The 'person-set' type is handled specially: instead of a generic property for the field key,
 * it emits two separate tool parameters (`people` and `peopleMatch`) so the AI can pass
 * human-readable names. The agent service resolves names to IDs before executing the search.
 *
 * Adding a new SearchableField to the registry automatically extends this tool schema.
 */
export function buildSearchMediaToolDef(): AiToolDef {
  const properties: Record<string, JsonSchemaProperty> = {};

  for (const field of SEARCHABLE_FIELDS) {
    switch (field.type) {
      case 'person-set':
        // Emit two parameters instead of a generic one for the field key.
        // The agent service resolves person names → IDs before calling runSearch.
        properties['people'] = {
          type: 'array',
          items: { type: 'string' },
          description:
            'Names of people who must appear in the photo, e.g. ["Oscar","Pamela"]. ' +
            'The search will resolve names to IDs automatically.',
        };
        properties['peopleMatch'] = {
          type: 'string',
          enum: ['all', 'any'],
          description:
            'all = every named person must appear together in the photo; ' +
            'any = at least one of the named people appears. Default: all.',
        };
        break;

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

      case 'geo-radius':
        properties[field.key] = {
          type: 'object',
          description: field.description,
          properties: {
            lat: { type: 'number', description: 'Latitude in decimal degrees (-90 to 90)' },
            lng: { type: 'number', description: 'Longitude in decimal degrees (-180 to 180)' },
            radiusKm: { type: 'number', description: 'Search radius in kilometres (max 20 000)' },
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

  // semanticQuery is a special-case parameter outside the registry loop (like people/peopleMatch).
  // It is NOT in SEARCHABLE_FIELDS because it is not a WHERE-clause filter;
  // it drives the KNN path in SearchService.runSearch separately.
  properties['semanticQuery'] = {
    type: 'string',
    description:
      'Natural-language description of photo content to find semantically similar photos ' +
      '(e.g. "kids playing on the beach at sunset"). ' +
      'Can be combined with structured filters. ' +
      'Use this for content/scene descriptions; use structured filters for dates, places, people, and tags.',
  };

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
