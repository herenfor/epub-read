import {
  AI_CAPABILITIES,
  getCapability,
  supportsCapability,
  type AiCapability,
  type ProviderManifest,
} from "../contracts/capabilities";
import {
  capabilityMethodName,
  type CapabilityProvider,
  type ProviderForCapability,
  type ProviderRequestOptions,
} from "../contracts/provider";
import { ProviderRegistryError } from "./errors";

function validateManifest(manifest: ProviderManifest): void {
  if (!manifest.id.trim() || !manifest.version.trim() || !manifest.displayName.trim()) {
    throw new ProviderRegistryError("invalid-manifest", "Provider manifest requires id, version and displayName");
  }
  const seen = new Set<AiCapability>();
  for (const descriptor of manifest.capabilities) {
    if (seen.has(descriptor.capability)) {
      throw new ProviderRegistryError("invalid-manifest", `Provider ${manifest.id} declares ${descriptor.capability} twice`);
    }
    seen.add(descriptor.capability);
  }
}

function validateProvider(provider: CapabilityProvider): void {
  validateManifest(provider.manifest);
  for (const descriptor of provider.manifest.capabilities) {
    const method = capabilityMethodName(descriptor.capability);
    if (descriptor.availability === "available" && typeof provider[method] !== "function") {
      throw new ProviderRegistryError(
        "invalid-manifest",
        `Provider ${provider.manifest.id} advertises ${descriptor.capability} without ${method}()`,
      );
    }
  }
}

export interface ProviderRegistryEntry {
  readonly provider: CapabilityProvider;
  readonly manifest: ProviderManifest;
}

/** In-process registry for project-owned providers. It does not load arbitrary code. */
export class ProviderRegistry {
  private readonly providers = new Map<string, CapabilityProvider>();
  private closed = false;

  register(provider: CapabilityProvider): void {
    if (this.closed) throw new ProviderRegistryError("disposed", "Provider registry has been disposed");
    validateProvider(provider);
    if (this.providers.has(provider.manifest.id)) {
      throw new ProviderRegistryError("duplicate-provider", `Provider ${provider.manifest.id} is already registered`);
    }
    this.providers.set(provider.manifest.id, provider);
  }

  async unregister(providerId: string, options?: { dispose?: boolean }): Promise<boolean> {
    const provider = this.providers.get(providerId);
    if (!provider) return false;
    this.providers.delete(providerId);
    if (options?.dispose !== false) await provider.dispose();
    return true;
  }

  get(providerId: string): CapabilityProvider | undefined {
    return this.providers.get(providerId);
  }

  has(providerId: string): boolean {
    return this.providers.has(providerId);
  }

  list(): readonly ProviderRegistryEntry[] {
    return [...this.providers.values()].map((provider) => ({ provider, manifest: provider.manifest }));
  }

  listForCapability(capability: AiCapability): readonly ProviderRegistryEntry[] {
    return this.list().filter(({ manifest }) => supportsCapability(manifest, capability));
  }

  resolve<C extends AiCapability>(
    capability: C,
    preferredProviderId?: string,
  ): ProviderForCapability<C> | undefined {
    if (preferredProviderId) {
      const preferred = this.providers.get(preferredProviderId);
      if (preferred && supportsCapability(preferred.manifest, capability)) {
        return preferred as ProviderForCapability<C>;
      }
      return undefined;
    }
    const match = this.listForCapability(capability)[0]?.provider;
    return match as ProviderForCapability<C> | undefined;
  }

  resolveOrThrow<C extends AiCapability>(capability: C, preferredProviderId?: string): ProviderForCapability<C> {
    const provider = this.resolve(capability, preferredProviderId);
    if (provider) return provider;
    if (preferredProviderId && !this.providers.has(preferredProviderId)) {
      throw new ProviderRegistryError("not-found", `Provider ${preferredProviderId} is not registered`);
    }
    throw new ProviderRegistryError("unsupported-capability", `No provider supports ${capability}`);
  }

  async checkHealth(providerId: string, options?: ProviderRequestOptions) {
    const provider = this.providers.get(providerId);
    if (!provider) throw new ProviderRegistryError("not-found", `Provider ${providerId} is not registered`);
    return provider.checkHealth(options);
  }

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const providers = [...this.providers.values()];
    this.providers.clear();
    await Promise.all(providers.map((provider) => provider.dispose()));
  }

  get size(): number {
    return this.providers.size;
  }
}

export function createProviderRegistry(providers: readonly CapabilityProvider[] = []): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const provider of providers) registry.register(provider);
  return registry;
}

export { AI_CAPABILITIES, getCapability, ProviderRegistryError };
