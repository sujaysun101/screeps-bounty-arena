const DEFAULT_INVALID_URL = "invalid SCREEPS_SERVER_URL";
const URL_PLACEHOLDER = "redacted";
const TEXT_PLACEHOLDER = "[redacted]";
const SENSITIVE_KEYS = [
  "token",
  "_token",
  "access_token",
  "auth_token",
  "password",
  "pass",
  "pwd",
  "user",
  "username",
];

export function stripUrlUserInfo(value, { invalidValue = DEFAULT_INVALID_URL } = {}) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    return trimUrl(url.toString());
  } catch {
    return invalidValue;
  }
}

export function buildMaskedReportUrl(value, { invalidValue = DEFAULT_INVALID_URL } = {}) {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = URL_PLACEHOLDER;
      url.password = url.password ? URL_PLACEHOLDER : "";
    }
    return trimUrl(url.toString());
  } catch {
    return invalidValue;
  }
}

export function collectSecrets(env) {
  const values = [env.SCREEPS_TOKEN, env.SCREEPS_USERNAME, env.SCREEPS_PASSWORD];

  if (env.SCREEPS_SERVER_URL) {
    try {
      const url = new URL(env.SCREEPS_SERVER_URL);
      if (url.username) {
        values.push(url.username, safeDecodeURIComponent(url.username));
      }
      if (url.password) {
        values.push(url.password, safeDecodeURIComponent(url.password));
      }
      for (const [name, value] of url.searchParams) {
        if (isSensitiveKey(name)) {
          values.push(value);
        }
      }
    } catch {
      // Invalid URLs are represented generically in user-facing output.
    }
  }

  return [...new Set(values.map((value) => String(value || "")).filter(Boolean))];
}

export function redactPrivateServerText(
  value,
  env,
  { redactKnownTokenPatterns = false } = {},
) {
  let output = String(value || "");

  if (env.SCREEPS_SERVER_URL) {
    output = output.split(env.SCREEPS_SERVER_URL).join(buildMaskedReportUrl(env.SCREEPS_SERVER_URL));
  }

  if (redactKnownTokenPatterns) {
    output = redactKnownPatterns(output);
  }

  for (const secret of collectSecrets(env)) {
    output = replaceSecret(output, secret);
  }

  return output;
}

function redactKnownPatterns(value) {
  let output = value;
  const keyPattern = SENSITIVE_KEYS.join("|");

  output = output.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+)(?::([^/\s@]*))?@/gi,
    (_, protocol, username, password) =>
      `${protocol}${username ? URL_PLACEHOLDER : ""}${password !== undefined ? `:${URL_PLACEHOLDER}` : ""}@`,
  );

  output = output.replace(
    new RegExp(`([?&](?:${keyPattern})=)([^&#\\s]+)`, "gi"),
    `$1${TEXT_PLACEHOLDER}`,
  );

  output = output.replace(
    new RegExp(`((?:^|[\\s{,(\\[])[\\"']?(?:${keyPattern})[\\"']?\\s*[:=]\\s*[\\"']?)([^\\s\\"',}\\]]+)`, "gim"),
    (_, prefix) => `${prefix}${TEXT_PLACEHOLDER}`,
  );

  output = output.replace(/(authorization\s*:\s*bearer\s+)([^\s]+)/gi, `$1${TEXT_PLACEHOLDER}`);

  return output;
}

function replaceSecret(value, secret) {
  if (/^[A-Za-z0-9._~-]+$/.test(secret)) {
    return value.replace(
      new RegExp(`(?<![A-Za-z0-9._~-])${escapeRegExp(secret)}(?![A-Za-z0-9._~-])`, "g"),
      TEXT_PLACEHOLDER,
    );
  }

  return value.split(secret).join(TEXT_PLACEHOLDER);
}

function isSensitiveKey(value) {
  return SENSITIVE_KEYS.some((key) => key.toLowerCase() === String(value || "").toLowerCase());
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimUrl(value) {
  return value.replace(/\/$/, "");
}
