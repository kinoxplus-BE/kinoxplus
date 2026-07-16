import { applyDecorators, type Type } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';

/**
 * Documents a success response in the standard envelope produced by
 * TransformInterceptor — `{ success, data, meta }` — with `data` typed by the
 * given model. Pass an array of models for endpoints whose payload varies
 * (rendered as oneOf).
 */
export function ApiEnvelope(
  model: Type<unknown> | Type<unknown>[],
  options: { status?: number; description?: string } = {},
): MethodDecorator & ClassDecorator {
  const models = Array.isArray(model) ? model : [model];
  const dataSchema =
    models.length === 1
      ? { $ref: getSchemaPath(models[0]) }
      : { oneOf: models.map((m) => ({ $ref: getSchemaPath(m) })) };

  return applyDecorators(
    ApiExtraModels(...models),
    ApiResponse({
      status: options.status ?? 200,
      description: options.description,
      schema: {
        type: 'object',
        required: ['success', 'data', 'meta'],
        properties: {
          success: { type: 'boolean', example: true },
          data: dataSchema,
          meta: {
            type: 'object',
            additionalProperties: true,
            example: {},
            description: 'Pagination cursors etc.; empty for most endpoints',
          },
        },
      },
    }),
  );
}
