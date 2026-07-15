import type { DydxIndexerBookMessage, DydxIndexerPriceLevelUpdate } from "./types.js";
import { dydxValidation, record, safeInteger, text, ticker } from "./validation.js";

/** Decode one official unbatched `v4_orderbook` wire envelope into the pure reducer input. */
export function decodeDydxIndexerBookMessage(raw: unknown): DydxIndexerBookMessage {
  const envelope = record(raw, "Indexer WebSocket message");
  const type = exactType(envelope.type);
  if (text(envelope.channel, "message.channel", 80) !== "v4_orderbook") {
    throw dydxValidation("message.channel must be v4_orderbook");
  }
  const contents = record(envelope.contents, "message.contents");
  const bids = optionalLevels(contents.bids, "message.contents.bids");
  const asks = optionalLevels(contents.asks, "message.contents.asks");
  return {
    type,
    connectionId: connectionToken(envelope.connection_id),
    instrumentId: ticker(envelope.id, "message.id"),
    messageId: safeInteger(envelope.message_id, "message.message_id", 0),
    ...(bids === undefined ? {} : { bids }),
    ...(asks === undefined ? {} : { asks })
  };
}

function optionalLevels(value: unknown, label: string): readonly DydxIndexerPriceLevelUpdate[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw dydxValidation(`${label} must be an array`);
  // Detailed shape, numeric and work bounds are applied transactionally by the reducer.
  return value as DydxIndexerPriceLevelUpdate[];
}

function exactType(value: unknown): DydxIndexerBookMessage["type"] {
  const type = text(value, "message.type", 40);
  if (type !== "subscribed" && type !== "channel_data") {
    throw dydxValidation("message.type must be subscribed or channel_data");
  }
  return type;
}

function connectionToken(value: unknown): string {
  const normalized = text(value, "message.connection_id", 128);
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw dydxValidation("message.connection_id has invalid format");
  }
  return normalized;
}
