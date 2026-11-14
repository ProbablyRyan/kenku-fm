import { CredentialId } from "../../domain/ids/CredentialId";
import { SecretStorePort } from "../../ports/SecretStorePort";
import { createSerializedSecretStore } from "./serializedSecretStore";

/** One instance for the main process lifetime. No provider or filesystem access. */
export function createSessionSecretStore(): SecretStorePort {
  const secrets = new Map<CredentialId, string>();
  return createSerializedSecretStore({
    persistence: "session-only",
    has: async (id) => secrets.has(id),
    read: async (id) => secrets.get(id),
    write: async (id, secret) => { secrets.set(id, secret); },
    remove: async (id) => { secrets.delete(id); },
  });
}

export function createUnavailableSecretStore(): SecretStorePort {
  const unavailable = async (): Promise<never> => { throw new Error("Secret storage unavailable"); };
  return createSerializedSecretStore({
    persistence: "unsupported",
    has: unavailable,
    read: unavailable,
    write: unavailable,
    remove: unavailable,
  });
}
