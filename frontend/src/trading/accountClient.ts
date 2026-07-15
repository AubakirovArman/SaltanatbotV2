import { tradeApiRequest } from "./tradeClient";

export type TradingAccountOwnership = "own" | "managed";
export type TradingAccountStatus = "ready" | "credentials_missing" | "disabled";
export type TradingAccountCredentialStatus = "configured" | "missing";

export interface CreateTradingAccountInput {
  label: string;
  exchange: "binance" | "bybit";
  ownership: TradingAccountOwnership;
  enabled?: boolean;
}

export interface UpdateTradingAccountInput {
  label?: string;
  ownership?: TradingAccountOwnership;
  enabled?: boolean;
}

export interface TradingAccountCredentialsInput {
  apiKey: string;
  apiSecret: string;
}

export interface TradingAccountView {
  id: string;
  label: string;
  exchange: "binance" | "bybit";
  ownership: TradingAccountOwnership;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  status: TradingAccountStatus;
  credential: {
    mode: "account_isolated";
    status: TradingAccountCredentialStatus;
    isolated: true;
  };
  capabilities: {
    liveExecution: boolean;
    credentialIsolation: true;
    multipleCredentialAccounts: true;
  };
  botIds: string[];
}

const accountStatuses = new Set<TradingAccountStatus>(["ready", "credentials_missing", "disabled"]);
const credentialStatuses = new Set<TradingAccountCredentialStatus>(["configured", "missing"]);

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a string`);
  return value;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
  return value;
}

function parseAccount(value: unknown, path: string): TradingAccountView {
  const item = asRecord(value, path);
  const credential = asRecord(item.credential, `${path}.credential`);
  const capabilities = asRecord(item.capabilities, `${path}.capabilities`);
  rejectSecretFields(item, path);
  rejectSecretFields(credential, `${path}.credential`);
  const exchange = asString(item.exchange, `${path}.exchange`);
  const ownership = asString(item.ownership, `${path}.ownership`);
  const status = asString(item.status, `${path}.status`);
  const credentialMode = asString(credential.mode, `${path}.credential.mode`);
  const credentialStatus = asString(credential.status, `${path}.credential.status`);
  const id = asString(item.id, `${path}.id`);
  const enabled = asBoolean(item.enabled, `${path}.enabled`);
  const liveExecution = asBoolean(capabilities.liveExecution, `${path}.capabilities.liveExecution`);
  if (exchange !== "binance" && exchange !== "bybit") throw new Error(`${path}.exchange is invalid`);
  if (ownership !== "own" && ownership !== "managed") throw new Error(`${path}.ownership is invalid`);
  if (!accountStatuses.has(status as TradingAccountStatus)) throw new Error(`${path}.status is invalid`);
  if (credentialMode !== "account_isolated") throw new Error(`${path}.credential.mode is invalid`);
  if (!credentialStatuses.has(credentialStatus as TradingAccountCredentialStatus)) throw new Error(`${path}.credential.status is invalid`);
  if (!Array.isArray(item.botIds) || item.botIds.some((id) => typeof id !== "string" || !id)) throw new Error(`${path}.botIds must be a string array`);
  if (credential.isolated !== true || capabilities.credentialIsolation !== true || capabilities.multipleCredentialAccounts !== true) {
    throw new Error(`${path} understates account credential capabilities`);
  }
  const expectedStatus: TradingAccountStatus = !enabled ? "disabled" : credentialStatus === "configured" ? "ready" : "credentials_missing";
  if (status !== expectedStatus || liveExecution !== (expectedStatus === "ready")) throw new Error(`${path} has inconsistent runtime capabilities`);
  return {
    id,
    label: asString(item.label, `${path}.label`),
    exchange,
    ownership,
    enabled,
    createdAt: asNumber(item.createdAt, `${path}.createdAt`),
    updatedAt: asNumber(item.updatedAt, `${path}.updatedAt`),
    status: status as TradingAccountStatus,
    credential: {
      mode: credentialMode,
      status: credentialStatus as TradingAccountCredentialStatus,
      isolated: true
    },
    capabilities: {
      liveExecution,
      credentialIsolation: true,
      multipleCredentialAccounts: true
    },
    botIds: item.botIds as string[]
  };
}

export function parseTradingAccount(value: unknown): TradingAccountView {
  try {
    const response = asRecord(value, "account response");
    return parseAccount(response.account, "account response.account");
  } catch (cause) {
    throw new Error(`Invalid trading account response: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export function parseTradingAccounts(value: unknown): TradingAccountView[] {
  try {
    const response = asRecord(value, "accounts response");
    if (!Array.isArray(response.accounts)) throw new Error("accounts response.accounts must be an array");
    return response.accounts.map((account, index) => parseAccount(account, `accounts response.accounts[${index}]`));
  } catch (cause) {
    throw new Error(`Invalid trading accounts response: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

export const listTradingAccounts = (): Promise<TradingAccountView[]> => tradeApiRequest<unknown>("/accounts").then(parseTradingAccounts);

export function createTradingAccount(input: CreateTradingAccountInput): Promise<TradingAccountView> {
  const body = {
    label: normalizedLabel(input.label),
    exchange: assertedExchange(input.exchange),
    ownership: assertedOwnership(input.ownership),
    enabled: input.enabled ?? true
  };
  if (typeof body.enabled !== "boolean") throw new Error("enabled must be a boolean");
  return tradeApiRequest<unknown>("/accounts", { method: "POST", body: JSON.stringify(body) }).then(parseTradingAccount);
}

export function updateTradingAccount(id: string, input: UpdateTradingAccountInput): Promise<TradingAccountView> {
  const accountId = normalizedId(id);
  const body: UpdateTradingAccountInput = {};
  if (input.label !== undefined) body.label = normalizedLabel(input.label);
  if (input.ownership !== undefined) body.ownership = assertedOwnership(input.ownership);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new Error("enabled must be a boolean");
    body.enabled = input.enabled;
  }
  if (Object.keys(body).length === 0) throw new Error("At least one account field is required");
  return tradeApiRequest<unknown>(`/accounts/${encodeURIComponent(accountId)}`, { method: "PATCH", body: JSON.stringify(body) }).then(parseTradingAccount);
}

export async function deleteTradingAccount(id: string): Promise<void> {
  const response = asRecord(await tradeApiRequest<unknown>(`/accounts/${encodeURIComponent(normalizedId(id))}`, { method: "DELETE" }), "delete account response");
  if (response.ok !== true) throw new Error("Invalid delete trading account response");
}

export function setTradingAccountCredentials(id: string, input: TradingAccountCredentialsInput): Promise<TradingAccountView> {
  const body = {
    apiKey: normalizedCredential(input.apiKey, "API key"),
    apiSecret: normalizedCredential(input.apiSecret, "API secret")
  };
  return tradeApiRequest<unknown>(`/accounts/${encodeURIComponent(normalizedId(id))}/credentials`, {
    method: "PUT",
    body: JSON.stringify(body)
  }).then(parseTradingAccount);
}

export function deleteTradingAccountCredentials(id: string): Promise<TradingAccountView> {
  return tradeApiRequest<unknown>(`/accounts/${encodeURIComponent(normalizedId(id))}/credentials`, {
    method: "DELETE"
  }).then(parseTradingAccount);
}

function normalizedId(value: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("account id must be a non-empty string");
  return value.trim();
}

function normalizedLabel(value: string): string {
  if (typeof value !== "string") throw new Error("label must be a string");
  const label = value.trim();
  if (!label || label.length > 120) throw new Error("label must contain 1 to 120 characters");
  return label;
}

function normalizedCredential(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (normalized.length < 8 || normalized.length > 256) throw new Error(`${label} must contain 8 to 256 characters`);
  return normalized;
}

function rejectSecretFields(value: Record<string, unknown>, path: string): void {
  if ("apiKey" in value || "apiSecret" in value) throw new Error(`${path} must not contain exchange secrets`);
}

function assertedExchange(value: string): "binance" | "bybit" {
  if (value !== "binance" && value !== "bybit") throw new Error("exchange is invalid");
  return value;
}

function assertedOwnership(value: string): TradingAccountOwnership {
  if (value !== "own" && value !== "managed") throw new Error("ownership is invalid");
  return value;
}
