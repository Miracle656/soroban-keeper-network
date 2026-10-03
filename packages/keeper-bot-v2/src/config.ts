/**
 * Configuration Loading and Validation
 *
 * Extends the secret-hygiene patterns from v1's requireEnv (examples/keeper-bot/index.js)
 * with TypeScript type safety and structured validation, plus support for external
 * secret managers (Vault, AWS Secrets Manager).
 */

import 'dotenv/config';
import { StrKey } from '@stellar/stellar-sdk';
import { NETWORK_PRESETS, isNetworkName } from '@soroban-keeper-network/sdk';
import {
  loadSecrets,
  SecretBackendConfig,
  SecretLoadingError,
  createRedactedConfigDump,
} from './secrets.js';

/**
 * Environment variable type for flexible use across the app.
 */
type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Configuration validation rule for type-safe environment parsing.
 */
export interface EnvRule<T> {
  readonly parse: (raw: string) => T;
  readonly validate: (value: T) => boolean;
  readonly reason: string;
  readonly fallback?: T;
  readonly secret?: boolean;
}

/**
 * Configuration validation helper with proper error message redaction for secrets.
 *
 * @param name - Environment variable name
 * @param rule - Validation rule
 * @param env - Environment to read from (defaults to process.env)
 * @returns The parsed and validated value, or throws
 */
export function requireEnv<T>(
  name: string,
  rule: EnvRule<T>,
  env: Environment = process.env,
): T {
  const raw = env[name];

  if (raw === undefined || raw === '') {
    if (Object.hasOwn(rule, 'fallback')) {
      return rule.fallback as T;
    }
    throw new Error(`Invalid ${name}: must be set`);
  }

  try {
    const parsed = rule.parse(raw);
    if (!rule.validate(parsed)) {
      throw new Error(rule.reason);
    }
    return parsed;
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : rule.reason;
    const supplied = rule.secret ? '' : `: ${raw}`;
    throw new Error(`Invalid ${name}${supplied} - ${detail}`);
  }
}

/**
 * Complete runtime configuration for the keeper bot.
 *
 * All values are validated at startup and will not change unless the
 * process is restarted. This immutability is intentional to simplify
 * concurrent processing and inspection.
 */
export interface BotConfig {
  // Network and contract
  network: 'testnet' | 'futurenet' | 'mainnet';
  registryContractId: string;
  signingKeys: string; // Comma-separated signing keys (single or multi-account). Never logged in full; marked for redaction.
  rpcUrl: string;
  networkPassphrase: string;

  // Runtime behavior
  once: boolean; // Run once then exit (vs daemon mode)
  pollIntervalMs: number; // Milliseconds between rounds in daemon mode
  withdrawThreshold: bigint; // Minimum balance before withdrawing
  maxTasksPerRound: number; // Maximum tasks to process per round
  maxRetries: number; // Maximum retry attempts for transient errors
  retryBaseMs: number; // Base delay (ms) for exponential backoff
  expireStaleTasks: boolean; // Whether to expire tasks past their deadline
  minProfitMarginStroops: bigint; // Minimum net profit before claiming

  // Persistence
  stateDbPath: string; // Path to SQLite database for persistent state

  // Indexer integration (optional — both must be set to enable indexer mode)
  // When configured, candidate tasks are discovered via the indexer WebSocket
  // feed instead of direct RPC getEvents scanning. The authoritative on-chain
  // is_claimable check is still performed before every claim regardless of
  // which source is active.
  indexerWsUrl: string | null; // WebSocket endpoint, e.g. ws://indexer:8080/v1/ws
  indexerRestUrl: string | null; // REST base URL, e.g. http://indexer:8080/v1

  // Development
  simulateExecution: boolean; // Use simulated execution (dev only, never production)
}

/**
 * Determine which secret backend to use based on environment variables.
 *
 * Priority:
 * 1. If VAULT_ADDR is set, use Vault backend
 * 2. If AWS_SECRET_NAME is set, use AWS Secrets Manager backend
 * 3. Otherwise, use environment variable backend (default for local dev)
 *
 * @param env - Environment to read from
 * @returns The secret backend configuration
 */
function determineSecretBackend(env: Environment): SecretBackendConfig {
  const vaultAddr = env.VAULT_ADDR;
  const awsSecretName = env.AWS_SECRET_NAME;
  const secretManagerBackend = env.SECRET_MANAGER_BACKEND;

  // Explicit backend selection via SECRET_MANAGER_BACKEND
  if (secretManagerBackend) {
    if (secretManagerBackend === 'vault') {
      return {
        backend: 'vault',
        vaultAddr: vaultAddr || 'http://localhost:8200',
        vaultToken: env.VAULT_TOKEN,
        vaultPath: env.VAULT_PATH,
      };
    }
    if (secretManagerBackend === 'aws_secrets_manager') {
      return {
        backend: 'aws_secrets_manager',
        awsSecretName: awsSecretName || '',
        awsRegion: env.AWS_REGION,
      };
    }
    if (secretManagerBackend !== 'env') {
      throw new Error(
        `Invalid SECRET_MANAGER_BACKEND: ${secretManagerBackend} (must be 'env', 'vault', or 'aws_secrets_manager')`,
      );
    }
  }

  // Auto-detect backend from environment
  if (vaultAddr) {
    return {
      backend: 'vault',
      vaultAddr,
      vaultToken: env.VAULT_TOKEN,
      vaultPath: env.VAULT_PATH,
    };
  }

  if (awsSecretName) {
    return {
      backend: 'aws_secrets_manager',
      awsSecretName,
      awsRegion: env.AWS_REGION,
    };
  }

  // Default to environment variable backend
  return { backend: 'env' };
}

/**
 * Load and validate the complete configuration from environment variables and secret managers.
 *
 * Secret loading priority:
 * 1. If a secret manager backend is configured (via SECRET_MANAGER_BACKEND or auto-detection),
 *    signing keys are loaded from that backend.
 * 2. Otherwise, signing keys are read directly from environment variables
 *    (KEEPER_SECRET_KEY or SIGNING_KEY_POOL).
 *
 * @param env - Environment to read from (defaults to process.env)
 * @returns The validated configuration object
 * @throws If any required configuration is missing or invalid
 */
export async function loadConfig(env: Environment = process.env): Promise<BotConfig> {
  const network = requireEnv(
    'NETWORK',
    {
      parse: (v) => v,
      validate: (v: string) => isNetworkName(v),
      reason: 'must be one of: testnet, futurenet, mainnet',
      fallback: 'testnet',
    },
    env,
  ) as string;

  const registryContractId = requireEnv(
    'REGISTRY_CONTRACT_ID',
    {
      parse: (v) => v,
      validate: (v: string) => StrKey.isValidContract(v),
      reason: 'must be a valid contract ID (starts with C...)',
    },
    env,
  ) as string;

  // Load signing keys from secret backend or environment
  let signingKeys: string;
  try {
    const secretBackendConfig = determineSecretBackend(env);
    const loadedSecrets = await loadSecrets(secretBackendConfig);
    signingKeys = loadedSecrets.signingKeys;
  } catch (error) {
    if (error instanceof SecretLoadingError) {
      throw error;
    }
    throw new Error(`Failed to load secrets: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Validate signing keys format
  const signingKeyList = signingKeys
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  if (signingKeyList.length === 0) {
    throw new Error('No valid signing keys found');
  }

  // Validate each key is a valid Stellar secret key
  for (const key of signingKeyList) {
    if (!StrKey.isValidEd25519SecretSeed(key)) {
      throw new Error(`Invalid signing key format (must start with S...)`);
    }
  }

  const networkConfig = NETWORK_PRESETS[network];
  const { rpcUrl, networkPassphrase } = networkConfig;

  const config: BotConfig = {
    network: network as 'testnet' | 'futurenet' | 'mainnet',
    registryContractId,
    signingKeys,
    rpcUrl,
    networkPassphrase,

    once: process.argv.includes('--once') || env.RUN_ONCE === 'true',

    pollIntervalMs: requireEnv(
      'POLL_INTERVAL_MS',
      {
        parse: (v) => parseInt(v, 10),
        validate: (v) => typeof v === 'number' && v >= 1000,
        reason: 'must be >= 1000',
        fallback: 10000,
      },
      env,
    ) as number,

    withdrawThreshold: requireEnv(
      'WITHDRAW_THRESHOLD',
      {
        parse: BigInt,
        validate: (v) => v >= 0n,
        reason: 'must be >= 0',
        fallback: 10000000n,
      },
      env,
    ) as bigint,

    maxTasksPerRound: requireEnv(
      'MAX_TASKS_PER_ROUND',
      {
        parse: (v) => parseInt(v, 10),
        validate: (v) => typeof v === 'number' && v >= 1,
        reason: 'must be >= 1',
        fallback: 5,
      },
      env,
    ) as number,

    maxRetries: requireEnv(
      'MAX_RETRIES',
      {
        parse: (v) => parseInt(v, 10),
        validate: (v) => typeof v === 'number' && v >= 0,
        reason: 'must be >= 0',
        fallback: 3,
      },
      env,
    ) as number,

    retryBaseMs: requireEnv(
      'RETRY_BASE_MS',
      {
        parse: (v) => parseInt(v, 10),
        validate: (v) => typeof v === 'number' && v > 0,
        reason: 'must be > 0',
        fallback: 500,
      },
      env,
    ) as number,

    expireStaleTasks: requireEnv(
      'EXPIRE_STALE_TASKS',
      {
        parse: (v) => v.toLowerCase() === 'true',
        validate: (v) => typeof v === 'boolean',
        reason: 'must be true or false',
        fallback: true,
      },
      env,
    ) as boolean,

    minProfitMarginStroops: requireEnv(
      'MIN_PROFIT_MARGIN_STROOPS',
      {
        parse: BigInt,
        validate: (v) => v >= 0n,
        reason: 'must be >= 0',
        fallback: 0n,
      },
      env,
    ) as bigint,

    stateDbPath: requireEnv(
      'STATE_DB_PATH',
      {
        parse: (v) => v,
        validate: () => true,
        reason: 'must be a valid path',
        fallback: './keeper-state.db',
      },
      env,
    ) as string,

    indexerWsUrl: requireEnv(
      'INDEXER_WS_URL',
      {
        parse: (v) => v,
        validate: (v: string) => v.startsWith('ws://') || v.startsWith('wss://'),
        reason: 'must start with ws:// or wss://',
        fallback: null,
      },
      env,
    ) as string | null,

    indexerRestUrl: requireEnv(
      'INDEXER_REST_URL',
      {
        parse: (v) => v,
        validate: (v: string) => v.startsWith('http://') || v.startsWith('https://'),
        reason: 'must start with http:// or https://',
        fallback: null,
      },
      env,
    ) as string | null,

    simulateExecution: requireEnv(
      'SIMULATE_EXECUTION',
      {
        parse: (v) => v.toLowerCase() === 'true',
        validate: (v) => typeof v === 'boolean',
        reason: 'must be true or false',
        fallback: false,
      },
      env,
    ) as boolean,
  };

  return config;
}
