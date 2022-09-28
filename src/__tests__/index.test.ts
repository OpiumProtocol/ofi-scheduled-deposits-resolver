import { encode } from "@msgpack/msgpack";
import "dotenv/config";
import { ethers } from "ethers";
import path from "path";
import { Template_CheckerResult } from "./types/wrap";
import { UserArgs } from "../wrap/UserArgs";
import client from "./utils/client";

/** MAINNET */
const SUBGRAPH_NAME = "mainnet-withdrawal-scheduler"
const DEPOSIT_SCHEDULER_ADDRESS = "0xe47b867b2b5b21a2022068c9ef1293783864b274";
const WITHDRAWAL_SCHEDULER_ADDRESS = "0x27004Bd82cB5636A53b29203633A05FA256E0b5c";

/** POLYGON */
// const DEPOSIT_SCHEDULER_ADDRESS = "0xeE1270120cE07Af80D2Eb1691807f1f66816c521";
// const SUBGRAPH_NAME = "withdrawal-scheduler"

const ACTION: 'withdrawal' | 'deposit' = 'deposit'

jest.setTimeout(60000);

describe("Gelato simple resolver test", () => {
  let wrapperUri: string;
  let userArgsBuffer: Uint8Array;
  let gelatoArgsBuffer: Uint8Array;
  // let expected: Template_CheckerResult;

  beforeAll(async () => {
    const dirname: string = path.resolve(__dirname);
    const wrapperPath: string = path.join(dirname, "..", "..");
    wrapperUri = `fs/${wrapperPath}/build`;

    const gelatoArgs = {
      gasPrice: ethers.utils.parseUnits("100", "gwei").toString(),
      timeStamp: Math.floor(Date.now() / 1000).toString(),
    };

    const userArgs: UserArgs = {
      schedulerType: ACTION,
      // @ts-ignore
      schedulerAddress: ACTION === 'deposit' ? DEPOSIT_SCHEDULER_ADDRESS : WITHDRAWAL_SCHEDULER_ADDRESS,
      subgraphName: SUBGRAPH_NAME
    };

    userArgsBuffer = encode(userArgs);
    gelatoArgsBuffer = encode(gelatoArgs);

    // expected = {
    //   canExec: false,
    //   execData: "",
    // };
  });

  it("calls checker", async () => {
    const job = await client.invoke({
      uri: wrapperUri,
      method: "checker",
      args: {
        userArgsBuffer,
        gelatoArgsBuffer,
      },
    });

    const error = job.error;
    const data = <Template_CheckerResult>job.data;

    console.log("Final:", { error, data })

    // expect(error).toBeFalsy();
    // expect(data?.canExec).toEqual(expected.canExec);
    // expect(data?.execData).toEqual(expected.execData);
  });
});
