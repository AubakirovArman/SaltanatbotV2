export type NativeSpreadContractType = "FundingRateArb" | "CarryTrade" | "FutureSpread" | "PerpBasis";

export type NativeSpreadLegType = "LinearPerpetual" | "LinearFutures" | "Spot";

export interface NativeSpreadLeg {
  symbol: string;
  contractType: NativeSpreadLegType;
}

export interface NativeSpreadInstrument {
  symbol: string;
  contractType: NativeSpreadContractType;
  status: "Trading" | "Settling";
  baseCoin: string;
  quoteCoin: string;
  settleCoin: string;
  tickSize: number;
  minimumPrice: number;
  maximumPrice: number;
  quantityStep: number;
  minimumQuantity: number;
  maximumQuantity: number;
  launchTime: number;
  deliveryTime?: number;
  legs: [NativeSpreadLeg, NativeSpreadLeg];
}

export interface NativeSpreadBook {
  symbol: string;
  bidPrice: number;
  bidQuantity: number;
  askPrice: number;
  askQuantity: number;
  sequence: number;
  exchangeTs: number;
  matchingEngineTs: number;
  receivedAt: number;
}

export interface NativeSpreadOpportunity extends NativeSpreadInstrument {
  id: string;
  venue: "bybit";
  bidPrice: number;
  bidQuantity: number;
  askPrice: number;
  askQuantity: number;
  bookWidth: number;
  relativeBookWidthBps?: number;
  executableQuantity: number;
  sequence: number;
  exchangeTs: number;
  matchingEngineTs: number;
  receivedAt: number;
  quoteAgeMs: number;
  riskFlags: string[];
}

export interface NativeSpreadScan {
  venue: "bybit";
  marketDataMode: "venue-native-spread-orderbook";
  executionModel: "venue-matched-multi-leg";
  readOnly: true;
  updatedAt: number;
  totalInstruments: number;
  eligibleInstruments: number;
  scannedInstruments: number;
  healthyBooks: number;
  totalOpportunities: number;
  truncated: boolean;
  candidateTruncated: boolean;
  sourceErrors: string[];
  opportunities: NativeSpreadOpportunity[];
}
