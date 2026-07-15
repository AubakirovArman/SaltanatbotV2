import type {
  PairwiseBorrowAssumption,
  PairwiseCapitalAssumption,
  PairwiseConvergenceAssumption,
  PairwiseDeliveryAssumption,
  PairwiseFundingAssumption,
  PairwiseInventoryAssumption,
  PairwiseRebalanceAssumption
} from "./types.js";

interface PairwiseRouteBase {
  routeId: string;
  longInstrumentId: string;
  shortInstrumentId: string;
  requestedBaseQuantity: number;
}

export interface PairwiseSpotSpotRoute extends PairwiseRouteBase {
  strategyKind: "spot-spot";
  longCapital: PairwiseCapitalAssumption;
  shortAccess: PairwiseInventoryAssumption;
  rebalance: PairwiseRebalanceAssumption;
}

export interface PairwisePerpetualRoute extends PairwiseRouteBase {
  strategyKind: "perpetual-perpetual";
  convergence: PairwiseConvergenceAssumption;
  funding: readonly [PairwiseFundingAssumption, PairwiseFundingAssumption];
}

export interface PairwiseReverseCashAndCarryRoute extends PairwiseRouteBase {
  strategyKind: "reverse-cash-and-carry";
  convergence: PairwiseConvergenceAssumption;
  borrow: PairwiseBorrowAssumption;
  funding: readonly [PairwiseFundingAssumption] | readonly [PairwiseFundingAssumption, PairwiseFundingAssumption];
}

export interface PairwiseSpotDatedFutureRoute extends PairwiseRouteBase {
  strategyKind: "spot-dated-future";
  longCapital: PairwiseCapitalAssumption;
  convergence: PairwiseConvergenceAssumption;
  delivery: PairwiseDeliveryAssumption;
}

export interface PairwisePerpetualFutureRoute extends PairwiseRouteBase {
  strategyKind: "perpetual-future";
  convergence: PairwiseConvergenceAssumption;
  funding: readonly [PairwiseFundingAssumption];
  delivery: PairwiseDeliveryAssumption;
}

export interface PairwiseCalendarSpreadRoute extends PairwiseRouteBase {
  strategyKind: "calendar-spread";
  convergence: PairwiseConvergenceAssumption;
  delivery: PairwiseDeliveryAssumption;
}

export interface PairwiseDatedFuturesSpreadRoute extends PairwiseRouteBase {
  strategyKind: "dated-futures-spread";
  convergence: PairwiseConvergenceAssumption;
  delivery: PairwiseDeliveryAssumption;
}

export type PairwiseRoute =
  | PairwiseSpotSpotRoute
  | PairwisePerpetualRoute
  | PairwiseReverseCashAndCarryRoute
  | PairwiseSpotDatedFutureRoute
  | PairwisePerpetualFutureRoute
  | PairwiseCalendarSpreadRoute
  | PairwiseDatedFuturesSpreadRoute;
