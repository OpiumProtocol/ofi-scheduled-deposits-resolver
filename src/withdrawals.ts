import { BigInt, JSON } from "@polywrap/wasm-as"
import {
  Ethereum_Module,
  Graph_Module,
  Logger_Logger_LogLevel,
  Logger_Module,
} from "./wrap"
import { Args_checker, CheckerResult, GelatoArgs } from "./wrap"

// Constants
const SUBGRAPH_AUTHOR = "opiumprotocol"

const PAGE_LIMIT = 100

const BATCH_SIZE = 5

// Global variables to avoid Closures
let schedulerAddress: string, subgraphName: string

function fetchAllScheduledWithdrawals(subgraphName: string): JSON.Value[] {
  // Controlling variables
  let lastResponseLength = PAGE_LIMIT
  let skip = 0

  // Result array
  let result: JSON.Value[] = []
  
  // Keep fetching pages till the end
  while (lastResponseLength == PAGE_LIMIT) {
    const responseJsonString = Graph_Module.querySubgraph({
      subgraphAuthor: SUBGRAPH_AUTHOR,
      subgraphName,
      query: `
        {
          withdrawals(where: { scheduled: true }, skip: ${skip}) {
            user
            pool
          }
        }
      `
    }).unwrap()

    // Parse response array
    const responseObj = <JSON.Obj>JSON.parse(responseJsonString)
  
    const dataObj = responseObj.getObj("data")
    if (!dataObj) { throw Error("No dataObj") }
  
    const withdrawalsArr = dataObj.getArr("withdrawals")
    if (!withdrawalsArr) { throw Error("No withdrawalsArr") }
  
    // Unwrap fetched withdrawals
    const withdrawals = withdrawalsArr.valueOf()

    // Concat result array with the fetched withdrawals
    result = result.concat(withdrawals)

    // Update controlling variables
    lastResponseLength = withdrawals.length
    skip += withdrawals.length
  }

  return result
}

// Cache to decrease the amount of external calls
const cachedIsStakingPhase = new Map<string, boolean>()
function checkIsStakingPhase(pool: string, args: Args_checker): boolean {
  let gelatoArgs = GelatoArgs.fromBuffer(args.gelatoArgsBuffer);
  const now = <i64> gelatoArgs.timeStamp.toInt64()

  if (!cachedIsStakingPhase.has(pool)) {
    const derivativeData = Ethereum_Module.callContractView({
      address: pool,
      method: "function derivative() external view returns((uint256,uint256,address,address,address))",
      args: null,
      connection: args.connection,
    }).unwrap()
    const endTime = <i64> Number.parseInt(derivativeData.split(',')[1])

    const epochLength = <i64> Number.parseInt(
        Ethereum_Module.callContractView({
        address: pool,
        method: "function EPOCH() external view returns(uint256)",
        args: null,
        connection: args.connection,
      }).unwrap()
    )

    const stakingLength = <i64> Number.parseInt(
        Ethereum_Module.callContractView({
        address: pool,
        method: "function STAKING_PHASE() external view returns(uint256)",
        args: null,
        connection: args.connection,
      }).unwrap()
    )

    const deltaLength = <i64> Number.parseInt(
        Ethereum_Module.callContractView({
        address: pool,
        method: "function TIME_DELTA() external view returns(uint256)",
        args: null,
        connection: args.connection,
      }).unwrap()
    )

    // derivative maturity - EPOCH + TIME_DELTA < now < derivative maturity - EPOCH + STAKING_PHASE - TIME_DELTA
    const isStakingPhase = (endTime - epochLength + deltaLength < now) && (now < endTime - epochLength + stakingLength - deltaLength)
    
    cachedIsStakingPhase.set(pool,isStakingPhase)
  }

  return cachedIsStakingPhase.get(pool) as boolean
}

function getScheduled(schedulerAddress: string, user: string, pool: string, args: Args_checker): BigInt {
  const balance = BigInt.fromString(
    Ethereum_Module.callContractView({
      address: pool,
      method: "function balanceOf(address) external view returns(uint256)",
      args: [user],
      connection: args.connection,
    }).unwrap()
  )

  const allowance = BigInt.fromString(
    Ethereum_Module.callContractView({
      address: pool,
      method: "function allowance(address, address) external view returns(uint256)",
      args: [user, schedulerAddress],
      connection: args.connection,
    }).unwrap()
  )

  if (allowance.gte(balance)) {
    return balance
  }

  return BigInt.fromString('0')
}

// Cache to decrease the amount of external calls
const cachedCoefficients = new Map<string, string>()
function getReserveCoefficient(schedulerAddress: string, pool: string, args: Args_checker): BigInt {
  if (!cachedCoefficients.has(pool)) {
    cachedCoefficients.set(
      pool,
      Ethereum_Module.callContractView({
        address: schedulerAddress,
        method: "function getReserveCoefficient(address) external view returns(uint256)",
        args: [pool],
        connection: args.connection,
      }).unwrap()
    )
  }

  return BigInt.fromString(cachedCoefficients.get(pool) as string)
}

export function checkWithdrawals(schedulerAddress_: string, subgraphName_: string, args: Args_checker): CheckerResult {
  // Saving user arguments to global variables to avoid Closures
  schedulerAddress = schedulerAddress_
  subgraphName = subgraphName_

  // Recursively fetch all the withdrawals from subgraph
  const allWithdrawals = fetchAllScheduledWithdrawals(subgraphName)

  Logger_Module.log({
    level: Logger_Logger_LogLevel.INFO,
    message: `Total fetched length: ${allWithdrawals.length.toString()}`
  })

  // Define the batch - an array to store withdrawals that will be executed
  const batchedWithdrawals: string[] = []

  // Iterate over fetched withdrawals
  for (let index = 0; index < allWithdrawals.length; index++) {
    // Exit the loop if batch is full
    if (batchedWithdrawals.length >= BATCH_SIZE) {
      break
    }

    // Parse withdrawal object and it's properties
    const withdrawalObj = <JSON.Obj>JSON.parse(allWithdrawals[index].toString())

    const user = withdrawalObj.getString("user")
    if (!user) { throw Error("No user") }

    const pool = withdrawalObj.getString("pool")
    if (!pool) { throw Error("No pool") }

    // Fetch reserve coefficient for the given pool
    const coefficient = getReserveCoefficient(schedulerAddress, pool.toString(), args)

    // Fetch user allowance and scheduled
    const scheduled = getScheduled(schedulerAddress, user.toString(), pool.toString(), args)

    // Fetch isStakingPhase
    const isStakingPhase = checkIsStakingPhase(pool.toString(), args)

    // Check if scheduled deposit is greater than the reserve coefficient
    if (
      BigInt.fromString(scheduled.toString()).gt(coefficient) &&
      isStakingPhase
    ) {
      // Prepare deposit execution call and push into the batch
      batchedWithdrawals.push(
        Ethereum_Module.encodeFunction({
          method: "function execute(address, address)",
          args: [user.toString(), pool.toString()]
        }).unwrap()
      )
    }
  }

  Logger_Module.log({
    level: Logger_Logger_LogLevel.INFO,
    message: `Result batch length: ${batchedWithdrawals.length.toString()}`
  })

  // If batch is empty, return
  if (batchedWithdrawals.length === 0) {
    return {
      canExec: false,
      execData: ""
    }
  }

  // Unwind deposits batch into single multicall() call
  return {
    canExec: true,
    execData:
      Ethereum_Module.encodeFunction({
        method: "function aggregate((address,bytes)[])",
        args: [
          "[" +
          batchedWithdrawals.map<string>(calldata => `["${schedulerAddress}","${calldata}"]`).join(",") +
          "]"
        ]
      }).unwrap()
  }
}
