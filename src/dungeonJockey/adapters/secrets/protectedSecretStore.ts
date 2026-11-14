import { createHash, randomUUID } from "crypto";
import fs from "fs/promises";
import path from "path";
import { CredentialId } from "../../domain/ids/CredentialId";
import { SecretStorePort } from "../../ports/SecretStorePort";
import { createSerializedSecretStore } from "./serializedSecretStore";

export interface AsyncSecretProtection {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(secret: string): Promise<Buffer>;
  decryptStringAsync(ciphertext: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

function isAbsent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Main-only implementation. Construct through the application factory in production.
 * The root is the main-selected userData directory, never a renderer/project path.
 */
export function createProtectedSecretStore(
  profileRoot: string,
  protection: AsyncSecretProtection,
): SecretStorePort {
  if (!path.isAbsolute(profileRoot)) throw new Error("Secret storage requires an absolute profile root");
  const directory = path.join(profileRoot, "Protected Credentials");
  // IDs are validated by the port boundary and hashed into fixed-format basenames.
  const recordPath = (id: CredentialId) =>
    path.join(directory, `${createHash("sha256").update(id).digest("hex")}.json`);

  async function requireProtection(): Promise<void> {
    if (!(await protection.isAsyncEncryptionAvailable())) {
      throw new Error("Secret protection unavailable");
    }
  }

  async function write(id: CredentialId, secret: string): Promise<void> {
    await requireProtection();
    const ciphertext = await protection.encryptStringAsync(secret);
    if (!Buffer.isBuffer(ciphertext) || ciphertext.length === 0) {
      throw new Error("Invalid protected record");
    }
    const bytes = JSON.stringify({ version: 1, ciphertext: ciphertext.toString("base64") });
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    let created = false;
    let published = false;
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      created = true;
      try {
        await handle.writeFile(bytes, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Same-directory rename is the only publish path: never unlink the old file
      // or fall back to copying. Node/libuv uses replace-existing MoveFileExW on
      // Windows and rename on macOS. A sharing/permission failure leaves the old
      // file in place. Windows inherits the private profile's ACL; POSIX requests
      // 0700/0600. File sync precedes publish, but no power-loss durability or
      // secure-erasure guarantee is made (including Forget and temporary cleanup).
      await fs.rename(temporary, recordPath(id));
      published = true;
    } finally {
      if (created && !published) await fs.unlink(temporary);
    }
  }

  return createSerializedSecretStore({
    persistence: "remembered",
    async has(id) {
      try {
        const entry = await fs.lstat(recordPath(id));
        if (!entry.isFile()) throw new Error("Invalid protected record");
        return true;
      } catch (error) {
        if (isAbsent(error)) return false;
        throw error;
      }
    },
    async read(id) {
      try {
        // lstat distinguishes dangling links/non-files from genuine absence.
        const entry = await fs.lstat(recordPath(id));
        if (!entry.isFile()) throw new Error("Invalid protected record");
      } catch (error) {
        if (isAbsent(error)) return undefined;
        throw error;
      }
      // A read error after a record was observed is unavailable, never missing.
      const bytes = await fs.readFile(recordPath(id), "utf8");
      const record: unknown = JSON.parse(bytes);
      if (
        typeof record !== "object" || record === null ||
        !("version" in record) || record.version !== 1 ||
        !("ciphertext" in record) || typeof record.ciphertext !== "string" ||
        record.ciphertext.length === 0 ||
        Object.keys(record).length !== 2
      ) throw new Error("Invalid protected record");
      const ciphertext = Buffer.from(record.ciphertext, "base64");
      if (ciphertext.toString("base64") !== record.ciphertext) throw new Error("Invalid protected record");
      await requireProtection();
      const decrypted = await protection.decryptStringAsync(ciphertext);
      if (typeof decrypted.result !== "string" || decrypted.result.length === 0 ||
          typeof decrypted.shouldReEncrypt !== "boolean") throw new Error("Invalid protected value");
      if (decrypted.shouldReEncrypt) await write(id, decrypted.result);
      return decrypted.result;
    },
    write,
    async remove(id) {
      try {
        await fs.unlink(recordPath(id));
      } catch (error) {
        if (!isAbsent(error)) throw error;
      }
    },
  });
}
