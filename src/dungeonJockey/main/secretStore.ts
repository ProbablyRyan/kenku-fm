import path from "path";
import { app, safeStorage } from "electron";
import { createProtectedSecretStore } from "../adapters/secrets/protectedSecretStore";
import { createSessionSecretStore, createUnavailableSecretStore } from "../adapters/secrets/sessionSecretStore";
import { SecretStorePort } from "../ports/SecretStorePort";

let applicationStore: SecretStorePort | undefined;
let selectedRoot: string | undefined;

/** Application-global main capability; startup wiring is deferred until a consumer
 * exists. The caller supplies configureApplicationProfile().userDataPath. Changing
 * profiles requires a new process, so two stores cannot race on the same records.
 */
export function getApplicationSecretStore(profileRoot: string): SecretStorePort {
  if (process.type !== "browser") throw new Error("Secret storage requires the main process");
  if (!path.isAbsolute(profileRoot)) throw new Error("Secret storage requires an absolute profile root");
  const root = path.resolve(profileRoot);
  if (applicationStore) {
    if (root !== selectedRoot) throw new Error("Secret storage profile is already selected");
    return applicationStore;
  }
  selectedRoot = root;
  if (process.platform === "linux") {
    applicationStore = createSessionSecretStore();
  } else if (process.platform === "win32" || process.platform === "darwin") {
    applicationStore = createProtectedSecretStore(root, {
      async isAsyncEncryptionAvailable() {
        await app.whenReady();
        return safeStorage.isAsyncEncryptionAvailable();
      },
      encryptStringAsync: (secret) => safeStorage.encryptStringAsync(secret),
      decryptStringAsync: (ciphertext) => safeStorage.decryptStringAsync(ciphertext),
    });
  } else {
    applicationStore = createUnavailableSecretStore();
  }
  return applicationStore;
}
