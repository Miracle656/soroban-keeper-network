/**
 * Secret Management Utilities
 *
 * Supports loading signing keys from multiple backends (environment variable, HashiCorp Vault,
 * AWS Secrets Manager) while maintaining strict redaction discipline for all sensitive data.
 *
 * Following the secret-hygiene discipline established by v1's requireEnv (examples/keeper-bot/index.js),
 * this ensures:
 * - Consistent redaction across all inspection output
 * - Safe-by-default patterns for marking fields as sensitive
 * - Prevention of accidental secret disclosure in error messages and logs
 */

/**
 * List of configuration keys that should always be redacted from output.
 * Any configuration values with these keys will have their content replaced
 * with a placeholder.
 */
const SENSITIVE_KEYS = new Set([
  'secretKey',
  'secret_key',
  'KEEPER_SECRET_KEY',
  'keeperSecretKey',
  'signingKey',
  'signing_key',
  'SIGNING_KEY',
  'signingKeys',
  'SIGNING_KEYS',
  'privateKey',
  'private_key',
  'PRIVATE_KEY',
  'token',
  'TOKEN',
  'apiKey',
  'API_KEY',
  'api_key',
  'password',
  'PASSWORD',
  'credential',
  'CREDENTIAL',
  'credentials',
  'CREDENTIALS',
  'secret',
  'SECRET',
  'authToken',
  'AUTH_TOKEN',
  'auth_token',
  'bearerToken',
  'BEARER_TOKEN',
  'bearer_token',
  'accessToken',
  'ACCESS_TOKEN',
  'access_token',
  'vaultToken',
  'VAULT_TOKEN',
  'vault_token',
]);

const REDACTED_PLACEHOLDER = '***REDACTED***';

/**
 * Supported secret backends.
 *
 * - env: Read from KEEPER_SECRET_KEY or SIGNING_KEY_POOL environment variables (default, suitable for local dev)
 * - vault: Fetch from HashiCorp Vault via authenticated API (production)
 * - aws_secrets_manager: Fetch from AWS Secrets Manager (production AWS deployments)
 */
export type SecretBackend = 'env' | 'vault' | 'aws_secrets_manager';

/**
 * Result of loading secrets from a backend.
 */
export interface LoadedSecrets {
  /**
   * The signing key(s) loaded from the backend.
   * For single-account usage, this is typically a single 56-character Stellar secret key (S...).
   * For multi-account usage, this is a comma-separated list of keys.
   */
  signingKeys: string;

  /**
   * Optional: The backend that was used to load these secrets.
   * Used for logging and inspection only.
   */
  backend?: SecretBackend;
}

/**
 * Base class for secret loading errors, ensuring all error messages
 * are safe to log and never contain actual secret material.
 */
export class SecretLoadingError extends Error {
  constructor(
    message: string,
    public readonly backend: SecretBackend,
  ) {
    super(`Failed to load secrets from ${backend}: ${message}`);
    this.name = 'SecretLoadingError';
  }
}

/**
 * Configuration required for the environment variable backend.
 */
export interface EnvBackendConfig {
  backend: 'env';
}

/**
 * Configuration required for the Vault backend.
 */
export interface VaultBackendConfig {
  backend: 'vault';
  vaultAddr: string; // URL to Vault, e.g., http://vault:8200
  vaultToken?: string; // Optional: if not provided, reads from VAULT_TOKEN env var
  vaultPath?: string; // Optional: path to secret, defaults to secret/data/keeper-bot/signing-keys
}

/**
 * Configuration required for the AWS Secrets Manager backend.
 */
export interface AwsSecretsManagerBackendConfig {
  backend: 'aws_secrets_manager';
  awsSecretName: string; // ARN or name of the secret, e.g., keeper-bot/signing-keys
  awsRegion?: string; // Optional: AWS region, defaults to AWS_REGION env var
}

/**
 * Union of all supported backend configurations.
 */
export type SecretBackendConfig = EnvBackendConfig | VaultBackendConfig | AwsSecretsManagerBackendConfig;

/**
 * Check if a configuration key should be redacted.
 *
 * @param key - The configuration key name
 * @returns true if the key represents sensitive information that should be redacted
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key);
}

/**
 * Recursively redact sensitive values in a configuration object.
 *
 * This function walks the entire object tree and replaces values
 * for any key marked as sensitive with the REDACTED_PLACEHOLDER.
 *
 * @param config - The configuration object to redact
 * @returns A new object with sensitive values replaced
 */
export function redactConfig(config: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(config)) {
    if (isSensitiveKey(key)) {
      redacted[key] = REDACTED_PLACEHOLDER;
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // Recursively redact nested objects
      redacted[key] = redactConfig(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      // Redact arrays of objects
      redacted[key] = value.map((item) =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? redactConfig(item as Record<string, unknown>)
          : item,
      );
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

/**
 * Check if a string value appears to be a secret (used for heuristic detection).
 *
 * This catches values that look like secrets based on format:
 * - Stellar secret keys (start with S)
 * - Hex strings longer than a typical threshold
 * - Base64-encoded values
 *
 * @param value - The value to check
 * @returns true if the value appears to be a secret
 */
export function appearsToBeSensitive(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }

  // Stellar secret key format (Ed25519)
  if (value.startsWith('S') && value.length === 56) {
    return true;
  }

  // Very long hex strings (potential private keys)
  if (/^[0-9a-fA-F]{64,}$/.test(value)) {
    return true;
  }

  // Very long base64-looking strings
  if (/^[A-Za-z0-9+/]{80,}={0,2}$/.test(value)) {
    return true;
  }

  return false;
}

/**
 * Safely log a configuration value, redacting if it appears sensitive.
 *
 * This is a defensive helper for logging that applies heuristic redaction
 * to catch secrets that might have been logged with the wrong key name.
 *
 * @param key - The configuration key
 * @param value - The value to log
 * @returns A safe-to-log representation of the value
 */
export function safeLogValue(key: string, value: unknown): unknown {
  if (isSensitiveKey(key) || appearsToBeSensitive(value)) {
    return REDACTED_PLACEHOLDER;
  }
  return value;
}

/**
 * Create a redacted copy of a configuration object suitable for inspection output.
 *
 * This is the primary public API for configuration redaction. It ensures
 * that configuration dumps never leak secrets while remaining useful for
 * debugging.
 *
 * @param config - The configuration object to redact
 * @returns A new object safe to return to operators
 */
export function createRedactedConfigDump(
  config: Record<string, unknown>,
): Record<string, unknown> {
  return redactConfig(config);
}

// ============================================================================
// SECRET BACKEND LOADERS
// ============================================================================

/**
 * Load secrets from environment variables.
 *
 * This is the default backend, suitable for local development.
 * Reads from KEEPER_SECRET_KEY (single key) or SIGNING_KEY_POOL (comma-separated keys).
 *
 * @param config - Configuration (unused, provided for interface consistency)
 * @returns Loaded secrets from environment variables
 * @throws SecretLoadingError if neither key is set
 */
export async function loadSecretsFromEnv(config: EnvBackendConfig): Promise<LoadedSecrets> {
  const keeperSecretKey = process.env.KEEPER_SECRET_KEY;
  const signingKeyPool = process.env.SIGNING_KEY_POOL;

  if (!keeperSecretKey && !signingKeyPool) {
    throw new SecretLoadingError(
      'KEEPER_SECRET_KEY or SIGNING_KEY_POOL must be set',
      'env',
    );
  }

  // Prefer SIGNING_KEY_POOL if both are set (multi-account mode)
  const signingKeys = signingKeyPool || keeperSecretKey;

  if (!signingKeys || signingKeys.trim() === '') {
    throw new SecretLoadingError(
      'Signing keys are empty',
      'env',
    );
  }

  return {
    signingKeys: signingKeys.trim(),
    backend: 'env',
  };
}

/**
 * Load secrets from HashiCorp Vault.
 *
 * Expected secret format in Vault:
 * ```
 * {
 *   "keys": "S...,S...,S..."
 * }
 * ```
 *
 * @param config - Vault configuration
 * @returns Loaded secrets from Vault
 * @throws SecretLoadingError if Vault is unreachable or secret is missing
 */
export async function loadSecretsFromVault(config: VaultBackendConfig): Promise<LoadedSecrets> {
  // Dynamically import node-fetch to avoid requiring it as a dependency
  // if not using Vault backend
  let fetch: typeof globalThis.fetch;
  try {
    // Try to use the global fetch if available (Node 18+)
    fetch = globalThis.fetch;
  } catch {
    throw new SecretLoadingError(
      'fetch is not available; upgrade to Node.js 18+',
      'vault',
    );
  }

  const vaultAddr = config.vaultAddr;
  const vaultToken = config.vaultToken || process.env.VAULT_TOKEN;
  const vaultPath = config.vaultPath || 'secret/data/keeper-bot/signing-keys';

  if (!vaultAddr) {
    throw new SecretLoadingError(
      'vaultAddr must be configured',
      'vault',
    );
  }

  if (!vaultToken) {
    throw new SecretLoadingError(
      'VAULT_TOKEN environment variable or vaultToken config is required',
      'vault',
    );
  }

  const url = `${vaultAddr.replace(/\/$/, '')}/v1/${vaultPath}`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Vault-Token': vaultToken,
      },
    });

    if (!response.ok) {
      const statusText = response.statusText || `HTTP ${response.status}`;
      throw new SecretLoadingError(
        `Vault request failed with ${statusText}`,
        'vault',
      );
    }

    const data = (await response.json()) as Record<string, unknown>;

    // Vault KV v2 stores actual data under data.data
    const secretData = (data.data as Record<string, unknown>) || data;
    const keys = secretData.keys as string | undefined;

    if (!keys || typeof keys !== 'string' || keys.trim() === '') {
      throw new SecretLoadingError(
        `Secret at ${vaultPath} must contain a "keys" field with signing keys`,
        'vault',
      );
    }

    return {
      signingKeys: keys.trim(),
      backend: 'vault',
    };
  } catch (error) {
    if (error instanceof SecretLoadingError) {
      throw error;
    }
    throw new SecretLoadingError(
      error instanceof Error ? error.message : 'Unknown error',
      'vault',
    );
  }
}

/**
 * Load secrets from AWS Secrets Manager.
 *
 * Expected secret format in AWS Secrets Manager:
 * - Raw string: a single signing key or comma-separated keys
 * - JSON string: `{"keys": "S...,S...,S..."}`
 *
 * @param config - AWS Secrets Manager configuration
 * @returns Loaded secrets from AWS
 * @throws SecretLoadingError if AWS SDK is unavailable or secret is missing
 */
export async function loadSecretsFromAws(
  config: AwsSecretsManagerBackendConfig,
): Promise<LoadedSecrets> {
  let SecretsManagerClient: any;
  let GetSecretValueCommand: any;

  try {
    // Dynamically import AWS SDK to avoid requiring it as a dependency
    // if not using AWS backend
    const sdk = await import('@aws-sdk/client-secrets-manager');
    SecretsManagerClient = sdk.SecretsManagerClient;
    GetSecretValueCommand = sdk.GetSecretValueCommand;
  } catch {
    throw new SecretLoadingError(
      '@aws-sdk/client-secrets-manager must be installed to use AWS Secrets Manager backend. Run: npm install @aws-sdk/client-secrets-manager',
      'aws_secrets_manager',
    );
  }

  const awsSecretName = config.awsSecretName;
  const awsRegion = config.awsRegion || process.env.AWS_REGION;

  if (!awsSecretName) {
    throw new SecretLoadingError(
      'awsSecretName must be configured',
      'aws_secrets_manager',
    );
  }

  try {
    const client = new SecretsManagerClient({ region: awsRegion });
    const command = new GetSecretValueCommand({ SecretId: awsSecretName });
    const response = await client.send(command);

    let keys: string | undefined;

    // Try to parse as JSON first
    if (response.SecretString) {
      try {
        const parsed = JSON.parse(response.SecretString) as Record<string, unknown>;
        keys = parsed.keys as string;
      } catch {
        // If not valid JSON, treat the entire string as the key(s)
        keys = response.SecretString;
      }
    } else if (response.SecretBinary) {
      // Handle binary secrets (less common for signing keys)
      const decoder = new TextDecoder();
      keys = decoder.decode(response.SecretBinary);
    }

    if (!keys || keys.trim() === '') {
      throw new SecretLoadingError(
        `Secret "${awsSecretName}" does not contain valid signing keys`,
        'aws_secrets_manager',
      );
    }

    return {
      signingKeys: keys.trim(),
      backend: 'aws_secrets_manager',
    };
  } catch (error) {
    if (error instanceof SecretLoadingError) {
      throw error;
    }
    throw new SecretLoadingError(
      error instanceof Error ? error.message : 'Unknown error',
      'aws_secrets_manager',
    );
  }
}

/**
 * Load secrets from the configured backend.
 *
 * Routes to the appropriate backend loader based on configuration.
 *
 * @param config - Backend configuration
 * @returns Loaded secrets
 * @throws SecretLoadingError if the backend fails
 */
export async function loadSecrets(config: SecretBackendConfig): Promise<LoadedSecrets> {
  switch (config.backend) {
    case 'env':
      return loadSecretsFromEnv(config);
    case 'vault':
      return loadSecretsFromVault(config);
    case 'aws_secrets_manager':
      return loadSecretsFromAws(config);
    default:
      // This should never happen if TypeScript is working correctly
      throw new Error(`Unknown backend: ${(config as any).backend}`);
  }
}
