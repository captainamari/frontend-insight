import type { ContractValidationResult, ValidationOptions } from "./validator.js";
import { validateTransportBatch } from "./validator.js";

export function validateForProducer(
  input: unknown,
  options?: ValidationOptions,
): ContractValidationResult {
  return validateTransportBatch(input, options);
}

export function validateForIngestion(
  input: unknown,
  options?: ValidationOptions,
): ContractValidationResult {
  return validateTransportBatch(input, options);
}

export function validateForConsumer(
  input: unknown,
  options?: ValidationOptions,
): ContractValidationResult {
  return validateTransportBatch(input, options);
}
