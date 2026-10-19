// run_command — exposes DeepSeek Harness slash commands to ACP clients.
//
// The harness keeps slash commands behind a UI adapter: `dsh-commands` can
// parse and execute a line against an agent, but ACP automation never calls it,
// so `/compact`, `/goal`, `/feedback` are unreachable from bb. This plugin adds
// a tool that calls the same registry, so the model can run a real harness
// command instead of asking the user to switch to `dsh web`.
//
// Some commands refuse to run inside an open turn (`/compact` reports "the
// agent is not idle"), so a busy result is retried until the turn ends.
import { defineTool } from "@deepseek-ai/dsh-tools";

export const name = "dsh-command-tool";
export const inject = ["tools", "commands", "compaction"];

const COMMAND_NAME = /^[a-z0-9][a-z0-9_-]*$/u;
const RETRY_DELAY_MS = 2000;
const MAX_ATTEMPTS = 45;

/** Retry a command until the agent is idle enough to accept it. */
async function runWhenIdle(ctx, agent, line, signal) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    if (signal?.aborted) return;
    try {
      const execution = await ctx.commands.execute(agent, line, [], undefined);
      if (execution !== undefined && execution.result.kind === "success") return;
    } catch {
      // Busy or disposed agent: keep retrying within the bounded window.
    }
  }
}

export function apply(ctx) {
  ctx.tools.register(
    defineTool({
      name: "run_command",
      description:
        "Run one of the harness's own slash commands against this agent, outside the model conversation. " +
        "Use it when the user asks for a harness command such as compact (condense history), goal, or feedback. " +
        "Commands that need an idle agent are queued and complete after the current turn ends.",
      parameters: {
        command: {
          type: "string",
          required: true,
          description: "Command name without the leading slash, for example compact.",
        },
        argument: {
          type: "string",
          description: "Raw input for the command, when it accepts one.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", required: true, description: "Settled or queued command output." },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args, exec) {
        if (exec.agent === undefined) throw new Error("run_command requires an owning agent session");

        const command = String(args.command ?? "").trim().replace(/^\/+/u, "");
        if (!COMMAND_NAME.test(command)) throw new Error(`not a command name: ${JSON.stringify(command)}`);

        const argument = typeof args.argument === "string" ? args.argument.trim() : "";
        const line = argument.length > 0 ? `/${command} ${argument}` : `/${command}`;

        const execution = await ctx.commands.execute(exec.agent, line, [], exec.signal);
        if (execution === undefined) {
          throw new Error(`unknown or malformed harness command: ${line}`);
        }
        if (execution.result.kind === "success") {
          return { text: execution.result.text ?? `${line} completed` };
        }

        void runWhenIdle(ctx, exec.agent, line, exec.signal);
        return { text: `queued: ${line} will run as soon as this turn ends` };
      },
    }),
  );
}
