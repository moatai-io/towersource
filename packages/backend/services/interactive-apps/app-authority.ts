// Experimental authority core. Not an HTTP endpoint or an engine tool.
export interface AppPrincipal { userId: string; projectId: string; sessionId: string }
interface Instance { principal: AppPrincipal; readTools: Set<string>; revoked: boolean }
export class AppAuthority {
  private instances = new Map<string, Instance>();
  constructor(private readonly canAccess: (principal: AppPrincipal) => Promise<boolean>) {}
  async register(id: string, principal: AppPrincipal, requested: string[], allowed: string[]) {
    if (!id || this.instances.has(id)) throw new Error('invalid_instance');
    if (!await this.canAccess(principal)) throw new Error('access_denied');
    // Recheck after asynchronous policy lookup: no stale duplicate overwrites.
    if (this.instances.has(id)) throw new Error('invalid_instance');
    const readTools = new Set(requested.filter(tool => allowed.includes(tool)));
    this.instances.set(id, { principal: { ...principal }, readTools, revoked: false });
    return [...readTools];
  }
  revoke(id: string) { const instance = this.instances.get(id); if (instance) instance.revoked = true; }
  private async authorize(id: string, principal: AppPrincipal, tool: string) {
    const instance = this.instances.get(id);
    if (!instance || instance.revoked || !['userId','projectId','sessionId'].every(key => instance.principal[key as keyof AppPrincipal] === principal[key as keyof AppPrincipal])) throw new Error('access_denied');
    if (!instance.readTools.has(tool)) throw new Error('capability_denied');
    if (!await this.canAccess(principal) || instance.revoked) throw new Error('access_denied');
  }
  async callRead<T>(id: string, principal: AppPrincipal, tool: string, execute: () => Promise<T>): Promise<T> {
    await this.authorize(id, principal, tool);
    const result = await execute();
    // Revocation while a tool runs must prevent result disclosure.
    await this.authorize(id, principal, tool);
    return result;
  }
}
