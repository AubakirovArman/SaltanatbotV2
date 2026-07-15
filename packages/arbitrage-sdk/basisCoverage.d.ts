export interface BasisIdentityCoverage {
    complete: boolean;
    stale: boolean;
    failedSources: string[];
}
export declare function parseBasisIdentityCoverage(value: unknown): BasisIdentityCoverage | undefined;
