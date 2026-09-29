/** One exact session's retain on an application-owned runtime resource. */
export type GatewaySessionResourceRelease = () => Promise<void>;

type ResourceLease = {
  name: string;
  release: GatewaySessionResourceRelease;
};

/**
 * Composition owner for the project-runtime leases acquired while building one
 * Agent session. It owns cleanup ordering only: MCP, plugin and project
 * runtime providers retain their existing state and lifecycle owners.
 */
export class GatewaySessionResourceLeaseBundle {
  private readonly leases: ResourceLease[] = [];
  private releasePromise?: Promise<void>;

  add(name: string, release: GatewaySessionResourceRelease): void {
    if (this.releasePromise) {
      throw new Error(`Cannot retain ${name}; Gateway session resources are releasing.`);
    }
    this.leases.push({ name, release });
  }

  release(): Promise<void> {
    if (this.releasePromise) return this.releasePromise;
    this.releasePromise = this.releaseAll();
    return this.releasePromise;
  }

  private async releaseAll(): Promise<void> {
    const failures: unknown[] = [];
    for (const lease of [...this.leases].reverse()) {
      try {
        await lease.release();
      } catch (error) {
        failures.push(new Error(`Failed to release ${lease.name}.`, { cause: error }));
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Failed to release Gateway session resources.");
    }
  }
}
