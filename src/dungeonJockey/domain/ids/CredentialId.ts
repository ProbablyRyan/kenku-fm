import { UuidFactory } from "./UuidFactory";
import { isCanonicalUuid } from "./ids";

declare const credentialIdBrand: unique symbol;
export type CredentialId = string & { readonly [credentialIdBrand]: true };

export function isCredentialId(value: unknown): value is CredentialId {
  return isCanonicalUuid(value);
}

export function parseCredentialId(value: unknown): CredentialId {
  if (!isCredentialId(value)) {
    throw new Error("Credential ID must be a canonical UUID");
  }
  return value;
}

export function createCredentialId(factory: UuidFactory): CredentialId {
  return parseCredentialId(factory.createUuid());
}
