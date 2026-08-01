import { PipeTransform, Injectable, ArgumentMetadata } from '@nestjs/common';
import type { ZodTypeAny } from 'zod';

/** Validates and NARROWS - the controller receives the parsed value, not the raw body. */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodTypeAny) {}
  transform(value: unknown, _metadata: ArgumentMetadata) {
    return this.schema.parse(value);   // ZodError is caught by DomainExceptionFilter
  }
}
