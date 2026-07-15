export interface ContinuousQuantityInstrument {
    quantityModel: {
        unit: "base";
    } | {
        unit: "quote";
    } | {
        unit: "contract";
        contractMultiplier: number;
        multiplierAsset: "base" | "quote";
    };
    quantityStep: number;
    minimumQuantity: number;
    minimumNotional: number;
}
export interface ContinuousQuantityBook {
    bid: number;
    bidSize: number;
    ask: number;
    askSize: number;
}
export interface ContinuousExpectedLegQuantity {
    topNativeQuantity: number;
    alignedNativeCapacity: number;
    alignedBaseCapacity: number;
    usedNativeQuantity: number;
    baseQuantity: number;
}
export declare function expectedContinuousPairQuantities(long: ContinuousQuantityInstrument, short: ContinuousQuantityInstrument, longBook: ContinuousQuantityBook, shortBook: ContinuousQuantityBook): {
    commonBaseQuantity: number;
    long: ContinuousExpectedLegQuantity;
    short: ContinuousExpectedLegQuantity;
};
