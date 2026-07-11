import { coreBlocks } from "./core";
import { marketBlocks } from "./market";
import { indicatorsBlocks } from "./indicators";
import { mathBlocks } from "./math";
import { positionBlocks } from "./position";
import { logicBlocks } from "./logic";
import { timeBlocks } from "./time";
import { signalsBlocks } from "./signals";
import { riskBlocks } from "./risk";
import { stateBlocks } from "./state";
import { flowBlocks } from "./flow";

export { coreBlocks, marketBlocks, indicatorsBlocks, mathBlocks, positionBlocks, logicBlocks, timeBlocks, signalsBlocks, riskBlocks, stateBlocks, flowBlocks };

export const allCustomBlockDefinitions = [...coreBlocks, ...marketBlocks, ...indicatorsBlocks, ...mathBlocks, ...positionBlocks, ...logicBlocks, ...timeBlocks, ...signalsBlocks, ...riskBlocks, ...stateBlocks, ...flowBlocks];
