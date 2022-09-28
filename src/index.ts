import { Args_checker, CheckerResult } from "./wrap"
import { UserArgs } from "./wrap/UserArgs"

import { checkDeposits } from './deposits'
import { checkWithdrawals } from './withdrawals'

export function checker(args: Args_checker): CheckerResult {
  let userArgs = UserArgs.fromBuffer(args.userArgsBuffer)

  if (userArgs.schedulerType == 'deposit') {
    return checkDeposits(userArgs.schedulerAddress, userArgs.subgraphName, args)
  }

  return checkWithdrawals(userArgs.schedulerAddress, userArgs.subgraphName, args)
}
