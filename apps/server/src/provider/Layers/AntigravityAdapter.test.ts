import { describe, expect, it } from "vite-plus/test";
import { parseAntigravityStreamJsonLine } from "./AntigravityAdapter.ts";

describe("Antigravity stream-json", () => {
  it("extracts assistant text and ignores non-text events", () => {
    expect(parseAntigravityStreamJsonLine('{"type":"assistant","text":"Hola"}')).toBe("Hola");
    expect(
      parseAntigravityStreamJsonLine(
        '{"type":"assistant","message":{"content":[{"type":"text","text":" mundo"}]}}',
      ),
    ).toBe(" mundo");
    expect(parseAntigravityStreamJsonLine('{"type":"tool_use","name":"shell"}')).toBeUndefined();
    expect(parseAntigravityStreamJsonLine("not json")).toBeUndefined();
  });

  it("extracts incremental text deltas from stream-json events", () => {
    expect(parseAntigravityStreamJsonLine('{"type":"init"}')).toBeUndefined();
    expect(
      parseAntigravityStreamJsonLine(
        '{"type":"step_update","step_type":"tool_call","tool_info":{"name":"bash"}}',
      ),
    ).toBeUndefined();
    expect(
      parseAntigravityStreamJsonLine(
        '{"type":"step_update","step_type":"agent_response","text_delta":"uno"}',
      ),
    ).toBe("uno");
    expect(
      parseAntigravityStreamJsonLine(
        '{"type":"content_block_delta","delta":{"type":"text_delta","text":"uno"}}',
      ),
    ).toBe("uno");
    expect(parseAntigravityStreamJsonLine('{"type":"message_delta","delta":{"text":" dos"}}')).toBe(
      " dos",
    );
    expect(parseAntigravityStreamJsonLine('{"type":"result","status":"success"}')).toBeUndefined();
    expect(parseAntigravityStreamJsonLine('{"type":"result","response":"uno dos"}', "uno")).toBe(
      " dos",
    );
  });

  it("turns cumulative assistant snapshots into only the unseen suffix", () => {
    expect(
      parseAntigravityStreamJsonLine(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"hola mundo"}]}}',
        "hola",
      ),
    ).toBe(" mundo");
  });
});
