Raw Streamable HTTP answers of HSP Agentic Payment's MCP server (`https://mcp-qa.hashkeymerchant.com/`, protocol
2025-06-18), recorded read-only by c0der from the allowlisted IP on 2026-11-01 between 15:44Z and 15:49Z. They are
kept byte for byte:

| file | request |
|---|---|
| `mcp-initialize.sse` | `initialize` (server info and its instructions) |
| `mcp-tools-list.sse` | `tools/list`: the eight tools with their live input and output schemas |
| `mcp-get-chain-config.sse` | `tools/call get_chain_config` |

`test/fake-hsp-mcp.ts` replays `tools/list` as is, so the SDK client validates every fake answer against the real
output schemas, and the unit tests read `get_chain_config` as the server sent it (Base Sepolia USDC is listed twice).
