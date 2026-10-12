import { describe, expect, it } from "vitest";
import { Ledger, LedgerError } from "./ledger.js";

const MINT = "Mint111";

describe("Ledger", () => {
  it("rejects unbalanced transactions", async () => {
    const ledger = new Ledger();
    await expect(
      ledger.post({
        id: "t1",
        at: new Date(),
        kind: "x",
        postings: [
          { account: "a", asset: "SOL", amount: 5n },
          { account: "b", asset: "SOL", amount: -4n },
        ],
      }),
    ).rejects.toBeInstanceOf(LedgerError);
  });

  it("is idempotent on id but refuses conflicting reposts", async () => {
    const ledger = new Ledger();
    const tx = {
      id: "t1",
      at: new Date(),
      kind: "x",
      postings: [
        { account: "a", asset: "SOL", amount: 5n },
        { account: "b", asset: "SOL", amount: -5n },
      ],
    };
    expect(await ledger.post(tx)).toBe(true);
    expect(await ledger.post(tx)).toBe(false);
    expect(await ledger.balance("a", "SOL")).toBe(5n);
    await expect(
      ledger.post({ ...tx, postings: [tx.postings[0]!, { account: "c", asset: "SOL", amount: -5n }] }),
    ).rejects.toThrow(/different postings/);
  });
});

