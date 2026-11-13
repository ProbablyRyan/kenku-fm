import { APPLICATION_ENTRY } from "./applicationProtocol";

export interface ApplicationEntryPolicy {
  allows(url: string): boolean;
}

export function createApplicationEntryPolicy(
  entry: string,
  isPackaged: boolean,
): ApplicationEntryPolicy {
  const expected = new URL(entry);
  if (
    expected.username ||
    expected.password ||
    expected.hash ||
    (isPackaged
      ? entry !== APPLICATION_ENTRY
      : !["http:", "https:"].includes(expected.protocol))
  ) {
    throw new Error("Invalid application entry policy");
  }

  // Pin the owned document, not every document sharing its origin. Node's URL
  // parser reports a null origin for custom schemes, so protocol/host/path are
  // checked explicitly. Development also pins the exact active document.
  return Object.freeze({
    allows(url: string): boolean {
      try {
        const candidate = new URL(url);
        return (
          !candidate.username &&
          !candidate.password &&
          candidate.protocol === expected.protocol &&
          candidate.host === expected.host &&
          candidate.origin === expected.origin &&
          candidate.pathname === expected.pathname &&
          candidate.search === expected.search
        );
      } catch {
        return false;
      }
    },
  });
}

export function isExternalApplicationLink(url: string): boolean {
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
