import { describe, expect, it } from "vitest";
import { MemorySink } from "./sinks.js";
import { Tracer } from "./tracer.js";
import { buildTree } from "./tree.js";

function setup() {
  let t = 0;
  let n = 0;
  const sink = new MemorySink();
  const tracer = new Tracer([sink], { now: () => ++t, newId: () => `s${++n}` });
  return { sink, tracer };
}

describe("Tracer", () => {
  it("nests spans through async context and rolls cost and tokens up", async () => {
    const { sink, tracer } = setup();

    await tracer.withSpan("run", "run", async () => {
      await tracer.withSpan("turn 1", "turn", async () => {
        await tracer.withSpan("llm", "llm_call", (s) => {
          s.addCost(0.02).addTokens({ prompt: 100, completion: 20 });
        });
        await tracer.withSpan("hash", "tool_call", (s) => {
          s.addCost(0.005);
        });
      });
    });

    const [root] = buildTree(sink.all());
    expect(root?.name).toBe("run");
    expect(root?.status).toBe("ok");
    expect(root?.totalCostUsd).toBeCloseTo(0.025);
    expect(root?.costUsd).toBe(0);
    expect(root?.tokens).toEqual({ prompt: 100, completion: 20 });

    const turn = root?.children[0];
    expect(turn?.children.map((c) => c.name)).toEqual(["llm", "hash"]);
    expect(turn?.children.every((c) => c.traceId === root?.id)).toBe(true);
  });

  it("marks a span as error and rethrows", async () => {
    const { sink, tracer } = setup();
    await expect(
      tracer.withSpan("run", "run", () => {
        throw new Error("provider declined");
      }),
    ).rejects.toThrow("provider declined");
    const [span] = sink.all();
    expect(span?.status).toBe("error");
    expect(span?.error).toBe("provider declined");
  });

  it("isolates sink failures from the agent loop", async () => {
    const errors: unknown[] = [];
    const tracer = new Tracer(
      [
        {
          onEnd() {
            throw new Error("db down");
          },
        },
      ],
      { onSinkError: (e) => errors.push(e) },
    );
    await expect(tracer.withSpan("run", "run", () => 42)).resolves.toBe(42);
    expect(errors).toHaveLength(1);
  });

  it("ending a span twice is a no-op", () => {
    const { sink, tracer } = setup();
    const parent = tracer.startSpan("p", "run");
    const child = tracer.startSpan("c", "tool_call", { parent });
    child.addCost(1);
    child.end();
    child.end();
    parent.end();
    expect(sink.spans.get(parent.id)?.totalCostUsd).toBe(1);
  });
});
