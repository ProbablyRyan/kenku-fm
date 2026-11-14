import { CredentialId } from "../domain/ids/CredentialId";

export type SecretPersistence = "remembered" | "session-only" | "unsupported";
export type SecretFailureCode =
  | "INVALID_CREDENTIAL_ID"
  | "INVALID_SECRET"
  | "CREDENTIAL_MISSING"
  | "SECRET_UNAVAILABLE"
  | "CONSUMER_FAILED";

export type SecretFailure = Readonly<{ ok: false; code: SecretFailureCode }>;
export type SecretOperationResult =
  | Readonly<{ ok: true; persistence: SecretPersistence }>
  | SecretFailure;
export type StoreSecretResult =
  | Readonly<{ ok: true; id: CredentialId; persistence: SecretPersistence }>
  | SecretFailure;
export type SecretStatus = Readonly<{
  state: "missing" | "available" | "unavailable";
  persistence: SecretPersistence;
  code?: SecretFailureCode;
}>;

/** Main-process capability. Never expose this interface or its consumer over IPC.
 * Only the authorized main adapter receives plaintext. Its return value is discarded;
 * it must not log, publish, or retain secrets beyond its required use.
 */
export interface SecretStorePort {
  store(secret: string): Promise<StoreSecretResult>;
  replace(id: CredentialId, secret: string): Promise<SecretOperationResult>;
  forget(id: CredentialId): Promise<SecretOperationResult>;
  status(id: CredentialId): Promise<SecretStatus>;
  use(
    id: CredentialId,
    consumer: (secret: string) => void | Promise<void>,
  ): Promise<SecretOperationResult>;
}
