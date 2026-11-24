// Pump.fun Replay Sprint — paper bot (agent-fun/replay/v2).
// The grader runs `node /bot/main.ts`. The strategy lives in strategy.ts and
// the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { bot } from './strategy.ts';

await runBot(bot);
