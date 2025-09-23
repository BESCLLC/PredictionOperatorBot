import 'dotenv/config';
import { ethers } from 'ethers';
import PredictionAbi from './abi/PancakePredictionV3.json' assert { type: "json" };

const {
  RPC_URL,
  PREDICTION_ADDRESS,
  PRIVATE_KEY,
  CHECK_INTERVAL = 30000,
  GAS_LIMIT = 500000
} = process.env;

if (!RPC_URL || !PREDICTION_ADDRESS || !PRIVATE_KEY) {
  throw new Error("Missing RPC_URL, PREDICTION_ADDRESS, or PRIVATE_KEY");
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const prediction = new ethers.Contract(PREDICTION_ADDRESS, PredictionAbi, wallet);

async function checkAndExecute() {
  try {
    const epoch = await prediction.currentEpoch();
    const round = await prediction.rounds(epoch);
    const now = Math.floor(Date.now() / 1000);

    const lockTime = Number(round.lockTimestamp);
    const closeTime = Number(round.closeTimestamp);

    if (lockTime > 0 && now > closeTime) {
      console.log(`[operator-bot] Executing round ${epoch.toString()}...`);
      
      // Force fixed gas settings
      const tx = await prediction.executeRound({
        gasLimit: Number(GAS_LIMIT),
        gasPrice: ethers.parseUnits("1000", "gwei")
      });

      console.log(`[operator-bot] Tx sent: ${tx.hash}`);
      await tx.wait();
      console.log(`[operator-bot] ✅ Round executed`);
    } else {
      console.log(`[operator-bot] Waiting... now=${now} lock=${lockTime} close=${closeTime}`);
    }
  } catch (e) {
    console.error(`[operator-bot] ❌ Error: ${e.message}`);
  }
}

console.log(`[operator-bot] Starting...`);
checkAndExecute();
setInterval(checkAndExecute, Number(CHECK_INTERVAL));
