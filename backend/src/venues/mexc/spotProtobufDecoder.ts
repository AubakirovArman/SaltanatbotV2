import type { MexcSpotProtobufDepthEnvelope } from "./types.js";
import { validation } from "./validation.js";

/**
 * Exact public fields used from MEXC's published 2025-02-24 Protobuf definitions.
 * Keeping the wire tags explicit makes schema drift reviewable without adding a general-purpose
 * decoder that could accidentally accept private/account bodies from the wrapper oneof.
 */
export const MEXC_SPOT_DEPTH_PROTO_SCHEMA = Object.freeze({
  source: "https://github.com/mexcdevelop/websocket-proto",
  wrapperMessage: "PushDataV3ApiWrapper",
  bodyMessage: "PublicAggreDepthsV3Api",
  wrapperFields: Object.freeze({ channel: 1, publicAggreDepths: 313, symbol: 3, sendTime: 6 }),
  bodyFields: Object.freeze({ asks: 1, bids: 2, eventType: 3, fromVersion: 4, toVersion: 5 }),
  levelFields: Object.freeze({ price: 1, quantity: 2 }),
  authority: "public-market-data-only"
} as const);

export interface MexcSpotProtobufDecoderOptions {
  maxFrameBytes?: number;
  maxLevelUpdates?: number;
  maxStringBytes?: number;
}

/** Injectable boundary for protoc-generated decoders; the protocol still enforces frame/update limits. */
export interface MexcSpotProtobufFrameDecoder {
  decode(frame: Uint8Array): MexcSpotProtobufDepthEnvelope;
}

/**
 * Small, bounded decoder for the two public MEXC messages required by the Spot depth feed.
 * It deliberately rejects every other wrapper oneof body, including all private/account bodies.
 */
export class ExplicitMexcSpotProtobufDepthDecoder implements MexcSpotProtobufFrameDecoder {
  private readonly maxFrameBytes: number;
  private readonly maxLevelUpdates: number;
  private readonly maxStringBytes: number;

  constructor(options: MexcSpotProtobufDecoderOptions = {}) {
    this.maxFrameBytes = bounded(options.maxFrameBytes ?? 512 * 1024, 256, 2 * 1024 * 1024, "maxFrameBytes");
    this.maxLevelUpdates = bounded(options.maxLevelUpdates ?? 2_000, 1, 10_000, "maxLevelUpdates");
    this.maxStringBytes = bounded(options.maxStringBytes ?? 256, 16, 4_096, "maxStringBytes");
  }

  decode(frame: Uint8Array): MexcSpotProtobufDepthEnvelope {
    if (!(frame instanceof Uint8Array)) throw validation("MEXC Spot Protobuf frame must be bytes");
    if (frame.byteLength === 0) throw validation("MEXC Spot Protobuf frame is empty");
    if (frame.byteLength > this.maxFrameBytes) throw validation(`MEXC Spot Protobuf frame exceeds ${this.maxFrameBytes} bytes`);
    const reader = new ProtobufReader(frame, this.maxStringBytes);
    let channel: string | undefined;
    let symbol: string | undefined;
    let sendTime: number | undefined;
    let depth: ReturnType<typeof decodeDepth> | undefined;
    while (!reader.done()) {
      const { field, wire } = reader.tag("wrapper");
      if (field === 1) channel = single(channel, reader.string(wire, "wrapper.channel"), "wrapper.channel");
      else if (field === 3) symbol = single(symbol, reader.string(wire, "wrapper.symbol"), "wrapper.symbol");
      else if (field === 6) sendTime = single(sendTime, reader.safeUint64(wire, "wrapper.sendTime"), "wrapper.sendTime");
      else if (field === 313) depth = single(depth, decodeDepth(reader.message(wire, "wrapper.publicAggreDepths"), this.maxLevelUpdates), "wrapper.publicAggreDepths");
      else if (field >= 301 && field <= 315) throw validation(`MEXC Spot Protobuf wrapper contains unsupported body field ${field}`);
      else reader.skip(wire, `wrapper field ${field}`);
    }
    if (!channel || !symbol || sendTime === undefined || !depth) throw validation("MEXC Spot Protobuf wrapper is missing required aggregate-depth fields");
    return { channel, symbol, sendTime, publicAggreDepths: depth };
  }
}

export function decodeMexcSpotProtobufDepth(frame: Uint8Array, options: MexcSpotProtobufDecoderOptions = {}) {
  return new ExplicitMexcSpotProtobufDepthDecoder(options).decode(frame);
}

function decodeDepth(reader: ProtobufReader, maximum: number) {
  const asks: Array<{ price: string; quantity: string }> = [];
  const bids: Array<{ price: string; quantity: string }> = [];
  let eventType: string | undefined;
  let fromVersion: string | undefined;
  let toVersion: string | undefined;
  while (!reader.done()) {
    const { field, wire } = reader.tag("aggregate depth");
    if (field === 1 || field === 2) {
      if (asks.length + bids.length >= maximum) throw validation(`MEXC Spot Protobuf depth exceeds ${maximum} updates`);
      (field === 1 ? asks : bids).push(decodeLevel(reader.message(wire, field === 1 ? "depth.asks" : "depth.bids")));
    } else if (field === 3) eventType = single(eventType, reader.string(wire, "depth.eventType"), "depth.eventType");
    else if (field === 4) fromVersion = single(fromVersion, reader.string(wire, "depth.fromVersion"), "depth.fromVersion");
    else if (field === 5) toVersion = single(toVersion, reader.string(wire, "depth.toVersion"), "depth.toVersion");
    else reader.skip(wire, `aggregate depth field ${field}`);
  }
  if (!eventType || !fromVersion || !toVersion || asks.length + bids.length === 0) throw validation("MEXC Spot Protobuf aggregate depth is missing required fields");
  return { asks, bids, eventType, fromVersion, toVersion };
}

function decodeLevel(reader: ProtobufReader) {
  let price: string | undefined;
  let quantity: string | undefined;
  while (!reader.done()) {
    const { field, wire } = reader.tag("depth level");
    if (field === 1) price = single(price, reader.string(wire, "depth level price"), "depth level price");
    else if (field === 2) quantity = single(quantity, reader.string(wire, "depth level quantity"), "depth level quantity");
    else reader.skip(wire, `depth level field ${field}`);
  }
  if (!price || quantity === undefined) throw validation("MEXC Spot Protobuf depth level is missing price or quantity");
  return { price, quantity };
}

class ProtobufReader {
  private offset = 0;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(
    private readonly bytes: Uint8Array,
    private readonly maxStringBytes: number
  ) {}

  done() {
    return this.offset === this.bytes.byteLength;
  }

  tag(label: string) {
    const value = this.varint(`${label} tag`);
    const field = Number(value >> 3n);
    const wire = Number(value & 7n);
    if (!Number.isSafeInteger(field) || field <= 0 || field > 536_870_911) throw validation(`${label} has an invalid field number`);
    return { field, wire };
  }

  string(wire: number, label: string) {
    const bytes = this.lengthDelimited(wire, label);
    if (bytes.byteLength === 0 || bytes.byteLength > this.maxStringBytes) throw validation(`${label} must contain between 1 and ${this.maxStringBytes} bytes`);
    try {
      return this.decoder.decode(bytes);
    } catch {
      throw validation(`${label} is not valid UTF-8`);
    }
  }

  message(wire: number, label: string) {
    return new ProtobufReader(this.lengthDelimited(wire, label), this.maxStringBytes);
  }

  safeUint64(wire: number, label: string) {
    if (wire !== 0) throw validation(`${label} must use Protobuf varint wire type`);
    const value = this.varint(label);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw validation(`${label} exceeds the safe integer range`);
    return Number(value);
  }

  skip(wire: number, label: string) {
    if (wire === 0) {
      this.varint(label);
      return;
    }
    if (wire === 1) {
      this.advance(8, label);
      return;
    }
    if (wire === 2) {
      this.lengthDelimited(wire, label);
      return;
    }
    if (wire === 5) {
      this.advance(4, label);
      return;
    }
    throw validation(`${label} uses unsupported Protobuf wire type ${wire}`);
  }

  private lengthDelimited(wire: number, label: string) {
    if (wire !== 2) throw validation(`${label} must use Protobuf length-delimited wire type`);
    const lengthValue = this.varint(`${label} length`);
    if (lengthValue > BigInt(Number.MAX_SAFE_INTEGER)) throw validation(`${label} length exceeds the safe integer range`);
    const length = Number(lengthValue);
    const start = this.offset;
    this.advance(length, label);
    return this.bytes.subarray(start, this.offset);
  }

  private varint(label: string) {
    let value = 0n;
    for (let index = 0; index < 10; index += 1) {
      if (this.offset >= this.bytes.byteLength) throw validation(`${label} is truncated`);
      const byte = this.bytes[this.offset++]!;
      if (index === 9 && byte > 1) throw validation(`${label} exceeds uint64`);
      value |= BigInt(byte & 0x7f) << BigInt(index * 7);
      if ((byte & 0x80) === 0) return value;
    }
    throw validation(`${label} varint is too long`);
  }

  private advance(length: number, label: string) {
    if (!Number.isSafeInteger(length) || length < 0 || this.offset + length > this.bytes.byteLength) throw validation(`${label} is truncated`);
    this.offset += length;
  }
}

function single<T>(current: T | undefined, value: T, label: string): T {
  if (current !== undefined) throw validation(`${label} is repeated`);
  return value;
}

function bounded(value: number, minimum: number, maximum: number, label: string) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw validation(`${label} must be between ${minimum} and ${maximum}`);
  return value;
}
