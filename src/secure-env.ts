const SECRET_ENV_KEYS = new Set([
  "KEYSTORE_PASSWORD",
  "APOW_KEYSTORE_PASSWORD",
  "PRIVATE_KEY",
]);

export function childEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!SECRET_ENV_KEYS.has(key)) {
      next[key] = value;
    }
  }
  return next;
}

