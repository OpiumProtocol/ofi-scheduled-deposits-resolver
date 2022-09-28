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

function fetchAllScheduledDeposits(subgraphName: string): JSON.Value[] {
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
          deposits(where: { scheduled_gt: 0 }, skip: ${skip}) {
            user
            pool
            scheduled
          }
        }
      `
    }).unwrap()

    // Parse response array
    const responseObj = <JSON.Obj>JSON.parse(responseJsonString)
  
    const dataObj = responseObj.getObj("data")
    if (!dataObj) { throw Error("No dataObj") }
  
    const depositsArr = dataObj.getArr("deposits")
    if (!depositsArr) { throw Error("No depositsArr") }
  
    // Unwrap fetched deposits
    const deposits = depositsArr.valueOf()

    // Concat result array with the fetched deposits
    result = result.concat(deposits)

    // Update controlling variables
    lastResponseLength = deposits.length
    skip += deposits.length
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

// Cache to decrease the amount of external calls
const cachedUnderlying = new Map<string, string>()
function getUnderlying(pool: string, args: Args_checker): string {
  if (!cachedUnderlying.has(pool)) {
    cachedUnderlying.set(
      pool,
      Ethereum_Module.callContractView({
        address: pool,
        method: "function underlying() external view returns(address)",
        args: null,
        connection: args.connection,
      }).unwrap()
    )
  }

  return cachedUnderlying.get(pool) as string
}

// Cache to decrease the amount of external calls
const cachedCoefficients = new Map<string, string>()
function getReserveCoefficient(schedulerAddress: string, pool: string, args: Args_checker): BigInt {
  const underlying = getUnderlying(pool, args)

  if (!cachedCoefficients.has(underlying)) {
    cachedCoefficients.set(
      underlying,
      Ethereum_Module.callContractView({
        address: schedulerAddress,
        method: "function getReserveCoefficient(address) external view returns(uint256)",
        args: [underlying],
        connection: args.connection,
      }).unwrap()
    )
  }

  return BigInt.fromString(cachedCoefficients.get(underlying) as string)
}

export function checkDeposits(schedulerAddress_: string, subgraphName_: string, args: Args_checker): CheckerResult {
  // Saving user arguments to global variables to avoid Closures
  schedulerAddress = schedulerAddress_
  subgraphName = subgraphName_

  // Recursively fetch all the deposits from subgraph
  const allDeposits = fetchAllScheduledDeposits(subgraphName)

  Logger_Module.log({
    level: Logger_Logger_LogLevel.INFO,
    message: `Total fetched length: ${allDeposits.length.toString()}`
  })

  // Define the batch - an array to store deposits that will be executed
  const batchedDeposits: string[] = []

  // Iterate over fetched deposits
  for (let index = 0; index < allDeposits.length; index++) {
    // Exit the loop if batch is full
    if (batchedDeposits.length >= BATCH_SIZE) {
      break
    }

    // Parse deposit object and it's properties
    const depositObj = <JSON.Obj>JSON.parse(allDeposits[index].toString())

    const user = depositObj.getString("user")
    if (!user) { throw Error("No user") }

    const pool = depositObj.getString("pool")
    if (!pool) { throw Error("No pool") }

    const scheduled = depositObj.getString("scheduled")
    if (!scheduled) { throw Error("No scheduled") }

    // Fetch reserve coefficient for the given pool
    const coefficient = getReserveCoefficient(schedulerAddress, pool.toString(), args)

    // Fetch isStakingPhase
    const isStakingPhase = checkIsStakingPhase(pool.toString(), args)

    // Check if scheduled deposit is greater than the reserve coefficient
    if (
      BigInt.fromString(scheduled.toString()).gt(coefficient) &&
      isStakingPhase
    ) {
      // Prepare deposit execution call and push into the batch
      batchedDeposits.push(
        Ethereum_Module.encodeFunction({
          method: "function execute(address, address)",
          args: [user.toString(), pool.toString()]
        }).unwrap()
      )
    }
  }

  Logger_Module.log({
    level: Logger_Logger_LogLevel.INFO,
    message: `Result batch length: ${batchedDeposits.length.toString()}`
  })

  // If batch is empty, return
  if (batchedDeposits.length === 0) {
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
          batchedDeposits.map<string>(calldata => `["${schedulerAddress}","${calldata}"]`).join(",") +
          "]"
        ]
      }).unwrap()
  }
}
