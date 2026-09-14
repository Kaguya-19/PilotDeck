import type { PermissionRule, PermissionRuleSet } from "../../permission/index.js";

export type GatewaySessionPermissionRuleSetLease = {
  /** The exact mutable rule arrays shared by one live session generation. */
  readonly rules: PermissionRuleSet;
  /** Releases this handle's retain without affecting an overlapping recreate. */
  release(): void;
};

/** Narrow Gateway consumer port for live, session-scoped permission grants. */
export type GatewaySessionPermissionGrantPort = {
  grant(sessionKey: string, rule: PermissionRule): boolean;
  allowRules(sessionKey: string): readonly PermissionRule[];
  closeSession(sessionKey: string): void;
  dispose(): void;
};

type Entry = {
  rules: PermissionRuleSet;
  retains: number;
  /** A Gateway RPC may grant before an AgentHandle has been created. */
  grantPinned: boolean;
};

/**
 * Owns fallback permission-rule arrays for live Gateway sessions.
 *
 * A gateway permission hook and PermissionContext must use the same array so
 * an allow-with-remember decision affects the following tool call. During a
 * dirty recreate the old and replacement handles briefly coexist, therefore
 * each handle acquires an exact retain on the same entry. The final release
 * removes fallback state instead of leaving a session-key map resident for
 * the process lifetime.
 */
export class GatewaySessionPermissionRuleSetRegistry implements GatewaySessionPermissionGrantPort {
  private readonly entries = new Map<string, Entry>();

  get size(): number {
    return this.entries.size;
  }

  acquire(
    sessionKey: string,
    configured?: Partial<PermissionRuleSet>,
  ): GatewaySessionPermissionRuleSetLease {
    const entry = this.ensure(sessionKey, configured);
    entry.retains += 1;

    let released = false;
    const retainedEntry = entry;
    return {
      rules: retainedEntry.rules,
      release: () => {
        if (released) return;
        released = true;
        retainedEntry.retains -= 1;
        this.deleteIfUnused(sessionKey, retainedEntry);
      },
    };
  }

  grant(sessionKey: string, rule: PermissionRule): boolean {
    const entry = this.ensure(sessionKey);
    entry.grantPinned = true;
    if (entry.rules.allow.some((existing) => sameRule(existing, rule))) return false;
    entry.rules.allow.push(rule);
    return true;
  }

  allowRules(sessionKey: string): readonly PermissionRule[] {
    return this.entries.get(sessionKey)?.rules.allow ?? [];
  }

  closeSession(sessionKey: string): void {
    const entry = this.entries.get(sessionKey);
    if (!entry) return;
    entry.grantPinned = false;
    this.deleteIfUnused(sessionKey, entry);
  }

  dispose(): void {
    this.entries.clear();
  }

  private ensure(sessionKey: string, configured?: Partial<PermissionRuleSet>): Entry {
    let entry = this.entries.get(sessionKey);
    if (!entry) {
      entry = {
        rules: {
          allow: configured?.allow ?? [],
          deny: configured?.deny ?? [],
          ask: configured?.ask ?? [],
        },
        retains: 0,
        grantPinned: false,
      };
      this.entries.set(sessionKey, entry);
      return entry;
    }

    // A grant may arrive before the first AgentHandle. Preserve it while
    // folding the later session override into the same live rule arrays.
    mergeRules(entry.rules.allow, configured?.allow);
    mergeRules(entry.rules.deny, configured?.deny);
    mergeRules(entry.rules.ask, configured?.ask);
    return entry;
  }

  private deleteIfUnused(sessionKey: string, entry: Entry): void {
    if (entry.retains !== 0 || entry.grantPinned) return;
    if (this.entries.get(sessionKey) === entry) this.entries.delete(sessionKey);
  }
}

function mergeRules(target: PermissionRule[], incoming: readonly PermissionRule[] | undefined): void {
  if (!incoming) return;
  for (const rule of incoming) {
    if (!target.some((existing) => sameRule(existing, rule))) target.push(rule);
  }
}

function sameRule(left: PermissionRule, right: PermissionRule): boolean {
  return left.source === right.source
    && left.behavior === right.behavior
    && left.toolName === right.toolName
    && left.pattern === right.pattern;
}
