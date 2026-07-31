const SECRET_ENV_KEYS = new Set([
  "KEYSTORE_PASSWORD",
  "APOW_KEYSTORE_PASSWORD",
  "PRIVATE_KEY",
]);

const SUBSCRIPTION_CLI_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "PATHEXT",
  "SystemRoot",
  "ComSpec",
  "WINDIR",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
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

function subscriptionCliEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (SUBSCRIPTION_CLI_ENV_KEYS.has(key)) {
      next[key] = value;
    }
  }
  return next;
}

export function claudeSubscriptionEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return subscriptionCliEnv(base);
}

export function codexSubscriptionEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return subscriptionCliEnv(base);
}
