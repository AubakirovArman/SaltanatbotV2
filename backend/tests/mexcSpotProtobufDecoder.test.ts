import { describe, expect, it } from "vitest";
import { ExplicitMexcSpotProtobufDepthDecoder, MEXC_SPOT_DEPTH_PROTO_SCHEMA } from "../src/venues/mexc/index.js";

describe("MEXC Spot published Protobuf decoder", () => {
  it("decodes only the exact public aggregate-depth wrapper tags", () => {
    const decoder = new ExplicitMexcSpotProtobufDepthDecoder();

    expect(MEXC_SPOT_DEPTH_PROTO_SCHEMA).toMatchObject({
      wrapperMessage: "PushDataV3ApiWrapper",
      bodyMessage: "PublicAggreDepthsV3Api",
      wrapperFields: { channel: 1, publicAggreDepths: 313, symbol: 3, sendTime: 6 },
      authority: "public-market-data-only"
    });
    expect(decoder.decode(wrapper())).toEqual({
      channel: "spot@public.aggre.depth.v3.api.pb@10ms@BTCUSDT",
      symbol: "BTCUSDT",
      sendTime: 1_784_023_200_010,
      publicAggreDepths: {
        asks: [{ price: "101", quantity: "0" }],
        bids: [{ price: "100", quantity: "2" }],
        eventType: "spot@public.aggre.depth.v3.api.pb@10ms",
        fromVersion: "1001",
        toVersion: "1003"
      }
    });
  });

  it("fails closed on private/other oneof bodies, truncation and repeated singular fields", () => {
    const decoder = new ExplicitMexcSpotProtobufDepthDecoder();
    expect(() => decoder.decode(message(field(307, utf8("private-account"))))).toThrow(/unsupported body field 307/);
    expect(() => decoder.decode(wrapper().subarray(0, wrapper().length - 1))).toThrow(/truncated|missing required/);
    expect(() => decoder.decode(message(wrapper(), stringField(3, "BTCUSDT")))).toThrow(/wrapper.symbol is repeated/);
  });

  it("bounds frame bytes and decoded level allocation before reconciliation", () => {
    const levels = new ExplicitMexcSpotProtobufDepthDecoder({ maxLevelUpdates: 1 });
    expect(() => levels.decode(wrapper())).toThrow(/exceeds 1 updates/);

    const frame = new ExplicitMexcSpotProtobufDepthDecoder({ maxFrameBytes: 256 });
    expect(() => frame.decode(message(wrapper(), field(100, new Uint8Array(300))))).toThrow(/exceeds 256 bytes/);
    expect(() => new ExplicitMexcSpotProtobufDepthDecoder({ maxFrameBytes: 2_097_153 })).toThrow(/maxFrameBytes must be between/);
  });
});

function wrapper() {
  const depth = message(
    field(1, level("101", "0")),
    field(2, level("100", "2")),
    stringField(3, "spot@public.aggre.depth.v3.api.pb@10ms"),
    stringField(4, "1001"),
    stringField(5, "1003")
  );
  return message(stringField(1, "spot@public.aggre.depth.v3.api.pb@10ms@BTCUSDT"), field(313, depth), stringField(3, "BTCUSDT"), scalarField(6, 1_784_023_200_010n));
}

function level(price: string, quantity: string) {
  return message(stringField(1, price), stringField(2, quantity));
}

function stringField(number: number, value: string) {
  return field(number, utf8(value));
}

function field(number: number, value: Uint8Array) {
  return message(varint(BigInt((number << 3) | 2)), varint(BigInt(value.byteLength)), value);
}

function scalarField(number: number, value: bigint) {
  return message(varint(BigInt(number << 3)), varint(value));
}

function utf8(value: string) {
  return new TextEncoder().encode(value);
}

function varint(input: bigint) {
  const bytes: number[] = [];
  let value = input;
  do {
    const byte = Number(value & 0x7fn);
    value >>= 7n;
    bytes.push(value === 0n ? byte : byte | 0x80);
  } while (value !== 0n);
  return Uint8Array.from(bytes);
}

function message(...parts: Uint8Array[]) {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
