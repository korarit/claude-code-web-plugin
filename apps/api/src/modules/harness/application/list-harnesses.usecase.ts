import type { HarnessDescriptor } from "@contracts/harness";
import type { AppError } from "@core/errors";
import { ok, type Result } from "@core/result";
import type { HarnessRegistry } from "./harness-registry.ts";

export class ListHarnessesUsecase {
  constructor(private readonly registry: HarnessRegistry) {}

  async execute(): Promise<Result<HarnessDescriptor[], AppError>> {
    const descriptors = await this.registry.getDescriptors();
    return ok(descriptors);
  }
}
