import { CredentialId, createCredentialId, isCredentialId } from "../../domain/ids/CredentialId";
import {
  SecretFailure,
  SecretFailureCode,
  SecretOperationResult,
  SecretPersistence,
  SecretStatus,
  SecretStorePort,
  StoreSecretResult,
} from "../../ports/SecretStorePort";
import { nodeUuidFactory } from "../node/nodeUuidFactory";

/** Internal, main-only storage mechanics; plaintext never leaves the use path. */
export interface SecretRecords {
  readonly persistence: SecretPersistence;
  has(id: CredentialId): Promise<boolean>;
  read(id: CredentialId): Promise<string | undefined>;
  write(id: CredentialId, secret: string): Promise<void>;
  remove(id: CredentialId): Promise<void>;
}

const failure = (code: SecretFailureCode): SecretFailure => ({ ok: false, code });
const validSecret = (secret: unknown): secret is string =>
  typeof secret === "string" && secret.length > 0;

export function createSerializedSecretStore(records: SecretRecords): SecretStorePort {
  // One queue also orders reads that can rotate keys against replace/forget.
  // The application factory shares this instance for the selected profile.
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(() => {}, () => {});
    return result;
  }
  const success = (): SecretOperationResult => ({ ok: true, persistence: records.persistence });

  return {
    async store(secret): Promise<StoreSecretResult> {
      if (!validSecret(secret)) return failure("INVALID_SECRET");
      try {
        return await serial(async () => {
          const id = createCredentialId(nodeUuidFactory);
          // Never replace an existing record, even on an unexpected UUID collision.
          if (await records.has(id)) return failure("SECRET_UNAVAILABLE");
          await records.write(id, secret);
          return { ok: true, id, persistence: records.persistence };
        });
      } catch {
        return failure("SECRET_UNAVAILABLE");
      }
    },
    async replace(id, secret) {
      if (!isCredentialId(id)) return failure("INVALID_CREDENTIAL_ID");
      if (!validSecret(secret)) return failure("INVALID_SECRET");
      try {
        return await serial(async () => {
          if (!(await records.has(id))) return failure("CREDENTIAL_MISSING");
          // Deliberate replacement needs no successful decryption of the old value.
          await records.write(id, secret);
          return success();
        });
      } catch {
        return failure("SECRET_UNAVAILABLE");
      }
    },
    async forget(id) {
      if (!isCredentialId(id)) return failure("INVALID_CREDENTIAL_ID");
      try {
        return await serial(async () => {
          await records.remove(id);
          return success();
        });
      } catch {
        return failure("SECRET_UNAVAILABLE");
      }
    },
    async status(id): Promise<SecretStatus> {
      const persistence = records.persistence;
      if (!isCredentialId(id)) {
        return { state: "unavailable", persistence, code: "INVALID_CREDENTIAL_ID" };
      }
      try {
        return await serial(async () => ({
          state: (await records.read(id)) === undefined ? "missing" : "available",
          persistence,
        }));
      } catch {
        return { state: "unavailable", persistence, code: "SECRET_UNAVAILABLE" };
      }
    },
    async use(id, consumer) {
      if (!isCredentialId(id)) return failure("INVALID_CREDENTIAL_ID");
      let secret: string | undefined;
      try {
        secret = await serial(() => records.read(id));
      } catch {
        return failure("SECRET_UNAVAILABLE");
      }
      if (secret === undefined) return failure("CREDENTIAL_MISSING");
      try {
        // Rotation has committed before dispatch. Release the queue so a consumer
        // can replace/forget without deadlocking; an already-started use may finish.
        await consumer(secret);
        return success();
      } catch {
        // Native, filesystem and consumer errors are never retained as causes.
        return failure("CONSUMER_FAILED");
      } finally {
        secret = undefined;
      }
    },
  };
}
